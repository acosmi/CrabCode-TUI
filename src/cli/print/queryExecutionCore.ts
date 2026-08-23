import type { ContentBlockParam } from '../../types/api-types.js'
import { feature } from '../../utils/featurePolyfill.js'
import { readFile, stat } from 'fs/promises'
import { dirname } from 'path'
import {
  downloadUserSettings,
  redownloadUserSettings,
} from 'src/services/settingsSync/index.js'
import { waitForRemoteManagedSettingsToLoad } from 'src/services/remoteManagedSettings/index.js'
import {
  StructuredIO,
  type StructuredIoOutboundMessage,
} from 'src/cli/structuredIO.js'
import type { Command } from 'src/types/command.js'
import {
  clearHeadlessCommandMemoizationCaches,
  clearHeadlessCommandsCache,
  formatHeadlessCommandDescription,
  getDirectTuiCommands,
  getHeadlessCommands,
  installDirectTuiCommandSurface,
  installHeadlessCommandSurface,
} from 'src/cli/headlessCommands.js'
import {
  projectCommandCatalogEntries,
  projectDirectTuiCommandCatalogEntries,
} from 'src/cli/commandCatalogProjection.js'
import {
  DirectTuiCommandCatalogLifecycle,
  DirectTuiCommandCatalogPublisher,
} from 'src/cli/directTuiCommandCatalogRefresh.js'
import { createStreamlinedTransformer } from 'src/utils/streamlinedTransform.js'
import {
  shouldRegisterSdkHookEventHandler,
  shouldTransformStreamOutput,
} from 'src/cli/print/streamOutputPolicy.js'
import {
  commandInventoryForRoute,
  commandLoaderForRoute,
  executableCommandInventoryForRoute,
} from './slashCommandRoutePolicy.js'
import { installStreamJsonStdoutGuard } from 'src/utils/streamJsonStdoutGuard.js'
import type { ToolPermissionContext } from 'src/Tool.js'
import type { ThinkingConfig } from 'src/utils/thinking.js'
import { clearCompletedGoalOnNextInput } from 'src/tools/GoalReportTool/sessionLifecycle.js'
import { assembleToolPool, filterToolsByDenyRules } from 'src/tools.js'
import uniqBy from 'lodash-es/uniqBy.js'
import { uniq } from 'src/utils/array.js'
import { mergeAndFilterTools } from 'src/utils/toolPool.js'
import {
  logEvent,
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
} from 'src/services/analytics/index.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from 'src/services/analytics/growthbook.js'
import { logForDebugging } from 'src/utils/debug.js'
import {
  logForDiagnosticsNoPII,
  withDiagnosticsTiming,
} from 'src/utils/diagLogs.js'
import { toolMatchesName, type Tool, type Tools } from 'src/Tool.js'
import {
  type AgentDefinition,
  isBuiltInAgent,
  parseAgentsFromJson,
} from 'src/tools/AgentTool/loadAgentsDir.js'
import type { Message, NormalizedUserMessage } from 'src/types/message.js'
import type { QueuedCommand } from 'src/types/textInputTypes.js'
import {
  dequeue,
  dequeueAllMatching,
  enqueue,
  hasCommandsInQueue,
  isTaskNotificationClaimed,
  peek,
  subscribeToCommandQueue,
  getCommandsByMaxPriority,
} from 'src/utils/messageQueueManager.js'
import { notifyCommandLifecycle } from 'src/utils/commandLifecycle.js'
import {
  getSessionState,
  notifySessionStateChanged,
  setPermissionModeChangedListener,
  type RequiresActionDetails,
} from 'src/utils/sessionState.js'
import { getInMemoryErrors, logError, logMCPDebug } from 'src/utils/log.js'
import {
  writeToStdout,
  registerProcessOutputErrorHandlers,
} from 'src/utils/process.js'
import type { Stream } from 'src/utils/stream.js'
import { EMPTY_USAGE } from 'src/services/api/logging.js'
import {
  loadConversationForResume,
  type TurnInterruptionState,
} from 'src/utils/conversationRecovery.js'
import type {
  MCPServerConnection,
  McpSdkServerConfig,
  ScopedMcpServerConfig,
} from 'src/services/mcp/types.js'
import {
  ChannelMessageNotificationSchema,
  gateChannelServer,
  wrapChannelMessage,
  findChannelEntry,
} from 'src/services/mcp/channelNotification.js'
import {
  isChannelAllowlisted,
  isChannelsEnabled,
} from 'src/services/mcp/channelAllowlist.js'
import { parsePluginIdentifier } from 'src/utils/plugins/pluginIdentifier.js'
import { validateUuid } from 'src/utils/uuid.js'
import { fromArray } from 'src/utils/generators.js'
import { ask } from 'src/QueryEngine.js'
import {
  createDirectTuiQueryEventSink,
  isDirectTuiRendererEvent,
  isDirectTuiControlPlaneSdkMessage,
} from 'src/cli/directTuiQueryEvents.js'
import { routeDirectTuiInput } from 'src/cli/directTuiInput.js'
import {
  createDirectTuiRuntimeActionRouter,
  isDirectTuiRuntimeActionResult,
} from 'src/cli/directTuiRuntimeActions.js'
import { runWithDirectTuiProjectionOwner } from 'src/cli/directTuiProjectionOwner.js'
import {
  deriveCrabCodeThinkingMode,
  prepareAccountBridgeThinkingModeForRoute,
  type AccountBridgeThinkingSelection,
} from 'src/services/accountBridge/thinking.js'
import { acquireDirectAccountBridgeTurnAccess } from 'src/services/accountBridge/directTurnAccess.js'
import { getLocale, t } from 'src/i18n/index.js'
import type { QuerySource } from 'src/constants/querySource.js'
import { getQuerySourceForREPL } from 'src/utils/promptCategory.js'
import type { PermissionPromptTool } from 'src/utils/queryHelpers.js'
import {
  createFileStateCacheWithSizeLimit,
  mergeFileStateCaches,
  READ_FILE_STATE_CACHE_SIZE,
} from 'src/utils/fileStateCache.js'
import { expandPath } from 'src/utils/path.js'
import { extractReadFilesFromMessages } from 'src/utils/queryHelpers.js'
import {
  registerHookEventHandler,
  suppressHookEventDelivery,
} from 'src/utils/hooks/hookEvents.js'
import { executeFilePersistence } from 'src/utils/filePersistence/filePersistence.js'
import { finalizePendingAsyncHooks } from 'src/utils/hooks/AsyncHookRegistry.js'
import {
  gracefulShutdown,
  gracefulShutdownSync,
  isShuttingDown,
} from 'src/utils/gracefulShutdown.js'
import { registerCleanup } from 'src/utils/cleanupRegistry.js'
import { createIdleTimeoutManager } from 'src/utils/idleTimeout.js'
import type {
  SDKStatus,
  ModelInfo,
  SDKMessage,
  SDKUserMessage,
  SDKUserMessageReplay,
  PermissionResult,
  McpServerConfigForProcessTransport,
  McpServerStatus,
  RewindFilesResult,
} from 'src/entrypoints/agentSdkTypes.js'
import type {
  StdoutMessage,
  SDKControlInitializeRequest,
  SDKControlInitializeResponse,
  SDKControlRequest,
  SDKControlResponse,
  SDKControlMcpSetServersResponse,
  SDKControlReloadPluginsResponse,
} from 'src/entrypoints/sdk/controlTypes.js'
import type {
  PermissionMode,
  PermissionMode as InternalPermissionMode,
} from 'src/types/permissions.js'
import { cwd } from 'process'
import { getCwd } from 'src/utils/cwd.js'
import omit from 'lodash-es/omit.js'
import reject from 'lodash-es/reject.js'
import {
  buildPluginMcpManagementStatuses,
  sdkMcpLifecycleStatusFromReason,
} from './pluginMcpStatusProjection.js'
import { isPolicyAllowed } from 'src/services/policyLimits/index.js'
import type { CanUseToolFn } from 'src/types/canUseTool.js'
import { withDirectTuiPermissionBridge } from '../directTuiPermissionBridge.js'
import { hasPermissionsToUseTool } from 'src/utils/permissions/permissions.js'
import { safeParseJSON } from 'src/utils/json.js'
import {
  outputSchema as permissionToolOutputSchema,
  permissionPromptToolResultToPermissionDecision,
} from 'src/utils/permissions/PermissionPromptToolResultSchema.js'
import { createAbortController } from 'src/utils/abortController.js'
import { createCombinedAbortSignal } from 'src/utils/combinedAbortSignal.js'
import { generateSessionTitleDirect } from 'src/utils/sessionTitleDirect.js'
import { buildSideQuestionFallbackParams } from 'src/utils/queryContext.js'
import { runSideQuestion } from 'src/utils/sideQuestion.js'
import {
  processSessionStartHooks,
  processSetupHooks,
  takeInitialUserMessage,
} from 'src/utils/sessionStart.js'
import {
  DEFAULT_OUTPUT_STYLE_NAME,
  getAllOutputStyles,
} from 'src/constants/outputStyles.js'
import { TICK_TAG } from 'src/constants/xml.js'
import {
  getSettings_DEPRECATED,
  getSettingsWithSources,
} from 'src/utils/settings/settings.js'
import { settingsChangeDetector } from 'src/utils/settings/changeDetector.js'
import { applySettingsChange } from 'src/utils/settings/applySettingsChange.js'
import {
  isFastModeAvailable,
  isFastModeEnabled,
  isFastModeSupportedByModel,
  getFastModeState,
} from 'src/utils/fastMode.js'
import {
  isAutoModeGateEnabled,
  getAutoModeUnavailableNotification,
  getAutoModeUnavailableReason,
  isBypassPermissionsModeDisabled,
  transitionPermissionMode,
} from 'src/utils/permissions/permissionSetup.js'
import {
  tryGenerateSuggestion,
  logSuggestionOutcome,
  logSuggestionSuppressed,
  type PromptVariant,
} from 'src/services/PromptSuggestion/promptSuggestion.js'
import { drainPendingExtraction } from 'src/services/memoryRunners/extract/drain.js'
import { getLastCacheSafeParams } from 'src/utils/forkedAgent.js'
import {
  getAuthStatus,
  loginStream,
  resolveOAuthCompletionScopes,
} from 'src/services/acosmi/client.js'
import { installOAuthTokens } from 'src/services/auth/installOAuthTokens.js'
import type { HookCallbackMatcher } from 'src/types/hooks.js'
import { AwsAuthStatusManager } from 'src/utils/awsAuthStatusManager.js'
import type { HookEvent } from 'src/entrypoints/agentSdkTypes.js'
import {
  registerHookCallbacks,
  setInitJsonSchema,
  getInitJsonSchema,
  setSdkAgentProgressSummariesEnabled,
  setUsesStructuredIoTransport,
} from 'src/bootstrap/state.js'
import { createSyntheticOutputTool } from 'src/tools/SyntheticOutputTool/SyntheticOutputTool.js'
import {
  resetSessionFilePointer,
  doesMessageExistInSession,
  findUnresolvedToolUse,
  recordAttributionSnapshot,
  saveAgentSetting,
  saveMode,
  saveAiGeneratedTitle,
  restoreSessionMetadata,
} from 'src/utils/sessionStorage.js'
import { incrementPromptCount } from 'src/utils/commitAttribution.js'
import {
  setupSdkMcpClients,
  connectToServer,
  clearServerCache,
  clearMcpAuthCache,
  evictExistingServerCache,
  getServerCacheKey,
  fetchToolsForClient,
  areMcpConfigsEqual,
  reconnectMcpServerImpl,
} from 'src/services/mcp/client.js'
import {
  filterMcpServersByPolicy,
  authorizeMcpOAuthStart,
  getActiveMcpConfigs,
  getActiveMcpConfigByName,
  getAllMcpConfigs,
  getCrabCodeMcpConfigs,
  getMcpConfigByName,
  isMcpServerDisabled,
  setMcpServerEnabled,
} from 'src/services/mcp/config.js'
import {
  getServerKey,
  performMCPOAuthFlow,
} from 'src/services/mcp/auth.js'
import { clearMcpAuthenticationRuntime } from 'src/services/mcp/mcpAuthClearRuntime.js'
import {
  runElicitationHooks,
  runElicitationResultHooks,
} from 'src/services/mcp/elicitationHandler.js'
import { executeNotificationHooks } from 'src/utils/hooks.js'
import {
  ElicitRequestSchema,
  ElicitationCompleteNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { getMcpPrefix } from 'src/services/mcp/mcpStringUtils.js'
import {
  canPluginMcpConnectAfterExplicitEnable,
  lifecycleMetadataFromInventory,
} from 'src/services/mcp/pluginMcpLifecycle.js'
import { isPluginMcpRuntimeName } from 'src/services/mcp/pluginMcpIdentity.js'
import {
  commandBelongsToServer,
  filterToolsByServer,
} from 'src/services/mcp/utils.js'
import { setupVscodeSdkMcp } from 'src/services/mcp/vscodeSdkMcp.js'
import {
  isQualifiedForGrove,
  checkGroveForNonInteractive,
} from 'src/services/api/grove.js'
import {
  toInternalMessages,
  toSDKRateLimitInfo,
} from 'src/utils/messages/mappers.js'
import {
  createModelSwitchBreadcrumbs,
  createUserMessage,
} from 'src/utils/messages.js'
import { handleGetContextUsageControlRequest } from 'src/commands/context/context-noninteractive.js'
import { LOCAL_COMMAND_STDOUT_TAG } from 'src/constants/xml.js'
import {
  statusListeners,
  type AcosmiLimits,
} from 'src/services/acosmiLimits.js'
import {
  getDefaultMainLoopModel,
  getMainLoopModel,
  modelDisplayString,
  parseUserSpecifiedModel,
} from 'src/utils/model/model.js'
import { getModelOptions } from 'src/utils/model/modelOptions.js'
import {
  modelSupportsEffort,
  modelSupportsMaxEffort,
  EFFORT_LEVELS,
  resolveAppliedEffort,
} from 'src/utils/effort.js'
import { modelSupportsAdaptiveThinking } from 'src/utils/thinking.js'
import { modelSupportsAutoMode } from 'src/utils/betas.js'
import { ensureModelCachePopulated } from 'src/utils/model/modelCapabilities.js'
import {
  getSessionId,
  setMainLoopModelOverride,
  setMainThreadAgentType,
  switchSession,
  isSessionPersistenceDisabled,
  getFlagSettingsInline,
  setFlagSettingsInline,
  getMainThreadAgentType,
  getAllowedChannels,
  setAllowedChannels,
  type ChannelEntry,
} from 'src/bootstrap/state.js'
import { runWithWorkload, WORKLOAD_CRON } from 'src/utils/workloadContext.js'
import type { UUID } from 'crypto'
import { randomUUID } from 'crypto'

import type { AppState } from 'src/state/AppStateStore.js'
import {
  fileHistoryRewind,
  fileHistoryCanRestore,
  fileHistoryEnabled,
  fileHistoryGetDiffStats,
} from 'src/utils/fileHistory.js'
import {
  restoreAgentFromSession,
  restoreSessionStateFromLog,
} from 'src/utils/sessionRestore.js'
import { SandboxManager } from 'src/utils/sandbox/sandbox-adapter.js'
import {
  headlessProfilerStartTurn,
  headlessProfilerCheckpoint,
  logHeadlessProfilerTurn,
} from 'src/utils/headlessProfiler.js'
import {
  startQueryProfile,
  logQueryProfileReport,
} from 'src/utils/queryProfiler.js'
import { asSessionId } from 'src/types/ids.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import {
  installSkillCommandCacheInvalidator,
  skillChangeDetector,
} from '../../utils/skills/skillChangeDetector.js'
import {
  isBareMode,
  isEnvTruthy,
  isEnvDefinedFalsy,
} from '../../utils/envUtils.js'
import { installPluginsForHeadless } from '../../utils/plugins/headlessPluginInstall.js'
import { getInitialSettings } from '../../utils/settings/settings.js'
import {
  recordPluginDiscoveryFingerprint,
  refreshActivePlugins,
  refreshActivePluginsIfDiscoveryChanged,
} from '../../utils/plugins/refresh.js'
import { loadAllPluginsCacheOnly } from '../../utils/plugins/pluginLoader.js'
import {
  isTeamLead,
  hasActiveInProcessTeammates,
  hasWorkingInProcessTeammates,
  waitForTeammatesToBecomeIdle,
} from '../../utils/teammate.js'
import {
  formatTeammateMessages,
  isStructuredProtocolMessage,
  markMessagesAsReadByPredicate,
  readUnreadMessages,
} from '../../utils/teammateMailbox.js'
import { TaskListWatcherCore } from '../../utils/taskListWatcherCore.js'
import { getRunningTasks } from '../../utils/task/framework.js'
import { isBackgroundTask } from '../../tasks/types.js'
import { stopTask } from '../../tasks/stopTask.js'
import { drainSdkEvents } from '../../utils/sdkEventQueue.js'
import { initializeGrowthBook } from '../../services/analytics/growthbook.js'
import { errorMessage, toError } from '../../utils/errors.js'
import { sleep } from '../../utils/sleep.js'
import { isExtractModeActive } from '../../memdir/paths.js'
// Sub-module imports (refactored from this file)
import {
  type DynamicMcpState,
  createMcpMutationLane,
  handleMcpSetServers,
  partitionStartupProcessMcpState,
  toScopedConfig,
} from './mcpServerManagement.js'
import {
  DIRECT_TUI_SDK_MCP_UNSUPPORTED_ERROR,
  canCommitDirectMcpOAuthGeneration,
  type McpProcessOwner,
  filterMcpServersForOwner,
  isDirectTuiSdkMcpInventoryRecord,
  orderMcpServersByPrecedence,
  planCapturedMcpPolicyTransitions,
  preservePublicProcessDesiredAcrossSdkRejections,
  prepareMcpServersForOwner,
} from './mcpServerOwnership.js'
import {
  createCanUseToolWithPermissionPrompt,
  getCanUseToolFn,
  handleOrphanedPermissionResponse,
} from './permissionHandlers.js'
import {
  DirectTeamInboxRuntime,
  resolveDirectTeamInboxTarget,
} from './directTeamInboxRuntime.js'
import {
  createDirectTeamInboxReadPredicate,
  excludeQueuedDirectTeamInboxOccurrences,
  routeDirectTeamInboxMessages,
} from './directTeamInboxRouter.js'
import {
  conservativeControlAuthCatalog,
  handleDirectTuiLogoutRequest,
  handleInitializeRequest,
  handleRewindFiles,
  refreshControlAuthCatalog,
  withCurrentControlAuthCommandCatalog,
  handleSetPermissionMode,
  handleChannelEnable,
  reregisterChannelHandlerAfterReconnect,
} from './sdkControlHandlers.js'
import {
  removeInterruptedMessage,
  loadInitialMessages,
  getStructuredIO,
} from './sessionLoader.js'

// Dead code elimination: conditional imports
/* eslint-disable @typescript-eslint/no-require-imports */
const coordinatorModeModule = feature('COORDINATOR_MODE')
  ? (require('../../coordinator/coordinatorMode.js') as typeof import('../../coordinator/coordinatorMode.js'))
  : null
const proactiveModule =
  feature('PROACTIVE') || feature('KAIROS')
    ? (require('../../proactive/index.js') as typeof import('../../proactive/index.js'))
    : null
/* eslint-enable @typescript-eslint/no-require-imports */

const SHUTDOWN_TEAM_PROMPT = `<system-reminder>
You are running in non-interactive mode and cannot return a response to the user until your team is shut down.

You MUST shut down your team before preparing your final response:
1. Use requestShutdown to ask each team member to shut down gracefully
2. Wait for shutdown approvals
3. Use the cleanup operation to clean up the team
4. Only then provide your final response to the user

The user cannot receive your response until the team is completely shut down.
</system-reminder>

Shut down your team and prepare your final response for the user.`

// Track message UUIDs received during the current session runtime
const MAX_RECEIVED_UUIDS = 10_000
const receivedMessageUuids = new Set<UUID>()
const receivedMessageUuidsOrder: UUID[] = []

function trackReceivedMessageUuid(uuid: UUID): boolean {
  if (receivedMessageUuids.has(uuid)) {
    return false // duplicate
  }
  receivedMessageUuids.add(uuid)
  receivedMessageUuidsOrder.push(uuid)
  // Evict oldest entries when at capacity
  if (receivedMessageUuidsOrder.length > MAX_RECEIVED_UUIDS) {
    const toEvict = receivedMessageUuidsOrder.splice(
      0,
      receivedMessageUuidsOrder.length - MAX_RECEIVED_UUIDS,
    )
    for (const old of toEvict) {
      receivedMessageUuids.delete(old)
    }
  }
  return true // new UUID
}

type PromptValue = string | ContentBlockParam[]

function toBlocks(v: PromptValue): ContentBlockParam[] {
  return typeof v === 'string' ? [{ type: 'text', text: v }] : v
}

/**
 * Join prompt values from multiple queued commands into one. Strings are
 * newline-joined; if any value is a block array, all values are normalized
 * to blocks and concatenated.
 */
export function joinPromptValues(values: PromptValue[]): PromptValue {
  if (values.length === 1) return values[0]!
  if (values.every(v => typeof v === 'string')) {
    return values.join('\n')
  }
  return values.flatMap(toBlocks)
}

/**
 * Whether `next` can be batched into the same ask() call as `head`. Only
 * prompt-mode commands batch, and only when the workload tag matches (so the
 * combined turn is attributed correctly) and the isMeta flag matches (so a
 * proactive tick can't merge into a user prompt and lose its hidden-in-
 * transcript marking when the head is spread over the merged command).
 */
export function canBatchWith(
  head: QueuedCommand,
  next: QueuedCommand | undefined,
): boolean {
  return (
    next !== undefined &&
    next.mode === 'prompt' &&
    next.workload === head.workload &&
    next.isMeta === head.isMeta
  )
}

export interface RunHeadlessOptions {
  continue: boolean | undefined
  resume: string | boolean | undefined
  resumeSessionAt: string | undefined
  verbose: boolean | undefined
  outputFormat: string | undefined
  jsonSchema: Record<string, unknown> | undefined
  permissionPromptToolName: string | undefined
  allowedTools: string[] | undefined
  thinkingConfig: ThinkingConfig | undefined
  maxTurns: number | undefined
  maxBudgetUsd: number | undefined
  taskBudget: { total: number } | undefined
  systemPrompt: string | undefined
  appendSystemPrompt: string | undefined
  /**
   * Main-thread agent persona resolved by the CLI bootstrap from the --agent
   * flag (or saved session state). Threaded down to ask() → QueryEngine →
   * buildEffectiveSystemPrompt.
   */
  mainThreadAgentDefinition: AgentDefinition | undefined
  userSpecifiedModel: string | undefined
  fallbackModel: string | undefined
  replayUserMessages: boolean | undefined
  includePartialMessages: boolean | undefined
  includeHookEvents: boolean | undefined
  forkSession: boolean | undefined
  rewindFiles: string | undefined
  enableAuthStatus: boolean | undefined
  agent: string | undefined
  workload: string | undefined
  /** Persistently disables direct-TUI slash discovery and dispatch. */
  disableSlashCommands?: boolean
  /** Direct runtime AppState subscription used for live MCP command catalogs. */
  subscribeAppState?: (listener: () => void) => () => void
  /** Names sourced only from this direct TUI's --mcp-config arguments. */
  startupSessionMcpServerNames?: readonly string[]
  /** Raw process configs from --mcp-config, retained for policy revalidation. */
  startupSessionMcpServers?: Readonly<Record<string, ScopedMcpServerConfig>>
  /** Fixed session configs initially inactive by policy or disabled settings. */
  startupPolicyBlockedMcpServerNames?: ReadonlySet<string> | readonly string[]
  /** Late fixed-owner discovery is admitted inside the direct MCP mutation lane. */
  lateFixedMcpConfig?: Promise<{
    name: string
    config: ScopedMcpServerConfig
  } | null>
  /** Direct TUI tasks mode; storage and locking remain owned by tasks.ts. */
  taskListId?: string | undefined
  setupTrigger?: 'init' | 'maintenance' | undefined
  sessionStartHooksPromise?: ReturnType<typeof processSessionStartHooks>
  setSDKStatus?: (status: SDKStatus) => void
  /**
   * Route-owned auxiliary title operation. Each outer route injects its
   * established implementation; the execution core remains transport-neutral.
   */
  sessionTitleGenerator?: (
    description: string,
    signal: AbortSignal,
    options?: { model?: string },
  ) => Promise<string | null>
}

export type RunHeadlessArguments = [
  inputPrompt: string | AsyncIterable<string>,
  getAppState: () => AppState,
  setAppState: (f: (prev: AppState) => AppState) => void,
  commands: Command[],
  tools: Tools,
  sdkMcpConfigs: Record<string, McpSdkServerConfig>,
  agents: AgentDefinition[],
  options: RunHeadlessOptions,
]

export function exitAfterFirstRenderIfRequested(): boolean {
  if (
    process.env.USER_TYPE !== 'ant' ||
    !isEnvTruthy(process.env.CRABCODE_EXIT_AFTER_FIRST_RENDER)
  ) {
    return false
  }
  process.stderr.write(
    `\nStartup time: ${Math.round(process.uptime() * 1000)}ms\n`,
  )
  // eslint-disable-next-line custom-rules/no-process-exit
  process.exit(0)
  return true
}

export async function runHeadlessDirectTui(
  ...args: RunHeadlessArguments
): Promise<void> {
  if (exitAfterFirstRenderIfRequested()) return
  installDirectTuiCommandSurface()
  const options = {
    ...withDirectTuiPermissionBridge(args[7]),
    sessionTitleGenerator: generateSessionTitleDirect,
  }
  const directArgs = [...args.slice(0, 7), options] as RunHeadlessArguments
  const slashCommandsEnabled = options.disableSlashCommands !== true
  await runHeadlessCore(...directArgs, {
    processOwnedAccountBridge: true,
    tasksMode: true,
    interactiveProductSession: true,
    allowDirectTuiBashContentBlocks: true,
    querySource: getQuerySourceForREPL(),
    directQueryEventDelivery: true,
    slashCommandsEnabled,
    commandLoader: commandLoaderForRoute(
      slashCommandsEnabled,
      getDirectTuiCommands,
    ),
  })
}

export async function runHeadlessStandardRoute(
  ...args: RunHeadlessArguments
): Promise<void> {
  installHeadlessCommandSurface()
  await runHeadlessCore(...args, {
    processOwnedAccountBridge: false,
    tasksMode: false,
    interactiveProductSession: false,
    allowDirectTuiBashContentBlocks: false,
    querySource: 'sdk',
    directQueryEventDelivery: false,
    slashCommandsEnabled: true,
    commandLoader: getHeadlessCommands,
  })
}

type HeadlessRoutePolicy = {
  processOwnedAccountBridge: boolean
  tasksMode: boolean
  interactiveProductSession: boolean
  allowDirectTuiBashContentBlocks: boolean
  querySource: QuerySource
  directQueryEventDelivery: boolean
  slashCommandsEnabled: boolean
  commandLoader: (cwd: string) => Promise<Command[]>
}

async function runHeadlessCore(
  inputPrompt: string | AsyncIterable<string>,
  getAppState: () => AppState,
  setAppState: (f: (prev: AppState) => AppState) => void,
  commands: Command[],
  tools: Tools,
  sdkMcpConfigs: Record<string, McpSdkServerConfig>,
  agents: AgentDefinition[],
  options: RunHeadlessOptions,
  routePolicy: HeadlessRoutePolicy,
): Promise<void> {
  // Both the ordinary SDK/print route and the native TUI's private pipe use
  // StructuredIO. Set the transport fact at their shared execution boundary;
  // product interactivity is an independent route policy.
  setUsesStructuredIoTransport(true)
  // Baseline the plugin discovery inputs before this process can write to any
  // of them (the settings download fired below, the plugin installer, managed
  // settings). The caller already awaited the startup discovery pass — the
  // `commands`/`agents` arguments ARE its output — so this baseline describes
  // the disk that the currently loaded plugin state was built from. Any write
  // after this line changes the fingerprint and forces the refresh.
  recordPluginDiscoveryFingerprint()
  installSkillCommandCacheInvalidator(preserveSkillCache => {
    if (preserveSkillCache) {
      clearHeadlessCommandMemoizationCaches()
    } else {
      clearHeadlessCommandsCache()
    }
  })
  const generateSessionTitle =
    options.sessionTitleGenerator ?? generateSessionTitleDirect
  // Fire user settings download now so it overlaps with the MCP/tool setup
  // below. Managed settings already started in main.tsx preAction; this gives
  // user settings a similar head start. The cached promise is joined in
  // installPluginsAndApplyMcpInBackground before plugin install reads
  // enabledPlugins.
  if (
    feature('DOWNLOAD_USER_SETTINGS') &&
    isEnvTruthy(process.env.CRABCODE_REMOTE)
  ) {
    const startupUserSettings = downloadUserSettings()
    if (routePolicy.directQueryEventDelivery) {
      void startupUserSettings
        .then(applied => {
          // Startup download writes are intentionally hidden from filesystem
          // watchers. Direct mode still needs the normal settings authority to
          // reset caches/AppState and either mark an early catalog catch-up or
          // publish a late reverse refresh. Standard keeps its old behavior.
          if (applied) settingsChangeDetector.notifyChange('userSettings')
        })
        .catch(error => logError(error))
    } else {
      void startupUserSettings
    }
  }

  // In headless mode there is no React tree, so the useSettingsChange hook
  // never runs. Subscribe directly so that settings changes (including
  // managed-settings / policy updates) are fully applied.
  let headlessSettingsClosed = false
  let pendingSettingsMcpReconcile = false
  let queueSettingsMcpReconcile: (() => void) | undefined
  const unsubscribeHeadlessSettingsChanges = settingsChangeDetector.subscribe(
    source => {
      if (headlessSettingsClosed) return
      applySettingsChange(source, setAppState)

      if (routePolicy.directQueryEventDelivery) {
        if (queueSettingsMcpReconcile) queueSettingsMcpReconcile()
        else pendingSettingsMcpReconcile = true
      }

      // In headless mode, also sync the denormalized fastMode field from
      // settings. The TUI manages fastMode via the UI so it skips this.
      if (isFastModeEnabled()) {
        setAppState(prev => {
          const s = prev.settings as Record<string, unknown>
          const fastMode = s.fastMode === true && !s.fastModePerSessionOptIn
          return { ...prev, fastMode }
        })
      }
    },
  )
  const installSettingsMcpReconcile = (listener: () => void): void => {
    if (headlessSettingsClosed) return
    queueSettingsMcpReconcile = listener
    if (pendingSettingsMcpReconcile) {
      pendingSettingsMcpReconcile = false
      listener()
    }
  }
  const closeHeadlessSettings = (): void => {
    if (headlessSettingsClosed) return
    headlessSettingsClosed = true
    queueSettingsMcpReconcile = undefined
    unsubscribeHeadlessSettingsChanges()
  }

  // Proactive activation is now handled in main.tsx before getTools() so
  // SleepTool passes isEnabled() filtering. This fallback covers the case
  // where CRABCODE_PROACTIVE is set but main.tsx's check didn't fire
  // (e.g. env was injected by the SDK transport after argv parsing).
  if (
    (feature('PROACTIVE') || feature('KAIROS')) &&
    proactiveModule &&
    !proactiveModule.isProactiveActive() &&
    isEnvTruthy(process.env.CRABCODE_PROACTIVE)
  ) {
    proactiveModule.activateProactive('command')
  }

  // Periodically force a full GC to keep memory usage in check
  if (typeof Bun !== 'undefined') {
    const gcTimer = setInterval(Bun.gc, 1000)
    gcTimer.unref()
  }

  // Start headless profiler for first turn
  headlessProfilerStartTurn()
  headlessProfilerCheckpoint('runHeadless_entry')

  // SDK/non-interactive consumers retain the established fail-closed check.
  // The dedicated native TUI runs the same backend authority after its
  // initialize handshake so Rust can render the decision without owning it.
  if (!routePolicy.interactiveProductSession && (await isQualifiedForGrove())) {
    await checkGroveForNonInteractive()
  }
  headlessProfilerCheckpoint('after_grove_check')

  // Initialize GrowthBook so feature flags take effect in headless mode.
  // Without this, the disk cache is empty and all flags fall back to defaults.
  void initializeGrowthBook()

  if (options.resumeSessionAt && !options.resume) {
    process.stderr.write(`Error: --resume-session-at requires --resume\n`)
    gracefulShutdownSync(1)
    return
  }

  if (options.rewindFiles && !options.resume) {
    process.stderr.write(`Error: --rewind-files requires --resume\n`)
    gracefulShutdownSync(1)
    return
  }

  if (options.rewindFiles && inputPrompt) {
    process.stderr.write(
      `Error: --rewind-files is a standalone operation and cannot be used with a prompt\n`,
    )
    gracefulShutdownSync(1)
    return
  }

  const structuredIO = getStructuredIO(
    inputPrompt,
    options.replayUserMessages,
  )

  // When emitting NDJSON for SDK clients, any stray write to stdout (debug
  // prints, dependency console.log, library banners) breaks the client's
  // line-by-line JSON parser. Install a guard that diverts non-JSON lines to
  // stderr so the stream stays clean. Must run before the first
  // structuredIO.write below.
  if (options.outputFormat === 'stream-json') {
    installStreamJsonStdoutGuard()
  }

  // #34044: if user explicitly set sandbox.enabled=true but deps are missing,
  // isSandboxingEnabled() returns false silently. Surface the reason so users
  // know their security config isn't being enforced.
  const sandboxUnavailableReason = SandboxManager.getSandboxUnavailableReason()
  if (sandboxUnavailableReason) {
    if (SandboxManager.isSandboxRequired()) {
      process.stderr.write(
        `\nError: sandbox required but unavailable: ${sandboxUnavailableReason}\n` +
          `  sandbox.failIfUnavailable is set — refusing to start without a working sandbox.\n\n`,
      )
      gracefulShutdownSync(1)
      return
    }
    process.stderr.write(
      `\n⚠ Sandbox disabled: ${sandboxUnavailableReason}\n` +
        `  Commands will run WITHOUT sandboxing. Network and filesystem restrictions will NOT be enforced.\n\n`,
    )
  } else if (SandboxManager.isSandboxingEnabled()) {
    // Initialize sandbox with a callback that forwards network permission
    // requests to the SDK host via the can_use_tool control_request protocol.
    // This must happen after structuredIO is created so we can send requests.
    try {
      await SandboxManager.initialize(structuredIO.createSandboxAskCallback())
    } catch (err) {
      process.stderr.write(`\n❌ Sandbox Error: ${errorMessage(err)}\n`)
      gracefulShutdownSync(1, 'other')
      return
    }
  }

  // The native TUI receives QueryEngine messages through the direct observer
  // below. Registering the SDK hook lifecycle as a second delivery path would
  // expose SessionStart/Setup hook stdout (including additionalContext) as
  // transcript rows and duplicate fields such as output/stdout. The ordinary
  // print/SDK route keeps its established verbose hook-event contract.
  const ownsSdkHookEventDelivery = shouldRegisterSdkHookEventHandler({
    directQueryEventDelivery: routePolicy.directQueryEventDelivery,
    outputFormat: options.outputFormat,
    verbose: options.verbose,
  })
  if (ownsSdkHookEventDelivery) {
    registerHookEventHandler(event => {
      const message: StdoutMessage = (() => {
        switch (event.type) {
          case 'started':
            return {
              type: 'system' as const,
              subtype: 'hook_started' as const,
              hook_id: event.hookId,
              hook_name: event.hookName,
              hook_event: event.hookEvent,
              uuid: randomUUID(),
              session_id: getSessionId(),
            }
          case 'progress':
            return {
              type: 'system' as const,
              subtype: 'hook_progress' as const,
              hook_id: event.hookId,
              hook_name: event.hookName,
              hook_event: event.hookEvent,
              stdout: event.stdout,
              stderr: event.stderr,
              output: event.output,
              uuid: randomUUID(),
              session_id: getSessionId(),
            }
          case 'response':
            return {
              type: 'system' as const,
              subtype: 'hook_response' as const,
              hook_id: event.hookId,
              hook_name: event.hookName,
              hook_event: event.hookEvent,
              output: event.output,
              stdout: event.stdout,
              stderr: event.stderr,
              exit_code: event.exitCode,
              outcome: event.outcome,
              uuid: randomUUID(),
              session_id: getSessionId(),
            }
        }
      })()
      void structuredIO.write(message)
    })
  } else {
    suppressHookEventDelivery()
  }

  if (options.setupTrigger) {
    await processSetupHooks(options.setupTrigger)
  }

  headlessProfilerCheckpoint('before_loadInitialMessages')
  const appState = getAppState()
  const {
    messages: initialMessages,
    turnInterruptionState,
    agentSetting: resumedAgentSetting,
  } = await loadInitialMessages(setAppState, {
    continue: options.continue,
    resume: options.resume,
    resumeSessionAt: options.resumeSessionAt,
    forkSession: options.forkSession,
    outputFormat: options.outputFormat,
    sessionStartHooksPromise: options.sessionStartHooksPromise,
  })

  // SessionStart hooks can emit initialUserMessage — the first user turn for
  // headless orchestrator sessions where stdin is empty and additionalContext
  // alone (an attachment, not a turn) would leave the REPL with nothing to
  // respond to. The hook promise is awaited inside loadInitialMessages, so the
  // module-level pending value is set by the time we get here.
  const hookInitialUserMessage = takeInitialUserMessage()
  if (hookInitialUserMessage) {
    structuredIO.prependUserMessage(hookInitialUserMessage)
  }

  // Restore agent setting from the resumed session (if not overridden by current --agent flag
  // or settings-based agent, which would already have set mainThreadAgentType in main.tsx)
  if (!options.agent && !getMainThreadAgentType() && resumedAgentSetting) {
    const { agentDefinition: restoredAgent } = restoreAgentFromSession(
      resumedAgentSetting,
      undefined,
      { activeAgents: agents, allAgents: agents },
    )
    if (restoredAgent) {
      setAppState(prev => ({ ...prev, agent: restoredAgent.agentType }))
      // Thread the restored agent persona via mainThreadAgentDefinition so
      // QueryEngine routes through buildEffectiveSystemPrompt (W-PROMPT-
      // SYSTEM-ROOTCAUSE PR-2). The pre-fix form assigned the agent's
      // prompt into `options.systemPrompt`, which then carried a misleading
      // `# Custom System Prompt` header instead of `# Custom Agent
      // Instructions`. Existing guards preserved: skip when the user
      // explicitly passed --system-prompt and skip built-in agents.
      if (!options.systemPrompt && !isBuiltInAgent(restoredAgent)) {
        options.mainThreadAgentDefinition = restoredAgent
      }
      // Re-persist agent setting so future resumes maintain the agent
      saveAgentSetting(restoredAgent.agentType)
    }
  }

  // gracefulShutdownSync schedules an async shutdown and sets process.exitCode.
  // If a loadInitialMessages error path triggered it, bail early to avoid
  // unnecessary work while the process winds down.
  if (initialMessages.length === 0 && process.exitCode !== undefined) {
    return
  }

  // Handle --rewind-files: restore filesystem and exit immediately
  if (options.rewindFiles) {
    // File history snapshots are only created for user messages,
    // so we require the target to be a user message
    const targetMessage = initialMessages.find(
      m => m.uuid === options.rewindFiles,
    )

    if (!targetMessage || targetMessage.type !== 'user') {
      process.stderr.write(
        `Error: --rewind-files requires a user message UUID, but ${options.rewindFiles} is not a user message in this session\n`,
      )
      gracefulShutdownSync(1)
      return
    }

    const currentAppState = getAppState()
    const result = await handleRewindFiles(
      options.rewindFiles as UUID,
      currentAppState,
      setAppState,
      false,
    )
    if (!result.canRewind) {
      process.stderr.write(`Error: ${result.error || 'Unexpected error'}\n`)
      gracefulShutdownSync(1)
      return
    }

    // Rewind complete - exit successfully
    process.stdout.write(
      `Files rewound to state at message ${options.rewindFiles}\n`,
    )
    gracefulShutdownSync(0)
    return
  }

  // A valid local session resume can omit an initial prompt.
  const hasValidResumeSessionId =
    typeof options.resume === 'string' &&
    (Boolean(validateUuid(options.resume)) || options.resume.endsWith('.jsonl'))
  if (!inputPrompt && !hasValidResumeSessionId) {
    process.stderr.write(
      `Error: Input must be provided either through stdin or as a prompt argument when using --print\n`,
    )
    gracefulShutdownSync(1)
    return
  }

  if (options.outputFormat === 'stream-json' && !options.verbose) {
    process.stderr.write(
      'Error: When using --print, --output-format=stream-json requires --verbose\n',
    )
    gracefulShutdownSync(1)
    return
  }

  // Filter out MCP tools that are in the deny list
  const allowedMcpTools = filterToolsByDenyRules(
    appState.mcp.tools,
    appState.toolPermissionContext,
  )
  let filteredTools = [...tools, ...allowedMcpTools]

  const effectivePermissionPromptToolName = options.permissionPromptToolName

  // Callback for when a permission prompt is shown
  const onPermissionPrompt = (_details: RequiresActionDetails) => {
    if (feature('COMMIT_ATTRIBUTION')) {
      setAppState(prev => ({
        ...prev,
        attribution: {
          ...prev.attribution,
          permissionPromptCount: prev.attribution.permissionPromptCount + 1,
        },
      }))
    }
    notifySessionStateChanged('requires_action')
  }

  const canUseTool = getCanUseToolFn(
    effectivePermissionPromptToolName,
    structuredIO,
    () => getAppState().mcp.tools,
    onPermissionPrompt,
  )
  if (options.permissionPromptToolName) {
    // Remove the permission prompt tool from the list of available tools.
    filteredTools = filteredTools.filter(
      tool => !toolMatchesName(tool, options.permissionPromptToolName!),
    )
  }

  // Install errors handlers to gracefully handle broken pipes (e.g., when parent process dies)
  registerProcessOutputErrorHandlers()

  headlessProfilerCheckpoint('after_loadInitialMessages')

  // Ensure SDK model catalog is populated before generating model options.
  await ensureModelCachePopulated()
  headlessProfilerCheckpoint('after_modelStrings')

  // UDS inbox store registration is deferred until after `run` is defined
  // so we can pass `run` as the onEnqueue callback (see below).

  // Only `json` + `verbose` needs the full array (jsonStringify(messages) below).
  // For stream-json (SDK/CCR) and default text output, only the last message is
  // read for the exit code / final result. Avoid accumulating every message in
  // memory for the entire session.
  const needsFullArray = options.outputFormat === 'json' && options.verbose
  const messages: SDKMessage[] = []
  let lastMessage: SDKMessage | undefined
  // Streamlined mode transforms messages when CRABCODE_STREAMLINED_OUTPUT=true and using stream-json
  // Build flag gates this out of external builds; env var is the runtime opt-in for ant builds
  const transformToStreamlined = shouldTransformStreamOutput({
    directQueryEventDelivery: routePolicy.directQueryEventDelivery,
    streamlinedFeatureEnabled: feature('STREAMLINED_OUTPUT'),
    streamlinedEnvironmentValue:
      process.env.CRABCODE_STREAMLINED_OUTPUT,
    outputFormat: options.outputFormat,
  })
      ? createStreamlinedTransformer()
      : null

  headlessProfilerCheckpoint('before_runHeadlessStreaming')
  // Keep the direct runtime registry free of MCP commands. MCP is live
  // AppState data and is combined at the catalog/dispatch read boundary below;
  // retaining an initial MCP snapshot here would make later disconnects stale.
  // The standard SDK route keeps its established initial merged registry.
  const initialStreamingCommands = routePolicy.directQueryEventDelivery
    ? commandInventoryForRoute(routePolicy.slashCommandsEnabled, commands)
    : commandInventoryForRoute(
        routePolicy.slashCommandsEnabled,
        commands,
        appState.mcp.commands,
      )
  for await (const message of runHeadlessStreaming(
    structuredIO,
    appState.mcp.clients,
    initialStreamingCommands,
    filteredTools,
    initialMessages,
    canUseTool,
    onPermissionPrompt,
    sdkMcpConfigs,
    getAppState,
    setAppState,
    agents,
    {
      ...options,
      installSettingsMcpReconcile,
      closeHeadlessSettings,
    },
    generateSessionTitle,
    routePolicy,
    turnInterruptionState,
  )) {
    if (isDirectTuiRuntimeActionResult(message)) {
      if (options.outputFormat === 'stream-json' && options.verbose) {
        await structuredIO.write(message)
      }
      continue
    }
    if (isDirectTuiRendererEvent(message)) {
      if (options.outputFormat === 'stream-json' && options.verbose) {
        await structuredIO.write(message)
      }
      continue
    }
    if (transformToStreamlined) {
      // Streamlined mode: transform messages and stream immediately
      const transformed = transformToStreamlined(message)
      if (transformed) {
        await structuredIO.write(transformed)
      }
    } else if (options.outputFormat === 'stream-json' && options.verbose) {
      await structuredIO.write(message)
    }
    // Should not be getting control messages or stream events in non-stream mode.
    // Also filter out streamlined types since they're only produced by the transformer.
    // SDK-only system events are excluded so lastMessage stays at the result
    // (session_state_changed(idle) and any late task_notification drain after
    // result in the finally block).
    if (
      message.type !== 'control_response' &&
      message.type !== 'control_request' &&
      message.type !== 'control_cancel_request' &&
      !(
        message.type === 'system' &&
        (message.subtype === 'session_state_changed' ||
          message.subtype === 'task_notification' ||
          message.subtype === 'task_started' ||
          message.subtype === 'task_progress' ||
          message.subtype === 'post_turn_summary')
      ) &&
      message.type !== 'stream_event' &&
      message.type !== 'keep_alive' &&
      message.type !== 'streamlined_text' &&
      message.type !== 'streamlined_tool_use_summary' &&
      message.type !== 'prompt_suggestion'
    ) {
      if (needsFullArray) {
        messages.push(message)
      }
      lastMessage = message
    }
  }

  switch (options.outputFormat) {
    case 'json':
      if (!lastMessage || lastMessage.type !== 'result') {
        throw new Error('No messages returned')
      }
      if (options.verbose) {
        writeToStdout(jsonStringify(messages) + '\n')
        break
      }
      writeToStdout(jsonStringify(lastMessage) + '\n')
      break
    case 'stream-json':
      // already logged above
      break
    default:
      if (!lastMessage || lastMessage.type !== 'result') {
        throw new Error('No messages returned')
      }
      switch (lastMessage.subtype) {
        case 'success':
          writeToStdout(
            lastMessage.result.endsWith('\n')
              ? lastMessage.result
              : lastMessage.result + '\n',
          )
          break
        case 'error_during_execution':
          writeToStdout(`Execution error`)
          break
        case 'error_max_turns':
          writeToStdout(`Error: Reached max turns (${options.maxTurns})`)
          break
        case 'error_max_budget_usd':
          writeToStdout(`Error: Exceeded USD budget (${options.maxBudgetUsd})`)
          break
        case 'error_max_structured_output_retries':
          writeToStdout(
            `Error: Failed to provide valid structured output after maximum retries`,
          )
      }
  }

  // Log headless latency metrics for the final turn
  logHeadlessProfilerTurn()

  // Drain any in-flight memory extraction before shutdown. The response is
  // already flushed above, so this adds no user-visible latency — it just
  // delays process exit so gracefulShutdownSync's 5s failsafe doesn't kill
  // the forked agent mid-flight. Gated by isExtractModeActive so the
  // tengu_slate_thimble flag controls non-interactive extraction end-to-end.
  if (feature('EXTRACT_MEMORIES') && isExtractModeActive()) {
    await drainPendingExtraction()
  }

  gracefulShutdownSync(
    lastMessage?.type === 'result' && lastMessage?.is_error ? 1 : 0,
  )
}

function runHeadlessStreaming(
  structuredIO: StructuredIO,
  mcpClients: MCPServerConnection[],
  commands: Command[],
  tools: Tools,
  initialMessages: Message[],
  canUseTool: CanUseToolFn,
  onPermissionPrompt: (details: RequiresActionDetails) => void,
  sdkMcpConfigs: Record<string, McpSdkServerConfig>,
  getAppState: () => AppState,
  setAppState: (f: (prev: AppState) => AppState) => void,
  agents: AgentDefinition[],
  options: {
    verbose: boolean | undefined
    jsonSchema: Record<string, unknown> | undefined
    permissionPromptToolName: string | undefined
    allowedTools: string[] | undefined
    thinkingConfig: ThinkingConfig | undefined
    maxTurns: number | undefined
    maxBudgetUsd: number | undefined
    taskBudget: { total: number } | undefined
    systemPrompt: string | undefined
    appendSystemPrompt: string | undefined
    mainThreadAgentDefinition: AgentDefinition | undefined
    userSpecifiedModel: string | undefined
    fallbackModel: string | undefined
    replayUserMessages?: boolean | undefined
    includePartialMessages?: boolean | undefined
    enableAuthStatus?: boolean | undefined
    agent?: string | undefined
    setSDKStatus?: (status: SDKStatus) => void
    promptSuggestions?: boolean | undefined
    workload?: string | undefined
    taskListId?: string | undefined
    subscribeAppState?: (listener: () => void) => () => void
    startupSessionMcpServerNames?: readonly string[]
    startupSessionMcpServers?: Readonly<Record<string, ScopedMcpServerConfig>>
    startupPolicyBlockedMcpServerNames?: ReadonlySet<string> | readonly string[]
    lateFixedMcpConfig?: Promise<{
      name: string
      config: ScopedMcpServerConfig
    } | null>
    installSettingsMcpReconcile?: (listener: () => void) => void
    closeHeadlessSettings?: () => void
  },
  generateSessionTitle: NonNullable<
    RunHeadlessOptions['sessionTitleGenerator']
  >,
  routePolicy: HeadlessRoutePolicy,
  turnInterruptionState?: TurnInterruptionState,
): AsyncIterable<StructuredIoOutboundMessage> {
  let running = false
  let runPhase:
    | 'draining_commands'
    | 'waiting_for_agents'
    | 'finally_flush'
    | 'finally_post_flush'
    | undefined
  let inputClosed = false
  let runtimeInitialized = false
  let shutdownPromptInjected = false
  let heldBackResult: StdoutMessage | null = null
  let abortController: AbortController | undefined
  // Same queue sendRequest() enqueues to — one FIFO for everything.
  const output = structuredIO.outbound
  const directTeamInboxRuntime = routePolicy.directQueryEventDelivery
    ? new DirectTeamInboxRuntime({
        structuredIO,
        getAppState,
        setAppState,
        onPermissionPrompt: details => {
          onPermissionPrompt(details)
          for (const event of drainSdkEvents()) {
            output.enqueue(event)
          }
        },
        onPermissionQueueSettled: () => {
          if (
            structuredIO.getPendingPermissionRequests().length > 0 ||
            isShuttingDown()
          ) {
            return
          }
          notifySessionStateChanged(running ? 'running' : 'idle')
          for (const event of drainSdkEvents()) {
            output.enqueue(event)
          }
        },
        onWorkerPermissionNotification: notification => {
          void executeNotificationHooks(notification)
        },
      })
    : undefined
  const directQueryEventSink = routePolicy.directQueryEventDelivery
    ? createDirectTuiQueryEventSink(event => {
        // These are the existing internal query() messages, deliberately
        // outside the public SDK schema and explicitly typed only in the
        // process-private StructuredIO outbound union.
        output.enqueue(event)
      })
    : undefined

  // Ctrl+C in -p mode: abort the in-flight query, then shut down gracefully.
  // gracefulShutdown persists session state and flushes analytics, with a
  // failsafe timer that force-exits if cleanup hangs.
  const interruptHandler = (signal: 'SIGINT' | 'SIGBREAK') => {
    logForDiagnosticsNoPII('info', 'shutdown_signal', { signal })
    if (abortController && !abortController.signal.aborted) {
      abortController.abort()
    }
    void gracefulShutdown(signal === 'SIGBREAK' ? 149 : 0)
  }
  process.on('SIGINT', () => interruptHandler('SIGINT'))
  if (process.platform === 'win32') {
    process.on('SIGBREAK', () => interruptHandler('SIGBREAK'))
  }

  // Dump run()'s state at SIGTERM so a stuck session's healthsweep can name
  // the do/while(waitingForAgents) poll without reading the transcript.
  registerCleanup(async () => {
    const bg: Record<string, number> = {}
    for (const t of getRunningTasks(getAppState())) {
      if (isBackgroundTask(t)) bg[t.type] = (bg[t.type] ?? 0) + 1
    }
    logForDiagnosticsNoPII('info', 'run_state_at_shutdown', {
      run_active: running,
      run_phase: runPhase,
      worker_status: getSessionState(),
      bg_tasks: bg,
    })
  })

  // Wire the central onChangeAppState mode-diff hook to the SDK output stream.
  // This fires whenever ANY code path mutates toolPermissionContext.mode —
  // Shift+Tab, ExitPlanMode, slash commands, rewind, the query loop, and
  // stop-task all pass through this single notification path.
  setPermissionModeChangedListener(newMode => {
    // Only emit for SDK-exposed modes.
    if (
      newMode === 'default' ||
      newMode === 'acceptEdits' ||
      newMode === 'bypassPermissions' ||
      newMode === 'plan' ||
      newMode === (feature('TRANSCRIPT_CLASSIFIER') && 'auto') ||
      newMode === 'dontAsk'
    ) {
      output.enqueue({
        type: 'system',
        subtype: 'status',
        status: null,
        permissionMode: newMode as import('src/types/permissions.js').ExternalPermissionMode,
        uuid: randomUUID(),
        session_id: getSessionId(),
      })
    }
  })

  // Prompt suggestion tracking (push model)
  const suggestionState: {
    abortController: AbortController | null
    inflightPromise: Promise<void> | null
    lastEmitted: {
      text: string
      emittedAt: number
      promptId: PromptVariant
      generationRequestId: string | null
    } | null
    pendingSuggestion: {
      type: 'prompt_suggestion'
      suggestion: string
      uuid: UUID
      session_id: string
    } | null
    pendingLastEmittedEntry: {
      text: string
      promptId: PromptVariant
      generationRequestId: string | null
    } | null
  } = {
    abortController: null,
    inflightPromise: null,
    lastEmitted: null,
    pendingSuggestion: null,
    pendingLastEmittedEntry: null,
  }

  // Set up AWS auth status listener if enabled
  let unsubscribeAuthStatus: (() => void) | undefined
  if (options.enableAuthStatus) {
    const authStatusManager = AwsAuthStatusManager.getInstance()
    unsubscribeAuthStatus = authStatusManager.subscribe(status => {
      output.enqueue({
        type: 'auth_status',
        isAuthenticating: status.isAuthenticating,
        output: status.output,
        error: status.error,
        uuid: randomUUID(),
        session_id: getSessionId(),
      })
    })
  }

  // Set up rate limit status listener to emit SDKRateLimitEvent for all status changes.
  // Emitting for all statuses (including 'allowed') ensures consumers can clear warnings
  // when rate limits reset. The upstream emitStatusChange already deduplicates via isEqual.
  const rateLimitListener = (limits: AcosmiLimits) => {
    const rateLimitInfo = toSDKRateLimitInfo(limits)
    if (rateLimitInfo) {
      output.enqueue({
        type: 'rate_limit_event',
        rate_limit_info: rateLimitInfo,
        uuid: randomUUID(),
        session_id: getSessionId(),
      })
    }
  }
  statusListeners.add(rateLimitListener)

  // Messages for internal tracking, directly mutated by ask(). These messages
  // include Assistant, User, Attachment, and Progress messages.
  // Messages for internal tracking, directly mutated by ask().
  const mutableMessages: Message[] = initialMessages

  if (routePolicy.directQueryEventDelivery) {
    // Post-setup native panels share StructuredIO's one stdin reader and one
    // outbound FIFO. The renderer surface is process-local and installed only
    // for this direct route; the ordinary SDK/public control path is unchanged.
    structuredIO.setDirectTuiRuntimeActionRouter(
      createDirectTuiRuntimeActionRouter({
        retainedCommandSurface: {
          getAppState,
          setAppState,
          getMessages: () => mutableMessages,
          appendMetaMessages: contents => {
            mutableMessages.push(
              ...contents.map(content =>
                createUserMessage({ content, isMeta: true }),
              ),
            )
          },
        },
      }),
    )
  }

  // Seed the readFileState cache from the transcript (content the model saw,
  // with message timestamps) so getChangedFiles can detect external edits.
  // This cache instance must persist across ask() calls, since the edit tool
  // relies on this as a global state.
  let readFileState = extractReadFilesFromMessages(
    initialMessages,
    cwd(),
    READ_FILE_STATE_CACHE_SIZE,
  )

  // Client-supplied readFileState seeds (via seed_read_state control request).
  // The stdin IIFE runs concurrently with ask() — a seed arriving mid-turn
  // would be lost to ask()'s clone-then-replace (QueryEngine.ts finally block)
  // if written directly into readFileState. Instead, seeds land here, merge
  // into getReadFileCache's view (readFileState-wins-ties: seeds fill gaps),
  // and are re-applied then CLEARED in setReadFileCache. One-shot: each seed
  // survives exactly one clone-replace cycle, then becomes a regular
  // readFileState entry subject to compact's clear like everything else.
  const pendingSeeds = createFileStateCacheWithSizeLimit(
    READ_FILE_STATE_CACHE_SIZE,
  )

  // Auto-resume interrupted turns on restart so CC continues from where it
  // left off without requiring the SDK to re-send the prompt.
  const resumeInterruptedTurnEnv = process.env.CRABCODE_RESUME_INTERRUPTED_TURN
  if (
    turnInterruptionState &&
    turnInterruptionState.kind !== 'none' &&
    resumeInterruptedTurnEnv
  ) {
    logForDebugging(
      `[print.ts] Auto-resuming interrupted turn (kind: ${turnInterruptionState.kind})`,
    )

    // Remove the interrupted message and its sentinel, then re-enqueue so
    // the model sees it exactly once. For mid-turn interruptions, the
    // deserialization layer transforms them into interrupted_prompt by
    // appending a synthetic "Continue from where you left off." message.
    removeInterruptedMessage(mutableMessages, turnInterruptionState.message)
    enqueue({
      mode: 'prompt',
      value: turnInterruptionState.message.message.content,
      uuid: randomUUID(),
    })
  }

  const modelOptions = getModelOptions()
  const modelInfos = modelOptions.map(option => {
    const modelId = option.value === null ? 'default' : option.value
    const resolvedModel =
      modelId === 'default'
        ? getDefaultMainLoopModel()
        : parseUserSpecifiedModel(modelId)
    const hasEffort = modelSupportsEffort(resolvedModel)
    const hasAdaptiveThinking = modelSupportsAdaptiveThinking(resolvedModel)
    const hasFastMode = isFastModeSupportedByModel(option.value)
    const hasAutoMode = modelSupportsAutoMode(resolvedModel)
    return {
      value: modelId,
      displayName: option.label,
      description: option.description,
      ...(hasEffort && {
        supportsEffort: true,
        supportedEffortLevels: modelSupportsMaxEffort(resolvedModel)
          ? [...EFFORT_LEVELS]
          : EFFORT_LEVELS.filter(l => l !== 'max'),
      }),
      ...(hasAdaptiveThinking && { supportsAdaptiveThinking: true }),
      ...(hasFastMode && { supportsFastMode: true }),
      ...(hasAutoMode && { supportsAutoMode: true }),
    }
  })
  let activeUserSpecifiedModel = options.userSpecifiedModel
  let printAccountBridgeThinkingSelection:
    | AccountBridgeThinkingSelection
    | undefined

  function injectModelSwitchBreadcrumbs(
    modelArg: string,
    resolvedModel: string,
  ): void {
    const breadcrumbs = createModelSwitchBreadcrumbs(
      modelArg,
      modelDisplayString(resolvedModel),
    )
    mutableMessages.push(...breadcrumbs)
    for (const crumb of breadcrumbs) {
      if (
        typeof crumb.message.content === 'string' &&
        crumb.message.content.includes(`<${LOCAL_COMMAND_STDOUT_TAG}>`)
      ) {
        output.enqueue({
          type: 'user',
          message: crumb.message,
          session_id: getSessionId(),
          parent_tool_use_id: null,
          uuid: crumb.uuid,
          timestamp: crumb.timestamp,
          isReplay: true,
        } satisfies SDKUserMessageReplay)
      }
    }
  }

  const separateProcessMcpOwners = routePolicy.directQueryEventDelivery
  const startupSessionMcpServerNames = separateProcessMcpOwners
    ? new Set<string>(options.startupSessionMcpServerNames ?? [])
    : new Set<string>()
  const startupSessionMcpServers = separateProcessMcpOwners
    ? (options.startupSessionMcpServers ?? {})
    : {}
  const startupPolicyBlockedMcpServerNames = separateProcessMcpOwners
    ? (options.startupPolicyBlockedMcpServerNames ?? [])
    : ([] as const)

  // Cache SDK MCP clients to avoid reconnecting on each run
  let sdkClients: MCPServerConnection[] = []
  let sdkTools: Tools = []

  // Track which MCP clients have had elicitation handlers registered
  const elicitationRegistered = new Set<string>()

  /**
   * Register elicitation request/completion handlers on connected MCP clients
   * that haven't been registered yet. SDK MCP servers are excluded because they
   * route through SdkControlClientTransport. Hooks run first (matching REPL
   * behavior); if no hook responds, the request is forwarded to the SDK
   * consumer via the control protocol.
   */
  function registerElicitationHandlers(clients: MCPServerConnection[]): void {
    for (const connection of clients) {
      if (
        connection.type !== 'connected' ||
        // W-MCP-RUNTIME-OWNERSHIP: worker owns invocation; main-proc has no
        // handle for a worker-projected connected server — nothing to register
        // elicitation handlers on. Skip it (worker registers its own).
        !connection.client ||
        elicitationRegistered.has(connection.name)
      ) {
        continue
      }
      // Skip SDK MCP servers — elicitation flows through SdkControlClientTransport
      if (connection.config.type === 'sdk') {
        continue
      }
      const serverName = connection.name

      // Wrapped in try/catch because setRequestHandler throws if the client wasn't
      // created with elicitation capability declared (e.g., SDK-created clients).
      try {
        connection.client.setRequestHandler(
          ElicitRequestSchema,
          async (request, extra) => {
            logMCPDebug(
              serverName,
              `Elicitation request received in print mode: ${jsonStringify(request)}`,
            )

            const mode = request.params.mode === 'url' ? 'url' : 'form'

            logEvent('tengu_mcp_elicitation_shown', {
              mode: mode as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
            })

            // Run elicitation hooks first — they can provide a response programmatically
            const hookResponse = await runElicitationHooks(
              serverName,
              request.params,
              extra.signal,
            )
            if (hookResponse) {
              logMCPDebug(
                serverName,
                `Elicitation resolved by hook: ${jsonStringify(hookResponse)}`,
              )
              logEvent('tengu_mcp_elicitation_response', {
                mode: mode as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                action:
                  hookResponse.action as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              })
              return hookResponse
            }

            // Delegate to SDK consumer via control protocol
            const url =
              'url' in request.params
                ? (request.params.url as string)
                : undefined
            const requestedSchema =
              'requestedSchema' in request.params
                ? (request.params.requestedSchema as
                    | Record<string, unknown>
                    | undefined)
                : undefined

            const elicitationId =
              'elicitationId' in request.params
                ? (request.params.elicitationId as string | undefined)
                : undefined

            const rawResult = await structuredIO.handleElicitation(
              serverName,
              request.params.message,
              requestedSchema,
              extra.signal,
              mode,
              url,
              elicitationId,
            )

            const result = await runElicitationResultHooks(
              serverName,
              rawResult,
              extra.signal,
              mode,
              elicitationId,
            )

            logEvent('tengu_mcp_elicitation_response', {
              mode: mode as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              action:
                result.action as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
            })
            return result
          },
        )

        // Surface completion notifications to SDK consumers (URL mode)
        connection.client.setNotificationHandler(
          ElicitationCompleteNotificationSchema,
          notification => {
            const { elicitationId } = notification.params
            logMCPDebug(
              serverName,
              `Elicitation completion notification: ${elicitationId}`,
            )
            void executeNotificationHooks({
              message: `MCP server "${serverName}" confirmed elicitation ${elicitationId} complete`,
              notificationType: 'elicitation_complete',
            })
            output.enqueue({
              type: 'system',
              subtype: 'elicitation_complete',
              mcp_server_name: serverName,
              elicitation_id: elicitationId,
              uuid: randomUUID(),
              session_id: getSessionId(),
            })
          },
        )

        elicitationRegistered.add(serverName)
      } catch {
        // setRequestHandler throws if the client wasn't created with
        // elicitation capability — skip silently
      }
    }
  }

  async function updateSdkMcp() {
    // Check if SDK MCP servers need to be updated (new servers added or removed)
    const currentServerNames = new Set(Object.keys(sdkMcpConfigs))
    const connectedServerNames = new Set(sdkClients.map(c => c.name))

    // Check if there are any differences (additions or removals)
    const hasNewServers = Array.from(currentServerNames).some(
      name => !connectedServerNames.has(name),
    )
    const hasRemovedServers = Array.from(connectedServerNames).some(
      name => !currentServerNames.has(name),
    )
    // Check if any SDK clients are pending and need to be upgraded
    const hasPendingSdkClients = sdkClients.some(c => c.type === 'pending')
    // Check if any SDK clients failed their handshake and need to be retried.
    // Without this, a client that lands in 'failed' (e.g. handshake timeout on
    // a WS reconnect race) stays failed forever — its name satisfies the
    // connectedServerNames diff but it contributes zero tools.
    const hasFailedSdkClients = sdkClients.some(c => c.type === 'failed')
    const haveServersChanged =
      hasNewServers ||
      hasRemovedServers ||
      hasPendingSdkClients ||
      hasFailedSdkClients

    if (haveServersChanged) {
      // Clean up clients for removed SDK MCP servers
      for (const client of sdkClients) {
        if (
          !currentServerNames.has(client.name) &&
          client.type === 'connected'
        ) {
          await client.cleanup()
        }
      }

      // Recreate SDK MCP clients with the current config
      const sdkSetup = await setupSdkMcpClients(
        sdkMcpConfigs,
        (serverName, message) =>
          structuredIO.sendMcpMessage(serverName, message),
      )
      sdkClients = sdkSetup.clients
      sdkTools = sdkSetup.tools

      // Store SDK MCP tools in appState so subagents can access them via
      // assembleToolPool. Only tools are stored here — SDK clients are already
      // merged separately in the query loop (allMcpClients) and mcp_status handler.
      // Use both old (connectedServerNames) and new (currentServerNames) to
      // remove stale SDK tools when servers are added or removed.
      const allSdkNames = uniq([
        ...connectedServerNames,
        ...currentServerNames,
      ])
      setAppState(prev => ({
        ...prev,
        mcp: {
          ...prev.mcp,
          tools: [
            ...prev.mcp.tools.filter(
              t =>
                !allSdkNames.some(name =>
                  t.name.startsWith(getMcpPrefix(name)),
                ),
            ),
            ...sdkTools,
          ],
        },
      }))

      // Set up the special internal VSCode MCP server if necessary.
      setupVscodeSdkMcp(sdkClients)
    }
  }

  void updateSdkMcp()

  const emptyProcessMcpState = (): DynamicMcpState => ({
    clients: [],
    tools: [],
    configs: {},
  })
  const startupProcessMcp = routePolicy.directQueryEventDelivery
    ? partitionStartupProcessMcpState(
        mcpClients,
        tools,
        startupSessionMcpServerNames,
      )
    : null
  let pluginProcessMcpState =
    startupProcessMcp?.dynamicState ?? emptyProcessMcpState()
  let dynamicMcpState = emptyProcessMcpState()
  let publicProcessMcpDesired: Record<
    string,
    McpServerConfigForProcessTransport
  > = {}
  const directControlDisabledMcpNames = new Set<string>()
  const startupSessionProcessMcpNames = new Set([
    ...startupSessionMcpServerNames,
    ...startupPolicyBlockedMcpServerNames,
  ])
  const startupSessionProcessMcpConfigs: Record<
    string,
    ScopedMcpServerConfig
  > = { ...startupSessionMcpServers }
  const policyBlockedSessionMcpNames = new Set<string>()
  const observedStartupInactiveMcpNames = new Set<string>()
  const syncCapturedFixedMcpConfigs = (): void => {
    for (const [name, config] of Object.entries(startupSessionMcpServers)) {
      startupSessionProcessMcpConfigs[name] = config
      startupSessionProcessMcpNames.add(name)
    }
    for (const name of startupPolicyBlockedMcpServerNames) {
      if (observedStartupInactiveMcpNames.has(name)) continue
      observedStartupInactiveMcpNames.add(name)
      policyBlockedSessionMcpNames.add(name)
      startupSessionProcessMcpNames.add(name)
    }
  }
  syncCapturedFixedMcpConfigs()
  for (const name of Object.keys(startupSessionProcessMcpConfigs)) {
    if (isMcpServerDisabled(name)) {
      directControlDisabledMcpNames.add(name)
    }
  }
  if (startupProcessMcp) {
    mcpClients = startupProcessMcp.remainingClients
  }
  // The original tool argument may already contain MCP tools. Keep a mutable
  // headless pool so a later control-plane disable removes them from the next
  // model turn instead of leaving an immutable first-wins copy behind.
  let headlessTools = startupProcessMcp?.remainingTools ?? tools

  const upsertConnection = (
    clients: MCPServerConnection[],
    client: MCPServerConnection,
  ): MCPServerConnection[] => [
    ...clients.filter(existing => existing.name !== client.name),
    client,
  ]

  const syncHeadlessMcpRuntime = (
    serverName: string,
    client: MCPServerConnection | null,
    nextTools: Tools = [],
  ): void => {
    const prefix = getMcpPrefix(serverName)
    const isSdk = separateProcessMcpOwners
      ? serverName in sdkMcpConfigs
      : sdkClients.some(existing => existing.name === serverName)
    const isDynamic = serverName in dynamicMcpState.configs
    const isPluginProcess = serverName in pluginProcessMcpState.configs
    const updateOwnedState = (state: DynamicMcpState): DynamicMcpState => ({
      ...state,
      clients: client
        ? upsertConnection(state.clients, client)
        : state.clients.filter(existing => existing.name !== serverName),
      tools: [
        ...state.tools.filter(tool => !tool.name?.startsWith(prefix)),
        ...nextTools,
      ],
    })
    if (isSdk) {
      sdkClients = client
        ? upsertConnection(sdkClients, client)
        : sdkClients.filter(existing => existing.name !== serverName)
      sdkTools = [
        ...sdkTools.filter(tool => !tool.name?.startsWith(prefix)),
        ...nextTools,
      ]
    } else if (isDynamic) {
      dynamicMcpState = updateOwnedState(dynamicMcpState)
    } else if (isPluginProcess) {
      pluginProcessMcpState = updateOwnedState(pluginProcessMcpState)
    } else {
      headlessTools = [
        ...headlessTools.filter(tool => !tool.name?.startsWith(prefix)),
        ...nextTools,
      ]
      mcpClients = client
        ? upsertConnection(mcpClients, client)
        : mcpClients.filter(existing => existing.name !== serverName)
    }
  }

  const commandOwnedByMcpServer = (
    command: Command,
    serverName: string,
  ): boolean =>
    (command.isMcp === true ||
      (command.type === 'prompt' && command.loadedFrom === 'mcp')) &&
    commandBelongsToServer(command, serverName)

  const clearDirectMcpProjection = (serverName: string): void => {
    const prefix = getMcpPrefix(serverName)
    syncHeadlessMcpRuntime(serverName, null)
    setAppState(prev => ({
      ...prev,
      mcp: {
        ...prev.mcp,
        clients: prev.mcp.clients.filter(client => client.name !== serverName),
        tools: reject(prev.mcp.tools, tool => tool.name?.startsWith(prefix)),
        commands: reject(prev.mcp.commands, command =>
          commandOwnedByMcpServer(command, serverName),
        ),
        resources: omit(prev.mcp.resources, serverName),
      },
    }))
  }

  const commitDirectMcpReconnect = (
    serverName: string,
    result: Awaited<ReturnType<typeof reconnectMcpServerImpl>>,
    ownedConfig?: DirectOwnedMcpTarget,
  ): void => {
    const prefix = getMcpPrefix(serverName)
    if (ownedConfig?.owner === 'public') {
      dynamicMcpState = {
        ...dynamicMcpState,
        configs: {
          ...dynamicMcpState.configs,
          [serverName]: ownedConfig.config,
        },
      }
    } else if (ownedConfig?.owner === 'plugin') {
      pluginProcessMcpState = {
        ...pluginProcessMcpState,
        configs: {
          ...pluginProcessMcpState.configs,
          [serverName]: ownedConfig.config,
        },
      }
    }
    syncHeadlessMcpRuntime(serverName, result.client, result.tools)
    setAppState(prev => ({
      ...prev,
      mcp: {
        ...prev.mcp,
        clients: upsertConnection(prev.mcp.clients, result.client),
        tools: [
          ...reject(prev.mcp.tools, tool => tool.name?.startsWith(prefix)),
          ...result.tools,
        ],
        commands: [
          ...reject(prev.mcp.commands, command =>
            commandOwnedByMcpServer(command, serverName),
          ),
          ...result.commands,
        ],
        resources:
          result.resources && result.resources.length > 0
            ? { ...prev.mcp.resources, [serverName]: result.resources }
            : omit(prev.mcp.resources, serverName),
      },
    }))
  }

  // Shared tool assembly for ask() and the get_context_usage control request.
  // Closes over every mutable MCP owner so both call sites see late-connecting
  // servers without letting one desired-set lifecycle erase another.
  const buildAllTools = (appState: AppState): Tools => {
    const assembledTools = assembleToolPool(
      appState.toolPermissionContext,
      appState.mcp.tools,
    )
    let allTools = uniqBy(
      mergeAndFilterTools(
        [
          ...headlessTools,
          ...sdkTools,
          ...dynamicMcpState.tools,
          ...pluginProcessMcpState.tools,
        ],
        assembledTools,
        appState.toolPermissionContext.mode,
      ),
      'name',
    )
    if (options.permissionPromptToolName) {
      allTools = allTools.filter(
        tool => !toolMatchesName(tool, options.permissionPromptToolName!),
      )
    }
    const initJsonSchema = getInitJsonSchema()
    if (initJsonSchema && !options.jsonSchema) {
      const syntheticOutputResult = createSyntheticOutputTool(initJsonSchema)
      if ('tool' in syntheticOutputResult) {
        allTools = [...allTools, syntheticOutputResult.tool]
      }
    }
    return allTools
  }

  // Helper to apply MCP server changes for one explicit process-server owner.
  // Direct TUI separates public and plugin process ownership; the standard SDK
  // route retains its historical shared desired set.
  const activeOAuthFlows = new Map<string, AbortController>()
  const oauthCallbackSubmitters = new Map<
    string,
    (callbackUrl: string) => void
  >()
  const oauthManualCallbackUsed = new Set<string>()
  const oauthAuthPromises = new Map<string, Promise<void>>()
  const invalidateActiveMcpOAuthFlow = (serverName: string): void => {
    activeOAuthFlows.get(serverName)?.abort()
    activeOAuthFlows.delete(serverName)
    oauthCallbackSubmitters.delete(serverName)
    oauthManualCallbackUsed.delete(serverName)
    oauthAuthPromises.delete(serverName)
  }
  const serializeMcpMutation = createMcpMutationLane()
  const runDirectMcpMutation = <T>(work: () => Promise<T>): Promise<T> =>
    separateProcessMcpOwners ? serializeMcpMutation(work) : work()

  function applyMcpServerChanges(
    owner: McpProcessOwner,
    servers: Record<string, McpServerConfigForProcessTransport>,
    alreadySerialized = false,
    commitPublicDesired = owner === 'public',
  ): Promise<{
    response: SDKControlMcpSetServersResponse
    sdkServersChanged: boolean
  }> {
    const requestedServers = separateProcessMcpOwners
      ? structuredClone(servers)
      : servers
    // Serialize calls to prevent race conditions between concurrent callers
    // (background plugin install and mcp_set_servers control messages)
    const doWork = async (): Promise<{
      response: SDKControlMcpSetServersResponse
      sdkServersChanged: boolean
    }> => {
      const activeRequestedServers = separateProcessMcpOwners
        ? Object.fromEntries(
            Object.entries(requestedServers).filter(
              ([name, config]) =>
                config.type === 'sdk' ||
                (owner === 'public' && commitPublicDesired) ||
                !directControlDisabledMcpNames.has(name),
            ),
          )
        : requestedServers
      const oldSdkClientNames = new Set(sdkClients.map(c => c.name))
      const effectiveOwner = separateProcessMcpOwners ? owner : 'public'
      const ownerState =
        effectiveOwner === 'public' ? dynamicMcpState : pluginProcessMcpState
      const otherOwnerState =
        effectiveOwner === 'public' ? pluginProcessMcpState : dynamicMcpState
      const publicSdkPreservation =
        separateProcessMcpOwners && owner === 'public'
          ? preservePublicProcessDesiredAcrossSdkRejections(
              requestedServers,
              publicProcessMcpDesired,
              ownerState.configs,
            )
          : null
      const managedOwnerNames = new Set([
        ...Object.keys(dynamicMcpState.configs),
        ...Object.keys(pluginProcessMcpState.configs),
        ...Object.keys(sdkMcpConfigs),
      ])
      const fixedProcessOwnerNames = new Set(
        [...mcpClients, ...getAppState().mcp.clients]
          .map(client => client.name)
          .filter(name => !managedOwnerNames.has(name)),
      )
      const ownership = separateProcessMcpOwners
        ? prepareMcpServersForOwner(
            owner,
            activeRequestedServers,
            new Set([
              ...Object.keys(otherOwnerState.configs),
              ...(owner === 'plugin'
                ? Object.keys(publicProcessMcpDesired)
                : []),
            ]),
            new Set([
              ...startupSessionProcessMcpNames,
              ...fixedProcessOwnerNames,
            ]),
          )
        : {
            reconciliationServers: activeRequestedServers,
            errors: {},
          }

      // Public desired state and public executable state are different
      // authorities. A disabled row remains a logical owner (so a later
      // toggle-on can use the latest requested config and other owners cannot
      // claim its namespace), but it must never reach the connector while the
      // persisted disabled setting is authoritative.
      const admittedPublicProcessServers =
        separateProcessMcpOwners && owner === 'public'
          ? { ...ownership.reconciliationServers }
          : null

      if (publicSdkPreservation) {
        Object.assign(
          ownership.reconciliationServers,
          publicSdkPreservation.retained,
        )
      }
      if (separateProcessMcpOwners && owner === 'public') {
        for (const name of Object.keys(ownership.reconciliationServers)) {
          if (
            directControlDisabledMcpNames.has(name) ||
            isMcpServerDisabled(name)
          ) {
            delete ownership.reconciliationServers[name]
          }
        }
      }

      if (separateProcessMcpOwners) {
        for (const [name, currentConfig] of Object.entries(
          ownerState.configs,
        )) {
          const desiredConfig = ownership.reconciliationServers[name]
          const scopedDesired = desiredConfig
            ? toScopedConfig(
                desiredConfig,
                owner === 'plugin',
              )
            : null
          if (
            !scopedDesired ||
            !areMcpConfigsEqual(currentConfig, scopedDesired) ||
            currentConfig.scope !== scopedDesired.scope
          ) {
            invalidateActiveMcpOAuthFlow(name)
          }
        }
      }

      const result = await handleMcpSetServers(
        ownership.reconciliationServers,
        { configs: sdkMcpConfigs, clients: sdkClients, tools: sdkTools },
        ownerState,
        setAppState,
        {
          syncPromptCommands:
            routePolicy.directQueryEventDelivery &&
            routePolicy.slashCommandsEnabled,
          syncResourceCleanup: routePolicy.directQueryEventDelivery,
          strictWireNamespaceCleanup:
            routePolicy.directQueryEventDelivery,
          preserveDesiredScopes:
            separateProcessMcpOwners && owner === 'plugin',
        },
      )
      if (publicSdkPreservation) {
        if (commitPublicDesired) {
          publicProcessMcpDesired = structuredClone(
            Object.fromEntries(
              Object.entries(publicSdkPreservation.desired).filter(
                ([name]) =>
                  (admittedPublicProcessServers !== null &&
                    name in admittedPublicProcessServers) ||
                  (requestedServers[name]?.type === 'sdk' &&
                    name in publicSdkPreservation.desired) ||
                  ownership.errors[name]?.startsWith(
                    'Blocked by enterprise policy',
                  ),
              ),
            ),
          )
          for (const name of Object.keys(admittedPublicProcessServers ?? {})) {
            if (requestedServers[name]?.type === 'sdk') continue
            if (isMcpServerDisabled(name)) {
              // A public desired row submitted after startup can encounter a
              // persisted disabled setting before any in-session toggle has
              // seeded the marker. Preserve that authority so reconnect and
              // OAuth cannot bypass the inert executable projection.
              directControlDisabledMcpNames.add(name)
            } else directControlDisabledMcpNames.delete(name)
          }
        }
      }
      // Update SDK state (need to mutate sdkMcpConfigs since it's shared)
      for (const key of Object.keys(sdkMcpConfigs)) {
        delete sdkMcpConfigs[key]
      }
      Object.assign(sdkMcpConfigs, result.newSdkState.configs)
      sdkClients = result.newSdkState.clients
      sdkTools = result.newSdkState.tools
      if (effectiveOwner === 'public') {
        dynamicMcpState = result.newDynamicState
      } else {
        pluginProcessMcpState = result.newDynamicState
      }

      // Keep appState.mcp.tools in sync so subagents can see SDK MCP tools.
      // Use both old and new SDK client names to remove stale tools.
      if (result.sdkServersChanged) {
        const newSdkClientNames = new Set(sdkClients.map(c => c.name))
        const allSdkNames = uniq([
          ...oldSdkClientNames,
          ...newSdkClientNames,
        ])
        setAppState(prev => ({
          ...prev,
          mcp: {
            ...prev.mcp,
            tools: [
              ...prev.mcp.tools.filter(
                t =>
                  !allSdkNames.some(name =>
                    t.name.startsWith(getMcpPrefix(name)),
                  ),
              ),
              ...sdkTools,
            ],
          },
        }))
      }

      return {
        response: {
          ...result.response,
          errors: { ...result.response.errors, ...ownership.errors },
        },
        sdkServersChanged: result.sdkServersChanged,
      }
    }

    return alreadySerialized ? doWork() : serializeMcpMutation(doWork)
  }

  type DirectOwnedMcpTarget = {
    owner: 'public' | 'plugin' | 'fixed'
    config: ScopedMcpServerConfig
  }
  const getDirectOwnedMcpTarget = (
    serverName: string,
  ): DirectOwnedMcpTarget | null => {
    if (!separateProcessMcpOwners) return null
    const currentAppState = getAppState()
    const publicConfig = dynamicMcpState.configs[serverName]
    if (publicConfig) return { owner: 'public', config: publicConfig }
    const pluginConfig = pluginProcessMcpState.configs[serverName]
    if (pluginConfig) return { owner: 'plugin', config: pluginConfig }
    const fixedConfig =
      mcpClients.find(client => client.name === serverName)?.config ??
      currentAppState.mcp.clients.find(client => client.name === serverName)
        ?.config
    if (fixedConfig) return { owner: 'fixed', config: fixedConfig }
    const publicDesiredConfig = publicProcessMcpDesired[serverName]
    if (publicDesiredConfig) {
      return {
        owner: 'public',
        config: toScopedConfig(publicDesiredConfig),
      }
    }
    const capturedFixedConfig = startupSessionProcessMcpConfigs[serverName]
    return capturedFixedConfig
      ? { owner: 'fixed', config: capturedFixedConfig }
      : null
  }

  const directMcpTargetIsOwned = (serverName: string): boolean =>
    getDirectOwnedMcpTarget(serverName) !== null

  const directMcpTargetIsLive = (serverName: string): boolean => {
    const currentAppState = getAppState()
    return (
      serverName in dynamicMcpState.configs ||
      serverName in pluginProcessMcpState.configs ||
      mcpClients.some(client => client.name === serverName) ||
      currentAppState.mcp.clients.some(client => client.name === serverName)
    )
  }

  const directMcpNameOwnershipError = (
    serverName: string,
    allowCapturedFixedSelf = false,
  ): string | null => {
    if (!separateProcessMcpOwners || directMcpTargetIsLive(serverName)) return null
    const logicalTarget = getDirectOwnedMcpTarget(serverName)
    const currentAppState = getAppState()
    const liveOwnerNames = new Set([
      ...Object.keys(dynamicMcpState.configs),
      ...Object.keys(pluginProcessMcpState.configs),
      ...Object.keys(publicProcessMcpDesired),
      ...startupSessionProcessMcpNames,
      ...mcpClients.map(client => client.name),
      ...currentAppState.mcp.clients.map(client => client.name),
    ])
    if (allowCapturedFixedSelf || logicalTarget) {
      liveOwnerNames.delete(serverName)
    }
    return (
      filterMcpServersForOwner(
        'plugin',
        { [serverName]: true },
        liveOwnerNames,
      ).errors[serverName] ?? null
    )
  }

  const directMcpControlAdmissionError = (
    serverName: string,
    config: ScopedMcpServerConfig,
  ): string | null => {
    if (!separateProcessMcpOwners) return null
    if (config.type === 'sdk') return DIRECT_TUI_SDK_MCP_UNSUPPORTED_ERROR

    const policy = filterMcpServersByPolicy({ [serverName]: config })
    if (policy.blocked.includes(serverName)) {
      return 'Blocked by enterprise policy (allowedMcpServers/deniedMcpServers)'
    }

    // An already-live raw owner is reconnecting its own namespace. A static
    // inventory row has no such authority and must be checked against every
    // live owner before it may persist, authenticate, or connect.
    return directMcpNameOwnershipError(serverName)
  }

  async function reconcileDirectSessionMcpPolicy(): Promise<void> {
    if (!separateProcessMcpOwners || inputClosed) return
    await runDirectMcpMutation(async () => {
      if (inputClosed) return
      syncCapturedFixedMcpConfigs()
      const settingsControlledNames = new Set([
        ...Object.keys(startupSessionProcessMcpConfigs),
        ...Object.keys(publicProcessMcpDesired),
      ])
      for (const name of settingsControlledNames) {
        if (isMcpServerDisabled(name)) {
          directControlDisabledMcpNames.add(name)
        } else {
          directControlDisabledMcpNames.delete(name)
        }
      }
      const { allowed } = filterMcpServersByPolicy(
        startupSessionProcessMcpConfigs,
      )
      const runtimeAllowedNames = new Set(
        Object.keys(allowed).filter(name => !isMcpServerDisabled(name)),
      )
      const transitions = planCapturedMcpPolicyTransitions(
        startupSessionProcessMcpConfigs,
        runtimeAllowedNames,
        policyBlockedSessionMcpNames,
        directControlDisabledMcpNames,
      )

      for (const serverName of transitions.toBlock) {
        const config = startupSessionProcessMcpConfigs[serverName]
        if (!config) continue
        invalidateActiveMcpOAuthFlow(serverName)
        await evictExistingServerCache(serverName, config)
        clearDirectMcpProjection(serverName)
        policyBlockedSessionMcpNames.add(serverName)
      }

      for (const serverName of transitions.toRestore) {
        const config = startupSessionProcessMcpConfigs[serverName]
        if (!config) continue

        // A policy-blocked startup entry did not claim a wire namespace.
        // Re-check the live namespace before restoring so a late allow cannot
        // erase a server that legitimately occupied it in the meantime.
        const ownershipError = directMcpNameOwnershipError(serverName, true)
        if (ownershipError) {
          logForDebugging(
            `Refusing MCP restore after policy update for "${serverName}": ${ownershipError}`,
            { level: 'warn' },
          )
          continue
        }

        const result = await reconnectMcpServerImpl(serverName, config)
        commitDirectMcpReconnect(serverName, result)
        policyBlockedSessionMcpNames.delete(serverName)
        if (result.client.type === 'connected') {
          registerElicitationHandlers([result.client])
          reregisterChannelHandlerAfterReconnect(result.client)
        }
      }
    })
  }

  async function admitLateFixedMcpConfig(candidate: {
    name: string
    config: ScopedMcpServerConfig
  }): Promise<void> {
    if (!separateProcessMcpOwners || inputClosed) return
    await runDirectMcpMutation(async () => {
      if (inputClosed) return
      const { name, config } = candidate
      if (config.type === 'sdk') {
        logForDebugging(
          `Ignoring late fixed MCP server "${name}": ${DIRECT_TUI_SDK_MCP_UNSUPPORTED_ERROR}`,
          { level: 'warn' },
        )
        return
      }
      const existingTarget = getDirectOwnedMcpTarget(name)
      if (existingTarget) {
        logForDebugging(
          `Ignoring late fixed MCP server "${name}": already owned by the ${existingTarget.owner} lifecycle`,
          { level: 'warn' },
        )
        return
      }
      const currentAppState = getAppState()
      const ownership = filterMcpServersForOwner(
        'plugin',
        { [name]: config },
        new Set([
          ...Object.keys(dynamicMcpState.configs),
          ...Object.keys(pluginProcessMcpState.configs),
          ...Object.keys(publicProcessMcpDesired),
          ...startupSessionProcessMcpNames,
          ...mcpClients.map(client => client.name),
          ...currentAppState.mcp.clients.map(client => client.name),
        ]),
      )
      if (ownership.errors[name]) {
        logForDebugging(
          `Ignoring late fixed MCP server "${name}": ${ownership.errors[name]}`,
          { level: 'warn' },
        )
        return
      }

      startupSessionProcessMcpConfigs[name] = config
      startupSessionProcessMcpNames.add(name)
      const policy = filterMcpServersByPolicy({ [name]: config })
      if (policy.blocked.includes(name) || isMcpServerDisabled(name)) {
        policyBlockedSessionMcpNames.add(name)
        observedStartupInactiveMcpNames.add(name)
        if (isMcpServerDisabled(name)) {
          directControlDisabledMcpNames.add(name)
        }
        return
      }

      const result = await reconnectMcpServerImpl(name, config)
      commitDirectMcpReconnect(name, result)
      if (result.client.type === 'connected') {
        registerElicitationHandlers([result.client])
        reregisterChannelHandlerAfterReconnect(result.client)
      }
    })
  }

  async function claimDirectPluginMcpOwner(
    serverName: string,
  ): Promise<string | null> {
    if (!separateProcessMcpOwners) return null
    const existingTarget = getDirectOwnedMcpTarget(serverName)
    if (existingTarget) {
      return existingTarget.owner === 'plugin'
        ? null
        : `MCP server is already owned by the ${existingTarget.owner} lifecycle: ${serverName}`
    }
    await applyPluginMcpDiff()
    return getDirectOwnedMcpTarget(serverName)?.owner === 'plugin'
      ? null
      : `MCP server was not admitted by the direct TUI ownership lifecycle: ${serverName}`
  }

  type DirectMcpActionResult =
    | { ok: true; client?: MCPServerConnection }
    | { ok: false; error: string }

  async function reconnectDirectMcpServer(
    serverName: string,
  ): Promise<DirectMcpActionResult> {
    const preparation = await runDirectMcpMutation(async (): Promise<
      | { claimPlugin: true }
      | { claimPlugin: false; result: DirectMcpActionResult }
    > => {
      if (directControlDisabledMcpNames.has(serverName)) {
        return {
          claimPlugin: false,
          result: {
            ok: false,
            error: `MCP server "${serverName}" is disabled`,
          },
        }
      }
      const target = getDirectOwnedMcpTarget(serverName)
      if (!target) {
        const ownershipError = directMcpNameOwnershipError(serverName)
        if (ownershipError) {
          return {
            claimPlugin: false,
            result: { ok: false, error: ownershipError },
          }
        }
        const inventoryRecord = isPluginMcpRuntimeName(serverName)
          ? (await getCrabCodeMcpConfigs()).pluginInventory.find(
              record => record.runtimeName === serverName,
            )
          : undefined
        if (isDirectTuiSdkMcpInventoryRecord(inventoryRecord)) {
          return {
            claimPlugin: false,
            result: {
              ok: false,
              error: DIRECT_TUI_SDK_MCP_UNSUPPORTED_ERROR,
            },
          }
        }
        const candidate = await getActiveMcpConfigByName(serverName)
        if (!candidate) {
          return {
            claimPlugin: false,
            result: {
              ok: false,
              error: `Server not found: ${serverName}`,
            },
          }
        }
        const admissionError = directMcpControlAdmissionError(
          serverName,
          candidate,
        )
        return admissionError
          ? {
              claimPlugin: false,
              result: { ok: false, error: admissionError },
            }
          : { claimPlugin: true }
      }
      if (target.owner === 'plugin') {
        const inventoryRecord = (
          await getCrabCodeMcpConfigs()
        ).pluginInventory.find(record => record.runtimeName === serverName)
        if (isDirectTuiSdkMcpInventoryRecord(inventoryRecord)) {
          return {
            claimPlugin: false,
            result: {
              ok: false,
              error: DIRECT_TUI_SDK_MCP_UNSUPPORTED_ERROR,
            },
          }
        }
      }
      const config =
        target.owner === 'plugin'
          ? await getActiveMcpConfigByName(serverName)
          : target.config
      if (!config) {
        return {
          claimPlugin: false,
          result: { ok: false, error: `Server not found: ${serverName}` },
        }
      }
      const admissionError = directMcpControlAdmissionError(
        serverName,
        config,
      )
      if (admissionError) {
        return {
          claimPlugin: false,
          result: { ok: false, error: admissionError },
        }
      }

      elicitationRegistered.delete(serverName)
      if (
        target.owner === 'plugin' &&
        getServerCacheKey(serverName, target.config) !==
          getServerCacheKey(serverName, config)
      ) {
        await evictExistingServerCache(serverName, target.config)
      }
      const result = await reconnectMcpServerImpl(serverName, config)
      commitDirectMcpReconnect(
        serverName,
        result,
        { owner: target.owner, config },
      )
      if (result.client.type === 'connected') {
        registerElicitationHandlers([result.client])
        reregisterChannelHandlerAfterReconnect(result.client)
        return {
          claimPlugin: false,
          result: { ok: true, client: result.client },
        }
      }
      return {
        claimPlugin: false,
        result: {
          ok: false,
          error:
            result.client.type === 'failed'
              ? (result.client.error ?? 'Connection failed')
              : `Server status: ${result.client.type}`,
        },
      }
    })
    if (!preparation.claimPlugin) return preparation.result

    const claimError = await claimDirectPluginMcpOwner(serverName)
    if (claimError) return { ok: false, error: claimError }
    return runDirectMcpMutation(async () => {
      if (getDirectOwnedMcpTarget(serverName)?.owner !== 'plugin') {
        return {
          ok: false,
          error: `MCP server was not admitted by the direct TUI ownership lifecycle: ${serverName}`,
        }
      }
      const claimedClient = pluginProcessMcpState.clients.find(
        client => client.name === serverName,
      )
      if (claimedClient?.type === 'connected') {
        registerElicitationHandlers([claimedClient])
        reregisterChannelHandlerAfterReconnect(claimedClient)
        return { ok: true, client: claimedClient }
      }
      return {
        ok: false,
        error:
          claimedClient?.type === 'failed'
            ? (claimedClient.error ?? 'Connection failed')
            : `Server status: ${claimedClient?.type ?? 'unavailable'}`,
      }
    })
  }

  async function toggleDirectMcpServer(
    serverName: string,
    enabled: boolean,
  ): Promise<DirectMcpActionResult> {
    const preparation = await runDirectMcpMutation(async (): Promise<
      | { claimPlugin: true }
      | { claimPlugin: false; result: DirectMcpActionResult }
    > => {
      const target = getDirectOwnedMcpTarget(serverName)
      if (!target) {
        const ownershipError = directMcpNameOwnershipError(serverName)
        if (ownershipError) {
          return {
            claimPlugin: false,
            result: { ok: false, error: ownershipError },
          }
        }

        const activeConfig = await getActiveMcpConfigByName(serverName)
        const inventoryRecord = isPluginMcpRuntimeName(serverName)
          ? (await getCrabCodeMcpConfigs()).pluginInventory.find(
              record => record.runtimeName === serverName,
            )
          : undefined
        if (isDirectTuiSdkMcpInventoryRecord(inventoryRecord)) {
          return {
            claimPlugin: false,
            result: {
              ok: false,
              error: DIRECT_TUI_SDK_MCP_UNSUPPORTED_ERROR,
            },
          }
        }
        const candidate = activeConfig ?? inventoryRecord?.config ?? null
        if (!candidate) {
          return {
            claimPlugin: false,
            result: {
              ok: false,
              error: `Direct TUI cannot activate an MCP server before its process transport configuration is available: ${serverName}`,
            },
          }
        }
        const admissionError = directMcpControlAdmissionError(
          serverName,
          candidate,
        )
        if (admissionError) {
          return {
            claimPlugin: false,
            result: { ok: false, error: admissionError },
          }
        }

        if (!enabled) await cancelActiveMcpOAuthFlow(serverName)
        await setMcpServerEnabled(serverName, enabled)
        if (enabled) directControlDisabledMcpNames.delete(serverName)
        else directControlDisabledMcpNames.add(serverName)
        return enabled
          ? { claimPlugin: true }
          : { claimPlugin: false, result: { ok: true } }
      }
      if (target.owner === 'plugin') {
        const inventoryRecord = (
          await getCrabCodeMcpConfigs()
        ).pluginInventory.find(record => record.runtimeName === serverName)
        if (isDirectTuiSdkMcpInventoryRecord(inventoryRecord)) {
          return {
            claimPlugin: false,
            result: {
              ok: false,
              error: DIRECT_TUI_SDK_MCP_UNSUPPORTED_ERROR,
            },
          }
        }
      }
      let config =
        enabled &&
        target.owner === 'plugin' &&
        !directControlDisabledMcpNames.has(serverName)
          ? await getActiveMcpConfigByName(serverName)
          : target.config
      if (!config) {
        return {
          claimPlugin: false,
          result: { ok: false, error: `Server not found: ${serverName}` },
        }
      }
      const admissionError = directMcpControlAdmissionError(
        serverName,
        config,
      )
      if (admissionError) {
        return {
          claimPlugin: false,
          result: { ok: false, error: admissionError },
        }
      }

      if (!enabled) await cancelActiveMcpOAuthFlow(serverName)
      elicitationRegistered.delete(serverName)
      await setMcpServerEnabled(serverName, enabled)
      if (!enabled) {
        directControlDisabledMcpNames.add(serverName)
        await evictExistingServerCache(serverName, config)
        const disabledClient: MCPServerConnection = {
          name: serverName,
          type: 'disabled',
          config,
        }
        const prefix = getMcpPrefix(serverName)
        syncHeadlessMcpRuntime(serverName, disabledClient)
        setAppState(prev => ({
          ...prev,
          mcp: {
            ...prev.mcp,
            clients: upsertConnection(prev.mcp.clients, disabledClient),
            tools: reject(prev.mcp.tools, tool =>
              tool.name?.startsWith(prefix),
            ),
            commands: reject(prev.mcp.commands, command =>
              commandOwnedByMcpServer(command, serverName),
            ),
            resources: omit(prev.mcp.resources, serverName),
          },
        }))
        return {
          claimPlugin: false,
          result: { ok: true, client: disabledClient },
        }
      }

      directControlDisabledMcpNames.delete(serverName)
      if (target.owner === 'plugin') {
        const freshConfig = await getActiveMcpConfigByName(serverName)
        if (!freshConfig) {
          return {
            claimPlugin: false,
            result: { ok: false, error: `Server not found: ${serverName}` },
          }
        }
        config = freshConfig
        const refreshedAdmissionError = directMcpControlAdmissionError(
          serverName,
          config,
        )
        if (refreshedAdmissionError) {
          return {
            claimPlugin: false,
            result: { ok: false, error: refreshedAdmissionError },
          }
        }
      }

      if (
        target.owner === 'plugin' &&
        getServerCacheKey(serverName, target.config) !==
          getServerCacheKey(serverName, config)
      ) {
        await evictExistingServerCache(serverName, target.config)
      }
      const result = await reconnectMcpServerImpl(serverName, config)
      commitDirectMcpReconnect(serverName, result, {
        owner: target.owner,
        config,
      })
      if (result.client.type === 'connected') {
        registerElicitationHandlers([result.client])
        reregisterChannelHandlerAfterReconnect(result.client)
        return {
          claimPlugin: false,
          result: { ok: true, client: result.client },
        }
      }
      return {
        claimPlugin: false,
        result: {
          ok: false,
          error:
            result.client.type === 'failed'
              ? (result.client.error ?? 'Connection failed')
              : `Server status: ${result.client.type}`,
        },
      }
    })

    if (!preparation.claimPlugin) return preparation.result

    const claimError = await claimDirectPluginMcpOwner(serverName)
    return runDirectMcpMutation(async () => {
      const claimedTarget = getDirectOwnedMcpTarget(serverName)
      if (claimError) {
        const latestRecord = (
          await getCrabCodeMcpConfigs()
        ).pluginInventory.find(record => record.runtimeName === serverName)
        if (!claimedTarget && latestRecord?.reasonCode === 'requires-login') {
          return { ok: true }
        }
        return { ok: false, error: claimError }
      }
      if (claimedTarget?.owner !== 'plugin') {
        return {
          ok: false,
          error: `MCP server was not admitted by the direct TUI plugin lifecycle: ${serverName}`,
        }
      }
      const claimedClient = pluginProcessMcpState.clients.find(
        client => client.name === serverName,
      )
      if (claimedClient?.type === 'connected') {
        registerElicitationHandlers([claimedClient])
        reregisterChannelHandlerAfterReconnect(claimedClient)
      }
      return claimedClient?.type === 'failed'
        ? {
            ok: false,
            error: claimedClient.error ?? 'Connection failed',
          }
        : { ok: true, client: claimedClient }
    })
  }

  // Build McpServerStatus[] for control responses. Shared by mcp_status and
  // reload_plugins handlers. Reads every live owner and deduplicates AppState's
  // projection of those same connections by stable server name.
  async function buildMcpServerStatuses(): Promise<McpServerStatus[]> {
    const currentAppState = getAppState()
    const currentMcpClients = currentAppState.mcp.clients
    const allMcpTools = uniqBy(
      [
        ...currentAppState.mcp.tools,
        ...dynamicMcpState.tools,
        ...pluginProcessMcpState.tools,
      ],
      'name',
    )
    let connections: MCPServerConnection[]
    if (separateProcessMcpOwners) {
      connections = uniqBy(
        [
          ...currentMcpClients,
          ...sdkClients,
          ...dynamicMcpState.clients,
          ...pluginProcessMcpState.clients,
        ] as MCPServerConnection[],
        'name',
      )
    } else {
      const existingNames = new Set([
        ...currentMcpClients.map(c => c.name),
        ...sdkClients.map(c => c.name),
      ])
      connections = [
        ...currentMcpClients,
        ...sdkClients,
        ...dynamicMcpState.clients.filter(c => !existingNames.has(c.name)),
      ]
    }
    const liveStatuses = connections.map(connection => {
      let config
      if (
        connection.config.type === 'sse' ||
        connection.config.type === 'http'
      ) {
        config = {
          type: connection.config.type,
          url: connection.config.url,
          headers: connection.config.headers,
          oauth: connection.config.oauth,
        }
      } else if (connection.config.type === 'acosmi-proxy') {
        config = {
          type: 'acosmi-proxy' as const,
          url: connection.config.url,
          id: connection.config.id,
        }
      } else if (
        connection.config.type === 'stdio' ||
        connection.config.type === undefined
      ) {
        config = {
          type: 'stdio' as const,
          command: connection.config.command,
          args: connection.config.args,
        }
      }
      const serverTools =
        connection.type === 'connected'
          ? filterToolsByServer(allMcpTools, connection.name).map(tool => ({
              name: tool.mcpInfo?.toolName ?? tool.name,
              annotations: {
                readOnly: tool.isReadOnly({}) || undefined,
                destructive: tool.isDestructive?.({}) || undefined,
                openWorld: tool.isOpenWorld?.({}) || undefined,
              },
            }))
          : undefined
      // Capabilities passthrough with allowlist pre-filter. The IDE reads
      // experimental['crabcode/channel'] to decide whether to show the
      // Enable-channel prompt — only echo it if channel_enable would
      // actually pass the allowlist. Not a security boundary (the
      // handler re-runs the full gate); just avoids dead buttons.
      let capabilities: { experimental?: Record<string, unknown> } | undefined
      if (
        (feature('KAIROS') || feature('KAIROS_CHANNELS')) &&
        connection.type === 'connected' &&
        connection.capabilities.experimental
      ) {
        const exp = { ...connection.capabilities.experimental }
        if (
          exp['crabcode/channel'] &&
          (!isChannelsEnabled() ||
            !isChannelAllowlisted(connection.config.pluginSource))
        ) {
          delete exp['crabcode/channel']
        }
        if (Object.keys(exp).length > 0) {
          capabilities = { experimental: exp }
        }
      }
      return {
        name: connection.name,
        status: connection.type,
        serverInfo:
          connection.type === 'connected' ? connection.serverInfo : undefined,
        error: connection.type === 'failed' ? connection.error : undefined,
        config,
        scope: connection.config.scope,
        lifecycleStatus: connection.config.pluginMcp
          ? sdkMcpLifecycleStatusFromReason(
              connection.config.pluginMcp.reasonCode,
            )
          : 'ready',
        ...(connection.config.pluginMcp?.reason
          ? { lifecycleReason: connection.config.pluginMcp.reason }
          : {}),
        tools: serverTools,
        capabilities,
      }
    })
    const { pluginInventory } = await getAllMcpConfigs()
    const liveNames = new Set(connections.map(connection => connection.name))
    const managementInventory = separateProcessMcpOwners
      ? pluginInventory.filter(
          record => !isDirectTuiSdkMcpInventoryRecord(record),
        )
      : pluginInventory
    return [
      ...liveStatuses,
      ...buildPluginMcpManagementStatuses(managementInventory, liveNames),
    ]
  }

  // NOTE: Nested function required - needs closure access to applyMcpServerChanges and updateSdkMcp
  //
  // Returns whether the installer actually installed/uninstalled anything, so
  // the caller can decide whether a second full plugin discovery pass is
  // justified. A thrown installer reports `true`: it cannot tell us what it did,
  // so the decision falls through to the discovery fingerprint.
  async function installPluginsAndApplyMcpInBackground(): Promise<boolean> {
    try {
      // Join point for user settings (fired at runHeadless entry) and managed
      // settings (fired in main.tsx preAction). downloadUserSettings() caches
      // its promise so this awaits the same in-flight request.
      await Promise.all([
        feature('DOWNLOAD_USER_SETTINGS') &&
        isEnvTruthy(process.env.CRABCODE_REMOTE)
          ? withDiagnosticsTiming('headless_user_settings_download', () =>
              downloadUserSettings(),
            )
          : Promise.resolve(),
        withDiagnosticsTiming('headless_managed_settings_wait', () =>
          waitForRemoteManagedSettingsToLoad(),
        ),
      ])

      const pluginsInstalled = await installPluginsForHeadless()

      if (routePolicy.directQueryEventDelivery) {
        await reconcileDirectMcpSettings()
      } else if (pluginsInstalled) {
        await applyPluginMcpDiff()
      }
      return pluginsInstalled
    } catch (error) {
      logError(error)
      return true
    }
  }

  // Background plugin installation for all headless users
  // Installs marketplaces from extraKnownMarketplaces and missing enabled plugins
  // CRABCODE_SYNC_PLUGIN_INSTALL=true: resolved in run() before the first
  // query so plugins are guaranteed available on the first ask().
  let pluginInstallPromise: Promise<boolean> | null = null
  // --bare / SIMPLE: skip plugin install. Scripted calls don't add plugins
  // mid-session; the next interactive run reconciles.
  if (!isBareMode()) {
    if (isEnvTruthy(process.env.CRABCODE_SYNC_PLUGIN_INSTALL)) {
      pluginInstallPromise = installPluginsAndApplyMcpInBackground()
    } else {
      void installPluginsAndApplyMcpInBackground()
        .then(installerChangedPlugins =>
          // setup() already ran the startup discovery pass for this route
          // (skipPluginPrefetch is false without CRABCODE_SYNC_PLUGIN_INSTALL),
          // so a second full pass is only warranted when the installer changed
          // something — or, as a second line of defense, when a settings /
          // marketplace file was rewritten inside the startup window.
          refreshPluginState({
            skipWhenDiscoveryInputsUnchanged: !installerChangedPlugins,
          }),
        )
        .catch(error => logError(error))
    }
  }

  // Idle timeout management
  const idleTimeout = createIdleTimeoutManager(() => !running)

  // Mutable commands and agents for hot reloading
  let currentCommands = commands
  let currentAgents = agents
  const commandCatalogPublisher = routePolicy.directQueryEventDelivery
    ? new DirectTuiCommandCatalogPublisher(
        catalog =>
          structuredIO.requestDirectTuiCommandCatalogChanged(catalog),
        error => {
          if (!inputClosed) {
            logForDebugging(
              `Direct TUI command catalog refresh was not acknowledged: ${errorMessage(error)}`,
              { level: 'warn' },
            )
          }
        },
      )
    : null
  const currentExecutableCommands = (
    mcpCommands: readonly Command[] = getAppState().mcp.commands,
  ): Command[] => {
    return executableCommandInventoryForRoute(
      routePolicy.slashCommandsEnabled,
      routePolicy.directQueryEventDelivery,
      currentCommands,
      mcpCommands,
    )
  }
  // Only the direct route publishes a private Rust catalog. Standard SDK
  // responses retain their established currentCommands projection.
  const currentCatalogCommands = (): Command[] =>
    routePolicy.directQueryEventDelivery
      ? currentExecutableCommands()
      : currentCommands
  const projectCurrentCommandCatalog = (
    commandsToProject: readonly Command[],
  ) =>
    routePolicy.directQueryEventDelivery
      ? projectDirectTuiCommandCatalogEntries(
          commandsToProject,
          formatHeadlessCommandDescription,
        )
      : projectCommandCatalogEntries(
          commandsToProject,
          formatHeadlessCommandDescription,
        )
  const publishCurrentCommandCatalog = (): void => {
    commandCatalogPublisher?.update(
      projectCurrentCommandCatalog(currentCatalogCommands()),
    )
  }
  const commandCatalogLifecycle = new DirectTuiCommandCatalogLifecycle(
    currentCommands,
    refreshedCommands => {
      currentCommands = [...refreshedCommands]
      publishCurrentCommandCatalog()
    },
  )
  let observedMcpCommands = getAppState().mcp.commands
  const unsubscribeAppStateCommandCatalog =
    routePolicy.directQueryEventDelivery &&
    routePolicy.slashCommandsEnabled
      ? options.subscribeAppState?.(() => {
          const nextMcpCommands = getAppState().mcp.commands
          if (Object.is(nextMcpCommands, observedMcpCommands)) return
          observedMcpCommands = nextMcpCommands
          publishCurrentCommandCatalog()
        })
      : undefined
  const refreshSettingsCommandCatalog = (): Promise<readonly Command[]> => {
    // The earlier headless settings subscriber has already reset the settings
    // cache and applied the new AppState snapshot. Rebuild from that same
    // authority so load-time eligibility cannot remain executable.
    clearHeadlessCommandMemoizationCaches()
    return commandCatalogLifecycle.refresh(() =>
      routePolicy.commandLoader(cwd()),
    )
  }
  const queueSettingsCommandCatalogRefresh = (): void => {
    void refreshSettingsCommandCatalog().catch(error => logError(error))
  }
  const commandRefreshEnabled =
    routePolicy.directQueryEventDelivery && routePolicy.slashCommandsEnabled
  const unsubscribeSettingsCommandCatalog = commandRefreshEnabled
    ? settingsChangeDetector.subscribe(queueSettingsCommandCatalogRefresh)
    : undefined

  // Clear all plugin-related caches, reload commands/agents/hooks.
  // Called after CRABCODE_SYNC_PLUGIN_INSTALL completes (before first query)
  // and after non-sync background install finishes.
  // refreshActivePlugins calls clearAllCaches() which is required because
  // loadAllPlugins() may have run during main.tsx startup BEFORE managed
  // settings were fetched. Without clearing, getCommands() would rebuild
  // from a stale plugin list.
  //
  // `skipWhenDiscoveryInputsUnchanged` is only safe for callers that can prove a
  // first discovery pass already ran. The sync-install path cannot: setup()
  // skips prefetchActiveCommands AND loadPluginHooks under
  // CRABCODE_SYNC_PLUGIN_INSTALL, so its refresh IS the first pass and must
  // always do the full sweep.
  async function refreshPluginState({
    skipWhenDiscoveryInputsUnchanged = false,
  }: { skipWhenDiscoveryInputsUnchanged?: boolean } = {}): Promise<void> {
    // refreshActivePlugins handles the full cache sweep (clearAllCaches),
    // reloads all plugin component loaders, writes AppState.plugins +
    // AppState.agentDefinitions, registers hooks, and bumps mcp.pluginReconnectKey.
    const refreshed = skipWhenDiscoveryInputsUnchanged
      ? await refreshActivePluginsIfDiscoveryChanged(setAppState)
      : await refreshActivePlugins(setAppState)
    // Skipped: nothing was swept and nothing was reloaded, so re-publishing the
    // command catalog would send a byte-identical catalog a second time.
    if (!refreshed) return
    const { agentDefinitions: freshAgentDefs } = refreshed

    // Headless-specific: currentCommands/currentAgents are local mutable refs
    // captured by the query loop (REPL uses AppState instead). getCommands is
    // fresh because refreshActivePlugins cleared its cache.
    await commandCatalogLifecycle.refresh(() =>
      routePolicy.commandLoader(cwd()),
    )

    // Preserve SDK-provided agents (--agents CLI flag or SDK initialize
    // control_request) — both inject via parseAgentsFromJson with
    // source='flagSettings'. loadMarkdownFilesForSubdir never assigns this
    // source, so it cleanly discriminates "injected, not disk-loadable".
    //
    // The previous filter used a negative set-diff (!freshAgentTypes.has(a))
    // which also matched plugin agents that were in the poisoned initial
    // currentAgents but correctly excluded from freshAgentDefs after managed
    // settings applied — leaking policy-blocked agents into the init message.
    // See gh-23085: isBridgeEnabled() at Commander-definition time poisoned
    // the settings cache before setEligibility(true) ran.
    const sdkAgents = currentAgents.filter(a => a.source === 'flagSettings')
    currentAgents = [...freshAgentDefs.allAgents, ...sdkAgents]
  }

  // Re-diff MCP configs after plugin state changes. Filters to
  // process-transport-supported types and carries SDK-mode servers through
  // so applyMcpServerChanges' diff doesn't close their transports.
  // Nested: needs closure access to sdkMcpConfigs, applyMcpServerChanges,
  // updateSdkMcp.
  let pluginMcpDiffPromise: Promise<void> = Promise.resolve()
  function applyPluginMcpDiff(): Promise<void> {
    const doWork = async (): Promise<void> => {
      if (inputClosed) return
      const { servers: newConfigs } = await getActiveMcpConfigs()
      if (inputClosed) return
      const orderedConfigs = separateProcessMcpOwners
        ? orderMcpServersByPrecedence(newConfigs)
        : newConfigs
      const supportedConfigs: Record<
        string,
        McpServerConfigForProcessTransport
      > = {}
      for (const [name, config] of Object.entries(orderedConfigs)) {
        const type = config.type
        if (
          type === undefined ||
          type === 'stdio' ||
          type === 'sse' ||
          type === 'http' ||
          type === 'sdk'
        ) {
          supportedConfigs[name] = config
        }
      }
      // Standard retains the historical shared SDK carry-forward.
      if (!separateProcessMcpOwners) {
        for (const [name, config] of Object.entries(sdkMcpConfigs)) {
          if (config.type === 'sdk' && !(name in supportedConfigs)) {
            supportedConfigs[name] = config
          }
        }
      }
      const { response, sdkServersChanged } =
        await applyMcpServerChanges(
          'plugin',
          supportedConfigs,
          separateProcessMcpOwners,
        )
      if (sdkServersChanged) {
        void updateSdkMcp()
      }
      for (const [name, reason] of Object.entries(response.errors)) {
        logForDebugging(
          `Ignoring MCP server "${name}" during plugin refresh: ${reason}`,
          { level: 'warn' },
        )
      }
      logForDebugging(
        `Headless MCP refresh: added=${response.added.length}, removed=${response.removed.length}`,
      )
    }
    const serializedWork = () =>
      separateProcessMcpOwners ? serializeMcpMutation(doWork) : doWork()
    pluginMcpDiffPromise = pluginMcpDiffPromise.then(
      serializedWork,
      serializedWork,
    )
    return pluginMcpDiffPromise
  }

  async function reconcileDirectMcpSettings(): Promise<void> {
    if (!separateProcessMcpOwners || inputClosed) return
    await reconcileDirectSessionMcpPolicy()
    if (inputClosed) return
    await serializeMcpMutation(async () => {
      if (inputClosed) return
      // Read both the committed public desired set and the current disabled
      // authority only after this settings task owns the mutation lane. A
      // queued toggle or mcp_set request may have changed either while the
      // fixed-owner policy pass above was awaiting transport cleanup.
      const settingsActivePublicDesired = Object.fromEntries(
        Object.entries(publicProcessMcpDesired).filter(
          ([name]) => !isMcpServerDisabled(name),
        ),
      )
      await applyMcpServerChanges(
        'public',
        settingsActivePublicDesired,
        true,
        false,
      )
    })
    if (inputClosed) return
    if (isBareMode()) return
    await applyPluginMcpDiff()
  }

  options.installSettingsMcpReconcile?.(() => {
    if (!inputClosed) {
      void reconcileDirectMcpSettings().catch(error => logError(error))
    }
  })
  if (separateProcessMcpOwners && options.lateFixedMcpConfig) {
    void options.lateFixedMcpConfig
      .then(candidate =>
        candidate ? admitLateFixedMcpConfig(candidate) : undefined,
      )
      .catch(error => logError(error))
  }

  // Subscribe to skill changes for hot reloading
  const refreshSkillCommandCatalog = (): void => {
    void commandCatalogLifecycle
      .refresh(() => routePolicy.commandLoader(cwd()))
      .catch(error => logError(error))
  }
  const unsubscribeSkillChanges = skillChangeDetector.subscribe(
    refreshSkillCommandCatalog,
  )
  // Both detectors are edge-only. One current-state rebuild after both
  // subscriptions closes the bootstrap window without changing their shared
  // process-global semantics; later edges use the listeners above.
  if (commandRefreshEnabled) {
    queueSettingsCommandCatalogRefresh()
  }

  // Proactive mode: schedule a tick to keep the model looping autonomously.
  // setTimeout(0) yields to the event loop so pending stdin messages
  // (interrupts, user messages) are processed before the tick fires.
  const scheduleProactiveTick =
    feature('PROACTIVE') || feature('KAIROS')
      ? () => {
          setTimeout(() => {
            if (
              !proactiveModule?.isProactiveActive() ||
              proactiveModule.isProactivePaused() ||
              inputClosed
            ) {
              return
            }
            const tickContent = `<${TICK_TAG}>${new Date().toLocaleTimeString()}</${TICK_TAG}>`
            enqueue({
              mode: 'prompt' as const,
              value: tickContent,
              uuid: randomUUID(),
              priority: 'later',
              isMeta: true,
            })
            void run()
          }, 0)
        }
      : undefined

  // Abort the current operation when a 'now' priority message arrives.
  subscribeToCommandQueue(() => {
    if (abortController && getCommandsByMaxPriority('now').length > 0) {
      abortController.abort('interrupt')
    }
  })

  let taskListWatcher: TaskListWatcherCore | undefined
  let directTeamInboxPollInFlight = false
  let directTeamInboxPollerStopped = false

  const queueDirectTeamModelContext = (
    messages: ReadonlyArray<{
      from: string
      text: string
      timestamp: string
      color?: string
      summary?: string
    }>,
  ): void => {
    if (messages.length === 0) return
    setAppState(previous => {
      const additions = excludeQueuedDirectTeamInboxOccurrences(
        messages,
        previous.inbox.messages,
      ).map(message => ({
        id: randomUUID(),
        from: message.from,
        text: message.text,
        timestamp: message.timestamp,
        status: 'pending' as const,
        color: message.color,
        summary: message.summary,
      }))
      if (additions.length === 0) return previous
      return {
        ...previous,
        inbox: {
          messages: [...previous.inbox.messages, ...additions],
        },
      }
    })
  }

  const deliverPendingDirectTeamModelContext = (): boolean => {
    if (running) return false
    const current = getAppState()
    const pending = current.inbox.messages.filter(
      message => message.status === 'pending',
    )
    const processedIds = new Set(
      current.inbox.messages
        .filter(message => message.status === 'processed')
        .map(message => message.id),
    )
    if (pending.length === 0) {
      if (processedIds.size > 0) {
        setAppState(previous => ({
          ...previous,
          inbox: {
            messages: previous.inbox.messages.filter(
              message => !processedIds.has(message.id),
            ),
          },
        }))
      }
      return false
    }

    enqueue({
      mode: 'prompt',
      value: formatTeammateMessages(pending),
      uuid: randomUUID(),
    })
    const submittedIds = new Set(pending.map(message => message.id))
    setAppState(previous => ({
      ...previous,
      inbox: {
        messages: previous.inbox.messages.filter(
          message =>
            !submittedIds.has(message.id) && !processedIds.has(message.id),
        ),
      },
    }))
    return true
  }

  const pollDirectTeamInboxOnce = async (): Promise<boolean> => {
    if (
      !directTeamInboxRuntime ||
      directTeamInboxPollInFlight ||
      directTeamInboxPollerStopped ||
      !runtimeInitialized
    ) {
      return false
    }
    const target = resolveDirectTeamInboxTarget(getAppState())
    if (!target) return false

    directTeamInboxPollInFlight = true
    try {
      const unread = await readUnreadMessages(
        target.agentName,
        target.teamName,
      )
      if (unread.length === 0) return false

      // Capture the fixed poll-start gate once. Historical useInboxPoller
      // could emit the first tool and first sandbox notification from one
      // batch before the queued dialogs caused a render-state transition.
      const workerNotificationGate = getSessionState() === 'idle'
      const routed = await routeDirectTeamInboxMessages(
        unread,
        directTeamInboxRuntime.handlers(target, workerNotificationGate),
      )
      const consumed = [...routed.consumed]
      let submitted = false

      if (routed.modelContext.length > 0) {
        if (running) {
          // Fixed history queues only already-routed structured context while
          // busy. Ordinary messages remain unread for the established
          // mid-turn attachment path, which marks them only after attachment
          // construction succeeds.
          const routedStructuredContext = routed.modelContext.filter(message =>
            isStructuredProtocolMessage(message.text),
          )
          queueDirectTeamModelContext(routedStructuredContext)
          consumed.push(...routedStructuredContext)
        } else {
          enqueue({
            mode: 'prompt',
            value: formatTeammateMessages(routed.modelContext),
            uuid: randomUUID(),
          })
          consumed.push(...routed.modelContext)
          submitted = true
        }
      }

      if (consumed.length > 0) {
        await markMessagesAsReadByPredicate(
          target.agentName,
          createDirectTeamInboxReadPredicate(consumed),
          target.teamName,
        )
      }

      for (const deferred of routed.deferred) {
        logForDebugging(
          `[DirectTeamInbox] retained unread ${deferred.type} from ${deferred.message.from}: ${deferred.reason}`,
          { level: 'warn' },
        )
      }

      if (submitted) void run()
      return submitted
    } finally {
      directTeamInboxPollInFlight = false
    }
  }

  const run = async () => {
    if (running) {
      return
    }

    running = true
    runPhase = undefined
    notifySessionStateChanged('running')
    idleTimeout.stop()

    headlessProfilerCheckpoint('run_entry')
    // MCP SDK update runs after profiler checkpoint.

    await updateSdkMcp()
    headlessProfilerCheckpoint('after_updateSdkMcp')

    // Resolve deferred plugin installation (CRABCODE_SYNC_PLUGIN_INSTALL).
    // The promise was started eagerly so installation overlaps with other init.
    // Awaiting here guarantees plugins are available before the first ask().
    // If CRABCODE_SYNC_PLUGIN_INSTALL_TIMEOUT_MS is set, races against that
    // deadline and proceeds without plugins on timeout (logging an error).
    if (pluginInstallPromise) {
      const installation = pluginInstallPromise
      let completedBeforeDeadline = true
      const timeoutMs = parseInt(
        process.env.CRABCODE_SYNC_PLUGIN_INSTALL_TIMEOUT_MS || '',
        10,
      )
      if (timeoutMs > 0) {
        const timeout = sleep(timeoutMs).then(() => 'timeout' as const)
        const result = await Promise.race([installation, timeout])
        if (result === 'timeout') {
          completedBeforeDeadline = false
          logError(
            new Error(
              `CRABCODE_SYNC_PLUGIN_INSTALL: plugin installation timed out after ${timeoutMs}ms`,
            ),
          )
          logEvent('tengu_sync_plugin_install_timeout', {
            timeout_ms: timeoutMs,
          })
          // Timeout relaxes first-turn availability; it must not make the
          // eventual installation invisible for the rest of this process.
          // Reconcile once the original install settles, unless the input
          // lifecycle has already closed.
          void installation
            .then(() => (inputClosed ? undefined : refreshPluginState()))
            .catch(error => logError(error))
        }
      } else {
        await installation
      }
      pluginInstallPromise = null

      // Refresh commands, agents, and hooks only after installation. On a
      // timeout the continuation above owns this refresh, avoiding a cache
      // sweep racing the still-running installer.
      if (completedBeforeDeadline) {
        await refreshPluginState()
      }

      // Set up hot-reload for plugin hooks now that the initial install is done.
      // In sync-install mode, setup.ts skips this to avoid racing with the install.
      const { setupPluginHookHotReload } = await import(
        '../../utils/plugins/loadPluginHooks.js'
      )
      setupPluginHookHotReload()
    }

    // Only main-thread commands (agentId===undefined) — subagent
    // notifications are drained by the subagent's mid-turn gate in query.ts.
    // Defined outside the try block so it's accessible in the post-finally
    // queue re-checks at the bottom of run().
    const isMainThread = (cmd: QueuedCommand) => cmd.agentId === undefined

    // Shared SDK status emitter. Used both by ask()'s setSDKStatus option
    // (compaction) and the F3-2 task-notification turn bracket below — single
    // emit point so the two producers cannot drift in wire shape.
    const emitSdkStatus = (status: SDKStatus): void => {
      output.enqueue({
        type: 'system',
        subtype: 'status',
        status,
        session_id: getSessionId(),
        uuid: randomUUID(),
      })
    }

    try {
      let command: QueuedCommand | undefined
      let waitingForAgents = false

      // Extract command processing into a named function for the do-while pattern.
      // Drains the queue, batching consecutive prompt-mode commands into one
      // ask() call so messages that queued up during a long turn coalesce
      // into a single follow-up turn instead of N separate turns.
      const drainCommandQueue = async () => {
        while ((command = dequeue(isMainThread))) {
          if (
            command.mode !== 'prompt' &&
            command.mode !== 'bash' &&
            command.mode !== 'orphaned-permission' &&
            command.mode !== 'task-notification'
          ) {
            throw new Error(
              'only prompt and bash commands are supported in streaming mode',
            )
          }

          // W-GOAL-HANG fix (2026-06-11): drop task-notifications whose task
          // was already explicitly retrieved via TaskOutput (claimed). They
          // are redundant — injecting them would start an extra,
          // user-invisible turn. Only this one command is skipped; the
          // while-loop keeps draining the rest normally.
          if (
            command.mode === 'task-notification' &&
            isTaskNotificationClaimed(
              command,
              taskId => getAppState().tasks?.[taskId],
            )
          ) {
            logForDebugging(
              '[queryExecution] dropping claimed task-notification (already retrieved via TaskOutput)',
            )
            continue
          }

          // Non-prompt commands (task-notification, orphaned-permission) carry
          // side effects or orphanedPermission state, so they process singly.
          // Prompt commands greedily collect followers with matching workload.
          const batch: QueuedCommand[] = [command]
          if (command.mode === 'prompt') {
            while (canBatchWith(command, peek(isMainThread))) {
              batch.push(dequeue(isMainThread)!)
            }
            if (batch.length > 1) {
              command = {
                ...command,
                value: joinPromptValues(batch.map(c => c.value)),
                uuid: batch.findLast(c => c.uuid)?.uuid ?? command.uuid,
              }
            }
          }
          const batchUuids = batch.map(c => c.uuid).filter(u => u !== undefined)

          // QueryEngine will emit a replay for command.uuid (the last uuid in
          // the batch) via its messagesToAck path. Emit replays here for the
          // rest so consumers that track per-uuid delivery (clank's
          // asyncMessages footer, CCR) see an ack for every message they sent,
          // not just the one that survived the merge.
          if (options.replayUserMessages && batch.length > 1) {
            for (const c of batch) {
              if (c.uuid && c.uuid !== command.uuid) {
                output.enqueue({
                  type: 'user',
                  message: { role: 'user', content: c.value },
                  session_id: getSessionId(),
                  parent_tool_use_id: null,
                  uuid: c.uuid,
                  isReplay: true,
                } satisfies SDKUserMessageReplay)
              }
            }
          }

          // Combine all MCP clients. appState.mcp is populated incrementally
          // per-server by main.tsx (mirrors useManageMCPConnections). Reading
          // fresh per-command means late-connecting servers are visible on the
          // next turn. registerElicitationHandlers is idempotent (tracking set).
          const appState = getAppState()
          const allMcpClients = separateProcessMcpOwners
            ? uniqBy(
                [
                  ...appState.mcp.clients,
                  ...sdkClients,
                  ...dynamicMcpState.clients,
                  ...pluginProcessMcpState.clients,
                ],
                'name',
              )
            : [
                ...appState.mcp.clients,
                ...sdkClients,
                ...dynamicMcpState.clients,
              ]
          registerElicitationHandlers(allMcpClients)
          // Channel handlers for servers allowlisted via --channels at
          // construction time (or enableChannel() mid-session). Runs every
          // turn like registerElicitationHandlers — idempotent per-client
          // (setNotificationHandler replaces, not stacks) and no-ops for
          // non-allowlisted servers (one feature-flag check).
          for (const client of allMcpClients) {
            reregisterChannelHandlerAfterReconnect(client)
          }

          const allTools = buildAllTools(appState)

          for (const uuid of batchUuids) {
            notifyCommandLifecycle(uuid, 'started')
          }

          // Task notifications arrive when background agents complete.
          // Emit an SDK system event for SDK consumers, then fall through
          // to ask() so the model sees the agent result and can act on it.
          // This matches TUI behavior where useQueueProcessor always feeds
          // notifications to the model regardless of coordinator mode.
          if (command.mode === 'task-notification') {
            const notificationText =
              typeof command.value === 'string' ? command.value : ''
            // Parse the XML-formatted notification
            const taskIdMatch = notificationText.match(
              /<task-id>([^<]+)<\/task-id>/,
            )
            const toolUseIdMatch = notificationText.match(
              /<tool-use-id>([^<]+)<\/tool-use-id>/,
            )
            const outputFileMatch = notificationText.match(
              /<output-file>([^<]+)<\/output-file>/,
            )
            const statusMatch = notificationText.match(
              /<status>([^<]+)<\/status>/,
            )
            const summaryMatch = notificationText.match(
              /<summary>([^<]+)<\/summary>/,
            )

            const isValidStatus = (
              s: string | undefined,
            ): s is 'completed' | 'failed' | 'stopped' | 'killed' =>
              s === 'completed' ||
              s === 'failed' ||
              s === 'stopped' ||
              s === 'killed'
            const rawStatus = statusMatch?.[1]
            const status = isValidStatus(rawStatus)
              ? rawStatus === 'killed'
                ? 'stopped'
                : rawStatus
              : 'completed'

            const usageMatch = notificationText.match(
              /<usage>([\s\S]*?)<\/usage>/,
            )
            const usageContent = usageMatch?.[1] ?? ''
            const totalTokensMatch = usageContent.match(
              /<total_tokens>(\d+)<\/total_tokens>/,
            )
            const toolUsesMatch = usageContent.match(
              /<tool_uses>(\d+)<\/tool_uses>/,
            )
            const durationMsMatch = usageContent.match(
              /<duration_ms>(\d+)<\/duration_ms>/,
            )

            // Only emit a task_notification SDK event when a <status> tag is
            // present — that means this is a terminal notification (completed/
            // failed/stopped). Stream events from enqueueStreamEvent carry no
            // <status> (they're progress pings); emitting them here would
            // default to 'completed' and falsely close the task for SDK
            // consumers. Terminal bookends are now emitted directly via
            // emitTaskTerminatedSdk, so skipping statusless events is safe.
            if (statusMatch) {
              output.enqueue({
                type: 'system',
                subtype: 'task_notification',
                task_id: taskIdMatch?.[1] ?? '',
                tool_use_id: toolUseIdMatch?.[1],
                status,
                output_file: outputFileMatch?.[1] ?? '',
                summary: summaryMatch?.[1] ?? '',
                usage:
                  totalTokensMatch && toolUsesMatch
                    ? {
                        total_tokens: parseInt(totalTokensMatch[1]!, 10),
                        tool_uses: parseInt(toolUsesMatch[1]!, 10),
                        duration_ms: durationMsMatch
                          ? parseInt(durationMsMatch[1]!, 10)
                          : 0,
                      }
                    : undefined,
                session_id: getSessionId(),
                uuid: randomUUID(),
              })
            }
            // No continue -- fall through to ask() so the model processes the result
          }

          const input = command.value

          // Abort any in-flight suggestion generation and track acceptance
          suggestionState.abortController?.abort()
          suggestionState.abortController = null
          suggestionState.pendingSuggestion = null
          suggestionState.pendingLastEmittedEntry = null
          if (suggestionState.lastEmitted) {
            if (command.mode === 'prompt') {
              // SDK user messages enqueue ContentBlockParam[], not a plain string
              const inputText =
                typeof input === 'string'
                  ? input
                  : (
                      input.find(b => b.type === 'text') as
                        | { type: 'text'; text: string }
                        | undefined
                    )?.text
              if (typeof inputText === 'string') {
                logSuggestionOutcome(
                  suggestionState.lastEmitted.text,
                  inputText,
                  suggestionState.lastEmitted.emittedAt,
                  suggestionState.lastEmitted.promptId,
                  suggestionState.lastEmitted.generationRequestId,
                )
              }
              suggestionState.lastEmitted = null
            }
          }

          abortController = createAbortController()
          const turnStartTime = feature('FILE_PERSISTENCE')
            ? Date.now()
            : undefined

          headlessProfilerCheckpoint('before_ask')
          startQueryProfile()
          // Per-iteration ALS context so bg agents spawned inside ask()
          // inherit workload across their detached awaits. In-process cron
          // stamps cmd.workload; the SDK --workload flag is options.workload.
          // const-capture: TS loses `while ((command = dequeue()))` narrowing
          // inside the closure.
          const cmd = command
          // F3-2 (W-GOAL-HANG): surface auto-continued turns. A drained
          // task-notification re-enters ask() with zero user input — without
          // this status the SDK/remote consumer sees an indistinguishable
          // multi-minute silent turn. Emitted before ask(), reset to null in
          // the .finally below (also on throw). A mid-turn compaction may
          // overwrite it with 'compacting'/null via the same channel — the
          // statuses are coarse last-write-wins signals, that is acceptable.
          const isTaskNotificationTurn = cmd.mode === 'task-notification'
          if (routePolicy.directQueryEventDelivery) {
            setAppState(prev =>
              clearCompletedGoalOnNextInput(prev, isTaskNotificationTurn),
            )
          }
          if (isTaskNotificationTurn) {
            emitSdkStatus('processing_background_task')
          }
          await runWithDirectTuiProjectionOwner(
            routePolicy.directQueryEventDelivery,
            () =>
              runWithWorkload(cmd.workload ?? options.workload, async () => {
                const requestedCrabCodeThinkingMode = deriveCrabCodeThinkingMode(
              options.thinkingConfig,
              appState.effortValue,
                )
                // Only an outer route that explicitly owns the process-local
                // capability may mint direct Account Bridge access. Other routes
                // retain their established dispatch and thinking preflight.
                const directAccountBridgeTurn =
                  routePolicy.processOwnedAccountBridge
                    ? await acquireDirectAccountBridgeTurnAccess(
                        activeUserSpecifiedModel,
                      )
                    : undefined
                try {
                  const preparedCrabCodeThinking =
                    routePolicy.processOwnedAccountBridge &&
                    directAccountBridgeTurn?.runtimeAccess !== undefined
                      ? prepareAccountBridgeThinkingModeForRoute({
                          route: directAccountBridgeTurn.runtimeAccess.route,
                          requestedMode: requestedCrabCodeThinkingMode,
                          priorSelection: printAccountBridgeThinkingSelection,
                          locale: getLocale(),
                          onFallback: message =>
                            process.stderr.write(
                              `[Account Bridge] ${message}\n`,
                            ),
                        })
                      : {
                          mode: requestedCrabCodeThinkingMode,
                          selection: undefined,
                        }
                  printAccountBridgeThinkingSelection =
                    preparedCrabCodeThinking.selection
                  for await (const message of ask({
                commands: uniqBy(
                  currentExecutableCommands(appState.mcp.commands),
                  'name',
                ),
                prompt: input,
                promptUuid: cmd.uuid,
                isMeta: cmd.isMeta,
                inputMode: cmd.mode === 'bash' ? 'bash' : 'prompt',
                cwd: cwd(),
                tools: allTools,
                verbose: options.verbose,
                mcpClients: allMcpClients,
                thinkingConfig: options.thinkingConfig,
                crabcodeThinkingMode: preparedCrabCodeThinking.mode,
                ...(directAccountBridgeTurn?.runtimeAccess !== undefined && {
                  accountBridgeRuntimeAccess:
                    directAccountBridgeTurn.runtimeAccess,
                }),
                maxTurns: options.maxTurns,
                maxBudgetUsd: options.maxBudgetUsd,
                taskBudget: options.taskBudget,
                canUseTool,
                userSpecifiedModel:
                  directAccountBridgeTurn?.modelForQuery ??
                  activeUserSpecifiedModel,
                fallbackModel: options.fallbackModel,
                jsonSchema: getInitJsonSchema() ?? options.jsonSchema,
                mutableMessages,
                getReadFileCache: () =>
                  pendingSeeds.size === 0
                    ? readFileState
                    : mergeFileStateCaches(readFileState, pendingSeeds),
                setReadFileCache: cache => {
                  readFileState = cache
                  for (const [path, seed] of pendingSeeds.entries()) {
                    const existing = readFileState.get(path)
                    if (!existing || seed.timestamp > existing.timestamp) {
                      readFileState.set(path, seed)
                    }
                  }
                  pendingSeeds.clear()
                },
                customSystemPrompt: options.systemPrompt,
                appendSystemPrompt: options.appendSystemPrompt,
                mainThreadAgentDefinition: options.mainThreadAgentDefinition,
                getAppState,
                setAppState,
                abortController,
                replayUserMessages: options.replayUserMessages,
                includePartialMessages: options.includePartialMessages,
                handleElicitation: (serverName, params, elicitSignal) =>
                  structuredIO.handleElicitation(
                    serverName,
                    params.message,
                    undefined,
                    elicitSignal,
                    params.mode,
                    params.url,
                    'elicitationId' in params
                      ? params.elicitationId
                      : undefined,
                  ),
                agents: currentAgents,
                orphanedPermission: cmd.orphanedPermission,
                setSDKStatus: emitSdkStatus,
                interactive: routePolicy.interactiveProductSession,
                allowDirectTuiBashContentBlocks:
                  routePolicy.allowDirectTuiBashContentBlocks,
                failClosedUnknownMcp:
                  routePolicy.directQueryEventDelivery,
                querySource: routePolicy.querySource,
                onQueryEvent: directQueryEventSink,
                // Fixed historical direct-TUI behavior:
                // useQueryBridge.ts@2358212c:440-442 installed the existing
                // ToolUseContext callback. Preserve its Notification hook
                // side effect in this process. Native terminal delivery is
                // renderer-owned and no control/public wire is introduced.
                sendOSNotification: routePolicy.directQueryEventDelivery
                  ? opts => {
                      void executeNotificationHooks(opts)
                    }
                  : undefined,
                  })) {
                // Forward messages to bridge incrementally (mid-turn) so
                // acosmi.com sees progress and the connection stays alive
                // while blocked on permission requests.

                // Raw query() events already entered the same FIFO at the
                // generator boundary. Retain only the two established
                // split-process control records; forwarding SDK projections
                // would duplicate or alter renderer-visible events.
                if (
                  routePolicy.directQueryEventDelivery &&
                  !isDirectTuiControlPlaneSdkMessage(message)
                ) {
                  continue
                }

                if (message.type === 'result') {
                  // Flush pending SDK events so they appear before result on the stream.
                  for (const event of drainSdkEvents()) {
                    output.enqueue(event)
                  }

                  // Hold-back: don't emit result while background agents are running
                  const currentState = getAppState()
                  if (
                    getRunningTasks(currentState).some(
                      t =>
                        (t.type === 'local_agent' ||
                          t.type === 'local_workflow') &&
                        isBackgroundTask(t),
                    )
                  ) {
                    heldBackResult = message
                  } else {
                    heldBackResult = null
                    output.enqueue(message)
                  }
                } else {
                  // Flush SDK events (task_started, task_progress) so background
                  // agent progress is streamed in real-time, not batched until result.
                  for (const event of drainSdkEvents()) {
                    output.enqueue(event)
                  }
                  output.enqueue(message)
                }
                  }
                } finally {
                  directAccountBridgeTurn?.release()
                }
              }).finally(() => {
                // F3-2: clear the continuation status even when ask() throws.
                // Harmless double-null when a mid-turn compaction already
                // reset the channel.
                if (isTaskNotificationTurn) {
                  emitSdkStatus(null)
                }
              }), // end runWithWorkload
          )

          for (const uuid of batchUuids) {
            notifyCommandLifecycle(uuid, 'completed')
          }

          // Forward messages to bridge after each turn

          if (feature('FILE_PERSISTENCE') && turnStartTime !== undefined) {
            void executeFilePersistence(
              turnStartTime,
              abortController.signal,
              result => {
                output.enqueue({
                  type: 'system' as const,
                  subtype: 'files_persisted' as const,
                  files: result.files,
                  failed: result.failed,
                  processed_at: new Date().toISOString(),
                  uuid: randomUUID(),
                  session_id: getSessionId(),
                })
              },
            )
          }

          // Generate and emit prompt suggestion for SDK consumers
          if (
            options.promptSuggestions &&
            !isEnvDefinedFalsy(process.env.CRABCODE_ENABLE_PROMPT_SUGGESTION)
          ) {
            // TS narrows suggestionState to never in the while loop body;
            // cast via unknown to reset narrowing.
            const state = suggestionState as unknown as typeof suggestionState
            state.abortController?.abort()
            const localAbort = new AbortController()
            suggestionState.abortController = localAbort

            const cacheSafeParams = getLastCacheSafeParams()
            if (!cacheSafeParams) {
              logSuggestionSuppressed(
                'sdk_no_params',
                undefined,
                undefined,
                'sdk',
              )
            } else {
              // Use a ref object so the IIFE's finally can compare against its own
              // promise without a self-reference (which upsets TypeScript's flow analysis).
              const ref: { promise: Promise<void> | null } = { promise: null }
              ref.promise = (async () => {
                try {
                  const result = await tryGenerateSuggestion(
                    localAbort,
                    mutableMessages,
                    getAppState,
                    cacheSafeParams,
                    'sdk',
                  )
                  if (!result || localAbort.signal.aborted) return
                  const suggestionMsg = {
                    type: 'prompt_suggestion' as const,
                    suggestion: result.suggestion,
                    uuid: randomUUID(),
                    session_id: getSessionId(),
                  }
                  const lastEmittedEntry = {
                    text: result.suggestion,
                    emittedAt: Date.now(),
                    promptId: result.promptId,
                    generationRequestId: result.generationRequestId,
                  }
                  // Defer emission if the result is being held for background agents,
                  // so that prompt_suggestion always arrives after result.
                  // Only set lastEmitted when the suggestion is actually delivered
                  // to the consumer; deferred suggestions may be discarded before
                  // delivery if a new command arrives first.
                  if (heldBackResult) {
                    suggestionState.pendingSuggestion = suggestionMsg
                    suggestionState.pendingLastEmittedEntry = {
                      text: lastEmittedEntry.text,
                      promptId: lastEmittedEntry.promptId,
                      generationRequestId: lastEmittedEntry.generationRequestId,
                    }
                  } else {
                    suggestionState.lastEmitted = lastEmittedEntry
                    output.enqueue(suggestionMsg)
                  }
                } catch (error) {
                  if (
                    error instanceof Error &&
                    (error.name === 'AbortError' ||
                      error.name === 'APIUserAbortError')
                  ) {
                    logSuggestionSuppressed(
                      'aborted',
                      undefined,
                      undefined,
                      'sdk',
                    )
                    return
                  }
                  logError(toError(error))
                } finally {
                  if (suggestionState.inflightPromise === ref.promise) {
                    suggestionState.inflightPromise = null
                  }
                }
              })()
              suggestionState.inflightPromise = ref.promise
            }
          }

          // Log headless profiler metrics for this turn and start next turn
          logHeadlessProfilerTurn()
          logQueryProfileReport()
          headlessProfilerStartTurn()
        }
      }

      // Use a do-while loop to drain commands and then wait for any
      // background agents that are still running. When agents complete,
      // their notifications are enqueued and the loop re-drains.
      do {
        // Drain SDK events (task_started, task_progress) before command queue
        // so progress events precede task_notification on the stream.
        for (const event of drainSdkEvents()) {
          output.enqueue(event)
        }

        runPhase = 'draining_commands'
        await drainCommandQueue()

        // Check for running background tasks before exiting.
        // Exclude in_process_teammate — teammates are long-lived by design
        // (status: 'running' for their whole lifetime, cleaned up by the
        // shutdown protocol, not by transitioning to 'completed'). Waiting
        // on them here loops forever (gh-30008). Same exclusion already
        // exists at useBackgroundTaskNavigation.ts:55 for the same reason;
        // L1839 above is already narrower (type === 'local_agent') so it
        // doesn't hit this.
        waitingForAgents = false
        {
          const state = getAppState()
          const hasRunningBg = getRunningTasks(state).some(
            t => isBackgroundTask(t) && t.type !== 'in_process_teammate',
          )
          const hasMainThreadQueued = peek(isMainThread) !== undefined
          if (hasRunningBg || hasMainThreadQueued) {
            waitingForAgents = true
            if (!hasMainThreadQueued) {
              runPhase = 'waiting_for_agents'
              // No commands ready yet, wait for tasks to complete
              await sleep(100)
            }
            // Loop back to drain any newly queued commands
          }
        }
      } while (waitingForAgents)

      if (heldBackResult) {
        output.enqueue(heldBackResult)
        heldBackResult = null
        if (suggestionState.pendingSuggestion) {
          output.enqueue(suggestionState.pendingSuggestion)
          // Now that the suggestion is actually delivered, record it for acceptance tracking
          if (suggestionState.pendingLastEmittedEntry) {
            suggestionState.lastEmitted = {
              ...suggestionState.pendingLastEmittedEntry,
              emittedAt: Date.now(),
            }
            suggestionState.pendingLastEmittedEntry = null
          }
          suggestionState.pendingSuggestion = null
        }
      }
    } catch (error) {
      // Emit error result message before shutting down
      // Write directly to structuredIO to ensure immediate delivery
      try {
        await structuredIO.write({
          type: 'result',
          subtype: 'error_during_execution',
          duration_ms: 0,
          duration_api_ms: 0,
          is_error: true,
          num_turns: 0,
          stop_reason: null,
          session_id: getSessionId(),
          total_cost_usd: 0,
          usage: EMPTY_USAGE,
          modelUsage: {},
          permission_denials: [],
          uuid: randomUUID(),
          errors: [
            errorMessage(error),
            ...getInMemoryErrors().map(_ => _.error),
          ],
        })
      } catch {
        // If we can't emit the error result, continue with shutdown anyway
      }
      suggestionState.abortController?.abort()
      gracefulShutdownSync(1)
      return
    } finally {
      runPhase = 'finally_flush'
      runPhase = 'finally_post_flush'
      if (!isShuttingDown()) {
        notifySessionStateChanged('idle')
        // Drain so the idle session_state_changed SDK event (plus any
        // terminal task_notification bookends emitted during bg-agent
        // teardown) reach the output stream before we block on the next
        // command. The do-while drain above only runs while
        // waitingForAgents; once we're here the next drain would be the
        // top of the next run(), which won't come if input is idle.
        for (const event of drainSdkEvents()) {
          output.enqueue(event)
        }
      }
      running = false
      // Start idle timer when we finish processing and are waiting for input
      idleTimeout.start()
      taskListWatcher?.notifyIdle()
    }

    if (deliverPendingDirectTeamModelContext()) {
      void run()
      return
    }

    // Proactive tick: if proactive is active and queue is empty, inject a tick
    if (
      (feature('PROACTIVE') || feature('KAIROS')) &&
      proactiveModule?.isProactiveActive() &&
      !proactiveModule.isProactivePaused()
    ) {
      if (peek(isMainThread) === undefined && !inputClosed) {
        scheduleProactiveTick!()
        return
      }
    }

    // Re-check the queue after releasing the mutex. A message may have
    // arrived (and called run()) between the last dequeue() returning
    // undefined and `running = false` above. In that case the caller
    // saw `running === true` and returned immediately, leaving the
    // message stranded in the queue with no one to process it.
    if (peek(isMainThread) !== undefined) {
      void run()
      return
    }

    // Team leaders keep the historical post-turn wait while teammates remain
    // active. The shared poller below performs the actual closed structured
    // routing; this loop never marks or injects raw mailbox data itself.
    {
      const currentAppState = getAppState()
      const teamContext = currentAppState.teamContext

      if (teamContext && isTeamLead(teamContext)) {
        while (true) {
          const refreshedState = getAppState()
          const hasActiveTeammates =
            hasActiveInProcessTeammates(refreshedState) ||
            (refreshedState.teamContext &&
              Object.keys(refreshedState.teamContext.teammates).length > 0)

          if (!hasActiveTeammates) {
            logForDebugging(
              '[print.ts] No more active teammates, stopping poll',
            )
            break
          }

          if (await pollDirectTeamInboxOnce()) return

          if (inputClosed && !shutdownPromptInjected) {
            shutdownPromptInjected = true
            logForDebugging(
              '[print.ts] Input closed with active teammates, injecting shutdown prompt',
            )
            enqueue({
              mode: 'prompt',
              value: SHUTDOWN_TEAM_PROMPT,
              uuid: randomUUID(),
            })
            void run()
            return // run() will come back here after processing
          }

          await sleep(1000)
        }
      }
    }

    if (inputClosed) {
      // Check for active swarm that needs shutdown
      const hasActiveSwarm = await (async () => {
        // Wait for any working in-process team members to finish
        const currentAppState = getAppState()
        if (hasWorkingInProcessTeammates(currentAppState)) {
          await waitForTeammatesToBecomeIdle(setAppState, currentAppState)
        }

        // Re-fetch state after potential wait
        const refreshedAppState = getAppState()
        const refreshedTeamContext = refreshedAppState.teamContext
        const hasTeamMembersNotCleanedUp =
          refreshedTeamContext &&
          Object.keys(refreshedTeamContext.teammates).length > 0

        return (
          hasTeamMembersNotCleanedUp ||
          hasActiveInProcessTeammates(refreshedAppState)
        )
      })()

      if (hasActiveSwarm) {
        // Team members are idle or pane-based - inject prompt to shut down team
        enqueue({
          mode: 'prompt',
          value: SHUTDOWN_TEAM_PROMPT,
          uuid: randomUUID(),
        })
        void run()
      } else {
        // Wait for any in-flight push suggestion before closing the output stream.
        if (suggestionState.inflightPromise) {
          await Promise.race([suggestionState.inflightPromise, sleep(5000)])
        }
        suggestionState.abortController?.abort()
        suggestionState.abortController = null
        await finalizePendingAsyncHooks()
        commandCatalogLifecycle.close()
        commandCatalogPublisher?.close()
        unsubscribeSkillChanges()
        unsubscribeAppStateCommandCatalog?.()
        unsubscribeSettingsCommandCatalog?.()
        options.closeHeadlessSettings?.()
        unsubscribeAuthStatus?.()
        statusListeners.delete(rateLimitListener)
        output.done()
      }
    }
  }

  const directTeamInboxPollLoop = async (): Promise<void> => {
    while (!directTeamInboxPollerStopped) {
      try {
        await pollDirectTeamInboxOnce()
        if (!running && deliverPendingDirectTeamModelContext()) {
          void run()
        }
      } catch (error) {
        logForDebugging(`[DirectTeamInbox] poll failed: ${error}`, {
          level: 'warn',
        })
      }

      if (inputClosed) {
        const state = getAppState()
        const target = resolveDirectTeamInboxTarget(state)
        const leaderStillOwnsTeam =
          target?.role === 'leader' &&
          (hasActiveInProcessTeammates(state) ||
            (state.teamContext &&
              Object.keys(state.teamContext.teammates).length > 0))
        if (!leaderStillOwnsTeam) break
      }
      await sleep(1000)
    }
  }
  if (directTeamInboxRuntime) {
    void directTeamInboxPollLoop()
    registerCleanup(async () => {
      directTeamInboxPollerStopped = true
    })
  }

  if (routePolicy.tasksMode && options.taskListId) {
    const isMainThreadQueued = (): boolean =>
      peek(command => command.agentId === undefined) !== undefined
    taskListWatcher = new TaskListWatcherCore({
      taskListId: options.taskListId,
      isBusy: () =>
        !runtimeInitialized || inputClosed || running || isMainThreadQueued(),
      onSubmitTask: prompt => {
        if (
          !runtimeInitialized ||
          inputClosed ||
          running ||
          isMainThreadQueued()
        ) {
          return false
        }
        const uuid = randomUUID()
        enqueue({
          mode: 'prompt',
          value: prompt,
          uuid,
        })
        output.enqueue({
          type: 'user',
          message: { role: 'user', content: prompt },
          session_id: getSessionId(),
          parent_tool_use_id: null,
          uuid,
        } satisfies SDKUserMessage)
        void run()
        return true
      },
    })
    void taskListWatcher.start()
    registerCleanup(async () => taskListWatcher?.stop())
  }

  // Set up UDS inbox callback so the query loop is kicked off
  // when a message arrives via the UDS socket in headless mode.
  if (feature('UDS_INBOX')) {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { setOnEnqueue } = require('../../utils/udsMessaging.js')
    /* eslint-enable @typescript-eslint/no-require-imports */
    setOnEnqueue(() => {
      if (!inputClosed) {
        void run()
      }
    })
  }

  // Cron scheduler: SDK/-p 模式不再本地调度。cronScheduler 已迁移到 Rust
  // SchedulerDaemon (crates/crabcode-cron) 统一调度；fire 事件通过 cron daemon
  // 的持久 outbox（`cron.outbox_read`，UDS on Unix / Named Pipe on Windows）
  // 暴露给所有 host。SDK / headless host 消费本地 cron fire 事件走 SDK 入口
  // `watchScheduledTasks`（agentSdkTypes.ts）—— 它是 LOCAL headless host 事件
  // 桥，从本地 daemon 的 append-only outbox 按持久 cursor 轮询拉取（W-CRON-
  // AUTOMATION-E2E P8 已接入，不再是 stub）。REPL 侧并行走 `useScheduledTasks`
  // 1.5s tick，两者各持独立 cursor。
  //
  // 注意：`watchScheduledTasks` 消费的是 LOCAL cron daemon —— 与远程触发线
  // （`AGENT_TRIGGERS_REMOTE` / `RemoteTriggerTool`）是两条独立路径。
  //
  // 历史：早期版本 Rust daemon 触发的任务通过 Go gateway `cron.poll_events`
  // → WS 广播到达 SDK；M6 (2026-05-02) Go 下线后该路径失效，后由持久 outbox
  // + cursor 模型替代。

  const sendControlResponseSuccess = function (
    message: SDKControlRequest,
    response?: Record<string, unknown>,
  ) {
    output.enqueue({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: message.request_id,
        response: response,
      },
    })
  }

  const sendControlResponseError = function (
    message: SDKControlRequest,
    errorMessage: string,
  ) {
    output.enqueue({
      type: 'control_response',
      response: {
        subtype: 'error',
        request_id: message.request_id,
        error: errorMessage,
      },
    })
  }

  // Handle unexpected permission responses by looking up the unresolved tool
  // call in the transcript and executing it
  const handledOrphanedToolUseIds = new Set<string>()
  structuredIO.setUnexpectedResponseCallback(async message => {
    await handleOrphanedPermissionResponse({
      message,
      setAppState,
      handledToolUseIds: handledOrphanedToolUseIds,
      onEnqueued: () => {
        // The first message of a session might be the orphaned permission
        // check rather than a user prompt, so kick off the loop.
        void run()
      },
    })
  })

  const cancelActiveMcpOAuthFlow = async (serverName: string): Promise<void> => {
    const controller = activeOAuthFlows.get(serverName)
    if (!controller) return
    const authPromise = oauthAuthPromises.get(serverName)
    controller.abort()
    // Invalidate the generation before awaiting its token-exchange promise so
    // its already-queued completion cannot reconnect while cancellation waits.
    if (activeOAuthFlows.get(serverName) === controller) {
      activeOAuthFlows.delete(serverName)
      oauthCallbackSubmitters.delete(serverName)
      oauthManualCallbackUsed.delete(serverName)
      oauthAuthPromises.delete(serverName)
    }
    if (authPromise) {
      await authPromise.catch(() => undefined)
    }
  }

  const authorizeDirectMcpOAuth = async (serverName: string) => {
    const target = getDirectOwnedMcpTarget(serverName)
    if (target?.owner === 'public' || target?.owner === 'fixed') {
      const { config } = target
      if (config.type !== 'sse' && config.type !== 'http') {
        return {
          allowed: false as const,
          message: `MCP server "${serverName}" transport "${config.type}" does not support OAuth`,
        }
      }
      if (
        directControlDisabledMcpNames.has(serverName)
      ) {
        return {
          allowed: false as const,
          message: `MCP server "${serverName}" is disabled`,
        }
      }
      const admissionError = directMcpControlAdmissionError(
        serverName,
        config,
      )
      return admissionError
        ? { allowed: false as const, message: admissionError }
        : {
            allowed: true as const,
            config,
            owner: target.owner,
          }
    }

    const inventoryRecord = isPluginMcpRuntimeName(serverName)
      ? (await getCrabCodeMcpConfigs()).pluginInventory.find(
          record => record.runtimeName === serverName,
        )
      : undefined
    if (isDirectTuiSdkMcpInventoryRecord(inventoryRecord)) {
      return {
        allowed: false as const,
        message: DIRECT_TUI_SDK_MCP_UNSUPPORTED_ERROR,
      }
    }

    const authorization = await authorizeMcpOAuthStart(serverName)
    if (!authorization.allowed) return authorization
    const ownershipError = directMcpNameOwnershipError(serverName)
    const admissionError = directMcpControlAdmissionError(
      serverName,
      authorization.config,
    )
    return ownershipError || admissionError
      ? {
          allowed: false as const,
          message: ownershipError ?? admissionError!,
        }
      : {
          allowed: true as const,
          config: authorization.config,
          owner: 'plugin' as const,
        }
  }

  // In-flight Acosmi OAuth flow (crabcode_authenticate). SDK handles the full
  // PKCE flow via IPC — no more localhost listener or manual code entry.
  // We only track the flow promise to let crabcode_oauth_wait_for_completion
  // await its result.
  let crabCodeOAuth: {
    flow: Promise<void>
    credentialsCommitted: () => boolean
  } | null = null

  // This is essentially spawning a parallel async task- we have two
  // running in parallel- one reading from stdin and adding to the
  // queue to be processed and another reading from the queue,
  // processing and returning the result of the generation.
  // The process is complete when the input stream completes and
  // the last generation of the queue has complete.
  void (async () => {
    logForDiagnosticsNoPII('info', 'cli_message_loop_started')
    for await (const message of structuredIO.structuredInput) {
      // Non-user events are handled inline (no queue). started→completed in
      // the same tick carries no information, so only fire completed.
      // control_response is reported by StructuredIO.processLine (which also
      // sees orphans that never yield here).
      const eventId = 'uuid' in message ? message.uuid : undefined
      if (
        eventId &&
        message.type !== 'user' &&
        message.type !== 'control_response'
      ) {
        notifyCommandLifecycle(eventId, 'completed')
      }

      if (message.type === 'control_request') {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const req = message.request as any
        if (message.request.subtype === 'interrupt') {
          // Track escapes for attribution (ant-only feature)
          if (feature('COMMIT_ATTRIBUTION')) {
            setAppState(prev => ({
              ...prev,
              attribution: {
                ...prev.attribution,
                escapeCount: prev.attribution.escapeCount + 1,
              },
            }))
          }
          if (abortController) {
            abortController.abort()
          }
          suggestionState.abortController?.abort()
          suggestionState.abortController = null
          suggestionState.lastEmitted = null
          suggestionState.pendingSuggestion = null
          sendControlResponseSuccess(message)
        } else if (req.subtype === 'end_session') {
          logForDebugging(
            `[print.ts] end_session received, reason=${req.reason ?? 'unspecified'}`,
          )
          if (abortController) {
            abortController.abort()
          }
          suggestionState.abortController?.abort()
          suggestionState.abortController = null
          suggestionState.lastEmitted = null
          suggestionState.pendingSuggestion = null
          sendControlResponseSuccess(message)
          break // exits for-await → falls through to inputClosed=true drain below
        } else if (message.request.subtype === 'initialize') {
          // SDK MCP server names from the initialize message
          // Populated by both browser and ProcessTransport sessions
          if (
            message.request.sdkMcpServers &&
            message.request.sdkMcpServers.length > 0
          ) {
            if (routePolicy.directQueryEventDelivery) {
              sendControlResponseError(
                message,
                `${DIRECT_TUI_SDK_MCP_UNSUPPORTED_ERROR}: ${message.request.sdkMcpServers.join(', ')}`,
              )
              continue
            }
            for (const serverName of message.request.sdkMcpServers) {
              // Create placeholder config for SDK MCP servers
              // The actual server connection is managed by the SDK Query class
              sdkMcpConfigs[serverName] = {
                type: 'sdk',
                name: serverName,
              }
            }
          }

          await handleInitializeRequest(
            message.request,
            message.request_id,
            runtimeInitialized,
            output,
            routePolicy.directQueryEventDelivery
              ? async () => {
                  await commandCatalogLifecycle.whenIdle()
                  return currentCatalogCommands()
                }
              : currentCatalogCommands(),
            modelInfos,
            structuredIO,
            !!options.enableAuthStatus,
            options,
            currentAgents,
            getAppState,
            routePolicy.directQueryEventDelivery,
          )

          // Enable prompt suggestions in AppState when SDK consumer opts in.
          // shouldEnablePromptSuggestion() returns false for non-interactive
          // sessions, but the SDK consumer explicitly requested suggestions.
          if (message.request.promptSuggestions) {
            setAppState(prev => {
              if (prev.promptSuggestionEnabled) return prev
              return { ...prev, promptSuggestionEnabled: true }
            })
          }

          if (
            message.request.agentProgressSummaries &&
            getFeatureValue_CACHED_MAY_BE_STALE('tengu_slate_prism', true)
          ) {
            setSdkAgentProgressSummariesEnabled(true)
          }

          runtimeInitialized = true
          commandCatalogPublisher?.markInitialized()
          taskListWatcher?.notifyIdle()
          // The initialize response is the runtime-ready boundary. Every
          // renderer-only setup authority completed before this request was
          // handed to StructuredIO, so no second startup protocol exists.
          if (hasCommandsInQueue()) {
            void run()
          }
        } else if (message.request.subtype === 'set_permission_mode') {
          const m = message.request
          setAppState(prev => ({
            ...prev,
            toolPermissionContext: handleSetPermissionMode(
              m,
              message.request_id,
              prev.toolPermissionContext,
              output,
            ),
          }))
        } else if (message.request.subtype === 'set_model') {
          const requestedModel = message.request.model ?? 'default'
          const model =
            requestedModel === 'default'
              ? getDefaultMainLoopModel()
              : requestedModel
          activeUserSpecifiedModel = model
          setMainLoopModelOverride(model)
          injectModelSwitchBreadcrumbs(requestedModel, model)

          sendControlResponseSuccess(message)
        } else if (message.request.subtype === 'set_max_thinking_tokens') {
          if (message.request.max_thinking_tokens === null) {
            options.thinkingConfig = undefined
          } else if (message.request.max_thinking_tokens === 0) {
            options.thinkingConfig = { type: 'disabled' }
          } else {
            options.thinkingConfig = {
              type: 'enabled',
              budgetTokens: message.request.max_thinking_tokens,
            }
          }
          sendControlResponseSuccess(message)
        } else if (req.subtype === 'crabcode_tui_logout') {
          const releaseCatalog = commandCatalogPublisher?.hold() ?? (() => {})
          try {
            await handleDirectTuiLogoutRequest(
              message.request_id,
              output,
              routePolicy.commandLoader,
              cwd(),
              routePolicy.interactiveProductSession,
              undefined,
              refreshedCommands => {
                if (!commandCatalogLifecycle.replace(refreshedCommands)) {
                  throw new Error(
                    'direct TUI command catalog lifecycle rejected the signed-out snapshot',
                  )
                }
              },
              currentCatalogCommands,
            )
          } finally {
            releaseCatalog()
          }
        } else if (message.request.subtype === 'mcp_status') {
          sendControlResponseSuccess(message, {
            mcpServers: await buildMcpServerStatuses(),
          })
        } else if (message.request.subtype === 'get_context_usage') {
          output.enqueue(
            await handleGetContextUsageControlRequest({
              message,
              messages: mutableMessages,
              getAppState,
              getMainLoopModel,
              buildTools: buildAllTools,
              customSystemPrompt: options.systemPrompt,
              appendSystemPrompt: options.appendSystemPrompt,
            }),
          )
        } else if (message.request.subtype === 'mcp_message') {
          if (routePolicy.directQueryEventDelivery) {
            sendControlResponseError(
              message,
              DIRECT_TUI_SDK_MCP_UNSUPPORTED_ERROR,
            )
            continue
          }
          // Handle MCP notifications from SDK servers
          const mcpRequest = message.request
          const sdkClient = sdkClients.find(
            client => client.name === mcpRequest.server_name,
          )
          // Check client exists - dynamically added SDK servers may have
          // placeholder clients with null client until updateSdkMcp() runs
          if (
            sdkClient &&
            sdkClient.type === 'connected' &&
            sdkClient.client?.transport?.onmessage
          ) {
            sdkClient.client.transport.onmessage(
              mcpRequest.message as import('@modelcontextprotocol/sdk/types.js').JSONRPCMessage,
            )
          }
          sendControlResponseSuccess(message)
        } else if (message.request.subtype === 'rewind_files') {
          const appState = getAppState()
          const result = await handleRewindFiles(
            message.request.user_message_id as UUID,
            appState,
            setAppState,
            message.request.dry_run ?? false,
          )
          if (result.canRewind || message.request.dry_run) {
            sendControlResponseSuccess(message, result)
          } else {
            sendControlResponseError(
              message,
              result.error ?? 'Unexpected error',
            )
          }
        } else if (message.request.subtype === 'cancel_async_message') {
          const targetUuid = message.request.message_uuid
          const removed = dequeueAllMatching(cmd => cmd.uuid === targetUuid)
          sendControlResponseSuccess(message, {
            cancelled: removed.length > 0,
          })
        } else if (message.request.subtype === 'seed_read_state') {
          // Client observed a Read that was later removed from context (e.g.
          // by snip), so transcript-based seeding missed it. Queued into
          // pendingSeeds; applied at the next clone-replace boundary.
          try {
            // expandPath: all other readFileState writers normalize (~, relative,
            // session cwd vs process cwd). FileEditTool looks up by expandPath'd
            // key — a verbatim client path would miss.
            const normalizedPath = expandPath(message.request.path)
            // Check disk mtime before reading content. If the file changed
            // since the client's observation, readFile would return C_current
            // but we'd store it with the client's M_observed — getChangedFiles
            // then sees disk > cache.timestamp, re-reads, diffs C_current vs
            // C_current = empty, emits no attachment, and the model is never
            // told about the C_observed → C_current change. Skipping the seed
            // makes Edit fail "file not read yet" → forces a fresh Read.
            // Math.floor matches FileReadTool and getFileModificationTime.
            const diskMtime = Math.floor((await stat(normalizedPath)).mtimeMs)
            if (diskMtime <= message.request.mtime) {
              const raw = await readFile(normalizedPath, 'utf-8')
              // Strip BOM + normalize CRLF→LF to match readFileInRange and
              // readFileSyncWithMetadata. FileEditTool's content-compare
              // fallback (for Windows mtime bumps without content change)
              // compares against LF-normalized disk reads.
              const content = (
                raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw
              ).replaceAll('\r\n', '\n')
              pendingSeeds.set(normalizedPath, {
                content,
                timestamp: diskMtime,
                offset: undefined,
                limit: undefined,
              })
            }
          } catch {
            // ENOENT etc — skip seeding but still succeed
          }
          sendControlResponseSuccess(message)
        } else if (message.request.subtype === 'mcp_set_servers') {
          const releaseCatalog = commandCatalogPublisher?.hold() ?? (() => {})
          try {
            const { response, sdkServersChanged } = await applyMcpServerChanges(
              'public',
              message.request.servers,
            )
            sendControlResponseSuccess(message, response)

            // Connect SDK servers AFTER response to avoid deadlock
            if (sdkServersChanged) {
              void updateSdkMcp()
            }
          } finally {
            releaseCatalog()
          }
        } else if (message.request.subtype === 'reload_plugins') {
          const releaseCatalog = commandCatalogPublisher?.hold() ?? (() => {})
          try {
            if (
              feature('DOWNLOAD_USER_SETTINGS') &&
              isEnvTruthy(process.env.CRABCODE_REMOTE)
            ) {
              // Re-pull user settings so enabledPlugins pushed from the
              // user's local CLI take effect before the cache sweep.
              const applied = await redownloadUserSettings()
              if (applied) {
                settingsChangeDetector.notifyChange('userSettings')
              }
            }

            const r = await refreshActivePlugins(setAppState)

            const sdkAgents = currentAgents.filter(
              a => a.source === 'flagSettings',
            )
            currentAgents = [...r.agentDefinitions.allAgents, ...sdkAgents]

            // Reload succeeded — gather response data best-effort so a
            // read failure doesn't mask the successful state change.
            // allSettled so one failure doesn't discard the others.
            let plugins: SDKControlReloadPluginsResponse['plugins'] = []
            const [cmdsR, mcpR, pluginsR] = await Promise.allSettled([
              commandCatalogLifecycle.refresh(() =>
                routePolicy.commandLoader(cwd()),
              ),
              applyPluginMcpDiff(),
              loadAllPluginsCacheOnly(),
            ])
            if (cmdsR.status === 'rejected') {
              logError(cmdsR.reason)
            }
            if (mcpR.status === 'rejected') {
              logError(mcpR.reason)
            }
            if (pluginsR.status === 'fulfilled') {
              plugins = pluginsR.value.enabled.map(p => ({
                name: p.name,
                path: p.path,
                source: p.source,
              }))
            } else {
              logError(pluginsR.reason)
            }

            sendControlResponseSuccess(message, {
              commands: projectCurrentCommandCatalog(currentCatalogCommands()),
              agents: currentAgents.map(a => ({
                name: a.agentType,
                description: a.whenToUse,
                model: a.model === 'inherit' ? undefined : a.model,
              })),
              plugins,
              mcpServers: await buildMcpServerStatuses(),
              error_count: r.error_count,
            } satisfies SDKControlReloadPluginsResponse)
          } catch (error) {
            sendControlResponseError(message, errorMessage(error))
          } finally {
            releaseCatalog()
          }
        } else if (message.request.subtype === 'mcp_reconnect') {
          const { serverName } = message.request
          if (separateProcessMcpOwners) {
            const releaseCatalog = commandCatalogPublisher?.hold() ?? (() => {})
            try {
              const outcome = await reconnectDirectMcpServer(serverName)
              if (outcome.ok) sendControlResponseSuccess(message)
              else sendControlResponseError(message, outcome.error)
            } finally {
              releaseCatalog()
            }
            continue
          }
          const currentAppState = getAppState()
          // Config-existence gate must cover the SAME sources as the
          // operations below. SDK-injected servers (query({mcpServers:{...}}))
          // and dynamically-added servers were missing here, so
          // toggleMcpServer/reconnect returned "Server not found" even though
          // the disconnect/reconnect would have worked (gh-31339 / CC-314).
          const directOwnedTarget = getDirectOwnedMcpTarget(serverName)
          const fallbackConfig = separateProcessMcpOwners
            ? (directOwnedTarget?.config ?? getMcpConfigByName(serverName))
            : (getMcpConfigByName(serverName) ??
              mcpClients.find(c => c.name === serverName)?.config ??
              sdkClients.find(c => c.name === serverName)?.config ??
              dynamicMcpState.clients.find(c => c.name === serverName)
                ?.config ??
              currentAppState.mcp.clients.find(c => c.name === serverName)
                ?.config ??
              null)
          const freshConfigured = await getActiveMcpConfigByName(serverName)
          const config = separateProcessMcpOwners
            ? directOwnedTarget?.owner === 'plugin'
              ? freshConfigured
              : (directOwnedTarget?.config ??
                freshConfigured ??
                fallbackConfig)
            : (freshConfigured ??
              (fallbackConfig?.pluginMcp ? null : fallbackConfig))
          const admissionError = config
            ? directMcpControlAdmissionError(serverName, config)
            : null
          if (!config) {
            sendControlResponseError(message, `Server not found: ${serverName}`)
          } else if (admissionError) {
            sendControlResponseError(message, admissionError)
          } else if (
            separateProcessMcpOwners &&
            !directMcpTargetIsOwned(serverName)
          ) {
            const claimError = await claimDirectPluginMcpOwner(serverName)
            const claimedClient = pluginProcessMcpState.clients.find(
              client => client.name === serverName,
            )
            if (claimError) {
              sendControlResponseError(message, claimError)
            } else if (claimedClient?.type === 'connected') {
              registerElicitationHandlers([claimedClient])
              reregisterChannelHandlerAfterReconnect(claimedClient)
              sendControlResponseSuccess(message)
            } else {
              sendControlResponseError(
                message,
                claimedClient?.type === 'failed'
                  ? (claimedClient.error ?? 'Connection failed')
                  : `Server status: ${claimedClient?.type ?? 'unavailable'}`,
              )
            }
          } else {
            elicitationRegistered.delete(serverName)
            const result = await reconnectMcpServerImpl(serverName, config)
            // Update appState.mcp with the new client, tools, commands, and resources
            const prefix = getMcpPrefix(serverName)
            setAppState(prev => ({
              ...prev,
              mcp: {
                ...prev.mcp,
                clients: prev.mcp.clients.map(c =>
                  c.name === serverName ? result.client : c,
                ),
                tools: [
                  ...reject(prev.mcp.tools, t => t.name?.startsWith(prefix)),
                  ...result.tools,
                ],
                commands: [
                  ...reject(prev.mcp.commands, c =>
                    commandBelongsToServer(c, serverName),
                  ),
                  ...result.commands,
                ],
                resources:
                  result.resources && result.resources.length > 0
                    ? { ...prev.mcp.resources, [serverName]: result.resources }
                    : omit(prev.mcp.resources, serverName),
              },
            }))
            syncHeadlessMcpRuntime(serverName, result.client, result.tools)
            if (result.client.type === 'connected') {
              registerElicitationHandlers([result.client])
              reregisterChannelHandlerAfterReconnect(result.client)
              sendControlResponseSuccess(message)
            } else {
              const errorMessage =
                result.client.type === 'failed'
                  ? (result.client.error ?? 'Connection failed')
                  : `Server status: ${result.client.type}`
              sendControlResponseError(message, errorMessage)
            }
          }
        } else if (message.request.subtype === 'mcp_toggle') {
          const { serverName, enabled } = message.request
          if (separateProcessMcpOwners) {
            const releaseCatalog = commandCatalogPublisher?.hold() ?? (() => {})
            try {
              const outcome = await toggleDirectMcpServer(serverName, enabled)
              if (outcome.ok) sendControlResponseSuccess(message)
              else sendControlResponseError(message, outcome.error)
            } finally {
              releaseCatalog()
            }
            continue
          }
          const currentAppState = getAppState()
          // Gate must match the client-lookup spread below (which
          // includes sdkClients and dynamicMcpState.clients). Same fix as
          // mcp_reconnect above (gh-31339 / CC-314).
          const directOwnedTarget = getDirectOwnedMcpTarget(serverName)
          const freshPluginOwnerConfig =
            separateProcessMcpOwners &&
            directOwnedTarget?.owner === 'plugin'
              ? await getActiveMcpConfigByName(serverName)
              : null
          let config = separateProcessMcpOwners
            ? directOwnedTarget?.owner === 'plugin'
              ? freshPluginOwnerConfig
              : (directOwnedTarget?.config ?? getMcpConfigByName(serverName))
            : (getMcpConfigByName(serverName) ??
              mcpClients.find(c => c.name === serverName)?.config ??
              sdkClients.find(c => c.name === serverName)?.config ??
              dynamicMcpState.clients.find(c => c.name === serverName)
                ?.config ??
              currentAppState.mcp.clients.find(c => c.name === serverName)
                ?.config ??
              null)
          let activationAlreadyPersisted = false
          let refreshedAfterActivation:
            | Awaited<ReturnType<typeof getCrabCodeMcpConfigs>>
            | undefined
          let inactivePluginInventoryFound = false

          // A deferred remote MCPB intentionally has an inventory row but no
          // live config until explicit activation authorizes the download.
          // Resolve its static candidate before any persistence so SDK and
          // namespace-invalid rows fail closed with zero side effects.
          if (!config && isPluginMcpRuntimeName(serverName)) {
            const inventory = await getCrabCodeMcpConfigs()
            const record = inventory.pluginInventory.find(
              item => item.runtimeName === serverName,
            )
            if (record) {
              // Inventory deliberately omits transport when no executable
              // config exists. Direct mode cannot prove SDK support, policy,
              // or namespace safety after a side-effecting activation, so the
              // only sound boundary is to reject before persistence.
              const inventoryAdmissionError =
                separateProcessMcpOwners && !record.config
                  ? 'Direct TUI cannot activate an MCP server before its process transport configuration is available'
                  : directMcpNameOwnershipError(serverName)
              if (inventoryAdmissionError) {
                sendControlResponseError(message, inventoryAdmissionError)
                continue
              }
              inactivePluginInventoryFound = true
              config = record.config ?? null
            }
          }

          const admissionError = config
            ? directMcpControlAdmissionError(serverName, config)
            : null
          if (admissionError) {
            sendControlResponseError(message, admissionError)
            continue
          }
          elicitationRegistered.delete(serverName)

          if (inactivePluginInventoryFound) {
            await setMcpServerEnabled(serverName, enabled)
            activationAlreadyPersisted = true
            if (enabled) {
              refreshedAfterActivation = await getCrabCodeMcpConfigs()
              config = refreshedAfterActivation.servers[serverName] ?? null
            }
          }

          const refreshedAdmissionError = config
            ? directMcpControlAdmissionError(serverName, config)
            : null
          if (refreshedAdmissionError) {
            sendControlResponseError(message, refreshedAdmissionError)
            continue
          }

          if (!config) {
            if (!activationAlreadyPersisted) {
              sendControlResponseError(
                message,
                `Server not found: ${serverName}`,
              )
            } else {
              const prefix = getMcpPrefix(serverName)
              syncHeadlessMcpRuntime(serverName, null)
              setAppState(prev => ({
                ...prev,
                mcp: {
                  ...prev.mcp,
                  clients: prev.mcp.clients.filter(
                    client => client.name !== serverName,
                  ),
                  tools: reject(prev.mcp.tools, tool =>
                    tool.name?.startsWith(prefix),
                  ),
                  commands: reject(prev.mcp.commands, command =>
                    commandBelongsToServer(command, serverName),
                  ),
                  resources: omit(prev.mcp.resources, serverName),
                },
              }))
              sendControlResponseSuccess(message)
            }
          } else if (!enabled) {
            // Disabling: persist + disconnect (matches TUI toggleMcpServer behavior)
            if (!activationAlreadyPersisted) {
              await setMcpServerEnabled(serverName, false)
            }
            const clientPool = [
              ...mcpClients,
              ...sdkClients,
              ...dynamicMcpState.clients,
              ...(separateProcessMcpOwners
                ? pluginProcessMcpState.clients
                : []),
              ...currentAppState.mcp.clients,
            ]
            const client = (separateProcessMcpOwners
              ? uniqBy(clientPool, 'name')
              : clientPool
            ).find(c => c.name === serverName)
            if (client && client.type === 'connected') {
              if (separateProcessMcpOwners) {
                await evictExistingServerCache(serverName, config)
              } else {
                await clearServerCache(serverName, config)
              }
            }
            // Update appState.mcp to reflect disabled status and remove tools/commands/resources
            const prefix = getMcpPrefix(serverName)
            const disabledClient: MCPServerConnection = {
              name: serverName,
              type: 'disabled',
              config,
            }
            syncHeadlessMcpRuntime(serverName, disabledClient)
            setAppState(prev => ({
              ...prev,
              mcp: {
                ...prev.mcp,
                clients: upsertConnection(prev.mcp.clients, disabledClient),
                tools: reject(prev.mcp.tools, t => t.name?.startsWith(prefix)),
                commands: reject(prev.mcp.commands, c =>
                  commandBelongsToServer(c, serverName),
                ),
                resources: omit(prev.mcp.resources, serverName),
              },
            }))
            sendControlResponseSuccess(message)
          } else {
            // Enabling: persist + reconnect
            if (!activationAlreadyPersisted) {
              await setMcpServerEnabled(serverName, true)
            }
            if (
              separateProcessMcpOwners &&
              !directMcpTargetIsOwned(serverName)
            ) {
              const claimError = await claimDirectPluginMcpOwner(serverName)
              const claimedClient = pluginProcessMcpState.clients.find(
                client => client.name === serverName,
              )
              if (claimError) {
                sendControlResponseError(message, claimError)
              } else if (claimedClient?.type === 'failed') {
                sendControlResponseError(
                  message,
                  claimedClient.error ?? 'Connection failed',
                )
              } else {
                if (claimedClient?.type === 'connected') {
                  registerElicitationHandlers([claimedClient])
                  reregisterChannelHandlerAfterReconnect(claimedClient)
                }
                sendControlResponseSuccess(message)
              }
              continue
            }
            let reconnectConfig = config
            let pluginLifecycle = config.pluginMcp
            let refreshedPluginConfigAvailable = true
            if (pluginLifecycle) {
              // Inactive plugin inventory is intentionally static: it does
              // not touch plugin data, PATH, keychain, or remote MCPB. Rebuild
              // after the persisted opt-in so preflight/auth happen exactly
              // once at the authorized boundary.
              const refreshed =
                refreshedAfterActivation ?? (await getCrabCodeMcpConfigs())
              const refreshedRecord = refreshed.pluginInventory.find(
                record => record.runtimeName === serverName,
              )
              const refreshedConfig = refreshed.servers[serverName]
              refreshedPluginConfigAvailable = refreshedConfig !== undefined
              if (refreshedRecord) {
                pluginLifecycle =
                  lifecycleMetadataFromInventory(refreshedRecord)
                reconnectConfig =
                  refreshedConfig ?? refreshedRecord.config ?? config
              } else {
                pluginLifecycle = {
                  ...pluginLifecycle,
                  activation: 'enabled',
                  active: false,
                  reasonCode: 'invalid-config',
                  reason: 'Plugin MCP inventory disappeared after activation',
                }
              }
            }
            if (
              pluginLifecycle &&
              (!refreshedPluginConfigAvailable ||
                !pluginLifecycle.active ||
                !canPluginMcpConnectAfterExplicitEnable(pluginLifecycle))
            ) {
              const blockedClient: MCPServerConnection = {
                name: serverName,
                type:
                  pluginLifecycle.authState === 'requiresLogin'
                    ? 'needs-auth'
                    : 'disabled',
                config: reconnectConfig,
              }
              const prefix = getMcpPrefix(serverName)
              syncHeadlessMcpRuntime(serverName, blockedClient)
              setAppState(prev => ({
                ...prev,
                mcp: {
                  ...prev.mcp,
                  clients: upsertConnection(prev.mcp.clients, blockedClient),
                  tools: reject(prev.mcp.tools, t =>
                    t.name?.startsWith(prefix),
                  ),
                  commands: reject(prev.mcp.commands, c =>
                    commandBelongsToServer(c, serverName),
                  ),
                  resources: omit(prev.mcp.resources, serverName),
                },
              }))
              sendControlResponseSuccess(message)
            } else {
              const result = await reconnectMcpServerImpl(
                serverName,
                reconnectConfig,
              )
              // Update appState.mcp with the new client, tools, commands, and
              // resources so the LLM sees the refreshed capabilities.
              const prefix = getMcpPrefix(serverName)
              syncHeadlessMcpRuntime(serverName, result.client, result.tools)
              setAppState(prev => ({
                ...prev,
                mcp: {
                  ...prev.mcp,
                  clients: upsertConnection(prev.mcp.clients, result.client),
                  tools: [
                    ...reject(prev.mcp.tools, t => t.name?.startsWith(prefix)),
                    ...result.tools,
                  ],
                  commands: [
                    ...reject(prev.mcp.commands, c =>
                      commandBelongsToServer(c, serverName),
                    ),
                    ...result.commands,
                  ],
                  resources:
                    result.resources && result.resources.length > 0
                      ? {
                          ...prev.mcp.resources,
                          [serverName]: result.resources,
                        }
                      : omit(prev.mcp.resources, serverName),
                },
              }))
              if (result.client.type === 'connected') {
                registerElicitationHandlers([result.client])
                reregisterChannelHandlerAfterReconnect(result.client)
                sendControlResponseSuccess(message)
              } else {
                const errorMessage =
                  result.client.type === 'failed'
                    ? (result.client.error ?? 'Connection failed')
                    : `Server status: ${result.client.type}`
                sendControlResponseError(message, errorMessage)
              }
            }
          }
        } else if (req.subtype === 'channel_enable') {
          const currentAppState = getAppState()
          handleChannelEnable(
            message.request_id,
            req.serverName,
            // Pool spread matches mcp_status — all three client sources.
            separateProcessMcpOwners
              ? uniqBy(
                  [
                    ...currentAppState.mcp.clients,
                    ...sdkClients,
                    ...dynamicMcpState.clients,
                    ...pluginProcessMcpState.clients,
                  ],
                  'name',
                )
              : [
                  ...currentAppState.mcp.clients,
                  ...sdkClients,
                  ...dynamicMcpState.clients,
                ],
            output,
          )
        } else if (req.subtype === 'mcp_authenticate') {
          const { serverName } = req
          const authorization = separateProcessMcpOwners
            ? await authorizeDirectMcpOAuth(serverName)
            : await authorizeMcpOAuthStart(serverName)
          if (!authorization.allowed) {
            sendControlResponseError(
              message,
              `MCP OAuth is not authorized for ${serverName}: ${authorization.message}`,
            )
          } else {
            const config = authorization.config
            const admissionError = directMcpControlAdmissionError(
              serverName,
              config,
            )
            if (admissionError) {
              sendControlResponseError(message, admissionError)
              continue
            }
            try {
              // A superseded generation must settle before the next one can
              // begin writing credentials for the same server.
              await cancelActiveMcpOAuthFlow(serverName)
              // Capture the auth URL from the callback
              let resolveAuthUrl: (url: string) => void
              const authUrlPromise = new Promise<string>(resolve => {
                resolveAuthUrl = resolve
              })
              const launch = (
                currentConfig: typeof config,
                controller: AbortController,
              ) =>
                performMCPOAuthFlow(
                  serverName,
                  currentConfig,
                  url => resolveAuthUrl!(url),
                  controller.signal,
                  {
                    skipBrowserOpen: true,
                    onWaitingForCallback: submit => {
                      if (activeOAuthFlows.get(serverName) === controller) {
                        oauthCallbackSubmitters.set(serverName, submit)
                      }
                    },
                  },
                )

              let effectiveAuthorization = authorization
              let directAuthorizationOwner:
                | DirectOwnedMcpTarget['owner']
                | null = null
              let controller: AbortController
              let oauthPromise: Promise<void>
              if (separateProcessMcpOwners) {
                const started = await runDirectMcpMutation(async () => {
                  const latestAuthorization =
                    await authorizeDirectMcpOAuth(serverName)
                  if (!latestAuthorization.allowed) {
                    return latestAuthorization
                  }
                  const nextController = new AbortController()
                  activeOAuthFlows.set(serverName, nextController)
                  return {
                    allowed: true as const,
                    authorization: latestAuthorization,
                    controller: nextController,
                    oauthPromise: launch(
                      latestAuthorization.config,
                      nextController,
                    ),
                  }
                })
                if (!started.allowed) {
                  sendControlResponseError(
                    message,
                    `MCP OAuth is not authorized for ${serverName}: ${started.message}`,
                  )
                  continue
                }
                effectiveAuthorization = started.authorization
                directAuthorizationOwner = started.authorization.owner
                controller = started.controller
                oauthPromise = started.oauthPromise
              } else {
                controller = new AbortController()
                activeOAuthFlows.set(serverName, controller)
                oauthPromise = launch(config, controller)
              }
              const authorizedServerKey = getServerKey(
                serverName,
                effectiveAuthorization.config,
              )

              // Wait for the auth URL (or the flow to complete without needing redirect)
              const authUrl = await Promise.race([
                authUrlPromise,
                oauthPromise.then(() => null as string | null),
              ])

              if (authUrl) {
                sendControlResponseSuccess(message, {
                  authUrl,
                  requiresUserAction: true,
                })
              } else {
                sendControlResponseSuccess(message, {
                  requiresUserAction: false,
                })
              }

              // Store auth-only promise for mcp_oauth_callback_url handler.
              // Don't swallow errors — the callback handler needs to detect
              // auth failures and report them to the caller.
              oauthAuthPromises.set(serverName, oauthPromise)

              // Handle background completion — reconnect after auth.
              // When manual callback is used, skip the reconnect here;
              // the extension's handleAuthDone → mcp_reconnect handles it
              // (which also updates dynamicMcpState for tool registration).
              const fullFlowPromise = oauthPromise
                .then(async () => {
                  // Skip reconnect if the manual callback path was used —
                  // handleAuthDone will do it via mcp_reconnect (which
                  // updates dynamicMcpState for tool registration).
                  if (oauthManualCallbackUsed.has(serverName)) {
                    return
                  }
                  // The OAuth flow may outlive the activation/config snapshot
                  // that authorized it. Rebuild after tokens land and refuse
                  // reconnect if the server was disabled or gained a blocker.
                  if (activeOAuthFlows.get(serverName) !== controller) return
                  clearMcpAuthCache()
                  if (!separateProcessMcpOwners) {
                    const freshConfig =
                      await getActiveMcpConfigByName(serverName)
                    if (!freshConfig) return
                    const result = await reconnectMcpServerImpl(
                      serverName,
                      freshConfig,
                    )
                    const prefix = getMcpPrefix(serverName)
                    setAppState(prev => ({
                      ...prev,
                      mcp: {
                        ...prev.mcp,
                        clients: prev.mcp.clients.map(client =>
                          client.name === serverName ? result.client : client,
                        ),
                        tools: [
                          ...reject(prev.mcp.tools, tool =>
                            tool.name?.startsWith(prefix),
                          ),
                          ...result.tools,
                        ],
                        commands: [
                          ...reject(prev.mcp.commands, command =>
                            commandBelongsToServer(command, serverName),
                          ),
                          ...result.commands,
                        ],
                        resources:
                          result.resources && result.resources.length > 0
                            ? {
                                ...prev.mcp.resources,
                                [serverName]: result.resources,
                              }
                            : omit(prev.mcp.resources, serverName),
                      },
                    }))
                    syncHeadlessMcpRuntime(
                      serverName,
                      result.client,
                      result.tools,
                    )
                    return
                  }

                  if (!directAuthorizationOwner) return
                  await runDirectMcpMutation(async () => {
                    if (activeOAuthFlows.get(serverName) !== controller) {
                      return
                    }
                    const target = getDirectOwnedMcpTarget(serverName)
                    const freshConfig =
                      directAuthorizationOwner === 'plugin'
                        ? await getActiveMcpConfigByName(serverName)
                        : target &&
                            target.owner === directAuthorizationOwner
                          ? target.config
                          : null
                    if (
                      !freshConfig ||
                      (freshConfig.type !== 'sse' &&
                        freshConfig.type !== 'http')
                    ) {
                      return
                    }
                    if (
                      !canCommitDirectMcpOAuthGeneration({
                        sameGeneration:
                          activeOAuthFlows.get(serverName) === controller,
                        expectedOwner: directAuthorizationOwner,
                        currentOwner: target?.owner ?? null,
                        authorizedServerKey,
                        currentServerKey: getServerKey(
                          serverName,
                          freshConfig,
                        ),
                        disabled:
                          directControlDisabledMcpNames.has(serverName),
                      })
                    ) {
                      return
                    }
                    const admissionError = directMcpControlAdmissionError(
                      serverName,
                      freshConfig,
                    )
                    if (admissionError) {
                      logForDebugging(
                        `Refusing MCP reconnect after OAuth for "${serverName}": ${admissionError}`,
                        { level: 'warn' },
                      )
                      return
                    }
                    if (
                      target?.owner === 'plugin' &&
                      getServerCacheKey(serverName, target.config) !==
                        getServerCacheKey(serverName, freshConfig)
                    ) {
                      await evictExistingServerCache(
                        serverName,
                        target.config,
                      )
                    }
                    const result = await reconnectMcpServerImpl(
                      serverName,
                      freshConfig,
                    )
                    if (activeOAuthFlows.get(serverName) !== controller) {
                      await evictExistingServerCache(
                        serverName,
                        freshConfig,
                      )
                      return
                    }
                    commitDirectMcpReconnect(serverName, result, {
                      owner: directAuthorizationOwner,
                      config: freshConfig,
                    })
                  })
                })
                .catch(error => {
                  logForDebugging(
                    `MCP OAuth failed for ${serverName}: ${error}`,
                    { level: 'error' },
                  )
                })
                .finally(() => {
                  // Clean up only if this is still the active flow
                  if (activeOAuthFlows.get(serverName) === controller) {
                    activeOAuthFlows.delete(serverName)
                    oauthCallbackSubmitters.delete(serverName)
                    oauthManualCallbackUsed.delete(serverName)
                    oauthAuthPromises.delete(serverName)
                  }
                })
              void fullFlowPromise
            } catch (error) {
              sendControlResponseError(message, errorMessage(error))
            }
          }
        } else if (req.subtype === 'mcp_oauth_callback_url') {
          const { serverName, callbackUrl } = req
          const submit = oauthCallbackSubmitters.get(serverName)
          if (submit) {
            // Validate the callback URL before submitting. The submit
            // callback in auth.ts silently ignores URLs missing a code
            // param, which would leave the auth promise unresolved and
            // block the control message loop until timeout.
            let hasCodeOrError = false
            try {
              const parsed = new URL(callbackUrl)
              hasCodeOrError =
                parsed.searchParams.has('code') ||
                parsed.searchParams.has('error')
            } catch {
              // Invalid URL
            }
            if (!hasCodeOrError) {
              sendControlResponseError(
                message,
                'Invalid callback URL: missing authorization code. Please paste the full redirect URL including the code parameter.',
              )
            } else {
              oauthManualCallbackUsed.add(serverName)
              submit(callbackUrl)
              // Wait for auth (token exchange) to complete before responding.
              // Reconnect is handled by the extension via handleAuthDone →
              // mcp_reconnect (which updates dynamicMcpState for tools).
              const authPromise = oauthAuthPromises.get(serverName)
              if (authPromise) {
                try {
                  await authPromise
                  sendControlResponseSuccess(message)
                } catch (error) {
                  sendControlResponseError(
                    message,
                    error instanceof Error
                      ? error.message
                      : 'OAuth authentication failed',
                  )
                }
              } else {
                sendControlResponseSuccess(message)
              }
            }
          } else {
            sendControlResponseError(
              message,
              `No active OAuth flow for server: ${serverName}`,
            )
          }
        } else if (req.subtype === 'crabcode_authenticate') {
          // Acosmi OAuth over the control channel via IPC to Go SDK.
          // skipBrowser=true: SDK client doesn't open browser — we hand back
          // the URL to the SDK client which controls the browser.
          if (
            routePolicy.interactiveProductSession &&
            isEnvTruthy(process.env.DISABLE_LOGIN_COMMAND)
          ) {
            sendControlResponseError(
              message,
              'Login is disabled by DISABLE_LOGIN_COMMAND',
            )
            continue
          }
          const requestedLoginWithAcosmi = req.loginWithAcosmi
          const forcedLoginMethod = routePolicy.interactiveProductSession
            ? getInitialSettings().forceLoginMethod
            : undefined
          const loginWithAcosmi =
            forcedLoginMethod === 'acosmi'
              ? true
              : forcedLoginMethod === 'console'
                ? false
                : requestedLoginWithAcosmi

          logEvent('tengu_oauth_flow_start', {
            loginWithAcosmi: loginWithAcosmi ?? true,
          })

          // SDK Client.loginWithHandler with skipBrowser to get auth URL
          // without opening the browser. The SDK client controls the browser.
          const scopes =
            (loginWithAcosmi ?? true) ? ['ai', 'skills', 'account'] : ['ai']

          // Start the SDK streaming flow in background. Resolution alone is
          // not a commit signal: a provider may end the stream without a
          // complete event, so keep the installed-token boundary explicit.
          let credentialsCommitted = false
          const flow = (async () => {
            for await (const event of loginStream(scopes, {
              skipBrowser: true,
            })) {
              if (event.type === 'auth_url' && event.url) {
                sendControlResponseSuccess(message, {
                  manualUrl: event.url,
                  automaticUrl: event.url,
                })
              }
              if (event.type === 'complete') {
                const status = await getAuthStatus()
                if (!status?.tokens) {
                  throw new Error(t('native_tui_auth_persistence_failed'))
                }
                const refreshToken = status.tokens.refreshToken ?? null
                const expiresAt = status.tokens.expiresAt ?? null
                if (
                  typeof refreshToken !== 'string' ||
                  refreshToken.trim().length === 0 ||
                  typeof expiresAt !== 'number' ||
                  !Number.isFinite(expiresAt) ||
                  expiresAt <= 0
                ) {
                  throw new Error(t('native_tui_auth_persistence_failed'))
                }
                const storageResult = await installOAuthTokens({
                  accessToken: status.tokens.accessToken,
                  refreshToken,
                  expiresAt,
                  scopes: resolveOAuthCompletionScopes(
                    status.tokens.scopes,
                    scopes,
                  ),
                  clientId: status.tokens.clientId,
                  serverUrl: status.tokens.serverUrl,
                  subscriptionType: null,
                  rateLimitTier: null,
                  membershipActive: null,
                })
                if (!storageResult.success && !storageResult.committed) {
                  throw new Error(t('native_tui_auth_persistence_failed'))
                }
                credentialsCommitted = true
                logEvent('tengu_oauth_success', {
                  loginWithAcosmi: loginWithAcosmi ?? true,
                })
              }
              if (
                event.type === 'error' &&
                event.err_code !== 'browser_open_failed'
              ) {
                sendControlResponseError(message, event.error ?? 'OAuth failed')
              }
            }
          })()

          crabCodeOAuth = {
            flow,
            credentialsCommitted: () => credentialsCommitted,
          }

          void flow.catch(err =>
            logForDebugging(`crabcode_authenticate flow ended: ${err}`, {
              level: 'info',
            }),
          )
        } else if (
          req.subtype === 'crabcode_oauth_callback' ||
          req.subtype === 'crabcode_oauth_wait_for_completion'
        ) {
          if (!crabCodeOAuth) {
            sendControlResponseError(
              message,
              'No active crabcode_authenticate flow',
            )
          } else {
            // SDK handles the callback via its own localhost server.
            // crabcode_oauth_callback is now a no-op (manual code entry removed).
            // crabcode_oauth_wait_for_completion awaits the flow promise.
            const { flow, credentialsCommitted } = crabCodeOAuth
            void (async () => {
              try {
                await flow
              } catch (error) {
                sendControlResponseError(message, errorMessage(error))
                return
              }
              if (!credentialsCommitted()) {
                sendControlResponseError(
                  message,
                  t('native_tui_auth_persistence_failed'),
                )
                return
              }

              const releaseCatalog =
                commandCatalogPublisher?.hold() ?? (() => {})
              try {

                // Token installation is now committed. Discovery and account
                // projection failures must degrade to a closed empty snapshot,
                // not report a false login failure while leaving stale UI and
                // TypeScript command state behind.
                let refreshed
                try {
                  refreshed = await refreshControlAuthCatalog(
                    routePolicy.commandLoader,
                    cwd(),
                    undefined,
                    routePolicy.directQueryEventDelivery,
                  )
                } catch (error) {
                  refreshed = conservativeControlAuthCatalog()
                  logForDebugging(
                    `[direct-tui] login credentials were committed but the auth/catalog refresh degraded safely: ${errorMessage(error)}`,
                    { level: 'warn' },
                  )
                }
                if (!commandCatalogLifecycle.replace(refreshed.commands)) {
                  logForDebugging(
                    '[direct-tui] login credentials were committed after the command catalog lifecycle closed; refusing a stale completion acknowledgement',
                    { level: 'warn' },
                  )
                  return
                }
                try {
                  sendControlResponseSuccess(
                    message,
                    withCurrentControlAuthCommandCatalog(
                      refreshed.response,
                      currentCatalogCommands(),
                      routePolicy.directQueryEventDelivery,
                    ),
                  )
                } catch (error) {
                  logForDebugging(
                    `[direct-tui] login credentials were committed but the completion response could not be queued: ${errorMessage(error)}`,
                    { level: 'warn' },
                  )
                }
              } finally {
                releaseCatalog()
              }
            })()
          }
        } else if (req.subtype === 'mcp_clear_auth') {
          const { serverName } = req
          if (separateProcessMcpOwners) {
            const initialTarget = getDirectOwnedMcpTarget(serverName)
            const inventoryRecord =
              (!initialTarget || initialTarget.owner === 'plugin') &&
              isPluginMcpRuntimeName(serverName)
                ? (await getCrabCodeMcpConfigs()).pluginInventory.find(
                    record => record.runtimeName === serverName,
                  )
                : undefined
            if (isDirectTuiSdkMcpInventoryRecord(inventoryRecord)) {
              sendControlResponseError(
                message,
                DIRECT_TUI_SDK_MCP_UNSUPPORTED_ERROR,
              )
              continue
            }
            const initialConfig =
              initialTarget?.config ?? getMcpConfigByName(serverName)
            if (!initialConfig) {
              sendControlResponseError(
                message,
                `Server not found: ${serverName}`,
              )
              continue
            }
            if (initialConfig.type === 'sdk') {
              sendControlResponseError(
                message,
                DIRECT_TUI_SDK_MCP_UNSUPPORTED_ERROR,
              )
              continue
            }
            if (
              initialConfig.type !== 'sse' &&
              initialConfig.type !== 'http'
            ) {
              sendControlResponseError(
                message,
                `Cannot clear auth for server type "${initialConfig.type}"`,
              )
              continue
            }

            const releaseCatalog = commandCatalogPublisher?.hold() ?? (() => {})
            try {
              const outcome = await runDirectMcpMutation(async () => {
                const target = getDirectOwnedMcpTarget(serverName)
                const config = target?.config
                if (!target || !config) {
                  return {
                    ok: false as const,
                    error: `Server not found: ${serverName}`,
                  }
                }
                if (config.type !== 'sse' && config.type !== 'http') {
                  return {
                    ok: false as const,
                    error: `Cannot clear auth for server type "${config.type}"`,
                  }
                }
                if (target.owner === 'plugin') {
                  const latestInventoryRecord = (
                    await getCrabCodeMcpConfigs()
                  ).pluginInventory.find(
                    record => record.runtimeName === serverName,
                  )
                  if (
                    isDirectTuiSdkMcpInventoryRecord(latestInventoryRecord)
                  ) {
                    return {
                      ok: false as const,
                      error: DIRECT_TUI_SDK_MCP_UNSUPPORTED_ERROR,
                    }
                  }
                }
                await cancelActiveMcpOAuthFlow(serverName)
                const retainedConfig = await clearMcpAuthenticationRuntime(
                  serverName,
                  config,
                  {
                    retainUnpersistedDynamic:
                      target.owner === 'public' || target.owner === 'fixed',
                    resolveFreshConfig: async () => {
                      const currentTarget =
                        getDirectOwnedMcpTarget(serverName)
                      if (currentTarget?.owner !== target.owner) return null
                      if (target.owner !== 'plugin') {
                        return getServerCacheKey(
                          serverName,
                          currentTarget.config,
                        ) === getServerCacheKey(serverName, config)
                          ? currentTarget.config
                          : null
                      }
                      const freshPluginConfig =
                        await getActiveMcpConfigByName(serverName)
                      return freshPluginConfig &&
                        getServerCacheKey(serverName, freshPluginConfig) ===
                          getServerCacheKey(serverName, config)
                        ? freshPluginConfig
                        : null
                    },
                  },
                )
                const needsAuthClient = retainedConfig
                  ? ({
                      name: serverName,
                      type: 'needs-auth' as const,
                      config: retainedConfig,
                    } satisfies MCPServerConnection)
                  : null
                if (needsAuthClient) {
                  const prefix = getMcpPrefix(serverName)
                  if (target.owner === 'public') {
                    dynamicMcpState = {
                      ...dynamicMcpState,
                      configs: {
                        ...dynamicMcpState.configs,
                        [serverName]: retainedConfig,
                      },
                    }
                  } else if (target.owner === 'plugin') {
                    pluginProcessMcpState = {
                      ...pluginProcessMcpState,
                      configs: {
                        ...pluginProcessMcpState.configs,
                        [serverName]: retainedConfig,
                      },
                    }
                  }
                  syncHeadlessMcpRuntime(serverName, needsAuthClient, [])
                  setAppState(prev => ({
                    ...prev,
                    mcp: {
                      ...prev.mcp,
                      clients: upsertConnection(
                        prev.mcp.clients,
                        needsAuthClient,
                      ),
                      tools: reject(prev.mcp.tools, tool =>
                        tool.name?.startsWith(prefix),
                      ),
                      commands: reject(prev.mcp.commands, command =>
                        commandOwnedByMcpServer(command, serverName),
                      ),
                      resources: omit(prev.mcp.resources, serverName),
                    },
                  }))
                } else {
                  clearDirectMcpProjection(serverName)
                  if (target.owner === 'plugin') {
                    const { [serverName]: _removed, ...configs } =
                      pluginProcessMcpState.configs
                    pluginProcessMcpState = {
                      ...pluginProcessMcpState,
                      clients: pluginProcessMcpState.clients.filter(
                        client => client.name !== serverName,
                      ),
                      tools: pluginProcessMcpState.tools.filter(
                        tool =>
                          !tool.name?.startsWith(getMcpPrefix(serverName)),
                      ),
                      configs,
                    }
                  }
                }
                return { ok: true as const }
              })
              if (outcome.ok) sendControlResponseSuccess(message, {})
              else sendControlResponseError(message, outcome.error)
            } finally {
              releaseCatalog()
            }
            continue
          }
          const currentAppState = getAppState()
          const config =
            mcpClients.find(c => c.name === serverName)?.config ??
            sdkClients.find(c => c.name === serverName)?.config ??
            dynamicMcpState.clients.find(c => c.name === serverName)?.config ??
            pluginProcessMcpState.clients.find(c => c.name === serverName)
              ?.config ??
            currentAppState.mcp.clients.find(c => c.name === serverName)
              ?.config ??
            getMcpConfigByName(serverName) ??
            null
          if (!config) {
            sendControlResponseError(message, `Server not found: ${serverName}`)
          } else if (config.type !== 'sse' && config.type !== 'http') {
            sendControlResponseError(
              message,
              `Cannot clear auth for server type "${config.type}"`,
            )
          } else {
            const retainedConfig = await clearMcpAuthenticationRuntime(
              serverName,
              config,
              {
                retainUnpersistedDynamic: Object.prototype.hasOwnProperty.call(
                  dynamicMcpState.configs,
                  serverName,
                ) || startupSessionProcessMcpNames.has(serverName),
              },
            )
            const prefix = getMcpPrefix(serverName)
            const needsAuthClient = retainedConfig
              ? ({
                  name: serverName,
                  type: 'needs-auth' as const,
                  config: retainedConfig,
                } satisfies MCPServerConnection)
              : null
            syncHeadlessMcpRuntime(serverName, needsAuthClient, [])
            setAppState(prev => ({
              ...prev,
              mcp: {
                ...prev.mcp,
                clients: needsAuthClient
                  ? upsertConnection(prev.mcp.clients, needsAuthClient)
                  : prev.mcp.clients.filter(c => c.name !== serverName),
                tools: reject(prev.mcp.tools, t => t.name?.startsWith(prefix)),
                commands: reject(prev.mcp.commands, c =>
                  commandBelongsToServer(c, serverName),
                ),
                resources: omit(prev.mcp.resources, serverName),
              },
            }))
            sendControlResponseSuccess(message, {})
          }
        } else if (message.request.subtype === 'apply_flag_settings') {
          // Snapshot the current model before applying — we need to detect
          // model switches so we can inject breadcrumbs and notify listeners.
          const prevModel = getMainLoopModel()

          // Merge the provided settings into the in-memory flag settings
          const existing = getFlagSettingsInline() ?? {}
          const incoming = message.request.settings
          // Shallow-merge top-level keys; getSettingsForSource handles
          // the deep merge with file-based flag settings via mergeWith.
          // JSON serialization drops `undefined`, so callers use `null`
          // to signal "clear this key". Convert nulls to deletions so
          // SettingsSchema().safeParse() doesn't reject the whole object
          // (z.string().optional() accepts string | undefined, not null).
          const merged = { ...existing, ...incoming }
          for (const key of Object.keys(merged)) {
            if (merged[key as keyof typeof merged] === null) {
              delete merged[key as keyof typeof merged]
            }
          }
          setFlagSettingsInline(merged)
          // Route through notifyChange so fanOut() resets the settings cache
          // before listeners run. The subscriber at :392 calls
          // applySettingsChange for us. Pre-#20625 this was a direct
          // applySettingsChange() call that relied on its own internal reset —
          // now that the reset is centralized in fanOut, a direct call here
          // would read stale cached settings and silently drop the update.
          // Bonus: going through notifyChange also tells the other subscribers
          // (loadPluginHooks, sandbox-adapter) about the change, which the
          // previous direct call skipped.
          settingsChangeDetector.notifyChange('flagSettings')

          // If the incoming settings include a model change, update the
          // override so getMainLoopModel() reflects it. The override has
          // higher priority than the settings cascade in
          // getUserSpecifiedModelSetting(), so without this update,
          // getMainLoopModel() returns the stale override and the model
          // change is silently ignored (matching set_model at :2811).
          if ('model' in incoming) {
            if (incoming.model != null) {
              setMainLoopModelOverride(String(incoming.model))
            } else {
              setMainLoopModelOverride(undefined)
            }
          }

          // If the model changed, inject breadcrumbs so the model sees the
          // mid-conversation switch.
          const newModel = getMainLoopModel()
          if (newModel !== prevModel) {
            activeUserSpecifiedModel = newModel
            const modelArg = incoming.model ? String(incoming.model) : 'default'
            injectModelSwitchBreadcrumbs(modelArg, newModel)
          }

          sendControlResponseSuccess(message)
        } else if (message.request.subtype === 'get_settings') {
          const currentAppState = getAppState()
          const model = getMainLoopModel()
          // modelSupportsEffort gate matches crabcode.ts — applied.effort must
          // mirror what actually goes to the API, not just what's configured.
          const effort = modelSupportsEffort(model)
            ? resolveAppliedEffort(model, currentAppState.effortValue)
            : undefined
          sendControlResponseSuccess(message, {
            ...getSettingsWithSources(),
            applied: {
              model,
              // Numeric effort (ant-only) → null; SDK schema is string-level only.
              effort: typeof effort === 'string' ? effort : null,
            },
          })
        } else if (message.request.subtype === 'stop_task') {
          const { task_id: taskId } = message.request
          try {
            await stopTask(taskId, {
              getAppState,
              setAppState,
            })
            sendControlResponseSuccess(message, {})
          } catch (error) {
            sendControlResponseError(message, errorMessage(error))
          }
        } else if (req.subtype === 'generate_session_title') {
          // Fire-and-forget so the helper call does not block the stdin loop
          // (which would delay processing of subsequent user messages /
          // interrupts for the duration of the API roundtrip).
          const { description, persist } = req
          // Reuse the live controller only if it has not already been aborted
          // (e.g. by interrupt()); an aborted signal would cause queryFastMode to
          // immediately throw APIUserAbortError → {title: null}.
          const titleSignal = (
            abortController && !abortController.signal.aborted
              ? abortController
              : createAbortController()
          ).signal
          void (async () => {
            try {
              const title = await generateSessionTitle(description, titleSignal)
              if (title && persist) {
                try {
                  saveAiGeneratedTitle(getSessionId() as UUID, title)
                } catch (e) {
                  logError(e)
                }
              }
              sendControlResponseSuccess(message, { title })
            } catch (e) {
              // Unreachable in practice — generateSessionTitle wraps its
              // own body and returns null, saveAiGeneratedTitle is wrapped
              // above. Propagate (not swallow) so unexpected failures are
              // visible to the SDK caller (hostComms.ts catches and logs).
              sendControlResponseError(message, errorMessage(e))
            }
          })()
        } else if (req.subtype === 'side_question') {
          // Same fire-and-forget pattern as generate_session_title above —
          // the forked agent's API roundtrip must not block the stdin loop.
          //
          // The snapshot captured by stopHooks (for querySource === 'sdk')
          // holds the exact systemPrompt/userContext/systemContext/messages
          // sent on the last main-thread turn. Reusing them gives a byte-
          // identical prefix → prompt cache hit.
          //
          // Fallback (resume before first turn completes — no snapshot yet):
          // rebuild from scratch. buildSideQuestionFallbackParams mirrors
          // QueryEngine.ts:ask()'s system prompt assembly (including
          // --system-prompt / --append-system-prompt) so the rebuilt prefix
          // matches in the common case. May still miss the cache for
          // coordinator mode or memory-mechanics extras — acceptable, the
          // alternative is the side question failing entirely.
          const { question } = req
          void (async () => {
            try {
              const saved = getLastCacheSafeParams()
              const cacheSafeParams = saved
                ? {
                    ...saved,
                    // If the last turn was interrupted, the snapshot holds an
                    // already-aborted controller; createChildAbortController in
                    // createSubagentContext would propagate it and the fork
                    // would die before sending a request. The controller is
                    // not part of the cache key — swapping in a fresh one is
                    // safe. Same guard as generate_session_title above.
                    toolUseContext: {
                      ...saved.toolUseContext,
                      abortController: createAbortController(),
                    },
                  }
                : await buildSideQuestionFallbackParams({
                    tools: buildAllTools(getAppState()),
                    commands: currentCatalogCommands(),
                    mcpClients: separateProcessMcpOwners
                      ? uniqBy(
                          [
                            ...getAppState().mcp.clients,
                            ...sdkClients,
                            ...dynamicMcpState.clients,
                            ...pluginProcessMcpState.clients,
                          ],
                          'name',
                        )
                      : [
                          ...getAppState().mcp.clients,
                          ...sdkClients,
                          ...dynamicMcpState.clients,
                        ],
                    messages: mutableMessages,
                    readFileState,
                    getAppState,
                    setAppState,
                    customSystemPrompt: options.systemPrompt,
                    appendSystemPrompt: options.appendSystemPrompt,
                    thinkingConfig: options.thinkingConfig,
                    agents: currentAgents,
                  })
              const result = await runSideQuestion({
                question,
                cacheSafeParams,
              })
              sendControlResponseSuccess(message, { response: result.response })
            } catch (e) {
              sendControlResponseError(message, errorMessage(e))
            }
          })()
        } else if (
          (feature('PROACTIVE') || feature('KAIROS')) &&
          (message.request as { subtype: string }).subtype === 'set_proactive'
        ) {
          const req = message.request as unknown as {
            subtype: string
            enabled: boolean
          }
          if (req.enabled) {
            if (!proactiveModule!.isProactiveActive()) {
              proactiveModule!.activateProactive('command')
              scheduleProactiveTick!()
            }
          } else {
            proactiveModule!.deactivateProactive()
          }
          sendControlResponseSuccess(message)
        } else {
          // Unknown control request subtype — send an error response so
          // the caller doesn't hang waiting for a reply that never comes.
          sendControlResponseError(
            message,
            `Unsupported control request subtype: ${(message.request as { subtype: string }).subtype}`,
          )
        }
        continue
      } else if (message.type === 'control_response') {
        // Replay control_response messages when replay mode is enabled
        if (options.replayUserMessages) {
          output.enqueue(message)
        }
        continue
      } else if (message.type === 'keep_alive') {
        // Silently ignore keep-alive messages
        continue
      } else if (message.type === 'update_environment_variables') {
        // Handled in structuredIO.ts, but TypeScript needs the type guard
        continue
      } else if (message.type === 'assistant' || message.type === 'system') {
        // History replay from bridge: inject into mutableMessages as
        // conversation context so the model sees prior turns.
        const internalMsgs = toInternalMessages([message])
        mutableMessages.push(...internalMsgs)
        // Echo assistant messages back so CCR displays them
        if (message.type === 'assistant' && options.replayUserMessages) {
          output.enqueue(message)
        }
        continue
      }
      // After handling control, keep-alive, env-var, assistant, and system
      // messages above, only user messages should remain.
      if (message.type !== 'user') {
        continue
      }

      // First prompt message implicitly initializes if not already done.
      runtimeInitialized = true
      commandCatalogPublisher?.markInitialized()

      // Check for duplicate user message - skip if already processed
      if (message.uuid) {
        const sessionId = getSessionId() as UUID
        const existsInSession = await doesMessageExistInSession(
          sessionId,
          message.uuid as UUID,
        )

        // Check both historical duplicates (from file) and runtime duplicates (this session)
        if (existsInSession || receivedMessageUuids.has(message.uuid as UUID)) {
          logForDebugging(`Skipping duplicate user message: ${message.uuid}`)
          // Send acknowledgment for duplicate message if replay mode is enabled
          if (options.replayUserMessages) {
            logForDebugging(
              `Sending acknowledgment for duplicate user message: ${message.uuid}`,
            )
            output.enqueue({
              type: 'user',
              message: message.message,
              session_id: sessionId,
              parent_tool_use_id: null,
              uuid: message.uuid,
              timestamp: message.timestamp,
              isReplay: true,
            } as SDKUserMessageReplay)
          }
          // Historical dup = transcript already has this turn's output, so it
          // ran but its lifecycle was never closed (interrupted before ack).
          // Runtime dups don't need this — the original enqueue path closes them.
          if (existsInSession) {
            notifyCommandLifecycle(message.uuid as UUID, 'completed')
          }
          // Don't enqueue duplicate messages for execution
          continue
        }

        // Track this UUID to prevent runtime duplicates
        trackReceivedMessageUuid(message.uuid as UUID)
      }

      const resolvedContent = (
        message.message as {
          content?:
            | string
            | import('../../types/api-types.js').ContentBlockParam[]
        }
      ).content as
        | string
        | import('../../types/api-types.js').ContentBlockParam[]
      // Only the native direct route restores the fixed CrabCode composer's
      // leading-`!` mode selection. Ordinary SDK/headless user payloads retain
      // prompt semantics even when their text happens to begin with `!`.
      const routedInput = routePolicy.directQueryEventDelivery
        ? routeDirectTuiInput(resolvedContent)
        : { mode: 'prompt' as const, value: resolvedContent }
      // The fixed composer consumed a standalone `!` as a mode selection and
      // never submitted its now-empty text. The private direct adapter models
      // that no-submit result as null; do not enqueue or start a query turn.
      if (routedInput === null) continue
      enqueue({
        mode: routedInput.mode,
        value: routedInput.value,
        uuid: message.uuid as UUID | undefined,
        priority: message.priority,
      })
      // Increment prompt count for attribution tracking and save snapshot
      // The snapshot persists promptCount so it survives compaction
      if (feature('COMMIT_ATTRIBUTION')) {
        setAppState(prev => ({
          ...prev,
          attribution: incrementPromptCount(prev.attribution, snapshot => {
            void recordAttributionSnapshot(snapshot).catch(error => {
              logForDebugging(`Attribution: Failed to save snapshot: ${error}`)
            })
          }),
        }))
      }
      void run()
    }
    inputClosed = true
    taskListWatcher?.stop()
    if (!running) {
      // If a push-suggestion is in-flight, wait for it to emit before closing
      // the output stream (5 s safety timeout to prevent hanging).
      if (suggestionState.inflightPromise) {
        await Promise.race([suggestionState.inflightPromise, sleep(5000)])
      }
      suggestionState.abortController?.abort()
      suggestionState.abortController = null
      await finalizePendingAsyncHooks()
      commandCatalogLifecycle.close()
      commandCatalogPublisher?.close()
      unsubscribeSkillChanges()
      unsubscribeAppStateCommandCatalog?.()
      unsubscribeSettingsCommandCatalog?.()
      options.closeHeadlessSettings?.()
      unsubscribeAuthStatus?.()
      statusListeners.delete(rateLimitListener)
      output.done()
    }
  })()

  return output
}
