import { AsyncLocalStorage } from 'node:async_hooks'
import { dirname, join } from 'node:path'
import { getCrabCodeConfigHomeDir } from './envUtils.js'
import { getErrnoCode } from './errors.js'
import { getFsImplementation } from './fsOperations.js'
import * as lockfile from './lockfile.js'

export type CrossProcessResource =
  | 'account-bridge-master-key'
  | 'custom-model-config'
  | 'installed-plugins-registry'
  | 'marketplace-cache-mutation'
  | 'marketplace-registry'
  | 'pending-notifications'
  | 'plugin-marketplace-membership'
  | 'secure-storage-mutation'

export type CrossProcessResourceLockOptions = {
  /**
   * Lock this concrete state file instead of the resource's config-home
   * sentinel. Registry callers use the real target so an explicit plugin
   * cache override still shares one mutex across CrabCode config homes.
   */
  targetPath?: string
  /** Override the synchronous acquisition retry budget for this call site. */
  syncAttempts?: number
}

const LOCK_STALE_MS = 120_000
const LOCK_UPDATE_MS = 10_000
/**
 * 12 attempts with `retryDelayMs` = 25+50+100+200+200x7 = 1,775 ms of waiting
 * before the acquisition is reported as contended.
 *
 * Every holder of these locks keeps its critical section to a bounded local
 * read/commit measured in milliseconds — the marketplace catalog resolution
 * that used to hold this lock 76 times per discovery pass now takes it once.
 * A holder that is still not done after ~1.8 s is therefore not "about to
 * finish"; it is blocked or dead, and the honest answer to the caller is a
 * contention error it can retry deliberately, not another four seconds of
 * blind sleeping inside the acquire loop.
 */
const ASYNC_LOCK_ATTEMPTS = 12
const SYNC_LOCK_ATTEMPTS = 8

const processTails = new Map<string, Promise<void>>()
type HeldLockToken = { active: boolean }
const heldLocks = new AsyncLocalStorage<Map<string, HeldLockToken>>()

function queueKeyFor(
  resource: CrossProcessResource,
  options?: CrossProcessResourceLockOptions,
): string {
  return options?.targetPath
    ? `${resource}\0${options.targetPath}`
    : resource
}

function assertNotReentrant(queueKey: string): void {
  if (heldLocks.getStore()?.get(queueKey)?.active) {
    throw new Error(`recursive cross-process resource lock: ${queueKey}`)
  }
}

function lockPaths(
  resource: CrossProcessResource,
  options?: CrossProcessResourceLockOptions,
): {
  targetPath: string
  lockPath: string
  parentPath: string
} {
  const targetPath =
    options?.targetPath ??
    join(getCrabCodeConfigHomeDir(), `.${resource}.transaction`)
  return {
    targetPath,
    lockPath: `${targetPath}.lock`,
    parentPath: dirname(targetPath),
  }
}

function retryDelayMs(attempt: number): number {
  return Math.min(25 * 2 ** attempt, 200)
}

function isLocked(error: unknown): boolean {
  return getErrnoCode(error) === 'ELOCKED'
}

async function acquireAsync(
  resource: CrossProcessResource,
  options?: CrossProcessResourceLockOptions,
): Promise<() => Promise<void>> {
  const { targetPath, lockPath, parentPath } = lockPaths(resource, options)
  await getFsImplementation().mkdir(parentPath)

  let lastError: unknown
  for (let attempt = 0; attempt < ASYNC_LOCK_ATTEMPTS; attempt++) {
    try {
      return await lockfile.lock(targetPath, {
        lockfilePath: lockPath,
        realpath: false,
        stale: LOCK_STALE_MS,
        update: LOCK_UPDATE_MS,
        // The default callback throws from a timer and can crash the process.
        // A stolen lock is already an external integrity violation; keep the
        // message path/secret-free and let the guarded operation fail through
        // its own durable checks instead of raising an unhandled exception.
        onCompromised: () => {
          console.warn(`[resource-lock] ${resource} lock was compromised`)
        },
      })
    } catch (error) {
      lastError = error
      if (!isLocked(error) || attempt === ASYNC_LOCK_ATTEMPTS - 1) break
      await Bun.sleep(retryDelayMs(attempt))
    }
  }
  throw new Error(
    `failed to acquire ${resource} transaction lock (${getErrnoCode(lastError) ?? 'unknown'})`,
  )
}

function acquireSync(
  resource: CrossProcessResource,
  options?: CrossProcessResourceLockOptions,
): () => void {
  const { targetPath, lockPath, parentPath } = lockPaths(resource, options)
  const syncAttempts = options?.syncAttempts ?? SYNC_LOCK_ATTEMPTS
  try {
    getFsImplementation().mkdirSync(parentPath)
  } catch (error) {
    if (getErrnoCode(error) !== 'EEXIST') throw error
  }

  let lastError: unknown
  for (let attempt = 0; attempt < syncAttempts; attempt++) {
    try {
      return lockfile.lockSync(targetPath, {
        lockfilePath: lockPath,
        realpath: false,
        stale: LOCK_STALE_MS,
        update: LOCK_UPDATE_MS,
        onCompromised: () => {
          console.warn(`[resource-lock] ${resource} lock was compromised`)
        },
      })
    } catch (error) {
      lastError = error
      if (!isLocked(error) || attempt === syncAttempts - 1) break
      Bun.sleepSync(retryDelayMs(attempt))
    }
  }
  throw new Error(
    `failed to acquire ${resource} transaction lock (${getErrnoCode(lastError) ?? 'unknown'})`,
  )
}

/**
 * FIFO in-process + proper-lockfile across processes. Callers must keep the
 * critical section bounded and must not recursively acquire the same resource.
 */
export async function withCrossProcessResourceLock<T>(
  resource: CrossProcessResource,
  operation: () => Promise<T>,
  options?: CrossProcessResourceLockOptions,
): Promise<T> {
  const queueKey = queueKeyFor(resource, options)
  assertNotReentrant(queueKey)
  const previous = processTails.get(queueKey) ?? Promise.resolve()
  let releaseQueue!: () => void
  const queued = new Promise<void>(resolve => {
    releaseQueue = resolve
  })
  processTails.set(queueKey, queued)

  await previous
  const token: HeldLockToken = { active: true }
  const context = new Map(heldLocks.getStore())
  context.set(queueKey, token)
  return heldLocks.run(context, async () => {
    let releaseFile: (() => Promise<void>) | undefined
    try {
      releaseFile = await acquireAsync(resource, options)
      return await operation()
    } finally {
      token.active = false
      if (releaseFile) {
        try {
          await releaseFile()
        } catch {
          console.warn(`[resource-lock] ${resource} lock release failed`)
        }
      }
      releaseQueue()
      if (processTails.get(queueKey) === queued) processTails.delete(queueKey)
    }
  })
}

export function withCrossProcessResourceLockSync<T>(
  resource: CrossProcessResource,
  operation: () => T,
  options?: CrossProcessResourceLockOptions,
): T {
  const queueKey = queueKeyFor(resource, options)
  assertNotReentrant(queueKey)
  const token: HeldLockToken = { active: true }
  const context = new Map(heldLocks.getStore())
  context.set(queueKey, token)
  return heldLocks.run(context, () => {
    const release = acquireSync(resource, options)
    try {
      return operation()
    } finally {
      token.active = false
      try {
        release()
      } catch {
        console.warn(`[resource-lock] ${resource} lock release failed`)
      }
    }
  })
}
