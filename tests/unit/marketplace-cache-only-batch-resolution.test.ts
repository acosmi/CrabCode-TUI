/**
 * P0-3: the cache-only marketplace catalog resolution must take the global
 * `marketplace-cache-mutation` lock once per discovery pass, not once per
 * plugin, and a contended lock must never be reported as "plugin not found".
 *
 * Before this contract existed, a startup with 76 enabled plugins performed 76
 * lock round-trips per pass. A second CrabCode window losing that race for the
 * whole retry budget produced `plugin-not-found`, which silently dropped the
 * plugin and its MCP servers from the session.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ---------------------------------------------------------------------------
// Cross-process lock stub: counts every acquisition by resource and can be
// told to report contention, exactly as the real acquire loop does when its
// retry budget is exhausted.
// ---------------------------------------------------------------------------

const lockAcquisitions: string[] = []
const contendedResources = new Set<string>()

function acquire(resource: string): void {
  lockAcquisitions.push(resource)
  if (contendedResources.has(resource)) {
    throw new Error(`failed to acquire ${resource} transaction lock (ELOCKED)`)
  }
}

mock.module('../../src/utils/crossProcessResourceLock.js', () => ({
  async withCrossProcessResourceLock<T>(
    resource: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    acquire(resource)
    return await operation()
  },
  withCrossProcessResourceLockSync<T>(
    resource: string,
    operation: () => T,
  ): T {
    acquire(resource)
    return operation()
  },
}))

// ---------------------------------------------------------------------------
// On-disk fixture: a real registry + a real cached catalog, so the batch
// resolution runs the production read/digest/backfill path.
// ---------------------------------------------------------------------------

const FIXTURE_ROOT = realpathSync(
  mkdtempSync(join(tmpdir(), 'crabcode-marketplace-batch-')),
)
const PLUGINS_ROOT = join(FIXTURE_ROOT, 'plugins')
const MARKETPLACE_NAME = 'acme-tools'
const MARKETPLACE_ROOT = join(PLUGINS_ROOT, 'marketplaces', MARKETPLACE_NAME)
const PLUGIN_COUNT = 76

const CONFIG_HOME = process.env.CRABCODE_CONFIG_DIR as string

function pluginId(index: number): string {
  return `plugin-${index}@${MARKETPLACE_NAME}`
}

function writeFixture(): void {
  mkdirSync(join(MARKETPLACE_ROOT, '.crabcode-plugin'), { recursive: true })
  writeFileSync(
    join(MARKETPLACE_ROOT, '.crabcode-plugin', 'marketplace.json'),
    JSON.stringify({
      name: MARKETPLACE_NAME,
      owner: { name: 'Acme' },
      plugins: Array.from({ length: PLUGIN_COUNT }, (_unused, index) => ({
        name: `plugin-${index}`,
        source: `./plugins/plugin-${index}`,
        description: `fixture plugin ${index}`,
      })),
    }),
  )
  writeFileSync(
    join(PLUGINS_ROOT, 'known_marketplaces.json'),
    JSON.stringify({
      [MARKETPLACE_NAME]: {
        source: { source: 'github', repo: 'acme/tools' },
        installLocation: MARKETPLACE_ROOT,
        lastUpdated: '2026-01-01T00:00:00.000Z',
      },
    }),
  )
}

function writeUserSettings(enabledPlugins: Record<string, boolean>): void {
  mkdirSync(CONFIG_HOME, { recursive: true })
  writeFileSync(
    join(CONFIG_HOME, 'settings.json'),
    JSON.stringify({ enabledPlugins }),
  )
}

process.env.CRABCODE_PLUGIN_CACHE_DIR = PLUGINS_ROOT
writeFixture()
writeUserSettings(
  Object.fromEntries(
    Array.from({ length: PLUGIN_COUNT }, (_unused, index) => [
      pluginId(index),
      true,
    ]),
  ),
)

const { resetSettingsCache } = await import(
  '../../src/utils/settings/settingsCache.js'
)
const {
  MARKETPLACE_CATALOG_UNAVAILABLE,
  MarketplaceCatalogUnavailableError,
  getPluginByIdCacheOnly,
  resolveMarketplacePluginsCacheOnly,
} = await import('../../src/utils/plugins/marketplaceManager.js')
const { loadPluginsFromMarketplaces } = await import(
  '../../src/utils/plugins/pluginLoader/marketplaceLoader.js'
)

afterAll(() => {
  rmSync(FIXTURE_ROOT, { recursive: true, force: true })
})

beforeEach(() => {
  lockAcquisitions.length = 0
  contendedResources.clear()
  writeFixture()
  resetSettingsCache()
})

function countOf(resource: string): number {
  return lockAcquisitions.filter(entry => entry === resource).length
}

describe('resolveMarketplacePluginsCacheOnly', () => {
  test('resolves a whole batch under one marketplace-cache-mutation lock', async () => {
    const ids = Array.from({ length: PLUGIN_COUNT }, (_unused, index) =>
      pluginId(index),
    )

    const resolutions = await resolveMarketplacePluginsCacheOnly(ids)

    expect(resolutions.size).toBe(PLUGIN_COUNT)
    for (const id of ids) {
      const resolution = resolutions.get(id)
      expect(resolution?.status).toBe('resolved')
      if (resolution?.status !== 'resolved') throw new Error('unreachable')
      expect(resolution.plugin.entry.name).toBe(id.split('@')[0])
      expect(resolution.plugin.marketplaceInstallLocation).toBe(
        MARKETPLACE_ROOT,
      )
      expect(resolution.plugin.marketplaceContentDigest).toMatch(
        /^[a-f0-9]{64}$/,
      )
    }

    expect(countOf('marketplace-cache-mutation')).toBe(1)
    expect(countOf('marketplace-registry')).toBe(1)
  })

  test('takes no lock at all when the batch has no marketplace-backed id', async () => {
    const resolutions = await resolveMarketplacePluginsCacheOnly([
      'not-a-plugin-id',
    ])

    expect(resolutions.get('not-a-plugin-id')).toEqual({ status: 'not-found' })
    expect(lockAcquisitions).toEqual([])
  })

  test('still reports a genuinely absent plugin as not-found', async () => {
    const resolutions = await resolveMarketplacePluginsCacheOnly([
      pluginId(0),
      `ghost@${MARKETPLACE_NAME}`,
      'orphan@unregistered-marketplace',
    ])

    expect(resolutions.get(pluginId(0))?.status).toBe('resolved')
    expect(resolutions.get(`ghost@${MARKETPLACE_NAME}`)).toEqual({
      status: 'not-found',
    })
    expect(resolutions.get('orphan@unregistered-marketplace')).toEqual({
      status: 'not-found',
    })
    expect(countOf('marketplace-cache-mutation')).toBe(1)
  })

  test('throws MarketplaceCatalogUnavailableError instead of reporting not-found when the lock is contended', async () => {
    contendedResources.add('marketplace-cache-mutation')

    const attempt = resolveMarketplacePluginsCacheOnly([
      pluginId(0),
      pluginId(1),
    ])

    await expect(attempt).rejects.toThrow(MarketplaceCatalogUnavailableError)
    const error = await attempt.catch(
      (thrown: MarketplaceCatalogUnavailableError) => thrown,
    )
    expect(error.code).toBe(MARKETPLACE_CATALOG_UNAVAILABLE)
    expect(error.marketplaces).toEqual([MARKETPLACE_NAME])
    expect(countOf('marketplace-cache-mutation')).toBe(1)
  })

  test('throws when the inner registry transaction lock is contended', async () => {
    contendedResources.add('marketplace-registry')

    await expect(
      resolveMarketplacePluginsCacheOnly([pluginId(0)]),
    ).rejects.toThrow(MarketplaceCatalogUnavailableError)
  })

  test('reports an unreadable cached catalog separately from an absent plugin', async () => {
    writeFileSync(
      join(MARKETPLACE_ROOT, '.crabcode-plugin', 'marketplace.json'),
      '{ this is not json',
    )

    const resolutions = await resolveMarketplacePluginsCacheOnly([pluginId(0)])

    const resolution = resolutions.get(pluginId(0))
    expect(resolution?.status).toBe('marketplace-unreadable')
    if (resolution?.status !== 'marketplace-unreadable') {
      throw new Error('unreachable')
    }
    expect(resolution.marketplace).toBe(MARKETPLACE_NAME)
    expect(resolution.reason.length).toBeGreaterThan(0)
  })
})

describe('getPluginByIdCacheOnly', () => {
  test('keeps its single-lookup contract while sharing the batch implementation', async () => {
    const resolved = await getPluginByIdCacheOnly(pluginId(3))

    expect(resolved?.entry.name).toBe('plugin-3')
    expect(countOf('marketplace-cache-mutation')).toBe(1)
  })

  test('still degrades a contended lock to null for its legacy callers', async () => {
    contendedResources.add('marketplace-cache-mutation')

    expect(await getPluginByIdCacheOnly(pluginId(3))).toBeNull()
  })
})

describe('loadPluginsFromMarketplaces', () => {
  test('resolves every enabled plugin with a single lock acquisition', async () => {
    const { errors } = await loadPluginsFromMarketplaces({ cacheOnly: true })

    expect(errors.some(error => error.type === 'plugin-not-found')).toBe(false)
    // Every enabled id reached the catalog and resolved; the only remaining
    // complaint is that the fixture records no local install for them.
    expect(errors).toHaveLength(PLUGIN_COUNT)
    expect(new Set(errors.map(error => error.type))).toEqual(
      new Set(['plugin-cache-miss']),
    )
    expect(countOf('marketplace-cache-mutation')).toBe(1)
  })

  test('propagates catalog unavailability instead of emitting plugin-not-found', async () => {
    contendedResources.add('marketplace-cache-mutation')

    const attempt = loadPluginsFromMarketplaces({ cacheOnly: true })

    await expect(attempt).rejects.toThrow(MarketplaceCatalogUnavailableError)
    // The pass produced no result at all, so no diagnostic could claim the
    // plugins are missing from their marketplace.
    await attempt.catch(() => undefined)
  })

  test('still emits plugin-not-found when the catalog is readable and the plugin is absent', async () => {
    writeUserSettings({ [`ghost@${MARKETPLACE_NAME}`]: true })
    resetSettingsCache()

    const { errors } = await loadPluginsFromMarketplaces({ cacheOnly: true })

    expect(
      errors.filter(error => error.type === 'plugin-not-found'),
    ).toHaveLength(1)

    writeUserSettings(
      Object.fromEntries(
        Array.from({ length: PLUGIN_COUNT }, (_unused, index) => [
          pluginId(index),
          true,
        ]),
      ),
    )
    resetSettingsCache()
  })
})
