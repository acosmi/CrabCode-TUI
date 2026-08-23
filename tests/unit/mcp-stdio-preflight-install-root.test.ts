import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { preflightPluginStdio } from '../../src/services/mcp/stdioPreflight.js'
import type { McpServerConfig } from '../../src/services/mcp/types.js'

/**
 * P2-11: a bare `bun`/`node` from a plugin MCP config must resolve to the
 * release install root's `.exe` before PATH is consulted, so Windows stops
 * routing every plugin server through npm's `bun.cmd` batch shim (and the extra
 * `cmd.exe` it forces). Every case pins `platform` explicitly so the suite
 * asserts the same contract on any host OS.
 */

const WIN_ENV_BASE = { PATHEXT: '.COM;.EXE;.BAT;.CMD' } as const

let base: string
let pluginRoot: string
let installRoot: string
let emptyInstallRoot: string
let pathDir: string
let explicitDir: string
let absDir: string

async function touchExecutable(path: string): Promise<void> {
  await writeFile(path, '')
  // POSIX hosts check X_OK; Windows ignores the mode bits entirely.
  await chmod(path, 0o755)
}

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), 'mcp-stdio-preflight-'))
  pluginRoot = join(base, 'plugin')
  installRoot = join(base, 'install')
  emptyInstallRoot = join(base, 'install-empty')
  pathDir = join(base, 'pathdir')
  explicitDir = join(base, 'explicit')
  absDir = join(base, 'abs')

  for (const dir of [
    join(pluginRoot, 'local'),
    installRoot,
    emptyInstallRoot,
    pathDir,
    explicitDir,
    absDir,
  ]) {
    await mkdir(dir, { recursive: true })
  }

  // Release install root: the first-party runtimes plus a decoy that must never
  // be preferred, and an extension-less `bun` used by the POSIX guard case.
  await touchExecutable(join(installRoot, 'bun.exe'))
  await touchExecutable(join(installRoot, 'node.exe'))
  await touchExecutable(join(installRoot, 'python.exe'))
  await touchExecutable(join(installRoot, 'bun'))

  // PATH: exactly the npm batch-shim layout that motivated the fix.
  await touchExecutable(join(pathDir, 'bun.cmd'))
  await touchExecutable(join(pathDir, 'node.cmd'))
  await touchExecutable(join(pathDir, 'python.cmd'))
  await touchExecutable(join(pathDir, 'bun'))

  await touchExecutable(join(explicitDir, 'bun.exe'))
  await touchExecutable(join(absDir, 'bun.exe'))
  await touchExecutable(join(pluginRoot, 'local', 'bun.exe'))
})

afterAll(async () => {
  await rm(base, { recursive: true, force: true })
})

function stdio(command: string): McpServerConfig {
  return { type: 'stdio', command, args: [] } as McpServerConfig
}

async function preflight(
  command: string,
  options: {
    installRoot?: string | null
    platform?: NodeJS.Platform
    env?: Record<string, string | undefined>
  } = {},
) {
  return preflightPluginStdio(stdio(command), pluginRoot, {
    platform: options.platform ?? 'win32',
    env: { ...WIN_ENV_BASE, PATH: pathDir, ...options.env },
    installRoot:
      options.installRoot === undefined ? installRoot : options.installRoot,
  })
}

function expectReady(result: Awaited<ReturnType<typeof preflight>>) {
  expect(result.state).toBe('ready')
  if (result.state !== 'ready') throw new Error('unreachable')
  return result
}

describe('preflightPluginStdio install-root runtime preference', () => {
  test('bare bun resolves to the install root exe instead of the PATH .cmd shim', async () => {
    const result = expectReady(await preflight('bun'))
    expect(result.config.command).toBe(
      await realpath(join(installRoot, 'bun.exe')),
    )
    expect(result.config.command.endsWith('.cmd')).toBe(false)
    expect(result.cwd).toBe(await realpath(pluginRoot))
    expect(result.shell).toBe(false)
  })

  test('bare node resolves to the install root exe as well', async () => {
    const result = expectReady(await preflight('node'))
    expect(result.config.command).toBe(
      await realpath(join(installRoot, 'node.exe')),
    )
  })

  test('missing install-root exe falls back to unchanged PATH resolution', async () => {
    const result = expectReady(
      await preflight('bun', { installRoot: emptyInstallRoot }),
    )
    expect(result.config.command).toBe(await realpath(join(pathDir, 'bun.cmd')))
  })

  test('absent install root falls back to unchanged PATH resolution', async () => {
    const result = expectReady(await preflight('bun', { installRoot: null }))
    expect(result.config.command).toBe(await realpath(join(pathDir, 'bun.cmd')))
  })

  test('CRABCODE_BUN_BIN still outranks the install root', async () => {
    const explicitBun = join(explicitDir, 'bun.exe')
    const result = expectReady(
      await preflight('bun', { env: { CRABCODE_BUN_BIN: explicitBun } }),
    )
    expect(result.config.command).toBe(await realpath(explicitBun))
  })

  test('an absolute command path is untouched by the install root', async () => {
    const absoluteBun = join(absDir, 'bun.exe')
    const result = expectReady(await preflight(absoluteBun))
    expect(result.config.command).toBe(await realpath(absoluteBun))
  })

  test('a separator-bearing plugin-relative path is untouched by the install root', async () => {
    const result = expectReady(await preflight('local/bun.exe'))
    expect(result.config.command).toBe(
      await realpath(join(pluginRoot, 'local', 'bun.exe')),
    )
  })

  test('a non-runtime command name is not redirected to the install root', async () => {
    // `python.exe` exists in the install root purely as a decoy here.
    const result = expectReady(await preflight('python'))
    expect(result.config.command).toBe(
      await realpath(join(pathDir, 'python.cmd')),
    )
  })

  test('non-Windows platforms keep resolving bun through PATH', async () => {
    // The install root also holds an extension-less `bun`; the platform guard
    // must still leave POSIX resolution exactly as it was.
    const result = expectReady(await preflight('bun', { platform: 'linux' }))
    expect(result.config.command).toBe(await realpath(join(pathDir, 'bun')))
  })

  test('an unresolvable runtime still reports requiresDependency', async () => {
    const result = await preflight('definitely-not-installed', {
      installRoot: null,
    })
    expect(result.state).toBe('requiresDependency')
    if (result.state !== 'requiresDependency') throw new Error('unreachable')
    expect(result.command).toBe('definitely-not-installed')
  })
})
