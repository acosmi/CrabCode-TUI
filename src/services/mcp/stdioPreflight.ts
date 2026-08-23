import { constants } from 'fs'
import { access, realpath, stat } from 'fs/promises'
import { delimiter, extname, isAbsolute, join } from 'path'
import type {
  McpServerConfig,
  McpStdioServerConfig,
} from './types.js'
import { getFlatBundleInstallRoot } from '../../utils/bundledMode.js'
import { resolvePluginComponentPath } from '../../utils/plugins/pluginPathSecurity.js'

export type PluginStdioPreflightResult =
  | {
      state: 'ready'
      config: McpStdioServerConfig
      cwd: string
      shell: false
    }
  | {
      state: 'requiresDependency'
      command: string
      reason: string
    }

export interface PluginStdioPreflightOptions {
  env?: Readonly<Record<string, string | undefined>>
  platform?: NodeJS.Platform
  /**
   * Release install root override. Left `undefined` (the default) the live
   * layout is resolved lazily through `getFlatBundleInstallRoot()`; passing
   * `null` asserts "not a release install" without touching the filesystem.
   */
  installRoot?: string | null
}

async function canonicalExecutable(
  candidate: string,
  platform: NodeJS.Platform,
): Promise<string | null> {
  try {
    const canonical = await realpath(candidate)
    if (!(await stat(canonical)).isFile()) return null
    // Windows does not expose POSIX executable bits. Existence + PATHEXT is
    // the platform's executable contract; POSIX uses X_OK.
    await access(
      canonical,
      platform === 'win32' ? constants.F_OK : constants.X_OK,
    )
    return canonical
  } catch {
    return null
  }
}

export function executableNamesForPlatform(
  command: string,
  platform: NodeJS.Platform,
  env: Readonly<Record<string, string | undefined>>,
): string[] {
  if (platform !== 'win32' || extname(command).length > 0) return [command]
  const pathExt = env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD'
  return pathExt
    .split(';')
    .map(ext => ext.trim())
    .filter(Boolean)
    .map(ext => `${command}${ext.toLowerCase()}`)
}

async function resolveBareExecutable(
  command: string,
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform,
): Promise<string | null> {
  const pathValue = env.PATH ?? env.Path ?? env.path ?? ''
  const names = executableNamesForPlatform(command, platform, env)
  const pathDelimiter = platform === 'win32' ? ';' : delimiter
  for (const directory of pathValue.split(pathDelimiter).filter(Boolean)) {
    for (const name of names) {
      const found = await canonicalExecutable(join(directory, name), platform)
      if (found) return found
    }
  }
  return null
}

/**
 * Runtime names a release install root owns a first-party copy of. Deliberately
 * closed: every other command still resolves through PATH exactly as before.
 */
const INSTALL_ROOT_RUNTIMES = new Set(['bun', 'node'])

/**
 * Prefer `<installRoot>/<name>.exe` over PATH for a bare `bun`/`node`.
 *
 * A Windows PATH lookup for a bare `bun` walks PATHEXT (`.COM;.EXE;.BAT;.CMD`)
 * and npm's global bin directory ships only `bun.cmd` — a batch shim that can
 * run only under `cmd.exe`. Each plugin MCP server then costs three processes
 * (wrapper + `cmd.exe` + the real `bun.exe`) instead of two. The release
 * install root holds the very `bun.exe` this runtime is already executing
 * under, so preferring it drops the shim hop and settles which `bun` a plugin
 * gets. On a hit it also skips the whole PATH walk, so it costs fewer syscalls
 * than the path it replaces.
 *
 * Windows-only on purpose: POSIX has no batch-shim layer, so the process count
 * there is already minimal, and repointing `bun`/`node` away from the user's
 * PATH toolchain would change behavior for no measured gain.
 *
 * Returns `null` whenever the runtime is absent, so the caller falls back to
 * the unchanged PATH resolution.
 */
async function resolveInstallRootRuntime(
  command: string,
  platform: NodeJS.Platform,
  installRoot: () => string | null,
): Promise<string | null> {
  if (platform !== 'win32') return null
  if (!INSTALL_ROOT_RUNTIMES.has(command)) return null
  const root = installRoot()
  if (!root) return null
  // The normal existence + canonicalization contract still applies, so a stale
  // or half-written install root falls through to PATH instead of being used.
  return canonicalExecutable(join(root, `${command}.exe`), platform)
}

function hasPathSeparator(command: string): boolean {
  return command.includes('/') || command.includes('\\')
}

/**
 * Resolve a plugin stdio command without spawning it or executing `--version`.
 * The returned command is an absolute canonical executable and `cwd` is the
 * canonical S2-contained plugin root. No shell/prefix expansion is permitted.
 */
export async function preflightPluginStdio(
  config: McpServerConfig,
  pluginRoot: string,
  options: PluginStdioPreflightOptions = {},
): Promise<PluginStdioPreflightResult> {
  if (config.type !== undefined && config.type !== 'stdio') {
    throw new Error('plugin stdio preflight requires a stdio config')
  }
  const stdio = config as McpStdioServerConfig
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  // Resolved lazily: only a bare `bun`/`node` on Windows ever needs it, so a
  // plugin naming anything else pays no filesystem probe for the install root.
  const installRoot = (): string | null =>
    options.installRoot !== undefined
      ? options.installRoot
      : getFlatBundleInstallRoot()
  const canonicalRoot = await resolvePluginComponentPath(pluginRoot, '.', {
    component: 'plugin MCP cwd',
  })

  let command: string | null = null

  if (stdio.command === 'bun' && env.CRABCODE_BUN_BIN) {
    command = await canonicalExecutable(env.CRABCODE_BUN_BIN, platform)
  }

  if (!command && isAbsolute(stdio.command)) {
    command = await canonicalExecutable(stdio.command, platform)
  } else if (!command && hasPathSeparator(stdio.command)) {
    try {
      const contained = await resolvePluginComponentPath(
        canonicalRoot,
        stdio.command,
        { component: 'plugin MCP executable' },
      )
      command = await canonicalExecutable(contained, platform)
    } catch {
      command = null
    }
  } else if (!command) {
    // Bare executable name: the release install root wins over PATH for the
    // runtimes it ships, and PATH resolution is unchanged for everything else.
    command =
      (await resolveInstallRootRuntime(stdio.command, platform, installRoot)) ??
      (await resolveBareExecutable(stdio.command, env, platform))
  }

  if (!command) {
    return {
      state: 'requiresDependency',
      command: stdio.command,
      reason: `Required runtime '${stdio.command}' is not available`,
    }
  }

  return {
    state: 'ready',
    config: { ...stdio, command },
    cwd: canonicalRoot,
    shell: false,
  }
}
