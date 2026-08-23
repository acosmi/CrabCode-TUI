// P2-10 (2026-08-23 Windows startup audit) —— 启动期磁盘残留回收。
//
// 这四项清理会删除用户主目录下的目录树，所以本文件钉的**首先是护栏**，其次才是
// 「该删的确实删了」：
//
//   1. `.marketplace-add-<pid>-<uuid>.staging` —— mtime 超 1 小时 **且** pid 已退出。
//      两条是「与」。任一不满足都必须留着，因为删错的对象是一个正在进行的安装。
//   2. `shell-snapshots/snapshot-<shell>-<ts>-<rand>.sh` —— 超 7 天才删，且只认这一个
//      文件名形状（目录在用户 config home 下，宽松通配会误伤）。
//   3. `versions/<v>/` —— `.current` 指向的、以及**当前进程实际所在**的，两个都留。
//      后者由 `process.execPath` 溯源，不信 `.current`；任何一处判断不出来就整轮不删。
//   4. 孤儿 marketplace 目录 —— `known_marketplaces.json` 读不到/解析不了/形状不对时
//      **一个都不删**，「读不到注册表」不等于「没有引用」。
//
// 隔离：`CRABCODE_PLUGIN_CACHE_DIR` + `CRABCODE_CONFIG_DIR` 指向本进程的临时目录，
// versions 那项直接走 options 注入。每个测试跑前先断言解析出的目录确实落在临时根下 ——
// 环境变量一旦没生效，测试应当当场失败，而不是去删真实的 `~/.crabcode`。

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'child_process'
import { randomUUID } from 'crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  cleanupOldShellSnapshots,
  cleanupOrphanedMarketplaceDirs,
  cleanupStaleMarketplaceStagingDirs,
  cleanupSupersededInstallVersions,
} from '../../src/utils/cleanup.js'
import { getCrabCodeConfigHomeDir } from '../../src/utils/envUtils.js'
import { getPluginsDirectory } from '../../src/utils/plugins/pluginDirectories.js'

const TEMP_ROOT = realpathSync(
  mkdtempSync(join(tmpdir(), 'crabcode-residue-cleanup-')),
)

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

afterAll(() => {
  rmSync(TEMP_ROOT, { recursive: true, force: true })
})

/** A fresh isolated tree per test, so one sweep never sees another's fixture. */
function freshCase(name: string): string {
  const dir = join(TEMP_ROOT, `${name}-${randomUUID()}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * Point the config/plugin roots at `caseDir` and *prove* it took effect.
 *
 * Without the assertions a typo in an env-var name would silently aim a
 * recursive delete at the developer's real `~/.crabcode`.
 */
function isolateUserDirs(caseDir: string): void {
  process.env.CRABCODE_CONFIG_DIR = caseDir
  process.env.CRABCODE_PLUGIN_CACHE_DIR = join(caseDir, 'plugins')
  expect(getCrabCodeConfigHomeDir().startsWith(TEMP_ROOT)).toBe(true)
  expect(getPluginsDirectory().startsWith(TEMP_ROOT)).toBe(true)
}

function ageOf(path: string, ms: number): void {
  const when = new Date(Date.now() - ms)
  utimesSync(path, when, when)
}

function makeStagingDir(
  marketplacesDir: string,
  pid: number,
  ageMs: number,
): string {
  const path = join(
    marketplacesDir,
    `.marketplace-add-${pid}-${randomUUID()}.staging`,
  )
  mkdirSync(path, { recursive: true })
  writeFileSync(join(path, 'marketplace.json'), '{}')
  ageOf(path, ageMs)
  return path
}

/**
 * A pid that is genuinely gone.
 *
 * `spawnSync` returns only after the child has exited and libuv has closed its
 * process handle, but Windows recycles pids eagerly — so the pid is confirmed
 * dead with the same ESRCH probe the implementation uses, and another child is
 * spawned if it happened to be reused.
 */
function findDeadPid(): number {
  for (let attempt = 0; attempt < 32; attempt++) {
    const child = spawnSync(process.execPath, ['--version'], {
      stdio: 'ignore',
    })
    const pid = child.pid
    if (pid === undefined) continue
    try {
      process.kill(pid, 0)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return pid
    }
  }
  throw new Error('could not obtain a pid that is reliably gone')
}

function makeVersionsFixture(caseDir: string): {
  versionsDir: string
  execPath: string
} {
  const versionsDir = join(caseDir, 'crabcode', 'versions')
  for (const version of ['1.0.35', '1.0.36']) {
    mkdirSync(join(versionsDir, version, 'dist'), { recursive: true })
    writeFileSync(join(versionsDir, version, 'bun.exe'), version)
  }
  // Installer-owned entries that must survive untouched.
  mkdirSync(join(versionsDir, `.install-1.0.37-${randomUUID()}`), {
    recursive: true,
  })
  writeFileSync(join(versionsDir, '.launcher-v1'), 'crabcode.exe\n')
  writeFileSync(
    join(versionsDir, '.current'),
    `${join(versionsDir, '1.0.36')}\n`,
  )
  return { versionsDir, execPath: join(versionsDir, '1.0.36', 'bun.exe') }
}

beforeEach(() => {
  delete process.env.CRABCODE_CONFIG_DIR
  delete process.env.CRABCODE_PLUGIN_CACHE_DIR
  delete process.env.CRABCODE_HOME
})

describe('marketplace add-staging reclamation', () => {
  function setup(): string {
    const caseDir = freshCase('staging')
    isolateUserDirs(caseDir)
    const marketplacesDir = join(getPluginsDirectory(), 'marketplaces')
    mkdirSync(marketplacesDir, { recursive: true })
    return marketplacesDir
  }

  test('keeps staging whose pid is still alive, however old it is', async () => {
    const marketplacesDir = setup()
    const alive = makeStagingDir(marketplacesDir, process.pid, 30 * DAY_MS)
    const dead = makeStagingDir(marketplacesDir, findDeadPid(), 30 * DAY_MS)

    const result = await cleanupStaleMarketplaceStagingDirs()

    expect(existsSync(alive)).toBe(true)
    expect(existsSync(dead)).toBe(false)
    expect(result).toEqual({ messages: 1, errors: 0 })
  })

  test('keeps staging younger than an hour even when its pid is gone', async () => {
    const marketplacesDir = setup()
    const deadPid = findDeadPid()
    const young = makeStagingDir(marketplacesDir, deadPid, 59 * 60 * 1000)
    const old = makeStagingDir(marketplacesDir, deadPid, 61 * 60 * 1000)

    const result = await cleanupStaleMarketplaceStagingDirs()

    expect(existsSync(young)).toBe(true)
    expect(existsSync(old)).toBe(false)
    expect(result).toEqual({ messages: 1, errors: 0 })
  })

  test('removes an hours-old staging directory whose pid has exited', async () => {
    const marketplacesDir = setup()
    const stale = makeStagingDir(marketplacesDir, findDeadPid(), 20 * DAY_MS)

    const result = await cleanupStaleMarketplaceStagingDirs()

    expect(existsSync(stale)).toBe(false)
    expect(result).toEqual({ messages: 1, errors: 0 })
  })

  test('ignores names that are not the exact staging shape', async () => {
    const marketplacesDir = setup()
    const deadPid = findDeadPid()
    // The unsuffixed staging path a live install is still writing into, plus a
    // published marketplace, plus a lookalike with a non-UUID tail.
    const survivors = [
      join(marketplacesDir, `.marketplace-add-${deadPid}-${randomUUID()}`),
      join(marketplacesDir, 'crabcode-plugins-official'),
      join(marketplacesDir, `.marketplace-add-${deadPid}-not-a-uuid.staging`),
    ]
    for (const path of survivors) {
      mkdirSync(path, { recursive: true })
      ageOf(path, 30 * DAY_MS)
    }

    const result = await cleanupStaleMarketplaceStagingDirs()

    for (const path of survivors) expect(existsSync(path)).toBe(true)
    expect(result).toEqual({ messages: 0, errors: 0 })
  })
})

describe('shell snapshot retention', () => {
  function setup(): string {
    const caseDir = freshCase('snapshots')
    isolateUserDirs(caseDir)
    const snapshotsDir = join(getCrabCodeConfigHomeDir(), 'shell-snapshots')
    mkdirSync(snapshotsDir, { recursive: true })
    return snapshotsDir
  }

  function makeSnapshot(dir: string, name: string, ageMs: number): string {
    const path = join(dir, name)
    writeFileSync(path, '# snapshot\n')
    ageOf(path, ageMs)
    return path
  }

  test('keeps snapshots younger than seven days and removes older ones', async () => {
    const dir = setup()
    const young = makeSnapshot(dir, 'snapshot-bash-1783172641412-cf4pvs.sh', 6 * DAY_MS)
    const boundary = makeSnapshot(dir, 'snapshot-zsh-1783172641413-cf4pvt.sh', 7 * DAY_MS - HOUR_MS)
    const old = makeSnapshot(dir, 'snapshot-sh-1783172641414-cf4pvu.sh', 8 * DAY_MS)

    const result = await cleanupOldShellSnapshots()

    expect(existsSync(young)).toBe(true)
    expect(existsSync(boundary)).toBe(true)
    expect(existsSync(old)).toBe(false)
    expect(result).toEqual({ messages: 1, errors: 0 })
  })

  test('only matches the exact filename shape the snapshot writer emits', async () => {
    const dir = setup()
    const survivors = [
      makeSnapshot(dir, 'snapshot-fish-1783172641412-cf4pvs.sh', 30 * DAY_MS),
      makeSnapshot(dir, 'snapshot-bash-1783172641412-cf4pvs.sh.bak', 30 * DAY_MS),
      makeSnapshot(dir, 'my-snapshot-bash-1783172641412-cf4pvs.sh', 30 * DAY_MS),
      makeSnapshot(dir, 'notes.sh', 30 * DAY_MS),
    ]

    const result = await cleanupOldShellSnapshots()

    for (const path of survivors) expect(existsSync(path)).toBe(true)
    expect(result).toEqual({ messages: 0, errors: 0 })
    // The directory itself must survive — live shells write into it.
    expect(existsSync(dir)).toBe(true)
  })
})

describe('superseded install version reclamation', () => {
  test('keeps the running version and the one .current names', async () => {
    const caseDir = freshCase('versions')
    const { versionsDir, execPath } = makeVersionsFixture(caseDir)
    // A third generation that is neither: the one the audit measured at 244 MB.
    const superseded = join(versionsDir, '1.0.34')
    mkdirSync(superseded, { recursive: true })
    // Running out of 1.0.35 while .current still names 1.0.36 — both survive.
    const runningExec = join(versionsDir, '1.0.35', 'bun.exe')

    const result = await cleanupSupersededInstallVersions({
      versionsDir,
      execPath: runningExec,
    })

    expect(existsSync(join(versionsDir, '1.0.35'))).toBe(true)
    expect(existsSync(join(versionsDir, '1.0.36'))).toBe(true)
    expect(existsSync(superseded)).toBe(false)
    expect(result).toEqual({ messages: 1, errors: 0 })
    expect(existsSync(execPath)).toBe(true)
  })

  test('removes a superseded generation once both answers agree', async () => {
    const caseDir = freshCase('versions')
    const { versionsDir, execPath } = makeVersionsFixture(caseDir)

    const result = await cleanupSupersededInstallVersions({
      versionsDir,
      execPath,
    })

    expect(existsSync(join(versionsDir, '1.0.35'))).toBe(false)
    expect(existsSync(join(versionsDir, '1.0.36'))).toBe(true)
    expect(result).toEqual({ messages: 1, errors: 0 })
  })

  test('never removes installer-owned dot entries', async () => {
    const caseDir = freshCase('versions')
    const { versionsDir, execPath } = makeVersionsFixture(caseDir)
    const incoming = readdirSync(versionsDir).filter(name =>
      name.startsWith('.install-'),
    )
    expect(incoming).toHaveLength(1)

    await cleanupSupersededInstallVersions({ versionsDir, execPath })

    expect(existsSync(join(versionsDir, incoming[0]!))).toBe(true)
    expect(existsSync(join(versionsDir, '.launcher-v1'))).toBe(true)
    expect(existsSync(join(versionsDir, '.current'))).toBe(true)
  })

  test('removes nothing when the process is not running from the versions tree', async () => {
    const caseDir = freshCase('versions')
    const { versionsDir } = makeVersionsFixture(caseDir)
    const outside = join(caseDir, 'bun.exe')
    writeFileSync(outside, 'dev runtime')

    const result = await cleanupSupersededInstallVersions({
      versionsDir,
      execPath: outside,
    })

    expect(existsSync(join(versionsDir, '1.0.35'))).toBe(true)
    expect(existsSync(join(versionsDir, '1.0.36'))).toBe(true)
    expect(result).toEqual({ messages: 0, errors: 0 })
  })

  test('removes nothing when .current is missing, empty, or points outside', async () => {
    for (const mutate of [
      (versionsDir: string) => rmSync(join(versionsDir, '.current')),
      (versionsDir: string) =>
        writeFileSync(join(versionsDir, '.current'), '\n'),
      (versionsDir: string) =>
        writeFileSync(join(versionsDir, '.current'), 'relative/path\n'),
      (versionsDir: string) =>
        writeFileSync(join(versionsDir, '.current'), `${TEMP_ROOT}\n`),
      (versionsDir: string) =>
        writeFileSync(
          join(versionsDir, '.current'),
          `${join(versionsDir, 'vanished')}\n`,
        ),
    ]) {
      const caseDir = freshCase('versions')
      const { versionsDir, execPath } = makeVersionsFixture(caseDir)
      mutate(versionsDir)

      const result = await cleanupSupersededInstallVersions({
        versionsDir,
        execPath,
      })

      expect(existsSync(join(versionsDir, '1.0.35'))).toBe(true)
      expect(existsSync(join(versionsDir, '1.0.36'))).toBe(true)
      expect(result).toEqual({ messages: 0, errors: 0 })
    }
  })
})

describe('orphaned marketplace reclamation', () => {
  function setup(registry: string | null): {
    marketplacesDir: string
    pluginsDir: string
  } {
    const caseDir = freshCase('orphans')
    isolateUserDirs(caseDir)
    const pluginsDir = getPluginsDirectory()
    const marketplacesDir = join(pluginsDir, 'marketplaces')
    mkdirSync(marketplacesDir, { recursive: true })
    for (const name of [
      'crabcode-plugins-official-ae02062a-d657-494c-8180-3368e6a29ec5',
      'crabcode-plugins-official',
      '.marketplace-add-4242-ae02062a-d657-494c-8180-3368e6a29ec5.staging',
      '.marketplace-add-4242-ae02062a-d657-494c-8180-3368e6a29ec6',
    ]) {
      mkdirSync(join(marketplacesDir, name), { recursive: true })
    }
    if (registry !== null) {
      writeFileSync(join(pluginsDir, 'known_marketplaces.json'), registry)
    }
    return { marketplacesDir, pluginsDir }
  }

  function liveRegistry(marketplacesDir: string): string {
    return JSON.stringify({
      'crabcode-plugins-official': {
        source: { source: 'github', repo: 'acosmi/CrabCode-Plugin' },
        installLocation: join(
          marketplacesDir,
          'crabcode-plugins-official-ae02062a-d657-494c-8180-3368e6a29ec5',
        ),
        lastUpdated: '2026-08-23T07:00:59.190Z',
      },
    })
  }

  function survivorNames(marketplacesDir: string): string[] {
    return readdirSync(marketplacesDir).sort()
  }

  test('removes the unreferenced generation and keeps the referenced one', async () => {
    const { marketplacesDir, pluginsDir } = setup(null)
    writeFileSync(
      join(pluginsDir, 'known_marketplaces.json'),
      liveRegistry(marketplacesDir),
    )

    const result = await cleanupOrphanedMarketplaceDirs()

    expect(survivorNames(marketplacesDir)).toEqual([
      '.marketplace-add-4242-ae02062a-d657-494c-8180-3368e6a29ec5.staging',
      '.marketplace-add-4242-ae02062a-d657-494c-8180-3368e6a29ec6',
      'crabcode-plugins-official-ae02062a-d657-494c-8180-3368e6a29ec5',
    ])
    expect(result).toEqual({ messages: 1, errors: 0 })
  })

  test('honours a legacy relative installLocation', async () => {
    const { marketplacesDir } = setup(
      JSON.stringify({
        legacy: {
          source: { source: 'github', repo: 'acosmi/CrabCode-Plugin' },
          installLocation:
            'marketplaces/crabcode-plugins-official-ae02062a-d657-494c-8180-3368e6a29ec5',
          lastUpdated: '2026-08-23T07:00:59.190Z',
        },
        alsoLegacy: {
          source: { source: 'github', repo: 'acosmi/CrabCode-Plugin' },
          installLocation: './crabcode-plugins-official',
          lastUpdated: '2026-08-23T07:00:59.190Z',
        },
      }),
    )

    const result = await cleanupOrphanedMarketplaceDirs()

    expect(
      existsSync(
        join(
          marketplacesDir,
          'crabcode-plugins-official-ae02062a-d657-494c-8180-3368e6a29ec5',
        ),
      ),
    ).toBe(true)
    expect(existsSync(join(marketplacesDir, 'crabcode-plugins-official'))).toBe(
      true,
    )
    expect(result).toEqual({ messages: 0, errors: 0 })
  })

  test('removes nothing when known_marketplaces.json is missing', async () => {
    const { marketplacesDir } = setup(null)
    const before = survivorNames(marketplacesDir)

    const result = await cleanupOrphanedMarketplaceDirs()

    expect(survivorNames(marketplacesDir)).toEqual(before)
    expect(result).toEqual({ messages: 0, errors: 0 })
  })

  test('removes nothing when known_marketplaces.json cannot be parsed', async () => {
    for (const registry of [
      '{"crabcode-plugins-official": {"instal',
      '[]',
      'null',
      '"a string"',
    ]) {
      const { marketplacesDir } = setup(registry)
      const before = survivorNames(marketplacesDir)

      const result = await cleanupOrphanedMarketplaceDirs()

      expect(survivorNames(marketplacesDir)).toEqual(before)
      expect(result).toEqual({ messages: 0, errors: 0 })
    }
  })

  test('removes nothing when an entry has no usable installLocation', async () => {
    for (const entry of [
      { source: { source: 'github', repo: 'a/b' } },
      { source: { source: 'github', repo: 'a/b' }, installLocation: '' },
      { source: { source: 'github', repo: 'a/b' }, installLocation: 42 },
    ]) {
      const { marketplacesDir } = setup(
        JSON.stringify({ 'crabcode-plugins-official': entry }),
      )
      const before = survivorNames(marketplacesDir)

      const result = await cleanupOrphanedMarketplaceDirs()

      expect(survivorNames(marketplacesDir)).toEqual(before)
      expect(result).toEqual({ messages: 0, errors: 0 })
    }
  })
})
