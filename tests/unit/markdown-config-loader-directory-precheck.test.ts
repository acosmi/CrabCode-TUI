// 2026-08-23 Windows 启动/输入延迟审计 P1-7 —— `loadMarkdownFiles()` 对不存在的
// 目录也会 spawn ripgrep。
//
// `loadMarkdownFilesForSubdir` 每次都要看三类目录：managed policy 目录、
// `~/.crabcode/<subdir>`、以及从 cwd 往上一路到 home 的 `.crabcode/<subdir>`。
// 其中绝大多数在任一台机器上都不存在，而旧实现「先 spawn 再 catch」意味着每个不
// 存在的目录都要真起一个 `rg` 进程、等它失败。审计实测一次启动为三个不存在的目录
// 各 spawn 一次，合计 **1.3 秒** —— Windows 上每次 CreateProcess 都要付映像加载
// + Defender 扫描。
//
// 这里钉四条，缺一不可：
//   1. 目录不存在 → **完全不调用** `ripGrep`（本条是性能修复本身）；
//   2. 目录存在 → 照常调用并真的读到文件（防止「修法」退化成无条件 return []，
//      那样第 1 条会绿得毫无意义）；
//   3. 预检查通过之后目录才被删掉 → 仍返回 []、不抛（真实竞态，用真 rg 跑）；
//   4. 搜索本身以 ENOENT 拒绝 → 仍返回 []，即 catch 分支里的 `isFsInaccessible`。
//      第 4 条与第 1 条是**两道防线**而不是替代关系：预检查省掉注定失败的进程创建，
//      catch 兜住预检查之后才出现的竞态。删掉任何一道，这里就有一条变红。
//
// spy 用 `spyOn(模块命名空间, 'ripGrep')` 而不是 `mock.module` —— 后者在单进程里
// 会泄漏成全局模块替换（见 sidequery-request-budget.test.ts 的同款说明）。

import { beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { mkdirSync, rmSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'

import { createTestDir } from '../setup.js'
import { loadMarkdownFilesForSubdir } from '../../src/utils/markdownConfigLoader.js'
import * as ripgrepModule from '../../src/utils/ripgrep.js'

/** 一次测试用的隔离环境：独立 config home + 独立 cwd（memoize key 含 cwd）。 */
function isolate(prefix: string): { configHome: string; cwd: string } {
  const root = createTestDir(prefix)
  const configHome = join(root, 'config')
  const cwd = join(root, 'project')
  mkdirSync(configHome, { recursive: true })
  mkdirSync(cwd, { recursive: true })
  process.env.CRABCODE_CONFIG_DIR = configHome
  return { configHome, cwd }
}

/** 传给 `ripGrep` 的搜索目标（第二个实参）。 */
function targetsOf(
  spy: ReturnType<typeof spyOn<typeof ripgrepModule, 'ripGrep'>>,
): string[] {
  return spy.mock.calls.map(call => call[1] as string)
}

function isExistingDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

describe('loadMarkdownFiles directory pre-check (P1-7)', () => {
  beforeAll(async () => {
    // 首次 `ripGrep` 要付 codesign 检查 + 冷启动的 rg 进程（本机实测 >3s，Windows
    // Defender 扫 98MB 二进制）。而 `loadMarkdownFiles` 给搜索的 signal 是硬编码的
    // 3s 超时 —— 冷启动会把本文件里唯一一条「目录存在」的断言拖成超时 flake。
    // 这里先用宽松 signal 预热一次，让下面的断言只测行为、不测冷启动延迟。
    await ripgrepModule
      .ripGrep(['--files'], createTestDir('md-precheck-warmup'), AbortSignal.timeout(60_000))
      .catch(() => {})
  })

  test('never spawns ripgrep against a path that is not a directory', async () => {
    const { configHome, cwd } = isolate('md-precheck-missing')
    // configHome 存在但 configHome/commands 不存在 —— 这正是真实机器上
    // `~/.crabcode/agents` 那一类目录的形态。managed 目录同理不存在。
    const missingUserDir = join(configHome, 'commands')
    expect(isExistingDirectory(missingUserDir)).toBe(false)

    const spy = spyOn(ripgrepModule, 'ripGrep')
    try {
      const files = await loadMarkdownFilesForSubdir('commands', cwd)
      expect(files).toEqual([])

      const targets = targetsOf(spy)
      // 具体的那一个：修复前它一定在列表里。
      expect(targets).not.toContain(missingUserDir)
      // 不变量本体，且不依赖本机是否恰好装了 managed policy 目录。
      expect(targets.filter(target => !isExistingDirectory(target))).toEqual([])
    } finally {
      spy.mockRestore()
    }
  })

  test('still searches — and still loads from — a directory that exists', async () => {
    const { configHome, cwd } = isolate('md-precheck-present')
    const userDir = join(configHome, 'agents')
    mkdirSync(userDir, { recursive: true })
    writeFileSync(
      join(userDir, 'reviewer.md'),
      '---\ndescription: reviews things\n---\nbody text\n',
      'utf-8',
    )

    const spy = spyOn(ripgrepModule, 'ripGrep')
    try {
      const files = await loadMarkdownFilesForSubdir('agents', cwd)

      expect(targetsOf(spy)).toContain(userDir)
      expect(files.map(file => file.filePath)).toEqual([
        join(userDir, 'reviewer.md'),
      ])
      expect(files[0]?.frontmatter.description).toBe('reviews things')
      expect(files[0]?.content.trim()).toBe('body text')
      expect(files[0]?.source).toBe('userSettings')
    } finally {
      spy.mockRestore()
    }
  })

  test('returns [] when the directory vanishes after the pre-check', async () => {
    const { configHome, cwd } = isolate('md-precheck-race')
    const userDir = join(configHome, 'skills')
    mkdirSync(userDir, { recursive: true })
    writeFileSync(join(userDir, 'doomed.md'), '# doomed\n', 'utf-8')

    // 预检查看到目录、随后目录被删、然后才轮到搜索 —— 真实竞态，用真 rg 收尾。
    const original = ripgrepModule.ripGrep
    const spy = spyOn(ripgrepModule, 'ripGrep').mockImplementation(
      async (args, target, signal) => {
        if (target === userDir) rmSync(userDir, { recursive: true, force: true })
        return original(args, target, signal)
      },
    )
    try {
      const files = await loadMarkdownFilesForSubdir('skills', cwd)
      expect(targetsOf(spy)).toContain(userDir)
      expect(files).toEqual([])
    } finally {
      spy.mockRestore()
    }
  })

  test('returns [] when the search itself rejects with ENOENT', async () => {
    // 第二道防线：`isFsInaccessible` 的 catch 分支。预检查通过之后目录消失，
    // 且搜索实现以 errno 拒绝（native 后端、或 rg 二进制本身缺失）时只有它兜底。
    const { configHome, cwd } = isolate('md-precheck-enoent')
    const userDir = join(configHome, 'workflows')
    mkdirSync(userDir, { recursive: true })

    const spy = spyOn(ripgrepModule, 'ripGrep').mockImplementation(
      async (_args, target) => {
        if (target === userDir) {
          throw Object.assign(
            new Error(`ENOENT: no such file or directory, scandir '${target}'`),
            { code: 'ENOENT' },
          )
        }
        return []
      },
    )
    try {
      const files = await loadMarkdownFilesForSubdir('workflows', cwd)
      expect(targetsOf(spy)).toContain(userDir)
      expect(files).toEqual([])
    } finally {
      spy.mockRestore()
    }
  })

  test('falls back to native discovery when the ripgrep executable is missing', async () => {
    const { configHome, cwd } = isolate('md-precheck-rg-missing')
    const userDir = join(configHome, 'output-styles')
    const filePath = join(userDir, 'concise.md')
    mkdirSync(userDir, { recursive: true })
    writeFileSync(filePath, '# concise\n', 'utf-8')

    const spy = spyOn(ripgrepModule, 'ripGrep').mockImplementation(
      async (_args, target) => {
        if (target === userDir) {
          throw Object.assign(new Error('spawn rg ENOENT'), {
            code: 'ENOENT',
            path: 'rg',
          })
        }
        return []
      },
    )
    try {
      const files = await loadMarkdownFilesForSubdir('output-styles', cwd)
      expect(targetsOf(spy)).toContain(userDir)
      expect(files.map(file => file.filePath)).toEqual([filePath])
      expect(files[0]?.content.trim()).toBe('# concise')
      expect(files[0]?.source).toBe('userSettings')
    } finally {
      spy.mockRestore()
    }
  })
})
