import { describe, expect, test } from 'bun:test'

import {
  DIRECT_TUI_COMMAND_CATALOG_ARGUMENT_HINT_MAX_UTF16_UNITS,
  DIRECT_TUI_COMMAND_CATALOG_DESCRIPTION_MAX_UTF16_UNITS,
  DIRECT_TUI_COMMAND_CATALOG_MAX_ENTRIES,
  DIRECT_TUI_COMMAND_CATALOG_NAME_MAX_UTF16_UNITS,
  projectDirectTuiCommandCatalogEntries as projectCommandCatalogEntries,
} from '../../src/cli/commandCatalogProjection.js'
import {
  buildDirectTuiCommandCatalogChangedRequest,
  DirectTuiCommandCatalogLifecycle,
  DirectTuiCommandCatalogPublisher,
  DirectTuiCommandCatalogChangedRequestSchema,
  DirectTuiCommandCatalogChangedResponseSchema,
} from '../../src/cli/directTuiCommandCatalogRefresh.js'
import { StructuredIO } from '../../src/cli/structuredIO.js'
import { commandInventoryForRoute } from '../../src/cli/print/slashCommandRoutePolicy.js'
import { createStore } from '../../src/state/store.js'
import type { Command } from '../../src/types/command.js'

describe('direct TUI command catalog refresh private contract', () => {
  test('keeps published and executable MCP inventory aligned across every producer', async () => {
    const sent: string[][] = []
    const publisher = new DirectTuiCommandCatalogPublisher(
      async commands => {
        sent.push(commands.map(command => command.name))
      },
      error => {
        throw error
      },
    )
    const command = (name: string) => ({ name }) as Command
    const entry = (name: string) => ({
      name,
      description: name,
      argumentHint: '',
    })
    let runtimeCommands = [command('runtime-initial')]
    const store = createStore({
      mcpCommands: [command('mcp__server__initial')],
    })
    const currentInventory = () =>
      commandInventoryForRoute(
        true,
        runtimeCommands,
        store.getState().mcpCommands,
      )
    const publish = () =>
      publisher.update(currentInventory().map(item => entry(item.name)))
    const lifecycle = new DirectTuiCommandCatalogLifecycle<Command>(
      runtimeCommands,
      commands => {
        runtimeCommands = [...commands]
        publish()
      },
    )
    let observedMcpCommands = store.getState().mcpCommands
    const unsubscribe = store.subscribe(() => {
      const nextMcpCommands = store.getState().mcpCommands
      if (Object.is(nextMcpCommands, observedMcpCommands)) return
      observedMcpCommands = nextMcpCommands
      publish()
    })

    publisher.markInitialized()
    publish()
    await publisher.whenIdle()

    store.setState(() => ({
      mcpCommands: [
        command('mcp__server__initial'),
        command('mcp__server__late'),
      ],
    }))
    await publisher.whenIdle()

    store.setState(() => ({
      mcpCommands: [command('mcp__server__late')],
    }))
    await publisher.whenIdle()

    await lifecycle.refresh(async () => [command('runtime-refreshed')])
    await publisher.whenIdle()

    store.setState(() => ({ mcpCommands: [] }))
    await publisher.whenIdle()
    unsubscribe()

    expect(sent).toEqual([
      ['runtime-initial', 'mcp__server__initial'],
      [
        'runtime-initial',
        'mcp__server__initial',
        'mcp__server__late',
      ],
      ['runtime-initial', 'mcp__server__late'],
      ['runtime-refreshed', 'mcp__server__late'],
      ['runtime-refreshed'],
    ])
    expect(currentInventory().map(item => item.name)).toEqual(
      sent.at(-1),
    )
  })

  test('uses the existing correlated StructuredIO FIFO and validates the ACK', async () => {
    let deliverLine: ((line: string) => void) | undefined
    const line = new Promise<string>(resolve => {
      deliverLine = resolve
    })
    async function* input(): AsyncGenerator<string> {
      yield await line
    }
    const io = new StructuredIO(input())
    const inputCompletion = io.structuredInput.next()
    const result = io.requestDirectTuiCommandCatalogChanged([
      {
        name: 'compact',
        description: 'Compact',
        argumentHint: '',
        builtin: true,
      },
    ])
    const outbound = await io.outbound.next()
    expect(outbound.value).toMatchObject({
      type: 'control_request',
      request: {
        subtype: 'crabcode_tui_command_catalog_changed',
        protocol_version: 1,
        commands: [{ name: 'compact', builtin: true }],
      },
    })
    const requestId = (outbound.value as { request_id: string }).request_id
    deliverLine?.(
      JSON.stringify({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: requestId,
          response: { protocol_version: 1, received: true },
        },
      }),
    )

    expect(await result).toEqual({ protocol_version: 1, received: true })
    expect(await inputCompletion).toEqual({ done: true, value: undefined })
  })

  test('preserves dispatch and presentation metadata in one closed request', () => {
    expect(
      buildDirectTuiCommandCatalogChangedRequest([
        {
          name: 'compact',
          description: 'Compact the conversation',
          argumentHint: '',
          builtin: true,
        },
        {
          name: 'hidden-skill',
          description: 'Exact dispatch only',
          argumentHint: '<value>',
          hidden: true,
        },
      ]),
    ).toEqual({
      subtype: 'crabcode_tui_command_catalog_changed',
      protocol_version: 1,
      commands: [
        {
          name: 'compact',
          description: 'Compact the conversation',
          argumentHint: '',
          builtin: true,
        },
        {
          name: 'hidden-skill',
          description: 'Exact dispatch only',
          argumentHint: '<value>',
          hidden: true,
        },
      ],
    })
  })

  test('rejects unknown fields, invalid optional booleans, and loose ACKs', () => {
    expect(
      DirectTuiCommandCatalogChangedRequestSchema.safeParse({
        subtype: 'crabcode_tui_command_catalog_changed',
        protocol_version: 1,
        commands: [
          {
            name: 'mcp:tool (MCP)',
            description: 'MCP command',
            argumentHint: '',
          },
        ],
      }).success,
    ).toBe(true)
    expect(
      DirectTuiCommandCatalogChangedRequestSchema.safeParse({
        subtype: 'crabcode_tui_command_catalog_changed',
        protocol_version: 1,
        commands: [
          {
            name: 'compact',
            description: 'Compact',
            argumentHint: '',
            hidden: false,
          },
        ],
      }).success,
    ).toBe(false)
    for (const name of [
      ' compact',
      'compact ',
      'compact\targument',
      'compact\u00a0argument',
      'mcp:tool  (MCP)',
    ]) {
      expect(
        DirectTuiCommandCatalogChangedRequestSchema.safeParse({
          subtype: 'crabcode_tui_command_catalog_changed',
          protocol_version: 1,
          commands: [{ name, description: '', argumentHint: '' }],
        }).success,
        name,
      ).toBe(false)
    }
    expect(
      DirectTuiCommandCatalogChangedRequestSchema.safeParse({
        subtype: 'crabcode_tui_command_catalog_changed',
        protocol_version: 1,
        commands: [
          { name: '   ', description: '', argumentHint: '' },
        ],
      }).success,
    ).toBe(false)
    expect(
      DirectTuiCommandCatalogChangedRequestSchema.safeParse({
        subtype: 'crabcode_tui_command_catalog_changed',
        protocol_version: 1,
        commands: [
          { name: 'compact', description: '', argumentHint: '' },
          { name: 'compact', description: '', argumentHint: '' },
        ],
      }).success,
    ).toBe(false)
    expect(
      DirectTuiCommandCatalogChangedRequestSchema.safeParse({
        subtype: 'crabcode_tui_command_catalog_changed',
        protocol_version: 1,
        commands: [],
        future: true,
      }).success,
    ).toBe(false)
    expect(
      DirectTuiCommandCatalogChangedResponseSchema.safeParse({
        protocol_version: 1,
        received: true,
      }).success,
    ).toBe(true)
    expect(
      DirectTuiCommandCatalogChangedResponseSchema.safeParse({
        protocol_version: 1,
        received: true,
        ignored: true,
      }).success,
    ).toBe(false)
  })

  test('shares exact UTF-16 and entry bounds with the catalog projector', () => {
    const exactBoundaryCommand = {
      name: 'n'.repeat(
        DIRECT_TUI_COMMAND_CATALOG_NAME_MAX_UTF16_UNITS,
      ),
      type: 'prompt',
      description: 'd'.repeat(
        DIRECT_TUI_COMMAND_CATALOG_DESCRIPTION_MAX_UTF16_UNITS,
      ),
      argumentHint: 'h'.repeat(
        DIRECT_TUI_COMMAND_CATALOG_ARGUMENT_HINT_MAX_UTF16_UNITS,
      ),
      progressMessage: 'running',
      getPromptForCommand: () => [],
    } satisfies Command
    const projected = projectCommandCatalogEntries(
      [exactBoundaryCommand],
      command => command.description,
    )
    expect(projected).toHaveLength(1)
    expect(
      DirectTuiCommandCatalogChangedRequestSchema.safeParse(
        buildDirectTuiCommandCatalogChangedRequest(projected),
      ).success,
    ).toBe(true)

    const boundaryEntry = projected[0]!
    for (const invalidEntry of [
      {
        ...boundaryEntry,
        name: boundaryEntry.name + 'n',
      },
      {
        ...boundaryEntry,
        description: boundaryEntry.description + 'd',
      },
      {
        ...boundaryEntry,
        argumentHint: boundaryEntry.argumentHint + 'h',
      },
    ]) {
      expect(
        DirectTuiCommandCatalogChangedRequestSchema.safeParse(
          {
            subtype: 'crabcode_tui_command_catalog_changed',
            protocol_version: 1,
            commands: [invalidEntry],
          },
        ).success,
      ).toBe(false)
    }

    for (const invalidEntry of [
      { ...boundaryEntry, name: `bad-\ud800` },
      { ...boundaryEntry, description: `bad-\udc00` },
      { ...boundaryEntry, argumentHint: `bad-\ud800` },
    ]) {
      expect(
        DirectTuiCommandCatalogChangedRequestSchema.safeParse({
          subtype: 'crabcode_tui_command_catalog_changed',
          protocol_version: 1,
          commands: [invalidEntry],
        }).success,
      ).toBe(false)
    }

    const maximumEntries = Array.from(
      { length: DIRECT_TUI_COMMAND_CATALOG_MAX_ENTRIES },
      (_, index) => ({
        name: `command-${index}`,
        description: '',
        argumentHint: '',
      }),
    )
    expect(
      DirectTuiCommandCatalogChangedRequestSchema.safeParse(
        buildDirectTuiCommandCatalogChangedRequest(maximumEntries),
      ).success,
    ).toBe(true)
    expect(
      DirectTuiCommandCatalogChangedRequestSchema.safeParse(
        {
          subtype: 'crabcode_tui_command_catalog_changed',
          protocol_version: 1,
          commands: [
            ...maximumEntries,
            {
              name: 'one-command-too-many',
              description: '',
              argumentHint: '',
            },
          ],
        },
      ).success,
    ).toBe(false)
  })

  test('holds pre-initialize changes and coalesces in-flight updates latest-wins', async () => {
    const sends: string[][] = []
    const releases: Array<() => void> = []
    const publisher = new DirectTuiCommandCatalogPublisher(
      commands => {
        sends.push(commands.map(command => command.name))
        return new Promise<void>(resolve => releases.push(resolve))
      },
      error => {
        throw error
      },
    )
    const entry = (name: string) => ({
      name,
      description: name,
      argumentHint: '',
    })

    publisher.update([entry('before-a')])
    publisher.update([entry('before-b')])
    expect(sends).toEqual([])

    publisher.markInitialized()
    await Promise.resolve()
    expect(sends).toEqual([['before-b']])

    publisher.update([entry('during-a')])
    publisher.update([entry('during-latest')])
    expect(sends).toEqual([['before-b']])
    releases.shift()?.()
    await Promise.resolve()
    await Promise.resolve()
    expect(sends).toEqual([['before-b'], ['during-latest']])
    releases.shift()?.()
    await publisher.whenIdle()

    publisher.close()
    publisher.update([entry('after-close')])
    await publisher.whenIdle()
    expect(sends).toEqual([['before-b'], ['during-latest']])
  })

  test('drops a re-projected snapshot that only differs in discovery order', async () => {
    const sends: string[][] = []
    const publisher = new DirectTuiCommandCatalogPublisher(
      async commands => {
        sends.push(commands.map(entry => entry.name))
      },
      error => {
        throw error
      },
    )
    const command = (name: string, aliases?: string[]) =>
      ({
        type: 'local',
        name,
        description: `${name} description`,
        aliases,
      }) as unknown as Command
    const project = (commands: readonly Command[]) =>
      projectCommandCatalogEntries(commands, item => item.description)
    // The same registry, loaded in the order two concurrent discovery passes
    // happened to settle in.
    const firstLoadOrder = [
      command('clear', ['reset', 'new']),
      command('compact', ['com']),
      command('review'),
    ]
    const secondLoadOrder = [
      command('review'),
      command('clear', ['reset', 'new']),
      command('compact', ['com']),
    ]
    const delivered = ['clear', 'com', 'compact', 'new', 'reset', 'review']

    publisher.markInitialized()
    publisher.update(project(firstLoadOrder))
    await publisher.whenIdle()
    expect(sends).toEqual([delivered])

    publisher.update(project(secondLoadOrder))
    await publisher.whenIdle()
    expect(sends).toEqual([delivered])

    publisher.update(project([...secondLoadOrder, command('added')]))
    await publisher.whenIdle()
    expect(sends).toEqual([delivered, ['added', ...delivered]])
  })

  test('republishes only when the delivered catalog content really changed', async () => {
    const sends: Array<Array<[string, string]>> = []
    const publisher = new DirectTuiCommandCatalogPublisher(
      async commands => {
        sends.push(
          commands.map(entry => [entry.name, entry.description] as [
            string,
            string,
          ]),
        )
      },
      error => {
        throw error
      },
    )
    const entry = (name: string, description = name) => ({
      name,
      description,
      argumentHint: '',
    })

    publisher.markInitialized()
    publisher.update([entry('alpha'), entry('beta')])
    await publisher.whenIdle()
    expect(sends).toEqual([
      [
        ['alpha', 'alpha'],
        ['beta', 'beta'],
      ],
    ])

    // A structurally equal snapshot from a fresh projection is not a change.
    publisher.update([entry('alpha'), entry('beta')])
    await publisher.whenIdle()
    expect(sends).toHaveLength(1)

    // Presentation-only differences are still real catalog changes.
    publisher.update([entry('alpha'), entry('beta', 'beta rewritten')])
    await publisher.whenIdle()
    expect(sends).toEqual([
      [
        ['alpha', 'alpha'],
        ['beta', 'beta'],
      ],
      [
        ['alpha', 'alpha'],
        ['beta', 'beta rewritten'],
      ],
    ])
  })

  test('still publishes a revert that races an unacknowledged snapshot', async () => {
    const sends: string[][] = []
    const releases: Array<() => void> = []
    const publisher = new DirectTuiCommandCatalogPublisher(
      commands => {
        sends.push(commands.map(entry => entry.name))
        return new Promise<void>(resolve => releases.push(resolve))
      },
      error => {
        throw error
      },
    )
    const entry = (name: string) => ({
      name,
      description: name,
      argumentHint: '',
    })
    const settleMicrotasks = async () => {
      for (let turn = 0; turn < 8; turn += 1) await Promise.resolve()
    }

    publisher.markInitialized()
    publisher.update([entry('installed')])
    await settleMicrotasks()
    expect(sends).toEqual([['installed']])
    releases.shift()?.()
    await settleMicrotasks()

    publisher.update([entry('uninstalled')])
    await settleMicrotasks()
    expect(sends).toEqual([['installed'], ['uninstalled']])

    // The reinstall lands while the uninstall is still unacknowledged; the
    // last delivered snapshot alone would wrongly suppress it and leave Rust
    // holding the superseded catalog.
    publisher.update([entry('installed')])
    releases.shift()?.()
    await settleMicrotasks()
    expect(sends).toEqual([
      ['installed'],
      ['uninstalled'],
      ['installed'],
    ])

    releases.shift()?.()
    await publisher.whenIdle()
    expect(sends).toHaveLength(3)
  })

  test('queues an owning auth response before its follow-up reverse refresh', async () => {
    const order: string[] = []
    const publisher = new DirectTuiCommandCatalogPublisher(
      async () => {
        order.push('catalog-refresh')
      },
      error => {
        throw error
      },
    )
    publisher.markInitialized()

    publisher.update([
      { name: 'account-command', description: '', argumentHint: '' },
    ])
    order.push('auth-control-response')
    await publisher.whenIdle()

    expect(order).toEqual(['auth-control-response', 'catalog-refresh'])
  })

  test('holds an async owning refresh until its correlated response is queued', async () => {
    const order: string[] = []
    const publisher = new DirectTuiCommandCatalogPublisher(
      async () => {
        order.push('catalog-refresh')
      },
      error => {
        throw error
      },
    )
    publisher.markInitialized()
    const release = publisher.hold()

    await Promise.resolve()
    publisher.update([
      { name: 'async-command', description: '', argumentHint: '' },
    ])
    await Promise.resolve()
    expect(order).toEqual([])

    order.push('correlated-response')
    release()
    release()
    await publisher.whenIdle()
    expect(order).toEqual(['correlated-response', 'catalog-refresh'])
  })

  test('keeps nested holds independent and releases after an owner failure', async () => {
    const sends: string[] = []
    const publisher = new DirectTuiCommandCatalogPublisher(
      async commands => {
        sends.push(commands[0]?.name ?? '')
      },
      () => {},
    )
    publisher.markInitialized()
    const releaseOuter = publisher.hold()
    const releaseInner = publisher.hold()
    publisher.update([{ name: 'held', description: '', argumentHint: '' }])

    releaseInner()
    await Promise.resolve()
    expect(sends).toEqual([])
    releaseOuter()
    await publisher.whenIdle()
    expect(sends).toEqual(['held'])
  })

  test('does not retry a failed snapshot until a newer change arrives', async () => {
    const attempts: string[][] = []
    const errors: string[] = []
    let fail = true
    const publisher = new DirectTuiCommandCatalogPublisher(
      async commands => {
        attempts.push(commands.map(command => command.name))
        if (fail) throw new Error('fixture transport closed')
      },
      error => errors.push(String(error)),
    )
    const entry = (name: string) => ({
      name,
      description: name,
      argumentHint: '',
    })

    publisher.markInitialized()
    publisher.update([entry('failed')])
    await publisher.whenIdle()
    expect(attempts).toEqual([['failed']])
    expect(errors).toEqual(['Error: fixture transport closed'])

    fail = false
    publisher.update([entry('newer')])
    await publisher.whenIdle()
    expect(attempts).toEqual([['failed'], ['newer']])
  })

  test('keeps async plugin, skill, reload, login, and logout producers on one newest-successful lifecycle', async () => {
    type Entry = { name: string }
    let releaseBackgroundPlugin: ((commands: Entry[]) => void) | undefined
    const backgroundPlugin = new Promise<Entry[]>(resolve => {
      releaseBackgroundPlugin = resolve
    })
    const commits: string[][] = []
    const lifecycle = new DirectTuiCommandCatalogLifecycle<Entry>(
      [{ name: 'initial' }],
      commands => commits.push(commands.map(command => command.name)),
    )

    // Non-sync installation begins first but completes after the skill watch.
    // Its older snapshot must not overwrite the newer successful refresh.
    const nonSyncInstall = lifecycle.refresh(() => backgroundPlugin)
    await lifecycle.refresh(async () => [{ name: 'skill-change' }])
    releaseBackgroundPlugin?.([{ name: 'late-plugin' }])
    await nonSyncInstall
    expect(lifecycle.snapshot()).toEqual([{ name: 'skill-change' }])

    // The sync install path awaits the same refresh seam before the first ask.
    await lifecycle.refresh(async () => [{ name: 'sync-plugin' }])

    // Manual reload and auth transitions can return commands from helpers;
    // replace() still assigns a lifecycle revision and publishes atomically.
    lifecycle.replace([{ name: 'manual-reload' }])
    lifecycle.replace([{ name: 'login-only-command' }])
    lifecycle.replace([{ name: 'logout-only-command' }])

    expect(commits).toEqual([
      ['skill-change'],
      ['sync-plugin'],
      ['manual-reload'],
      ['login-only-command'],
      ['logout-only-command'],
    ])
    expect(lifecycle.snapshot()).toEqual([{ name: 'logout-only-command' }])
  })

  test('does not let close races publish a late background refresh', async () => {
    let release: ((commands: Array<{ name: string }>) => void) | undefined
    const loaded = new Promise<Array<{ name: string }>>(resolve => {
      release = resolve
    })
    const commits: string[][] = []
    const lifecycle = new DirectTuiCommandCatalogLifecycle(
      [{ name: 'initial' }],
      commands => commits.push(commands.map(command => command.name)),
    )

    const refresh = lifecycle.refresh(() => loaded)
    lifecycle.close()
    release?.([{ name: 'too-late' }])
    await refresh

    expect(commits).toEqual([])
    expect(lifecycle.snapshot()).toEqual([{ name: 'initial' }])
    expect(lifecycle.replace([{ name: 'after-close' }])).toBe(false)
  })

  test('allows an older successful load to recover when a newer load fails', async () => {
    let releaseOlder: ((commands: Array<{ name: string }>) => void) | undefined
    const olderLoad = new Promise<Array<{ name: string }>>(resolve => {
      releaseOlder = resolve
    })
    const commits: string[][] = []
    const lifecycle = new DirectTuiCommandCatalogLifecycle(
      [{ name: 'initial' }],
      commands => commits.push(commands.map(command => command.name)),
    )

    const olderRefresh = lifecycle.refresh(() => olderLoad)
    await expect(
      lifecycle.refresh(async () => {
        throw new Error('newer skill snapshot is malformed')
      }),
    ).rejects.toThrow('newer skill snapshot is malformed')
    releaseOlder?.([{ name: 'older-valid' }])
    await olderRefresh

    expect(commits).toEqual([['older-valid']])
    expect(lifecycle.snapshot()).toEqual([{ name: 'older-valid' }])
  })

  test('bounds the idle barrier to refreshes registered at its call boundary', async () => {
    type Entry = { name: string }
    let releaseFirst!: (commands: Entry[]) => void
    let releaseSecond!: (commands: Entry[]) => void
    const firstLoad = new Promise<Entry[]>(resolve => {
      releaseFirst = resolve
    })
    const secondLoad = new Promise<Entry[]>(resolve => {
      releaseSecond = resolve
    })
    const lifecycle = new DirectTuiCommandCatalogLifecycle<Entry>(
      [{ name: 'initial' }],
      () => {},
    )

    const firstRefresh = lifecycle.refresh(() => firstLoad)
    let barrierResolved = false
    const barrier = lifecycle.whenIdle().then(snapshot => {
      barrierResolved = true
      return snapshot
    })
    await Promise.resolve()

    const secondRefresh = lifecycle.refresh(() => secondLoad)
    releaseFirst([{ name: 'first' }])
    await firstRefresh
    expect(await barrier).toEqual([{ name: 'first' }])
    expect(barrierResolved).toBe(true)

    releaseSecond([{ name: 'second' }])
    await secondRefresh
    expect(lifecycle.snapshot()).toEqual([{ name: 'second' }])
  })

  test('idle barrier observes failed refresh settlement without stealing its rejection', async () => {
    const lifecycle = new DirectTuiCommandCatalogLifecycle(
      [{ name: 'last-success' }],
      () => {},
    )
    const failedRefresh = lifecycle.refresh(async () => {
      throw new Error('catalog load failed')
    })
    const observedFailure = failedRefresh.catch(error => String(error))

    expect(await lifecycle.whenIdle()).toEqual([{ name: 'last-success' }])
    expect(await observedFailure).toBe('Error: catalog load failed')
    expect(lifecycle.snapshot()).toEqual([{ name: 'last-success' }])
  })

  test('contains diagnostic callback failures and sends nothing after pre-init close', async () => {
    const attempts: string[][] = []
    const publisher = new DirectTuiCommandCatalogPublisher(
      async commands => {
        attempts.push(commands.map(command => command.name))
        throw new Error('transport failed')
      },
      () => {
        throw new Error('diagnostics failed')
      },
    )

    publisher.markInitialized()
    publisher.update([
      { name: 'attempt', description: '', argumentHint: '' },
    ])
    await publisher.whenIdle()
    expect(attempts).toEqual([['attempt']])

    const preInitAttempts: string[][] = []
    const preInit = new DirectTuiCommandCatalogPublisher(
      async commands => {
        preInitAttempts.push(commands.map(command => command.name))
      },
      () => {},
    )
    preInit.update([
      { name: 'held', description: '', argumentHint: '' },
    ])
    preInit.close()
    preInit.markInitialized()
    await preInit.whenIdle()
    expect(preInitAttempts).toEqual([])

    let releaseInFlight: (() => void) | undefined
    const inFlightAttempts: string[][] = []
    const inFlight = new DirectTuiCommandCatalogPublisher(
      commands => {
        inFlightAttempts.push(commands.map(command => command.name))
        return new Promise<void>(resolve => {
          releaseInFlight = resolve
        })
      },
      () => {},
    )
    inFlight.markInitialized()
    inFlight.update([
      { name: 'already-sent', description: '', argumentHint: '' },
    ])
    await Promise.resolve()
    expect(inFlightAttempts).toEqual([['already-sent']])
    inFlight.update([
      { name: 'queued-before-close', description: '', argumentHint: '' },
    ])
    inFlight.close()
    releaseInFlight?.()
    await inFlight.whenIdle()
    expect(inFlightAttempts).toEqual([['already-sent']])
  })
})
