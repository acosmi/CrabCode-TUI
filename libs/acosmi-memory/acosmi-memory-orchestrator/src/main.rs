use anyhow::{Context, Result};
use fs2::FileExt as _;
use std::collections::VecDeque;
use std::fs::OpenOptions;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};

/// env var carrying the TUI main-process pid (set by the Tauri host on the
/// orchestrator child command).
const PARENT_PID_ENV: &str = "CRABCODE_PARENT_PID";
/// Stable-runtime supervisor mode, injected only by the Rust TUI client
/// launcher before any multi-threaded runtime exists.
const COORDINATOR_ENV: &str = "CRABCODE_MEMORY_COORDINATOR";
/// Marks the supervised serving child so it does not recursively supervise.
const COORDINATOR_CHILD_ENV: &str = "CRABCODE_MEMORY_COORDINATOR_CHILD";
/// Absolute lifetime-lock path shared with the launcher.
const COORDINATOR_LOCK_ENV: &str = "CRABCODE_MEMORY_COORDINATOR_LOCK";
const COORDINATOR_RESTART_WINDOW: Duration = Duration::from_secs(60);
const COORDINATOR_RESTART_BURST: usize = 5;
const COORDINATOR_BACKOFF_INITIAL: Duration = Duration::from_millis(250);
const COORDINATOR_BACKOFF_CAP: Duration = Duration::from_secs(30);
/// Serving-child creation flags: `DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP`.
///
/// The single source of truth for the flags the coordinator hands its serving
/// child. `Command::creation_flags` is a setter, not a bitwise-or, so the value
/// must be assembled here rather than across several call sites — see the
/// spawn site and `serving_child_creation_flags_are_applied_exactly_once`.
///
/// `DETACHED_PROCESS` (0x8) leaves the child with no console at all, where
/// `CREATE_NO_WINDOW` would still allocate a hidden one plus its `conhost.exe`.
/// No console means no `CTRL_C_EVENT` / `CTRL_BREAK_EVENT` / `CTRL_CLOSE_EVENT`
/// can be delivered, which removes the `0xC000013A` (`STATUS_CONTROL_C_EXIT`)
/// restart loop entirely instead of merely hiding the window that caused it.
/// `CREATE_NEW_PROCESS_GROUP` (0x200) keeps a console control event aimed at
/// the client from reaching the shared daemon.
///
/// Do not add `CREATE_NO_WINDOW` — MSDN specifies it is ignored when combined
/// with `DETACHED_PROCESS`.
#[cfg(windows)]
pub(crate) const SERVING_CHILD_CREATION_FLAGS: u32 = 0x0000_0208;

/// Returns `true` if `pid` is still alive (or exists but we lack permission to
/// signal it); `false` only if it is definitively gone.
///
/// Unix — `libc::kill(pid, 0)` sends no signal, only probes existence/permission:
/// - `0`  → process exists and is signalable → alive
/// - `-1` + `ESRCH` → no such process → dead
/// - `-1` + `EPERM` → process exists but not signalable by us → alive
///
/// Windows has no `kill(pid, 0)`; we mirror `acosmi-app-server::parent_death`
/// (and `acosmi-scheduler::lock::is_pid_alive`) and probe with
/// `OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION)` — handle opens → alive;
/// failure with `ERROR_INVALID_PARAMETER` (87) → process definitively gone →
/// dead; any other failure (e.g. `ACCESS_DENIED`) is treated conservatively as
/// alive, so we never falsely conclude the parent died and exit early.
fn parent_pid_is_alive(pid: i32) -> bool {
    #[cfg(unix)]
    {
        // POSIX: kill(pid, 0) 不发送信号，仅检查进程是否存在 / 是否可被本进程 signal。
        // SAFETY: signal 0 是存在性检查，不实际发送信号，无内存安全副作用。
        #[allow(unsafe_code)]
        let rc = unsafe { libc::kill(pid as libc::pid_t, 0) };
        if rc == 0 {
            return true;
        }
        std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
    }
    #[cfg(windows)]
    {
        // SAFETY: OpenProcess + CloseHandle 是标准 Win32 API，无内存安全副作用。
        // 与 Unix kill(pid,0) 的 ESRCH 语义对齐：只有 ERROR_INVALID_PARAMETER(87)
        // 才代表 pid 明确不存在；其余失败（如 ACCESS_DENIED）保守视为存活。
        #[allow(unsafe_code)]
        #[allow(clippy::cast_sign_loss)]
        unsafe {
            let handle = windows_sys::Win32::System::Threading::OpenProcess(
                windows_sys::Win32::System::Threading::PROCESS_QUERY_LIMITED_INFORMATION,
                0, // bInheritHandle = FALSE
                pid as u32,
            );
            if handle.is_null() {
                let err = windows_sys::Win32::Foundation::GetLastError();
                const ERROR_INVALID_PARAMETER: u32 = 87;
                err != ERROR_INVALID_PARAMETER
            } else {
                let _ = windows_sys::Win32::Foundation::CloseHandle(handle);
                true
            }
        }
    }
    #[cfg(not(any(unix, windows)))]
    {
        // 其它平台无法判定 → 保守假设父进程存活，宁可不退出也不误判其已死。
        let _ = pid;
        true
    }
}

/// Resolve the parent pid from `CRABCODE_PARENT_PID`; if absent / empty /
/// unparseable / <= 1, return `None` (no watcher).
fn parent_pid_from_env() -> Option<i32> {
    std::env::var(PARENT_PID_ENV)
        .ok()
        .and_then(|s| s.trim().parse::<i32>().ok())
        .filter(|p| *p > 1)
}

fn env_flag_is_one(name: &str) -> bool {
    let value = std::env::var(name).ok();
    flag_value_is_one(value.as_deref())
}

fn flag_value_is_one(value: Option<&str>) -> bool {
    value.is_some_and(|value| value.trim() == "1")
}

fn coordinator_lock_path() -> Result<PathBuf> {
    let path = std::env::var_os(COORDINATOR_LOCK_ENV)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .context("CRABCODE_MEMORY_COORDINATOR_LOCK is required in coordinator mode")?;
    if !path.is_absolute() {
        anyhow::bail!("CRABCODE_MEMORY_COORDINATOR_LOCK must be absolute");
    }
    Ok(path)
}

fn acquire_coordinator_lifetime_lock(path: &Path) -> Result<std::fs::File> {
    let parent = path
        .parent()
        .context("memory coordinator lock has no parent directory")?;
    std::fs::create_dir_all(parent)
        .with_context(|| format!("create memory coordinator lock dir {}", parent.display()))?;
    let file = OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .truncate(false)
        .open(path)
        .with_context(|| format!("open memory coordinator lock {}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        file.set_permissions(std::fs::Permissions::from_mode(0o600))
            .with_context(|| format!("chmod memory coordinator lock {}", path.display()))?;
    }
    file.try_lock_exclusive().with_context(|| {
        format!(
            "another memory runtime coordinator already owns {}",
            path.display()
        )
    })?;
    Ok(file)
}

async fn run_coordinator() -> Result<()> {
    let lock_path = coordinator_lock_path()?;
    let _lifetime_lock = acquire_coordinator_lifetime_lock(&lock_path)?;
    let executable = std::env::current_exe().context("resolve memory coordinator executable")?;
    let mut restart_times = VecDeque::<Instant>::new();
    let mut backoff = COORDINATOR_BACKOFF_INITIAL;

    eprintln!(
        "[orchestrator-coordinator] owner acquired lock={} endpoint={}",
        lock_path.display(),
        std::env::var(acosmi_memory_orchestrator::MEMORY_IPC_ENDPOINT_ENV)
            .unwrap_or_else(|_| "<missing>".to_string())
    );

    loop {
        let started = Instant::now();
        let mut command = tokio::process::Command::new(&executable);
        // The coordinator is spawned DETACHED_PROCESS, so it owns no console.
        // Creating a console-subsystem child from it with no creation flags
        // makes Windows allocate a fresh console, which Windows 11 hands off to
        // the default terminal app -- a stray terminal window appears on every
        // start and on every restart below. Closing that window then delivers
        // CTRL_CLOSE_EVENT to the child, which exits 0xC000013A
        // (STATUS_CONTROL_C_EXIT) and gets restarted here, spawning yet another
        // window.
        //
        // SERVING_CHILD_CREATION_FLAGS spawns the child DETACHED_PROCESS, so it
        // gets no console at all: no window to appear, none to close, and no
        // channel over which a console control event could be delivered. The
        // stdout/stderr handles inherited below are the coordinator's own
        // log-file handles and are unaffected -- DETACHED_PROCESS governs
        // console inheritance only, which is why the coordinator itself is
        // launched the same way (acosmi-daemon-launcher/src/spawn_windows.rs)
        // and still logs normally. Parent-death reclamation does not depend on
        // a console or a Job either: CRABCODE_PARENT_PID below drives
        // wait_for_parent_death()'s poll, and kill_on_drop covers the rest.
        //
        // Exactly one creation-flags call site: the method is a setter, so a
        // second one would silently discard this value. That is not a style
        // preference -- CREATE_NEW_PROCESS_GROUP was lost that way once, when
        // two branches each added their own call and a rebase ordered the
        // older one last.
        #[cfg(windows)]
        {
            // `creation_flags` is inherent on tokio's Command on Windows, so no
            // `CommandExt` import is needed here.
            command.creation_flags(SERVING_CHILD_CREATION_FLAGS);
        }
        command
            .env(COORDINATOR_ENV, "0")
            .env(COORDINATOR_CHILD_ENV, "1")
            .env(PARENT_PID_ENV, std::process::id().to_string())
            .stdin(Stdio::null())
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit())
            .kill_on_drop(true);

        let outcome = match command.spawn() {
            Ok(mut child) => {
                let pid = child.id();
                eprintln!("[orchestrator-coordinator] serving child started pid={pid:?}");
                match child.wait().await {
                    Ok(status)
                        if status.code()
                            == Some(acosmi_memory_orchestrator::MEMORY_PROMOTION_EXIT_CODE) =>
                    {
                        eprintln!(
                            "[orchestrator-coordinator] child acknowledged successor promotion; \
                             releasing lifetime owner"
                        );
                        return Ok(());
                    }
                    Ok(status) => format!("pid={pid:?} exited status={status}"),
                    Err(error) => format!("pid={pid:?} wait failed: {error}"),
                }
            }
            Err(error) => format!("spawn failed: {error}"),
        };
        eprintln!("[orchestrator-coordinator] {outcome}");

        let now = Instant::now();
        restart_times.push_back(now);
        while restart_times
            .front()
            .is_some_and(|first| now.duration_since(*first) > COORDINATOR_RESTART_WINDOW)
        {
            let _ = restart_times.pop_front();
        }

        if started.elapsed() >= COORDINATOR_RESTART_WINDOW {
            restart_times.clear();
            backoff = COORDINATOR_BACKOFF_INITIAL;
        } else if restart_times.len() >= COORDINATOR_RESTART_BURST {
            backoff = COORDINATOR_BACKOFF_CAP;
        }

        eprintln!(
            "[orchestrator-coordinator] restarting after {}ms (failures_in_window={})",
            backoff.as_millis(),
            restart_times.len()
        );
        tokio::time::sleep(backoff).await;
        backoff = backoff.saturating_mul(2).min(COORDINATOR_BACKOFF_CAP);
    }
}

/// Resolve to a future that completes when the TUI parent process dies.
///
/// When `CRABCODE_PARENT_PID` is set (TUI-spawned), poll the parent pid every
/// second and return once it dies. When unset/invalid (non-TUI launch, e.g.
/// run directly), never return — `std::future::pending()` — so the
/// `tokio::select!` below is equivalent to "no watcher". macOS has no
/// PR_SET_PDEATHSIG and a Tauri crash skips kill_on_drop, so this poll is the
/// orphan-prevention mechanism. The 1s interval is not a correctness
/// threshold.
async fn wait_for_parent_death() {
    let Some(pid) = parent_pid_from_env() else {
        std::future::pending::<()>().await;
        return;
    };
    eprintln!("[orchestrator] parent-death watcher armed for parent pid {pid}");
    loop {
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        if !parent_pid_is_alive(pid) {
            return;
        }
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    // The coordinator outlives whichever TUI client/CLI launched it and must
    // keep its immutable binary generation available for future child
    // restarts. Direct/TUI-owned orchestrators use the same idempotent
    // detection; development and flat installs return `None`.
    let _generation_lease = acosmi_generation_lease::acquire_current_process_generation_lease()
        .context("acquire Memory coordinator generation lifetime lease")?;

    if env_flag_is_one(COORDINATOR_ENV) && !env_flag_is_one(COORDINATOR_CHILD_ENV) {
        return run_coordinator().await;
    }

    let endpoint = std::env::var(acosmi_memory_orchestrator::MEMORY_IPC_ENDPOINT_ENV)
        .context("CRABCODE_MEMORY_IPC_ENDPOINT is required")?;

    eprintln!("acosmi-memory-orchestrator listening on {endpoint}");
    tokio::select! {
        r = acosmi_memory_orchestrator::serve_endpoint(&endpoint) => {
            match r? {
                acosmi_memory_orchestrator::ServeExit::Promoted => {
                    eprintln!("[orchestrator] successor promotion acknowledged; exiting serving child");
                    std::process::exit(acosmi_memory_orchestrator::MEMORY_PROMOTION_EXIT_CODE);
                }
            }
        },
        () = wait_for_parent_death() => {
            eprintln!("[orchestrator] parent process died; exiting");
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parent_own_pid_is_alive() {
        let me = std::process::id() as i32;
        assert!(parent_pid_is_alive(me), "our own pid must read as alive");
    }

    #[test]
    fn coordinator_mode_requires_exact_one() {
        assert!(flag_value_is_one(Some("1")));
        assert!(flag_value_is_one(Some(" 1 ")));
        assert!(!flag_value_is_one(Some("true")));
        assert!(!flag_value_is_one(Some("0")));
        assert!(!flag_value_is_one(None));
    }

    #[cfg(unix)]
    #[test]
    fn parent_pid_one_is_alive() {
        // init/launchd always exists; EPERM must still count as alive.
        // (Unix-only: Windows has no pid 1.)
        assert!(parent_pid_is_alive(1));
    }

    #[cfg(unix)]
    #[test]
    fn parent_reaped_child_pid_is_dead() {
        let mut child = std::process::Command::new("true")
            .spawn()
            .expect("spawn `true`");
        let pid = child.id() as i32;
        let _ = child.wait().expect("wait for child");
        assert!(
            !parent_pid_is_alive(pid),
            "reaped child pid {pid} must read as dead"
        );
    }

    #[cfg(windows)]
    #[test]
    fn serving_child_creation_flags_are_detached_with_a_new_process_group() {
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;

        assert_eq!(
            SERVING_CHILD_CREATION_FLAGS,
            DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
        );
        // MSDN: CREATE_NO_WINDOW is ignored when combined with
        // DETACHED_PROCESS, so carrying it would only mislead a reader.
        assert_eq!(SERVING_CHILD_CREATION_FLAGS & CREATE_NO_WINDOW, 0);
    }

    #[test]
    fn serving_child_creation_flags_are_applied_exactly_once() {
        // Asserting the constant's value cannot catch the defect this guards
        // against. `Command::creation_flags` is a setter rather than a
        // bitwise-or, and neither std nor tokio exposes a getter, so two call
        // sites on the same builder compile cleanly while the later one
        // silently discards the earlier -- which is precisely how
        // CREATE_NEW_PROCESS_GROUP was dropped after a rebase reordered two
        // branches that had each added their own call. The only place that
        // defect is observable is the number of call sites, so count them.
        //
        // The needle is assembled at compile time so this file's own scanning
        // code is not itself a match.
        const NEEDLE: &str = concat!(".creation_flags", "(");
        let call_sites = include_str!("main.rs")
            .lines()
            .filter(|line| !line.trim_start().starts_with("//"))
            .filter(|line| line.contains(NEEDLE))
            .count();

        assert_eq!(
            call_sites, 1,
            "the serving child's creation flags must be set from exactly one \
             call site (found {call_sites}); a second call overwrites the \
             first instead of combining with it, so add flags to \
             SERVING_CHILD_CREATION_FLAGS rather than adding a call"
        );
    }
}
