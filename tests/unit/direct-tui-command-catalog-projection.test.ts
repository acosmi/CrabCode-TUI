import { describe, expect, test } from 'bun:test'

import {
  DIRECT_TUI_COMMAND_CATALOG_ARGUMENT_HINT_MAX_UTF16_UNITS,
  DIRECT_TUI_COMMAND_CATALOG_DESCRIPTION_MAX_UTF16_UNITS,
  DIRECT_TUI_COMMAND_CATALOG_MAX_ENTRIES,
  DIRECT_TUI_COMMAND_CATALOG_NAME_MAX_UTF16_UNITS,
  projectCommandCatalogEntries as projectStandardCommandCatalogEntries,
  projectDirectTuiCommandCatalogEntries as projectCommandCatalogEntries,
} from '../../src/cli/commandCatalogProjection.js'
import {
  findCommand,
  matchesCommandInvocation,
  type Command,
} from '../../src/types/command.js'
import { parseFrontmatter } from '../../src/utils/frontmatterParser.js'
import { installBuiltInCommandNamesProvider } from '../../src/utils/builtInCommandNamesProvider.js'

function command(
  name: string,
  options: {
    aliases?: string[]
    argumentHint?: string
    description?: string
    userFacingName?: () => string
    userInvocable?: boolean
    isHidden?: boolean
    skillInterface?: Command['skillInterface']
  } = {},
): Command {
  return {
    type: 'local',
    name,
    description: options.description ?? `${name} description`,
    aliases: options.aliases,
    argumentHint: options.argumentHint,
    userFacingName: options.userFacingName,
    userInvocable: options.userInvocable,
    isHidden: options.isHidden,
    skillInterface: options.skillInterface,
  } as unknown as Command
}

describe('slash-command control catalog projection', () => {
  test('preserves the established standard projection independently of direct policy', () => {
    const modelOnly = command('model-only', {
      aliases: ['shared'],
      userInvocable: false,
    })
    const visible = command('shared', {
      aliases: ['visible-alias'],
      userFacingName: () => 'legacy-display',
    })

    expect(
      projectStandardCommandCatalogEntries(
        [modelOnly, visible],
        item => item.description,
      ).map(entry => entry.name),
    ).toEqual(['shared', 'visible-alias'])
  })

  // Name pinned by contracts/direct-tui-command-capabilities/v1 evidence
  // marker ts.catalog_projection: keep it verbatim. "First-wins order" is the
  // token-ownership order the projection resolves; rows are delivered sorted.
  test('projects canonical names and aliases in backend first-wins order', () => {
    const entries = projectCommandCatalogEntries(
      [
        command('alpha', {
          aliases: ['shared', 'alpha-alias'],
          argumentHint: '<alpha>',
        }),
        command('shared', {
          aliases: ['beta-alias', 'alpha'],
          argumentHint: '<beta>',
        }),
        command('gamma', {
          aliases: ['beta-alias', 'gamma-alias', 'gamma-alias'],
        }),
      ],
      item => `formatted: ${item.description}`,
    )

    expect(entries).toEqual([
      {
        name: 'alpha',
        description: 'formatted: alpha description',
        argumentHint: '<alpha>',
      },
      {
        name: 'alpha-alias',
        description: 'formatted: alpha description',
        argumentHint: '<alpha>',
        hidden: true,
      },
      {
        // `shared` lost its canonical token to `alpha`, so this alias is the
        // command's first published row and stays discoverable.
        name: 'beta-alias',
        description: 'formatted: shared description',
        argumentHint: '<beta>',
      },
      {
        name: 'gamma',
        description: 'formatted: gamma description',
        argumentHint: '',
      },
      {
        name: 'gamma-alias',
        description: 'formatted: gamma description',
        argumentHint: '',
        hidden: true,
      },
      {
        name: 'shared',
        description: 'formatted: alpha description',
        argumentHint: '<alpha>',
        hidden: true,
      },
    ])
  })

  test('publishes one discoverable row per command and hides alternate spellings', () => {
    const entries = projectCommandCatalogEntries(
      [
        command('clear', { aliases: ['reset', 'new'] }),
        command('compact', { aliases: ['com'] }),
      ],
      item => item.description,
    )

    expect(entries).toEqual([
      {
        name: 'clear',
        description: 'clear description',
        argumentHint: '',
      },
      {
        name: 'com',
        description: 'compact description',
        argumentHint: '',
        hidden: true,
      },
      {
        name: 'compact',
        description: 'compact description',
        argumentHint: '',
      },
      {
        name: 'new',
        description: 'clear description',
        argumentHint: '',
        hidden: true,
      },
      {
        name: 'reset',
        description: 'clear description',
        argumentHint: '',
        hidden: true,
      },
    ])
    expect(entries.filter(entry => entry.hidden !== true)).toHaveLength(2)
    // Every hidden alias still routes to its owner, so typing it keeps working.
    for (const entry of entries) {
      expect(
        findCommand(entry.name, [
          command('clear', { aliases: ['reset', 'new'] }),
          command('compact', { aliases: ['com'] }),
        ])?.description,
        entry.name,
      ).toBe(entry.description)
    }
  })

  test('keeps the canonical row hidden when the command itself is hidden', () => {
    const entries = projectCommandCatalogEntries(
      [command('secret', { aliases: ['secret-alias'], isHidden: true })],
      item => item.description,
    )

    expect(entries).toEqual([
      {
        name: 'secret',
        description: 'secret description',
        argumentHint: '',
        hidden: true,
      },
      {
        name: 'secret-alias',
        description: 'secret description',
        argumentHint: '',
        hidden: true,
      },
    ])
  })

  test('projects one identical array for any input order of the same commands', () => {
    const commands = [
      command('zulu', { aliases: ['zulu-alias'] }),
      command('alpha', { aliases: ['alpha-alias'], argumentHint: '<a>' }),
      command('mike'),
      command('bravo', { aliases: ['bravo-alias', 'bravo-second'] }),
      command('yankee', { userFacingName: () => 'yankee-legacy' }),
    ]
    const project = (order: readonly Command[]) =>
      projectCommandCatalogEntries(order, item => item.description)
    const reference = project(commands)

    expect(reference.map(entry => entry.name)).toEqual([
      'alpha',
      'alpha-alias',
      'bravo',
      'bravo-alias',
      'bravo-second',
      'mike',
      'yankee',
      'yankee-legacy',
      'zulu',
      'zulu-alias',
    ])
    // Every rotation and the full reversal of a collision-free registry must
    // serialize to the same bytes; discovery settles in a nondeterministic
    // order and the renderer replaces its whole model on any difference.
    for (let rotation = 1; rotation < commands.length; rotation += 1) {
      const rotated = [
        ...commands.slice(rotation),
        ...commands.slice(0, rotation),
      ]
      expect(project(rotated), `rotation ${rotation}`).toEqual(reference)
      expect(
        JSON.stringify(project(rotated)),
        `rotation ${rotation} serialization`,
      ).toBe(JSON.stringify(reference))
    }
    expect(project([...commands].reverse())).toEqual(reference)
    expect(JSON.stringify(project([...commands].reverse()))).toBe(
      JSON.stringify(reference),
    )
  })

  test('lets model-only commands claim backend tokens without advertising them', () => {
    const entries = projectCommandCatalogEntries(
      [
        command('model-only', {
          aliases: ['shared'],
          userInvocable: false,
        }),
        command('shared', { aliases: ['visible-alias'] }),
      ],
      item => item.description,
    )

    // Losing the canonical token to an earlier owner does not make this
    // command undiscoverable: `visible-alias` is its only publishable row, so
    // it is the visible one. Collapsing duplicates must never delete a command
    // from the palette.
    expect(entries).toEqual([
      {
        name: 'visible-alias',
        description: 'shared description',
        argumentHint: '',
      },
    ])
    expect(
      findCommand('shared', [
        command('model-only', {
          aliases: ['shared'],
          userInvocable: false,
        }),
        command('shared', { aliases: ['visible-alias'] }),
      ])?.name,
    ).toBe('model-only')
  })

  test('gives a command whose canonical token was claimed its one visible row', () => {
    const entries = projectCommandCatalogEntries(
      [
        command('token-owner', {
          aliases: ['claimed-canonical'],
          userInvocable: false,
        }),
        command('claimed-canonical', {
          aliases: ['first-surviving-alias', 'second-surviving-alias'],
        }),
      ],
      item => item.description,
    )

    // Hidden marks the *duplicate* spellings of a command, counted over the
    // rows the command actually published. The dropped canonical row must not
    // consume the visible slot, or this command would have zero rows.
    expect(entries).toEqual([
      {
        name: 'first-surviving-alias',
        description: 'claimed-canonical description',
        argumentHint: '',
      },
      {
        name: 'second-surviving-alias',
        description: 'claimed-canonical description',
        argumentHint: '',
        hidden: true,
      },
    ])
    expect(entries.filter(entry => entry.hidden !== true)).toHaveLength(1)
  })

  test('publishes only the legacy user-facing names that the dispatcher actually routes', () => {
    const legacy = command('stable-name', {
      aliases: ['documented-alias'],
      userFacingName: () => 'localized-display-name',
    })
    const interfaceDisplay = command('interface-stable-name', {
      userFacingName: () => 'display-only-name',
      skillInterface: { displayName: 'display-only-name' },
    })
    const entries = projectCommandCatalogEntries(
      [legacy, interfaceDisplay],
      item => item.description,
    )

    expect(entries.map(entry => entry.name)).toEqual([
      'documented-alias',
      'interface-stable-name',
      'localized-display-name',
      'stable-name',
    ])
    expect(
      entries
        .filter(entry => entry.hidden === true)
        .map(entry => entry.name),
    ).toEqual(['documented-alias', 'localized-display-name'])
    expect(findCommand('localized-display-name', [legacy])).toBe(legacy)
    expect(
      findCommand('display-only-name', [interfaceDisplay]),
    ).toBeUndefined()
  })

  test('keeps every advertised collision token bound to the real first dispatcher owner', () => {
    const modelOnly = command('model-only', {
      aliases: ['model-owned'],
      userInvocable: false,
    })
    const visibleAfterModel = command('model-owned', {
      aliases: ['visible-alias'],
    })
    const legacyOwner = command('legacy-owner', {
      userFacingName: () => 'display-collision',
    })
    const canonicalAfterLegacy = command('display-collision')
    const mcpPrompt = command('mcp__server__prompt', {
      userFacingName: () => 'server:prompt (MCP)',
    })
    const commands = [
      modelOnly,
      visibleAfterModel,
      legacyOwner,
      canonicalAfterLegacy,
      mcpPrompt,
    ]

    const entries = projectCommandCatalogEntries(
      commands,
      item => item.description,
    )

    expect(entries.map(entry => entry.name)).toEqual([
      'display-collision',
      'legacy-owner',
      'mcp__server__prompt',
      'server:prompt (MCP)',
      'visible-alias',
    ])
    for (const entry of entries) {
      const owner = findCommand(entry.name, commands)
      expect(owner, entry.name).toBeDefined()
      expect(entry.description, entry.name).toBe(owner?.description)
    }
    expect(findCommand('display-collision', commands)).toBe(legacyOwner)
    expect(findCommand('server:prompt (MCP)', commands)).toBe(mcpPrompt)
  })

  test('keeps canonical and alias matches lazy before the legacy display fallback', () => {
    let displayCalls = 0
    const lazy = command('canonical', {
      aliases: ['alias'],
      userFacingName: () => {
        displayCalls += 1
        return 'legacy-display'
      },
    })

    expect(matchesCommandInvocation(lazy, 'canonical')).toBe(true)
    expect(matchesCommandInvocation(lazy, 'alias')).toBe(true)
    expect(displayCalls).toBe(0)
    expect(matchesCommandInvocation(lazy, 'legacy-display')).toBe(true)
    expect(displayCalls).toBe(1)
  })

  test('isolates a throwing legacy display callback without changing matcher semantics', () => {
    let displayCalls = 0
    const throwingLegacy = command('throwing-canonical', {
      aliases: ['throwing-alias'],
      userFacingName: () => {
        displayCalls += 1
        throw new Error('untrusted legacy display callback failed')
      },
    })

    const entries = projectCommandCatalogEntries(
      [throwingLegacy, command('healthy-after-throw')],
      item => item.description,
    )

    expect(entries.map(entry => entry.name)).toEqual([
      'healthy-after-throw',
      'throwing-alias',
      'throwing-canonical',
    ])
    expect(displayCalls).toBe(1)
    expect(() =>
      matchesCommandInvocation(throwingLegacy, 'not-a-match'),
    ).toThrow('untrusted legacy display callback failed')
  })

  test('omits description-only rows whose names cannot roundtrip through the existing slash parser', () => {
    const entries = projectCommandCatalogEntries(
      [
        command('', { description: 'blank canonical description' }),
        command('valid', {
          aliases: ['', '   ', 'alias with argument tail', 'valid-alias'],
        }),
        command('mcp:tool (MCP)'),
      ],
      item => item.description,
    )

    expect(entries.map(entry => entry.name)).toEqual([
      'mcp:tool (MCP)',
      'valid',
      'valid-alias',
    ])
    expect(entries.every(entry => entry.name.trim().length > 0)).toBe(true)
  })

  test('retains commands but drops malformed runtime argument hints', () => {
    const malformed = [
      ['array-hint', ['project-name']],
      ['number-hint', 7],
      ['object-hint', { value: 'project-name' }],
    ] as const
    const entries = projectCommandCatalogEntries(
      malformed.map(([name, argumentHint]) =>
        command(name, {
          argumentHint: argumentHint as unknown as string,
        }),
      ),
      item => item.description,
    )

    expect(entries).toEqual(
      malformed.map(([name]) => ({
        name,
        description: `${name} description`,
        argumentHint: '',
      })),
    )
  })

  test('isolates malformed runtime aliases without coercing a new token', () => {
    const malformed = command('safe-canonical', {
      aliases: [Symbol('unsafe-runtime-alias') as unknown as string],
    })

    const entries = projectCommandCatalogEntries(
      [malformed, command('healthy-after-malformed-alias')],
      item => item.description,
    )

    expect(entries.map(entry => entry.name)).toEqual([
      'healthy-after-malformed-alias',
      'safe-canonical',
    ])
  })

  test('drops overlong tokens and safely bounds presentation UTF-16 units', () => {
    const overlongName = 'n'.repeat(
      DIRECT_TUI_COMMAND_CATALOG_NAME_MAX_UTF16_UNITS + 1,
    )
    const description =
      'd'.repeat(
        DIRECT_TUI_COMMAND_CATALOG_DESCRIPTION_MAX_UTF16_UNITS - 1,
      ) + '😀trailing'
    const argumentHint =
      'h'.repeat(
        DIRECT_TUI_COMMAND_CATALOG_ARGUMENT_HINT_MAX_UTF16_UNITS - 1,
      ) + '😀trailing'

    const entries = projectCommandCatalogEntries(
      [
        command(overlongName, {
          aliases: ['safe-alias'],
          description,
          argumentHint,
        }),
      ],
      item => item.description,
    )

    expect(entries).toHaveLength(1)
    expect(entries[0]?.name).toBe('safe-alias')
    // The canonical token was unrepresentable, so it never produced a row.
    // The surviving alias is this command's first published row and must stay
    // discoverable rather than hiding the command completely.
    expect(entries[0]?.hidden).toBeUndefined()
    expect(entries[0]?.description.length).toBe(
      DIRECT_TUI_COMMAND_CATALOG_DESCRIPTION_MAX_UTF16_UNITS - 1,
    )
    expect(entries[0]?.argumentHint.length).toBe(
      DIRECT_TUI_COMMAND_CATALOG_ARGUMENT_HINT_MAX_UTF16_UNITS - 1,
    )
    expect(entries[0]?.description.endsWith('d')).toBe(true)
    expect(entries[0]?.argumentHint.endsWith('h')).toBe(true)
  })

  test('caps the closed catalog without rewriting later command identities', () => {
    const entries = projectCommandCatalogEntries(
      Array.from(
        { length: DIRECT_TUI_COMMAND_CATALOG_MAX_ENTRIES + 2 },
        (_, index) => command(`entry-${index}`),
      ),
      item => item.description,
    )

    expect(entries).toHaveLength(DIRECT_TUI_COMMAND_CATALOG_MAX_ENTRIES)
    expect(
      entries.some(
        entry =>
          entry.name === `entry-${DIRECT_TUI_COMMAND_CATALOG_MAX_ENTRIES - 1}`,
      ),
    ).toBe(true)
    for (const overflow of [
      DIRECT_TUI_COMMAND_CATALOG_MAX_ENTRIES,
      DIRECT_TUI_COMMAND_CATALOG_MAX_ENTRIES + 1,
    ]) {
      expect(
        entries.some(entry => entry.name === `entry-${overflow}`),
        `entry-${overflow}`,
      ).toBe(false)
    }
    // The capped snapshot is delivered in the same code-unit order as any
    // other snapshot.
    const names = entries.map(entry => entry.name)
    expect(names).toEqual([...names].sort())
  })

  test('closes the real YAML array-hint path before initialize projection', () => {
    const parsed = parseFrontmatter(
      [
        '---',
        'description: Create an SDK project',
        'argument-hint: [project-name]',
        '---',
        'Create the project.',
      ].join('\n'),
      'commands/new-sdk-app.md',
    )
    expect(parsed.frontmatter['argument-hint']).toEqual(['project-name'])

    const [entry] = projectCommandCatalogEntries(
      [
        command('new-sdk-app', {
          argumentHint: parsed.frontmatter[
            'argument-hint'
          ] as unknown as string,
        }),
      ],
      item => item.description,
    )
    expect(entry).toEqual({
      name: 'new-sdk-app',
      description: 'new-sdk-app description',
      argumentHint: '',
    })
    expect(
      Object.values(entry!).every(value => typeof value === 'string'),
    ).toBe(true)
  })

  test('preserves hidden dispatch and builtin help metadata per invocation token', () => {
    installBuiltInCommandNamesProvider(
      () => new Set(['builtin-command', 'builtin-alias']),
    )
    try {
      const entries = projectCommandCatalogEntries(
        [
          command('builtin-command', {
            aliases: ['builtin-alias'],
            isHidden: true,
          }),
          command('custom-command'),
        ],
        item => item.description,
      )

      expect(entries).toEqual([
        {
          name: 'builtin-alias',
          description: 'builtin-command description',
          argumentHint: '',
          hidden: true,
          builtin: true,
        },
        {
          name: 'builtin-command',
          description: 'builtin-command description',
          argumentHint: '',
          hidden: true,
          builtin: true,
        },
        {
          name: 'custom-command',
          description: 'custom-command description',
          argumentHint: '',
        },
      ])
    } finally {
      installBuiltInCommandNamesProvider(() => new Set())
    }
  })

  test('drops malformed UTF-16 identities and sanitizes presentation metadata', () => {
    const entries = projectCommandCatalogEntries(
      [
        command(`trailing-high-\ud800`),
        command(`leading-low-\udc00`),
        command('valid-pair-😀', {
          description: `before\ud800after`,
          argumentHint: `hint\udc00tail`,
        }),
      ],
      item => item.description,
    )

    expect(entries).toEqual([
      {
        name: 'valid-pair-😀',
        description: 'before�after',
        argumentHint: 'hint�tail',
      },
    ])
  })

  test('contains malformed or throwing description providers per row', () => {
    const malformed = command('malformed-description') as Command & {
      description: unknown
    }
    malformed.description = { unexpected: true }

    const entries = projectCommandCatalogEntries(
      [malformed, command('throwing-description'), command('healthy')],
      item => {
        if (item.name === 'throwing-description') {
          throw new Error('dynamic formatter failed')
        }
        return item.description
      },
    )

    expect(entries).toEqual([
      {
        name: 'healthy',
        description: 'healthy description',
        argumentHint: '',
      },
      {
        name: 'malformed-description',
        description: '',
        argumentHint: '',
      },
      {
        name: 'throwing-description',
        description: '',
        argumentHint: '',
      },
    ])
  })
})
