/**
 * Marketplace manager for CrabCode plugins
 *
 * This module provides functionality to:
 * - Manage known marketplace sources (URLs, GitHub repos, npm packages, local files)
 * - Cache marketplace manifests locally for offline access
 * - Install plugins from marketplace entries
 * - Track and update marketplace configurations
 *
 * File structure managed by this module:
 * ~/.crabcode/
 *   └── plugins/
 *       ├── known_marketplaces.json    # Configuration of all known marketplaces
 *       └── marketplaces/              # Cache directory for marketplace data
 *           ├── my-marketplace.json    # Cached marketplace from URL source
 *           └── github-marketplace/    # Cloned repository for GitHub source
 *               └── .crabcode-plugin/
 *                   └── marketplace.json
 */

import axios from 'axios'
import { createHash, randomUUID } from 'node:crypto'
import { Agent as HttpsAgent } from 'node:https'
import { realpath, stat } from 'fs/promises'
import isEqual from 'lodash-es/isEqual.js'
import memoize from 'lodash-es/memoize.js'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'path'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import { logForDebugging } from '../debug.js'
import { isEnvTruthy } from '../envUtils.js'
import {
  ConfigParseError,
  errorMessage,
  getErrnoCode,
  isENOENT,
  toError,
} from '../errors.js'
import { localExecBridge } from 'src/runtime/localProcess.js'
import { getFsImplementation } from '../fsOperations.js'
import { writeFileSyncAtomicNoFallback } from '../file.js'
import { logError } from '../log.js'
import { withCrossProcessResourceLock } from '../crossProcessResourceLock.js'
import {
  getInitialSettings,
  getSettingsForSource,
  updateSettingsForSource,
} from '../settings/settings.js'
import type { SettingsJson } from '../settings/types.js'
import { jsonParse, jsonStringify } from '../slowOperations.js'
import {
  getAddDirEnabledPlugins,
  getAddDirExtraMarketplaces,
} from './addDirPluginSettings.js'
import { classifyFetchError, logPluginFetch } from './fetchTelemetry.js'
import { assertNoInstalledPluginsForMarketplaceStrict } from './installedPluginsManager.js'
import {
  MarketplaceIngressPolicyError,
  type LocalMarketplaceIngressIdentity,
  revalidateLocalMarketplaceIngressIdentity,
  validateAndCaptureMarketplaceIngressSource,
} from './marketplaceIngressPolicy.js'
import {
  extractHostFromSource,
  formatSourceForDisplay,
  getHostPatternsFromAllowlist,
  getStrictKnownMarketplaces,
  isSourceAllowedByPolicy,
  isSourceInBlocklist,
} from './marketplaceHelpers.js'
import {
  LEGACY_OFFICIAL_MARKETPLACE_REPO,
  OFFICIAL_MARKETPLACE_NAME,
  OFFICIAL_MARKETPLACE_SOURCE,
} from './officialMarketplace.js'
import { fetchOfficialMarketplaceFromGcs } from './officialMarketplaceGcs.js'
import { normalizeSafeAbsoluteMarketplaceInstallLocation } from './marketplaceInstallLocation.js'
import { normalizeMarketplaceSparsePaths } from './marketplaceSparsePaths.js'
import { getPluginSeedDirs, getPluginsDirectory } from './pluginDirectories.js'
import { parsePluginIdentifier } from './pluginIdentifier.js'
import {
  PluginPathSecurityError,
  readCanonicalPluginTextFile,
  resolveInternalPluginPath,
  resolvePluginComponentPath,
  writeCanonicalPluginFile,
} from './pluginPathSecurity.js'
import {
  isLocalMarketplaceSource,
  type KnownMarketplace,
  type KnownMarketplacesFile,
  KnownMarketplacesFileSchema,
  type MarketplaceCategory,
  MarketplaceCategorySchema,
  type MarketplaceSource,
  type PluginMarketplace,
  type PluginMarketplaceEntry,
  type PluginManifest,
  PluginManifestSchema,
  PluginMarketplaceSchema,
  validateOfficialNameSource,
} from './schemas.js'

/**
 * Result of loading and caching a marketplace
 */
type LoadedPluginMarketplace = {
  marketplace: PluginMarketplace
  cachePath: string
  generationId: string
  contentDigest: string
  /**
   * Set only for add-time staging. `cachePath` is the unpublished generation
   * and `publishPath` is the eventual live cache location.
   */
  publishPath?: string
}

function canonicalMarketplaceJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value
      .map((item) =>
        item === undefined ? 'null' : canonicalMarketplaceJson(item),
      )
      .join(',')}]`
  }
  const object = value as Record<string, unknown>
  return `{${Object.keys(object)
    .filter((key) => object[key] !== undefined)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonicalMarketplaceJson(object[key])}`,
    )
    .join(',')}}`
}

/** Stable identity of the fully parsed marketplace catalog. */
export function computeMarketplaceContentDigest(
  marketplace: PluginMarketplace,
): string {
  return createHash('sha256')
    .update(canonicalMarketplaceJson(marketplace))
    .digest('hex')
}

export type MarketplaceCacheMutationContext = {
  pluginsRoot: string
  cacheDir: string
  lockTarget: string
  membershipLockTarget: string
}

/**
 * Get the path to the known marketplaces configuration file
 * Using a function instead of a constant allows proper mocking in tests
 */
function getKnownMarketplacesFile(): string {
  return join(getPluginsDirectory(), 'known_marketplaces.json')
}

/**
 * Get the path to the marketplaces cache directory
 * Using a function instead of a constant allows proper mocking in tests
 */
export function getMarketplacesCacheDir(): string {
  return join(getPluginsDirectory(), 'marketplaces')
}

/**
 * Memoized inner function to get marketplace data.
 * This caches the marketplace in memory after loading from disk or network.
 */

/**
 * Clear all cached marketplace data (for testing)
 */
export function clearMarketplacesCache(): void {
  getMarketplace.cache?.clear?.()
}

/**
 * Configuration for known marketplaces
 */
export type KnownMarketplacesConfig = KnownMarketplacesFile

type KnownMarketplacesTransactionResult<T> = {
  value: T
  changed: boolean
  /** Runs while the registry lock is still held if atomic publication fails. */
  onCommitFailure?: () => Promise<void>
  /** Runs after the registry commit while its lock remains held. */
  commitSibling?: () => Promise<void>
  /** Reverses non-registry state when the sibling commit fails. */
  onSiblingFailure?: () => Promise<void>
}

export const MARKETPLACE_REGISTRY_SIBLING_COMMIT_FAILED =
  'MARKETPLACE_REGISTRY_SIBLING_COMMIT_FAILED' as const
export const MARKETPLACE_REGISTRY_SIBLING_ROLLBACK_FAILED =
  'MARKETPLACE_REGISTRY_SIBLING_ROLLBACK_FAILED' as const

export class MarketplaceRegistrySiblingCommitError extends Error {
  constructor(
    readonly code:
      | typeof MARKETPLACE_REGISTRY_SIBLING_COMMIT_FAILED
      | typeof MARKETPLACE_REGISTRY_SIBLING_ROLLBACK_FAILED,
    readonly siblingError: unknown,
    readonly rollbackErrors: unknown[] = [],
  ) {
    super(
      code === MARKETPLACE_REGISTRY_SIBLING_ROLLBACK_FAILED
        ? `[${code}] sibling commit failed: ${errorMessage(siblingError)}; rollback failed: ${rollbackErrors.map(errorMessage).join('; ')}`
        : `[${code}] sibling commit failed: ${errorMessage(siblingError)}; marketplace registry and coordinated state restored`,
    )
    this.name = 'MarketplaceRegistrySiblingCommitError'
  }
}

/**
 * Declared marketplace entry (intent layer).
 *
 * Structurally compatible with settings `extraKnownMarketplaces` entries, but
 * adds `sourceIsFallback` for implicit built-in declarations. This is NOT a
 * settings-schema field — it's only ever set in code (never parsed from JSON).
 */
export type DeclaredMarketplace = {
  source: MarketplaceSource
  installLocation?: string
  autoUpdate?: boolean
  /**
   * Presence suffices. When set, diffMarketplaces treats an already-materialized
   * entry as upToDate regardless of source shape — never reports sourceChanged.
   *
   * Used for the implicit official-marketplace declaration: we want "clone from
   * GitHub if missing", not "replace with GitHub if present under a different
   * source". Without this, a seed dir that registers the official marketplace
   * under e.g. an internal-mirror source would be stomped by a GitHub re-clone.
   */
  sourceIsFallback?: boolean
}

/**
 * Get declared marketplace intent from merged settings and --add-dir sources.
 * This is what SHOULD exist — used by the reconciler to find gaps.
 *
 * The official marketplace is implicitly declared with `sourceIsFallback: true`
 * when any enabled plugin references it.
 */
export function getDeclaredMarketplaces(): Record<string, DeclaredMarketplace> {
  const implicit: Record<string, DeclaredMarketplace> = {}

  // Only the official marketplace can be implicitly declared — it's the one
  // built-in source we know. Other marketplaces have no default source to inject.
  // Explicitly-disabled entries (value: false) don't count.
  const enabledPlugins = {
    ...getAddDirEnabledPlugins(),
    ...(getInitialSettings().enabledPlugins ?? {}),
  }
  for (const [pluginId, value] of Object.entries(enabledPlugins)) {
    if (
      value &&
      parsePluginIdentifier(pluginId).marketplace === OFFICIAL_MARKETPLACE_NAME
    ) {
      implicit[OFFICIAL_MARKETPLACE_NAME] = {
        source: OFFICIAL_MARKETPLACE_SOURCE,
        sourceIsFallback: true,
      }
      break
    }
  }

  // Lowest precedence: implicit < --add-dir < merged settings.
  // An explicit extraKnownMarketplaces entry for crabcode-plugins-official
  // in --add-dir or settings wins.
  return {
    ...implicit,
    ...getAddDirExtraMarketplaces(),
    ...(getInitialSettings().extraKnownMarketplaces ?? {}),
  }
}

/**
 * Find which editable settings source declared a marketplace.
 * Checks in reverse precedence order (highest priority last) so the
 * result is the source that "wins" in the merged view.
 * Returns null if the marketplace isn't declared in any editable source.
 */
export function getMarketplaceDeclaringSource(
  name: string,
): 'userSettings' | 'projectSettings' | 'localSettings' | null {
  // Check highest-precedence editable sources first — the one that wins
  // in the merged view is the one we should write back to.
  const editableSources: Array<
    'localSettings' | 'projectSettings' | 'userSettings'
  > = ['localSettings', 'projectSettings', 'userSettings']

  for (const source of editableSources) {
    const settings = getSettingsForSource(source)
    if (settings?.extraKnownMarketplaces?.[name]) {
      return source
    }
  }
  return null
}

/**
 * Save a marketplace entry to settings (intent layer).
 * Does NOT touch known_marketplaces.json (state layer).
 *
 * @param name - The marketplace name
 * @param entry - The marketplace config
 * @param settingSource - Which settings source to write to (defaults to userSettings)
 */
export function saveMarketplaceToSettings(
  name: string,
  entry: DeclaredMarketplace,
  settingSource:
    'userSettings' | 'projectSettings' | 'localSettings' = 'userSettings',
): void {
  const existing = getSettingsForSource(settingSource) ?? {}
  const current = { ...existing.extraKnownMarketplaces }
  current[name] = entry
  updateSettingsForSource(settingSource, { extraKnownMarketplaces: current })
}

/**
 * Load known marketplaces configuration from disk
 *
 * Reads the configuration file at ~/.crabcode/plugins/known_marketplaces.json
 * which contains a mapping of marketplace names to their sources and metadata.
 *
 * Example configuration file content:
 * ```json
 * {
 *   "official-marketplace": {
 *     "source": { "source": "url", "url": "https://example.com/marketplace.json" },
 *     "installLocation": "/Users/me/.crabcode/plugins/marketplaces/official-marketplace.json",
 *     "lastUpdated": "2024-01-15T10:30:00.000Z"
 *   },
 *   "company-plugins": {
 *     "source": { "source": "github", "repo": "mycompany/plugins" },
 *     "installLocation": "/Users/me/.crabcode/plugins/marketplaces/company-plugins",
 *     "lastUpdated": "2024-01-14T15:45:00.000Z"
 *   }
 * }
 * ```
 *
 * @returns Configuration object mapping marketplace names to their metadata
 */
export async function loadKnownMarketplacesConfig(): Promise<KnownMarketplacesConfig> {
  return loadKnownMarketplacesConfigFromFile(getKnownMarketplacesFile())
}

async function loadKnownMarketplacesConfigFromFile(
  configFile: string,
): Promise<KnownMarketplacesConfig> {
  const fs = getFsImplementation()

  try {
    const content = await fs.readFile(configFile, {
      encoding: 'utf-8',
    })
    const data = jsonParse(content)
    // Validate against schema
    const parsed = KnownMarketplacesFileSchema().safeParse(data)
    if (!parsed.success) {
      const errorMsg = `Marketplace configuration file is corrupted: ${parsed.error.issues.map((e) => `${e.path.join('.')}: ${e.message}`).join(', ')}`
      logForDebugging(errorMsg, {
        level: 'error',
      })
      throw new ConfigParseError(errorMsg, configFile, data)
    }
    return parsed.data
  } catch (error) {
    if (isENOENT(error)) {
      return {}
    }
    // If it's already a ConfigParseError, re-throw it
    if (error instanceof ConfigParseError) {
      throw error
    }
    // For JSON parse errors or I/O errors, throw with helpful message
    const errorMsg = `Failed to load marketplace configuration: ${errorMessage(error)}`
    logForDebugging(errorMsg, {
      level: 'error',
    })
    throw new Error(errorMsg)
  }
}

/**
 * Load known marketplaces config, returning {} on any error instead of throwing.
 *
 * Use this on read-only paths (plugin loading, feature checks) where a corrupted
 * config should degrade gracefully rather than crash. DO NOT use on load→mutate→save
 * paths — returning {} there would cause the save to overwrite the corrupted file
 * with just the new entry, permanently destroying the user's other entries. The
 * throwing variant preserves the file so the user can fix the corruption and recover.
 */
export async function loadKnownMarketplacesConfigSafe(): Promise<KnownMarketplacesConfig> {
  try {
    return await loadKnownMarketplacesConfig()
  } catch {
    // Inner function already logged via logForDebugging. Don't logError here —
    // corrupted user config isn't a CrabCode bug, shouldn't hit the error file.
    return {}
  }
}

/**
 * Save known marketplaces configuration to disk
 *
 * Writes the configuration to ~/.crabcode/plugins/known_marketplaces.json,
 * creating the directory structure if it doesn't exist.
 *
 * @param config - The marketplace configuration to save
 */
export async function saveKnownMarketplacesConfig(
  config: KnownMarketplacesConfig,
): Promise<void> {
  const configFile = getKnownMarketplacesFile()
  await withCrossProcessResourceLock(
    'marketplace-registry',
    () => saveKnownMarketplacesConfigWithinTransaction(config, configFile),
    { targetPath: configFile },
  )
}

async function saveKnownMarketplacesConfigWithinTransaction(
  config: KnownMarketplacesConfig,
  configFile = getKnownMarketplacesFile(),
): Promise<void> {
  // Validate before saving
  const parsed = KnownMarketplacesFileSchema().safeParse(config)

  if (!parsed.success) {
    throw new ConfigParseError(
      `Invalid marketplace config: ${parsed.error.message}`,
      configFile,
      config,
    )
  }

  const fs = getFsImplementation()
  const dir = dirname(configFile)
  await fs.mkdir(dir)
  writeFileSyncAtomicNoFallback(
    configFile,
    `${jsonStringify(parsed.data, null, 2)}\n`,
    { encoding: 'utf-8', mode: 0o600 },
  )
}

async function withKnownMarketplacesTransaction<T>(
  operation: (
    config: KnownMarketplacesConfig,
  ) => Promise<KnownMarketplacesTransactionResult<T>>,
  configFile = getKnownMarketplacesFile(),
): Promise<T> {
  return withCrossProcessResourceLock(
    'marketplace-registry',
    async () => {
      // The read must happen only after the cross-process mutex is held. A
      // lock around save alone still permits two processes to derive writes
      // from the same stale generation and lose one update.
      const config = await loadKnownMarketplacesConfigFromFile(configFile)
      const preState = KnownMarketplacesFileSchema().parse(config)
      const result = await operation(config)
      if (result.changed) {
        try {
          await saveKnownMarketplacesConfigWithinTransaction(config, configFile)
        } catch (commitError) {
          if (result.onCommitFailure) {
            try {
              await result.onCommitFailure()
            } catch (rollbackError) {
              throw new Error(
                `Marketplace registry commit failed (${errorMessage(commitError)}) and coordinated rollback failed (${errorMessage(rollbackError)})`,
              )
            }
          }
          throw commitError
        }
      }
      if (result.commitSibling) {
        try {
          await result.commitSibling()
        } catch (siblingError) {
          const rollbackErrors: unknown[] = []
          if (result.changed) {
            try {
              await saveKnownMarketplacesConfigWithinTransaction(
                preState,
                configFile,
              )
            } catch (error) {
              rollbackErrors.push(error)
            }
          }
          if (result.onSiblingFailure) {
            try {
              await result.onSiblingFailure()
            } catch (error) {
              rollbackErrors.push(error)
            }
          }
          throw new MarketplaceRegistrySiblingCommitError(
            rollbackErrors.length > 0
              ? MARKETPLACE_REGISTRY_SIBLING_ROLLBACK_FAILED
              : MARKETPLACE_REGISTRY_SIBLING_COMMIT_FAILED,
            siblingError,
            rollbackErrors,
          )
        }
      }
      return result.value
    },
    { targetPath: configFile },
  )
}

/**
 * Atomically mutate the known-marketplaces registry. External producers such
 * as startup seeding must use this instead of a separate load + save pair.
 */
export async function updateKnownMarketplacesConfig(
  operation: (config: KnownMarketplacesConfig) => void | Promise<void>,
): Promise<void> {
  await withKnownMarketplacesTransaction(async (config) => {
    await operation(config)
    return { value: undefined, changed: true }
  })
}

/**
 * Serialize cache materialization/removal/refresh across processes. Registry
 * mutations take their own file lock inside this outer cache lock, giving one
 * global lock order (cache → registry) and preventing an add/remove/refresh
 * interleave from publishing a registry entry whose cache was just deleted or
 * replaced by another source.
 */
export async function withMarketplaceCacheMutationLock<T>(
  operation: (context: MarketplaceCacheMutationContext) => Promise<T>,
  context: MarketplaceCacheMutationContext = captureMarketplaceCacheContext(),
): Promise<T> {
  return withCrossProcessResourceLock(
    'marketplace-cache-mutation',
    () => operation(context),
    { targetPath: context.lockTarget },
  )
}

/**
 * Serialize the only state transition that changes whether a marketplace has
 * installed members. The target is derived from the concrete plugins root, so
 * processes with different config homes but one CRABCODE_PLUGIN_CACHE_DIR
 * still contend on the same proper-lockfile resource.
 *
 * Global nested order is membership → marketplace cache → marketplace
 * registry → installed registry. Network download/staging must stay outside
 * this lock; only bounded validation and commit work belongs inside it.
 */
export async function withPluginMarketplaceMembershipLock<T>(
  operation: (context: MarketplaceCacheMutationContext) => Promise<T>,
  context: MarketplaceCacheMutationContext = captureMarketplaceCacheContext(),
): Promise<T> {
  return withCrossProcessResourceLock(
    'plugin-marketplace-membership',
    () => operation(context),
    { targetPath: context.membershipLockTarget },
  )
}

function captureMarketplaceCacheContext(): MarketplaceCacheMutationContext {
  const pluginsRoot = getPluginsDirectory()
  return {
    pluginsRoot,
    cacheDir: join(pluginsRoot, 'marketplaces'),
    lockTarget: join(pluginsRoot, '.marketplace-cache-mutation'),
    membershipLockTarget: join(pluginsRoot, '.plugin-marketplace-membership'),
  }
}

export const MARKETPLACE_PLUGIN_INSTALL_COMMIT_REJECTED =
  'MARKETPLACE_PLUGIN_INSTALL_COMMIT_REJECTED'

export type MarketplacePluginInstallationExpectation = {
  pluginId: string
  entry: PluginMarketplaceEntry
  marketplaceInstallLocation: string
  marketplaceGenerationId: string
  marketplaceContentDigest: string
}

/**
 * Commit one installed-registry write only if its marketplace generation is
 * still authoritative. Download/copy/version calculation happens before this
 * function. Inside the short critical section we freeze cache publication,
 * strictly re-read the registry, re-read the referenced catalog, compare the
 * exact plugin entry, then run the installed-registry commit while all outer
 * guards remain held.
 */
export async function commitMarketplacePluginInstallation<T>(
  expectation: MarketplacePluginInstallationExpectation,
  commit: () => T | Promise<T>,
): Promise<T> {
  return commitMarketplacePluginInstallations([expectation], commit)
}

/**
 * Validate a complete dependency closure against one authoritative registry
 * snapshot, then invoke the bounded publish/registry callback exactly once.
 */
export async function commitMarketplacePluginInstallations<T>(
  expectations: readonly MarketplacePluginInstallationExpectation[],
  commit: () => T | Promise<T>,
): Promise<T> {
  if (expectations.length === 0) {
    throw new Error(
      `[${MARKETPLACE_PLUGIN_INSTALL_COMMIT_REJECTED}] Plugin installation requires at least one exact plugin@marketplace expectation`,
    )
  }

  const parsedExpectations = expectations.map((expectation) => {
    const { name: pluginName, marketplace: marketplaceName } =
      parsePluginIdentifier(expectation.pluginId)
    if (!pluginName || !marketplaceName) {
      throw new Error(
        `[${MARKETPLACE_PLUGIN_INSTALL_COMMIT_REJECTED}] Plugin installation requires an exact plugin@marketplace identifier`,
      )
    }
    return { expectation, pluginName, marketplaceName }
  })

  const context = captureMarketplaceCacheContext()
  return withPluginMarketplaceMembershipLock(
    () =>
      withMarketplaceCacheMutationLock(
        () =>
          withKnownMarketplacesTransaction(
            async (config) => {
              const reject = (pluginId: string, reason: string): never => {
                throw new Error(
                  `[${MARKETPLACE_PLUGIN_INSTALL_COMMIT_REJECTED}] Cannot commit '${pluginId}': ${reason}`,
                )
              }

              const catalogs = new Map<
                string,
                { marketplace: PluginMarketplace; canonicalLocation: string }
              >()
              for (const {
                expectation,
                pluginName,
                marketplaceName,
              } of parsedExpectations) {
                const authoritative = config[marketplaceName]
                if (!authoritative) {
                  reject(
                    expectation.pluginId,
                    `marketplace '${marketplaceName}' no longer exists`,
                  )
                }
                if (
                  authoritative.generationId !==
                    expectation.marketplaceGenerationId ||
                  authoritative.contentDigest !==
                    expectation.marketplaceContentDigest
                ) {
                  reject(
                    expectation.pluginId,
                    `marketplace '${marketplaceName}' generation changed`,
                  )
                }

                let loaded = catalogs.get(marketplaceName)
                if (!loaded) {
                  loaded = await (async () => {
                    try {
                      return {
                        marketplace: await readCachedMarketplace(
                          authoritative.installLocation,
                          authoritative.source,
                          context.cacheDir,
                        ),
                        canonicalLocation: await realpath(
                          resolve(authoritative.installLocation),
                        ),
                      }
                    } catch (error) {
                      return reject(
                        expectation.pluginId,
                        `marketplace '${marketplaceName}' is no longer readable (${errorMessage(error)})`,
                      )
                    }
                  })()
                  catalogs.set(marketplaceName, loaded)
                }

                const expectedCanonicalLocation = await realpath(
                  resolve(expectation.marketplaceInstallLocation),
                ).catch((error) =>
                  reject(
                    expectation.pluginId,
                    `expected marketplace install location is no longer readable (${errorMessage(error)})`,
                  ),
                )
                if (loaded.canonicalLocation !== expectedCanonicalLocation) {
                  reject(
                    expectation.pluginId,
                    `marketplace '${marketplaceName}' install location changed`,
                  )
                }

                const actualDigest = computeMarketplaceContentDigest(
                  loaded.marketplace,
                )
                if (
                  actualDigest !== authoritative.contentDigest ||
                  actualDigest !== expectation.marketplaceContentDigest
                ) {
                  reject(
                    expectation.pluginId,
                    `marketplace '${marketplaceName}' content changed`,
                  )
                }

                const authoritativePlugin = loaded.marketplace.plugins.find(
                  (candidate) => candidate.name === pluginName,
                )
                if (
                  !authoritativePlugin ||
                  !isEqual(authoritativePlugin, expectation.entry)
                ) {
                  reject(
                    expectation.pluginId,
                    `marketplace '${marketplaceName}' plugin source changed`,
                  )
                }
              }

              return {
                value: await commit(),
                changed: false,
              }
            },
            join(context.pluginsRoot, 'known_marketplaces.json'),
          ),
        context,
      ),
    context,
  )
}

/**
 * Locked + atomic legacy official-repository migration. Kept in this manager
 * so it resolves the same standard/cowork/override registry as every reader.
 */
export async function migrateOfficialMarketplaceRepoInRegistry(): Promise<boolean> {
  const context = captureMarketplaceCacheContext()
  return withKnownMarketplacesTransaction(async (config) => {
    const entry = config[OFFICIAL_MARKETPLACE_NAME]
    if (
      !entry ||
      entry.source.source !== 'github' ||
      entry.source.repo !== LEGACY_OFFICIAL_MARKETPLACE_REPO
    ) {
      return { value: false, changed: false }
    }
    const marketplace = await readCachedMarketplace(
      entry.installLocation,
      entry.source,
      context.cacheDir,
    )
    entry.source = {
      ...entry.source,
      repo: OFFICIAL_MARKETPLACE_SOURCE.repo,
    }
    entry.generationId = randomUUID()
    entry.contentDigest = computeMarketplaceContentDigest(marketplace)
    return { value: true, changed: true }
  })
}

/**
 * Register marketplaces from the read-only seed directories into the primary
 * known_marketplaces.json.
 *
 * The seed's known_marketplaces.json contains installLocation paths pointing
 * into the seed dir itself. Registering those entries into the primary JSON
 * makes them visible to all marketplace readers (getMarketplaceCacheOnly,
 * getPluginByIdCacheOnly, etc.) without any loader changes — they just follow
 * the installLocation wherever it points.
 *
 * Seed entries always win for marketplaces declared in the seed — the seed is
 * admin-managed (baked into the container image). If admin updates the seed
 * in a new image, those changes propagate on next boot. Users opt out of seed
 * plugins via `plugin disable`, not by removing the marketplace.
 *
 * With multiple seed dirs (path-delimiter-separated), first-seed-wins: a
 * marketplace name claimed by an earlier seed is skipped by later seeds.
 *
 * autoUpdate is forced to false since the seed is read-only and git-pull would
 * fail. installLocation is computed from the runtime seedDir, not trusted from
 * the seed's JSON (handles multi-stage Docker mount-path drift).
 *
 * Idempotent: second call with unchanged seed writes nothing.
 *
 * @returns true if any marketplace entries were written/changed (caller should
 *   clear caches so earlier plugin-load passes don't keep stale "marketplace
 *   not found" state)
 */
export async function registerSeedMarketplaces(): Promise<boolean> {
  const seedDirs = getPluginSeedDirs()
  if (seedDirs.length === 0) return false

  return withKnownMarketplacesTransaction(async (primary) => {
    // First-seed-wins across this registration pass. Can't use the isEqual
    // check alone — two seeds with the same name have different locations.
    const claimed = new Set<string>()
    let changed = 0

    for (const seedDir of seedDirs) {
      const seedConfig = await readSeedKnownMarketplaces(seedDir)
      if (!seedConfig) continue

      for (const [name, seedEntry] of Object.entries(seedConfig)) {
        if (claimed.has(name)) continue

        // Compute installLocation relative to THIS seedDir, not the build-time
        // path baked into the seed's JSON. Handles multi-stage Docker builds
        // where the seed is mounted at a different path than where it was built.
        const resolvedSeed = await findSeedMarketplaceLocation(seedDir, name)
        if (!resolvedSeed) {
          // Seed content missing (incomplete build) — leave primary alone, but
          // don't claim the name either: a later seed may have working content.
          logForDebugging(
            `Seed marketplace '${name}' not found under ${seedDir}/marketplaces/, skipping`,
            { level: 'warn' },
          )
          continue
        }
        claimed.add(name)

        const contentDigest = computeMarketplaceContentDigest(
          resolvedSeed.marketplace,
        )
        const desiredBase = {
          source: seedEntry.source,
          installLocation: resolvedSeed.installLocation,
          lastUpdated: seedEntry.lastUpdated,
          autoUpdate: false,
          contentDigest,
        }

        const current = primary[name]
        const unchanged =
          current !== undefined &&
          isEqual(
            {
              source: current.source,
              installLocation: current.installLocation,
              lastUpdated: current.lastUpdated,
              autoUpdate: current.autoUpdate,
              contentDigest: current.contentDigest,
            },
            desiredBase,
          )

        // A healthy, fully identified seed generation is a true no-op. Legacy
        // entries are upgraded atomically; any seed/source/content change gets
        // a fresh generation identity.
        if (unchanged && current.generationId) continue

        const desired: KnownMarketplace = {
          ...desiredBase,
          generationId: randomUUID(),
        }

        // Seed wins — admin-managed. Overwrite any existing primary entry.
        primary[name] = desired
        changed++
      }
    }

    if (changed > 0) {
      logForDebugging(`Synced ${changed} marketplace(s) from seed dir(s)`)
    }
    return { value: changed > 0, changed: changed > 0 }
  })
}

async function readSeedKnownMarketplaces(
  seedDir: string,
): Promise<KnownMarketplacesConfig | null> {
  const seedJsonPath = join(seedDir, 'known_marketplaces.json')
  try {
    const content = await getFsImplementation().readFile(seedJsonPath, {
      encoding: 'utf-8',
    })
    const parsed = KnownMarketplacesFileSchema().safeParse(jsonParse(content))
    if (!parsed.success) {
      logForDebugging(
        `Seed known_marketplaces.json invalid at ${seedDir}: ${parsed.error.message}`,
        { level: 'warn' },
      )
      return null
    }
    return parsed.data
  } catch (e) {
    if (!isENOENT(e)) {
      logForDebugging(
        `Failed to read seed known_marketplaces.json at ${seedDir}: ${e}`,
        { level: 'warn' },
      )
    }
    return null
  }
}

/**
 * Locate a marketplace in the seed directory by name.
 *
 * Probes the canonical locations under seedDir/marketplaces/ rather than
 * trusting the seed's stored installLocation (which may have a stale absolute
 * path from a different build-time mount point).
 *
 * @returns Readable location, or null if neither format exists/validates
 */
async function findSeedMarketplaceLocation(
  seedDir: string,
  name: string,
): Promise<{
  installLocation: string
  marketplace: PluginMarketplace
} | null> {
  const dirCandidate = join(seedDir, 'marketplaces', name)
  const jsonCandidate = join(seedDir, 'marketplaces', `${name}.json`)
  for (const candidate of [dirCandidate, jsonCandidate]) {
    try {
      const marketplace = await readCachedMarketplace(candidate, {
        source: 'directory',
        path: candidate,
      })
      return { installLocation: candidate, marketplace }
    } catch {
      // Try next candidate
    }
  }
  return null
}

/**
 * If installLocation points into a configured seed directory, return that seed
 * directory. Seed-managed entries are admin-controlled — users can't
 * remove/refresh/modify them (they'd be overwritten by registerSeedMarketplaces
 * on next startup). Returning the specific seed lets error messages name it.
 */
function seedDirFor(installLocation: string): string | undefined {
  return getPluginSeedDirs().find(
    (d) => installLocation === d || installLocation.startsWith(d + sep),
  )
}

/**
 * Git pull operation (exported for testing)
 *
 * Pulls latest changes with a configurable timeout (default 120s, override via CRABCODE_PLUGIN_GIT_TIMEOUT_MS).
 * Provides helpful error messages for common failure scenarios.
 * If a ref is specified, fetches and checks out that specific branch or tag.
 */
// Environment variables to prevent git from prompting for credentials
const GIT_NO_PROMPT_ENV = {
  GIT_TERMINAL_PROMPT: '0', // Prevent terminal credential prompts
  GIT_ASKPASS: '', // Disable graphical askpass programs
}

type MarketplaceGitRuntimeOptions = {
  disableCredentialHelper?: boolean
  hardenedIngress?: boolean
}

const HARDENED_INGRESS_GIT_CONFIG_ARGS = [
  '-c',
  'credential.helper=',
  '-c',
  'http.proxy=',
  '-c',
  'http.sslVerify=true',
  '-c',
  'http.sslVersion=tlsv1.2',
  '-c',
  'http.followRedirects=false',
  '-c',
  'protocol.allow=never',
  '-c',
  'protocol.https.allow=always',
] as const

/**
 * Build a hermetic Git invocation for the remote ingress boundary. In particular,
 * inherited `GIT_CONFIG_*` injection and user/system `url.*.insteadOf` rules
 * must not rewrite an approved HTTPS repository to another host or protocol.
 */
function getMarketplaceGitExecutionContext(
  options?: MarketplaceGitRuntimeOptions,
): { env: NodeJS.ProcessEnv; configArgs: string[] } {
  const env: NodeJS.ProcessEnv = { ...process.env, ...GIT_NO_PROMPT_ENV }
  if (!options?.hardenedIngress) {
    return {
      env,
      configArgs: options?.disableCredentialHelper
        ? ['-c', 'credential.helper=']
        : [],
    }
  }

  const nullConfig = process.platform === 'win32' ? 'NUL' : '/dev/null'
  for (const key of Object.keys(env)) {
    // ExecBridge currently uses execa's default extendEnv behavior. Explicitly
    // neutralize inherited keys instead of merely deleting them from this
    // overlay, which would let execa merge the process value back in.
    if (key === 'GIT_CONFIG') {
      env[key] = nullConfig
    } else if (key === 'GIT_CONFIG_COUNT') {
      env[key] = '0'
    } else if (
      key === 'GIT_CONFIG_PARAMETERS' ||
      key.startsWith('GIT_CONFIG_KEY_') ||
      key.startsWith('GIT_CONFIG_VALUE_')
    ) {
      env[key] = ''
    } else if (key.startsWith('GIT_CONFIG_')) {
      env[key] = nullConfig
    } else if (key === 'GIT_SSL_NO_VERIFY') {
      env[key] = '0'
    } else if (key === 'GIT_SSL_VERSION') {
      env[key] = 'tlsv1.2'
    } else if (key.startsWith('GIT_SSL_')) {
      env[key] = ''
    }
  }
  env.GIT_CONFIG_NOSYSTEM = '1'
  env.GIT_CONFIG_GLOBAL = nullConfig
  env.GIT_CONFIG_SYSTEM = nullConfig
  env.GIT_ALLOW_PROTOCOL = 'https'
  for (const key of [
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'ALL_PROXY',
    'http_proxy',
    'https_proxy',
    'all_proxy',
  ]) {
    // ExecBridge/execa extends the process environment, so an empty overlay is
    // required; deleting would let an inherited proxy reappear.
    env[key] = ''
  }

  return { env, configArgs: [...HARDENED_INGRESS_GIT_CONFIG_ARGS] }
}

const DEFAULT_PLUGIN_GIT_TIMEOUT_MS = 120 * 1000

function getPluginGitTimeoutMs(): number {
  const envValue = process.env.CRABCODE_PLUGIN_GIT_TIMEOUT_MS
  if (envValue) {
    const parsed = parseInt(envValue, 10)
    if (!isNaN(parsed) && parsed > 0) {
      return parsed
    }
  }
  return DEFAULT_PLUGIN_GIT_TIMEOUT_MS
}

export async function gitPull(
  cwd: string,
  ref?: string,
  options?: MarketplaceGitRuntimeOptions & { sparsePaths?: string[] },
): Promise<{ code: number; stderr: string }> {
  logForDebugging(`git pull: cwd=${cwd} ref=${ref ?? 'default'}`)
  const { env, configArgs } = getMarketplaceGitExecutionContext(options)

  if (ref) {
    const fetchResult = await localExecBridge.execGitCommand({
      args: [...configArgs, 'fetch', 'origin', ref],
      cwd,
      timeout: getPluginGitTimeoutMs(),
      stdin: 'ignore',
      env,
    })

    if (fetchResult.code !== 0) {
      return enhanceGitPullErrorMessages(fetchResult)
    }

    const checkoutResult = await localExecBridge.execGitCommand({
      args: [...configArgs, 'checkout', ref],
      cwd,
      timeout: getPluginGitTimeoutMs(),
      stdin: 'ignore',
      env,
    })

    if (checkoutResult.code !== 0) {
      return enhanceGitPullErrorMessages(checkoutResult)
    }

    const pullResult = await localExecBridge.execGitCommand({
      args: [...configArgs, 'pull', 'origin', ref],
      cwd,
      timeout: getPluginGitTimeoutMs(),
      stdin: 'ignore',
      env,
    })
    if (pullResult.code !== 0) {
      return enhanceGitPullErrorMessages(pullResult)
    }
    if (!options?.hardenedIngress) {
      await gitSubmoduleUpdate(cwd, configArgs, env, options?.sparsePaths)
    }
    return pullResult
  }

  const result = await localExecBridge.execGitCommand({
    args: [...configArgs, 'pull', 'origin', 'HEAD'],
    cwd,
    timeout: getPluginGitTimeoutMs(),
    stdin: 'ignore',
    env,
  })
  if (result.code !== 0) {
    return enhanceGitPullErrorMessages(result)
  }
  if (!options?.hardenedIngress) {
    await gitSubmoduleUpdate(cwd, configArgs, env, options?.sparsePaths)
  }
  return result
}

/**
 * Sync submodule working dirs after a successful pull. gitClone() uses
 * --recurse-submodules, but gitPull() didn't — the parent repo's submodule
 * pointer would advance while the working dir stayed at the old commit,
 * making plugin sources in submodules unresolvable after marketplace update.
 * Non-fatal: a failed submodule update logs a warning; most marketplaces
 * don't use submodules at all. (gh-30696)
 *
 * Skipped for sparse clones — gitClone's sparse path intentionally omits
 * --recurse-submodules to preserve partial-clone bandwidth savings, and
 * .gitmodules is a root file that cone-mode sparse-checkout always
 * materializes, so the .gitmodules gate alone can't distinguish sparse repos.
 *
 * Perf: git-submodule is a bash script that spawns ~20 subprocesses (~35ms+)
 * even when no submodules exist. .gitmodules is a tracked file — pull
 * materializes it iff the repo has submodules — so gate on its presence to
 * skip the spawn for the common case.
 *
 * --init performs first-contact clone of newly-added submodules, so maintain
 * parity with gitClone's non-sparse path: StrictHostKeyChecking=yes for
 * fail-closed SSH (unknown hosts reject rather than silently populate
 * known_hosts), and --depth 1 for shallow clone (matching --shallow-submodules).
 * --depth only affects not-yet-initialized submodules; existing shallow
 * submodules are unaffected.
 */
async function gitSubmoduleUpdate(
  cwd: string,
  credentialArgs: string[],
  env: NodeJS.ProcessEnv,
  sparsePaths: string[] | undefined,
): Promise<void> {
  if (sparsePaths && sparsePaths.length > 0) return
  const hasGitmodules = await getFsImplementation()
    .stat(join(cwd, '.gitmodules'))
    .then(
      () => true,
      () => false,
    )
  if (!hasGitmodules) return
  const result = await localExecBridge.execGitCommand({
    args: [
      '-c',
      'core.sshCommand=ssh -o BatchMode=yes -o StrictHostKeyChecking=yes',
      ...credentialArgs,
      'submodule',
      'update',
      '--init',
      '--recursive',
      '--depth',
      '1',
    ],
    cwd,
    timeout: getPluginGitTimeoutMs(),
    stdin: 'ignore',
    env,
  })
  if (result.code !== 0) {
    logForDebugging(
      `git submodule update failed (non-fatal): ${result.stderr}`,
      { level: 'warn' },
    )
  }
}

/**
 * Enhance error messages for git pull failures
 */
function enhanceGitPullErrorMessages(result: {
  code: number
  stderr: string
  error?: string
}): { code: number; stderr: string } {
  if (result.code === 0) {
    return result
  }

  // Detect execa timeout kills via the error field (stderr won't contain "timed out"
  // when the process is killed by SIGTERM — the timeout info is only in error)
  if (result.error?.includes('timed out')) {
    const timeoutSec = Math.round(getPluginGitTimeoutMs() / 1000)
    return {
      ...result,
      stderr: `Git pull timed out after ${timeoutSec}s. Try increasing the timeout via CRABCODE_PLUGIN_GIT_TIMEOUT_MS environment variable.\n\nOriginal error: ${result.stderr}`,
    }
  }

  // Detect SSH host key verification failures (check before the generic
  // 'Could not read from remote' catch — that string appears in both cases).
  // OpenSSH emits "Host key verification failed" for BOTH host-not-in-known_hosts
  // and host-key-has-changed — the latter also includes the "REMOTE HOST
  // IDENTIFICATION HAS CHANGED" banner, which needs different remediation.
  if (result.stderr.includes('REMOTE HOST IDENTIFICATION HAS CHANGED')) {
    return {
      ...result,
      stderr: `SSH host key for this marketplace's git host has changed (server key rotation or possible MITM). Remove the stale entry with: ssh-keygen -R <host>\nThen connect once manually to accept the new key.\n\nOriginal error: ${result.stderr}`,
    }
  }
  if (result.stderr.includes('Host key verification failed')) {
    return {
      ...result,
      stderr: `SSH host key verification failed while updating marketplace. The host key is not in your known_hosts file. Connect once manually to add it (e.g., ssh -T git@<host>), or remove and re-add the marketplace with an HTTPS URL.\n\nOriginal error: ${result.stderr}`,
    }
  }

  // Detect SSH authentication failures
  if (
    result.stderr.includes('Permission denied (publickey)') ||
    result.stderr.includes('Could not read from remote repository')
  ) {
    return {
      ...result,
      stderr: `SSH authentication failed while updating marketplace. Please ensure your SSH keys are configured.\n\nOriginal error: ${result.stderr}`,
    }
  }

  // Detect network issues
  if (
    result.stderr.includes('timed out') ||
    result.stderr.includes('Could not resolve host')
  ) {
    return {
      ...result,
      stderr: `Network error while updating marketplace. Please check your internet connection.\n\nOriginal error: ${result.stderr}`,
    }
  }

  return result
}

/**
 * Check if SSH is likely to work for GitHub
 * This is a quick heuristic check that avoids the full clone timeout
 *
 * Uses StrictHostKeyChecking=yes (not accept-new) so an unknown github.com
 * host key fails closed rather than being silently added to known_hosts.
 * This prevents a network-level MITM from poisoning known_hosts on first
 * contact. Users who already have github.com in known_hosts see no change;
 * users who don't are routed to the HTTPS clone path.
 *
 * @returns true if SSH auth succeeds and github.com is already trusted
 */
async function isGitHubSshLikelyConfigured(): Promise<boolean> {
  try {
    // Quick SSH connection test with 2 second timeout
    // This fails fast if SSH isn't configured
    const result = await localExecBridge.execCommand({
      command: 'ssh',
      args: [
        '-T',
        '-o',
        'BatchMode=yes',
        '-o',
        'ConnectTimeout=2',
        '-o',
        'StrictHostKeyChecking=yes',
        'git@github.com',
      ],
      timeout: 3000, // 3 second total timeout
    })

    // SSH to github.com always returns exit code 1 with "successfully authenticated"
    // or exit code 255 with "Permission denied" - we want the former
    const configured =
      result.code === 1 &&
      (result.stderr?.includes('successfully authenticated') ||
        result.stdout?.includes('successfully authenticated'))
    logForDebugging(
      `SSH config check: code=${result.code} configured=${configured}`,
    )
    return configured
  } catch (error) {
    // Any error means SSH isn't configured properly
    logForDebugging(`SSH configuration check failed: ${errorMessage(error)}`, {
      level: 'warn',
    })
    return false
  }
}

/**
 * Check if a git error indicates authentication failure.
 * Used to provide enhanced error messages for auth failures.
 */
function isAuthenticationError(stderr: string): boolean {
  return (
    stderr.includes('Authentication failed') ||
    stderr.includes('could not read Username') ||
    stderr.includes('terminal prompts disabled') ||
    stderr.includes('403') ||
    stderr.includes('401')
  )
}

/**
 * Extract the SSH host from a git URL for error messaging.
 * Matches the SSH format user@host:path (e.g., git@github.com:owner/repo.git).
 */
function extractSshHost(gitUrl: string): string | null {
  const match = gitUrl.match(/^[^@]+@([^:]+):/)
  return match?.[1] ?? null
}

/**
 * Git clone operation (exported for testing)
 *
 * Clones a git repository with a configurable timeout (default 120s, override via CRABCODE_PLUGIN_GIT_TIMEOUT_MS)
 * and larger repositories. Provides helpful error messages for common failure scenarios.
 * Optionally checks out a specific branch or tag.
 *
 * Does NOT disable credential helpers — this allows the user's existing auth setup
 * (gh auth, keychain, git-credential-store, etc.) to work natively for private repos.
 * Interactive prompts are still prevented via GIT_TERMINAL_PROMPT=0, GIT_ASKPASS='',
 * stdin: 'ignore', and BatchMode=yes for SSH.
 *
 * Uses StrictHostKeyChecking=yes (not accept-new): unknown SSH hosts fail closed
 * with a clear message rather than being silently trusted on first contact. For
 * the github source type, the preflight check routes unknown-host users to HTTPS
 * automatically; for explicit git@host:… URLs, users see an actionable error.
 */
export async function gitClone(
  gitUrl: string,
  targetPath: string,
  ref?: string,
  sparsePaths?: string[],
  options?: Pick<MarketplaceGitRuntimeOptions, 'hardenedIngress'>,
): Promise<{ code: number; stderr: string }> {
  const useSparse = sparsePaths && sparsePaths.length > 0
  const { env, configArgs } = getMarketplaceGitExecutionContext(options)
  const args = [...configArgs]
  if (!options?.hardenedIngress) {
    args.push(
      '-c',
      'core.sshCommand=ssh -o BatchMode=yes -o StrictHostKeyChecking=yes',
    )
  }
  args.push('clone', '--depth', '1')

  if (useSparse) {
    // Partial clone: skip blob download until checkout, defer checkout until
    // after sparse-checkout is configured. Submodules are intentionally dropped
    // for sparse clones — sparse monorepos rarely need them, and recursing
    // submodules would defeat the partial-clone bandwidth savings.
    args.push('--filter=blob:none', '--no-checkout')
  } else if (!options?.hardenedIngress) {
    args.push('--recurse-submodules', '--shallow-submodules')
  }

  if (ref) {
    args.push('--branch', ref)
  }

  args.push(gitUrl, targetPath)

  const timeoutMs = getPluginGitTimeoutMs()
  logForDebugging(
    `git clone: url=${redactUrlCredentials(gitUrl)} ref=${ref ?? 'default'} timeout=${timeoutMs}ms`,
  )

  const result = await localExecBridge.execGitCommand({
    args,
    timeout: timeoutMs,
    stdin: 'ignore',
    env,
  })

  // Scrub credentials from execa's error/stderr fields before any logging or
  // returning. execa's shortMessage embeds the full command line (including
  // the credentialed URL), and result.stderr may also contain it on some git
  // versions.
  const redacted = redactUrlCredentials(gitUrl)
  if (gitUrl !== redacted) {
    if (result.error) result.error = result.error.replaceAll(gitUrl, redacted)
    if (result.stderr)
      result.stderr = result.stderr.replaceAll(gitUrl, redacted)
  }

  if (result.code === 0) {
    if (useSparse) {
      // Configure the sparse cone, then materialize only those paths.
      // `sparse-checkout set --cone` handles both init and path selection
      // in a single step on git >= 2.25.
      const sparseResult = await localExecBridge.execGitCommand({
        args: [
          ...configArgs,
          'sparse-checkout',
          'set',
          '--cone',
          '--',
          ...sparsePaths,
        ],
        cwd: targetPath,
        timeout: timeoutMs,
        stdin: 'ignore',
        env,
      })
      if (sparseResult.code !== 0) {
        return {
          code: sparseResult.code,
          stderr: `git sparse-checkout set failed: ${sparseResult.stderr}`,
        }
      }

      const checkoutResult = await localExecBridge.execGitCommand({
        args: [...configArgs, 'checkout', 'HEAD'],
        cwd: targetPath,
        timeout: timeoutMs,
        stdin: 'ignore',
        env,
      })
      if (checkoutResult.code !== 0) {
        return {
          code: checkoutResult.code,
          stderr: `git checkout after sparse-checkout failed: ${checkoutResult.stderr}`,
        }
      }
    }
    logForDebugging(`git clone succeeded: ${redactUrlCredentials(gitUrl)}`)
    return result
  }

  logForDebugging(
    `git clone failed: url=${redactUrlCredentials(gitUrl)} code=${result.code} error=${result.error ?? 'none'} stderr=${result.stderr}`,
    { level: 'warn' },
  )

  // Detect timeout kills — when execFileNoThrowWithCwd kills the process via SIGTERM,
  // stderr may only contain partial output (e.g. "Cloning into '...'") with no
  // "timed out" string. Check the error field from execa which contains the
  // timeout message.
  if (result.error?.includes('timed out')) {
    return {
      ...result,
      stderr: `Git clone timed out after ${Math.round(timeoutMs / 1000)}s. The repository may be too large for the current timeout. Set CRABCODE_PLUGIN_GIT_TIMEOUT_MS to increase it (e.g., 300000 for 5 minutes).\n\nOriginal error: ${result.stderr}`,
    }
  }

  // Enhance error messages for common scenarios
  if (result.stderr) {
    // Host key verification failure — check FIRST, before the generic
    // 'Could not read from remote repository' catch (that string appears
    // in both stderr outputs, so order matters). OpenSSH emits
    // "Host key verification failed" for BOTH host-not-in-known_hosts and
    // host-key-has-changed; distinguish them by the key-change banner.
    if (result.stderr.includes('REMOTE HOST IDENTIFICATION HAS CHANGED')) {
      const host = extractSshHost(gitUrl)
      const removeHint = host ? `ssh-keygen -R ${host}` : 'ssh-keygen -R <host>'
      return {
        ...result,
        stderr: `SSH host key has changed (server key rotation or possible MITM). Remove the stale known_hosts entry:\n  ${removeHint}\nThen connect once manually to verify and accept the new key.\n\nOriginal error: ${result.stderr}`,
      }
    }
    if (result.stderr.includes('Host key verification failed')) {
      const host = extractSshHost(gitUrl)
      const connectHint = host ? `ssh -T git@${host}` : 'ssh -T git@<host>'
      return {
        ...result,
        stderr: `SSH host key is not in your known_hosts file. To add it, connect once manually (this will show the fingerprint for you to verify):\n  ${connectHint}\n\nOr use an HTTPS URL instead (recommended for public repos).\n\nOriginal error: ${result.stderr}`,
      }
    }

    if (
      result.stderr.includes('Permission denied (publickey)') ||
      result.stderr.includes('Could not read from remote repository')
    ) {
      return {
        ...result,
        stderr: `SSH authentication failed. Please ensure your SSH keys are configured for GitHub, or use an HTTPS URL instead.\n\nOriginal error: ${result.stderr}`,
      }
    }

    if (isAuthenticationError(result.stderr)) {
      return {
        ...result,
        stderr: `HTTPS authentication failed. Please ensure your credential helper is configured (e.g., gh auth login).\n\nOriginal error: ${result.stderr}`,
      }
    }

    if (
      result.stderr.includes('timed out') ||
      result.stderr.includes('timeout') ||
      result.stderr.includes('Could not resolve host')
    ) {
      return {
        ...result,
        stderr: `Network error or timeout while cloning repository. Please check your internet connection and try again.\n\nOriginal error: ${result.stderr}`,
      }
    }
  }

  // Fallback for empty stderr — gh-28373: user saw "Failed to clone
  // marketplace repository:" with nothing after the colon. Git CAN fail
  // without writing to stderr (stdout instead, or output swallowed by
  // credential helper / signal). execa's error field has the execa-level
  // message (command, exit code, signal); exit code is the minimum.
  if (!result.stderr) {
    return {
      code: result.code,
      stderr:
        result.error ||
        `git clone exited with code ${result.code} (no stderr output). Run with --debug to see the full command.`,
    }
  }

  return result
}

/**
 * Progress callback for marketplace operations.
 *
 * This callback is invoked at various stages during marketplace operations
 * (downloading, git operations, validation, etc.) to provide user feedback.
 *
 * IMPORTANT: Implementations should handle errors internally and not throw exceptions.
 * If a callback throws, it will be caught and logged but won't abort the operation.
 *
 * @param message - Human-readable progress message to display to the user
 */
export type MarketplaceProgressCallback = (message: string) => void

/**
 * Safely invoke a progress callback, catching and logging any errors.
 * Prevents callback errors from aborting marketplace operations.
 *
 * @param onProgress - The progress callback to invoke
 * @param message - Progress message to pass to the callback
 */
function safeCallProgress(
  onProgress: MarketplaceProgressCallback | undefined,
  message: string,
): void {
  if (!onProgress) return
  try {
    onProgress(message)
  } catch (callbackError) {
    logForDebugging(`Progress callback error: ${errorMessage(callbackError)}`, {
      level: 'warn',
    })
  }
}

/**
 * Reconcile the on-disk sparse-checkout state with the desired config.
 *
 * Runs before gitPull to handle transitions:
 * - Full→Sparse or SparseA→SparseB: run `sparse-checkout set --cone` (idempotent)
 * - Sparse→Full: return non-zero so caller falls back to rm+reclone. Avoids
 *   `sparse-checkout disable` on a --filter=blob:none partial clone, which would
 *   trigger a lazy fetch of every blob in the monorepo.
 * - Full→Full (common case): single local `git config --get` check, no-op.
 *
 * Failures here (ENOENT, not a repo) are harmless — gitPull will also fail and
 * trigger the clone path, which establishes the correct state from scratch.
 */
export async function reconcileSparseCheckout(
  cwd: string,
  sparsePaths: string[] | undefined,
  options?: Pick<MarketplaceGitRuntimeOptions, 'hardenedIngress'>,
): Promise<{ code: number; stderr: string }> {
  const { env, configArgs } = getMarketplaceGitExecutionContext(options)

  if (sparsePaths && sparsePaths.length > 0) {
    return localExecBridge.execGitCommand({
      args: [
        ...configArgs,
        'sparse-checkout',
        'set',
        '--cone',
        '--',
        ...sparsePaths,
      ],
      cwd,
      timeout: getPluginGitTimeoutMs(),
      stdin: 'ignore',
      env,
    })
  }

  const check = await localExecBridge.execGitCommand({
    args: [...configArgs, 'config', '--get', 'core.sparseCheckout'],
    cwd,
    stdin: 'ignore',
    env,
  })
  if (check.code === 0 && check.stdout.trim() === 'true') {
    return {
      code: 1,
      stderr:
        'sparsePaths removed from config but repository is sparse; re-cloning for full checkout',
    }
  }
  return { code: 0, stderr: '' }
}

/**
 * Cache a marketplace from a git repository
 *
 * Clones or updates a git repository containing marketplace data.
 * If the repository already exists at cachePath, pulls the latest changes.
 * If pulling fails, removes the directory and re-clones.
 *
 * Example repository structure:
 * ```
 * my-marketplace/
 *   ├── .crabcode-plugin/
 *   │   └── marketplace.json    # Default location for marketplace manifest
 *   ├── plugins/                # Plugin implementations
 *   └── README.md
 * ```
 *
 * @param gitUrl - The git URL to clone (https or ssh)
 * @param cachePath - Local directory path to clone/update the repository
 * @param ref - Optional git branch or tag to checkout
 * @param onProgress - Optional callback to report progress
 */
async function cacheMarketplaceFromGit(
  gitUrl: string,
  cachePath: string,
  ref?: string,
  sparsePaths?: string[],
  onProgress?: MarketplaceProgressCallback,
  options?: MarketplaceGitRuntimeOptions,
): Promise<void> {
  const fs = getFsImplementation()
  const cacheParent = dirname(cachePath)
  cachePath = await resolvePluginComponentPath(
    cacheParent,
    basename(cachePath),
    {
      mustExist: false,
      rejectSymlinks: true,
      rejectRoot: true,
      component: 'marketplace git cache',
    },
  )

  // Attempt incremental update; fall back to re-clone if the repo is absent,
  // stale, or otherwise not updatable. Using pull-first avoids a stat-before-operate
  // TOCTOU check: gitPull returns non-zero when cachePath is missing or has no .git.
  const timeoutSec = Math.round(getPluginGitTimeoutMs() / 1000)
  safeCallProgress(
    onProgress,
    `Refreshing marketplace cache (timeout: ${timeoutSec}s)…`,
  )

  // Reconcile sparse-checkout config before pulling. If this requires a re-clone
  // (Sparse→Full transition) or fails (missing dir, not a repo), skip straight
  // to the rm+clone fallback.
  const reconcileResult = await reconcileSparseCheckout(
    cachePath,
    sparsePaths,
    options,
  )
  if (reconcileResult.code === 0) {
    const pullStarted = performance.now()
    const pullResult = await gitPull(cachePath, ref, {
      disableCredentialHelper: options?.disableCredentialHelper,
      hardenedIngress: options?.hardenedIngress,
      sparsePaths,
    })
    logPluginFetch(
      'marketplace_pull',
      gitUrl,
      pullResult.code === 0 ? 'success' : 'failure',
      performance.now() - pullStarted,
      pullResult.code === 0 ? undefined : classifyFetchError(pullResult.stderr),
    )
    if (pullResult.code === 0) return
    logForDebugging(`git pull failed, will re-clone: ${pullResult.stderr}`, {
      level: 'warn',
    })
  } else {
    logForDebugging(
      `sparse-checkout reconcile requires re-clone: ${reconcileResult.stderr}`,
    )
  }

  try {
    cachePath = await resolvePluginComponentPath(
      cacheParent,
      basename(cachePath),
      {
        mustExist: false,
        rejectSymlinks: true,
        rejectRoot: true,
        component: 'marketplace git cache cleanup',
      },
    )
    await fs.rm(cachePath, { recursive: true })
    // rm succeeded — a stale or partially-cloned directory existed; log for diagnostics
    logForDebugging(
      `Found stale marketplace directory at ${cachePath}, cleaning up to allow re-clone`,
      { level: 'warn' },
    )
    safeCallProgress(
      onProgress,
      'Found stale directory, cleaning up and re-cloning…',
    )
  } catch (rmError) {
    if (!isENOENT(rmError)) {
      const rmErrorMsg = errorMessage(rmError)
      throw new Error(
        `Failed to clean up existing marketplace directory. Please manually delete the directory at ${cachePath} and try again.\n\nTechnical details: ${rmErrorMsg}`,
      )
    }
    // ENOENT — cachePath didn't exist, this is a fresh install, nothing to clean up
  }

  // Clone the repository (one attempt — no internal retry loop)
  const refMessage = ref ? ` (ref: ${ref})` : ''
  safeCallProgress(
    onProgress,
    `Cloning repository (timeout: ${timeoutSec}s): ${redactUrlCredentials(gitUrl)}${refMessage}`,
  )
  cachePath = await resolvePluginComponentPath(
    cacheParent,
    basename(cachePath),
    {
      mustExist: false,
      rejectSymlinks: true,
      rejectRoot: true,
      component: 'marketplace git clone destination',
    },
  )
  const cloneStarted = performance.now()
  const result = await gitClone(gitUrl, cachePath, ref, sparsePaths, {
    hardenedIngress: options?.hardenedIngress,
  })
  logPluginFetch(
    'marketplace_clone',
    gitUrl,
    result.code === 0 ? 'success' : 'failure',
    performance.now() - cloneStarted,
    result.code === 0 ? undefined : classifyFetchError(result.stderr),
  )
  if (result.code !== 0) {
    // Clean up any partial directory created by the failed clone so the next
    // attempt starts fresh. Best-effort: if this fails, the stale dir will be
    // auto-detected and removed at the top of the next call.
    try {
      const failedCachePath = await resolvePluginComponentPath(
        cacheParent,
        basename(cachePath),
        {
          mustExist: false,
          rejectSymlinks: true,
          rejectRoot: true,
          component: 'failed marketplace git clone cleanup',
        },
      )
      await fs.rm(failedCachePath, { recursive: true, force: true })
    } catch {
      // ignore
    }
    throw new Error(`Failed to clone marketplace repository: ${result.stderr}`)
  }
  safeCallProgress(onProgress, 'Clone complete, validating marketplace…')
}

/**
 * Redact header values for safe logging
 *
 * @param headers - Headers to redact
 * @returns Headers with values replaced by '***REDACTED***'
 */
function redactHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([key]) => [key, '***REDACTED***']),
  )
}

/**
 * Redact userinfo (username:password) in a URL to avoid logging credentials.
 *
 * Marketplace URLs may embed credentials (e.g. GitHub PATs in
 * `https://user:token@github.com/org/repo`). Debug logs and progress output
 * are written to disk and may be included in bug reports, so credentials must
 * be redacted before logging.
 *
 * Redacts all credentials from http(s) URLs:
 *   https://user:token@github.com/repo → https://***:***@github.com/repo
 *   https://:token@github.com/repo     → https://:***@github.com/repo
 *   https://token@github.com/repo      → https://***@github.com/repo
 *
 * Both username and password are redacted unconditionally on http(s) because
 * it is impossible to distinguish `placeholder:secret` (e.g. x-access-token:ghp_...)
 * from `secret:placeholder` (e.g. ghp_...:x-oauth-basic) by parsing alone.
 * Non-http(s) schemes (ssh://git@...) and non-URL inputs (`owner/repo` shorthand)
 * pass through unchanged.
 */
function redactUrlCredentials(urlString: string): string {
  try {
    const parsed = new URL(urlString)
    const isHttp = parsed.protocol === 'http:' || parsed.protocol === 'https:'
    if (isHttp && (parsed.username || parsed.password)) {
      if (parsed.username) parsed.username = '***'
      if (parsed.password) parsed.password = '***'
      return parsed.toString()
    }
  } catch {
    // Not a valid URL — safe as-is
  }
  return urlString
}

const HARDENED_INGRESS_MARKETPLACE_JSON_MAX_BYTES = 4 * 1024 * 1024

function marketplaceUrlRequestConfig(
  headers: Record<string, string>,
  hardenedIngress: boolean,
): NonNullable<Parameters<typeof axios.get>[1]> {
  return {
    timeout: 10000,
    headers,
    ...(hardenedIngress && {
      // Explicit request-local settings override mutable axios defaults. A
      // dedicated verified agent also defeats NODE_TLS_REJECT_UNAUTHORIZED=0
      // for this trust boundary.
      proxy: false,
      maxRedirects: 0,
      maxContentLength: HARDENED_INGRESS_MARKETPLACE_JSON_MAX_BYTES,
      maxBodyLength: HARDENED_INGRESS_MARKETPLACE_JSON_MAX_BYTES,
      httpsAgent: new HttpsAgent({
        minVersion: 'TLSv1.2',
        rejectUnauthorized: true,
      }),
    }),
  }
}

/** Test seam for the transport floor without performing a network request. */
export function __getMarketplaceUrlRequestConfigForTest(
  hardenedIngress: boolean,
): NonNullable<Parameters<typeof axios.get>[1]> {
  return marketplaceUrlRequestConfig({}, hardenedIngress)
}

/**
 * Cache a marketplace from a URL
 *
 * Downloads a marketplace.json file from a URL and saves it locally.
 * Creates the cache directory structure if it doesn't exist.
 *
 * Example marketplace.json structure:
 * ```json
 * {
 *   "name": "my-marketplace",
 *   "owner": { "name": "John Doe", "email": "john@example.com" },
 *   "plugins": [
 *     {
 *       "id": "my-plugin",
 *       "name": "My Plugin",
 *       "source": "./plugins/my-plugin.json",
 *       "category": "productivity",
 *       "description": "A helpful plugin"
 *     }
 *   ]
 * }
 * ```
 *
 * @param url - The URL to download the marketplace.json from
 * @param cachePath - Local file path to save the downloaded marketplace
 * @param customHeaders - Optional custom HTTP headers for authentication
 * @param onProgress - Optional callback to report progress
 */
async function cacheMarketplaceFromUrl(
  url: string,
  cachePath: string,
  customHeaders?: Record<string, string>,
  onProgress?: MarketplaceProgressCallback,
  options?: { hardenedIngress?: boolean },
): Promise<void> {
  const fs = getFsImplementation()

  if (options?.hardenedIngress && new URL(url).protocol !== 'https:') {
    throw new MarketplaceIngressPolicyError(
      'URL downloads must use HTTPS',
    )
  }

  const redactedUrl = redactUrlCredentials(url)
  safeCallProgress(onProgress, `Downloading marketplace from ${redactedUrl}`)
  logForDebugging(`Downloading marketplace from URL: ${redactedUrl}`)
  if (customHeaders && Object.keys(customHeaders).length > 0) {
    logForDebugging(
      `Using custom headers: ${jsonStringify(redactHeaders(customHeaders))}`,
    )
  }

  const headers = {
    ...customHeaders,
    // User-Agent must come last to prevent override (for consistency with WebFetch)
    'User-Agent': 'CrabCode-Plugin-Manager',
  }

  let response
  const fetchStarted = performance.now()
  try {
    response = await axios.get(
      url,
      marketplaceUrlRequestConfig(headers, !!options?.hardenedIngress),
    )
  } catch (error) {
    logPluginFetch(
      'marketplace_url',
      url,
      'failure',
      performance.now() - fetchStarted,
      classifyFetchError(error),
    )
    if (axios.isAxiosError(error)) {
      if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
        throw new Error(
          `Could not connect to ${redactedUrl}. Please check your internet connection and verify the URL is correct.\n\nTechnical details: ${error.message}`,
        )
      }
      if (error.code === 'ETIMEDOUT') {
        throw new Error(
          `Request timed out while downloading marketplace from ${redactedUrl}. The server may be slow or unreachable.\n\nTechnical details: ${error.message}`,
        )
      }
      if (error.response) {
        throw new Error(
          `HTTP ${error.response.status} error while downloading marketplace from ${redactedUrl}. The marketplace file may not exist at this URL.\n\nTechnical details: ${error.message}`,
        )
      }
    }
    throw new Error(
      `Failed to download marketplace from ${redactedUrl}: ${errorMessage(error)}`,
    )
  }

  safeCallProgress(onProgress, 'Validating marketplace data')
  // Validate the response is a valid marketplace
  const result = PluginMarketplaceSchema().safeParse(response.data)
  if (!result.success) {
    logPluginFetch(
      'marketplace_url',
      url,
      'failure',
      performance.now() - fetchStarted,
      'invalid_schema',
    )
    throw new ConfigParseError(
      `Invalid marketplace schema from URL: ${result.error.issues.map((e) => `${e.path.join('.')}: ${e.message}`).join(', ')}`,
      redactedUrl,
      response.data,
    )
  }
  logPluginFetch(
    'marketplace_url',
    url,
    'success',
    performance.now() - fetchStarted,
  )

  safeCallProgress(onProgress, 'Saving marketplace to cache')
  // Ensure cache directory exists
  const cacheDir = dirname(cachePath)
  await fs.mkdir(cacheDir)

  // Write the validated marketplace file
  const safeCachePath = await resolvePluginComponentPath(
    cacheDir,
    basename(cachePath),
    {
      mustExist: false,
      rejectSymlinks: true,
      rejectRoot: true,
      component: 'marketplace URL cache file',
    },
  )
  await writeCanonicalPluginFile(
    cacheDir,
    safeCachePath,
    jsonStringify(result.data, null, 2),
    'marketplace URL cache file',
  )
}

/**
 * Generate a cache path for a marketplace source
 */
function getCachePathForSource(source: MarketplaceSource): string {
  const tempName =
    source.source === 'github'
      ? source.repo.replace('/', '-')
      : source.source === 'npm'
        ? source.package.replace('@', '').replace('/', '-')
        : source.source === 'file'
          ? basename(source.path).replace('.json', '')
          : source.source === 'directory'
            ? basename(source.path)
            : 'temp_' + Date.now()
  return tempName
}

/**
 * Parse and validate JSON file with a Zod schema
 */
async function parseFileWithSchema<T>(
  filePath: string,
  schema: {
    safeParse: (data: unknown) => {
      success: boolean
      data?: T
      error?: {
        issues: Array<{ path: PropertyKey[]; message: string }>
      }
    }
  },
  trustedRoot?: string,
): Promise<T> {
  const fs = getFsImplementation()
  const content = trustedRoot
    ? await readCanonicalPluginTextFile(
        trustedRoot,
        filePath,
        'marketplace manifest',
      )
    : await fs.readFile(filePath, { encoding: 'utf-8' })
  let data: unknown
  try {
    data = jsonParse(content)
  } catch (error) {
    throw new ConfigParseError(
      `Invalid JSON in ${filePath}: ${errorMessage(error)}`,
      filePath,
      content,
    )
  }
  const result = schema.safeParse(data)
  if (!result.success) {
    throw new ConfigParseError(
      `Invalid schema: ${filePath} ${result.error?.issues.map((e) => `${e.path.join('.')}: ${e.message}`).join(', ')}`,
      filePath,
      data,
    )
  }
  return result.data!
}

function marketplaceNameForSinglePluginRepo(
  manifest: PluginManifest,
  source: MarketplaceSource,
): string {
  if (
    source.source === 'github' &&
    source.repo.toLowerCase() === OFFICIAL_MARKETPLACE_SOURCE.repo.toLowerCase()
  ) {
    return OFFICIAL_MARKETPLACE_NAME
  }
  return manifest.name
}

async function synthesizeMarketplaceFromPluginRepo(
  repoRoot: string,
  marketplacePath: string,
  source: MarketplaceSource,
): Promise<boolean> {
  const pluginManifestPath = await resolvePluginComponentPath(
    repoRoot,
    '.crabcode-plugin/plugin.json',
    { component: 'single-plugin marketplace manifest' },
  ).catch((error) => {
    if (
      isENOENT(error) ||
      (error instanceof PluginPathSecurityError &&
        error.reason === 'path-missing')
    ) {
      return null
    }
    throw error
  })
  if (!pluginManifestPath) return false
  let manifest: PluginManifest
  try {
    manifest = await parseFileWithSchema(
      pluginManifestPath,
      PluginManifestSchema(),
      repoRoot,
    )
  } catch (error) {
    if (isENOENT(error)) return false
    throw new Error(
      `Failed to parse plugin manifest at ${pluginManifestPath}: ${errorMessage(error)}`,
    )
  }

  const marketplaceName = marketplaceNameForSinglePluginRepo(manifest, source)
  const pluginEntry: PluginMarketplaceEntry = {
    ...manifest,
    source: './',
    strict: true,
  }
  const safeMarketplacePath = await resolveInternalPluginPath(
    repoRoot,
    marketplacePath,
    {
      mustExist: false,
      rejectSymlinks: true,
      rejectRoot: true,
      component: 'synthesized marketplace manifest',
    },
  )
  await writeCanonicalPluginFile(
    repoRoot,
    safeMarketplacePath,
    jsonStringify(
      {
        name: marketplaceName,
        owner: manifest.author ?? { name: marketplaceName },
        metadata: {
          version: manifest.version,
          description: manifest.description,
        },
        plugins: [pluginEntry],
      },
      null,
      2,
    ),
    'synthesized marketplace manifest',
  )
  logForDebugging(
    `Synthesized marketplace '${marketplaceName}' from single plugin repo manifest at ${pluginManifestPath}`,
  )
  return true
}

/**
 * Load and cache a marketplace from its source
 *
 * Handles different source types:
 * - URL: Downloads marketplace.json directly
 * - GitHub: Clones repo and looks for .crabcode-plugin/marketplace.json
 * - Git: Clones repository from git URL
 * - NPM: (Not yet implemented) Would fetch from npm package
 * - File: Reads from local filesystem
 *
 * After loading, validates the marketplace schema and renames the cache
 * to match the marketplace's actual name from the manifest.
 *
 * Cache structure:
 * ~/.crabcode/plugins/marketplaces/
 *   ├── official-marketplace.json     # From URL source
 *   ├── github-marketplace/          # From GitHub/Git source
 *   │   └── .crabcode-plugin/
 *   │       └── marketplace.json
 *   └── local-marketplace.json       # From file source
 *
 * @param source - The marketplace source to load from
 * @param onProgress - Optional callback to report progress
 * @returns Object containing the validated marketplace and its cache path
 * @throws If marketplace file not found or validation fails
 */
async function loadAndCacheMarketplace(
  source: MarketplaceSource,
  onProgress?: MarketplaceProgressCallback,
  options?: {
    /** Download/clone into a private generation without replacing live cache. */
    stageOnly?: boolean
    /** Captured cache root paired with the later publication lock target. */
    cacheDir?: string
    /** Unique basename supplied by addMarketplaceSource for its generation. */
    stagingName?: string
    /** Refresh-only git option; staging still occurs outside publication locks. */
    disableCredentialHelper?: boolean
    /** remote ingress-only transport hardening; never enabled by global CLI paths. */
    hardenedIngress?: boolean
    /** Captured by the same remote ingress policy pass for a local source. */
    localIngressIdentity?: LocalMarketplaceIngressIdentity
  },
): Promise<LoadedPluginMarketplace> {
  const fs = getFsImplementation()
  const hardenedLocalSource =
    options?.hardenedIngress && isLocalMarketplaceSource(source)
  if (hardenedLocalSource && !options.localIngressIdentity) {
    throw new MarketplaceIngressPolicyError(
      'hardened local marketplace reads require a captured identity',
    )
  }
  if (hardenedLocalSource) {
    // First check occurs before even creating cache parent directories. Local
    // remote ingress drift must leave registry/cache state byte-for-byte unchanged.
    await revalidateCapturedLocalIngressSource(
      source,
      options.localIngressIdentity,
    )
  }
  const pluginsRoot = options?.cacheDir
    ? dirname(options.cacheDir)
    : getPluginsDirectory()
  let cacheDir: string
  if (hardenedLocalSource) {
    // Local sources are never copied into the managed cache. Avoid creating
    // cache state before the final identity-guarded registry transaction.
    cacheDir = resolve(options?.cacheDir ?? join(pluginsRoot, 'marketplaces'))
  } else {
    await fs.mkdir(pluginsRoot)
    cacheDir = options?.cacheDir
      ? await resolveInternalPluginPath(pluginsRoot, options.cacheDir, {
          mustExist: false,
          rejectSymlinks: true,
          component: 'marketplace cache root',
        })
      : await resolvePluginComponentPath(pluginsRoot, 'marketplaces', {
          mustExist: false,
          rejectSymlinks: true,
          component: 'marketplace cache root',
        })

    // Ensure cache directory exists
    await fs.mkdir(cacheDir)
  }

  let temporaryCachePath: string
  let marketplacePath: string
  let marketplaceReadRoot = cacheDir
  let cleanupNeeded = false

  // Generate a temp name for the cache path
  const tempName = options?.stagingName ?? getCachePathForSource(source)

  try {
    switch (source.source) {
      case 'url': {
        // Direct URL to marketplace.json
        temporaryCachePath = await resolvePluginComponentPath(
          cacheDir,
          `${tempName}.json`,
          {
            mustExist: false,
            rejectSymlinks: true,
            rejectRoot: true,
            component: 'temporary marketplace cache',
          },
        )
        cleanupNeeded = true
        await cacheMarketplaceFromUrl(
          source.url,
          temporaryCachePath,
          source.headers,
          onProgress,
          { hardenedIngress: options?.hardenedIngress },
        )
        marketplacePath = temporaryCachePath
        marketplaceReadRoot = cacheDir
        break
      }

      case 'github': {
        // Smart SSH/HTTPS selection: check if SSH is configured before trying it
        // This avoids waiting for timeout on SSH when it's not configured
        const sshUrl = `git@github.com:${source.repo}.git`
        const httpsUrl = `https://github.com/${source.repo}.git`
        temporaryCachePath = await resolvePluginComponentPath(
          cacheDir,
          tempName,
          {
            mustExist: false,
            rejectSymlinks: true,
            rejectRoot: true,
            component: 'temporary marketplace cache',
          },
        )
        cleanupNeeded = true

        if (options?.hardenedIngress) {
          // Hardened ingress is HTTPS-only. Do not probe SSH and do
          // not retry another protocol after an approved URL fails.
          safeCallProgress(onProgress, `Cloning via HTTPS: ${httpsUrl}`)
          await cacheMarketplaceFromGit(
            httpsUrl,
            temporaryCachePath,
            source.ref,
            source.sparsePaths,
            onProgress,
            { hardenedIngress: true },
          )
        } else {
          let lastError: Error | null = null

          // Quick check if SSH is likely to work
          const sshConfigured =
            !isEnvTruthy(process.env.CRABCODE_REMOTE) &&
            (await isGitHubSshLikelyConfigured())

          if (sshConfigured) {
            // SSH looks good, try it first
            safeCallProgress(onProgress, `Cloning via SSH: ${sshUrl}`)
            try {
              await cacheMarketplaceFromGit(
                sshUrl,
                temporaryCachePath,
                source.ref,
                source.sparsePaths,
                onProgress,
                { disableCredentialHelper: options?.disableCredentialHelper },
              )
            } catch (err) {
              lastError = toError(err)

              // Log SSH failure for monitoring
              logError(lastError)

              // SSH failed despite being configured, try HTTPS fallback
              safeCallProgress(
                onProgress,
                `SSH clone failed, retrying with HTTPS: ${httpsUrl}`,
              )

              logForDebugging(
                `SSH clone failed for ${source.repo} despite SSH being configured, falling back to HTTPS`,
                { level: 'info' },
              )

              // Clean up failed SSH attempt if it created anything
              const failedSshCache = await resolveInternalPluginPath(
                cacheDir,
                temporaryCachePath,
                {
                  mustExist: false,
                  rejectSymlinks: true,
                  rejectRoot: true,
                  component: 'failed marketplace clone cleanup',
                },
              )
              await fs.rm(failedSshCache, { recursive: true, force: true })

              // Try HTTPS
              try {
                await cacheMarketplaceFromGit(
                  httpsUrl,
                  temporaryCachePath,
                  source.ref,
                  source.sparsePaths,
                  onProgress,
                  {
                    disableCredentialHelper: options?.disableCredentialHelper,
                  },
                )
                lastError = null // Success!
              } catch (httpsErr) {
                // HTTPS also failed - use HTTPS error as the final error
                lastError = toError(httpsErr)

                // Log HTTPS failure for monitoring (both SSH and HTTPS failed)
                logError(lastError)
              }
            }
          } else {
            // SSH not configured, go straight to HTTPS
            safeCallProgress(
              onProgress,
              `SSH not configured, cloning via HTTPS: ${httpsUrl}`,
            )

            logForDebugging(
              `SSH not configured for GitHub, using HTTPS for ${source.repo}`,
              { level: 'info' },
            )

            try {
              await cacheMarketplaceFromGit(
                httpsUrl,
                temporaryCachePath,
                source.ref,
                source.sparsePaths,
                onProgress,
                { disableCredentialHelper: options?.disableCredentialHelper },
              )
            } catch (err) {
              lastError = toError(err)

              // Always try SSH as fallback for ANY HTTPS failure
              // Log HTTPS failure for monitoring
              logError(lastError)

              // HTTPS failed, try SSH as fallback
              safeCallProgress(
                onProgress,
                `HTTPS clone failed, retrying with SSH: ${sshUrl}`,
              )

              logForDebugging(
                `HTTPS clone failed for ${source.repo} (${lastError.message}), falling back to SSH`,
                { level: 'info' },
              )

              // Clean up failed HTTPS attempt if it created anything
              const failedHttpsCache = await resolveInternalPluginPath(
                cacheDir,
                temporaryCachePath,
                {
                  mustExist: false,
                  rejectSymlinks: true,
                  rejectRoot: true,
                  component: 'failed marketplace clone cleanup',
                },
              )
              await fs.rm(failedHttpsCache, { recursive: true, force: true })

              // Try SSH
              try {
                await cacheMarketplaceFromGit(
                  sshUrl,
                  temporaryCachePath,
                  source.ref,
                  source.sparsePaths,
                  onProgress,
                  {
                    disableCredentialHelper: options?.disableCredentialHelper,
                  },
                )
                lastError = null // Success!
              } catch (sshErr) {
                // SSH also failed - use SSH error as the final error
                lastError = toError(sshErr)

                // Log SSH failure for monitoring (both HTTPS and SSH failed)
                logError(lastError)
              }
            }
          }

          // If we still have an error, throw it
          if (lastError) {
            throw lastError
          }
        }

        temporaryCachePath = await resolveInternalPluginPath(
          cacheDir,
          temporaryCachePath,
          {
            rejectSymlinks: true,
            rejectRoot: true,
            component: 'materialized marketplace cache',
          },
        )

        marketplacePath = await resolvePluginComponentPath(
          temporaryCachePath,
          source.path || '.crabcode-plugin/marketplace.json',
          { mustExist: false, component: 'marketplace manifest' },
        )
        marketplaceReadRoot = temporaryCachePath
        break
      }

      case 'git': {
        temporaryCachePath = await resolvePluginComponentPath(
          cacheDir,
          tempName,
          {
            mustExist: false,
            rejectSymlinks: true,
            rejectRoot: true,
            component: 'temporary marketplace cache',
          },
        )
        cleanupNeeded = true
        await cacheMarketplaceFromGit(
          source.url,
          temporaryCachePath,
          source.ref,
          source.sparsePaths,
          onProgress,
          {
            disableCredentialHelper: options?.disableCredentialHelper,
            hardenedIngress: options?.hardenedIngress,
          },
        )
        temporaryCachePath = await resolveInternalPluginPath(
          cacheDir,
          temporaryCachePath,
          {
            rejectSymlinks: true,
            rejectRoot: true,
            component: 'materialized marketplace cache',
          },
        )
        marketplacePath = await resolvePluginComponentPath(
          temporaryCachePath,
          source.path || '.crabcode-plugin/marketplace.json',
          { mustExist: false, component: 'marketplace manifest' },
        )
        marketplaceReadRoot = temporaryCachePath
        break
      }

      case 'npm': {
        // KNOWN_LIMITATION: npm marketplace 源 — 需要包管理设计决策，跟踪于全局审计 G-10A
        throw new Error('NPM marketplace sources not yet implemented')
      }

      case 'file': {
        // For local files, resolve paths relative to marketplace root directory
        // File sources point to .crabcode-plugin/marketplace.json, so the marketplace
        // root is two directories up (parent of .crabcode-plugin/)
        // Resolve to absolute so error messages show the actual path checked
        // (legacy known_marketplaces.json entries may have relative paths)
        await revalidateCapturedLocalIngressSource(
          source,
          options?.localIngressIdentity,
        )
        const absPath = resolve(source.path)
        marketplacePath = await realpath(absPath)
        if (!(await stat(marketplacePath)).isFile()) {
          throw new Error(`Marketplace file is not a regular file: ${absPath}`)
        }
        temporaryCachePath = dirname(dirname(marketplacePath))
        marketplaceReadRoot = dirname(marketplacePath)
        cleanupNeeded = false
        break
      }

      case 'directory': {
        // For directories, look for .crabcode-plugin/marketplace.json
        // Resolve to absolute so error messages show the actual path checked
        // (legacy known_marketplaces.json entries may have relative paths)
        await revalidateCapturedLocalIngressSource(
          source,
          options?.localIngressIdentity,
        )
        const absPath = resolve(source.path)
        temporaryCachePath = await resolveInternalPluginPath(absPath, absPath, {
          component: 'local marketplace directory root',
        })
        marketplacePath = await resolvePluginComponentPath(
          temporaryCachePath,
          '.crabcode-plugin/marketplace.json',
          { mustExist: false, component: 'marketplace manifest' },
        )
        marketplaceReadRoot = temporaryCachePath
        cleanupNeeded = false
        break
      }

      case 'settings': {
        // Inline manifest from settings.json — no fetch. Synthesize the
        // marketplace.json on disk so getMarketplaceCacheOnly reads it
        // like any other source. The plugins array already passed
        // PluginMarketplaceEntrySchema validation when settings were parsed;
        // the post-switch parseFileWithSchema re-validates the full
        // PluginMarketplaceSchema (catches schema drift between the two).
        //
        // Writing to source.name up front means the rename below is a no-op
        // (temporaryCachePath === finalCachePath). known_marketplaces.json
        // stores this source object including the plugins array, so
        // diffMarketplaces detects settings edits via isEqual — no special
        // dirty-tracking needed.
        temporaryCachePath = await resolvePluginComponentPath(
          cacheDir,
          options?.stageOnly ? tempName : source.name,
          {
            mustExist: false,
            rejectSymlinks: true,
            rejectRoot: true,
            component: 'settings marketplace cache',
          },
        )
        marketplacePath = await resolvePluginComponentPath(
          temporaryCachePath,
          '.crabcode-plugin/marketplace.json',
          {
            mustExist: false,
            rejectSymlinks: true,
            rejectRoot: true,
            component: 'settings marketplace manifest',
          },
        )
        marketplaceReadRoot = temporaryCachePath
        cleanupNeeded = options?.stageOnly === true
        await fs.mkdir(dirname(marketplacePath))
        // No `satisfies PluginMarketplace` here: source.plugins is the narrow
        // SettingsMarketplacePlugin type (no strict/.default(), no manifest
        // fields). The parseFileWithSchema(PluginMarketplaceSchema()) call
        // below widens and validates — that's the real check.
        await writeCanonicalPluginFile(
          marketplaceReadRoot,
          marketplacePath,
          jsonStringify(
            {
              name: source.name,
              owner: source.owner ?? { name: 'settings' },
              plugins: source.plugins,
            },
            null,
            2,
          ),
          'settings marketplace manifest',
        )
        break
      }

      default:
        throw new Error(`Unsupported marketplace source type`)
    }

    // Load and validate the marketplace
    logForDebugging(`Reading marketplace from ${marketplacePath}`)
    let marketplace: PluginMarketplace
    try {
      await revalidateCapturedLocalIngressSource(
        source,
        options?.localIngressIdentity,
      )
      marketplace = await parseFileWithSchema(
        marketplacePath,
        PluginMarketplaceSchema(),
        marketplaceReadRoot,
      )
    } catch (e) {
      if (isENOENT(e)) {
        await revalidateCapturedLocalIngressSource(
          source,
          options?.localIngressIdentity,
        )
        const synthesized = await synthesizeMarketplaceFromPluginRepo(
          temporaryCachePath,
          marketplacePath,
          source,
        )
        if (!synthesized) {
          throw new Error(`Marketplace file not found at ${marketplacePath}`)
        }
        await revalidateCapturedLocalIngressSource(
          source,
          options?.localIngressIdentity,
        )
        marketplace = await parseFileWithSchema(
          marketplacePath,
          PluginMarketplaceSchema(),
          marketplaceReadRoot,
        )
      } else {
        throw new Error(
          `Failed to parse marketplace file at ${marketplacePath}: ${errorMessage(e)}`,
        )
      }
    }

    const generationId = randomUUID()
    const contentDigest = computeMarketplaceContentDigest(marketplace)

    // Remote live cache paths are immutable and generation-scoped. A refresh
    // publishes beside the current generation and flips the registry only
    // after publication succeeds; it never overwrites bytes referenced by a
    // concurrent install snapshot.
    const generationCacheName =
      source.source === 'url'
        ? `${marketplace.name}-${generationId}.json`
        : `${marketplace.name}-${generationId}`

    // Now choose the immutable destination for this exact generation.
    const finalCachePath = hardenedLocalSource
      ? join(cacheDir, marketplace.name)
      : await resolvePluginComponentPath(cacheDir, generationCacheName, {
          mustExist: false,
          rejectSymlinks: true,
          rejectRoot: true,
          component: 'marketplace cache destination',
        })
    // Defense-in-depth: the schema rejects path separators, .., and . in marketplace.name,
    // but verify the computed path is a strict subdirectory of cacheDir before fs.rm.
    // A malicious marketplace.json with a crafted name must never cause us to rm outside
    // cacheDir, nor rm cacheDir itself (e.g. name "." → join normalizes to cacheDir).
    const resolvedFinal = resolve(finalCachePath)
    const resolvedCacheDir = resolve(cacheDir)
    if (!resolvedFinal.startsWith(resolvedCacheDir + sep)) {
      throw new Error(
        `Marketplace name '${marketplace.name}' resolves to a path outside the cache directory`,
      )
    }
    if (options?.stageOnly && !isLocalMarketplaceSource(source)) {
      // The caller owns this unpublished generation from here. Reserved-name
      // and source validation happens before the short publication lock.
      return {
        marketplace,
        cachePath: temporaryCachePath,
        publishPath: finalCachePath,
        generationId,
        contentDigest,
      }
    }
    // Don't rename if it's a local file or directory, or already has the right name
    if (
      temporaryCachePath !== finalCachePath &&
      !isLocalMarketplaceSource(source)
    ) {
      try {
        // Remove the destination if it already exists, then rename
        try {
          onProgress?.('Cleaning up old marketplace cache…')
        } catch (callbackError) {
          logForDebugging(
            `Progress callback error: ${errorMessage(callbackError)}`,
            { level: 'warn' },
          )
        }
        await fs.rm(finalCachePath, { recursive: true, force: true })
        // Rename temp cache to final name
        const activeTemporaryCachePath = await resolveInternalPluginPath(
          cacheDir,
          temporaryCachePath,
          {
            rejectSymlinks: true,
            rejectRoot: true,
            component: 'temporary marketplace cache',
          },
        )
        const activeFinalCachePath = await resolveInternalPluginPath(
          cacheDir,
          finalCachePath,
          {
            mustExist: false,
            rejectSymlinks: true,
            rejectRoot: true,
            component: 'marketplace cache destination',
          },
        )
        await fs.rename(activeTemporaryCachePath, activeFinalCachePath)
        temporaryCachePath = finalCachePath
        cleanupNeeded = false // Successfully renamed, no cleanup needed
      } catch (error) {
        const errorMsg = errorMessage(error)
        throw new Error(
          `Failed to finalize marketplace cache. Please manually delete the directory at ${finalCachePath} if it exists and try again.\n\nTechnical details: ${errorMsg}`,
        )
      }
    }

    return {
      marketplace,
      cachePath: temporaryCachePath,
      generationId,
      contentDigest,
    }
  } catch (error) {
    // Clean up any temporary files/directories on error
    if (
      cleanupNeeded &&
      temporaryCachePath! &&
      !isLocalMarketplaceSource(source)
    ) {
      try {
        const safeTemporaryCachePath = await resolveInternalPluginPath(
          cacheDir,
          temporaryCachePath!,
          {
            mustExist: false,
            rejectSymlinks: true,
            rejectRoot: true,
            component: 'temporary marketplace cache cleanup',
          },
        )
        await fs.rm(safeTemporaryCachePath, {
          recursive: true,
          force: true,
        })
      } catch (cleanupError) {
        logForDebugging(
          `Warning: Failed to clean up temporary marketplace cache at ${temporaryCachePath}: ${errorMessage(cleanupError)}`,
          { level: 'warn' },
        )
      }
    }
    throw error
  }
}

/**
 * Add a marketplace source to the known marketplaces
 *
 * The marketplace is fetched, validated, and cached locally.
 * The configuration is saved to ~/.crabcode/plugins/known_marketplaces.json.
 *
 * @param source - MarketplaceSource object representing the marketplace source.
 *                 Callers should parse user input into MarketplaceSource format
 *                 (see AddMarketplace.parseMarketplaceInput for handling shortcuts like "owner/repo").
 * @param onProgress - Optional callback for progress updates during marketplace installation
 * @throws If source format is invalid or marketplace cannot be loaded
 */
/**
 * True when a source points at the official CrabCode marketplace repo. Used to
 * route the official marketplace through the GCS mirror (no git, no GitHub) on
 * first add — `acosmi/CrabCode-Plugin` is an INTERNAL repo that end users
 * cannot git-clone (SSH host-key / HTTPS auth), so the only working first-install
 * path is the mirror.
 */
function isOfficialMarketplaceSource(source: MarketplaceSource): boolean {
  return (
    source.source === 'github' &&
    source.repo.toLowerCase() === OFFICIAL_MARKETPLACE_SOURCE.repo.toLowerCase()
  )
}

function isExactOfficialMarketplaceSource(source: MarketplaceSource): boolean {
  return (
    isOfficialMarketplaceSource(source) &&
    source.source === 'github' &&
    source.ref === undefined &&
    source.path === undefined &&
    source.sparsePaths === undefined
  )
}

function normalizeMarketplaceIngressSparsePaths(
  source: MarketplaceSource,
): MarketplaceSource {
  const hasSparsePaths = 'sparsePaths' in source
  if (source.source !== 'git' && source.source !== 'github') {
    if (hasSparsePaths) {
      throw new MarketplaceIngressPolicyError(
        `sparsePaths is only supported for git/github sources (got '${source.source}')`,
      )
    }
    return source
  }

  const sparsePaths: unknown = source.sparsePaths
  if (sparsePaths === undefined) return source
  if (
    !Array.isArray(sparsePaths) ||
    !sparsePaths.every((path) => typeof path === 'string')
  ) {
    throw new MarketplaceIngressPolicyError(
      'sparsePaths must be an array of strings',
    )
  }
  try {
    return {
      ...source,
      sparsePaths: normalizeMarketplaceSparsePaths(sparsePaths),
    }
  } catch (error) {
    throw new MarketplaceIngressPolicyError(
      `invalid sparsePaths: ${errorMessage(error)}`,
    )
  }
}

function registeredMarketplaceSourceRawInput(
  source: MarketplaceSource,
): string {
  switch (source.source) {
    case 'github':
      return source.repo
    case 'git':
    case 'url':
      return source.url
    case 'file':
    case 'directory':
      return source.path
    default:
      throw new MarketplaceIngressPolicyError(
        `registered '${source.source}' sources cannot be refreshed through remote ingress`,
      )
  }
}

async function validateRegisteredMarketplaceSourceForIngress(
  source: MarketplaceSource,
): Promise<{
  source: MarketplaceSource
  localIdentity?: LocalMarketplaceIngressIdentity
}> {
  const normalized = normalizeMarketplaceIngressSparsePaths(source)
  if (!isEqual(normalized, source)) {
    throw new MarketplaceIngressPolicyError(
      'registered source contains non-canonical sparse paths',
    )
  }
  const validation = await validateAndCaptureMarketplaceIngressSource(
    registeredMarketplaceSourceRawInput(source),
    normalized,
  )
  if (!isEqual(validation.source, source)) {
    // Never upgrade a canonicalized derivative while committing against a
    // different legacy registry value. Re-add through the remote ingress boundary
    // so the approved canonical source becomes authoritative first.
    throw new MarketplaceIngressPolicyError(
      'registered source is not canonical for remote ingress refresh; remove and re-add it',
    )
  }
  return validation
}

async function revalidateCapturedLocalIngressSource(
  source: MarketplaceSource,
  localIdentity: LocalMarketplaceIngressIdentity | undefined,
): Promise<void> {
  if (!localIdentity) return
  if (!isLocalMarketplaceSource(source)) {
    throw new MarketplaceIngressPolicyError(
      'a local marketplace identity was attached to a network source',
    )
  }
  await revalidateLocalMarketplaceIngressIdentity(source, localIdentity)
}

export type AddMarketplaceSourceResult = {
  name: string
  alreadyMaterialized: boolean
  resolvedSource: MarketplaceSource
  installLocation: string
}

type PublishedMarketplaceGeneration = {
  livePath: string
  backupPath: string | null
}

function marketplaceAddStagingName(): string {
  return `.marketplace-add-${process.pid}-${randomUUID()}`
}

type OfficialMarketplaceGcsFetcher = typeof fetchOfficialMarketplaceFromGcs
let officialMarketplaceGcsFetcherOverride: OfficialMarketplaceGcsFetcher | null =
  null

/** Narrow test seam; avoids process-global module mocks leaking across files. */
export function __setOfficialMarketplaceGcsFetcherForTest(
  fetcher: OfficialMarketplaceGcsFetcher | null,
): void {
  officialMarketplaceGcsFetcherOverride = fetcher
}

async function stageOfficialMarketplaceFromGcs(
  context: MarketplaceCacheMutationContext,
  options?: { hardenedIngress?: boolean },
): Promise<LoadedPluginMarketplace | null> {
  const fs = getFsImplementation()
  await fs.mkdir(context.cacheDir)
  const stagingPath = await resolvePluginComponentPath(
    context.cacheDir,
    marketplaceAddStagingName(),
    {
      mustExist: false,
      rejectSymlinks: true,
      rejectRoot: true,
      component: 'official marketplace unpublished generation',
    },
  )
  const internalGcsStaging = `${stagingPath}.staging`
  let handedOff = false
  try {
    const fetchFromGcs =
      officialMarketplaceGcsFetcherOverride ?? fetchOfficialMarketplaceFromGcs
    const sha = await fetchFromGcs(stagingPath, context.cacheDir, options)
    if (sha === null) return null

    const manifestPath = await resolvePluginComponentPath(
      stagingPath,
      '.crabcode-plugin/marketplace.json',
      { component: 'official marketplace staged manifest' },
    )
    const marketplace = await parseFileWithSchema(
      manifestPath,
      PluginMarketplaceSchema(),
      stagingPath,
    )
    if (marketplace.name !== OFFICIAL_MARKETPLACE_NAME) {
      throw new Error(
        `Official marketplace mirror declared unexpected name '${marketplace.name}'`,
      )
    }
    const generationId = randomUUID()
    const contentDigest = computeMarketplaceContentDigest(marketplace)
    const publishPath = await resolvePluginComponentPath(
      context.cacheDir,
      `${OFFICIAL_MARKETPLACE_NAME}-${generationId}`,
      {
        mustExist: false,
        rejectSymlinks: true,
        rejectRoot: true,
        component: 'official marketplace live cache',
      },
    )
    handedOff = true
    return {
      marketplace,
      cachePath: stagingPath,
      publishPath,
      generationId,
      contentDigest,
    }
  } finally {
    if (!handedOff) {
      for (const path of [stagingPath, internalGcsStaging]) {
        try {
          await fs.rm(path, { recursive: true, force: true })
        } catch (error) {
          logForDebugging(
            `Failed to clean official marketplace staging generation: ${errorMessage(error)}`,
            { level: 'warn' },
          )
        }
      }
    }
  }
}

async function stageMarketplaceGenerationForExistingEntry(
  context: MarketplaceCacheMutationContext,
  name: string,
  source: MarketplaceSource,
  onProgress?: MarketplaceProgressCallback,
  options?: {
    disableCredentialHelper?: boolean
    hardenedIngress?: boolean
  },
): Promise<LoadedPluginMarketplace> {
  let staged: LoadedPluginMarketplace | undefined
  try {
    const shouldUseOfficialMirror =
      name === OFFICIAL_MARKETPLACE_NAME &&
      (!options?.hardenedIngress || isExactOfficialMarketplaceSource(source))
    if (shouldUseOfficialMirror) {
      staged =
        (await stageOfficialMarketplaceFromGcs(
          context,
          options?.hardenedIngress ? { hardenedIngress: true } : undefined,
        )) ?? undefined
      if (
        !staged &&
        !getFeatureValue_CACHED_MAY_BE_STALE(
          'tengu_plugin_official_mkt_git_fallback',
          true,
        )
      ) {
        throw new Error(
          'Official marketplace GCS fetch failed and git fallback is disabled',
        )
      }
    }

    staged ??= await loadAndCacheMarketplace(source, onProgress, {
      stageOnly: true,
      cacheDir: context.cacheDir,
      stagingName: marketplaceAddStagingName(),
      disableCredentialHelper: options?.disableCredentialHelper,
      hardenedIngress: options?.hardenedIngress,
    })

    const sourceValidationError = validateOfficialNameSource(
      staged.marketplace.name,
      source,
    )
    if (sourceValidationError) throw new Error(sourceValidationError)
    if (staged.marketplace.name !== name) {
      throw new Error(
        `Marketplace '${name}' source declared unexpected name '${staged.marketplace.name}'`,
      )
    }
    return staged
  } catch (error) {
    await cleanupUnpublishedMarketplaceGeneration(context, staged)
    throw error
  }
}

async function publishStagedMarketplaceGeneration(
  context: MarketplaceCacheMutationContext,
  stagedPath: string,
  requestedLivePath: string,
): Promise<PublishedMarketplaceGeneration> {
  const fs = getFsImplementation()
  const activeStagedPath = await resolveInternalPluginPath(
    context.cacheDir,
    stagedPath,
    {
      rejectSymlinks: true,
      rejectRoot: true,
      component: 'marketplace unpublished generation',
    },
  )
  const livePath = await resolveInternalPluginPath(
    context.cacheDir,
    requestedLivePath,
    {
      mustExist: false,
      rejectSymlinks: true,
      rejectRoot: true,
      component: 'marketplace live cache',
    },
  )
  let newGenerationPublished = false
  try {
    try {
      await fs.stat(livePath)
      throw new Error(
        `Refusing to overwrite existing marketplace generation at ${livePath}`,
      )
    } catch (error) {
      if (!isENOENT(error)) throw error
    }
    await fs.rename(activeStagedPath, livePath)
    newGenerationPublished = true
    return {
      livePath,
      backupPath: null,
    }
  } catch (publishError) {
    try {
      if (newGenerationPublished) {
        await fs.rm(livePath, { recursive: true, force: true })
      }
    } catch (restoreError) {
      throw new Error(
        `Marketplace cache publish failed (${errorMessage(publishError)}) and new-generation cleanup failed (${errorMessage(restoreError)})`,
      )
    }
    throw publishError
  }
}

async function rollbackPublishedMarketplaceGeneration(
  publication: PublishedMarketplaceGeneration,
): Promise<void> {
  const fs = getFsImplementation()
  await fs.rm(publication.livePath, { recursive: true, force: true })
}

async function finalizePublishedMarketplaceGeneration(
  publication: PublishedMarketplaceGeneration,
): Promise<void> {
  if (!publication.backupPath) return
  await getFsImplementation().rm(publication.backupPath, {
    recursive: true,
    force: true,
  })
}

async function cleanupUnpublishedMarketplaceGeneration(
  context: MarketplaceCacheMutationContext,
  staged: LoadedPluginMarketplace | undefined,
): Promise<void> {
  if (!staged?.publishPath) return
  try {
    const path = await resolveInternalPluginPath(
      context.cacheDir,
      staged.cachePath,
      {
        mustExist: false,
        rejectSymlinks: true,
        rejectRoot: true,
        component: 'marketplace unpublished generation cleanup',
      },
    )
    await getFsImplementation().rm(path, { recursive: true, force: true })
  } catch (error) {
    logForDebugging(
      `Failed to clean unpublished marketplace generation: ${errorMessage(error)}`,
      { level: 'warn' },
    )
  }
}

type CoordinatedMarketplaceMutationResult<T> = {
  value: T
  changed: boolean
  postCommitCleanup?: string | null
}

/**
 * The single cache publication state machine used by add, read-repair,
 * refresh, and startup install. Callers mutate only the in-memory registry
 * generation in `operation`; this helper owns cache → registry lock order,
 * backup/publish, commit-failure rollback, and best-effort cleanup.
 */
async function commitStagedMarketplaceMutation<T>(
  context: MarketplaceCacheMutationContext,
  staged: LoadedPluginMarketplace,
  operation: (
    config: KnownMarketplacesConfig,
    installLocation: string,
  ) => Promise<CoordinatedMarketplaceMutationResult<T>>,
): Promise<T> {
  const configFile = join(context.pluginsRoot, 'known_marketplaces.json')
  return withMarketplaceCacheMutationLock(async () => {
    let publication: PublishedMarketplaceGeneration | undefined
    let coordinatedRollbackCompleted = false
    let postCommitCleanup: string | null = null
    let result: T
    try {
      result = await withKnownMarketplacesTransaction<T>(async (config) => {
        const installLocation = staged.publishPath ?? staged.cachePath
        const mutation = await operation(config, installLocation)
        postCommitCleanup = mutation.postCommitCleanup ?? null
        if (mutation.changed && staged.publishPath) {
          // Publish last: after this rename succeeds, the only remaining
          // fallible step is the registry's atomic commit. Its failure hook
          // restores the backup before the registry lock is released.
          publication = await publishStagedMarketplaceGeneration(
            context,
            staged.cachePath,
            staged.publishPath,
          )
        }
        return {
          value: mutation.value,
          changed: mutation.changed,
          ...(publication && {
            onCommitFailure: async () => {
              await rollbackPublishedMarketplaceGeneration(publication!)
              coordinatedRollbackCompleted = true
            },
          }),
        }
      }, configFile)
    } catch (error) {
      if (publication && !coordinatedRollbackCompleted) {
        try {
          await rollbackPublishedMarketplaceGeneration(publication)
        } catch (restoreError) {
          throw new Error(
            `Marketplace registry commit failed (${errorMessage(error)}) and live cache rollback failed (${errorMessage(restoreError)})`,
          )
        }
      }
      throw error
    }

    if (publication) {
      try {
        await finalizePublishedMarketplaceGeneration(publication)
      } catch (error) {
        logForDebugging(
          `Failed to remove committed marketplace rollback generation: ${errorMessage(error)}`,
          { level: 'warn' },
        )
      }
    }
    if (postCommitCleanup) {
      try {
        await getFsImplementation().rm(postCommitCleanup, {
          recursive: true,
          force: true,
        })
      } catch (error) {
        logForDebugging(
          `Failed to clean up replaced marketplace cache (${postCommitCleanup}): ${errorMessage(error)}`,
          { level: 'warn' },
        )
      }
    }
    return result
  }, context)
}

type ExistingMarketplaceCommitResult =
  | { status: 'committed'; installLocation: string }
  | { status: 'missing' | 'stale' }

async function commitStagedExistingMarketplace(
  context: MarketplaceCacheMutationContext,
  name: string,
  expectedSource: MarketplaceSource,
  staged: LoadedPluginMarketplace,
): Promise<ExistingMarketplaceCommitResult> {
  return commitStagedMarketplaceMutation<ExistingMarketplaceCommitResult>(
    context,
    staged,
    async (config, installLocation) => {
      const current = config[name]
      if (!current) {
        return { value: { status: 'missing' }, changed: false }
      }
      if (!isEqual(current.source, expectedSource)) {
        return { value: { status: 'stale' }, changed: false }
      }

      let postCommitCleanup: string | null = null
      if (!isLocalMarketplaceSource(current.source)) {
        try {
          const resolvedOld = await resolveInternalPluginPath(
            context.cacheDir,
            current.installLocation,
            {
              rejectSymlinks: true,
              rejectRoot: true,
              component: 'previous marketplace cache generation',
            },
          )
          if (resolvedOld !== resolve(installLocation)) {
            postCommitCleanup = resolvedOld
          }
        } catch (error) {
          logForDebugging(
            `Skipping cleanup of unsafe previous installLocation (${current.installLocation}): ${errorMessage(error)}`,
            { level: 'warn' },
          )
        }
      }

      current.installLocation = installLocation
      current.lastUpdated = new Date().toISOString()
      current.generationId = staged.generationId
      current.contentDigest = staged.contentDigest
      return {
        value: { status: 'committed', installLocation },
        changed: true,
        postCommitCleanup,
      }
    },
  )
}

async function commitMarketplaceTimestampOnly(
  context: MarketplaceCacheMutationContext,
  name: string,
  expectedSource: MarketplaceSource,
  marketplace: PluginMarketplace,
  localIngressIdentity?: LocalMarketplaceIngressIdentity,
): Promise<ExistingMarketplaceCommitResult> {
  return withKnownMarketplacesTransaction<ExistingMarketplaceCommitResult>(
    async (config) => {
      const current = config[name]
      if (!current) {
        return { value: { status: 'missing' as const }, changed: false }
      }
      if (!isEqual(current.source, expectedSource)) {
        return { value: { status: 'stale' as const }, changed: false }
      }
      await revalidateCapturedLocalIngressSource(
        current.source,
        localIngressIdentity,
      )
      current.lastUpdated = new Date().toISOString()
      current.generationId = randomUUID()
      current.contentDigest = computeMarketplaceContentDigest(marketplace)
      return {
        value: {
          status: 'committed' as const,
          installLocation: current.installLocation,
        },
        changed: true,
      }
    },
    join(context.pluginsRoot, 'known_marketplaces.json'),
  )
}

async function commitStagedMarketplaceAdd(
  context: MarketplaceCacheMutationContext,
  staged: LoadedPluginMarketplace,
  resolvedSource: MarketplaceSource,
  localIngressIdentity?: LocalMarketplaceIngressIdentity,
): Promise<AddMarketplaceSourceResult> {
  return commitStagedMarketplaceMutation<AddMarketplaceSourceResult>(
    context,
    staged,
    async (config, installLocation) => {
      // Run inside the coordinated cache → registry transaction immediately
      // before any authoritative state can change.
      await revalidateCapturedLocalIngressSource(
        resolvedSource,
        localIngressIdentity,
      )
      const marketplaceName = staged.marketplace.name
      for (const [existingName, existingEntry] of Object.entries(config)) {
        if (isEqual(existingEntry.source, resolvedSource)) {
          try {
            const existingMarketplace = await readCachedMarketplace(
              existingEntry.installLocation,
              existingEntry.source,
              context.cacheDir,
              localIngressIdentity,
            )
            const existingDigest =
              computeMarketplaceContentDigest(existingMarketplace)
            await revalidateCapturedLocalIngressSource(
              resolvedSource,
              localIngressIdentity,
            )
            if (
              existingEntry.contentDigest === undefined ||
              existingEntry.contentDigest === existingDigest
            ) {
              const needsIdentityBackfill =
                !existingEntry.generationId || !existingEntry.contentDigest
              if (needsIdentityBackfill) {
                existingEntry.generationId = randomUUID()
                existingEntry.contentDigest = existingDigest
              }
              return {
                value: {
                  name: existingName,
                  alreadyMaterialized: true,
                  resolvedSource,
                  installLocation: existingEntry.installLocation,
                },
                changed: needsIdentityBackfill,
              }
            }
            // The bytes no longer match the registered generation. Continue
            // into the staged repair path below.
          } catch (error) {
            if (error instanceof MarketplaceIngressPolicyError) {
              throw error
            }
            if (existingName !== marketplaceName) {
              throw new Error(
                `Marketplace source is registered as '${existingName}' with an invalid cache but now declares '${marketplaceName}'`,
              )
            }
            // Same authoritative source with a missing/corrupt cache: publish
            // the already-staged repair instead of returning a dead path.
          }
        }
      }

      const oldEntry = config[marketplaceName]
      if (oldEntry) {
        const seedDir = seedDirFor(oldEntry.installLocation)
        if (seedDir) {
          throw new Error(
            `Marketplace '${marketplaceName}' is seed-managed (${seedDir}). ` +
              `To use a different source, ask your admin to update the seed, ` +
              `or use a different marketplace name.`,
          )
        }
        logForDebugging(
          `Marketplace '${marketplaceName}' exists with different source — overwriting`,
        )
      }

      let postCommitCleanup: string | null = null
      if (oldEntry && !isLocalMarketplaceSource(oldEntry.source)) {
        try {
          const resolvedOld = await resolveInternalPluginPath(
            context.cacheDir,
            oldEntry.installLocation,
            {
              rejectSymlinks: true,
              rejectRoot: true,
              component: 'old marketplace cache',
            },
          )
          if (resolvedOld !== resolve(installLocation)) {
            postCommitCleanup = resolvedOld
          }
        } catch (error) {
          logForDebugging(
            `Skipping cleanup of unsafe old installLocation (${oldEntry.installLocation}): ${errorMessage(error)}`,
            { level: 'warn' },
          )
        }
      }

      await revalidateCapturedLocalIngressSource(
        resolvedSource,
        localIngressIdentity,
      )
      config[marketplaceName] = {
        source: resolvedSource,
        installLocation,
        lastUpdated: new Date().toISOString(),
        generationId: staged.generationId,
        contentDigest: staged.contentDigest,
      }
      return {
        value: {
          name: marketplaceName,
          alreadyMaterialized: false,
          resolvedSource,
          installLocation,
        },
        changed: true,
        postCommitCleanup,
      }
    },
  )
}

async function findHealthyExistingMarketplaceSource(
  context: MarketplaceCacheMutationContext,
  source: MarketplaceSource,
  localIngressIdentity?: LocalMarketplaceIngressIdentity,
): Promise<AddMarketplaceSourceResult | null> {
  return withMarketplaceCacheMutationLock(
    async () =>
      withKnownMarketplacesTransaction(
        async (config) => {
          for (const [name, entry] of Object.entries(config)) {
            if (!isEqual(entry.source, source)) continue
            let marketplace: PluginMarketplace
            try {
              marketplace = await readCachedMarketplace(
                entry.installLocation,
                entry.source,
                context.cacheDir,
                localIngressIdentity,
              )
            } catch (error) {
              if (error instanceof MarketplaceIngressPolicyError) {
                throw error
              }
              return { value: null, changed: false }
            }
            const contentDigest = computeMarketplaceContentDigest(marketplace)
            await revalidateCapturedLocalIngressSource(
              source,
              localIngressIdentity,
            )
            if (
              entry.contentDigest !== undefined &&
              entry.contentDigest !== contentDigest
            ) {
              // The registry identity and bytes disagree. Treat this as a
              // damaged generation so the normal staged repair path replaces
              // it; never silently relabel changed bytes with the old identity.
              return { value: null, changed: false }
            }
            const needsIdentityBackfill =
              !entry.generationId || !entry.contentDigest
            if (needsIdentityBackfill) {
              entry.generationId = randomUUID()
              entry.contentDigest = contentDigest
            }
            return {
              value: {
                name,
                alreadyMaterialized: true,
                resolvedSource: source,
                installLocation: entry.installLocation,
              },
              changed: needsIdentityBackfill,
            }
          }
          return { value: null, changed: false }
        },
        join(context.pluginsRoot, 'known_marketplaces.json'),
      ),
    context,
  )
}

async function addMarketplaceSourceInternal(
  source: MarketplaceSource,
  onProgress?: MarketplaceProgressCallback,
  options?: {
    hardenedIngress?: boolean
    localIngressIdentity?: LocalMarketplaceIngressIdentity
  },
): Promise<AddMarketplaceSourceResult> {
  // Capture the actual cache/registry targets once. Network work below uses a
  // unique unpublished generation outside the global cache mutex; only the
  // bounded backup/publish + registry commit phase takes cache → registry.
  const context = captureMarketplaceCacheContext()
  // Resolve relative directory/file paths to absolute so state is cwd-independent
  let resolvedSource = source
  if (isLocalMarketplaceSource(source) && !isAbsolute(source.path)) {
    resolvedSource = { ...source, path: resolve(source.path) }
  }
  if (
    options?.hardenedIngress &&
    isLocalMarketplaceSource(resolvedSource) &&
    !options.localIngressIdentity
  ) {
    throw new MarketplaceIngressPolicyError(
      'hardened local marketplace operations require a captured identity',
    )
  }

  // Check policy FIRST, before any network/filesystem operations
  // This prevents downloading/cloning when the source is blocked
  if (!isSourceAllowedByPolicy(resolvedSource)) {
    // Check if explicitly blocked vs not in allowlist for better error messages
    if (isSourceInBlocklist(resolvedSource)) {
      throw new Error(
        `Marketplace source '${formatSourceForDisplay(resolvedSource)}' is blocked by enterprise policy.`,
      )
    }
    // Not in allowlist - build helpful error message
    const allowlist = getStrictKnownMarketplaces() || []
    const hostPatterns = getHostPatternsFromAllowlist()
    const sourceHost = extractHostFromSource(resolvedSource)

    let errorMessage = `Marketplace source '${formatSourceForDisplay(resolvedSource)}'`
    if (sourceHost) {
      errorMessage += ` (${sourceHost})`
    }
    errorMessage += ' is blocked by enterprise policy.'

    if (allowlist.length > 0) {
      errorMessage += ` Allowed sources: ${allowlist.map((s) => formatSourceForDisplay(s)).join(', ')}`
    } else {
      errorMessage += ' No external marketplaces are allowed.'
    }

    // If source is a github shorthand and there are hostPatterns, suggest using full URL
    if (resolvedSource.source === 'github' && hostPatterns.length > 0) {
      errorMessage +=
        `\n\nTip: The shorthand "${resolvedSource.repo}" assumes github.com. ` +
        `For internal GitHub Enterprise, use the full URL:\n` +
        `  git@your-github-host.com:${resolvedSource.repo}.git`
    }

    throw new Error(errorMessage)
  }

  // Fast idempotency stays linearizable with remove/refresh: the read and
  // cache-health check use the same cache → registry lock order as mutation.
  const healthyExisting = await findHealthyExistingMarketplaceSource(
    context,
    resolvedSource,
    options?.localIngressIdentity,
  )
  if (healthyExisting) {
    logForDebugging(
      `Source already materialized as '${healthyExisting.name}', skipping clone`,
    )
    return healthyExisting
  }

  // direct-add parity (W-OFFICIAL-PLUGINS-BUNDLE-SEED): when the source IS the
  // official marketplace repo, install from the GCS mirror first — the same path
  // the startup auto-install uses (officialMarketplaceStartupCheck.ts:236-268).
  // Without this, addMarketplaceSource git-clones acosmi/CrabCode-Plugin, an
  // INTERNAL repo that end users cannot clone, which is the SSH/host-key failure
  // the desktop client "添加官方市场" button surfaces. On GCS success we register under the
  // canonical name so refresh / seed / "already installed" checks all line up.
  // Falls through to the existing git path only when the mirror is unreachable
  // AND the git-fallback kill-switch allows.
  let staged: LoadedPluginMarketplace | undefined
  try {
    const shouldUseOfficialMirror = options?.hardenedIngress
      ? isExactOfficialMarketplaceSource(resolvedSource)
      : isOfficialMarketplaceSource(resolvedSource)
    if (shouldUseOfficialMirror) {
      const gcsStaged = await stageOfficialMarketplaceFromGcs(
        context,
        options?.hardenedIngress ? { hardenedIngress: true } : undefined,
      )
      if (gcsStaged) {
        staged = gcsStaged
        resolvedSource = OFFICIAL_MARKETPLACE_SOURCE
      } else if (
        !getFeatureValue_CACHED_MAY_BE_STALE(
          'tengu_plugin_official_mkt_git_fallback',
          true,
        )
      ) {
        throw new Error(
          'Official marketplace mirror is unreachable and git fallback is disabled. Please try again later.',
        )
      }
    }

    staged ??= await loadAndCacheMarketplace(resolvedSource, onProgress, {
      stageOnly: true,
      cacheDir: context.cacheDir,
      stagingName: marketplaceAddStagingName(),
      hardenedIngress: options?.hardenedIngress,
      localIngressIdentity: options?.localIngressIdentity,
    })

    // A staged generation is still private here. Validate reserved names
    // before any rename can make attacker-controlled bytes live.
    const sourceValidationError = validateOfficialNameSource(
      staged.marketplace.name,
      resolvedSource,
    )
    if (sourceValidationError) {
      throw new Error(sourceValidationError)
    }

    const result = await commitStagedMarketplaceAdd(
      context,
      staged,
      resolvedSource,
      options?.localIngressIdentity,
    )
    logForDebugging(
      result.alreadyMaterialized
        ? `Source already materialized as '${result.name}', skipping registry write`
        : `Added marketplace source: ${result.name}`,
    )
    return result
  } finally {
    await cleanupUnpublishedMarketplaceGeneration(context, staged)
  }
}

/**
 * Global CLI/TUI add behavior. This deliberately retains the existing source
 * policy, Git authentication, SSH fallback, redirect, and official-mirror
 * semantics.
 */
export async function addMarketplaceSource(
  source: MarketplaceSource,
  onProgress?: MarketplaceProgressCallback,
): Promise<AddMarketplaceSourceResult> {
  return addMarketplaceSourceInternal(source, onProgress)
}

/**
 * remote ingress-only add boundary. Revalidates and canonicalizes the source inside
 * the runtime immediately before any network or cache work, even when an
 * upstream worker already applied the shared policy.
 */
export async function addMarketplaceSourceFromIngress(
  rawInput: string,
  source: MarketplaceSource,
  onProgress?: MarketplaceProgressCallback,
): Promise<AddMarketplaceSourceResult> {
  const normalizedInput = normalizeMarketplaceIngressSparsePaths(source)
  const validation = await validateAndCaptureMarketplaceIngressSource(
    rawInput,
    normalizedInput,
  )
  const resolvedSource = normalizeMarketplaceIngressSparsePaths(
    validation.source,
  )
  return addMarketplaceSourceInternal(resolvedSource, onProgress, {
    hardenedIngress: true,
    localIngressIdentity: validation.localIdentity,
  })
}

/**
 * Startup's GCS-only attempt. The mirror download/extraction is staged without
 * the global cache mutex; the same coordinated add publisher owns the short
 * cache → registry commit. `false` means callers may apply their git fallback
 * policy.
 */
export async function installOfficialMarketplaceFromGcs(): Promise<boolean> {
  const context = captureMarketplaceCacheContext()
  const staged = await stageOfficialMarketplaceFromGcs(context)
  if (!staged) return false
  try {
    await commitStagedMarketplaceAdd(
      context,
      staged,
      OFFICIAL_MARKETPLACE_SOURCE,
    )
    return true
  } finally {
    await cleanupUnpublishedMarketplaceGeneration(context, staged)
  }
}

/**
 * Remove a marketplace source from known marketplaces
 *
 * Refuses removal while any installed scope belongs to the marketplace. Once
 * empty, removes the marketplace configuration, managed cache, and stale
 * settings declarations. Plugin installations, version caches, options,
 * secrets, and data are never cascaded from this operation.
 *
 * @param name - The marketplace name to remove
 * @throws If marketplace with given name is not found
 */
export type RemoveMarketplaceSourceResult = {
  installLocation: string
}

export const MARKETPLACE_REMOVE_INSTALL_LOCATION_INVALID =
  'MARKETPLACE_REMOVE_INSTALL_LOCATION_INVALID' as const

export class MarketplaceRemovalInstallLocationError extends Error {
  readonly code = MARKETPLACE_REMOVE_INSTALL_LOCATION_INVALID

  constructor(name: string, installLocation: unknown) {
    super(
      `Marketplace '${name}' has an invalid absolute installLocation and cannot be removed safely: ${JSON.stringify(installLocation)}`,
    )
    this.name = 'MarketplaceRemovalInstallLocationError'
  }
}

type MarketplaceRemovalSettingsSource =
  | 'userSettings'
  | 'projectSettings'
  | 'localSettings'

type MarketplaceRemovalSettingsPlan = {
  source: MarketplaceRemovalSettingsSource
  forward: SettingsJson
  rollback: SettingsJson
}

type StagedMarketplaceCacheRemoval = {
  originalPath: string
  tombstonePath: string
}

const MARKETPLACE_REMOVAL_TOMBSTONE_PREFIX = '.marketplace-remove-'

function buildMarketplaceRemovalSettingsPlans(
  name: string,
): MarketplaceRemovalSettingsPlan[] {
  const sources: MarketplaceRemovalSettingsSource[] = [
    'userSettings',
    'projectSettings',
    'localSettings',
  ]
  const plans: MarketplaceRemovalSettingsPlan[] = []

  for (const source of sources) {
    const settings = getSettingsForSource(source)
    if (!settings) continue
    const forward: SettingsJson = {}
    const rollback: SettingsJson = {}
    let changed = false

    const declaredMarketplace = settings.extraKnownMarketplaces?.[name]
    if (declaredMarketplace) {
      const next: Partial<SettingsJson['extraKnownMarketplaces']> = {
        ...settings.extraKnownMarketplaces,
      }
      next[name] = undefined
      forward.extraKnownMarketplaces =
        next as SettingsJson['extraKnownMarketplaces']
      rollback.extraKnownMarketplaces = {
        [name]: declaredMarketplace,
      } as SettingsJson['extraKnownMarketplaces']
      changed = true
    }

    if (settings.enabledPlugins) {
      const next = { ...settings.enabledPlugins }
      const previous: typeof settings.enabledPlugins = {}
      for (const [pluginId, value] of Object.entries(
        settings.enabledPlugins,
      )) {
        if (parsePluginIdentifier(pluginId).marketplace !== name) continue
        next[pluginId] = undefined
        previous[pluginId] = value
        changed = true
      }
      if (Object.keys(previous).length > 0) {
        forward.enabledPlugins = next
        rollback.enabledPlugins = previous
      }
    }

    if (changed) plans.push({ source, forward, rollback })
  }
  return plans
}

function commitMarketplaceRemovalSettings(
  plans: readonly MarketplaceRemovalSettingsPlan[],
): void {
  const committed: MarketplaceRemovalSettingsPlan[] = []
  for (const plan of plans) {
    const result = updateSettingsForSource(plan.source, plan.forward)
    if (!result.error) {
      committed.push(plan)
      continue
    }

    const rollbackErrors: Error[] = []
    for (const previous of committed.reverse()) {
      const rollback = updateSettingsForSource(
        previous.source,
        previous.rollback,
      )
      if (rollback.error) rollbackErrors.push(rollback.error)
    }
    if (rollbackErrors.length > 0) {
      throw new Error(
        `Marketplace settings cleanup failed (${result.error.message}) and settings rollback failed (${rollbackErrors.map(error => error.message).join('; ')})`,
      )
    }
    throw result.error
  }
}

function marketplaceRemovalTombstoneName(originalPath: string): string {
  const encodedBasename = Buffer.from(basename(originalPath)).toString(
    'base64url',
  )
  return `${MARKETPLACE_REMOVAL_TOMBSTONE_PREFIX}${randomUUID()}-${encodedBasename}`
}

function originalBasenameFromMarketplaceRemovalTombstone(
  tombstoneName: string,
): string | null {
  if (!tombstoneName.startsWith(MARKETPLACE_REMOVAL_TOMBSTONE_PREFIX)) {
    return null
  }
  const suffix = tombstoneName.slice(
    MARKETPLACE_REMOVAL_TOMBSTONE_PREFIX.length,
  )
  if (!/^[0-9a-f-]{36}-/i.test(suffix)) return null
  const encoded = suffix.slice(37)
  if (!encoded) return null
  const decoded = Buffer.from(encoded, 'base64url').toString('utf8')
  if (
    !decoded ||
    basename(decoded) !== decoded ||
    Buffer.from(decoded).toString('base64url') !== encoded
  ) {
    return null
  }
  return decoded
}

async function stageMarketplaceCacheRemoval(
  context: MarketplaceCacheMutationContext,
  originalPath: string,
): Promise<StagedMarketplaceCacheRemoval | null> {
  const tombstonePath = await resolveInternalPluginPath(
    context.cacheDir,
    join(context.cacheDir, marketplaceRemovalTombstoneName(originalPath)),
    {
      mustExist: false,
      rejectSymlinks: true,
      rejectRoot: true,
      component: 'marketplace removal tombstone',
    },
  )
  try {
    await getFsImplementation().rename(originalPath, tombstonePath)
    return { originalPath, tombstonePath }
  } catch (error) {
    if (isENOENT(error)) return null
    throw error
  }
}

async function restoreStagedMarketplaceCacheRemoval(
  staged: StagedMarketplaceCacheRemoval | null,
): Promise<void> {
  if (!staged) return
  try {
    await getFsImplementation().rename(
      staged.tombstonePath,
      staged.originalPath,
    )
  } catch (error) {
    if (isENOENT(error)) {
      try {
        await getFsImplementation().stat(staged.originalPath)
        return
      } catch {}
    }
    throw error
  }
}

async function reconcileMarketplaceRemovalTombstones(
  context: MarketplaceCacheMutationContext,
  config: KnownMarketplacesConfig,
): Promise<void> {
  let entries
  try {
    entries = await getFsImplementation().readdir(context.cacheDir)
  } catch (error) {
    if (isENOENT(error)) return
    throw error
  }

  for (const entry of entries) {
    const originalBasename = originalBasenameFromMarketplaceRemovalTombstone(
      entry.name,
    )
    if (!originalBasename) continue
    const tombstonePath = await resolveInternalPluginPath(
      context.cacheDir,
      join(context.cacheDir, entry.name),
      {
        rejectSymlinks: true,
        rejectRoot: true,
        component: 'marketplace removal tombstone reconciliation',
      },
    )
    const originalPath = await resolveInternalPluginPath(
      context.cacheDir,
      join(context.cacheDir, originalBasename),
      {
        mustExist: false,
        rejectSymlinks: true,
        rejectRoot: true,
        component: 'marketplace removal original cache reconciliation',
      },
    )
    const registryStillReferencesOriginal = Object.values(config).some(
      known => resolve(known.installLocation) === resolve(originalPath),
    )
    if (!registryStillReferencesOriginal) {
      try {
        await getFsImplementation().rm(tombstonePath, {
          recursive: true,
          force: true,
        })
      } catch (error) {
        logForDebugging(
          `Deferred marketplace removal cleanup still pending at ${tombstonePath}: ${errorMessage(error)}`,
          { level: 'warn' },
        )
      }
      continue
    }

    try {
      await getFsImplementation().stat(originalPath)
      await getFsImplementation().rm(tombstonePath, {
        recursive: true,
        force: true,
      })
    } catch (error) {
      if (!isENOENT(error)) throw error
      await getFsImplementation().rename(tombstonePath, originalPath)
    }
  }
}

export async function removeMarketplaceSource(
  name: string,
): Promise<RemoveMarketplaceSourceResult> {
  const context = captureMarketplaceCacheContext()
  return withPluginMarketplaceMembershipLock(
    () =>
      withMarketplaceCacheMutationLock(
        () => removeMarketplaceSourceWithinCacheLock(name, context),
        context,
      ),
    context,
  )
}

async function removeMarketplaceSourceWithinCacheLock(
  name: string,
  context: MarketplaceCacheMutationContext,
): Promise<RemoveMarketplaceSourceResult> {
  const removed = await withKnownMarketplacesTransaction(
    async (config) => {
      // Finish or reverse tombstones left by a prior interrupted removal before
      // deriving this registry generation. Referenced originals are restored;
      // unreferenced tombstones are safe deferred-GC candidates.
      await reconcileMarketplaceRemovalTombstones(context, config)
      const entry = config[name]
      if (!entry) {
        throw new Error(`Marketplace '${name}' not found`)
      }

      // The worker projects this value into an AbsolutePathBuf after the
      // transaction commits. Validate and normalize it while registry/cache
      // locks are still held, before deleting any registry, cache, settings,
      // installed, options, or data state.
      const safeInstallLocation =
        normalizeSafeAbsoluteMarketplaceInstallLocation(entry.installLocation)
      if (safeInstallLocation === null) {
        throw new MarketplaceRemovalInstallLocationError(
          name,
          entry.installLocation,
        )
      }

      // Seed-registered marketplaces are admin-baked into the container —
      // removing them is a category error. They'd resurrect on next startup.
      const seedDir = seedDirFor(safeInstallLocation)
      if (seedDir) {
        throw new Error(
          `Marketplace '${name}' is registered from the read-only seed directory ` +
            `(${seedDir}) and will be re-registered on next startup. ` +
            `To stop using its plugins: crabcode plugin disable <plugin>@${name}`,
        )
      }

      // Exact, strict guard read while the global lock hierarchy is held:
      // membership → cache → registry → installed. A malformed installed
      // registry is a classified failure and cannot be treated as empty.
      assertNoInstalledPluginsForMarketplaceStrict(name)

      let managedInstallLocation: string | null = null
      if (!isLocalMarketplaceSource(entry.source)) {
        try {
          managedInstallLocation = await resolveInternalPluginPath(
            context.cacheDir,
            safeInstallLocation,
            {
              rejectSymlinks: true,
              rejectRoot: true,
              component: 'marketplace managed generation removal',
            },
          )
        } catch {
          throw new MarketplaceRemovalInstallLocationError(
            name,
            entry.installLocation,
          )
        }
      }

      const settingsPlans = buildMarketplaceRemovalSettingsPlans(name)
      const stagedCacheRemoval = managedInstallLocation
        ? await stageMarketplaceCacheRemoval(
            context,
            managedInstallLocation,
          )
        : null

      delete config[name]
      return {
        value: {
          installLocation: safeInstallLocation,
          stagedCacheRemoval,
        },
        changed: true,
        ...(stagedCacheRemoval && {
          onCommitFailure: () =>
            restoreStagedMarketplaceCacheRemoval(stagedCacheRemoval),
          onSiblingFailure: () =>
            restoreStagedMarketplaceCacheRemoval(stagedCacheRemoval),
        }),
        commitSibling: async () => {
          commitMarketplaceRemovalSettings(settingsPlans)
        },
      }
    },
    join(context.pluginsRoot, 'known_marketplaces.json'),
  )

  // The live cache name was atomically moved aside before the registry commit.
  // Physical deletion is deliberately post-commit: failure leaves only an
  // unreferenced tombstone, never a registry entry pointing at missing bytes.
  // A later removal reconciles and retries these tombstones under the same lock.
  if (removed.stagedCacheRemoval) {
    try {
      await getFsImplementation().rm(
        removed.stagedCacheRemoval.tombstonePath,
        { recursive: true, force: true },
      )
    } catch (error) {
      logForDebugging(
        `Deferred marketplace cache cleanup at ${removed.stagedCacheRemoval.tombstonePath}: ${errorMessage(error)}`,
        { level: 'warn' },
      )
    }
  }

  logForDebugging(`Removed marketplace source: ${name}`)
  return { installLocation: removed.installLocation }
}

/**
 * Resolve the trusted on-disk root of a registered marketplace.
 *
 * Everything read out of a marketplace directory — the manifest, and the
 * category taxonomy beside it — must clear the same boundary, so this is
 * deliberately one function rather than a rule each reader re-implements:
 * a local source is an explicit trust root that is canonicalized once (and,
 * when an app-server identity was captured, re-proved against it), while a
 * cached source must resolve strictly inside the plugins cache root with
 * symlinks rejected.
 */
async function resolveSafeMarketplaceRoot(
  installLocation: string,
  source: MarketplaceSource,
  managedCacheRoot?: string,
  localIngressIdentity?: LocalMarketplaceIngressIdentity,
): Promise<string> {
  // For hardened local sources this is both the healthy-existing fast-path
  // guard and the immediate pre-manifest-read guard. Global callers omit it.
  await revalidateCapturedLocalIngressSource(source, localIngressIdentity)
  let safeInstallLocation: string
  if (isLocalMarketplaceSource(source)) {
    if (localIngressIdentity) {
      const expectedLexicalLocation =
        source.source === 'directory'
          ? localIngressIdentity.canonicalTarget
          : dirname(dirname(localIngressIdentity.canonicalTarget))
      if (installLocation !== expectedLexicalLocation) {
        throw new MarketplaceIngressPolicyError(
          'registered local installLocation no longer matches the captured identity',
        )
      }
    }
    // A local source is an explicit trust root. Canonicalize that root once so
    // retargeting its command-line/settings alias cannot redirect later reads.
    safeInstallLocation = await realpath(installLocation)
    if (localIngressIdentity) {
      if (source.source === 'directory') {
        if (safeInstallLocation !== localIngressIdentity.canonicalTarget) {
          throw new MarketplaceIngressPolicyError(
            'registered directory installLocation no longer matches the captured local identity',
          )
        }
      } else {
        const boundManifest = await realpath(
          join(
            safeInstallLocation,
            '.crabcode-plugin',
            'marketplace.json',
          ),
        ).catch(() => {
          throw new MarketplaceIngressPolicyError(
            'registered file installLocation does not contain the captured marketplace manifest',
          )
        })
        if (boundManifest !== localIngressIdentity.canonicalTarget) {
          throw new MarketplaceIngressPolicyError(
            'registered file installLocation no longer matches the captured local identity',
          )
        }
      }
    }
  } else {
    const cacheRoot = managedCacheRoot
      ? await resolveInternalPluginPath(
          dirname(managedCacheRoot),
          managedCacheRoot,
          {
            rejectSymlinks: true,
            component: 'marketplace cache root',
          },
        )
      : await resolvePluginComponentPath(
          getPluginsDirectory(),
          'marketplaces',
          { rejectSymlinks: true, component: 'marketplace cache root' },
        )
    safeInstallLocation = await resolveInternalPluginPath(
      cacheRoot,
      installLocation,
      {
        rejectSymlinks: true,
        rejectRoot: true,
        component: 'cached marketplace install location',
      },
    )
  }
  return safeInstallLocation
}

/**
 * Read a cached marketplace from disk without updating it
 *
 * @param installLocation - Path to the cached marketplace
 * @returns The marketplace object
 * @throws If marketplace file not found or invalid
 */
async function readCachedMarketplace(
  installLocation: string,
  source: MarketplaceSource,
  managedCacheRoot?: string,
  localIngressIdentity?: LocalMarketplaceIngressIdentity,
): Promise<PluginMarketplace> {
  const safeInstallLocation = await resolveSafeMarketplaceRoot(
    installLocation,
    source,
    managedCacheRoot,
    localIngressIdentity,
  )

  const finishRead = async (
    marketplace: Promise<PluginMarketplace>,
  ): Promise<PluginMarketplace> => {
    const parsed = await marketplace
    await revalidateCapturedLocalIngressSource(
      source,
      localIngressIdentity,
    )
    return parsed
  }

  const installStats = await stat(safeInstallLocation)
  if (installStats.isFile()) {
    return finishRead(
      parseFileWithSchema(
        safeInstallLocation,
        PluginMarketplaceSchema(),
        dirname(safeInstallLocation),
      ),
    )
  }
  if (!installStats.isDirectory()) {
    throw new Error(
      `Cached marketplace is not a file or directory: ${safeInstallLocation}`,
    )
  }

  // For git-sourced directories, the manifest lives at .crabcode-plugin/marketplace.json.
  // For url/file/directory sources it is the installLocation itself.
  // Try the nested path first; fall back to installLocation when it is a plain file
  // (ENOTDIR) or the nested file is simply missing (ENOENT).
  let nestedPath: string
  try {
    nestedPath = await resolvePluginComponentPath(
      safeInstallLocation,
      '.crabcode-plugin/marketplace.json',
      { component: 'marketplace manifest' },
    )
    return await finishRead(
      parseFileWithSchema(
        nestedPath,
        PluginMarketplaceSchema(),
        safeInstallLocation,
      ),
    )
  } catch (e) {
    if (e instanceof ConfigParseError) throw e
    if (e instanceof PluginPathSecurityError && e.reason === 'path-missing') {
      // Fall through to the legacy direct-file form below.
    } else {
      const code = getErrnoCode(e)
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw e
    }
  }
  return await finishRead(
    parseFileWithSchema(
      safeInstallLocation,
      PluginMarketplaceSchema(),
      safeInstallLocation,
    ),
  )
}

/**
 * Get a specific marketplace by name from cache only (no network).
 * Returns null if cache is missing or corrupted.
 * Use this for startup paths that should never block on network.
 */
export async function getMarketplaceCacheOnly(
  name: string,
): Promise<PluginMarketplace | null> {
  const fs = getFsImplementation()
  const configFile = getKnownMarketplacesFile()

  try {
    const content = await fs.readFile(configFile, { encoding: 'utf-8' })
    const config = jsonParse(content) as KnownMarketplacesConfig
    const entry = config[name]

    if (!entry) {
      return null
    }

    return await readCachedMarketplace(entry.installLocation, entry.source)
  } catch (error) {
    if (isENOENT(error)) {
      return null
    }
    logForDebugging(
      `Failed to read cached marketplace ${name}: ${errorMessage(error)}`,
      { level: 'warn' },
    )
    return null
  }
}

/**
 * Read a registered marketplace's category taxonomy from disk, cache only.
 *
 * `.crabcode-plugin/categories.json` sits beside `marketplace.json` and maps the
 * bare `category` ids on plugin entries to human names. Without it the client
 * can only synthesize a heading from the id, which is where English section
 * titles and one-plugin-name-for-a-whole-category headings came from.
 *
 * Fail-soft by construction: an absent, unreadable, malformed, or partially
 * invalid file yields `[]`, and individual bad entries are dropped rather than
 * rejecting the whole list. A broken taxonomy must cost display names only — the
 * marketplace itself still loads, and callers keep their existing fallback.
 *
 * Shares `resolveSafeMarketplaceRoot` with the manifest read, so both obey one
 * path boundary (symlink rejection, cache-root containment, local trust roots).
 */
export async function getMarketplaceCategoriesCacheOnly(
  name: string,
): Promise<MarketplaceCategory[]> {
  const fs = getFsImplementation()

  try {
    const content = await fs.readFile(getKnownMarketplacesFile(), {
      encoding: 'utf-8',
    })
    const entry = (jsonParse(content) as KnownMarketplacesConfig)[name]
    if (!entry) return []

    const safeRoot = await resolveSafeMarketplaceRoot(
      entry.installLocation,
      entry.source,
    )
    const raw = await fs.readFile(
      join(safeRoot, '.crabcode-plugin', 'categories.json'),
      { encoding: 'utf-8' },
    )

    const parsed = jsonParse(raw)
    if (!Array.isArray(parsed)) return []
    const categories: MarketplaceCategory[] = []
    const seen = new Set<string>()
    for (const candidate of parsed) {
      const result = MarketplaceCategorySchema().safeParse(candidate)
      if (!result.success) continue
      // First declaration wins, mirroring how the manifest treats duplicates.
      if (seen.has(result.data.id)) continue
      seen.add(result.data.id)
      categories.push(result.data)
    }
    return categories
  } catch (error) {
    if (!isENOENT(error)) {
      logForDebugging(
        `Failed to read categories for marketplace ${name}: ${errorMessage(error)}`,
        { level: 'warn' },
      )
    }
    return []
  }
}

/**
 * Get a specific marketplace by name
 *
 * First attempts to read from cache. Only fetches from source if:
 * - No cached version exists
 * - Cache is invalid/corrupted
 *
 * This avoids unnecessary network/git operations on every access.
 * Use refreshMarketplace() to explicitly update from source.
 *
 * @param name - The marketplace name to fetch
 * @returns The marketplace object or null if not found/failed
 */
export const getMarketplace = memoize(
  (name: string): Promise<PluginMarketplace> => getMarketplaceUncached(name),
)

async function getMarketplaceUncached(
  name: string,
): Promise<PluginMarketplace> {
  const context = captureMarketplaceCacheContext()
  for (let attempt = 0; attempt < 2; attempt++) {
    const config = await loadKnownMarketplacesConfigFromFile(
      join(context.pluginsRoot, 'known_marketplaces.json'),
    )
    const entry = config[name]

    if (!entry) {
      throw new Error(
        `Marketplace '${name}' not found in configuration. Available marketplaces: ${Object.keys(config).join(', ')}`,
      )
    }

    // Legacy entries (pre-#19708) may have relative paths in global config.
    // These are meaningless outside the project that wrote them — resolving
    // against process.cwd() produces the wrong path. Give actionable guidance
    // instead of a misleading ENOENT.
    if (
      isLocalMarketplaceSource(entry.source) &&
      !isAbsolute(entry.source.path)
    ) {
      throw new Error(
        `Marketplace "${name}" has a relative source path (${entry.source.path}) ` +
          `in known_marketplaces.json — this is stale state from an older ` +
          `CrabCode version. Run 'crabcode marketplace remove ${name}' and ` +
          `re-add it from the original project directory.`,
      )
    }

    // Try to read from disk cache
    try {
      return await readCachedMarketplace(
        entry.installLocation,
        entry.source,
        context.cacheDir,
      )
    } catch (error) {
      // Log cache corruption before re-fetching
      logForDebugging(
        `Cache corrupted or missing for marketplace ${name}, re-fetching from source: ${errorMessage(error)}`,
        {
          level: 'warn',
        },
      )
    }

    if (seedDirFor(entry.installLocation)) {
      throw new Error(
        `Seed-managed marketplace '${name}' has missing or invalid baked cache content`,
      )
    }

    if (isLocalMarketplaceSource(entry.source)) {
      let marketplace: PluginMarketplace
      try {
        ;({ marketplace } = await loadAndCacheMarketplace(entry.source))
      } catch (error) {
        throw new Error(
          `Failed to load marketplace "${name}" from source (${entry.source.source}): ${errorMessage(error)}`,
        )
      }
      const commit = await commitMarketplaceTimestampOnly(
        context,
        name,
        entry.source,
        marketplace,
      )
      if (commit.status === 'committed') return marketplace
      if (commit.status === 'missing') {
        throw new Error(`Marketplace '${name}' was removed while being loaded`)
      }
      continue
    }

    let staged: LoadedPluginMarketplace | undefined
    try {
      staged = await stageMarketplaceGenerationForExistingEntry(
        context,
        name,
        entry.source,
      )
      const commit = await commitStagedExistingMarketplace(
        context,
        name,
        entry.source,
        staged,
      )
      if (commit.status === 'committed') return staged.marketplace
      if (commit.status === 'missing') {
        throw new Error(`Marketplace '${name}' was removed while being loaded`)
      }
      // Source changed while the network generation was staging. Discard it
      // and retry once from the current authoritative source.
    } catch (error) {
      throw new Error(
        `Failed to load marketplace "${name}" from source (${entry.source.source}): ${errorMessage(error)}`,
      )
    } finally {
      await cleanupUnpublishedMarketplaceGeneration(context, staged)
    }
  }

  throw new Error(`Marketplace '${name}' changed repeatedly while being loaded`)
}

export type ResolvedMarketplacePlugin = {
  entry: PluginMarketplaceEntry
  marketplaceInstallLocation: string
  marketplaceGenerationId: string
  marketplaceContentDigest: string
}

/**
 * Marker carried by both the thrown error and the degraded loader diagnostic
 * so the failure mode stays greppable end to end.
 */
export const MARKETPLACE_CATALOG_UNAVAILABLE = 'marketplace-unavailable'

/**
 * The marketplace catalog could not be read at all: the cross-process cache
 * mutation lock or the registry transaction lock stayed contended for the
 * whole retry budget.
 *
 * This is transient infrastructure contention, never evidence about a plugin.
 * Callers must surface it as "catalog unavailable" and retry; downgrading it
 * to "plugin not found" silently drops installed plugins (and their MCP
 * servers) from the session.
 */
export class MarketplaceCatalogUnavailableError extends Error {
  readonly code = MARKETPLACE_CATALOG_UNAVAILABLE
  /** Marketplaces whose plugins could not be resolved because of this failure. */
  readonly marketplaces: readonly string[]

  constructor(marketplaces: readonly string[], sourceError: unknown) {
    super(
      `[${MARKETPLACE_CATALOG_UNAVAILABLE}] marketplace catalog could not be locked for reading: ${errorMessage(sourceError)}`,
    )
    this.name = 'MarketplaceCatalogUnavailableError'
    this.marketplaces = [...marketplaces]
  }
}

/**
 * Per-plugin outcome of a batched cache-only resolution.
 *
 * `not-found` is a real verdict about the catalog's contents (unparseable id,
 * unregistered marketplace, or a marketplace that genuinely does not list the
 * plugin). A catalog that could not be read is never reported this way — it is
 * either `marketplace-unreadable` (decided under the lock, so not contention)
 * or a thrown `MarketplaceCatalogUnavailableError`.
 */
export type MarketplacePluginResolution =
  | { status: 'resolved'; plugin: ResolvedMarketplacePlugin }
  | { status: 'not-found' }
  | { status: 'marketplace-unreadable'; marketplace: string; reason: string }

/**
 * Resolve a whole batch of `name@marketplace` ids against the cached catalogs
 * under ONE acquisition of the marketplace cache-mutation lock.
 *
 * Startup asks for every enabled plugin at once. Taking the global lock (and
 * re-reading + re-digesting each ~100 KB `marketplace.json`) once per plugin
 * turned a discovery pass into dozens of lock round-trips, which is exactly
 * the traffic that starves a second CrabCode process out of the lock.
 *
 * @throws MarketplaceCatalogUnavailableError when the lock cannot be taken.
 */
export async function resolveMarketplacePluginsCacheOnly(
  pluginIds: readonly string[],
): Promise<Map<string, MarketplacePluginResolution>> {
  const resolutions = new Map<string, MarketplacePluginResolution>()
  const requestsByMarketplace = new Map<
    string,
    Array<{ pluginId: string; pluginName: string }>
  >()

  for (const pluginId of pluginIds) {
    if (resolutions.has(pluginId)) continue
    const { name: pluginName, marketplace: marketplaceName } =
      parsePluginIdentifier(pluginId)
    if (!pluginName || !marketplaceName) {
      resolutions.set(pluginId, { status: 'not-found' })
      continue
    }
    const bucket = requestsByMarketplace.get(marketplaceName)
    const request = { pluginId, pluginName }
    if (bucket) {
      if (bucket.some((existing) => existing.pluginId === pluginId)) continue
      bucket.push(request)
    } else {
      requestsByMarketplace.set(marketplaceName, [request])
    }
  }

  // No marketplace-backed id in the batch: never pay a lock round-trip.
  if (requestsByMarketplace.size === 0) return resolutions

  const context = captureMarketplaceCacheContext()
  try {
    await withMarketplaceCacheMutationLock(
      () =>
        withKnownMarketplacesTransaction(
          async (config) => {
            let changed = false
            for (const [
              marketplaceName,
              requests,
            ] of requestsByMarketplace.entries()) {
              const marketplaceConfig = config[marketplaceName]
              if (!marketplaceConfig) {
                for (const request of requests) {
                  resolutions.set(request.pluginId, { status: 'not-found' })
                }
                continue
              }

              let marketplace: PluginMarketplace
              let contentDigest: string
              try {
                marketplace = await readCachedMarketplace(
                  marketplaceConfig.installLocation,
                  marketplaceConfig.source,
                  context.cacheDir,
                )
                contentDigest = computeMarketplaceContentDigest(marketplace)
                if (
                  marketplaceConfig.contentDigest !== undefined &&
                  marketplaceConfig.contentDigest !== contentDigest
                ) {
                  throw new Error(
                    `Marketplace '${marketplaceName}' cached content does not match its registered generation`,
                  )
                }
              } catch (error) {
                // Decided while holding the lock, so no other process was
                // mid-write: this is corruption/permission, not contention.
                // Retrying cannot help, but it is still never a statement
                // that the plugin is absent from the catalog.
                const reason = errorMessage(error)
                logForDebugging(
                  `Cached marketplace '${marketplaceName}' could not be read: ${reason}`,
                  { level: 'warn' },
                )
                for (const request of requests) {
                  resolutions.set(request.pluginId, {
                    status: 'marketplace-unreadable',
                    marketplace: marketplaceName,
                    reason,
                  })
                }
                continue
              }

              let generationId = marketplaceConfig.generationId
              let registeredDigest = marketplaceConfig.contentDigest
              if (!generationId || !registeredDigest) {
                generationId = randomUUID()
                registeredDigest = contentDigest
                marketplaceConfig.generationId = generationId
                marketplaceConfig.contentDigest = registeredDigest
                changed = true
              }

              // First entry wins, matching the previous `.find()` lookup.
              const entriesByName = new Map<string, PluginMarketplaceEntry>()
              for (const candidate of marketplace.plugins) {
                if (!entriesByName.has(candidate.name)) {
                  entriesByName.set(candidate.name, candidate)
                }
              }

              for (const request of requests) {
                const entry = entriesByName.get(request.pluginName)
                resolutions.set(
                  request.pluginId,
                  entry
                    ? {
                        status: 'resolved',
                        plugin: {
                          entry,
                          marketplaceInstallLocation:
                            marketplaceConfig.installLocation,
                          marketplaceGenerationId: generationId,
                          marketplaceContentDigest: registeredDigest,
                        },
                      }
                    : { status: 'not-found' },
                )
              }
            }
            return { value: undefined, changed }
          },
          join(context.pluginsRoot, 'known_marketplaces.json'),
        ),
      context,
    )
  } catch (error) {
    // The transaction body above is total — every per-marketplace failure is
    // recorded as a resolution. Anything escaping here is the lock/registry
    // transaction itself failing, i.e. contention.
    throw new MarketplaceCatalogUnavailableError(
      [...requestsByMarketplace.keys()],
      error,
    )
  }

  return resolutions
}

/**
 * Get plugin by ID from cache only (no network calls).
 * Returns null if marketplace cache is missing or corrupted.
 * Use this for startup paths that should never block on network.
 *
 * Single-element wrapper over `resolveMarketplacePluginsCacheOnly` so there is
 * exactly one catalog-resolution implementation. Batch callers must use the
 * batch entry point directly and honour the thrown unavailability instead of
 * collapsing it to null.
 *
 * @param pluginId - The plugin ID in format "name@marketplace"
 * @returns The plugin entry or null if not found/cache missing
 */
export async function getPluginByIdCacheOnly(
  pluginId: string,
): Promise<ResolvedMarketplacePlugin | null> {
  try {
    const resolution = (
      await resolveMarketplacePluginsCacheOnly([pluginId])
    ).get(pluginId)
    if (resolution?.status === 'resolved') return resolution.plugin
    if (resolution?.status === 'marketplace-unreadable') {
      logForDebugging(
        `Failed atomic marketplace plugin lookup for ${pluginId}: ${resolution.reason}`,
        { level: 'warn' },
      )
    }
    return null
  } catch (error) {
    logForDebugging(
      `Failed atomic marketplace plugin lookup for ${pluginId}: ${errorMessage(error)}`,
      { level: 'warn' },
    )
    return null
  }
}

/**
 * Get plugin by ID from a specific marketplace
 *
 * First tries cache-only lookup. If cache is missing/corrupted,
 * falls back to fetching from source.
 *
 * @param pluginId - The plugin ID in format "name@marketplace"
 * @returns The plugin entry or null if not found
 */
export async function getPluginById(
  pluginId: string,
): Promise<ResolvedMarketplacePlugin | null> {
  // Try cache-only first (fast path)
  const cached = await getPluginByIdCacheOnly(pluginId)
  if (cached) {
    return cached
  }

  // Cache miss - try fetching from source
  const { name: pluginName, marketplace: marketplaceName } =
    parsePluginIdentifier(pluginId)
  if (!pluginName || !marketplaceName) {
    return null
  }

  try {
    await getMarketplace(marketplaceName)
    // Do not combine a pre-fetch registry snapshot with post-fetch catalog
    // bytes. Re-enter the atomic lookup so install receives one coherent
    // generation/location/digest tuple.
    return await getPluginByIdCacheOnly(pluginId)
  } catch (error) {
    logForDebugging(
      `Could not find plugin ${pluginId}: ${errorMessage(error)}`,
      { level: 'debug' },
    )
    return null
  }
}

/**
 * Refresh all marketplace caches
 *
 * Updates all configured marketplaces from their sources.
 * Continues refreshing even if some marketplaces fail.
 * Updates lastUpdated timestamps for successful refreshes.
 *
 * This is useful for:
 * - Periodic updates to get new plugins
 * - Syncing after network connectivity is restored
 * - Ensuring caches are up-to-date before browsing
 *
 * @returns Promise that resolves when all refresh attempts complete
 */
export async function refreshAllMarketplaces(): Promise<void> {
  const config = await loadKnownMarketplacesConfig()
  for (const [name, entry] of Object.entries(config)) {
    // Seed-managed marketplaces are controlled by the seed image — refreshing
    // them is pointless (registerSeedMarketplaces overwrites on next startup).
    if (seedDirFor(entry.installLocation)) {
      logForDebugging(
        `Skipping seed-managed marketplace '${name}' in bulk refresh`,
      )
      continue
    }
    // settings-sourced marketplaces have no upstream — see refreshMarketplace.
    if (entry.source.source === 'settings') {
      continue
    }
    try {
      // Each entry stages independently without the global cache mutex, then
      // enters its own bounded cache → registry publish section.
      await refreshMarketplace(name)
    } catch (error) {
      logForDebugging(
        `Failed to refresh marketplace ${name}: ${errorMessage(error)}`,
        {
          level: 'error',
        },
      )
    }
  }
}

/**
 * Refresh a single marketplace cache
 *
 * Updates a specific marketplace by materializing a unique generation outside
 * the cache mutex, then publishing it in a short coordinated transaction.
 * Remote git sources use a fresh clone so a failed/slow refresh never mutates
 * the live checkout before validation and registry commit.
 * Clears the memoization cache and updates the lastUpdated timestamp.
 *
 * @param name - The name of the marketplace to refresh
 * @param onProgress - Optional callback to report progress
 * @throws If marketplace not found or refresh fails
 */
export type RefreshMarketplaceResult = {
  installLocation: string
}

type MarketplaceRefreshRuntimeOptions = {
  disableCredentialHelper?: boolean
  hardenedIngress?: boolean
}

function marketplaceRefreshResult(
  name: string,
  installLocation: string,
  hardenedIngress: boolean,
): RefreshMarketplaceResult {
  if (!hardenedIngress) return { installLocation }
  const safeInstallLocation =
    normalizeSafeAbsoluteMarketplaceInstallLocation(installLocation)
  if (safeInstallLocation === null) {
    throw new Error(
      `Marketplace '${name}' refresh produced an unsafe absolute installLocation`,
    )
  }
  return { installLocation: safeInstallLocation }
}

async function refreshMarketplaceInternal(
  name: string,
  onProgress?: MarketplaceProgressCallback,
  options?: MarketplaceRefreshRuntimeOptions,
): Promise<RefreshMarketplaceResult> {
  // Clear the memoization cache for this specific marketplace
  getMarketplace.cache?.delete?.(name)
  const context = captureMarketplaceCacheContext()
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const config = await loadKnownMarketplacesConfigFromFile(
        join(context.pluginsRoot, 'known_marketplaces.json'),
      )
      const entry = config[name]
      if (!entry) {
        throw new Error(
          `Marketplace '${name}' not found. Available marketplaces: ${Object.keys(config).join(', ')}`,
        )
      }

      const sourceValidation: {
        source: MarketplaceSource
        localIdentity?: LocalMarketplaceIngressIdentity
      } = options?.hardenedIngress
        ? await validateRegisteredMarketplaceSourceForIngress(entry.source)
        : { source: entry.source }
      const source = sourceValidation.source

      // settings-sourced marketplaces have no upstream. Edits surface through
      // the reconciler and add's short staged publication path.
      if (source.source === 'settings') {
        logForDebugging(
          `Skipping refresh for settings-sourced marketplace '${name}' — no upstream`,
        )
        return marketplaceRefreshResult(name, entry.installLocation, false)
      }

      const seedDir = seedDirFor(entry.installLocation)
      if (seedDir) {
        throw new Error(
          `Marketplace '${name}' is seed-managed (${seedDir}) and its content is ` +
            `controlled by the seed image. To update: ask your admin to update the seed.`,
        )
      }

      if (isLocalMarketplaceSource(source)) {
        if (
          options?.hardenedIngress &&
          normalizeSafeAbsoluteMarketplaceInstallLocation(
            entry.installLocation,
          ) === null
        ) {
          throw new Error(
            `Marketplace '${name}' has an unsafe absolute installLocation`,
          )
        }
        safeCallProgress(onProgress, 'Validating local marketplace')
        const marketplace = await readCachedMarketplace(
          entry.installLocation,
          source,
          undefined,
          sourceValidation.localIdentity,
        )
        const commit = await commitMarketplaceTimestampOnly(
          context,
          name,
          entry.source,
          marketplace,
          sourceValidation.localIdentity,
        )
        if (commit.status === 'committed') {
          logForDebugging(`Successfully refreshed marketplace: ${name}`)
          return marketplaceRefreshResult(
            name,
            commit.installLocation,
            !!options?.hardenedIngress,
          )
        }
        if (commit.status === 'missing') {
          throw new Error(`Marketplace '${name}' was removed while refreshing`)
        }
        continue
      }

      let staged: LoadedPluginMarketplace | undefined
      try {
        staged = await stageMarketplaceGenerationForExistingEntry(
          context,
          name,
          source,
          onProgress,
          options,
        )
        const commit = await commitStagedExistingMarketplace(
          context,
          name,
          entry.source,
          staged,
        )
        if (commit.status === 'committed') {
          logForDebugging(`Successfully refreshed marketplace: ${name}`)
          return marketplaceRefreshResult(
            name,
            commit.installLocation,
            !!options?.hardenedIngress,
          )
        }
        if (commit.status === 'missing') {
          throw new Error(`Marketplace '${name}' was removed while refreshing`)
        }
        // Stale source: cleanup in finally, then retry the latest source once.
      } finally {
        await cleanupUnpublishedMarketplaceGeneration(context, staged)
      }
    }
    throw new Error(`Marketplace '${name}' changed repeatedly while refreshing`)
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    logForDebugging(`Failed to refresh marketplace ${name}: ${errorMessage}`, {
      level: 'error',
    })
    throw new Error(`Failed to refresh marketplace '${name}': ${errorMessage}`)
  }
}

/**
 * Global CLI/TUI refresh behavior. This intentionally retains legacy source,
 * credential, proxy, redirect, and official-mirror semantics.
 */
export async function refreshMarketplace(
  name: string,
  onProgress?: MarketplaceProgressCallback,
  options?: { disableCredentialHelper?: boolean },
): Promise<void> {
  await refreshMarketplaceInternal(name, onProgress, options)
}

/**
 * remote ingress-only refresh boundary. The authoritative registry source is
 * revalidated on every retry, all network transports are hardened, and the
 * installLocation comes directly from the same coordinated registry commit.
 */
export async function refreshMarketplaceFromIngress(
  name: string,
): Promise<RefreshMarketplaceResult> {
  return refreshMarketplaceInternal(name, undefined, {
    hardenedIngress: true,
  })
}

/**
 * Set the autoUpdate flag for a marketplace
 *
 * When autoUpdate is enabled, the marketplace and its installed plugins
 * will be automatically updated on startup.
 *
 * @param name - The name of the marketplace to update
 * @param autoUpdate - Whether to enable auto-update
 * @throws If marketplace not found
 */
export async function setMarketplaceAutoUpdate(
  name: string,
  autoUpdate: boolean,
): Promise<void> {
  const changed = await withKnownMarketplacesTransaction(async (config) => {
    const entry = config[name]
    if (!entry) {
      throw new Error(
        `Marketplace '${name}' not found. Available marketplaces: ${Object.keys(config).join(', ')}`,
      )
    }

    // Seed-managed marketplaces always have autoUpdate: false (read-only,
    // git-pull would fail). Error instead of silently reverting on restart.
    const seedDir = seedDirFor(entry.installLocation)
    if (seedDir) {
      throw new Error(
        `Marketplace '${name}' is seed-managed (${seedDir}) and ` +
          `auto-update is always disabled for seed content. ` +
          `To update: ask your admin to update the seed.`,
      )
    }

    if (entry.autoUpdate === autoUpdate) {
      return { value: false, changed: false }
    }
    config[name] = { ...entry, autoUpdate }
    return { value: true, changed: true }
  })

  if (!changed) return

  // Also update intent in settings if declared there — write to the SAME
  // source that declared it to avoid creating duplicates at wrong scope
  const declaringSource = getMarketplaceDeclaringSource(name)
  if (declaringSource) {
    const declared =
      getSettingsForSource(declaringSource)?.extraKnownMarketplaces?.[name]
    if (declared) {
      saveMarketplaceToSettings(
        name,
        { source: declared.source, autoUpdate },
        declaringSource,
      )
    }
  }

  logForDebugging(`Set autoUpdate=${autoUpdate} for marketplace: ${name}`)
}

export const _test = {
  redactUrlCredentials,
}
