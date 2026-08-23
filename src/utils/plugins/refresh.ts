/**
 * Layer-3 refresh primitive: swap active plugin components in the running session.
 *
 * Three-layer model (see reconciler.ts for Layer-2):
 * - Layer 1: intent (settings)
 * - Layer 2: materialization (~/.crabcode/plugins/) — reconcileMarketplaces()
 * - Layer 3: active components (AppState) — this file
 *
 * Called from:
 * - /reload-plugins command (interactive, user-initiated)
 * - print.ts refreshPluginState() (headless, auto before first query with SYNC_PLUGIN_INSTALL)
 * - performBackgroundPluginInstallations() (background, auto after new marketplace install)
 *
 * NOT called from:
 * - useManagePlugins needsRefresh effect — interactive mode shows a notification;
 *   user explicitly runs /reload-plugins (PR 5c)
 * - /plugin menu — sets needsRefresh, user runs /reload-plugins (PR 5b)
 */

import { join } from 'path'
import {
  getAdditionalDirectoriesForCrabcodeMd,
  getOriginalCwd,
} from '../../bootstrap/state.js'
import type { Command } from '../../types/command.js'
import { reinitializeLspServerManager } from '../../services/lsp/manager.js'
import { getSettingsPath as getRemoteManagedSettingsCachePath } from '../../services/remoteManagedSettings/syncCacheState.js'
import type { AppState } from '../../state/AppState.js'
import type { AgentDefinitionsResult } from '../../tools/AgentTool/loadAgentsDir.js'
import { getAgentDefinitionsWithOverrides } from '../../tools/AgentTool/loadAgentsDir.js'
import type { LoadedPlugin, PluginError } from '../../types/plugin.js'
import { logForDebugging } from '../debug.js'
import { errorMessage } from '../errors.js'
import { getFsImplementation } from '../fsOperations.js'
import { logError } from '../log.js'
import { SETTING_SOURCES } from '../settings/constants.js'
import { getSettingsFilePathForSource } from '../settings/settings.js'
import { clearAllCaches } from './cacheUtils.js'
import { getPluginCommands } from './loadPluginCommands.js'
import { loadPluginHooks } from './loadPluginHooks.js'
import { loadPluginLspServers } from './lspPluginIntegration.js'
import { loadPluginMcpServers } from './mcpPluginIntegration.js'
import { clearPluginCacheExclusions } from './orphanedPluginFilter.js'
import { getPluginsDirectory } from './pluginDirectories.js'
import { loadAllPlugins } from './pluginLoader.js'

type SetAppState = (updater: (prev: AppState) => AppState) => void

export type RefreshActivePluginsResult = {
  enabled_count: number
  disabled_count: number
  command_count: number
  agent_count: number
  hook_count: number
  mcp_count: number
  /** LSP servers provided by enabled plugins. reinitializeLspServerManager()
   * is called unconditionally so the manager picks these up (no-op if
   * manager was never initialized). */
  lsp_count: number
  error_count: number
  /** The refreshed agent definitions, for callers (e.g. print.ts) that also
   * maintain a local mutable reference outside AppState. */
  agentDefinitions: AgentDefinitionsResult
  /** The refreshed plugin commands, same rationale as agentDefinitions. */
  pluginCommands: Command[]
}

/**
 * Number of plugins processed between event-loop yields during the plugin
 * traversals below.
 *
 * Discovery is synchronous filesystem work (see the audit's §5 rejection of an
 * async-FS rewrite: on Windows the async APIs go through the same filter-driver
 * stack, so the per-call cost is unchanged). What the single JS thread CAN do is
 * come up for air: yielding every N plugins lets queued user input be processed
 * while a refresh that really is required runs to completion.
 */
export const PLUGIN_TRAVERSAL_YIELD_INTERVAL = 8

function yieldToEventLoop(): Promise<void> {
  return new Promise<void>(resolve => {
    setImmediate(resolve)
  })
}

/**
 * Map over plugins sequentially, yielding the event loop once per
 * {@link PLUGIN_TRAVERSAL_YIELD_INTERVAL} plugins.
 *
 * The yield happens BEFORE continuing past a full batch, so a traversal of n
 * plugins yields floor((n - 1) / interval) times and never yields after the
 * last plugin (that yield would buy nothing — the caller is about to await).
 *
 * `yieldTo` is injectable for tests only; production always uses setImmediate.
 */
export async function mapPluginsYieldingToEventLoop<Item, Result>(
  items: readonly Item[],
  fn: (item: Item, index: number) => Promise<Result> | Result,
  yieldTo: () => Promise<void> = yieldToEventLoop,
): Promise<Result[]> {
  const results: Result[] = []
  for (const [index, item] of items.entries()) {
    if (index > 0 && index % PLUGIN_TRAVERSAL_YIELD_INTERVAL === 0) {
      await yieldTo()
    }
    results.push(await fn(item, index))
  }
  return results
}

/**
 * Files whose (mtimeMs, size) decide whether plugin discovery has anything new
 * to find. Deliberately reuses metadata files that already exist — no new state
 * file, no new in-process cache layer (both rejected in the audit's §5).
 *
 * - installed_plugins.json / known_marketplaces.json: the materialization layer
 * - every settings.json layer that feeds the merged `enabledPlugins` intent,
 *   including --add-dir layers and the remote-managed-settings cache file
 *   (written before waitForRemoteManagedSettingsToLoad() resolves, which is the
 *   "loadAllPlugins ran before managed settings arrived" case that made the
 *   second pass unconditional in the first place)
 */
function pluginDiscoveryInputFiles(): string[] {
  const pluginsDirectory = getPluginsDirectory()
  const files = [
    join(pluginsDirectory, 'installed_plugins.json'),
    join(pluginsDirectory, 'known_marketplaces.json'),
    getRemoteManagedSettingsCachePath(),
  ]
  for (const source of SETTING_SOURCES) {
    const path = getSettingsFilePathForSource(source)
    if (path) files.push(path)
  }
  for (const dir of getAdditionalDirectoriesForCrabcodeMd()) {
    files.push(join(dir, '.crabcode', 'settings.json'))
    files.push(join(dir, '.crabcode', 'settings.local.json'))
  }
  return files
}

/** Missing files get a definite stamp rather than an exception. */
function fileStamp(path: string): string {
  try {
    const stats = getFsImplementation().statSync(path)
    return `${stats.mtimeMs}:${stats.size}`
  } catch {
    return 'missing'
  }
}

let unavailableFingerprintCounter = 0

/**
 * Stringified (mtimeMs, size) of every plugin discovery input.
 *
 * Never throws: if the input set itself cannot be enumerated the result is a
 * value that can never equal a previously recorded one, so the caller falls
 * back to refreshing.
 */
export function computePluginDiscoveryFingerprint(): string {
  try {
    return pluginDiscoveryInputFiles()
      .map(path => `${path}=${fileStamp(path)}`)
      .join('|')
  } catch (e) {
    unavailableFingerprintCounter += 1
    logForDebugging(
      `computePluginDiscoveryFingerprint: input enumeration failed: ${errorMessage(e)}`,
    )
    return `unavailable:${unavailableFingerprintCounter}`
  }
}

let recordedDiscoveryFingerprint: string | null = null

/**
 * Baseline the discovery inputs for the plugin state that is currently loaded.
 *
 * Called at headless startup (before anything can write to those files) and at
 * the end of every full refresh. Recording EARLIER than the discovery pass that
 * it describes is the safe direction: a write in between changes the
 * fingerprint and forces the refresh.
 */
export function recordPluginDiscoveryFingerprint(
  fingerprint: string = computePluginDiscoveryFingerprint(),
): string {
  recordedDiscoveryFingerprint = fingerprint
  return fingerprint
}

/**
 * True when a refresh could actually find something new. Also true when no
 * baseline was ever recorded — an unknown baseline must never suppress work.
 */
export function hasPluginDiscoveryInputChanged(): boolean {
  if (recordedDiscoveryFingerprint === null) return true
  return computePluginDiscoveryFingerprint() !== recordedDiscoveryFingerprint
}

/** Test-only: drop the recorded baseline. */
export function clearRecordedPluginDiscoveryFingerprintForTesting(): void {
  recordedDiscoveryFingerprint = null
}

/**
 * refreshActivePlugins(), but only when the discovery inputs changed since the
 * baseline recorded at startup / by the previous full refresh.
 *
 * Returns null when the refresh was skipped: no clearAllCaches(), no second
 * full filesystem discovery pass, and — because callers key their own work off
 * a non-null result — no second command-catalog publish either.
 *
 * Only for callers that can prove a first discovery pass already ran (headless
 * background install). The sync-install path skips the startup prefetch
 * entirely, so its refresh is the FIRST pass and must never be suppressed.
 */
export async function refreshActivePluginsIfDiscoveryChanged(
  setAppState: SetAppState,
): Promise<RefreshActivePluginsResult | null> {
  if (!hasPluginDiscoveryInputChanged()) {
    logForDebugging(
      'refreshActivePlugins: plugin discovery inputs unchanged since startup, skipping full rescan',
    )
    return null
  }
  return await refreshActivePlugins(setAppState)
}

/**
 * Refresh all active plugin components: commands, agents, hooks, MCP-reconnect
 * trigger, AppState plugin arrays. Clears ALL plugin caches (unlike the old
 * needsRefresh path which only cleared loadAllPlugins and returned stale data
 * from downstream memoized loaders).
 *
 * Consumes plugins.needsRefresh (sets to false).
 * Increments mcp.pluginReconnectKey so useManageMCPConnections effects re-run
 * and pick up new plugin MCP servers.
 *
 * LSP: if plugins now contribute LSP servers, reinitializeLspServerManager()
 * re-reads config. Servers are lazy-started so this is just config parsing.
 */
export async function refreshActivePlugins(
  setAppState: SetAppState,
): Promise<RefreshActivePluginsResult> {
  // Sampled BEFORE the sweep: anything written to a discovery input while this
  // pass is running is then still "unseen" for the next comparison.
  const fingerprintAtStart = computePluginDiscoveryFingerprint()
  logForDebugging('refreshActivePlugins: clearing all plugin caches')
  clearAllCaches()
  // Orphan exclusions are session-frozen by default, but /reload-plugins is
  // an explicit "disk changed, re-read it" signal — recompute them too.
  clearPluginCacheExclusions()

  // Sequence the full load before cache-only consumers. Before #23693 all
  // three shared loadAllPlugins()'s memoize promise so Promise.all was a
  // no-op race. After #23693 getPluginCommands/getAgentDefinitions call
  // loadAllPluginsCacheOnly (separate memoize) — racing them means they
  // read installed_plugins.json before loadAllPlugins() has cloned+cached
  // the plugin, returning plugin-cache-miss. loadAllPlugins warms the
  // cache-only memoize on completion, so the awaits below are ~free.
  const pluginResult = await loadAllPlugins()
  const [pluginCommands, agentDefinitions] = await Promise.all([
    getPluginCommands(),
    getAgentDefinitionsWithOverrides(getOriginalCwd()),
  ])

  const { enabled, disabled, errors } = pluginResult

  // Populate mcpServers/lspServers on each enabled plugin. These are lazy
  // cache slots NOT filled by loadAllPlugins() — they're written later by
  // extractMcpServersFromPlugins/getPluginLspServers, which races with this.
  // Loading here gives accurate metrics AND warms the cache slots so the MCP
  // connection manager (triggered by pluginReconnectKey bump) sees the servers
  // without re-parsing manifests. Errors are pushed to the shared errors array.
  //
  // Traversed with mapPluginsYieldingToEventLoop instead of Promise.all: the
  // manifest reads underneath are synchronous filesystem work, so the "parallel"
  // map never overlapped anything — it only denied the event loop any chance to
  // run queued user input until all plugins were done.
  const mcpCounts = await mapPluginsYieldingToEventLoop<LoadedPlugin, number>(
    enabled,
    async p => {
      if (p.mcpServers) return Object.keys(p.mcpServers).length
      const servers = await loadPluginMcpServers(p, errors)
      if (servers) p.mcpServers = servers
      return servers ? Object.keys(servers).length : 0
    },
  )
  const lspCounts = await mapPluginsYieldingToEventLoop<LoadedPlugin, number>(
    enabled,
    async p => {
      if (p.lspServers) return Object.keys(p.lspServers).length
      const servers = await loadPluginLspServers(p, errors)
      if (servers) p.lspServers = servers
      return servers ? Object.keys(servers).length : 0
    },
  )
  const mcp_count = mcpCounts.reduce((sum, n) => sum + n, 0)
  const lsp_count = lspCounts.reduce((sum, n) => sum + n, 0)

  setAppState(prev => ({
    ...prev,
    plugins: {
      ...prev.plugins,
      enabled,
      disabled,
      commands: pluginCommands,
      errors: mergePluginErrors(prev.plugins.errors, errors),
      needsRefresh: false,
    },
    agentDefinitions,
    mcp: {
      ...prev.mcp,
      pluginReconnectKey: prev.mcp.pluginReconnectKey + 1,
    },
  }))

  // Re-initialize LSP manager so newly-loaded plugin LSP servers are picked
  // up. No-op if LSP was never initialized (headless subcommand path).
  // Unconditional so removing the last LSP plugin also clears stale config.
  // Fixes issue #15521: LSP manager previously read a stale memoized
  // loadAllPlugins() result from before marketplaces were reconciled.
  await reinitializeLspServerManager()

  // clearAllCaches() prunes removed-plugin hooks; this does the FULL swap
  // (adds hooks from newly-enabled plugins too). Catching here so
  // hook_load_failed can feed error_count; a failure doesn't lose the
  // plugin/command/agent data above (hooks go to STATE.registeredHooks, not
  // AppState).
  let hook_load_failed = false
  try {
    await loadPluginHooks()
  } catch (e) {
    hook_load_failed = true
    logError(e)
    logForDebugging(
      `refreshActivePlugins: loadPluginHooks failed: ${errorMessage(e)}`,
    )
  }

  const hook_count = enabled.reduce((sum, p) => {
    if (!p.hooksConfig) return sum
    return (
      sum +
      (Object.values(p.hooksConfig) as unknown[]).reduce(
        (s: number, matchers: any) =>
          s + (matchers?.reduce((h: number, m: any) => h + m.hooks.length, 0) ?? 0),
        0,
      )
    )
  }, 0)

  logForDebugging(
    `refreshActivePlugins: ${enabled.length} enabled, ${pluginCommands.length} commands, ${agentDefinitions.allAgents.length} agents, ${hook_count} hooks, ${mcp_count} MCP, ${lsp_count} LSP`,
  )

  // The loaded state now reflects the disk as of the start of this pass.
  recordPluginDiscoveryFingerprint(fingerprintAtStart)

  return {
    enabled_count: enabled.length,
    disabled_count: disabled.length,
    command_count: pluginCommands.length,
    agent_count: agentDefinitions.allAgents.length,
    hook_count,
    mcp_count,
    lsp_count,
    error_count: errors.length + (hook_load_failed ? 1 : 0),
    agentDefinitions,
    pluginCommands,
  }
}

/**
 * Merge fresh plugin-load errors with existing errors, preserving LSP and
 * plugin-component errors that were recorded by other systems and
 * deduplicating. Same logic as refreshPlugins()/updatePluginState(), extracted
 * so refresh.ts doesn't leave those errors stranded.
 */
function mergePluginErrors(
  existing: PluginError[],
  fresh: PluginError[],
): PluginError[] {
  const preserved = existing.filter(
    e => e.source === 'lsp-manager' || e.source.startsWith('plugin:'),
  )
  const freshKeys = new Set(fresh.map(errorKey))
  const deduped = preserved.filter(e => !freshKeys.has(errorKey(e)))
  return [...deduped, ...fresh]
}

function errorKey(e: PluginError): string {
  return e.type === 'generic-error'
    ? `generic-error:${e.source}:${e.error}`
    : `${e.type}:${e.source}`
}
