/**
 * Marketplace plugin loading pipeline.
 *
 * Handles discovery, enterprise policy checks, and loading of plugins
 * from marketplace entries. Supports both full (network) and cache-only modes.
 */

import { join, resolve } from 'path'
import { getOriginalCwd } from '../../../bootstrap/state.js'
import type {
  LoadedPlugin,
  PluginError,
  PluginManifest,
} from '../../../types/plugin.js'
import { logForDebugging } from '../../debug.js'
import { toError } from '../../errors.js'
import { logError } from '../../log.js'
import { getSettings_DEPRECATED } from '../../settings/settings.js'
import type { HooksSettings } from '../../settings/types.js'
import { getAddDirEnabledPlugins } from '../addDirPluginSettings.js'
import { resolveEffectivePluginInstallation } from '../effectiveInstallation.js'
import {
  getInMemoryInstalledPlugins,
  resolveInstalledPluginCachePath,
} from '../installedPluginsManager.js'
import {
  formatSourceForDisplay,
  getBlockedMarketplaces,
  getStrictKnownMarketplaces,
  isSourceAllowedByPolicy,
  isSourceInBlocklist,
} from '../marketplaceHelpers.js'
import {
  loadKnownMarketplacesConfigSafe,
  resolveMarketplacePluginsCacheOnly,
} from '../marketplaceManager.js'
import { parsePluginIdentifier } from '../pluginIdentifier.js'
import {
  PluginPathSecurityError,
  resolvePluginComponentPath,
} from '../pluginPathSecurity.js'
import {
  type CommandMetadata,
  PluginIdSchema,
  type PluginMarketplaceEntry,
} from '../schemas.js'
import {
  extractZipToDirectory,
  getSessionPluginCachePath,
  isPluginZipCacheEnabled,
} from '../zipCache.js'
import { BUILTIN_MARKETPLACE_NAME } from '../../../plugins/builtinPlugins.js'
import {
  createPluginFromPath,
  recordPluginComponentPathFailure,
  validatePluginPaths,
} from './createPlugin.js'

/**
 * Shared discovery/policy/merge pipeline for both load modes.
 *
 * Resolves enabledPlugins -> marketplace entries, runs enterprise policy
 * checks, pre-loads catalogs, then dispatches each entry to the full or
 * cache-only per-entry loader.
 */
export async function loadPluginsFromMarketplaces({
  cacheOnly,
  targetCwd,
}: {
  cacheOnly: boolean
  /**
   * Wave D (R2 根修)：以哪个 cwd 判 project/local 安装记录的相关性。
   * 缺省 = 进程 cwd（`getOriginalCwd()`），即 TUI/既有行为；worker 的
   * skills/list 按请求 cwds[0] 透传，让插件聚合按目标工作区作答。
   */
  targetCwd?: string
}): Promise<{
  plugins: LoadedPlugin[]
  errors: PluginError[]
}> {
  // The public mode remains part of the startup API, but both modes now obey
  // the same no-write contract. Recovery/materialization happens before load.
  void cacheOnly
  const settings = getSettings_DEPRECATED()
  // Merge --add-dir plugins at lowest priority; standard settings win on conflict
  const enabledPlugins = {
    ...getAddDirEnabledPlugins(),
    ...(settings.enabledPlugins || {}),
  }
  const plugins: LoadedPlugin[] = []
  const errors: PluginError[] = []

  // Filter to plugin@marketplace format and validate
  const marketplacePluginEntries = Object.entries(enabledPlugins).filter(
    ([key, value]) => {
      const isValidFormat = PluginIdSchema().safeParse(key).success
      if (!isValidFormat || value === undefined) return false
      const { marketplace } = parsePluginIdentifier(key)
      return marketplace !== BUILTIN_MARKETPLACE_NAME
    },
  )

  // Load known marketplaces config to look up sources for policy checking.
  const knownMarketplaces = await loadKnownMarketplacesConfigSafe()

  // Fail-closed guard for enterprise policy
  const strictAllowlist = getStrictKnownMarketplaces()
  const blocklist = getBlockedMarketplaces()
  const hasEnterprisePolicy =
    strictAllowlist !== null || (blocklist !== null && blocklist.length > 0)

  // Look up installed versions once
  const installedPluginsData = getInMemoryInstalledPlugins()

  // Enterprise policy is decided before any catalog read so blocked ids never
  // reach the marketplace lock at all.
  const admitted: Array<[string, unknown]> = []
  for (const [pluginId, enabledValue] of marketplacePluginEntries) {
    const { name: pluginName, marketplace: marketplaceName } =
      parsePluginIdentifier(pluginId)

    const marketplaceConfig = knownMarketplaces[marketplaceName!]

    // Fail-closed: enterprise policy active but can't verify source
    if (!marketplaceConfig && hasEnterprisePolicy) {
      errors.push({
        type: 'marketplace-blocked-by-policy',
        source: pluginId,
        plugin: pluginName,
        marketplace: marketplaceName!,
        blockedByBlocklist: strictAllowlist === null,
        allowedSources: (strictAllowlist ?? []).map((s) =>
          formatSourceForDisplay(s),
        ),
      })
      continue
    }

    if (
      marketplaceConfig &&
      !isSourceAllowedByPolicy(marketplaceConfig.source)
    ) {
      const isBlocked = isSourceInBlocklist(marketplaceConfig.source)
      const allowlist = getStrictKnownMarketplaces() || []
      errors.push({
        type: 'marketplace-blocked-by-policy',
        source: pluginId,
        plugin: pluginName,
        marketplace: marketplaceName!,
        blockedByBlocklist: isBlocked,
        allowedSources: isBlocked
          ? []
          : allowlist.map((s) => formatSourceForDisplay(s)),
      })
      continue
    }

    admitted.push([pluginId, enabledValue])
  }

  // Installation identity must come from one registry-locked catalog read.
  // Never combine the preloaded catalog with a separately loaded registry
  // entry: refresh can change generation/location between those snapshots.
  //
  // The whole batch resolves under a single lock acquisition. A contended
  // lock throws MarketplaceCatalogUnavailableError, which deliberately
  // propagates: the caller retries the pass rather than publishing a catalog
  // with the unresolved plugins silently missing.
  const resolutions = await resolveMarketplacePluginsCacheOnly(
    admitted.map(([pluginId]) => pluginId),
  )

  // Load all marketplace plugins in parallel for faster startup
  const results = await Promise.allSettled(
    admitted.map(async ([pluginId, enabledValue]) => {
      const { name: pluginName, marketplace: marketplaceName } =
        parsePluginIdentifier(pluginId)
      const resolution = resolutions.get(pluginId)

      if (resolution?.status === 'marketplace-unreadable') {
        errors.push({
          type: 'marketplace-load-failed',
          source: pluginId,
          marketplace: resolution.marketplace,
          reason: resolution.reason,
        })
        return null
      }

      if (resolution?.status !== 'resolved') {
        errors.push({
          type: 'plugin-not-found',
          source: pluginId,
          pluginId: pluginName!,
          marketplace: marketplaceName!,
        })
        return null
      }

      // Wave D：生效安装记录选择收敛到统一 resolver（local > project >
      // user > managed，前两者精确 cwd 匹配 —— 不做祖先目录匹配）。
      // resolver 内部对两侧 resolve，这里传原始 targetCwd 即可。
      const installEntry = resolveEffectivePluginInstallation(
        pluginId,
        targetCwd ?? getOriginalCwd(),
        installedPluginsData,
      )

      // Both loader modes consume only the exact path committed in the
      // installed registry. Network/materialization recovery belongs to the
      // coordinated startup/install path; loading must never create or
      // overwrite deterministic cache paths as a side effect.
      return loadPluginFromMarketplaceEntryCacheOnly(
        resolution.plugin.entry,
        pluginId,
        enabledValue === true,
        errors,
        installEntry?.installPath,
      )
    }),
  )

  for (const [i, result] of results.entries()) {
    if (result.status === 'fulfilled' && result.value) {
      plugins.push(result.value)
    } else if (result.status === 'rejected') {
      const err = toError(result.reason)
      logError(err)
      const pluginId = admitted[i]![0]
      errors.push({
        type: 'generic-error',
        source: pluginId,
        plugin: pluginId.split('@')[0],
        error: err.message,
      })
    }
  }

  return { plugins, errors }
}

/**
 * Cache-only variant of loadPluginFromMarketplaceEntry.
 *
 * Performs no network or disk-copy work. Reads directly from the recorded
 * installPath; if missing, emits 'plugin-cache-miss'.
 */
async function loadPluginFromMarketplaceEntryCacheOnly(
  entry: PluginMarketplaceEntry,
  pluginId: string,
  enabled: boolean,
  errorsOut: PluginError[],
  installPath: string | undefined,
): Promise<LoadedPlugin | null> {
  if (!installPath) {
    errorsOut.push({
      type: 'plugin-cache-miss',
      source: pluginId,
      plugin: entry.name,
      installPath: '(not recorded)',
    })
    return null
  }
  let pluginPath: string
  try {
    pluginPath = await resolveInstalledPluginCachePath(installPath)
  } catch {
    errorsOut.push({
      type: 'plugin-cache-miss',
      source: pluginId,
      plugin: entry.name,
      installPath,
    })
    return null
  }

  // Zip cache extraction
  if (isPluginZipCacheEnabled() && pluginPath.endsWith('.zip')) {
    const sessionDir = await getSessionPluginCachePath()
    const extractDir = join(
      sessionDir,
      pluginId.replace(/[^a-zA-Z0-9@\-_]/g, '-'),
    )
    try {
      await extractZipToDirectory(pluginPath, extractDir, sessionDir)
      pluginPath = extractDir
    } catch (error) {
      logForDebugging(`Failed to extract plugin ZIP ${pluginPath}: ${error}`, {
        level: 'error',
      })
      errorsOut.push({
        type: 'plugin-cache-miss',
        source: pluginId,
        plugin: entry.name,
        installPath: pluginPath,
      })
      return null
    }
  }

  return finishLoadingPluginFromPath(
    entry,
    pluginId,
    enabled,
    errorsOut,
    pluginPath,
  )
}

/**
 * Shared tail of both loadPluginFromMarketplaceEntry variants.
 *
 * Once pluginPath is resolved (via clone, cache, or installPath lookup),
 * the rest of the load -- manifest probe, createPluginFromPath, marketplace
 * entry supplementation -- is identical.
 */
async function finishLoadingPluginFromPath(
  entry: PluginMarketplaceEntry,
  pluginId: string,
  enabled: boolean,
  errorsOut: PluginError[],
  pluginPath: string,
): Promise<LoadedPlugin | null> {
  const errors: PluginError[] = []

  let hasManifest = false
  try {
    await resolvePluginComponentPath(
      pluginPath,
      '.crabcode-plugin/plugin.json',
      { component: 'plugin manifest' },
    )
    hasManifest = true
  } catch (error) {
    if (
      !(error instanceof PluginPathSecurityError) ||
      error.reason !== 'path-missing'
    ) {
      throw error
    }
  }

  const { plugin, errors: pluginErrors } = await createPluginFromPath(
    pluginPath,
    pluginId,
    enabled,
    entry.name,
    entry.strict ?? true,
  )
  errors.push(...pluginErrors)

  // Set sha from source if available
  if (
    typeof entry.source === 'object' &&
    'sha' in entry.source &&
    entry.source.sha
  ) {
    plugin.sha = entry.source.sha
  }

  // If there's no plugin.json, use marketplace entry as manifest
  if (!hasManifest) {
    plugin.manifest = {
      ...entry,
      id: undefined,
      source: undefined,
      strict: undefined,
    } as PluginManifest
    plugin.name = plugin.manifest.name

    // Process commands from marketplace entry
    if (entry.commands) {
      const firstValue = Object.values(entry.commands)[0]
      if (
        typeof entry.commands === 'object' &&
        !Array.isArray(entry.commands) &&
        firstValue &&
        typeof firstValue === 'object' &&
        ('source' in firstValue || 'content' in firstValue)
      ) {
        // Object mapping format
        const commandsMetadata: Record<string, CommandMetadata> = {}
        const validPaths: string[] = []

        const entries = Object.entries(entry.commands)
        const checks = await Promise.all(
          entries.map(async ([commandName, metadata]) => {
            if (!metadata || typeof metadata !== 'object' || !metadata.source) {
              return { commandName, metadata, skip: true as const }
            }
            try {
              const fullPath = await resolvePluginComponentPath(
                pluginPath,
                metadata.source,
                { component: 'commands' },
              )
              return {
                commandName,
                metadata,
                skip: false as const,
                fullPath,
                error: undefined,
              }
            } catch (error) {
              return {
                commandName,
                metadata,
                skip: false as const,
                fullPath: resolve(pluginPath, metadata.source),
                error,
              }
            }
          }),
        )
        for (const check of checks) {
          if (check.skip) continue
          if (!check.error) {
            validPaths.push(check.fullPath)
            commandsMetadata[check.commandName] = check.metadata
          } else {
            recordPluginComponentPathFailure(errors, check.error, {
              pluginPath,
              requestedPath: check.metadata.source!,
              pluginName: entry.name,
              source: pluginId,
              component: 'commands',
            })
          }
        }

        if (validPaths.length > 0) {
          plugin.commandsPaths = validPaths
          plugin.commandsMetadata = commandsMetadata
        }
      } else {
        const commandPaths = Array.isArray(entry.commands)
          ? entry.commands
          : [entry.commands]

        const stringCommandPaths = commandPaths.filter(
          (cmdPath): cmdPath is string => {
            if (typeof cmdPath === 'string') return true
            logForDebugging(
              `Unexpected command format in marketplace entry for ${entry.name}`,
              { level: 'error' },
            )
            return false
          },
        )
        const validPaths = await validatePluginPaths(
          stringCommandPaths,
          pluginPath,
          entry.name,
          pluginId,
          'commands',
          'Command',
          'from marketplace entry',
          errors,
        )

        if (validPaths.length > 0) {
          plugin.commandsPaths = validPaths
        }
      }
    }

    // Process agents from marketplace entry
    if (entry.agents) {
      const agentPaths = Array.isArray(entry.agents)
        ? entry.agents
        : [entry.agents]

      const validPaths = await validatePluginPaths(
        agentPaths,
        pluginPath,
        entry.name,
        pluginId,
        'agents',
        'Agent',
        'from marketplace entry',
        errors,
      )

      if (validPaths.length > 0) {
        plugin.agentsPaths = validPaths
      }
    }

    // Process skills from marketplace entry
    if (entry.skills) {
      logForDebugging(
        `Processing ${Array.isArray(entry.skills) ? entry.skills.length : 1} skill paths for plugin ${entry.name}`,
      )
      const skillPaths = Array.isArray(entry.skills)
        ? entry.skills
        : [entry.skills]

      const validPaths = await validatePluginPaths(
        skillPaths,
        pluginPath,
        entry.name,
        pluginId,
        'skills',
        'Skill',
        'from marketplace entry',
        errors,
      )

      logForDebugging(
        `Found ${validPaths.length} valid skill paths for plugin ${entry.name}, setting skillsPaths`,
      )
      if (validPaths.length > 0) {
        plugin.skillsPaths = validPaths
      }
    } else {
      logForDebugging(`Plugin ${entry.name} has no entry.skills defined`)
    }

    // Process output styles from marketplace entry
    if (entry.outputStyles) {
      const outputStylePaths = Array.isArray(entry.outputStyles)
        ? entry.outputStyles
        : [entry.outputStyles]

      const validPaths = await validatePluginPaths(
        outputStylePaths,
        pluginPath,
        entry.name,
        pluginId,
        'output-styles',
        'Output style',
        'from marketplace entry',
        errors,
      )

      if (validPaths.length > 0) {
        plugin.outputStylesPaths = validPaths
      }
    }

    // Process inline hooks from marketplace entry
    if (entry.hooks) {
      plugin.hooksConfig = entry.hooks as HooksSettings
    }
  } else if (
    !entry.strict &&
    hasManifest &&
    (entry.commands ||
      entry.agents ||
      entry.skills ||
      entry.hooks ||
      entry.outputStyles)
  ) {
    // In non-strict mode with plugin.json, marketplace entries are conflicts
    const error = new Error(
      `Plugin ${entry.name} has both plugin.json and marketplace manifest entries for commands/agents/skills/hooks/outputStyles. This is a conflict.`,
    )
    logForDebugging(
      `Plugin ${entry.name} has both plugin.json and marketplace manifest entries for commands/agents/skills/hooks/outputStyles. This is a conflict.`,
      { level: 'error' },
    )
    logError(error)
    errorsOut.push({
      type: 'generic-error',
      source: pluginId,
      error: `Plugin ${entry.name} has conflicting manifests: both plugin.json and marketplace entry specify components. Set strict: true in marketplace entry or remove component specs from one location.`,
    })
    return null
  } else if (hasManifest) {
    // Has plugin.json - marketplace can supplement commands/agents/skills/hooks/outputStyles

    // Supplement commands from marketplace entry
    if (entry.commands) {
      const firstValue = Object.values(entry.commands)[0]
      if (
        typeof entry.commands === 'object' &&
        !Array.isArray(entry.commands) &&
        firstValue &&
        typeof firstValue === 'object' &&
        ('source' in firstValue || 'content' in firstValue)
      ) {
        // Object mapping format - merge metadata
        const commandsMetadata: Record<string, CommandMetadata> = {
          ...(plugin.commandsMetadata || {}),
        }
        const validPaths: string[] = []

        const entries = Object.entries(entry.commands)
        const checks = await Promise.all(
          entries.map(async ([commandName, metadata]) => {
            if (!metadata || typeof metadata !== 'object' || !metadata.source) {
              return { commandName, metadata, skip: true as const }
            }
            try {
              const fullPath = await resolvePluginComponentPath(
                pluginPath,
                metadata.source,
                { component: 'commands' },
              )
              return {
                commandName,
                metadata,
                skip: false as const,
                fullPath,
                error: undefined,
              }
            } catch (error) {
              return {
                commandName,
                metadata,
                skip: false as const,
                fullPath: resolve(pluginPath, metadata.source),
                error,
              }
            }
          }),
        )
        for (const check of checks) {
          if (check.skip) continue
          if (!check.error) {
            validPaths.push(check.fullPath)
            commandsMetadata[check.commandName] = check.metadata
          } else {
            recordPluginComponentPathFailure(errors, check.error, {
              pluginPath,
              requestedPath: check.metadata.source!,
              pluginName: entry.name,
              source: pluginId,
              component: 'commands',
            })
          }
        }

        if (validPaths.length > 0) {
          plugin.commandsPaths = [
            ...(plugin.commandsPaths || []),
            ...validPaths,
          ]
          plugin.commandsMetadata = commandsMetadata
        }
      } else {
        const commandPaths = Array.isArray(entry.commands)
          ? entry.commands
          : [entry.commands]

        const stringCommandPaths = commandPaths.filter(
          (cmdPath): cmdPath is string => {
            if (typeof cmdPath === 'string') return true
            logForDebugging(
              `Unexpected command format in marketplace entry for ${entry.name}`,
              { level: 'error' },
            )
            return false
          },
        )
        const validPaths = await validatePluginPaths(
          stringCommandPaths,
          pluginPath,
          entry.name,
          pluginId,
          'commands',
          'Command',
          'from marketplace entry',
          errors,
        )

        if (validPaths.length > 0) {
          plugin.commandsPaths = [
            ...(plugin.commandsPaths || []),
            ...validPaths,
          ]
        }
      }
    }

    // Supplement agents from marketplace entry
    if (entry.agents) {
      const agentPaths = Array.isArray(entry.agents)
        ? entry.agents
        : [entry.agents]

      const validPaths = await validatePluginPaths(
        agentPaths,
        pluginPath,
        entry.name,
        pluginId,
        'agents',
        'Agent',
        'from marketplace entry',
        errors,
      )

      if (validPaths.length > 0) {
        plugin.agentsPaths = [...(plugin.agentsPaths || []), ...validPaths]
      }
    }

    // Supplement skills from marketplace entry
    if (entry.skills) {
      const skillPaths = Array.isArray(entry.skills)
        ? entry.skills
        : [entry.skills]

      const validPaths = await validatePluginPaths(
        skillPaths,
        pluginPath,
        entry.name,
        pluginId,
        'skills',
        'Skill',
        'from marketplace entry',
        errors,
      )

      if (validPaths.length > 0) {
        plugin.skillsPaths = [...(plugin.skillsPaths || []), ...validPaths]
      }
    }

    // Supplement output styles from marketplace entry
    if (entry.outputStyles) {
      const outputStylePaths = Array.isArray(entry.outputStyles)
        ? entry.outputStyles
        : [entry.outputStyles]

      const validPaths = await validatePluginPaths(
        outputStylePaths,
        pluginPath,
        entry.name,
        pluginId,
        'output-styles',
        'Output style',
        'from marketplace entry',
        errors,
      )

      if (validPaths.length > 0) {
        plugin.outputStylesPaths = [
          ...(plugin.outputStylesPaths || []),
          ...validPaths,
        ]
      }
    }

    // Supplement hooks from marketplace entry
    if (entry.hooks) {
      plugin.hooksConfig = {
        ...(plugin.hooksConfig || {}),
        ...(entry.hooks as HooksSettings),
      }
    }
  }

  errorsOut.push(...errors)
  return plugin
}
