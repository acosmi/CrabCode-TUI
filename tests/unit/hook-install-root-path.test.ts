import { describe, expect, test } from 'bun:test'

import { withInstallRootFirstOnPath } from '../../src/utils/hooks/hooks-executor.js'

/**
 * Windows hooks spawn through Git Bash, so a bare `bun` in a hook command hits
 * npm's `sh` shim (dirname + sed + uname + cygpath + bun.exe) before the real
 * runtime. Putting the release install root at the front of the child's PATH
 * makes the bare name resolve first-party and drops those four extra
 * processes. Every case pins `platform` explicitly so the suite asserts the
 * same contract on any host OS.
 */

const INSTALL_ROOT = 'C:\\Users\\dev\\.local\\share\\crabcode\\versions\\1.0.37'
const USER_PATH = 'C:\\Users\\dev\\AppData\\Roaming\\npm;C:\\Windows\\system32'

function pathKeys(env: NodeJS.ProcessEnv): string[] {
  return Object.keys(env).filter(key => key.toLowerCase() === 'path')
}

describe('withInstallRootFirstOnPath', () => {
  test('win32 + release install root prepends the root to PATH', () => {
    const result = withInstallRootFirstOnPath(
      { PATH: USER_PATH, CRABCODE_PROJECT_DIR: '/d/repo' },
      { platform: 'win32', installRoot: INSTALL_ROOT },
    )

    expect(result.PATH).toBe(`${INSTALL_ROOT};${USER_PATH}`)
    // Ahead of npm's shim directory, or the shim still wins the lookup.
    expect(result.PATH?.indexOf(INSTALL_ROOT)).toBe(0)
    // Exactly one PATH variable, still under its original casing.
    expect(pathKeys(result)).toEqual(['PATH'])
    // Nothing else in the environment is disturbed.
    expect(result.CRABCODE_PROJECT_DIR).toBe('/d/repo')
  })

  test('win32 + non-release layout leaves PATH byte-for-byte unchanged', () => {
    // `installRoot: null` is what getFlatBundleInstallRoot() returns for a repo
    // dev checkout — the branch that must stay inert.
    const result = withInstallRootFirstOnPath(
      { PATH: USER_PATH },
      { platform: 'win32', installRoot: null },
    )

    expect(result.PATH).toBe(USER_PATH)
    expect(pathKeys(result)).toEqual(['PATH'])
  })

  test('non-Windows platforms leave PATH byte-for-byte unchanged', () => {
    const posixPath = '/usr/local/bin:/usr/bin:/bin'
    for (const platform of ['darwin', 'linux'] as const) {
      const result = withInstallRootFirstOnPath(
        { PATH: posixPath },
        { platform, installRoot: INSTALL_ROOT },
      )

      expect(result.PATH).toBe(posixPath)
      expect(pathKeys(result)).toEqual(['PATH'])
    }
  })

  test('a `Path`-cased environment is rewritten in place, never duplicated', () => {
    // PowerShell and Explorer hand Node `Path`; Git Bash hands it `PATH`. A
    // spread of process.env keeps whichever the parent used, and emitting a
    // second casing would give the child two PATH variables.
    const result = withInstallRootFirstOnPath(
      { Path: USER_PATH },
      { platform: 'win32', installRoot: INSTALL_ROOT },
    )

    expect(pathKeys(result)).toEqual(['Path'])
    expect(result.Path).toBe(`${INSTALL_ROOT};${USER_PATH}`)
    expect(Object.hasOwn(result, 'PATH')).toBe(false)
  })

  test('a lowercase `path` key is likewise rewritten under its own name', () => {
    const result = withInstallRootFirstOnPath(
      { path: USER_PATH },
      { platform: 'win32', installRoot: INSTALL_ROOT },
    )

    expect(pathKeys(result)).toEqual(['path'])
    expect(result.path).toBe(`${INSTALL_ROOT};${USER_PATH}`)
  })

  test('an environment with no PATH at all gets the install root alone', () => {
    const result = withInstallRootFirstOnPath(
      {},
      { platform: 'win32', installRoot: INSTALL_ROOT },
    )

    expect(pathKeys(result)).toEqual(['PATH'])
    expect(result.PATH).toBe(INSTALL_ROOT)
  })

  test('an empty PATH value gets the install root alone, no leading delimiter', () => {
    const result = withInstallRootFirstOnPath(
      { Path: '' },
      { platform: 'win32', installRoot: INSTALL_ROOT },
    )

    expect(pathKeys(result)).toEqual(['Path'])
    expect(result.Path).toBe(INSTALL_ROOT)
  })

  // The helper is exported, so a caller may hand it `process.env` itself.
  // Rewriting PATH in place would mutate the live environment of the whole
  // runtime, not just the hook child about to be spawned.
  test('the environment object handed in is never mutated', () => {
    const original: NodeJS.ProcessEnv = { Path: USER_PATH, KEEP: 'me' }

    const result = withInstallRootFirstOnPath(original, {
      platform: 'win32',
      installRoot: INSTALL_ROOT,
    })

    expect(original.Path).toBe(USER_PATH)
    expect(result).not.toBe(original)
    expect(result.Path).toBe(`${INSTALL_ROOT};${USER_PATH}`)
    expect(result.KEEP).toBe('me')
  })
})
