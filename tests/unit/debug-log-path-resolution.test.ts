// 2026-08-23 Windows 启动/输入延迟审计 P1-8 —— `CRABCODE_DEBUG_LOGS_DIR` 被当成
// 文件路径，指向目录时启动即崩。
//
// 变量名是 `_DIR`，`getDebugLogPath()` 的兜底分支也是「目录 + `<session>.txt`」，
// 但中间那条分支把整个值原样当文件路径返回。按字面含义传一个目录进去，第一次写日志
// 就是 `EISDIR: illegal operation on a directory, write` → EXIT 1：一个专门用来排障
// 的开关会亲手杀掉被排障的进程，并且连带打不开 `CRABCODE_PROFILE_STARTUP`（它的报告
// 经 `logForDebugging` 走同一条链）。
//
// 这里钉四种取值：
//   (a) 已存在的文件路径 —— 原样使用，老用法必须不变；
//   (b) 已存在的目录 —— 追加 `<session>.txt`；
//   (c) 不存在但以路径分隔符结尾 —— 也按目录处理（调用者写 `\` 或 `/` 就是在说
//       「这是目录」，此刻它还没被建出来而已）。Windows 上 `\` 和 `/` 都算；
//   (d) 空串 —— 视同未设置，走兜底。否则 `??` 会让空串胜出，交给 appendFileSync
//       一个打不开的路径，崩法与 (b) 同类。
//
// 断言写成「路径落在目录内且以 `<sessionId>.txt` 结尾」，而不是硬编码某个文件名，
// 这样它钉的是「目录 + 会话文件」这条语义，而不是 session id 的具体形态。
//
// 隔离：只动 `CRABCODE_DEBUG_LOGS_DIR` 与 `CRABCODE_CONFIG_DIR`，afterEach 恢复原值；
// 不碰 `HOME`（Bun 的 `os.homedir()` 首调即缓存）。

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'fs'
import { join, sep } from 'path'

import { getSessionId } from '../../src/bootstrap/state.js'
import { createTestDir } from '../setup.js'
import { getDebugLogPath } from '../../src/utils/debug.js'

const previousLogsDir = process.env.CRABCODE_DEBUG_LOGS_DIR
let caseDir: string

beforeEach(() => {
  caseDir = createTestDir('debug-log-path')
})

afterEach(() => {
  if (previousLogsDir === undefined) delete process.env.CRABCODE_DEBUG_LOGS_DIR
  else process.env.CRABCODE_DEBUG_LOGS_DIR = previousLogsDir
})

/** 该目录下、属于本会话的日志文件路径。 */
function sessionFileIn(dir: string): string {
  return join(dir, `${getSessionId()}.txt`)
}

describe('getDebugLogPath honours CRABCODE_DEBUG_LOGS_DIR (P1-8)', () => {
  test('(a) an existing file path is used as-is', () => {
    const file = join(caseDir, 'explicit.log')
    writeFileSync(file, '', 'utf-8')
    process.env.CRABCODE_DEBUG_LOGS_DIR = file

    expect(getDebugLogPath()).toBe(file)
  })

  test('(b) an existing directory gets the session file appended', () => {
    const dir = join(caseDir, 'logs-existing')
    mkdirSync(dir, { recursive: true })
    process.env.CRABCODE_DEBUG_LOGS_DIR = dir

    // 修复前这里返回 `dir` 本身，第一次写就是 EISDIR。
    expect(getDebugLogPath()).toBe(sessionFileIn(dir))
    expect(getDebugLogPath()).not.toBe(dir)
  })

  test('(c) a not-yet-created path with a trailing separator is treated as a directory', () => {
    const dir = join(caseDir, 'logs-not-created')
    process.env.CRABCODE_DEBUG_LOGS_DIR = `${dir}${sep}`

    expect(getDebugLogPath()).toBe(sessionFileIn(dir))
  })

  test('(c/win) a trailing forward slash also reads as a directory', () => {
    // Windows 接受正斜杠写法，用户/脚本经常这么写；POSIX 上 `/` 本就是分隔符。
    const dir = join(caseDir, 'logs-forward-slash')
    process.env.CRABCODE_DEBUG_LOGS_DIR = `${dir}/`

    expect(getDebugLogPath()).toBe(join(dir, `${getSessionId()}.txt`))
  })

  test('(d) an empty value falls back instead of yielding an unopenable path', () => {
    process.env.CRABCODE_DEBUG_LOGS_DIR = ''
    const fallback = getDebugLogPath()

    expect(fallback).not.toBe('')
    expect(fallback.endsWith(`${sep}debug${sep}${getSessionId()}.txt`)).toBe(true)
  })

  test('a path that does not exist and has no trailing separator stays a file path', () => {
    // 没有任何「我是目录」的信号时，仍按显式文件路径处理 —— 这是 (a) 的用户在
    // 日志文件尚未创建时的形态，不能被 (b)/(c) 顺手改掉。
    const file = join(caseDir, 'nested', 'not-created-yet.log')
    process.env.CRABCODE_DEBUG_LOGS_DIR = file

    expect(getDebugLogPath()).toBe(file)
  })
})
