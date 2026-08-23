import {
  afterAll,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from 'bun:test'
import type { Command } from '../../src/types/command.js'
import type { StdoutMessage } from '../../src/entrypoints/sdk/controlTypes.js'
import type { StructuredIO } from '../../src/cli/structuredIO.js'
import { getDefaultAppState } from '../../src/state/AppStateStore.js'

const auth = await import('../../src/utils/auth.js')
const catalog = await import('../../src/cli/headlessCommands.js')
const catalogRefresh = await import(
  '../../src/cli/directTuiCommandCatalogRefresh.js'
)
const handlers = await import('../../src/cli/print/sdkControlHandlers.js')
const localAuthState = await import(
  '../../src/services/auth/localAuthState.js'
)
const oauthInstall = await import(
  '../../src/services/auth/installOAuthTokens.js'
)

const subscriber = spyOn(auth, 'isAcosmiSubscriber')

function command(name: string): Command {
  return {
    type: 'local',
    name,
    description: `Description for ${name}`,
    supportsNonInteractive: true,
    load: async () => ({
      call: async () => ({ type: 'text', value: '' }),
    }),
  }
}

beforeEach(() => {
  subscriber.mockReturnValue(false)
  catalog.clearHeadlessCommandMemoizationCaches()
})

afterAll(() => {
  subscriber.mockRestore()
  catalog.clearHeadlessCommandMemoizationCaches()
})

describe('direct TUI authentication control lifecycle', () => {
  test('initialize resolves a lazy command catalog immediately before enqueueing its response', async () => {
    const messages: StdoutMessage[] = []
    let releaseCatalog!: (commands: readonly Command[]) => void
    let markResolverEntered!: () => void
    const resolverEntered = new Promise<void>(resolve => {
      markResolverEntered = resolve
    })
    const catalogReady = new Promise<readonly Command[]>(resolve => {
      releaseCatalog = resolve
    })

    const initialization = handlers.handleInitializeRequest(
      { subtype: 'initialize' },
      'initialize-lazy-catalog',
      false,
      { enqueue: message => messages.push(message) },
      async () => {
        markResolverEntered()
        return catalogReady
      },
      [],
      {} as StructuredIO,
      false,
      {
        systemPrompt: undefined,
        appendSystemPrompt: undefined,
        agent: undefined,
        userSpecifiedModel: undefined,
      },
      [],
      getDefaultAppState,
    )

    await resolverEntered
    expect(messages).toEqual([])
    releaseCatalog([command('late-initialize-command')])
    await initialization

    const response = messages[0] as Extract<
      StdoutMessage,
      { type: 'control_response' }
    >
    expect(response.response.response?.commands).toMatchObject([
      { name: 'late-initialize-command' },
    ])
  })

  test('correlated auth catalogs use the committed route inventory on their first response', async () => {
    const base = command('public-after-auth-transition')
    const liveMcp = command('mcp__live__prompt')

    expect(
      handlers.withCurrentControlAuthCommandCatalog(
        { account: { email: 'signed-in@example.invalid' }, commands: [] },
        [base, liveMcp],
      ),
    ).toMatchObject({
      account: { email: 'signed-in@example.invalid' },
      commands: [
        { name: 'public-after-auth-transition' },
        { name: 'mcp__live__prompt' },
      ],
    })

    for (const slashCommandsEnabled of [true, false]) {
      const messages: StdoutMessage[] = []
      let committed: readonly Command[] = []
      await handlers.handleDirectTuiLogoutRequest(
        `logout-route-${slashCommandsEnabled}`,
        { enqueue: message => messages.push(message) },
        async () => (slashCommandsEnabled ? [base] : []),
        '/workspace',
        true,
        {
          logout: async () => {},
          clearCommandCaches: () => {},
          getAccount: () => undefined,
          getProvider: () => 'firstParty',
        },
        nextCommands => {
          committed = nextCommands
        },
        () =>
          slashCommandsEnabled ? [...committed, liveMcp] : [],
      )

      const response = messages[0] as Extract<
        StdoutMessage,
        { type: 'control_response' }
      >
      // The direct-TUI logout catalog is delivered in name order so a
      // background reprojection of the same inventory is byte-identical.
      expect(
        response.response.response?.commands.map(item => item.name),
      ).toEqual(
        slashCommandsEnabled
          ? ['mcp__live__prompt', 'public-after-auth-transition']
          : [],
      )
    }
  })

  test('logout performs backend cleanup, refreshes auth/catalog, and preserves request correlation', async () => {
    const messages: StdoutMessage[] = []
    const events: string[] = []
    const commands = [command('login-after-logout')]
    let committedCommands: readonly Command[] | undefined

    const refreshed = await handlers.handleDirectTuiLogoutRequest(
      'logout-request-完整',
      { enqueue: message => messages.push(message) },
      async currentCwd => {
        events.push(`load:${currentCwd}`)
        return commands
      },
      '/workspace',
      true,
      {
        logout: async options => {
          events.push(`logout:${String(options.clearOnboarding)}`)
        },
        clearCommandCaches: () => events.push('clear-command-cache'),
        getAccount: () => ({ tokenSource: 'none' }),
        getProvider: () => 'firstParty',
      },
      nextCommands => {
        events.push('commit-catalog')
        committedCommands = nextCommands
      },
    )

    expect(refreshed).toBe(commands)
    expect(events).toEqual([
      'logout:true',
      'clear-command-cache',
      'load:/workspace',
      'commit-catalog',
    ])
    expect(committedCommands).toBe(commands)
    expect(messages).toEqual([
      {
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: 'logout-request-完整',
          response: {
            account: {
              apiProvider: 'firstParty',
            },
            commands: [
              {
                name: 'login-after-logout',
                description: 'Description for login-after-logout',
                argumentHint: '',
              },
            ],
          },
        },
      },
    ])
  })

  test('a committed logout degrades cache, loader, account, and provider refresh failures to one signed-out success', async () => {
    const stages = ['cache', 'loader', 'account', 'provider'] as const

    for (const failureStage of stages) {
      const messages: StdoutMessage[] = []
      const events: string[] = []
      let committedCommands: readonly Command[] | undefined
      let currentCommands: readonly Command[] = [
        command('authenticated-command-before-logout'),
      ]
      const lifecycle = new catalogRefresh.DirectTuiCommandCatalogLifecycle(
        currentCommands,
        nextCommands => {
          currentCommands = nextCommands
        },
      )

      const refreshed = await handlers.handleDirectTuiLogoutRequest(
        `logout-${failureStage}`,
        {
          enqueue: message => {
            events.push('response')
            messages.push(message)
          },
        },
        async () => {
          events.push('loader')
          if (failureStage === 'loader') throw new Error('loader failed')
          return [command('must-not-survive-degraded-logout')]
        },
        '/workspace',
        true,
        {
          logout: async () => {
            events.push('logout')
          },
          clearCommandCaches: () => {
            events.push('cache')
            if (failureStage === 'cache') throw new Error('cache failed')
          },
          getAccount: () => {
            events.push('account')
            if (failureStage === 'account') throw new Error('account failed')
            return undefined
          },
          getProvider: () => {
            events.push('provider')
            if (failureStage === 'provider') throw new Error('provider failed')
            return 'firstParty'
          },
        },
        nextCommands => {
          events.push('commit')
          committedCommands = nextCommands
          lifecycle.replace(nextCommands)
        },
      )

      expect(refreshed, failureStage).toEqual([])
      expect(committedCommands, failureStage).toEqual([])
      expect(currentCommands, failureStage).toEqual([])
      expect(events.at(0), failureStage).toBe('logout')
      expect(events.slice(-2), failureStage).toEqual([
        'commit',
        'response',
      ])
      expect(messages, failureStage).toEqual([
        {
          type: 'control_response',
          response: {
            subtype: 'success',
            request_id: `logout-${failureStage}`,
            response: {
              account: {},
              commands: [],
            },
          },
        },
      ])
    }
  })

  test('logout never republishes stale account identity after credential removal', async () => {
    const messages: StdoutMessage[] = []
    let committedCommands: readonly Command[] | undefined

    const refreshed = await handlers.handleDirectTuiLogoutRequest(
      'logout-stale-account-cache',
      { enqueue: message => messages.push(message) },
      async () => [command('account-gated-stale-command')],
      '/workspace',
      true,
      {
        logout: async () => {},
        clearCommandCaches: () => {},
        getAccount: () => ({
          email: 'old@example.invalid',
          organization: 'old-org',
          subscription: 'max',
          tokenSource: 'acosmi.com',
        }),
        getProvider: () => 'firstParty',
      },
      nextCommands => {
        committedCommands = nextCommands
      },
    )

    expect(refreshed).toEqual([])
    expect(committedCommands).toEqual([])
    expect(messages).toEqual([
      {
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: 'logout-stale-account-cache',
          response: { account: {}, commands: [] },
        },
      },
    ])
    expect(JSON.stringify(messages)).not.toContain('old@example.invalid')
    expect(JSON.stringify(messages)).not.toContain('subscription')
  })

  test('logout response enqueue failure cannot roll back the committed signed-out catalog or emit a false error', async () => {
    const commands = [command('public-after-logout')]
    let committedCommands: readonly Command[] | undefined
    let enqueueAttempts = 0

    const refreshed = await handlers.handleDirectTuiLogoutRequest(
      'logout-output-closed',
      {
        enqueue: () => {
          enqueueAttempts += 1
          throw new Error('output queue closed')
        },
      },
      async () => commands,
      '/workspace',
      true,
      {
        logout: async () => {},
        clearCommandCaches: () => {},
        getAccount: () => undefined,
        getProvider: () => 'firstParty',
      },
      nextCommands => {
        committedCommands = nextCommands
      },
    )

    expect(refreshed).toBe(commands)
    expect(committedCommands).toBe(commands)
    expect(enqueueAttempts).toBe(1)
  })

  test('a typed OAuth-account post-commit cleanup failure is account-removed success without stale refresh reads', async () => {
    const messages: StdoutMessage[] = []
    const events: string[] = []
    let currentCommands: readonly Command[] = [command('old-private-command')]

    const refreshed = await handlers.handleDirectTuiLogoutRequest(
      'logout-storage-committed',
      { enqueue: message => messages.push(message) },
      async () => {
        events.push('loader')
        return [command('must-not-load-after-committed-warning')]
      },
      '/workspace',
      true,
      {
        logout: async () => {
          events.push('logout')
          throw new localAuthState.AcosmiAccountRemovalCommittedCleanupError(
            'plaintext cleanup failed after keychain commit',
            new Error('synthetic committed cleanup failure'),
          )
        },
        clearCommandCaches: () => events.push('cache'),
        getAccount: () => {
          events.push('account')
          return { email: 'stale@example.invalid', subscription: 'max' }
        },
        getProvider: () => {
          events.push('provider')
          return 'firstParty'
        },
      },
      nextCommands => {
        events.push('commit')
        currentCommands = nextCommands
      },
    )

    expect(refreshed).toEqual([])
    expect(currentCommands).toEqual([])
    expect(events).toEqual(['logout', 'commit'])
    expect(messages).toEqual([
      {
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: 'logout-storage-committed',
          response: { account: {}, commands: [] },
        },
      },
    ])
  })

  test('multi-storage logout touches the API-key authority only after the OAuth account commit boundary', async () => {
    const beforeCommitEvents: string[] = []
    let beforeCommitError: unknown
    try {
      await localAuthState.clearAcosmiAccountAuthorities({
        removeAccountStorage: async () => {
          beforeCommitEvents.push('account-storage')
          return {
            success: false,
            committed: false,
            warning: 'account storage did not commit',
          }
        },
        removeApiKeyStorage: async () => {
          beforeCommitEvents.push('api-key-storage')
        },
        finishCommittedRemoval: async () => {
          beforeCommitEvents.push('projection')
        },
      })
    } catch (error) {
      beforeCommitError = error
    }

    expect(beforeCommitEvents).toEqual(['account-storage'])
    expect(beforeCommitError).toBeInstanceOf(Error)
    expect(beforeCommitError).not.toBeInstanceOf(
      localAuthState.AcosmiAccountRemovalCommittedCleanupError,
    )

    const afterCommitEvents: string[] = []
    let afterCommitError: unknown
    try {
      await localAuthState.clearAcosmiAccountAuthorities({
        removeAccountStorage: async () => {
          afterCommitEvents.push('account-storage')
          return { success: true }
        },
        removeApiKeyStorage: async () => {
          afterCommitEvents.push('api-key-storage')
          throw new Error('API-key cleanup failed')
        },
        finishCommittedRemoval: async () => {
          afterCommitEvents.push('projection')
        },
      })
    } catch (error) {
      afterCommitError = error
    }

    expect(afterCommitEvents).toEqual([
      'account-storage',
      'api-key-storage',
    ])
    expect(afterCommitError).toBeInstanceOf(
      localAuthState.AcosmiAccountRemovalCommittedCleanupError,
    )
    expect(afterCommitError).toMatchObject({
      accountRemovalCommitted: true,
      message: 'API-key cleanup failed',
    })

    const committedWarningEvents: string[] = []
    let committedWarning: unknown
    try {
      await localAuthState.clearAcosmiAccountAuthorities({
        removeAccountStorage: async () => {
          committedWarningEvents.push('account-storage')
          return {
            success: false,
            committed: true,
            warning: 'primary committed; plaintext cleanup failed',
          }
        },
        removeApiKeyStorage: async () => {
          committedWarningEvents.push('api-key-storage')
        },
        finishCommittedRemoval: async result => {
          committedWarningEvents.push('projection')
          throw new Error(result.warning)
        },
      })
    } catch (error) {
      committedWarning = error
    }

    expect(committedWarningEvents).toEqual([
      'account-storage',
      'api-key-storage',
      'projection',
    ])
    expect(committedWarning).toBeInstanceOf(
      localAuthState.AcosmiAccountRemovalCommittedCleanupError,
    )
  })

  test('OAuth replacement continues only after the typed prior-account commit signal', async () => {
    const events: string[] = []
    await oauthInstall.clearPriorAuthForOAuthInstall(async () => {
      events.push('clear-prior-account')
      throw new localAuthState.AcosmiAccountRemovalCommittedCleanupError(
        'old account removed; projection cleanup failed',
        new Error('synthetic projection cleanup failure'),
      )
    })
    events.push('install-new-token')
    expect(events).toEqual([
      'clear-prior-account',
      'install-new-token',
    ])

    await expect(
      oauthInstall.clearPriorAuthForOAuthInstall(async () => {
        throw new Error('old account removal did not commit')
      }),
    ).rejects.toThrow('old account removal did not commit')

    await expect(
      oauthInstall.clearPriorAuthForOAuthInstall(async () => {
        throw Object.assign(new Error('typed lookalike'), {
          accountRemovalCommitted: true,
        })
      }),
    ).rejects.toThrow('typed lookalike')
  })

  test('logout failure is request-local and does not refresh or terminate the runtime', async () => {
    const messages: StdoutMessage[] = []
    let loaded = false
    let committed = false

    const refreshed = await handlers.handleDirectTuiLogoutRequest(
      'logout-failure-id',
      { enqueue: message => messages.push(message) },
      async () => {
        loaded = true
        return []
      },
      '/workspace',
      true,
      {
        logout: async () => {
          throw Object.assign(new Error('credential cleanup failed'), {
            // Only the exported post-commit error class is authoritative; a
            // structural/string lookalike must remain an ordinary failure.
            credentialsCommitted: true,
          })
        },
        clearCommandCaches: () => {
          throw new Error('must not refresh after logout failure')
        },
        getAccount: () => undefined,
        getProvider: () => 'firstParty',
      },
      () => {
        committed = true
      },
    )

    expect(refreshed).toBeNull()
    expect(loaded).toBe(false)
    expect(committed).toBe(false)
    expect(messages).toEqual([
      {
        type: 'control_response',
        response: {
          subtype: 'error',
          request_id: 'logout-failure-id',
          error: 'credential cleanup failed',
        },
      },
    ])
  })

  test('ordinary SDK/headless routes cannot invoke the process-private logout authority', async () => {
    const messages: StdoutMessage[] = []
    let logoutCalled = false

    const refreshed = await handlers.handleDirectTuiLogoutRequest(
      'non-direct-logout',
      { enqueue: message => messages.push(message) },
      async () => [],
      '/workspace',
      false,
      {
        logout: async () => {
          logoutCalled = true
        },
        clearCommandCaches: () => {},
        getAccount: () => undefined,
        getProvider: () => 'firstParty',
      },
    )

    expect(refreshed).toBeNull()
    expect(logoutCalled).toBe(false)
    expect(messages).toEqual([
      {
        type: 'control_response',
        response: {
          subtype: 'error',
          request_id: 'non-direct-logout',
          error:
            'crabcode_tui_logout is available only to the direct TUI runtime',
        },
      },
    ])
  })

  test('auth refresh invalidates the memoized direct catalog after login state changes', async () => {
    subscriber.mockReturnValue(false)
    const loggedOut = await catalog.getDirectTuiCommands(process.cwd())
    expect(
      loggedOut.some(candidate => candidate.name === 'install-slack-app'),
    ).toBe(false)

    subscriber.mockReturnValue(true)
    const refreshed = await handlers.refreshControlAuthCatalog(
      catalog.getDirectTuiCommands,
      process.cwd(),
      {
        clearCommandCaches: catalog.clearHeadlessCommandMemoizationCaches,
        getAccount: () => ({
          email: 'signed-in@example.invalid',
          organization: 'example-org',
          subscription: 'pro',
          tokenSource: 'acosmi.com',
          apiKeySource: 'none',
        }),
        getProvider: () => 'firstParty',
      },
    )

    expect(
      refreshed.commands.some(
        candidate => candidate.name === 'install-slack-app',
      ),
    ).toBe(true)
    expect(
      refreshed.response.commands.some(
        candidate => candidate.name === 'install-slack-app',
      ),
    ).toBe(true)
    expect(refreshed.response.account).toMatchObject({
      email: 'signed-in@example.invalid',
      subscriptionType: 'pro',
      tokenSource: 'acosmi.com',
      apiProvider: 'firstParty',
    })
  })
})
