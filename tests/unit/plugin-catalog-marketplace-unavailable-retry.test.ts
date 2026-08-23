/**
 * P0-3: a discovery pass that cannot reach the marketplace catalog must be
 * retried once, and if it still cannot reach it, must keep serving the last
 * complete catalog instead of publishing one with plugins missing.
 *
 * The failure this locks down: a contended `marketplace-cache-mutation` lock
 * used to surface as `plugin-not-found` per plugin, so the session published a
 * catalog that was silently short a few plugins (and their MCP servers).
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test'
import type { LoadedPlugin, PluginError } from '../../src/types/plugin.js'

const { MarketplaceCatalogUnavailableError } = await import(
  '../../src/utils/plugins/marketplaceManager.js'
)

type MarketplacePass = { plugins: LoadedPlugin[]; errors: PluginError[] }

let passAttempts = 0
let nextPass: () => Promise<MarketplacePass> = async () => ({
  plugins: [],
  errors: [],
})

mock.module('../../src/utils/plugins/pluginLoader/marketplaceLoader.js', () => ({
  async loadPluginsFromMarketplaces(): Promise<MarketplacePass> {
    passAttempts += 1
    return await nextPass()
  },
}))

const {
  MARKETPLACE_UNAVAILABLE_RETRY_DELAY_MS,
  __resetRetainedPluginCatalogsForTest,
  loadAllPluginsStrictCacheOnly,
} = await import('../../src/utils/plugins/pluginLoader/pluginAssembly.js')

function marketplacePlugin(name: string): LoadedPlugin {
  return {
    name,
    path: `/fixture/${name}`,
    source: `${name}@acme-tools`,
    enabled: true,
    manifest: { name, version: '1.0.0' },
  } as unknown as LoadedPlugin
}

function unavailable(): MarketplaceCatalogUnavailableError {
  return new MarketplaceCatalogUnavailableError(
    ['acme-tools'],
    new Error('failed to acquire marketplace-cache-mutation lock (ELOCKED)'),
  )
}

beforeEach(() => {
  passAttempts = 0
  __resetRetainedPluginCatalogsForTest()
})

describe('plugin catalog assembly under marketplace unavailability', () => {
  test('retries the whole pass exactly once, after a delay', async () => {
    nextPass = async () => {
      if (passAttempts === 1) throw unavailable()
      return { plugins: [marketplacePlugin('alpha')], errors: [] }
    }

    const startedAt = Date.now()
    const result = await loadAllPluginsStrictCacheOnly()
    const elapsed = Date.now() - startedAt

    expect(passAttempts).toBe(2)
    expect(elapsed).toBeGreaterThanOrEqual(
      MARKETPLACE_UNAVAILABLE_RETRY_DELAY_MS,
    )
    expect(result.enabled.map(plugin => plugin.name)).toContain('alpha')
    expect(result.errors.some(error => error.type === 'plugin-not-found')).toBe(
      false,
    )
  })

  test('does not retry a pass that succeeded', async () => {
    nextPass = async () => ({
      plugins: [marketplacePlugin('alpha')],
      errors: [],
    })

    await loadAllPluginsStrictCacheOnly()

    expect(passAttempts).toBe(1)
  })

  test('keeps the previous complete catalog when both attempts fail', async () => {
    nextPass = async () => ({
      plugins: [marketplacePlugin('alpha'), marketplacePlugin('beta')],
      errors: [],
    })
    const complete = await loadAllPluginsStrictCacheOnly()
    const completeNames = complete.enabled.map(plugin => plugin.name)
    expect(completeNames).toContain('alpha')
    expect(completeNames).toContain('beta')

    passAttempts = 0
    nextPass = async () => {
      throw unavailable()
    }
    const degraded = await loadAllPluginsStrictCacheOnly()

    expect(passAttempts).toBe(2)
    // The catalog is the previous complete one, not a truncated rescan.
    expect(degraded.enabled.map(plugin => plugin.name)).toEqual(completeNames)
    expect(
      degraded.errors.some(error => error.type === 'plugin-not-found'),
    ).toBe(false)
    const unavailableErrors = degraded.errors.filter(
      error => error.type === 'marketplace-load-failed',
    )
    expect(unavailableErrors).toHaveLength(1)
    expect(unavailableErrors[0]).toMatchObject({
      type: 'marketplace-load-failed',
      marketplace: 'acme-tools',
    })
    expect(
      (unavailableErrors[0] as { reason: string }).reason,
    ).toContain('marketplace-unavailable')
  })

  test('a later successful pass replaces the retained catalog', async () => {
    nextPass = async () => ({
      plugins: [marketplacePlugin('alpha')],
      errors: [],
    })
    await loadAllPluginsStrictCacheOnly()

    nextPass = async () => ({
      plugins: [marketplacePlugin('gamma')],
      errors: [],
    })
    await loadAllPluginsStrictCacheOnly()

    nextPass = async () => {
      throw unavailable()
    }
    const degraded = await loadAllPluginsStrictCacheOnly()

    expect(degraded.enabled.map(plugin => plugin.name)).toContain('gamma')
    expect(degraded.enabled.map(plugin => plugin.name)).not.toContain('alpha')
  })

  test('reports unavailability without plugin-not-found when no catalog was ever complete', async () => {
    nextPass = async () => {
      throw unavailable()
    }

    const degraded = await loadAllPluginsStrictCacheOnly()

    expect(passAttempts).toBe(2)
    expect(
      degraded.errors.some(error => error.type === 'plugin-not-found'),
    ).toBe(false)
    expect(
      degraded.errors.some(error => error.type === 'marketplace-load-failed'),
    ).toBe(true)
  })

  test('never retries or swallows a non-contention failure', async () => {
    nextPass = async () => {
      throw new Error('marketplace loader exploded')
    }

    await expect(loadAllPluginsStrictCacheOnly()).rejects.toThrow(
      'marketplace loader exploded',
    )
    expect(passAttempts).toBe(1)
  })
})
