import {
  getRoutableCommandInvocationNames,
  type Command,
} from 'src/types/command.js'
import { parseSlashCommand } from 'src/utils/slashCommandParsing.js'
import { getActiveBuiltInCommandNames } from 'src/utils/builtInCommandNamesProvider.js'

export const DIRECT_TUI_COMMAND_CATALOG_MAX_ENTRIES = 4_096
export const DIRECT_TUI_COMMAND_CATALOG_NAME_MAX_UTF16_UNITS = 512
export const DIRECT_TUI_COMMAND_CATALOG_DESCRIPTION_MAX_UTF16_UNITS = 16_384
export const DIRECT_TUI_COMMAND_CATALOG_ARGUMENT_HINT_MAX_UTF16_UNITS = 4_096

export type CommandCatalogEntry = {
  name: string
  description: string
  argumentHint: string
  hidden?: true
  builtin?: true
}

/** Preserve the established public SDK/headless catalog projection. */
export function projectCommandCatalogEntries(
  commands: readonly Command[],
  formatDescription: (command: Command) => string,
): CommandCatalogEntry[] {
  const claimedInvocationNames = new Set<string>()
  const entries: CommandCatalogEntry[] = []
  const builtInNames = getActiveBuiltInCommandNames()

  for (const command of commands) {
    if (command.userInvocable === false) continue

    const description = formatDescription(command)
    const argumentHint =
      typeof command.argumentHint === 'string' ? command.argumentHint : ''
    for (const name of [command.name, ...(command.aliases ?? [])]) {
      if (typeof name !== 'string') continue
      const parsed = parseSlashCommand('/' + name)
      if (!parsed || parsed.commandName !== name || parsed.args !== '') continue
      if (claimedInvocationNames.has(name)) continue
      claimedInvocationNames.add(name)
      entries.push({
        name,
        description,
        argumentHint,
        ...(command.isHidden === true ? { hidden: true as const } : {}),
        ...(builtInNames.has(name) ? { builtin: true as const } : {}),
      })
    }
  }

  return entries
}

/**
 * Project the ordered command registry onto the private direct-TUI catalog.
 * `hidden` and `builtin` are additive presentation metadata: hidden commands
 * retain exact typed dispatch ownership but stay out of renderer discovery,
 * while builtin lets Help partition runtime commands without guessing from a
 * second stale token list.
 *
 * The backend resolves slash invocations with `Array.find`, so the first
 * command whose actual routable name matches a token owns that token. Token
 * ownership is still claimed in that exact order: canonical name first,
 * declared aliases next, then the historical user-facing fallback where the
 * dispatcher still supports it.
 *
 * Each command contributes exactly one discoverable row: its first publishable
 * invocation. Every further row for the same command is an alternate spelling
 * of one command, so it is published as `hidden` — the renderer keeps routing
 * it verbatim, but stops listing `/clear`, `/reset`, and `/new` as three
 * separate commands. Normally that first row is the canonical name; when an
 * earlier first-wins owner already claimed the canonical token, the command's
 * first surviving alias takes the visible row, because the goal is to remove
 * duplicate rows, never to remove a command from discovery entirely.
 *
 * Entries are returned sorted by name in UTF-16 code-unit order. The registry
 * arrives in whatever order concurrent discovery loads settled in, and an
 * unordered catalog made every reload look like a content change and reshuffle
 * the renderer's palette. Ordering is presentation only; ownership above is
 * unaffected because each token is claimed exactly once.
 *
 * Callers pass an already stable-name-deduplicated command list. Model-only
 * commands remain undiscoverable, but still claim their backend-owned tokens
 * so a later visible command is never falsely advertised as their owner.
 */
export function projectDirectTuiCommandCatalogEntries(
  commands: readonly Command[],
  formatDescription: (command: Command) => string,
): CommandCatalogEntry[] {
  const claimedInvocationNames = new Set<string>()
  const entries: CommandCatalogEntry[] = []
  const builtInNames = getActiveBuiltInCommandNames()

  for (const command of commands) {
    let presentation:
      | { description: string; argumentHint: string }
      | undefined
    // Rows this command actually contributed, not positions in the routable
    // sequence: a token dropped as already-claimed, unparsable, overlong, or
    // malformed never had a row, so it must not consume this command's one
    // discoverable slot and make the command vanish from the palette.
    let publishedRowCount = 0
    const invocationNames = getRoutableCommandInvocationNames(command)
    while (true) {
      let nextName: IteratorResult<string>
      try {
        nextName = invocationNames.next()
      } catch {
        // Legacy userFacingName is an executable callback and Command does not
        // declare it no-throw. Canonical/alias rows already projected for this
        // command remain valid; omit only the unavailable legacy fallback and
        // continue building a bounded catalog for the remaining commands.
        break
      }
      if (nextName.done) break
      const name = nextName.value
      if (typeof name !== 'string') continue
      // Plugin/frontmatter values are runtime data despite Command's static
      // type. Only publish names that the existing slash parser can roundtrip
      // as one exact invocation with no accidental argument tail. This keeps
      // description-only rows out of the renderer without inventing or
      // rewriting a command token.
      const parsed = parseSlashCommand('/' + name)
      if (!parsed || parsed.commandName !== name || parsed.args !== '') continue
      if (claimedInvocationNames.has(name)) continue
      claimedInvocationNames.add(name)

      if (command.userInvocable === false) continue
      // Invocation identity cannot be truncated without creating a different
      // command. Keep the backend owner claimed, but omit an unrepresentable
      // token instead of letting one bad dynamic row reject the whole catalog.
      if (name.length > DIRECT_TUI_COMMAND_CATALOG_NAME_MAX_UTF16_UNITS) {
        continue
      }
      if (!isWellFormedUtf16(name)) continue
      if (entries.length >= DIRECT_TUI_COMMAND_CATALOG_MAX_ENTRIES) {
        return sortCatalogEntriesByName(entries)
      }
      // Presentation metadata is not routing identity, so it can be safely
      // bounded to the closed direct-TUI wire contract. Plugin/frontmatter
      // values remain runtime data despite Command's compile-time strings.
      if (!presentation) {
        let formattedDescription: unknown = ''
        try {
          formattedDescription = formatDescription(command)
        } catch {
          // A malformed dynamic command must not reject the complete catalog.
        }
        presentation = {
          description: truncateUtf16WithoutSplittingSurrogatePair(
            typeof formattedDescription === 'string'
              ? replaceUnpairedUtf16Surrogates(formattedDescription)
              : '',
            DIRECT_TUI_COMMAND_CATALOG_DESCRIPTION_MAX_UTF16_UNITS,
          ),
          argumentHint: truncateUtf16WithoutSplittingSurrogatePair(
            typeof command.argumentHint === 'string'
              ? replaceUnpairedUtf16Surrogates(command.argumentHint)
              : '',
            DIRECT_TUI_COMMAND_CATALOG_ARGUMENT_HINT_MAX_UTF16_UNITS,
          ),
        }
      }
      entries.push({
        name,
        description: presentation.description,
        argumentHint: presentation.argumentHint,
        ...(command.isHidden === true || publishedRowCount > 0
          ? { hidden: true as const }
          : {}),
        ...(builtInNames.has(name) ? { builtin: true as const } : {}),
      })
      publishedRowCount += 1
    }
  }

  return sortCatalogEntriesByName(entries)
}

/**
 * Order the closed catalog by UTF-16 code-unit comparison.
 *
 * `localeCompare` is deliberately unused: its result depends on the host ICU
 * data and the active locale, so it cannot give the renderer a byte-stable
 * snapshot across machines or across a locale change inside one session.
 */
function sortCatalogEntriesByName(
  entries: CommandCatalogEntry[],
): CommandCatalogEntry[] {
  return entries.sort((left, right) => {
    if (left.name < right.name) return -1
    if (left.name > right.name) return 1
    return 0
  })
}

export function isWellFormedUtf16(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index)
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false
      index += 1
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false
    }
  }
  return true
}

function replaceUnpairedUtf16Surrogates(value: string): string {
  let result = ''
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index)
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        result += value[index] + value[index + 1]
        index += 1
      } else {
        result += '\ufffd'
      }
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      result += '\ufffd'
    } else {
      result += value[index]
    }
  }
  return result
}

function truncateUtf16WithoutSplittingSurrogatePair(
  value: unknown,
  maximum: number,
): string {
  if (typeof value !== 'string') return ''
  if (value.length <= maximum) return value

  let end = maximum
  const lastCodeUnit = value.charCodeAt(end - 1)
  if (lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff) {
    end -= 1
  }
  return value.slice(0, end)
}
