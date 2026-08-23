/**
 * P0-2: the startup window must not run plugin/skill discovery twice.
 *
 * The headless background installer used to chain an unconditional
 * refreshPluginState(), which begins with clearAllCaches() and therefore re-runs
 * the entire filesystem discovery pass. On a large plugin cache that second pass
 * occupies the single JS thread with synchronous FS work for seconds, during
 * which no queued user input is processed.
 *
 * These tests pin the three defenses:
 *  1. a discovery fingerprint over the metadata files that decide what
 *     discovery can find,
 *  2. the installer's own "nothing was installed or uninstalled" report,
 *  3. an event-loop yield every PLUGIN_TRAVERSAL_YIELD_INTERVAL plugins, so a
 *     refresh that IS required still lets input through.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import type { AppState } from '../../src/state/AppState.js'
import type { LoadedPlugin } from '../../src/types/plugin.js'
import { createTestDir } from '../setup.js'

const ROOT = resolve(import.meta.dir, '../..')
const root = createTestDir('plugin-discovery-fingerprint')
const pluginsDir = join(root, 'plugins')
const configDir = join(root, 'config')
const projectDir = join(root, 'project')
mkdirSync(pluginsDir, { recursive: true })
mkdirSync(configDir, { recursive: true })
mkdirSync(join(projectDir, '.crabcode'), { recursive: true })

const INSTALLED_PLUGINS = join(pluginsDir, 'installed_plugins.json')
const KNOWN_MARKETPLACES = join(pluginsDir, 'known_marketplaces.json')
const USER_SETTINGS = join(configDir, 'settings.json')
const PROJECT_SETTINGS = join(projectDir, '.crabcode', 'settings.json')

writeFileSync(INSTALLED_PLUGINS, JSON.stringify({ version: 2, plugins: {} }))
writeFileSync(KNOWN_MARKETPLACES, JSON.stringify({ marketplaces: {} }))
writeFileSync(USER_SETTINGS, JSON.stringify({ enabledPlugins: {} }))
writeFileSync(PROJECT_SETTINGS, JSON.stringify({}))

const previousConfigDir = process.env.CRABCODE_CONFIG_DIR
const previousPluginCacheDir = process.env.CRABCODE_PLUGIN_CACHE_DIR
process.env.CRABCODE_CONFIG_DIR = configDir
process.env.CRABCODE_PLUGIN_CACHE_DIR = pluginsDir
afterAll(() => {
  if (previousConfigDir === undefined) delete process.env.CRABCODE_CONFIG_DIR
  else process.env.CRABCODE_CONFIG_DIR = previousConfigDir
  if (previousPluginCacheDir === undefined) {
    delete process.env.CRABCODE_PLUGIN_CACHE_DIR
  } else {
    process.env.CRABCODE_PLUGIN_CACHE_DIR = previousPluginCacheDir
  }
})

// ---------------------------------------------------------------------------
// Discovery is stubbed: these tests are about whether it runs at all, and how
// often it comes up for air while it does.
// ---------------------------------------------------------------------------

let clearAllCachesCalls = 0
let clearPluginCacheExclusionsCalls = 0
let loadAllPluginsCalls = 0
let pluginCommandsCalls = 0
let agentDefinitionCalls = 0
let enabledPlugins: LoadedPlugin[] = []
/** Runs inside a discovery pass, after it sampled the fingerprint. */
let writeDuringPass: (() => void) | null = null

function fakePlugins(count: number): LoadedPlugin[] {
  return Array.from(
    { length: count },
    (_unused, index) => ({ name: `plugin-${index}` }) as unknown as LoadedPlugin,
  )
}

// Every mock spreads the real module first: bun's mock.module replaces a module
// for the whole process, and other importers in this graph need the untouched
// exports. Only the discovery entry points below are swapped out.
const realCacheUtils = await import('../../src/utils/plugins/cacheUtils.js')
mock.module('../../src/utils/plugins/cacheUtils.js', () => ({
  ...realCacheUtils,
  clearAllCaches: () => {
    clearAllCachesCalls += 1
  },
}))
const realOrphanFilter = await import(
  '../../src/utils/plugins/orphanedPluginFilter.js'
)
mock.module('../../src/utils/plugins/orphanedPluginFilter.js', () => ({
  ...realOrphanFilter,
  clearPluginCacheExclusions: () => {
    clearPluginCacheExclusionsCalls += 1
  },
}))
const realPluginLoader = await import('../../src/utils/plugins/pluginLoader.js')
mock.module('../../src/utils/plugins/pluginLoader.js', () => ({
  ...realPluginLoader,
  loadAllPlugins: async () => {
    loadAllPluginsCalls += 1
    writeDuringPass?.()
    return { enabled: enabledPlugins, disabled: [], errors: [] }
  },
}))
const realLoadPluginCommands = await import(
  '../../src/utils/plugins/loadPluginCommands.js'
)
mock.module('../../src/utils/plugins/loadPluginCommands.js', () => ({
  ...realLoadPluginCommands,
  getPluginCommands: async () => {
    pluginCommandsCalls += 1
    return []
  },
}))
const realLoadAgentsDir = await import(
  '../../src/tools/AgentTool/loadAgentsDir.js'
)
mock.module('../../src/tools/AgentTool/loadAgentsDir.js', () => ({
  ...realLoadAgentsDir,
  getAgentDefinitionsWithOverrides: async () => {
    agentDefinitionCalls += 1
    return { allAgents: [] }
  },
}))
const realLoadPluginHooks = await import(
  '../../src/utils/plugins/loadPluginHooks.js'
)
mock.module('../../src/utils/plugins/loadPluginHooks.js', () => ({
  ...realLoadPluginHooks,
  loadPluginHooks: async () => {},
}))
const realMcpPluginIntegration = await import(
  '../../src/utils/plugins/mcpPluginIntegration.js'
)
mock.module('../../src/utils/plugins/mcpPluginIntegration.js', () => ({
  ...realMcpPluginIntegration,
  loadPluginMcpServers: async () => null,
}))
const realLspPluginIntegration = await import(
  '../../src/utils/plugins/lspPluginIntegration.js'
)
mock.module('../../src/utils/plugins/lspPluginIntegration.js', () => ({
  ...realLspPluginIntegration,
  loadPluginLspServers: async () => null,
}))
const realLspManager = await import('../../src/services/lsp/manager.js')
mock.module('../../src/services/lsp/manager.js', () => ({
  ...realLspManager,
  reinitializeLspServerManager: async () => {},
}))

const { setOriginalCwd } = await import('../../src/bootstrap/state.js')
setOriginalCwd(projectDir)

const {
  PLUGIN_TRAVERSAL_YIELD_INTERVAL,
  clearRecordedPluginDiscoveryFingerprintForTesting,
  computePluginDiscoveryFingerprint,
  hasPluginDiscoveryInputChanged,
  mapPluginsYieldingToEventLoop,
  recordPluginDiscoveryFingerprint,
  refreshActivePlugins,
  refreshActivePluginsIfDiscoveryChanged,
} = await import('../../src/utils/plugins/refresh.js')

const { DirectTuiCommandCatalogLifecycle } = await import(
  '../../src/cli/directTuiCommandCatalogRefresh.js'
)

let appState = {
  plugins: {
    enabled: [],
    disabled: [],
    commands: [],
    errors: [],
    needsRefresh: true,
  },
  agentDefinitions: { allAgents: [] },
  mcp: { pluginReconnectKey: 0 },
} as unknown as AppState

const setAppState = (updater: (prev: AppState) => AppState): void => {
  appState = updater(appState)
}

// Mirrors headless refreshPluginState(): the command catalog is republished
// only when a refresh actually happened. The source assertions at the bottom
// pin that the shipped function has this exact shape.
let catalogPublishes = 0
let catalogLifecycle = new DirectTuiCommandCatalogLifecycle<{ name: string }>(
  [],
  () => {
    catalogPublishes += 1
  },
)

async function refreshPluginStateLikeHeadless(
  skipWhenDiscoveryInputsUnchanged: boolean,
): Promise<boolean> {
  const refreshed = skipWhenDiscoveryInputsUnchanged
    ? await refreshActivePluginsIfDiscoveryChanged(setAppState)
    : await refreshActivePlugins(setAppState)
  if (!refreshed) return false
  await catalogLifecycle.refresh(async () => [{ name: 'plugin:example' }])
  return true
}

function touch(path: string): void {
  const future = new Date(Date.now() + 10_000)
  utimesSync(path, future, future)
}

beforeEach(() => {
  clearAllCachesCalls = 0
  clearPluginCacheExclusionsCalls = 0
  loadAllPluginsCalls = 0
  pluginCommandsCalls = 0
  agentDefinitionCalls = 0
  catalogPublishes = 0
  enabledPlugins = fakePlugins(3)
  writeDuringPass = null
  catalogLifecycle = new DirectTuiCommandCatalogLifecycle<{ name: string }>(
    [],
    () => {
      catalogPublishes += 1
    },
  )
  clearRecordedPluginDiscoveryFingerprintForTesting()
})

describe('plugin discovery fingerprint', () => {
  test('an unchanged disk skips the entire second discovery pass', async () => {
    // Pass 1 stands in for the startup discovery that setup() kicks off.
    expect(await refreshPluginStateLikeHeadless(false)).toBe(true)
    expect(clearAllCachesCalls).toBe(1)
    expect(loadAllPluginsCalls).toBe(1)
    expect(catalogPublishes).toBe(1)

    // Pass 2 is the one the background installer used to chain unconditionally.
    expect(await refreshPluginStateLikeHeadless(true)).toBe(false)
    expect(clearAllCachesCalls).toBe(1)
    expect(clearPluginCacheExclusionsCalls).toBe(1)
    expect(loadAllPluginsCalls).toBe(1)
    expect(pluginCommandsCalls).toBe(1)
    expect(agentDefinitionCalls).toBe(1)
    expect(catalogPublishes).toBe(1)
  })

  test('a changed installed_plugins.json mtime still rescans', async () => {
    recordPluginDiscoveryFingerprint()
    touch(INSTALLED_PLUGINS)

    expect(hasPluginDiscoveryInputChanged()).toBe(true)
    expect(await refreshPluginStateLikeHeadless(true)).toBe(true)
    expect(clearAllCachesCalls).toBe(1)
    expect(loadAllPluginsCalls).toBe(1)
    expect(catalogPublishes).toBe(1)
  })

  test('a changed known_marketplaces.json still rescans', async () => {
    recordPluginDiscoveryFingerprint()
    writeFileSync(
      KNOWN_MARKETPLACES,
      JSON.stringify({ marketplaces: { example: { source: 'github' } } }),
    )

    expect(hasPluginDiscoveryInputChanged()).toBe(true)
    expect(await refreshPluginStateLikeHeadless(true)).toBe(true)
    expect(clearAllCachesCalls).toBe(1)
    expect(loadAllPluginsCalls).toBe(1)
  })

  test('settings rewritten inside the startup window still rescans', async () => {
    recordPluginDiscoveryFingerprint()
    writeFileSync(
      USER_SETTINGS,
      JSON.stringify({ enabledPlugins: { 'example@marketplace': true } }),
    )

    expect(hasPluginDiscoveryInputChanged()).toBe(true)
    expect(await refreshPluginStateLikeHeadless(true)).toBe(true)
    expect(clearAllCachesCalls).toBe(1)

    // The project layer participates in the same merge, so it must count too.
    clearAllCachesCalls = 0
    recordPluginDiscoveryFingerprint()
    expect(hasPluginDiscoveryInputChanged()).toBe(false)
    touch(PROJECT_SETTINGS)
    expect(hasPluginDiscoveryInputChanged()).toBe(true)
    expect(await refreshPluginStateLikeHeadless(true)).toBe(true)
    expect(clearAllCachesCalls).toBe(1)
  })

  test('a missing metadata file is a definite stamp, not an exception', () => {
    expect(() => computePluginDiscoveryFingerprint()).not.toThrow()
    const fingerprint = computePluginDiscoveryFingerprint()

    // Present files carry (mtimeMs, size).
    const escaped = INSTALLED_PLUGINS.replaceAll('\\', '\\\\').replaceAll(
      '.',
      '\\.',
    )
    expect(fingerprint).toMatch(new RegExp(`${escaped}=\\d+(\\.\\d+)?:\\d+`))

    // Absent ones are stamped rather than skipped, so the file appearing later
    // is itself a change. No managed-settings.json exists on a dev machine.
    expect(fingerprint).toContain('managed-settings.json=missing')
    expect(computePluginDiscoveryFingerprint()).toBe(fingerprint)
  })

  test('without a recorded baseline the refresh is never suppressed', async () => {
    expect(hasPluginDiscoveryInputChanged()).toBe(true)
    expect(await refreshPluginStateLikeHeadless(true)).toBe(true)
    expect(clearAllCachesCalls).toBe(1)
    // The completed refresh rebaselines, so the next one can be skipped.
    expect(await refreshPluginStateLikeHeadless(true)).toBe(false)
    expect(clearAllCachesCalls).toBe(1)
  })

  test('a refresh baselines the disk as it was BEFORE its own sweep', async () => {
    // A settings write that lands while the pass is running was not seen by
    // that pass, so it must still force the next one.
    writeDuringPass = () => touch(USER_SETTINGS)
    await refreshActivePlugins(setAppState)
    expect(loadAllPluginsCalls).toBe(1)
    expect(hasPluginDiscoveryInputChanged()).toBe(true)

    // Once a pass runs with no concurrent write, the baseline holds.
    writeDuringPass = null
    await refreshActivePlugins(setAppState)
    expect(loadAllPluginsCalls).toBe(2)
    expect(hasPluginDiscoveryInputChanged()).toBe(false)
  })
})

describe('plugin traversal yields the event loop', () => {
  test('yields once per full batch and preserves order', async () => {
    expect(PLUGIN_TRAVERSAL_YIELD_INTERVAL).toBe(8)

    const seen: number[] = []
    let yields = 0
    const result = await mapPluginsYieldingToEventLoop(
      Array.from({ length: 20 }, (_unused, index) => index),
      value => {
        seen.push(value)
        return value * 2
      },
      async () => {
        yields += 1
      },
    )

    expect(yields).toBe(2)
    expect(seen).toEqual(Array.from({ length: 20 }, (_unused, i) => i))
    expect(result).toEqual(Array.from({ length: 20 }, (_unused, i) => i * 2))
  })

  test('never yields for a partial first batch', async () => {
    let yields = 0
    await mapPluginsYieldingToEventLoop(
      Array.from({ length: PLUGIN_TRAVERSAL_YIELD_INTERVAL }, () => 0),
      value => value,
      async () => {
        yields += 1
      },
    )
    expect(yields).toBe(0)
  })

  test('the shipped default really hands the loop back via setImmediate', async () => {
    const realSetImmediate = globalThis.setImmediate
    let scheduled = 0
    globalThis.setImmediate = ((
      callback: (...args: unknown[]) => void,
      ...args: unknown[]
    ) => {
      scheduled += 1
      return realSetImmediate(callback, ...args)
    }) as typeof globalThis.setImmediate

    try {
      // Two traversals (MCP + LSP) over 9 plugins: one yield each.
      enabledPlugins = fakePlugins(PLUGIN_TRAVERSAL_YIELD_INTERVAL + 1)
      await refreshActivePlugins(setAppState)
      expect(scheduled).toBe(2)

      scheduled = 0
      clearRecordedPluginDiscoveryFingerprintForTesting()
      enabledPlugins = fakePlugins(PLUGIN_TRAVERSAL_YIELD_INTERVAL * 3)
      await refreshActivePlugins(setAppState)
      expect(scheduled).toBe(4)
    } finally {
      globalThis.setImmediate = realSetImmediate
    }
  })

  test('a real yield lets an already-queued macrotask run mid-traversal', async () => {
    let ranDuringTraversal = false
    let traversalFinished = false
    setImmediate(() => {
      if (!traversalFinished) ranDuringTraversal = true
    })
    await mapPluginsYieldingToEventLoop(
      Array.from({ length: PLUGIN_TRAVERSAL_YIELD_INTERVAL * 2 }, () => 0),
      value => value,
    )
    traversalFinished = true
    expect(ranDuringTraversal).toBe(true)
  })
})

describe('headless startup wiring', () => {
  const queryCore = readFileSync(
    resolve(ROOT, 'src/cli/print/queryExecutionCore.ts'),
    'utf8',
  )

  test('the background installer reports whether it changed anything', () => {
    expect(queryCore).toContain(
      'async function installPluginsAndApplyMcpInBackground(): Promise<boolean>',
    )
    expect(queryCore).toContain('return pluginsInstalled')
    expect(queryCore).toMatch(
      /\.then\(installerChangedPlugins =>[\s\S]*?refreshPluginState\(\{[\s\S]*?skipWhenDiscoveryInputsUnchanged: !installerChangedPlugins/,
    )
  })

  test('the startup baseline is recorded before anything can write to it', () => {
    const recordAt = queryCore.indexOf('recordPluginDiscoveryFingerprint()')
    const downloadAt = queryCore.indexOf('const startupUserSettings =')
    const installAt = queryCore.indexOf(
      'installPluginsAndApplyMcpInBackground()',
    )
    expect(recordAt).toBeGreaterThan(0)
    expect(recordAt).toBeLessThan(downloadAt)
    expect(recordAt).toBeLessThan(installAt)
  })

  test('a skipped refresh returns before the command catalog is republished', () => {
    const body = queryCore.slice(
      queryCore.indexOf('async function refreshPluginState('),
    )
    const earlyReturn = body.indexOf('if (!refreshed) return')
    const catalogRefresh = body.indexOf('await commandCatalogLifecycle.refresh')
    expect(earlyReturn).toBeGreaterThan(0)
    expect(catalogRefresh).toBeGreaterThan(earlyReturn)
    expect(body).toContain('refreshActivePluginsIfDiscoveryChanged(setAppState)')
  })

  test('the sync-install path never suppresses its first discovery pass', () => {
    // setup() skips prefetchActiveCommands AND loadPluginHooks under
    // CRABCODE_SYNC_PLUGIN_INSTALL, so that refresh IS the first pass.
    const syncBlock = queryCore.slice(
      queryCore.indexOf('if (pluginInstallPromise) {'),
      queryCore.indexOf('setupPluginHookHotReload()'),
    )
    expect(syncBlock).toContain('await refreshPluginState()')
    expect(syncBlock).not.toContain('skipWhenDiscoveryInputsUnchanged')
  })
})
