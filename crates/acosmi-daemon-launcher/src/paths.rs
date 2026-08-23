#![allow(unsafe_code)]

//! `~/.crabcode/run/` 下 daemon 的 PID / lock / socket / log 路径解析。
//!
//! 每个 daemon 有自己的 `name`；当前产品消费者是 `"cron"`，文件按
//! `name` 派生：
//!
//! - `~/.crabcode/run/<name>.pid`：daemon 自写
//! - `~/.crabcode/run/<name>.lock`：launcher flock 互斥
//! - `~/.crabcode/run/<name>.sock`：daemon UDS（Unix）；Windows 使用
//!   `\\.\pipe\crabcode-<USER>-<name>`
//! - `~/.crabcode/logs/<name>.log`：daemon stderr/stdout 归宿
//!
//! 注意：scheduler 的业务文件（scheduled_tasks.json / scheduled_tasks.lock）
//! 走 `acosmi_config::paths::resolve_state_dir()`，受 `CRABCODE_STATE_DIR`
//! 控制。daemon 运行期目录必须与应用配置根遵守同一隔离语义，不能把
//! `CRABCODE_HOME` 在一个子系统里解释成 base、另一个子系统里解释成 full
//! root。

use std::ffi::OsStr;
use std::fmt::Write as _;
use std::path::{Path, PathBuf};

use sha2::{Digest as _, Sha256};

/// macOS exposes 104 bytes for `sockaddr_un.sun_path` including the trailing
/// NUL; Linux exposes 108. Stay below both and leave room for the NUL.
const UNIX_SOCKET_SAFE_PATH_BYTES: usize = 100;
const SHORT_SOCKET_ROOT: &str = "/tmp";
const SHORT_MEMORY_SOCKET_DIR_PREFIX: &str = "crabcode-memory-";
const MEMORY_WINDOWS_PIPE_DOMAIN: &[u8] = b"crabcode-memory-pipe-v1\0";

/// `~/.crabcode/`（cron 的 socket·pid·lock·log state root）。
///
/// 优先级（与 TS 端 `getCrabCodeRuntimeHomeDir` 逐字对称——cron socket
/// 是 TS client ↔ Rust daemon 的对称契约，两端必须完全一致）：
/// 1. `CRABCODE_CONFIG_DIR` env override —— 显式全量覆盖，**最高优先**（§4：
///    此前只读 `CRABCODE_HOME` 漏了它 → 仅设 `CRABCODE_CONFIG_DIR` 的隔离运行
///    中 cron.sock / pid / lock 仍落真实 `~/.crabcode`，测试进程连上生产 cron
///    daemon、改写生产状态。与 `acosmi-config::paths` / TS 端 CONFIG_DIR 最高
///    优先一致）。
/// 2. `CRABCODE_HOME` env override（测试 / 沙盒的 home **base**，运行期
///    state root 为 `<CRABCODE_HOME>/.crabcode`）。
/// 3. `~/.crabcode`（Windows 首选 `USERPROFILE`、`HOME` 降为次级候选 ——
///    Windows 常规无 `HOME` env，只读 HOME 会让 pid / build-id / lock / log
///    全落 `C:\tmp\.crabcode`，而 Node `homedir()` 走 USERPROFILE；两端必须
///    选择同一根目录）。
///
/// 注：CONFIG_DIR / HOME 均要求**非空**才生效（空字符串视同未设，回退下一级），
/// 与 TS `getCrabCodeRuntimeHomeDir` 的 `length > 0` 守卫一致。
pub fn home_dir() -> PathBuf {
    let home_vars: &[&str] = if cfg!(windows) {
        &["USERPROFILE", "HOME"]
    } else {
        &["HOME"]
    };
    let home = home_vars
        .iter()
        .find_map(std::env::var_os)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/tmp"));
    resolve_home_dir(
        std::env::var_os("CRABCODE_CONFIG_DIR").as_deref(),
        std::env::var_os("CRABCODE_HOME").as_deref(),
        &home,
    )
}

/// Pure state-root resolver used by native clients and shared fixtures.
///
/// `CRABCODE_CONFIG_DIR` is a full root; `CRABCODE_HOME` is a home base.
/// Empty values fall through to the next source. This is the repository-wide
/// isolation contract shared with `acosmi-config` and
/// `src/utils/envUtils.ts::getCrabCodeConfigHomeDir`.
#[must_use]
pub fn resolve_home_dir(
    config_dir: Option<&OsStr>,
    crabcode_home: Option<&OsStr>,
    fallback_home: &Path,
) -> PathBuf {
    if let Some(path) = config_dir.filter(|path| !path.is_empty()) {
        return PathBuf::from(path);
    }
    if let Some(path) = crabcode_home.filter(|path| !path.is_empty()) {
        return PathBuf::from(path).join(".crabcode");
    }
    fallback_home.join(".crabcode")
}

pub fn run_dir() -> PathBuf {
    home_dir().join("run")
}

pub fn pid_file(name: &str) -> PathBuf {
    pid_file_for_generation(name, None)
}

/// Append an optional daemon generation to a canonical daemon name.
///
/// The TypeScript endpoint selector owns generation calculation. Rust only
/// carries that exact value into the pid/build-id/socket identity files so a
/// daemon cannot accidentally mix identities from two generations.
#[must_use]
pub fn name_with_generation(name: &str, generation: Option<&str>) -> String {
    match generation {
        Some(generation) if !generation.is_empty() => format!("{name}.{generation}"),
        _ => name.to_string(),
    }
}

/// `~/.crabcode/run/<name>.pid` for the canonical daemon or
/// `<name>.<generation>.pid` for an isolated generation.
#[must_use]
pub fn pid_file_for_generation(name: &str, generation: Option<&str>) -> PathBuf {
    run_dir().join(format!("{}.pid", name_with_generation(name, generation)))
}

pub fn lock_file(name: &str) -> PathBuf {
    run_dir().join(format!("{name}.lock"))
}

/// daemon IPC socket 路径。
///
/// - Unix：`~/.crabcode/run/<name>.sock`（UDS）
/// - Windows：`\\.\pipe\crabcode-<USER>-<name>`；
///   `<USER>` 取自 `USERNAME` env，缺失时退化为 `user`（pipe 命名长度上限
///   256 chars，per-user 部分受限于 USERNAME 实际长度，足够 cover）。
///
/// CLI / supervisor / 其他 client 都连这里。
pub fn socket_file(name: &str) -> PathBuf {
    socket_file_for_generation(name, None)
}

/// Resolve the IPC endpoint for an optional daemon generation.
///
/// Unix file identities use `<name>.<generation>.sock`; Windows named pipes
/// use `...-<name>-<generation>`. Empty generations retain the canonical
/// endpoint byte-for-byte.
#[must_use]
pub fn socket_file_for_generation(name: &str, generation: Option<&str>) -> PathBuf {
    #[cfg(unix)]
    {
        run_dir().join(format!("{}.sock", name_with_generation(name, generation)))
    }
    #[cfg(windows)]
    {
        let user = std::env::var("USERNAME").unwrap_or_else(|_| "user".to_string());
        let user_safe = sanitize_pipe_user_name(&user);
        match generation {
            Some(generation) if !generation.is_empty() => PathBuf::from(format!(
                r"\\.\pipe\crabcode-{user_safe}-{name}-{generation}"
            )),
            _ => PathBuf::from(format!(r"\\.\pipe\crabcode-{user_safe}-{name}")),
        }
    }
}

/// Parse the generation from a Unix socket file name created by
/// [`socket_file_for_generation`]. Canonical sockets return `None`.
#[must_use]
pub fn parse_generation_from_unix_socket_name(name: &str, file_name: &str) -> Option<String> {
    let stem = file_name.strip_suffix(".sock")?;
    if stem == name {
        return None;
    }
    let generation = stem.strip_prefix(&format!("{name}."))?;
    (!generation.is_empty()).then(|| generation.to_string())
}

/// Parse the generation from a Windows pipe name created by
/// [`socket_file_for_generation`]. Canonical pipes return `None`.
#[must_use]
pub fn parse_generation_from_pipe_name(name: &str, pipe: &str) -> Option<String> {
    let anchor = format!("-{name}");
    let position = pipe.rfind(&anchor)?;
    let suffix = &pipe[position + anchor.len()..];
    if suffix.is_empty() {
        return None;
    }
    let generation = suffix.strip_prefix('-')?;
    (!generation.is_empty()).then(|| generation.to_string())
}

/// Stable Unix memory-orchestrator endpoint for one canonical state root.
///
/// The endpoint deliberately has no TUI-generation suffix: every compatible
/// direct runtime observes the same memory owner. The state root remains the
/// authority for the owner/start locks and logs; only an overlong kernel
/// socket path moves into a deterministic private `/tmp` namespace.
#[must_use]
pub fn memory_unix_socket_for_state_root(state_root: &Path) -> PathBuf {
    let socket_name = "memory-orchestrator.sock";
    let candidate = state_root.join("run").join(socket_name);
    if candidate.to_string_lossy().len() <= UNIX_SOCKET_SAFE_PATH_BYTES {
        return candidate;
    }

    let mut hasher = Sha256::new();
    hasher.update(b"crabcode-memory-uds-v1\0");
    hasher.update(state_root.to_string_lossy().as_bytes());
    let digest = hasher.finalize();
    let mut namespace = String::with_capacity(32);
    for byte in &digest[..16] {
        let _ = write!(&mut namespace, "{byte:02x}");
    }
    PathBuf::from(SHORT_SOCKET_ROOT)
        .join(format!("{SHORT_MEMORY_SOCKET_DIR_PREFIX}{namespace}"))
        .join(socket_name)
}

/// Stable Windows memory-orchestrator pipe for one canonical state root.
///
/// Named pipes are machine-global kernel objects. Binding both the sanitized
/// user and a domain-separated state-root digest prevents two isolated
/// `CRABCODE_CONFIG_DIR` roots owned by the same account from sharing memory.
#[must_use]
pub fn memory_windows_pipe_for_state_root(state_root: &Path, username: &str) -> PathBuf {
    let user_safe = sanitize_pipe_user_name(username);
    let normalized = crate::state_identity::normalize_windows_text(&state_root.to_string_lossy());
    let mut hasher = Sha256::new();
    hasher.update(MEMORY_WINDOWS_PIPE_DOMAIN);
    hasher.update(normalized.as_bytes());
    let digest = hasher.finalize();
    let mut namespace = String::with_capacity(32);
    for byte in &digest[..16] {
        let _ = write!(&mut namespace, "{byte:02x}");
    }
    PathBuf::from(format!(
        r"\\.\pipe\crabcode-{user_safe}-{namespace}-memory-orchestrator"
    ))
}

/// Environment-wire form consumed by the memory orchestrator and direct
/// TypeScript/Rust clients.
#[must_use]
pub fn memory_ipc_endpoint_for_state_root(state_root: &Path, _username: &str) -> String {
    #[cfg(unix)]
    {
        format!(
            "unix:{}",
            memory_unix_socket_for_state_root(state_root).to_string_lossy()
        )
    }
    #[cfg(windows)]
    {
        format!(
            "npipe:{}",
            memory_windows_pipe_for_state_root(state_root, _username).to_string_lossy()
        )
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = (state_root, _username);
        String::new()
    }
}

/// Windows pipe 名的 USERNAME sanitize。TS 真源位于
/// `src/utils/ipcPipeName.ts::sanitizePipeUserName`，双端任一改动必须同步
/// 另一端，fixture 对齐测试见两侧单测。
///
/// - 非 `[A-Za-z0-9._-]` 一律替换为 `_`（pipe 名禁含 `\ / : * ? " < > |`，
///   除 leading `\\.\pipe\`）；
/// - **发生过替换时追加 `-<fnv1a32(raw utf8) 8位小写hex>` 后缀保唯一性** ——
///   否则全非 ASCII 用户名（中文名常态）坍缩成同一串 `_`（王彪→`__`、
///   李明→`__`），同机多用户撞管道名 + per-user DACL 互拒，上方 per-user
///   隔离承诺直接失效（第二个用户的 daemon 首实例创建必败 → exit 1）。
///   纯 ASCII 合法用户名不追加后缀（既有用户管道名零变更）。
pub fn sanitize_pipe_user_name(raw: &str) -> String {
    let mapped: String = raw
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' {
                c
            } else {
                '_'
            }
        })
        .collect();
    if mapped == raw {
        return mapped;
    }
    format!("{mapped}-{:08x}", fnv1a32(raw.as_bytes()))
}

/// FNV-1a 32-bit（UTF-8 字节序列）。与 TS
/// `src/utils/ipcPipeName.ts::fnv1a32Hex` 逐字节同算法。
fn fnv1a32(bytes: &[u8]) -> u32 {
    let mut hash: u32 = 0x811c_9dc5;
    for &byte in bytes {
        hash ^= u32::from(byte);
        hash = hash.wrapping_mul(0x0100_0193);
    }
    hash
}

pub fn log_dir() -> PathBuf {
    home_dir().join("logs")
}

pub fn log_symlink(name: &str) -> PathBuf {
    log_dir().join(format!("{name}.log"))
}

pub fn ensure_run_dir() -> std::io::Result<()> {
    std::fs::create_dir_all(run_dir())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serial_test::serial;

    #[test]
    #[serial]
    fn home_dir_respects_env_override() {
        let prev = std::env::var_os("CRABCODE_HOME");
        let prev_cfg = std::env::var_os("CRABCODE_CONFIG_DIR");
        // SAFETY: 测试用，serial_test 加锁单线程
        unsafe {
            // CONFIG_DIR 现优先于 HOME；清空它才能验证 HOME 分支。
            std::env::remove_var("CRABCODE_CONFIG_DIR");
            std::env::set_var("CRABCODE_HOME", "/tmp/crabcode-launcher-test-home");
        }
        assert_eq!(
            home_dir(),
            PathBuf::from("/tmp/crabcode-launcher-test-home/.crabcode")
        );
        unsafe {
            match prev {
                Some(v) => std::env::set_var("CRABCODE_HOME", v),
                None => std::env::remove_var("CRABCODE_HOME"),
            }
            match prev_cfg {
                Some(v) => std::env::set_var("CRABCODE_CONFIG_DIR", v),
                None => std::env::remove_var("CRABCODE_CONFIG_DIR"),
            }
        }
    }

    /// `CRABCODE_CONFIG_DIR` 必须优先于 `CRABCODE_HOME`（与 TS
    /// `getCrabCodeRuntimeHomeDir` 对齐）。此前漏读 CONFIG_DIR 会让仅设
    /// CONFIG_DIR 的隔离运行把 daemon 文件泄漏到真实 `~/.crabcode`，
    /// 测试进程可能连上生产 cron daemon。
    #[test]
    #[serial]
    fn home_dir_config_dir_takes_priority_over_home() {
        let prev_home = std::env::var_os("CRABCODE_HOME");
        let prev_cfg = std::env::var_os("CRABCODE_CONFIG_DIR");
        // SAFETY: 测试用，serial_test 加锁单线程
        unsafe {
            std::env::set_var("CRABCODE_HOME", "/tmp/crabcode-home-should-lose");
            std::env::set_var("CRABCODE_CONFIG_DIR", "/tmp/crabcode-cfg-wins");
        }
        assert_eq!(home_dir(), PathBuf::from("/tmp/crabcode-cfg-wins"));
        // 空 CONFIG_DIR 不得覆盖（回退到 HOME）。
        unsafe { std::env::set_var("CRABCODE_CONFIG_DIR", "") };
        assert_eq!(
            home_dir(),
            PathBuf::from("/tmp/crabcode-home-should-lose/.crabcode")
        );
        unsafe {
            match prev_home {
                Some(v) => std::env::set_var("CRABCODE_HOME", v),
                None => std::env::remove_var("CRABCODE_HOME"),
            }
            match prev_cfg {
                Some(v) => std::env::set_var("CRABCODE_CONFIG_DIR", v),
                None => std::env::remove_var("CRABCODE_CONFIG_DIR"),
            }
        }
    }

    #[test]
    fn pure_home_dir_resolution_matches_the_cross_language_precedence() {
        let fallback = Path::new("/home/tester");
        assert_eq!(
            resolve_home_dir(
                Some(OsStr::new("/config")),
                Some(OsStr::new("/runtime")),
                fallback
            ),
            PathBuf::from("/config")
        );
        assert_eq!(
            resolve_home_dir(Some(OsStr::new("")), Some(OsStr::new("/runtime")), fallback),
            PathBuf::from("/runtime/.crabcode")
        );
        assert_eq!(
            resolve_home_dir(None, None, fallback),
            PathBuf::from("/home/tester/.crabcode")
        );
    }

    #[test]
    #[serial]
    fn pid_file_under_run_dir() {
        let p = pid_file("cron");
        assert!(p.ends_with("cron.pid"));
        assert!(p.parent().is_some_and(|d| d.ends_with("run")));
    }

    #[test]
    #[serial]
    #[cfg(unix)]
    fn socket_file_under_run_dir_unix() {
        let p = socket_file("cron");
        assert!(p.ends_with("cron.sock"));
    }

    #[test]
    #[serial]
    #[cfg(windows)]
    fn socket_file_named_pipe_windows() {
        let p = socket_file("cron");
        let s = p.to_string_lossy();
        assert!(s.starts_with(r"\\.\pipe\crabcode-"), "{s}");
        assert!(s.ends_with("-cron"), "{s}");
    }

    #[test]
    // The unix socket path is production code only under `#[cfg(unix)]`; the
    // Windows build takes the `npipe:` arm instead. Without this gate the test
    // asserts POSIX literals against a `Path::join` that yields `\` on Windows.
    #[cfg(unix)]
    fn memory_unix_socket_is_stable_per_state_root_and_handles_long_paths() {
        let short_root = PathBuf::from("/tmp/crabcode-memory-short-root");
        assert_eq!(
            memory_unix_socket_for_state_root(&short_root),
            short_root.join("run").join("memory-orchestrator.sock")
        );

        let long_root = PathBuf::from("/tmp").join("m".repeat(180));
        let first = memory_unix_socket_for_state_root(&long_root);
        let second = memory_unix_socket_for_state_root(&long_root);
        assert_eq!(first, second);
        assert!(
            first.to_string_lossy().starts_with("/tmp/crabcode-memory-"),
            "{}",
            first.display()
        );
        assert!(first.ends_with("memory-orchestrator.sock"));
        assert_ne!(
            first,
            memory_unix_socket_for_state_root(&PathBuf::from("/tmp").join("n".repeat(180)))
        );
    }

    #[test]
    fn memory_windows_pipe_binds_user_and_state_root_without_generation() {
        let root = Path::new(r"C:\Users\Alice\.crabcode");
        let first = memory_windows_pipe_for_state_root(root, "Alice")
            .to_string_lossy()
            .into_owned();
        assert!(first.starts_with(r"\\.\pipe\crabcode-Alice-"), "{first}");
        assert!(first.ends_with("-memory-orchestrator"), "{first}");
        assert_eq!(
            first,
            memory_windows_pipe_for_state_root(Path::new("c:/users/alice/.crabcode"), "Alice")
                .to_string_lossy()
        );
        assert_ne!(
            first,
            memory_windows_pipe_for_state_root(Path::new(r"C:\isolated\CrabCode"), "Alice")
                .to_string_lossy()
        );
        assert_ne!(
            first,
            memory_windows_pipe_for_state_root(root, "Bob").to_string_lossy()
        );
    }

    /// 与 TS `src/utils/ipcPipeName.ts` / cron client fixture 逐字面对齐
    /// （双端 sanitize+fnv1a32 任一漂移即红）。
    #[test]
    fn sanitize_pipe_user_name_matches_ts_fixtures() {
        // 纯 ASCII 合法字符：零变更、零后缀（既有用户管道名不变）。
        assert_eq!(sanitize_pipe_user_name("Alice"), "Alice");
        assert_eq!(sanitize_pipe_user_name("alice.bob-c_d9"), "alice.bob-c_d9");
        assert_eq!(sanitize_pipe_user_name(""), "");
        // 非 ASCII（中文用户名真机环境）：替换 + fnv1a32 唯一性后缀。
        assert_eq!(sanitize_pipe_user_name("王彪"), "__-0ce83ba3");
        assert_eq!(sanitize_pipe_user_name("李明"), "__-ad55fab2");
        assert_eq!(sanitize_pipe_user_name("王 彪"), "___-f7cc5d2d");
        // pipe 名禁字符。
        assert_eq!(sanitize_pipe_user_name(r"a b/c\d:e"), "a_b_c_d_e-43ce8fb5");
        assert_eq!(
            sanitize_pipe_user_name("user\"<>|?*"),
            "user______-6fa523b3"
        );
    }

    /// 唯一性回归：sanitize 后相同的两个原始用户名必须得到不同结果。
    #[test]
    fn sanitize_pipe_user_name_keeps_distinct_users_distinct() {
        assert_ne!(
            sanitize_pipe_user_name("王彪"),
            sanitize_pipe_user_name("李明")
        );
    }

    #[test]
    #[serial]
    fn lock_and_pid_distinct() {
        // 不同 daemon name 的文件必须互不冲突；同 name 的 pid / lock 也要分文件。
        assert_ne!(pid_file("cron"), lock_file("cron"));
        assert_ne!(pid_file("cron"), pid_file("worker"));
        assert!(pid_file("cron").to_string_lossy().contains("cron"));
        assert!(pid_file("worker").to_string_lossy().contains("worker"));
    }
}
