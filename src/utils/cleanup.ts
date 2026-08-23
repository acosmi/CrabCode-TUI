import * as fs from 'fs/promises'
import { homedir } from 'os'
import { basename, isAbsolute, join, relative, resolve } from 'path'
import { logEvent } from '../services/analytics/index.js'
import { CACHE_PATHS } from './cachePaths.js'
import { logForDebugging } from './debug.js'
import { getCrabCodeConfigHomeDir } from './envUtils.js'
import { getErrnoCode } from './errors.js'
import { type FsOperations, getFsImplementation } from './fsOperations.js'
import { cleanupOldImageCaches } from './imageStore.js'
import * as lockfile from './lockfile.js'
import { logError } from './log.js'
import { cleanupOldPastes } from './pasteStore.js'
import { getPluginsDirectory } from './plugins/pluginDirectories.js'
import { getProjectsDir } from './sessionStorage.js'
import { getSettingsWithAllErrors } from './settings/allErrors.js'
import {
  getSettings_DEPRECATED,
  rawSettingsContainsKey,
} from './settings/settings.js'
import { TOOL_RESULTS_SUBDIR } from './toolResultStorage.js'
import { cleanupStaleAgentWorktrees } from './worktree.js'

const DEFAULT_CLEANUP_PERIOD_DAYS = 30

function getCutoffDate(): Date {
  const settings = getSettings_DEPRECATED() || {}
  const cleanupPeriodDays =
    settings.cleanupPeriodDays ?? DEFAULT_CLEANUP_PERIOD_DAYS
  const cleanupPeriodMs = cleanupPeriodDays * 24 * 60 * 60 * 1000
  return new Date(Date.now() - cleanupPeriodMs)
}

export type CleanupResult = {
  messages: number
  errors: number
}

export function addCleanupResults(
  a: CleanupResult,
  b: CleanupResult,
): CleanupResult {
  return {
    messages: a.messages + b.messages,
    errors: a.errors + b.errors,
  }
}

export function convertFileNameToDate(filename: string): Date {
  const isoStr = filename
    .split('.')[0]!
    .replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/, 'T$1:$2:$3.$4Z')
  return new Date(isoStr)
}

async function cleanupOldFilesInDirectory(
  dirPath: string,
  cutoffDate: Date,
  isMessagePath: boolean,
): Promise<CleanupResult> {
  const result: CleanupResult = { messages: 0, errors: 0 }

  try {
    const files = await getFsImplementation().readdir(dirPath)

    for (const file of files) {
      try {
        // Convert filename format where all ':.' were replaced with '-'
        const timestamp = convertFileNameToDate(file.name)
        if (timestamp < cutoffDate) {
          await getFsImplementation().unlink(join(dirPath, file.name))
          // Increment the appropriate counter
          if (isMessagePath) {
            result.messages++
          } else {
            result.errors++
          }
        }
      } catch (error) {
        // Log but continue processing other files
        logError(error as Error)
      }
    }
  } catch (error: unknown) {
    // Ignore if directory doesn't exist
    if (error instanceof Error && 'code' in error && error.code !== 'ENOENT') {
      logError(error)
    }
  }

  return result
}

export async function cleanupOldMessageFiles(): Promise<CleanupResult> {
  const fsImpl = getFsImplementation()
  const cutoffDate = getCutoffDate()
  const errorPath = CACHE_PATHS.errors()
  const baseCachePath = CACHE_PATHS.baseLogs()

  // Clean up message and error logs
  let result = await cleanupOldFilesInDirectory(errorPath, cutoffDate, false)

  // Clean up MCP logs
  try {
    let dirents
    try {
      dirents = await fsImpl.readdir(baseCachePath)
    } catch {
      return result
    }

    const mcpLogDirs = dirents
      .filter(
        dirent => dirent.isDirectory() && dirent.name.startsWith('mcp-logs-'),
      )
      .map(dirent => join(baseCachePath, dirent.name))

    for (const mcpLogDir of mcpLogDirs) {
      // Clean up files in MCP log directory
      result = addCleanupResults(
        result,
        await cleanupOldFilesInDirectory(mcpLogDir, cutoffDate, true),
      )
      await tryRmdir(mcpLogDir, fsImpl)
    }
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code !== 'ENOENT') {
      logError(error)
    }
  }

  return result
}

async function unlinkIfOld(
  filePath: string,
  cutoffDate: Date,
  fsImpl: FsOperations,
): Promise<boolean> {
  const stats = await fsImpl.stat(filePath)
  if (stats.mtime < cutoffDate) {
    await fsImpl.unlink(filePath)
    return true
  }
  return false
}

async function tryRmdir(dirPath: string, fsImpl: FsOperations): Promise<void> {
  try {
    await fsImpl.rmdir(dirPath)
  } catch {
    // not empty / doesn't exist
  }
}

export async function cleanupOldSessionFiles(): Promise<CleanupResult> {
  const cutoffDate = getCutoffDate()
  const result: CleanupResult = { messages: 0, errors: 0 }
  const projectsDir = getProjectsDir()
  const fsImpl = getFsImplementation()

  let projectDirents
  try {
    projectDirents = await fsImpl.readdir(projectsDir)
  } catch {
    return result
  }

  for (const projectDirent of projectDirents) {
    if (!projectDirent.isDirectory()) continue
    const projectDir = join(projectsDir, projectDirent.name)

    // Single readdir per project directory — partition into files and session dirs
    let entries
    try {
      entries = await fsImpl.readdir(projectDir)
    } catch {
      result.errors++
      continue
    }

    for (const entry of entries) {
      if (entry.isFile()) {
        if (!entry.name.endsWith('.jsonl') && !entry.name.endsWith('.cast')) {
          continue
        }
        try {
          if (
            await unlinkIfOld(join(projectDir, entry.name), cutoffDate, fsImpl)
          ) {
            result.messages++
          }
        } catch {
          result.errors++
        }
      } else if (entry.isDirectory()) {
        // Session directory — clean up tool-results/<toolDir>/* beneath it
        const sessionDir = join(projectDir, entry.name)
        const toolResultsDir = join(sessionDir, TOOL_RESULTS_SUBDIR)
        let toolDirs
        try {
          toolDirs = await fsImpl.readdir(toolResultsDir)
        } catch {
          // No tool-results dir — still try to remove an empty session dir
          await tryRmdir(sessionDir, fsImpl)
          continue
        }
        for (const toolEntry of toolDirs) {
          if (toolEntry.isFile()) {
            try {
              if (
                await unlinkIfOld(
                  join(toolResultsDir, toolEntry.name),
                  cutoffDate,
                  fsImpl,
                )
              ) {
                result.messages++
              }
            } catch {
              result.errors++
            }
          } else if (toolEntry.isDirectory()) {
            const toolDirPath = join(toolResultsDir, toolEntry.name)
            let toolFiles
            try {
              toolFiles = await fsImpl.readdir(toolDirPath)
            } catch {
              continue
            }
            for (const tf of toolFiles) {
              if (!tf.isFile()) continue
              try {
                if (
                  await unlinkIfOld(
                    join(toolDirPath, tf.name),
                    cutoffDate,
                    fsImpl,
                  )
                ) {
                  result.messages++
                }
              } catch {
                result.errors++
              }
            }
            await tryRmdir(toolDirPath, fsImpl)
          }
        }
        await tryRmdir(toolResultsDir, fsImpl)
        await tryRmdir(sessionDir, fsImpl)
      }
    }

    await tryRmdir(projectDir, fsImpl)
  }

  return result
}

/**
 * Generic helper for cleaning up old files in a single directory
 * @param dirPath Path to the directory to clean
 * @param extension File extension to filter (e.g., '.md', '.jsonl')
 * @param removeEmptyDir Whether to remove the directory if empty after cleanup
 */
async function cleanupSingleDirectory(
  dirPath: string,
  extension: string,
  removeEmptyDir: boolean = true,
): Promise<CleanupResult> {
  const cutoffDate = getCutoffDate()
  const result: CleanupResult = { messages: 0, errors: 0 }
  const fsImpl = getFsImplementation()

  let dirents
  try {
    dirents = await fsImpl.readdir(dirPath)
  } catch {
    return result
  }

  for (const dirent of dirents) {
    if (!dirent.isFile() || !dirent.name.endsWith(extension)) continue
    try {
      if (await unlinkIfOld(join(dirPath, dirent.name), cutoffDate, fsImpl)) {
        result.messages++
      }
    } catch {
      result.errors++
    }
  }

  if (removeEmptyDir) {
    await tryRmdir(dirPath, fsImpl)
  }

  return result
}

export function cleanupOldPlanFiles(): Promise<CleanupResult> {
  const plansDir = join(getCrabCodeConfigHomeDir(), 'plans')
  return cleanupSingleDirectory(plansDir, '.md')
}

export async function cleanupOldFileHistoryBackups(): Promise<CleanupResult> {
  const cutoffDate = getCutoffDate()
  const result: CleanupResult = { messages: 0, errors: 0 }
  const fsImpl = getFsImplementation()

  try {
    const configDir = getCrabCodeConfigHomeDir()
    const fileHistoryStorageDir = join(configDir, 'file-history')

    let dirents
    try {
      dirents = await fsImpl.readdir(fileHistoryStorageDir)
    } catch {
      return result
    }

    const fileHistorySessionsDirs = dirents
      .filter(dirent => dirent.isDirectory())
      .map(dirent => join(fileHistoryStorageDir, dirent.name))

    await Promise.all(
      fileHistorySessionsDirs.map(async fileHistorySessionDir => {
        try {
          const stats = await fsImpl.stat(fileHistorySessionDir)
          if (stats.mtime < cutoffDate) {
            await fsImpl.rm(fileHistorySessionDir, {
              recursive: true,
              force: true,
            })
            result.messages++
          }
        } catch {
          result.errors++
        }
      }),
    )

    await tryRmdir(fileHistoryStorageDir, fsImpl)
  } catch (error) {
    logError(error as Error)
  }

  return result
}

export async function cleanupOldSessionEnvDirs(): Promise<CleanupResult> {
  const cutoffDate = getCutoffDate()
  const result: CleanupResult = { messages: 0, errors: 0 }
  const fsImpl = getFsImplementation()

  try {
    const configDir = getCrabCodeConfigHomeDir()
    const sessionEnvBaseDir = join(configDir, 'session-env')

    let dirents
    try {
      dirents = await fsImpl.readdir(sessionEnvBaseDir)
    } catch {
      return result
    }

    const sessionEnvDirs = dirents
      .filter(dirent => dirent.isDirectory())
      .map(dirent => join(sessionEnvBaseDir, dirent.name))

    for (const sessionEnvDir of sessionEnvDirs) {
      try {
        const stats = await fsImpl.stat(sessionEnvDir)
        if (stats.mtime < cutoffDate) {
          await fsImpl.rm(sessionEnvDir, { recursive: true, force: true })
          result.messages++
        }
      } catch {
        result.errors++
      }
    }

    await tryRmdir(sessionEnvBaseDir, fsImpl)
  } catch (error) {
    logError(error as Error)
  }

  return result
}

/**
 * Cleans up old debug log files from ~/.crabcode/debug/
 * Preserves the 'latest' symlink which points to the current session's log.
 * Debug logs can grow very large (especially with the infinite logging loop bug)
 * and accumulate indefinitely without this cleanup.
 */
export async function cleanupOldDebugLogs(): Promise<CleanupResult> {
  const cutoffDate = getCutoffDate()
  const result: CleanupResult = { messages: 0, errors: 0 }
  const fsImpl = getFsImplementation()
  const debugDir = join(getCrabCodeConfigHomeDir(), 'debug')

  let dirents
  try {
    dirents = await fsImpl.readdir(debugDir)
  } catch {
    return result
  }

  for (const dirent of dirents) {
    // Preserve the 'latest' symlink
    if (
      !dirent.isFile() ||
      !dirent.name.endsWith('.txt') ||
      dirent.name === 'latest'
    ) {
      continue
    }
    try {
      if (await unlinkIfOld(join(debugDir, dirent.name), cutoffDate, fsImpl)) {
        result.messages++
      }
    } catch {
      result.errors++
    }
  }

  // Intentionally do NOT remove debugDir even if empty — needed for future logs
  return result
}

const ONE_HOUR_MS = 60 * 60 * 1000
const SHELL_SNAPSHOT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

/**
 * `.marketplace-add-<pid>-<uuid>.staging`, exactly as
 * `marketplaceAddStagingName()` writes it (`randomUUID()` is always the
 * canonical lowercase 8-4-4-4-12 form). Anchored on purpose: a loose
 * `.marketplace-add-*` glob would also swallow the *unsuffixed* staging path
 * a live install is still writing into.
 */
const MARKETPLACE_STAGING_DIR_NAME =
  /^\.marketplace-add-(\d+)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.staging$/i

/**
 * `snapshot-<zsh|bash|sh>-<epochMs>-<rand>.sh`, exactly as
 * `createAndSaveSnapshot()` writes it. The shell type is a closed set there,
 * so it is spelled out rather than wildcarded — `shell-snapshots/` is under
 * the user's config home and nothing else in it may be matched by accident.
 */
const SHELL_SNAPSHOT_FILE_NAME = /^snapshot-(?:zsh|bash|sh)-\d+-[0-9a-z]+\.sh$/

/** Windows path comparison is case-insensitive; POSIX is not. */
function normalizeEntryName(name: string): string {
  return process.platform === 'win32' ? name.toLowerCase() : name
}

/**
 * The first path segment of `candidate` below `root`, or null when
 * `candidate` is not below `root` at all (including when it *is* `root`).
 */
function firstSegmentUnder(root: string, candidate: string): string | null {
  const rel = relative(root, candidate)
  if (rel.length === 0 || rel.startsWith('..') || isAbsolute(rel)) {
    return null
  }
  const segment = rel.split(/[\\/]/)[0]
  return segment !== undefined && segment.length > 0 ? segment : null
}

/**
 * Whether `pid` still names a live process.
 *
 * `process.kill(pid, 0)` delivers no signal — it only probes — and the three
 * outcomes must be told apart, because "cannot tell" has to mean *alive*:
 * deleting a staging directory out from under a running install is the one
 * failure this cleanup must never produce.
 *
 *   - returns normally  → live.
 *   - throws ESRCH      → no such process. The only answer that permits a delete.
 *   - throws otherwise  → live, or unknowable. On POSIX an EPERM means the
 *     process exists under another uid. On Windows libuv's `uv_kill` opens the
 *     process and maps ERROR_INVALID_PARAMETER (no such pid) to ESRCH while
 *     ERROR_ACCESS_DENIED surfaces as EPERM/EACCES — so "gone" and "present but
 *     not openable" really are distinguishable there, and everything that is
 *     not a definite ESRCH is treated as present.
 */
function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return true
  }
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return getErrnoCode(error) !== 'ESRCH'
  }
}

/** `<plugins>/marketplaces` — the marketplace cache root. */
function getMarketplacesDirForCleanup(): string {
  return join(getPluginsDirectory(), 'marketplaces')
}

/**
 * Remove `.marketplace-add-<pid>-<uuid>.staging` directories left behind by
 * interrupted marketplace installs (31 MB across four of them on the machine
 * this was measured on).
 *
 * Both guards must hold, and they are an AND, not an OR: the directory must be
 * older than an hour *and* the pid in its name must be gone. The age alone
 * would race a slow clone; the dead pid alone would race pid reuse.
 */
export async function cleanupStaleMarketplaceStagingDirs(): Promise<CleanupResult> {
  const result: CleanupResult = { messages: 0, errors: 0 }
  const fsImpl = getFsImplementation()
  const marketplacesDir = getMarketplacesDirForCleanup()
  const cutoffDate = new Date(Date.now() - ONE_HOUR_MS)

  let dirents
  try {
    dirents = await fsImpl.readdir(marketplacesDir)
  } catch {
    return result
  }

  for (const dirent of dirents) {
    if (!dirent.isDirectory()) continue
    const match = MARKETPLACE_STAGING_DIR_NAME.exec(dirent.name)
    if (!match) continue
    if (isProcessAlive(Number(match[1]))) continue

    const stagingPath = join(marketplacesDir, dirent.name)
    try {
      const stats = await fsImpl.stat(stagingPath)
      if (stats.mtime >= cutoffDate) continue
      await fsImpl.rm(stagingPath, { recursive: true, force: true })
      result.messages++
    } catch {
      result.errors++
    }
  }

  return result
}

/**
 * Remove shell snapshots older than seven days from `~/.crabcode/shell-snapshots/`.
 *
 * `ShellSnapshot.ts` only ever writes there; nothing reclaims, so the directory
 * grows one file per session forever (219 on the measured machine). The writer
 * is deliberately left alone — reclamation lives here with every other retention
 * rule. A snapshot that a still-running shell would have sourced is safe to lose:
 * `bashProvider` re-checks the path with `access()` and falls back to a login
 * shell when it has gone.
 */
export async function cleanupOldShellSnapshots(): Promise<CleanupResult> {
  const result: CleanupResult = { messages: 0, errors: 0 }
  const fsImpl = getFsImplementation()
  const snapshotsDir = join(getCrabCodeConfigHomeDir(), 'shell-snapshots')
  const cutoffDate = new Date(Date.now() - SHELL_SNAPSHOT_RETENTION_MS)

  let dirents
  try {
    dirents = await fsImpl.readdir(snapshotsDir)
  } catch {
    return result
  }

  for (const dirent of dirents) {
    if (!dirent.isFile() || !SHELL_SNAPSHOT_FILE_NAME.test(dirent.name)) {
      continue
    }
    try {
      if (
        await unlinkIfOld(join(snapshotsDir, dirent.name), cutoffDate, fsImpl)
      ) {
        result.messages++
      }
    } catch {
      result.errors++
    }
  }

  // Intentionally do NOT remove snapshotsDir — live shells write into it.
  return result
}

/**
 * Remove marketplace directories no `known_marketplaces.json` entry points at.
 *
 * The one on the measured machine was 63 MB: a pre-generation-layout
 * `crabcode-plugins-official/` still on disk after the registry moved to
 * `crabcode-plugins-official-<generationId>/`.
 *
 * A registry that cannot be read is NOT a registry with no references — every
 * read failure, parse failure, non-object shape, or entry missing the required
 * `installLocation` string aborts the whole sweep with nothing deleted, rather
 * than reporting every directory as unreferenced.
 *
 * Dot-prefixed entries are skipped outright, which is wider than the spec's
 * `.staging` exclusion and deliberately so: an in-flight install's *unsuffixed*
 * `.marketplace-add-<pid>-<uuid>` path is a live directory that no registry
 * entry references yet.
 */
export async function cleanupOrphanedMarketplaceDirs(): Promise<CleanupResult> {
  const result: CleanupResult = { messages: 0, errors: 0 }
  const fsImpl = getFsImplementation()
  const pluginsDir = getPluginsDirectory()
  const marketplacesDir = getMarketplacesDirForCleanup()

  let raw: string
  try {
    raw = await fsImpl.readFile(join(pluginsDir, 'known_marketplaces.json'), {
      encoding: 'utf8',
    })
  } catch {
    return result
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return result
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return result
  }

  const referenced = new Set<string>()
  for (const entry of Object.values(parsed as Record<string, unknown>)) {
    if (typeof entry !== 'object' || entry === null) return result
    const location = (entry as { installLocation?: unknown }).installLocation
    // `installLocation` is required by KnownMarketplaceSchema. An entry without
    // one is a registry we do not understand, so we stop rather than guess.
    if (typeof location !== 'string' || location.length === 0) return result

    // Legacy entries stored relative paths, resolved against the plugins root.
    const absolute = isAbsolute(location)
      ? resolve(location)
      : resolve(pluginsDir, location)
    const segment = firstSegmentUnder(marketplacesDir, absolute)
    if (segment !== null) {
      referenced.add(normalizeEntryName(segment))
    }
    // A location resolving outside the marketplaces dir still shields a
    // same-named directory inside it. Over-protecting keeps a stale directory;
    // under-protecting deletes a live one.
    referenced.add(normalizeEntryName(basename(absolute)))
  }

  let dirents
  try {
    dirents = await fsImpl.readdir(marketplacesDir)
  } catch {
    return result
  }

  for (const dirent of dirents) {
    if (!dirent.isDirectory()) continue
    if (dirent.name.startsWith('.') || dirent.name.endsWith('.staging')) {
      continue
    }
    if (referenced.has(normalizeEntryName(dirent.name))) continue
    try {
      await fsImpl.rm(join(marketplacesDir, dirent.name), {
        recursive: true,
        force: true,
      })
      result.messages++
    } catch {
      result.errors++
    }
  }

  return result
}

/**
 * `$XDG_DATA_HOME/crabcode/versions`, byte-for-byte the directory
 * `scripts/install.ps1` / `install.sh` and the Rust
 * `native_installer_versions_dir()` install into.
 */
function getNativeInstallerVersionsDir(): string | null {
  const dataHomeEnv = process.env.XDG_DATA_HOME
  const dataHome =
    dataHomeEnv && dataHomeEnv.length > 0
      ? dataHomeEnv
      : join(homedir(), '.local', 'share')
  if (!isAbsolute(dataHome)) return null
  return join(dataHome, 'crabcode', 'versions')
}

/**
 * Remove installed version trees that are neither what `.current` names nor
 * where this process is actually running from (244 MB of superseded 1.0.35 on
 * the measured machine).
 *
 * "Where this process is running from" is derived from `process.execPath` — the
 * release layout puts the running `bun` inside the version directory — and NOT
 * from `.current`, which is exactly the file that can be stale or wrong. Both
 * answers are computed independently and both are kept.
 *
 * Every uncertainty aborts the whole sweep with nothing deleted:
 *   - the versions dir cannot be realpath'd (no native install here);
 *   - `process.execPath` does not resolve to somewhere below the versions dir
 *     (a dev/npm run — this process has no version directory to protect, so no
 *     directory may be deleted either);
 *   - `.current` is missing, empty, relative, unresolvable, or points outside
 *     the versions tree.
 *
 * Dot-prefixed entries (`.current`, `.launcher-v1`, `.install-<v>-<uuid>`
 * incoming trees) are installer-owned and never touched.
 *
 * @param options.versionsDir Override the versions root (tests).
 * @param options.execPath Override the running executable (tests).
 */
export async function cleanupSupersededInstallVersions(options?: {
  versionsDir?: string
  execPath?: string
}): Promise<CleanupResult> {
  const result: CleanupResult = { messages: 0, errors: 0 }
  const fsImpl = getFsImplementation()
  const versionsDir = options?.versionsDir ?? getNativeInstallerVersionsDir()
  if (versionsDir === null) return result

  let versionsRoot: string
  let execPathReal: string
  try {
    versionsRoot = fsImpl.realpathSync(versionsDir)
    execPathReal = fsImpl.realpathSync(options?.execPath ?? process.execPath)
  } catch {
    return result
  }

  const runningVersion = firstSegmentUnder(versionsRoot, execPathReal)
  if (runningVersion === null) return result

  let declared: string
  try {
    declared = (
      await fsImpl.readFile(join(versionsRoot, '.current'), {
        encoding: 'utf8',
      })
    ).trim()
  } catch {
    return result
  }
  if (declared.length === 0 || !isAbsolute(declared)) return result

  let declaredVersion: string | null
  try {
    declaredVersion = firstSegmentUnder(
      versionsRoot,
      fsImpl.realpathSync(declared),
    )
  } catch {
    // `.current` names a directory we cannot resolve. We no longer know which
    // entry it protects, so we protect all of them.
    return result
  }
  if (declaredVersion === null) return result

  const keep = new Set([
    normalizeEntryName(runningVersion),
    normalizeEntryName(declaredVersion),
  ])

  let dirents
  try {
    dirents = await fsImpl.readdir(versionsRoot)
  } catch {
    return result
  }

  for (const dirent of dirents) {
    if (!dirent.isDirectory()) continue
    if (dirent.name.startsWith('.')) continue
    if (keep.has(normalizeEntryName(dirent.name))) continue
    try {
      await fsImpl.rm(join(versionsRoot, dirent.name), {
        recursive: true,
        force: true,
      })
      result.messages++
    } catch {
      result.errors++
    }
  }

  return result
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000

/**
 * Clean up old npm cache entries for Acosmi packages.
 * This helps reduce disk usage since we publish many dev versions per day.
 * Only runs once per day for Ant users.
 */
export async function cleanupNpmCacheForAcosmiPackages(): Promise<void> {
  const markerPath = join(getCrabCodeConfigHomeDir(), '.npm-cache-cleanup')

  try {
    const stat = await fs.stat(markerPath)
    if (Date.now() - stat.mtimeMs < ONE_DAY_MS) {
      logForDebugging('npm cache cleanup: skipping, ran recently')
      return
    }
  } catch {
    // File doesn't exist, proceed with cleanup
  }

  try {
    await lockfile.lock(markerPath, { retries: 0, realpath: false })
  } catch {
    logForDebugging('npm cache cleanup: skipping, lock held')
    return
  }

  logForDebugging('npm cache cleanup: starting')

  const npmCachePath = join(homedir(), '.npm', '_cacache')

  const NPM_CACHE_RETENTION_COUNT = 5

  const startTime = Date.now()
  try {
    const cacache = await import('cacache')
    const cutoff = startTime - ONE_DAY_MS

    // Stream index entries and collect all Acosmi package entries.
    // Previous implementation used cacache.verify() which does a full
    // integrity check + GC of the ENTIRE cache — O(all content blobs).
    // On large caches this took 60+ seconds and blocked the event loop.
    const stream = cacache.ls.stream(npmCachePath)
    const acosmiEntries: { key: string; time: number }[] = []
    for await (const entry of stream as AsyncIterable<{
      key: string
      time: number
    }>) {
      if (entry.key.includes('@acosmi-ai/crabcode')) {
        acosmiEntries.push({ key: entry.key, time: entry.time })
      }
    }

    // Group by package name (everything before the last @version separator)
    const byPackage = new Map<string, { key: string; time: number }[]>()
    for (const entry of acosmiEntries) {
      const atVersionIdx = entry.key.lastIndexOf('@')
      const pkgName =
        atVersionIdx > 0 ? entry.key.slice(0, atVersionIdx) : entry.key
      const existing = byPackage.get(pkgName) ?? []
      existing.push(entry)
      byPackage.set(pkgName, existing)
    }

    // Remove entries older than 1 day OR beyond the top N most recent per package
    const keysToRemove: string[] = []
    for (const [, entries] of byPackage) {
      entries.sort((a, b) => b.time - a.time) // newest first
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i]!
        if (entry.time < cutoff || i >= NPM_CACHE_RETENTION_COUNT) {
          keysToRemove.push(entry.key)
        }
      }
    }

    await Promise.all(
      keysToRemove.map(key => cacache.rm.entry(npmCachePath, key)),
    )

    await fs.writeFile(markerPath, new Date().toISOString())

    const durationMs = Date.now() - startTime
    if (keysToRemove.length > 0) {
      logForDebugging(
        `npm cache cleanup: Removed ${keysToRemove.length} old @acosmi-ai entries in ${durationMs}ms`,
      )
    } else {
      logForDebugging(`npm cache cleanup: completed in ${durationMs}ms`)
    }
    logEvent('tengu_npm_cache_cleanup', {
      success: true,
      durationMs,
      entriesRemoved: keysToRemove.length,
    })
  } catch (error) {
    logError(error as Error)
    logEvent('tengu_npm_cache_cleanup', {
      success: false,
      durationMs: Date.now() - startTime,
    })
  } finally {
    await lockfile.unlock(markerPath, { realpath: false }).catch(() => {})
  }
}

async function cleanupOldMessageFilesCore(): Promise<void> {
  // If settings have validation errors but the user explicitly set cleanupPeriodDays,
  // skip cleanup entirely rather than falling back to the default (30 days).
  // This prevents accidentally deleting files when the user intended a different retention period.
  const { errors } = getSettingsWithAllErrors()
  if (errors.length > 0 && rawSettingsContainsKey('cleanupPeriodDays')) {
    logForDebugging(
      'Skipping cleanup: settings have validation errors but cleanupPeriodDays was explicitly set. Fix settings errors to enable cleanup.',
    )
    return
  }

  await cleanupOldMessageFiles()
  await cleanupOldSessionFiles()
  await cleanupOldPlanFiles()
  await cleanupOldFileHistoryBackups()
  await cleanupOldSessionEnvDirs()
  await cleanupOldDebugLogs()
  await cleanupOldImageCaches()
  await cleanupOldPastes(getCutoffDate())
  await cleanupStaleMarketplaceStagingDirs()
  await cleanupOldShellSnapshots()
  await cleanupOrphanedMarketplaceDirs()
  await cleanupSupersededInstallVersions()
  const removedWorktrees = await cleanupStaleAgentWorktrees(getCutoffDate())
  if (removedWorktrees > 0) {
    logEvent('tengu_worktree_cleanup', { removed: removedWorktrees })
  }
}

/**
 * Renderer- and server-free cleanup used by the dedicated native TUI.
 *
 * Ant npm-cache cleanup is an internal distribution concern and stays out.
 * User-owned transcript, plan, file-history, media, paste and stale worktree
 * retention stays identical.
 *
 * Superseded native generations ARE reclaimed here (P2-10): the installer only
 * ever adds a version tree, so nothing else was ever going to remove the one
 * an update left behind. `cleanupSupersededInstallVersions` self-limits to
 * processes actually running out of the versions tree, so this call is inert
 * for dev and npm runs. It reaches this far only after startup succeeded and
 * `initializeVersionedPlugins()` completed — `startDirectTuiBackendLifecycle`
 * is called after both, and defers this whole body behind an idle timer.
 */
export async function cleanupDirectTuiUserDataInBackground(): Promise<void> {
  await cleanupOldMessageFilesCore()
}

export async function cleanupOldMessageFilesInBackground(): Promise<void> {
  await cleanupOldMessageFilesCore()
  if (process.env.USER_TYPE === 'ant') {
    await cleanupNpmCacheForAcosmiPackages()
  }
}
