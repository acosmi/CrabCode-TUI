//! SDK-message validation and presentation-only projection.
//!
//! CrabCode's StructuredIO/QueryEngine output remains authoritative.  This
//! reducer accepts each complete JSON envelope before deriving compact,
//! terminal-oriented items. A bounded recent-envelope window is retained for
//! diagnostics; the backend transcript remains the durable authority. A
//! additive presentation variants are retained and surfaced as non-fatal
//! compatibility evidence, while malformed control/integrity contracts remain
//! fail-closed.

use std::collections::{BTreeMap, HashMap, HashSet};

use serde_json::Value;

use crate::generated_renderer_contract::{
    GeneratedEventDisposition, generated_stream_event_disposition,
};
use crate::sdk_runtime::{
    DirectSystemSubtype, EnvelopeClass, RawEnvelope, RequestCorrelation, SystemSubtype,
};

/// Fixed historical query() event classes which still lack an exact
/// projection disposition. The empty denominator is deliberate: attachment
/// members are partitioned below into source-rendered, source-null, and
/// renderer-state-gated sets.
pub const UNPROJECTED_DIRECT_QUERY_EVENT_TYPES: [&str; 0] = [];

/// Raw stream-event members known in the current QueryEngine sources.
///
/// The first eight members are the current `BetaRawMessageStreamEvent` union in
/// `src/types/api-types.ts`. The locked `@acosmi/sdk-ts` 2.15.0
/// `classifySourcesEvent` additionally recognizes a JSON payload whose `type`
/// is `sources`. `chatStreamAdapter` suppresses empty or malformed source
/// payloads and forwards only the classifier's normalized non-empty event.
/// This is a drift baseline, not a runtime allowlist: a future presentation
/// member remains visible and diagnosable without stopping the backend.
#[cfg(test)]
const KNOWN_RAW_STREAM_EVENT_TYPES: [&str; 9] = [
    "message_start",
    "message_delta",
    "message_stop",
    "content_block_start",
    "content_block_delta",
    "content_block_stop",
    "error",
    "ping",
    "sources",
];

/// The open tree declares this discriminator only as an ant-only placeholder.
/// It has no payload contract, so the renderer must not invent fields; it does
/// emit a bounded, visible compatibility row rather than silently dropping it.
pub const DIAGNOSTIC_FALLBACK_DIRECT_PROGRESS_TYPES: [&str; 1] = ["repl_progress"];

/// `HookProgress.hookEvent` is the fixed `HookEvent` union from
/// `entrypoints/sdk/coreSchemas.ts`. SDK hook lifecycle messages deliberately
/// use a free string, so this closed set applies only to historical direct
/// `hook_progress` records.
const DIRECT_HOOK_EVENTS: [&str; 27] = [
    "PreToolUse",
    "PostToolUse",
    "PostToolUseFailure",
    "Notification",
    "UserPromptSubmit",
    "SessionStart",
    "SessionEnd",
    "Stop",
    "StopFailure",
    "SubagentStart",
    "SubagentStop",
    "PreCompact",
    "PostCompact",
    "PermissionRequest",
    "PermissionDenied",
    "Setup",
    "TeammateIdle",
    "TaskCreated",
    "TaskCompleted",
    "Elicitation",
    "ElicitationResult",
    "ConfigChange",
    "WorktreeCreate",
    "WorktreeRemove",
    "InstructionsLoaded",
    "CwdChanged",
    "FileChanged",
];

/// Attachment members which the fixed historical
/// `nullRenderingAttachments.ts` contract removes before both rendering and
/// the 200-message render count. Keeping the exact closed set here prevents a
/// future attachment from becoming silently invisible.
pub const NULL_RENDERING_DIRECT_ATTACHMENT_TYPES: [&str; 33] = [
    "hook_success",
    "hook_additional_context",
    "hook_cancelled",
    "command_permissions",
    "agent_mention",
    "budget_usd",
    "critical_system_reminder",
    "edited_image_file",
    "edited_text_file",
    "opened_file_in_ide",
    "output_style",
    "plan_mode",
    "plan_mode_exit",
    "plan_mode_reentry",
    "structured_output",
    "team_context",
    "todo_reminder",
    "context_efficiency",
    "deferred_tools_delta",
    "mcp_instructions_delta",
    "companion_intro",
    "token_usage",
    "ultrathink_effort",
    "max_turns_reached",
    "task_reminder",
    "auto_mode",
    "auto_mode_exit",
    "output_token_usage",
    "verify_plan_reminder",
    "current_session_memory",
    "compaction_reminder",
    "date_change",
    "bagel_console",
];

/// Attachment members whose fixed historical renderer has a payload-derived
/// disposition. Individual members can still render `null` for a
/// source-defined payload state (for example an initial skill listing).
pub const PROJECTED_DIRECT_ATTACHMENT_TYPES: [&str; 24] = [
    "file",
    "compact_file_reference",
    "pdf_reference",
    "already_read_file",
    "directory",
    "selected_lines_in_ide",
    "nested_memory",
    "relevant_memories",
    "dynamic_skill",
    "skill_listing",
    "queued_command",
    "diagnostics",
    "plan_file_reference",
    "mcp_resource",
    "task_status",
    "hook_blocking_error",
    "hook_non_blocking_error",
    "hook_error_during_execution",
    "hook_stopped_continuation",
    "hook_system_message",
    "hook_permission_decision",
    "invoked_skills",
    "teammate_shutdown_batch",
    "agent_listing_delta",
];

/// Attachment members whose visibility depends on state outside the direct
/// envelope. They remain losslessly journaled until the renderer supplies the
/// corresponding fixed runtime gate; projecting them unconditionally would
/// guess.
pub const RENDERER_GATED_DIRECT_ATTACHMENT_TYPES: [&str; 3] =
    ["skill_discovery", "async_hook_response", "teammate_mailbox"];

// Parsed JSON and allocator metadata cost more than the encoded NDJSON frame.
// Charging a fixed amount per frame as well as its encoded length bounds both
// many-small-frame and few-large-frame diagnostic windows. A single complete
// envelope is always retained even if a test or future transport config makes
// the window smaller than that envelope. Exceeding this diagnostic budget must
// never terminate an otherwise valid backend session.
const MAX_RETAINED_RAW_CHARGE_BYTES: usize = 128 * 1024 * 1024;
const RAW_ENVELOPE_ALLOCATION_CHARGE_BYTES: usize = 1024;
const MAX_COMPATIBILITY_DIAGNOSTICS: usize = 4096;

// Exact existing producer limits from `src/types/toolArtifact.ts`. These are
// renderer-private validation limits over an existing wire member; they do not
// add a backend field or a second artifact protocol.
const MAX_TOOL_ARTIFACTS_PER_RESULT: usize = 16;
const MAX_TOTAL_TOOL_ARTIFACT_BYTES_PER_RESULT: u64 = 512 * 1024 * 1024;
const MAX_TOOL_ARTIFACT_IMAGE_BYTES: u64 = 25 * 1024 * 1024;
const MAX_TOOL_ARTIFACT_VIDEO_BYTES: u64 = 500 * 1024 * 1024;
const MAX_TOOL_ARTIFACT_AUDIO_BYTES: u64 = 250 * 1024 * 1024;
const MAX_TOOL_ARTIFACT_DOCUMENT_BYTES: u64 = 100 * 1024 * 1024;
const MAX_TOOL_ARTIFACT_ARCHIVE_BYTES: u64 = 500 * 1024 * 1024;
const MAX_TOOL_ARTIFACT_OTHER_BYTES: u64 = 100 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProjectedKind {
    User,
    Assistant,
    Thinking,
    ToolUse,
    ToolResult,
    TerminalOutput,
    System,
    Progress,
    Warning,
    Error,
}

/// Exact assistant content-block discriminator retained for renderer dispatch.
///
/// These variants come from CrabCode's local API wire types plus the
/// additional result variants already accepted by this projection. An
/// unrecognized wire value never maps to this enum: projection fails closed
/// while retaining the raw envelope instead.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AssistantBlockType {
    Text,
    Thinking,
    RedactedThinking,
    ToolUse,
    ServerToolUse,
    McpToolUse,
    WebSearchToolResult,
    WebFetchToolResult,
    CodeExecutionToolResult,
    BashCodeExecutionToolResult,
    TextEditorCodeExecutionToolResult,
    ToolSearchToolResult,
    McpToolResult,
    ContainerUpload,
    ConnectorText,
    AdvisorToolResult,
    Compaction,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SystemLevel {
    Info,
    Warning,
    Error,
    Suggestion,
}

/// SDK system envelopes use the validated runtime enum. Historical system
/// records are not independent wire envelopes, so their exact legacy
/// discriminator is retained separately instead of being coerced into an SDK
/// subtype.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProjectedSystemSubtype {
    Sdk(SystemSubtype),
    Historical(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SystemPresentation {
    pub subtype: ProjectedSystemSubtype,
    pub level: Option<SystemLevel>,
    /// Present only for the fixed historical direct-query `system` union.
    /// SDK system envelopes have their own validated lifecycle state and
    /// therefore leave this unset.
    pub direct: Option<DirectSystemPresentation>,
}

/// Exact identity retained by the fixed historical renderer.
///
/// `timestamp` and `isMeta` remain validated in the producer envelope and in
/// the raw diagnostic journal, but the fixed system/attachment render paths do
/// not consume them. Duplicating them here would incorrectly turn producer
/// schema into renderer state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DirectMessageIdentity {
    pub uuid: String,
}

/// Renderer-consumed identity and labels from one fixed direct-query
/// assistant message.
///
/// A normalized message can produce multiple [`ProjectedItem`] rows. Each row
/// retains this complete source identity instead of reconstructing it from the
/// row key. SDK-mode assistant envelopes deliberately leave this presentation
/// unset because their public lifecycle is a different contract.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DirectAssistantPresentation {
    pub identity: DirectMessageIdentity,
    pub timestamp: String,
    /// Optional request identity consumed by the fixed `/feedback` reporter.
    /// This remains renderer presentation state; it does not create or change
    /// a backend request identifier.
    pub request_id: Option<String>,
    pub is_api_error_message: Option<bool>,
    pub advisor_model: Option<String>,
    pub message_id: String,
    pub model: String,
    /// Exact token counters consumed by the fixed ExitPlanMode permission
    /// surface. Older/reduced fixtures can omit the entire usage object; when
    /// it is present, every consumer field is validated and retained.
    pub usage: Option<DirectAssistantUsage>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DirectAssistantUsage {
    pub input_tokens: serde_json::Number,
    pub cache_creation_input_tokens: Option<serde_json::Number>,
    pub cache_read_input_tokens: Option<serde_json::Number>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DirectMessageOriginKind {
    Human,
    TaskNotification,
    Coordinator,
    Channel,
    AutoAccept,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DirectCompactDirection {
    Leading,
    Trailing,
    From,
    UpTo,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DirectCompactSummaryPresentation {
    pub messages_summarized: u64,
    pub user_context: Option<String>,
    pub direction: Option<DirectCompactDirection>,
}

/// Closed request-content discriminator used by the fixed direct TUI.
///
/// Some variants are deliberately transcript-silent in the historical Ink
/// component, but retaining their discriminator prevents the Rust renderer
/// from inferring a branch from [`ProjectedKind`] or fallback prose.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DirectUserBlockType {
    Text,
    Image,
    Document,
    Thinking,
    RedactedThinking,
    ToolUse,
    ToolResult,
    ServerToolUse,
    McpToolUse,
    WebSearchToolResult,
    WebFetchToolResult,
    CodeExecutionToolResult,
    BashCodeExecutionToolResult,
    TextEditorCodeExecutionToolResult,
    ToolSearchToolResult,
    McpToolResult,
    ContainerUpload,
    ConnectorText,
    AdvisorToolResult,
    Compaction,
}

/// Renderer-consumed fields from one normalized direct-query user block.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DirectUserPresentation {
    pub identity: DirectMessageIdentity,
    pub timestamp: String,
    /// These producer members are `?: true`; `None` and `Some(true)` remain
    /// distinct so exact source presence is not collapsed into a display bool.
    pub is_meta: Option<bool>,
    pub is_visible_in_transcript_only: Option<bool>,
    pub is_compact_summary: Option<bool>,
    pub source_tool_use_id: Option<String>,
    pub origin: Option<DirectMessageOriginKind>,
    pub compact_summary: Option<DirectCompactSummaryPresentation>,
    pub plan_content: Option<String>,
    /// Lossless, tool-schema-dependent result supplied on the direct user
    /// envelope. The fixed renderer validates this against the selected
    /// tool's output schema; duplicating every plugin schema in Rust would
    /// widen backend ownership rather than improve type safety.
    pub tool_use_result: Option<Value>,
    pub block_type: DirectUserBlockType,
    /// Exact producer-supplied ID for this image block. This stays `None` when
    /// the historical renderer uses its ordinal fallback.
    pub image_paste_id: Option<u64>,
    /// Exact historical renderer effect (`imagePasteIds[position] ??
    /// position + 1`) retained separately from the optional producer field.
    pub render_image_id: Option<u64>,
}

/// Outer identity retained for every fixed direct progress envelope.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DirectProgressIdentity {
    pub uuid: String,
    pub tool_use_id: String,
    pub parent_tool_use_id: String,
    pub progress_type: String,
    pub raw_sequence: u64,
}

/// Exact hook-progress entry consumed by the fixed stop-hook spinner.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DirectHookProgressEntry {
    pub identity: DirectProgressIdentity,
    pub hook_event: String,
    pub hook_name: String,
    pub command: String,
    pub status_message: Option<String>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum DirectStreamActivityPhase {
    #[default]
    Idle,
    Requesting,
    Responding,
    Thinking,
    ToolInput,
    ToolUse,
}

/// Durable renderer activity state for the process-private direct stream.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DirectStreamActivityState {
    pub phase: DirectStreamActivityPhase,
    pub ttft_ms: Option<serde_json::Number>,
    pub raw_sequence: Option<u64>,
    /// Monotonic model-request identity. QueryEngine emits a new
    /// `stream_request_start` for each inference loop inside a user turn, so
    /// this advances after tools without resetting the enclosing turn timer.
    pub turn_generation: u64,
    /// Raw boundary for the current model request. Unlike `raw_sequence`, this
    /// remains stable while subsequent stream frames advance.
    pub request_started_sequence: Option<u64>,
}

/// Non-fatal compatibility evidence retained by the projection.
///
/// These records are deliberately separate from safety/control failures. A
/// provider replay, a source-index reuse, or an additive presentation event
/// must remain observable without stopping CrabCode's backend runtime.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProjectionCompatibilityKind {
    UnknownPresentation,
    MalformedPresentation,
    StreamReplay,
    StreamIndexReuse,
    StreamOverlap,
    OrphanStreamEvent,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectionCompatibilityDiagnostic {
    pub sequence: u64,
    pub kind: ProjectionCompatibilityKind,
    pub message_id: Option<String>,
    pub source_index: Option<u64>,
    pub generation: Option<u64>,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DirectDiscoveredSkill {
    pub name: String,
    pub short_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DirectTeammateMailboxMessage {
    pub text: String,
    pub from: String,
    pub color: Option<String>,
    pub summary: Option<String>,
}

/// Payloads whose visibility depends on fixed renderer state that is not part
/// of the direct event. They are retained outside [`Projection::items`] so a
/// missing feature/verbose/swarms gate can never make them unconditionally
/// visible.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DirectRendererGatedAttachmentData {
    SkillDiscovery {
        skills: Vec<DirectDiscoveredSkill>,
    },
    AsyncHookResponse {
        hook_event: String,
    },
    TeammateMailbox {
        messages: Vec<DirectTeammateMailboxMessage>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DirectRendererGatedAttachment {
    pub identity: DirectMessageIdentity,
    pub raw_sequence: u64,
    pub data: DirectRendererGatedAttachmentData,
}

/// Stable deletion identity/effect for a fixed direct tombstone.
///
/// JavaScript object identity cannot survive NDJSON serialization. The fixed
/// producer assigns every assistant message a UUID with `randomUUID()`, and
/// the fixed persistent deletion path also deletes by that UUID. The Rust
/// reducer therefore uses the same declared UUID identity for its local row
/// deletion and records the effect explicitly.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DirectTombstoneDeleteEffect {
    pub target_uuid: String,
    pub target_message_id: String,
    pub removed_item_count: usize,
    pub raw_sequence: u64,
}

/// Monotonic renderer mutation emitted whenever the canonical projection
/// explicitly retires a row.
///
/// The live Grok lifecycle consumes this log instead of inferring deletion
/// from absence in a later full transcript snapshot. That distinction keeps
/// tombstones/hook completion authoritative without allowing a presentation
/// snapshot to delete arbitrary native scrollback entries.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectionItemRemoval {
    pub id: u64,
    pub key: String,
    pub raw_sequence: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DirectStopHookInfo {
    /// The fixed producer writes `hookName`. Some generated historical UI
    /// helper code reads the nonexistent aliases `command`/`promptText`; those
    /// aliases are not invented here.
    pub hook_name: String,
    pub duration_ms: serde_json::Number,
}

/// The subset of a serialized historical `APIError` that its fixed formatter
/// actually consumes. Arbitrary response-body members and headers are not
/// copied into renderer state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DirectApiErrorPresentation {
    pub message: Option<String>,
    pub status: Option<serde_json::Number>,
    pub nested_message: Option<String>,
    pub deeply_nested_message: Option<String>,
    /// First serialized cause-chain `code`, following the fixed formatter's
    /// maximum depth of five.
    pub connection_code: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DirectSystemData {
    Informational {
        content: String,
        tool_use_id: Option<String>,
    },
    PermissionRetry {
        commands: Vec<String>,
    },
    ScheduledTaskFire {
        content: String,
    },
    StopHookSummary {
        hook_count: serde_json::Number,
        hook_infos: Vec<DirectStopHookInfo>,
        hook_errors: Vec<String>,
        prevented_continuation: bool,
        stop_reason: Option<String>,
        has_output: bool,
        tool_use_id: Option<String>,
        hook_label: Option<String>,
        total_duration_ms: Option<serde_json::Number>,
    },
    TurnDuration {
        duration_ms: serde_json::Number,
        budget_tokens: Option<serde_json::Number>,
        budget_limit: Option<serde_json::Number>,
        budget_nudges: Option<serde_json::Number>,
    },
    AwaySummary {
        content: String,
    },
    MemorySaved {
        written_paths: Vec<String>,
        team_count: Option<serde_json::Number>,
    },
    AgentsKilled,
    ApiMetrics,
    LocalCommand {
        content: String,
    },
    ApiError {
        error: DirectApiErrorPresentation,
        retry_in_ms: serde_json::Number,
        retry_attempt: serde_json::Number,
        max_retries: serde_json::Number,
    },
    CompactBoundary,
    MicrocompactBoundary,
    CommandInput {
        content: String,
    },
    Thinking,
    FileSnapshot {
        /// The fixed SystemTextMessage renderer consumes only `content` and
        /// `level`. `snapshotFiles` remains in the bounded raw diagnostic
        /// envelope and is intentionally not duplicated into render state.
        content: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DirectSystemPresentation {
    pub identity: DirectMessageIdentity,
    pub data: DirectSystemData,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ThinkingKind {
    Thinking,
    Redacted,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ThinkingPresentation {
    pub kind: ThinkingKind,
    /// Exact `thinking` or redacted `data` field, not text reconstructed from
    /// the display title.
    pub content: String,
    /// Present on completed ordinary thinking blocks when supplied by the
    /// backend. Redacted blocks have no signature field in the local schema.
    pub signature: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolPresentation {
    /// Exact tool name when the use frame supplied it, or when a result could
    /// be correlated with a preceding use frame.
    pub name: Option<String>,
    /// Exact structured `input` value from a completed or start block.
    pub input: Option<Value>,
    /// Exact streamed `partial_json` bytes accumulated before the final block.
    /// This is deliberately not parsed or repaired.
    pub partial_input_json: Option<String>,
    /// Renderer-normalized live output associated with the owning tool use.
    /// This is populated only by the canonical lifecycle coalescer; it never
    /// replaces the exact backend result field below.
    pub lifecycle_output: Option<String>,
    /// Exact result `content`/`result` field. No display-string round trip is
    /// used, so nested image/text blocks remain available to the renderer.
    pub result: Option<Value>,
    /// Exact optional `is_error` flag. Absence remains distinct from `false`.
    pub is_error: Option<bool>,
}

/// Renderer-safe projection of an Anthropic-compatible in-stream error
/// frame. The producer permits every detail field to be absent, so the
/// adapter retains their presence independently and supplies only a local
/// fallback message for the visible terminal row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StreamErrorPresentation {
    pub error_type: Option<String>,
    pub error_code: Option<String>,
    pub message: String,
}

/// Renderer data for the fixed historical direct-mode progress union.
///
/// This is private presentation state, not a backend/public protocol. It
/// retains the fields that the old Ink components actually branch on so the
/// Rust renderer never has to reverse-engineer display state from fallback
/// prose.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DirectProgressPresentation {
    Shell {
        progress_type: String,
        /// Exact last producer slice used by the fixed compact renderer.
        output: String,
        elapsed_time_seconds: serde_json::Number,
        total_lines: serde_json::Number,
        total_bytes: Option<serde_json::Number>,
        timeout_ms: Option<serde_json::Number>,
        task_id: Option<String>,
    },
    Nested {
        progress_type: String,
        parent_tool_use_id: String,
        progress_tool_use_id: String,
        prompt: String,
        agent_id: String,
        message_kind: DirectNestedMessageKind,
        /// Exact counters read by the fixed AgentTool compact progress row.
        ///
        /// Older stored/reduced progress fixtures may omit `message.usage`.
        /// Presence and absence remain distinct; no counter is inferred from
        /// transcript text or from a task notification.
        usage: Option<DirectNestedAssistantUsage>,
    },
    Mcp {
        status: String,
        server_name: String,
        tool_name: String,
        progress: Option<serde_json::Number>,
        total: Option<serde_json::Number>,
        elapsed_time_ms: Option<serde_json::Number>,
        progress_message: Option<String>,
        percentage: Option<u8>,
    },
    SearchQuery {
        query: String,
    },
    SearchResults {
        query: String,
        result_count: u64,
    },
    WaitingForTask {
        task_description: String,
        task_type: String,
    },
    Hook {
        hook_event: String,
        in_progress_count: usize,
        resolved_count: usize,
    },
    Compact {
        phase: DirectCompactProgressPhase,
        hook_type: Option<DirectCompactHookType>,
    },
    Workflow {
        /// Stable workflow-task identity. Unlike `toolUseID`, this remains
        /// constant across every progress emission for one workflow run.
        task_id: String,
        workflow: String,
        phase: Option<String>,
        phase_index: i64,
        message: String,
        agents_started: u32,
        agents_completed: u32,
        phases: Vec<DirectWorkflowPhase>,
        status: DirectWorkflowStatus,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DirectCompactProgressPhase {
    HooksStart,
    CompactStart,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DirectCompactHookType {
    PreCompact,
    PostCompact,
    SessionStart,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DirectWorkflowPhase {
    pub index: i64,
    pub title: String,
    pub state: DirectWorkflowPhaseState,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DirectWorkflowPhaseState {
    Pending,
    Active,
    Done,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DirectWorkflowStatus {
    Running,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DirectNestedAssistantUsage {
    pub input_tokens: serde_json::Number,
    pub output_tokens: serde_json::Number,
    pub cache_creation_input_tokens: Option<serde_json::Number>,
    pub cache_read_input_tokens: Option<serde_json::Number>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DirectNestedMessageKind {
    User,
    Assistant,
}

/// Fixed historical HookProgress lookup state exposed only to this crate's
/// renderer.
///
/// The historical direct TUI keys both started and resolved hook counts by
/// the target tool-use id plus hook event. In particular, PreToolUse and
/// PostToolUse rows are absent from the live viewport but their retained
/// started count is rendered as a static transcript summary. This snapshot is
/// therefore derived from reducer-owned state, never by replaying the bounded
/// raw-envelope diagnostic window or by looking for a transient projected
/// item.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct DirectHookProgressPresentation {
    pub(crate) tool_use_id: String,
    pub(crate) hook_event: String,
    pub(crate) in_progress_count: usize,
    pub(crate) resolved_count: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DirectFileAttachmentContent {
    Notebook { cell_count: usize },
    Unchanged,
    Text { line_count: u64, truncated: bool },
    Binary { original_size: serde_json::Number },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DirectRelevantMemory {
    pub path: String,
    pub content: String,
    pub mtime_ms: serde_json::Number,
    pub header: Option<String>,
    pub limit: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DirectDiagnosticSeverity {
    Error,
    Warning,
    Info,
    Hint,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DirectDiagnostic {
    pub message: String,
    pub severity: DirectDiagnosticSeverity,
    pub start_line: serde_json::Number,
    pub start_character: serde_json::Number,
    pub code: Option<String>,
    pub source: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DirectDiagnosticFile {
    pub uri: String,
    pub diagnostics: Vec<DirectDiagnostic>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DirectHookPermissionDecision {
    Allow,
    Deny,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DirectTaskStatus {
    Pending,
    Running,
    Completed,
    Failed,
    Killed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DirectTaskType {
    LocalBash,
    LocalAgent,
    RemoteAgent,
    InProcessTeammate,
    LocalWorkflow,
    MonitorMcp,
    Dream,
}

/// Renderer-complete projection of the 24 fixed payload-rendered attachment
/// variants. Large backend-only payloads (file bytes, MCP resource bodies,
/// skill source) are deliberately not copied into renderer state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DirectAttachmentData {
    Directory {
        display_path: String,
    },
    File {
        display_path: String,
        content: DirectFileAttachmentContent,
    },
    CompactFileReference {
        display_path: String,
    },
    PdfReference {
        display_path: String,
        page_count: u64,
    },
    SelectedLines {
        ide_name: String,
        line_start: u64,
        line_end: u64,
        display_path: String,
    },
    NestedMemory {
        display_path: String,
    },
    RelevantMemories {
        memories: Vec<DirectRelevantMemory>,
    },
    DynamicSkill {
        skill_names: Vec<String>,
        display_path: String,
    },
    SkillListing {
        skill_count: u64,
        is_initial: bool,
    },
    AgentListingDelta {
        added_types: Vec<String>,
        is_initial: bool,
    },
    QueuedCommand {
        text: String,
        image_paste_ids: Vec<u64>,
        command_mode: Option<String>,
        is_meta: Option<bool>,
        origin: Option<DirectMessageOriginKind>,
    },
    PlanFileReference {
        plan_file_path: String,
    },
    InvokedSkills {
        skill_names: Vec<String>,
    },
    Diagnostics {
        files: Vec<DirectDiagnosticFile>,
    },
    McpResource {
        name: String,
        server: String,
        uri: String,
    },
    HookBlockingError {
        hook_name: String,
        tool_use_id: String,
        hook_event: String,
        blocking_error: String,
    },
    HookNonBlockingError {
        hook_name: String,
        tool_use_id: String,
        hook_event: String,
    },
    HookErrorDuringExecution {
        hook_name: String,
        tool_use_id: String,
        hook_event: String,
    },
    HookStoppedContinuation {
        hook_name: String,
        tool_use_id: String,
        hook_event: String,
        message: String,
    },
    HookSystemMessage {
        hook_name: String,
        tool_use_id: String,
        hook_event: String,
        content: String,
    },
    HookPermissionDecision {
        tool_use_id: String,
        hook_event: String,
        decision: DirectHookPermissionDecision,
    },
    TaskStatus {
        task_id: String,
        task_type: DirectTaskType,
        status: DirectTaskStatus,
        description: String,
    },
    TeammateShutdownBatch {
        count: u64,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DirectAttachmentPresentation {
    pub identity: DirectMessageIdentity,
    pub data: DirectAttachmentData,
}

/// Advisor-specific renderer data derived from the exact CrabCode wire
/// discriminators. The renderer must dispatch on this enum rather than infer
/// Advisor semantics from a generic tool title.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AdvisorPresentation {
    Invocation {
        /// Exact object-valued `input` supplied by the `server_tool_use`
        /// block. Empty objects remain distinguishable from a missing field.
        input: Value,
        state: AdvisorInvocationState,
    },
    Result(AdvisorResultPresentation),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AdvisorInvocationState {
    InProgress,
    Succeeded,
    Failed,
}

/// Safe, display-complete Advisor result. Redacted ciphertext is validated in
/// the raw envelope but deliberately never copied into renderer-owned state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AdvisorResultPresentation {
    Feedback { text: String },
    Redacted,
    Error { error_code: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImageMediaType {
    Jpeg,
    Png,
    Gif,
    Webp,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ImageProvenance {
    Base64 {
        media_type: ImageMediaType,
        encoded_len: usize,
    },
    Url {
        url: String,
    },
    File {
        file_id: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProjectedToolArtifactKind {
    Image,
    Video,
    Audio,
    Document,
    Archive,
    Other,
}

impl ProjectedToolArtifactKind {
    fn byte_limit(self) -> u64 {
        match self {
            Self::Image => MAX_TOOL_ARTIFACT_IMAGE_BYTES,
            Self::Video => MAX_TOOL_ARTIFACT_VIDEO_BYTES,
            Self::Audio => MAX_TOOL_ARTIFACT_AUDIO_BYTES,
            Self::Document => MAX_TOOL_ARTIFACT_DOCUMENT_BYTES,
            Self::Archive => MAX_TOOL_ARTIFACT_ARCHIVE_BYTES,
            Self::Other => MAX_TOOL_ARTIFACT_OTHER_BYTES,
        }
    }
}

/// Existing `ToolArtifactLocation` represented without an unbounded JSON
/// value. `LocalHandle` is retained only as source data: a pure TUI renderer
/// validates the existing backend shape but does not dereference non-local
/// handles.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProjectedToolArtifactLocation {
    RuntimePath {
        path: String,
    },
    ExternalUri {
        uri: String,
    },
    LocalHandle {
        handle: String,
        account_epoch_ms: Option<u64>,
        created_at_ms: u64,
        expires_at_ms: u64,
        capture_id: String,
        authorization: String,
        audit_status: String,
        audit_ref: Option<String>,
        owner_thread_id: Option<String>,
        owner_turn_id: Option<String>,
    },
}

/// Typed renderer provenance copied from the existing `tool_artifacts` member.
///
/// This state is owned by [`Projection`] and therefore survives diagnostic raw
/// journal eviction. Payload bytes are never copied here; only the producer's
/// bounded metadata and location are retained.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectedToolArtifact {
    pub id: String,
    pub kind: ProjectedToolArtifactKind,
    pub mime_type: String,
    pub display_name: String,
    pub location: ProjectedToolArtifactLocation,
    pub byte_size: Option<u64>,
    pub sha256: Option<String>,
    pub producer_tool_use_id: String,
    pub raw_sequences: Vec<u64>,
}

impl ProjectedToolArtifact {
    fn same_payload(&self, other: &Self) -> bool {
        self.id == other.id
            && self.kind == other.kind
            && self.mime_type == other.mime_type
            && self.display_name == other.display_name
            && self.location == other.location
            && self.byte_size == other.byte_size
            && self.sha256 == other.sha256
            && self.producer_tool_use_id == other.producer_tool_use_id
    }
}

/// Renderer-owned typed data composed independently from the compact fallback
/// title/text. Multiple dimensions may apply to one item (for example an
/// assistant tool-use block has both `assistant_block` and `tool`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ProjectedPresentation {
    /// A producer-classified arbitrary-text system row whose exact consumer
    /// is the fixed generic System block. This is never inferred from title
    /// or text.
    pub plain_system: bool,
    pub assistant_block: Option<AssistantBlockType>,
    pub direct_assistant: Option<DirectAssistantPresentation>,
    pub direct_user: Option<DirectUserPresentation>,
    pub direct_progress_identity: Option<DirectProgressIdentity>,
    pub system: Option<SystemPresentation>,
    pub tool: Option<ToolPresentation>,
    pub thinking: Option<ThinkingPresentation>,
    pub image: Option<ImageProvenance>,
    pub advisor: Option<AdvisorPresentation>,
    pub direct_progress: Option<DirectProgressPresentation>,
    pub direct_attachment: Option<DirectAttachmentPresentation>,
    pub stream_error: Option<StreamErrorPresentation>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectedItem {
    /// Stable within one child-runtime session. Streaming and final assistant
    /// frames deliberately resolve to the same key where the SDK message id is
    /// available.
    pub key: String,
    pub kind: ProjectedKind,
    pub title: String,
    /// This is a render projection only. Its recent complete source may remain
    /// in [`Projection::raw_envelopes`], while CrabCode's transcript remains
    /// the durable authority.
    pub text: String,
    pub streaming: bool,
    pub raw_sequences: Vec<u64>,
    pub tool_use_id: Option<String>,
    pub presentation: ProjectedPresentation,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PendingControl {
    pub request_id: String,
    pub subtype: String,
    pub request: Value,
    pub raw_sequence: u64,
}

#[derive(Debug, Clone, PartialEq)]
pub enum ProjectionEffect {
    None,
    /// A fully validated SDK envelope changed the authoritative session id.
    ///
    /// This is renderer-private lifecycle state, not a wire event. The
    /// replacement projection already contains the triggering envelope, while
    /// the nested effect preserves that envelope's ordinary disposition.
    SessionTransition {
        previous_session_id: String,
        session_id: String,
        effect: Box<ProjectionEffect>,
    },
    Initialized {
        session_id: Option<String>,
        cwd: Option<String>,
        model: Option<String>,
        permission_mode: Option<String>,
    },
    SessionStateChanged(String),
    ReverseControlOpened(PendingControl),
    ReverseControlCancelled {
        request_id: String,
    },
    ControlResponse {
        request_id: String,
        request_subtype: Option<String>,
        success: bool,
        payload: Value,
        raw_sequence: u64,
    },
    PromptSuggestion(String),
    /// Fixed historical `stream_request_start` presentation signal. It has no
    /// backend-semantic payload; the TUI uses it only to enter the requesting
    /// activity state until ordinary stream/message events advance it.
    StreamRequestStarted,
    TurnCompleted {
        subtype: String,
        is_error: bool,
        raw_sequence: u64,
    },
    /// A presentation-only or forward-compatible stream event could not be
    /// projected. The raw envelope and bounded metadata have been retained;
    /// the current turn and runtime remain authoritative and active.
    CompatibilityFault {
        sequence: u64,
        event_type: String,
        code: String,
    },
    /// A known message lifecycle can no longer be projected reliably. The
    /// host must interrupt only the active turn and keep the runtime alive.
    AbortTurn {
        sequence: u64,
        code: String,
        reason: String,
    },
    /// The raw value has already been journaled when this is returned. The
    /// host must stop the child and show an upgrade diagnostic.
    FailClosed {
        sequence: u64,
        reason: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct StreamBlockSlot {
    context: StreamContext,
    message_id: String,
    index: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct StreamBlockKey {
    slot: StreamBlockSlot,
    generation: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
enum StreamContext {
    /// Fixed historical `query()` events are process-private and carry no
    /// SDK session/parent fields. One direct runtime owns exactly one active
    /// response stream.
    DirectQuery,
    /// Public SDK partial-assistant envelopes carry both fields together.
    Sdk {
        session_id: String,
        parent_tool_use_id: Option<String>,
    },
}

#[derive(Debug, Clone)]
struct StreamBlockState {
    key: StreamBlockKey,
    block_type: String,
    item_key: String,
    start_payload: Value,
    started_sequence: u64,
    reconciled: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct DirectHookKey {
    parent_tool_use_id: String,
    hook_event: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct DirectUserEnvelopeFields {
    identity: DirectMessageIdentity,
    timestamp: String,
    is_meta: Option<bool>,
    is_visible_in_transcript_only: Option<bool>,
    is_compact_summary: Option<bool>,
    source_tool_use_id: Option<String>,
    origin: Option<DirectMessageOriginKind>,
    compact_summary: Option<DirectCompactSummaryPresentation>,
    plan_content: Option<String>,
    tool_use_result: Option<Value>,
    image_paste_ids: Vec<u64>,
}

impl DirectUserEnvelopeFields {
    fn for_block(
        &self,
        block_type: DirectUserBlockType,
        image_position: Option<usize>,
    ) -> DirectUserPresentation {
        let (image_paste_id, render_image_id) = image_position.map_or((None, None), |position| {
            let exact = self.image_paste_ids.get(position).copied();
            let fallback = u64::try_from(position)
                .ok()
                .and_then(|position| position.checked_add(1));
            (exact, exact.or(fallback))
        });
        DirectUserPresentation {
            identity: self.identity.clone(),
            timestamp: self.timestamp.clone(),
            is_meta: self.is_meta,
            is_visible_in_transcript_only: self.is_visible_in_transcript_only,
            is_compact_summary: self.is_compact_summary,
            source_tool_use_id: self.source_tool_use_id.clone(),
            origin: self.origin,
            compact_summary: self.compact_summary.clone(),
            plan_content: self.plan_content.clone(),
            tool_use_result: (block_type == DirectUserBlockType::ToolResult)
                .then(|| self.tool_use_result.clone())
                .flatten(),
            block_type,
            image_paste_id,
            render_image_id,
        }
    }
}

#[derive(Debug, Default)]
pub struct Projection {
    diagnostics: crate::renderer_diagnostics::RendererDiagnostics,
    raw_envelopes: Vec<RawEnvelope>,
    raw_envelope_count: u64,
    raw_evicted_count: u64,
    raw_retention_charge_bytes: usize,
    raw_retention_limit_override: Option<usize>,
    items: Vec<ProjectedItem>,
    item_index: HashMap<String, usize>,
    stream_blocks: HashMap<StreamBlockSlot, StreamBlockState>,
    finalized_stream_blocks: HashMap<StreamBlockKey, StreamBlockState>,
    next_stream_generation: HashMap<StreamBlockSlot, u64>,
    assistant_stream_reconciliations: HashMap<String, Vec<Option<StreamBlockKey>>>,
    active_message_by_context: HashMap<StreamContext, String>,
    tool_names: HashMap<String, String>,
    tool_artifacts_by_tool_use: HashMap<String, Vec<ProjectedToolArtifact>>,
    direct_nested_tool_names: HashMap<(String, String), String>,
    direct_nested_tool_item_keys: HashMap<(String, String), String>,
    direct_nested_resolved_tool_uses: HashSet<(String, String)>,
    direct_nested_prompts: HashMap<String, String>,
    direct_hook_progress_counts: HashMap<DirectHookKey, usize>,
    /// Number of primary terminal results observed for each hook batch.
    ///
    /// The current producer emits one progress record per matching hook, but
    /// `hookName` names the event/matcher and is deliberately shared by every
    /// hook in that batch. Counting unique names therefore cannot represent a
    /// two-hook `Stop`/`SessionStart` batch. Primary terminal attachments are
    /// process-private events and are counted by occurrence instead;
    /// supplemental hook attachments never advance this count.
    direct_resolved_hook_counts: HashMap<DirectHookKey, usize>,
    direct_progress_identities: Vec<DirectProgressIdentity>,
    direct_hook_progress_entries: Vec<DirectHookProgressEntry>,
    direct_renderer_gated_attachments: Vec<DirectRendererGatedAttachment>,
    /// Durable active background-task ownership projected from exact
    /// `task_status` attachments. Terminal states remove the identity; callers
    /// never infer watcher state from display text.
    active_direct_tasks: HashMap<String, DirectTaskType>,
    /// Monotonic visible-output boundary, mirroring Grok's tracker epoch.
    /// Raw diagnostic-only replay does not advance it.
    visible_output_epoch: u64,
    epoch_at_last_finish: u64,
    direct_stream_activity: DirectStreamActivityState,
    compatibility_diagnostics: Vec<ProjectionCompatibilityDiagnostic>,
    direct_tombstone_delete_effects: Vec<DirectTombstoneDeleteEffect>,
    item_removals: Vec<ProjectionItemRemoval>,
    next_item_removal_id: u64,
    pending_controls: BTreeMap<String, PendingControl>,
    session_id: Option<String>,
    cwd: Option<String>,
    model: Option<String>,
    permission_mode: Option<String>,
    session_state: Option<String>,
    prompt_suggestion: Option<String>,
}

impl Projection {
    pub fn ingest(&mut self, envelope: RawEnvelope) -> ProjectionEffect {
        let sequence = envelope.sequence;
        let envelope_charge = envelope
            .encoded_len
            .saturating_add(RAW_ENVELOPE_ALLOCATION_CHARGE_BYTES);
        self.raw_envelope_count = self.raw_envelope_count.saturating_add(1);
        self.raw_retention_charge_bytes = self
            .raw_retention_charge_bytes
            .saturating_add(envelope_charge);
        self.raw_envelopes.push(envelope);
        let retention_limit = self
            .raw_retention_limit_override
            .unwrap_or(MAX_RETAINED_RAW_CHARGE_BYTES);
        let mut evict_count = 0_usize;
        while self.raw_envelopes.len().saturating_sub(evict_count) > 1
            && self.raw_retention_charge_bytes > retention_limit
        {
            let evicted_charge = self.raw_envelopes[evict_count]
                .encoded_len
                .saturating_add(RAW_ENVELOPE_ALLOCATION_CHARGE_BYTES);
            self.raw_retention_charge_bytes = self
                .raw_retention_charge_bytes
                .saturating_sub(evicted_charge);
            self.raw_evicted_count = self.raw_evicted_count.saturating_add(1);
            evict_count = evict_count.saturating_add(1);
        }
        if evict_count > 0 {
            self.raw_envelopes.drain(..evict_count);
        }
        // A short-lived clone avoids aliasing the recent diagnostic window
        // while mutating projection indexes.
        let raw = self
            .raw_envelopes
            .last()
            .expect("the envelope was just retained")
            .clone();
        let incoming_session_id = string_at(&raw.value, &["session_id"]);
        let session_transition = self
            .session_id
            .as_deref()
            .zip(incoming_session_id.as_deref())
            .filter(|(previous, incoming)| previous != incoming)
            .map(|(previous, incoming)| (previous.to_string(), incoming.to_string()));
        let projected = if let Some((previous_session_id, session_id)) = session_transition {
            // Validate and project the first envelope of the new session into
            // isolated state. Only replace the old projection after the whole
            // envelope succeeds, so a malformed or non-session-bearing frame
            // cannot erase the visible transcript.
            let mut replacement = Self::default();
            match replacement.project(&raw) {
                Ok(effect) if replacement.session_id.as_deref() == Some(session_id.as_str()) => {
                    self.replace_session_projection_preserving_diagnostics(replacement);
                    Ok(ProjectionEffect::SessionTransition {
                        previous_session_id,
                        session_id,
                        effect: Box::new(effect),
                    })
                }
                Ok(_) => self.project(&raw),
                Err(reason) => Err(reason),
            }
        } else {
            self.project(&raw)
        };
        let effect = match projected {
            Ok(effect) => effect,
            Err(reason) => self.stream_projection_failure_effect(&raw, reason),
        };
        let block_generation = self.diagnostic_block_generation(&raw);
        let compatibility_count = self
            .compatibility_diagnostics
            .iter()
            .filter(|diagnostic| diagnostic.sequence == sequence)
            .count();
        let (outcome, declared_disposition, issue_code, root_error_code) =
            projection_effect_diagnostic_fields(&effect, &raw);
        self.diagnostics.record_envelope(
            &raw,
            self.direct_stream_activity.turn_generation,
            block_generation,
            outcome,
            declared_disposition,
            issue_code,
            root_error_code,
            compatibility_count,
        );
        effect
    }

    fn stream_projection_failure_effect(
        &mut self,
        envelope: &RawEnvelope,
        reason: String,
    ) -> ProjectionEffect {
        let EnvelopeClass::StreamEvent { event_type } = &envelope.classification else {
            return ProjectionEffect::FailClosed {
                sequence: envelope.sequence,
                reason,
            };
        };
        let Some(event_type) = event_type.as_deref() else {
            return ProjectionEffect::AbortTurn {
                sequence: envelope.sequence,
                code: "stream_event_type_missing".to_string(),
                reason,
            };
        };
        let code = format!("{event_type}_invalid");
        match generated_stream_event_disposition(event_type) {
            Some(GeneratedEventDisposition::TurnFatal) => ProjectionEffect::AbortTurn {
                sequence: envelope.sequence,
                code,
                reason,
            },
            Some(
                GeneratedEventDisposition::PresentationOnly
                | GeneratedEventDisposition::Recoverable,
            )
            | None => {
                self.record_compatibility(
                    envelope.sequence,
                    ProjectionCompatibilityKind::MalformedPresentation,
                    None,
                    None,
                    format!("ignored incompatible stream event `{event_type}` ({code})"),
                    false,
                );
                ProjectionEffect::CompatibilityFault {
                    sequence: envelope.sequence,
                    event_type: event_type.to_string(),
                    code,
                }
            }
            Some(GeneratedEventDisposition::ProtocolFatal) => ProjectionEffect::FailClosed {
                sequence: envelope.sequence,
                reason,
            },
        }
    }

    pub(crate) fn set_renderer_diagnostics(
        &mut self,
        diagnostics: crate::renderer_diagnostics::RendererDiagnostics,
    ) {
        self.diagnostics = diagnostics;
    }

    #[cfg(test)]
    pub(crate) fn project_wire_fixtures(
        &mut self,
        values: &[Value],
        first_sequence: u64,
    ) -> Result<usize, String> {
        for (offset, value) in values.iter().enumerate() {
            let classification =
                crate::sdk_runtime::classify_envelope(value).map_err(|error| error.to_string())?;
            let encoded_len = serde_json::to_vec(value)
                .map_err(|error| format!("failed to encode wire fixture: {error}"))?
                .len();
            let sequence = first_sequence.saturating_add(offset as u64);
            if let ProjectionEffect::FailClosed { reason, .. } = self.ingest(RawEnvelope {
                sequence,
                encoded_len,
                value: value.clone(),
                classification,
                correlation: None,
            }) {
                return Err(reason);
            }
        }
        Ok(values.len())
    }

    pub fn raw_envelopes(&self) -> &[RawEnvelope] {
        &self.raw_envelopes
    }

    pub fn raw_envelope_count(&self) -> u64 {
        self.raw_envelope_count
    }

    pub fn raw_evicted_count(&self) -> u64 {
        self.raw_evicted_count
    }

    pub fn raw_retention_charge_bytes(&self) -> usize {
        self.raw_retention_charge_bytes
    }

    pub fn items(&self) -> &[ProjectedItem] {
        &self.items
    }

    #[cfg(test)]
    pub(crate) fn direct_progress_identities(&self) -> &[DirectProgressIdentity] {
        &self.direct_progress_identities
    }

    #[cfg(test)]
    pub(crate) fn direct_hook_progress_entries(&self) -> &[DirectHookProgressEntry] {
        &self.direct_hook_progress_entries
    }

    pub(crate) fn direct_stream_activity(&self) -> &DirectStreamActivityState {
        &self.direct_stream_activity
    }

    pub(crate) fn active_direct_tasks(&self) -> &HashMap<String, DirectTaskType> {
        &self.active_direct_tasks
    }

    pub(crate) fn output_since_last_finish(&self) -> bool {
        self.visible_output_epoch != self.epoch_at_last_finish
    }

    pub(crate) fn snapshot_output_epoch(&mut self) {
        self.epoch_at_last_finish = self.visible_output_epoch;
    }

    pub(crate) fn finish_output_epoch(&mut self) {
        self.snapshot_output_epoch();
    }

    #[cfg(test)]
    pub(crate) fn compatibility_diagnostics(&self) -> &[ProjectionCompatibilityDiagnostic] {
        &self.compatibility_diagnostics
    }

    #[cfg(test)]
    pub(crate) fn direct_tombstone_delete_effects(&self) -> &[DirectTombstoneDeleteEffect] {
        &self.direct_tombstone_delete_effects
    }

    pub(crate) fn item_removals(&self) -> &[ProjectionItemRemoval] {
        &self.item_removals
    }

    /// Renderer artifact provenance for one exact producer tool-use id.
    ///
    /// Returning an empty slice is fail-closed: the caller must never infer a
    /// file path from display text or scan the bounded raw diagnostic journal.
    pub fn tool_artifacts_for(&self, tool_use_id: &str) -> &[ProjectedToolArtifact] {
        self.tool_artifacts_by_tool_use
            .get(tool_use_id)
            .map(Vec::as_slice)
            .unwrap_or_default()
    }

    /// Return the fixed historical HookProgress lookup for one target
    /// tool-use id and hook event.
    ///
    /// `None` means that no matching progress message has started. Resolution
    /// attachments can arrive first and are still retained internally, so a
    /// later progress message observes their terminal occurrence count. The
    /// exposed count is capped at the number started because renderer state is
    /// a started/resolved lifecycle, not a count of diagnostic envelopes.
    pub(crate) fn direct_hook_progress_presentation(
        &self,
        tool_use_id: &str,
        hook_event: &str,
    ) -> Option<DirectHookProgressPresentation> {
        let key = DirectHookKey {
            parent_tool_use_id: tool_use_id.to_string(),
            hook_event: hook_event.to_string(),
        };
        let in_progress_count = self.direct_hook_progress_counts.get(&key).copied()?;
        let resolved_count = self
            .direct_resolved_hook_counts
            .get(&key)
            .copied()
            .unwrap_or_default()
            .min(in_progress_count);
        Some(DirectHookProgressPresentation {
            tool_use_id: tool_use_id.to_string(),
            hook_event: hook_event.to_string(),
            in_progress_count,
            resolved_count,
        })
    }

    pub fn pending_controls(&self) -> impl Iterator<Item = &PendingControl> {
        self.pending_controls.values()
    }

    pub fn pending_control(&self, request_id: &str) -> Option<&PendingControl> {
        self.pending_controls.get(request_id)
    }

    pub fn resolve_pending_control(&mut self, request_id: &str) -> Option<PendingControl> {
        self.pending_controls.remove(request_id)
    }

    pub fn session_id(&self) -> Option<&str> {
        self.session_id.as_deref()
    }

    pub fn cwd(&self) -> Option<&str> {
        self.cwd.as_deref()
    }

    pub fn model(&self) -> Option<&str> {
        self.model.as_deref()
    }

    pub fn permission_mode(&self) -> Option<&str> {
        self.permission_mode.as_deref()
    }

    pub fn session_state(&self) -> Option<&str> {
        self.session_state.as_deref()
    }

    pub fn prompt_suggestion(&self) -> Option<&str> {
        self.prompt_suggestion.as_deref()
    }

    fn record_compatibility(
        &mut self,
        sequence: u64,
        kind: ProjectionCompatibilityKind,
        slot: Option<&StreamBlockSlot>,
        generation: Option<u64>,
        reason: impl Into<String>,
        visible: bool,
    ) {
        let reason = reason.into();
        let diagnostic_ordinal = self.compatibility_diagnostics.len().saturating_add(1);
        self.compatibility_diagnostics
            .push(ProjectionCompatibilityDiagnostic {
                sequence,
                kind,
                message_id: slot.map(|slot| slot.message_id.clone()),
                source_index: slot.map(|slot| slot.index),
                generation,
                reason: reason.clone(),
            });
        if self.compatibility_diagnostics.len() > MAX_COMPATIBILITY_DIAGNOSTICS {
            let overflow = self
                .compatibility_diagnostics
                .len()
                .saturating_sub(MAX_COMPATIBILITY_DIAGNOSTICS);
            self.compatibility_diagnostics.drain(..overflow);
        }
        if visible {
            self.append_item(ProjectedItem {
                key: format!("renderer-compatibility:{sequence}:{diagnostic_ordinal}"),
                kind: ProjectedKind::System,
                title: "Renderer compatibility".to_string(),
                text: reason,
                streaming: false,
                raw_sequences: vec![sequence],
                tool_use_id: None,
                presentation: ProjectedPresentation {
                    plain_system: true,
                    ..ProjectedPresentation::default()
                },
            });
        }
    }

    fn diagnostic_block_generation(&self, envelope: &RawEnvelope) -> Option<u64> {
        let event = envelope.value.get("event")?;
        let index = event.get("index")?.as_u64()?;
        let context = stream_context(&envelope.value, envelope).ok()?;
        let message_id = event
            .pointer("/message/id")
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| self.active_message_by_context.get(&context).cloned())?;
        let slot = StreamBlockSlot {
            context,
            message_id,
            index,
        };
        self.stream_blocks
            .get(&slot)
            .map(|state| state.key.generation)
            .or_else(|| {
                self.finalized_stream_blocks
                    .iter()
                    .filter(|(key, _)| key.slot == slot)
                    .map(|(key, _)| key.generation)
                    .max()
            })
    }

    fn replace_session_projection_preserving_diagnostics(&mut self, mut replacement: Self) {
        replacement.diagnostics = std::mem::take(&mut self.diagnostics);
        replacement.raw_envelopes = std::mem::take(&mut self.raw_envelopes);
        replacement.raw_envelope_count = self.raw_envelope_count;
        replacement.raw_evicted_count = self.raw_evicted_count;
        replacement.raw_retention_charge_bytes = self.raw_retention_charge_bytes;
        replacement.raw_retention_limit_override = self.raw_retention_limit_override;
        *self = replacement;
    }

    fn project(&mut self, envelope: &RawEnvelope) -> Result<ProjectionEffect, String> {
        match &envelope.classification {
            EnvelopeClass::User => {
                self.project_user(envelope)?;
                Ok(ProjectionEffect::None)
            }
            EnvelopeClass::Assistant => {
                self.project_assistant(envelope)?;
                Ok(ProjectionEffect::None)
            }
            EnvelopeClass::DirectProgress { progress_type } => {
                self.project_direct_progress(envelope, progress_type)?;
                Ok(ProjectionEffect::None)
            }
            EnvelopeClass::DirectAttachment { attachment_type } => {
                self.project_direct_attachment(envelope, attachment_type)?;
                Ok(ProjectionEffect::None)
            }
            EnvelopeClass::DirectStreamRequestStart => {
                optional_string_at(
                    &envelope.value,
                    &["uuid"],
                    "direct stream_request_start",
                    envelope,
                )?;
                let turn_generation = self
                    .direct_stream_activity
                    .turn_generation
                    .saturating_add(1);
                self.direct_stream_activity = DirectStreamActivityState {
                    phase: DirectStreamActivityPhase::Requesting,
                    ttft_ms: None,
                    raw_sequence: Some(envelope.sequence),
                    turn_generation,
                    request_started_sequence: Some(envelope.sequence),
                };
                Ok(ProjectionEffect::StreamRequestStarted)
            }
            EnvelopeClass::DirectTombstone { message_type } => {
                self.project_direct_tombstone(envelope, message_type)?;
                Ok(ProjectionEffect::None)
            }
            EnvelopeClass::Result => self.project_result(envelope),
            EnvelopeClass::System(subtype) => self.project_system(envelope, subtype),
            EnvelopeClass::DirectSystem(subtype) => {
                self.project_direct_system(envelope, subtype)?;
                Ok(ProjectionEffect::None)
            }
            EnvelopeClass::StreamEvent { event_type } => {
                self.project_stream_event(envelope, event_type.as_deref())
            }
            EnvelopeClass::ToolProgress => {
                self.project_tool_progress(envelope)?;
                Ok(ProjectionEffect::None)
            }
            EnvelopeClass::AuthStatus => {
                self.project_auth_status(envelope)?;
                Ok(ProjectionEffect::None)
            }
            EnvelopeClass::ToolUseSummary => {
                required_string_array_at(
                    &envelope.value,
                    &["preceding_tool_use_ids"],
                    "tool_use_summary",
                    envelope,
                )?;
                // SDK-only state: the fixed direct message adapter explicitly
                // ignores tool_use_summary instead of adding a transcript row.
                validate_sdk_identity(&envelope.value, "tool_use_summary", envelope)?;
                required_string_at(&envelope.value, &["summary"], "tool_use_summary", envelope)?;
                Ok(ProjectionEffect::None)
            }
            EnvelopeClass::RateLimitEvent => {
                self.project_rate_limit(envelope)?;
                Ok(ProjectionEffect::None)
            }
            EnvelopeClass::PromptSuggestion => {
                validate_sdk_identity(&envelope.value, "prompt_suggestion", envelope)?;
                let suggestion = required_string_at(
                    &envelope.value,
                    &["suggestion"],
                    "prompt_suggestion",
                    envelope,
                )?;
                self.prompt_suggestion = (!suggestion.is_empty()).then(|| suggestion.clone());
                Ok(ProjectionEffect::PromptSuggestion(suggestion))
            }
            EnvelopeClass::StreamlinedText => {
                self.project_named_text(
                    envelope,
                    ProjectedKind::Assistant,
                    "Assistant",
                    &["text"],
                    ProjectedPresentation {
                        assistant_block: Some(AssistantBlockType::Text),
                        ..ProjectedPresentation::default()
                    },
                )?;
                Ok(ProjectionEffect::None)
            }
            EnvelopeClass::StreamlinedToolUseSummary => {
                self.project_named_text(
                    envelope,
                    ProjectedKind::System,
                    "Tool summary",
                    &["tool_summary"],
                    ProjectedPresentation {
                        plain_system: true,
                        ..ProjectedPresentation::default()
                    },
                )?;
                Ok(ProjectionEffect::None)
            }
            EnvelopeClass::ControlRequest {
                request_id,
                subtype,
            } => {
                let request = envelope
                    .value
                    .get("request")
                    .cloned()
                    .ok_or_else(|| "control_request lost its request object".to_string())?;
                let pending = PendingControl {
                    request_id: request_id.clone(),
                    subtype: subtype.clone(),
                    request,
                    raw_sequence: envelope.sequence,
                };
                if self
                    .pending_controls
                    .insert(request_id.clone(), pending.clone())
                    .is_some()
                {
                    return Err(format!(
                        "duplicate reverse control request id `{request_id}` reached projection"
                    ));
                }
                Ok(ProjectionEffect::ReverseControlOpened(pending))
            }
            EnvelopeClass::ControlResponse {
                request_id,
                outcome,
            } => {
                let response = envelope
                    .value
                    .get("response")
                    .cloned()
                    .ok_or_else(|| "control_response lost its response object".to_string())?;
                let request_subtype = match &envelope.correlation {
                    Some(RequestCorrelation::OutboundResponseMatched {
                        request_subtype, ..
                    }) => Some(request_subtype.clone()),
                    _ => None,
                };
                Ok(ProjectionEffect::ControlResponse {
                    request_id: request_id.clone(),
                    request_subtype,
                    success: outcome == "success",
                    payload: response,
                    raw_sequence: envelope.sequence,
                })
            }
            EnvelopeClass::ControlCancelRequest { request_id } => {
                self.pending_controls.remove(request_id);
                Ok(ProjectionEffect::ReverseControlCancelled {
                    request_id: request_id.clone(),
                })
            }
            // Post-setup native panel results are process-private control
            // values, not transcript items. TuiApp consumes their closed
            // request lifecycle after this complete raw envelope is retained.
            EnvelopeClass::PrivateRuntimeResult { .. } => Ok(ProjectionEffect::None),
            EnvelopeClass::KeepAlive => Ok(ProjectionEffect::None),
            EnvelopeClass::Unclassified {
                observed_type,
                observed_system_subtype,
            } => {
                self.record_compatibility(
                    envelope.sequence,
                    ProjectionCompatibilityKind::UnknownPresentation,
                    None,
                    None,
                    format!(
                        "Unsupported presentation event retained without stopping the backend (type={}, subtype={})",
                        observed_type.as_deref().unwrap_or("<missing>"),
                        observed_system_subtype.as_deref().unwrap_or("<missing>")
                    ),
                    true,
                );
                Ok(ProjectionEffect::None)
            }
        }
    }

    fn project_user(&mut self, envelope: &RawEnvelope) -> Result<(), String> {
        let value = &envelope.value;
        let is_direct = value.get("parent_tool_use_id").is_none();
        let parsed_tool_artifacts = match value.get("tool_artifacts") {
            Some(artifacts) => Some(parse_tool_artifacts(artifacts, envelope)?),
            None => None,
        };
        let parent_tool = match value.get("parent_tool_use_id") {
            Some(_) => {
                let parent = required_nullable_string_at(
                    value,
                    &["parent_tool_use_id"],
                    "SDK user",
                    envelope,
                )?;
                optional_string_at(value, &["uuid"], "SDK user", envelope)?;
                optional_string_at(value, &["session_id"], "SDK user", envelope)?;
                optional_string_at(value, &["timestamp"], "SDK user", envelope)?;
                optional_bool_at(value, &["isSynthetic"], "SDK user", envelope)?;
                if let Some(is_replay) =
                    optional_bool_at(value, &["isReplay"], "SDK user", envelope)?
                    && !is_replay
                {
                    return Err(format!(
                        "SDK user has false isReplay at sequence {}",
                        envelope.sequence
                    ));
                }
                if value.get("isReplay").is_some() {
                    required_string_at(value, &["uuid"], "SDK replay user", envelope)?;
                    required_string_at(value, &["session_id"], "SDK replay user", envelope)?;
                }
                if let Some(priority) =
                    optional_string_at(value, &["priority"], "SDK user", envelope)?
                    && !matches!(priority.as_str(), "now" | "next" | "later")
                {
                    return Err(format!(
                        "SDK user has unsupported priority `{priority}` at sequence {}",
                        envelope.sequence
                    ));
                }
                parent
            }
            None => {
                // Fixed direct `UserMessage` has a required native identity
                // and deliberately has no SDK parent/session context.
                required_string_at(value, &["uuid"], "direct user", envelope)?;
                required_string_at(value, &["timestamp"], "direct user", envelope)?;
                if value.get("session_id").is_some() {
                    return Err(format!(
                        "user mixed direct-query identity with SDK session_id at sequence {}",
                        envelope.sequence
                    ));
                }
                None
            }
        };
        let direct_user = if is_direct {
            Some(parse_direct_user_envelope_fields(value, envelope)?)
        } else {
            None
        };
        self.observe_session(value);
        let content = value.pointer("/message/content");
        let synthetic =
            optional_bool_at(value, &["isSynthetic"], "user", envelope)?.unwrap_or(false);
        let replay = optional_bool_at(value, &["isReplay"], "user", envelope)?.unwrap_or(false);
        let prefix = if synthetic {
            "Synthetic user"
        } else if replay {
            "User (history)"
        } else if parent_tool.is_some() {
            "Tool result"
        } else {
            "You"
        };
        match content {
            Some(Value::String(text)) => {
                self.append_item(ProjectedItem {
                    key: envelope_key(envelope, "user", 0),
                    kind: if parent_tool.is_some() {
                        ProjectedKind::ToolResult
                    } else {
                        ProjectedKind::User
                    },
                    title: prefix.to_string(),
                    text: text.clone(),
                    streaming: false,
                    raw_sequences: vec![envelope.sequence],
                    tool_use_id: parent_tool,
                    presentation: ProjectedPresentation {
                        direct_user: direct_user
                            .as_ref()
                            .map(|fields| fields.for_block(DirectUserBlockType::Text, None)),
                        ..ProjectedPresentation::default()
                    },
                });
            }
            Some(Value::Array(blocks)) => {
                let mut image_position = 0_usize;
                for (index, block) in blocks.iter().enumerate() {
                    let is_image = string_at(block, &["type"]).as_deref() == Some("image");
                    let current_image_position = is_image.then_some(image_position);
                    self.project_user_block(
                        envelope,
                        block,
                        index,
                        prefix,
                        parent_tool.as_deref(),
                        direct_user.as_ref(),
                        current_image_position,
                    )?;
                    if is_image {
                        image_position = image_position.checked_add(1).ok_or_else(|| {
                            format!(
                                "direct user image position overflowed at sequence {}",
                                envelope.sequence
                            )
                        })?;
                    }
                }
            }
            Some(_) => {
                return Err(format!(
                    "user message content is neither text nor an array at sequence {}",
                    envelope.sequence
                ));
            }
            None => {
                return Err(format!(
                    "user envelope omitted message.content at sequence {}",
                    envelope.sequence
                ));
            }
        }
        if let Some(artifacts) = parsed_tool_artifacts {
            self.commit_tool_artifacts(artifacts)?;
        }
        Ok(())
    }

    fn commit_tool_artifacts(
        &mut self,
        artifacts: Vec<ProjectedToolArtifact>,
    ) -> Result<(), String> {
        // Check the complete batch before mutating reducer state so a
        // conflicting replay cannot partially replace established provenance.
        for (index, artifact) in artifacts.iter().enumerate() {
            if let Some(conflict) = artifacts[..index].iter().find(|prior| {
                prior.producer_tool_use_id == artifact.producer_tool_use_id
                    && prior.id == artifact.id
                    && !prior.same_payload(artifact)
            }) {
                return Err(format!(
                    "tool_artifacts contains conflicting artifact `{}` for producer `{}` at raw sequence {} (first seen in {:?})",
                    artifact.id,
                    artifact.producer_tool_use_id,
                    artifact.raw_sequences.first().copied().unwrap_or_default(),
                    conflict.raw_sequences
                ));
            }
            if let Some(existing) = self
                .tool_artifacts_by_tool_use
                .get(&artifact.producer_tool_use_id)
                .and_then(|known| known.iter().find(|known| known.id == artifact.id))
                && !existing.same_payload(artifact)
            {
                return Err(format!(
                    "tool artifact `{}` for producer `{}` changed after projection",
                    artifact.id, artifact.producer_tool_use_id
                ));
            }
        }

        for mut artifact in artifacts {
            let known = self
                .tool_artifacts_by_tool_use
                .entry(artifact.producer_tool_use_id.clone())
                .or_default();
            if let Some(existing) = known.iter_mut().find(|existing| existing.id == artifact.id) {
                for sequence in artifact.raw_sequences.drain(..) {
                    if !existing.raw_sequences.contains(&sequence) {
                        existing.raw_sequences.push(sequence);
                    }
                }
            } else {
                known.push(artifact);
            }
        }
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    fn project_user_block(
        &mut self,
        envelope: &RawEnvelope,
        block: &Value,
        index: usize,
        prefix: &str,
        parent_tool: Option<&str>,
        direct_user: Option<&DirectUserEnvelopeFields>,
        image_position: Option<usize>,
    ) -> Result<(), String> {
        let block_type = string_at(block, &["type"]).ok_or_else(|| {
            format!(
                "user content block {index} omitted type at sequence {}",
                envelope.sequence
            )
        })?;
        let direct_block_type = direct_user
            .map(|_| direct_user_block_type(&block_type, envelope.sequence))
            .transpose()?;
        let item_count_before = self.items.len();
        match block_type.as_str() {
            "text" => {
                let text = string_at(block, &["text"]).ok_or_else(|| {
                    format!(
                        "user text block {index} omitted text at sequence {}",
                        envelope.sequence
                    )
                })?;
                self.append_item(ProjectedItem {
                    key: envelope_key(envelope, "user-text", index),
                    kind: if parent_tool.is_some() {
                        ProjectedKind::ToolResult
                    } else {
                        ProjectedKind::User
                    },
                    title: prefix.to_string(),
                    text,
                    streaming: false,
                    raw_sequences: vec![envelope.sequence],
                    tool_use_id: parent_tool.map(str::to_string),
                    presentation: ProjectedPresentation::default(),
                });
            }
            "tool_result" => {
                let id = string_at(block, &["tool_use_id"]).ok_or_else(|| {
                    format!(
                        "user tool_result block {index} omitted tool_use_id at sequence {}",
                        envelope.sequence
                    )
                })?;
                let is_error = optional_bool_field(block, "is_error", "user tool_result block")?;
                let text = content_to_text(block.get("content"))?;
                let terminal = self
                    .tool_names
                    .get(&id)
                    .is_some_and(|name| is_terminal_tool(name));
                let name = self.tool_names.get(&id).cloned();
                let renderer_result = match direct_user {
                    // The fixed successful tool renderer consumes the
                    // envelope-level, tool-schema-dependent `toolUseResult`.
                    // Error/cancel/reject rendering consumes block.content.
                    Some(fields) if is_error != Some(true) => fields.tool_use_result.clone(),
                    _ => block.get("content").cloned(),
                };
                self.append_item(ProjectedItem {
                    key: format!("tool-result:{id}"),
                    kind: if terminal {
                        ProjectedKind::TerminalOutput
                    } else {
                        ProjectedKind::ToolResult
                    },
                    title: name.as_ref().map_or_else(
                        || "Tool result".to_string(),
                        |name| format!("{name} result"),
                    ),
                    text,
                    streaming: false,
                    raw_sequences: vec![envelope.sequence],
                    tool_use_id: Some(id),
                    presentation: ProjectedPresentation {
                        tool: Some(ToolPresentation {
                            name,
                            input: None,
                            partial_input_json: None,
                            lifecycle_output: None,
                            result: renderer_result,
                            is_error,
                        }),
                        ..ProjectedPresentation::default()
                    },
                });
            }
            "image" => {
                let (text, image) = image_projection(block, envelope.sequence, index)?;
                self.append_item(ProjectedItem {
                    key: envelope_key(envelope, "user-image", index),
                    kind: ProjectedKind::User,
                    title: "Image".to_string(),
                    text,
                    streaming: false,
                    raw_sequences: vec![envelope.sequence],
                    tool_use_id: parent_tool.map(str::to_string),
                    presentation: ProjectedPresentation {
                        image: Some(image),
                        ..ProjectedPresentation::default()
                    },
                });
            }
            "document" => {
                self.append_item(ProjectedItem {
                    key: envelope_key(envelope, "user-document", index),
                    kind: ProjectedKind::User,
                    title: "Document".to_string(),
                    text: document_projection(block, envelope.sequence, index)?,
                    streaming: false,
                    raw_sequences: vec![envelope.sequence],
                    tool_use_id: parent_tool.map(str::to_string),
                    presentation: ProjectedPresentation::default(),
                });
            }
            "thinking" | "redacted_thinking" => {
                let redacted = block_type == "redacted_thinking";
                let content_field = if redacted { "data" } else { "thinking" };
                let content = string_at(block, &[content_field]).ok_or_else(|| {
                    format!(
                        "user {block_type} block {index} omitted {content_field} at sequence {}",
                        envelope.sequence
                    )
                })?;
                let signature = if redacted {
                    None
                } else {
                    Some(string_at(block, &["signature"]).ok_or_else(|| {
                        format!(
                            "user thinking block {index} omitted signature at sequence {}",
                            envelope.sequence
                        )
                    })?)
                };
                self.append_item(ProjectedItem {
                    key: envelope_key(envelope, "user-thinking", index),
                    kind: ProjectedKind::Thinking,
                    title: if redacted {
                        "Redacted thinking"
                    } else {
                        "Thinking"
                    }
                    .to_string(),
                    text: content.clone(),
                    streaming: false,
                    raw_sequences: vec![envelope.sequence],
                    tool_use_id: parent_tool.map(str::to_string),
                    presentation: ProjectedPresentation {
                        thinking: Some(ThinkingPresentation {
                            kind: if redacted {
                                ThinkingKind::Redacted
                            } else {
                                ThinkingKind::Thinking
                            },
                            content,
                            signature,
                        }),
                        ..ProjectedPresentation::default()
                    },
                });
            }
            "connector_text" => {
                self.append_item(ProjectedItem {
                    key: envelope_key(envelope, "user-connector-text", index),
                    kind: ProjectedKind::User,
                    title: prefix.to_string(),
                    text: connector_text_projection(
                        block,
                        &format!(
                            "user connector_text block {index} at sequence {}",
                            envelope.sequence
                        ),
                    )?,
                    streaming: false,
                    raw_sequences: vec![envelope.sequence],
                    tool_use_id: parent_tool.map(str::to_string),
                    presentation: ProjectedPresentation::default(),
                });
            }
            "tool_use" | "server_tool_use" | "mcp_tool_use" => {
                let id = string_at(block, &["id"]).ok_or_else(|| {
                    format!(
                        "user {block_type} block {index} omitted id at sequence {}",
                        envelope.sequence
                    )
                })?;
                let name = string_at(block, &["name"]).ok_or_else(|| {
                    format!(
                        "user {block_type} block {index} omitted name at sequence {}",
                        envelope.sequence
                    )
                })?;
                let input = block.get("input").cloned().ok_or_else(|| {
                    format!(
                        "user {block_type} block {index} omitted input at sequence {}",
                        envelope.sequence
                    )
                })?;
                self.tool_names.insert(id.clone(), name.clone());
                let advisor = if block_type == "server_tool_use" && name == "advisor" {
                    Some(advisor_invocation_presentation(
                        &input,
                        &format!(
                            "user advisor server_tool_use block {index} at sequence {}",
                            envelope.sequence
                        ),
                    )?)
                } else {
                    None
                };
                self.append_item(ProjectedItem {
                    key: envelope_key(envelope, "user-tool-use", index),
                    kind: ProjectedKind::ToolUse,
                    title: if advisor.is_some() {
                        "Advising".to_string()
                    } else {
                        name.clone()
                    },
                    text: pretty_json(&input),
                    streaming: false,
                    raw_sequences: vec![envelope.sequence],
                    tool_use_id: Some(id),
                    presentation: ProjectedPresentation {
                        tool: Some(ToolPresentation {
                            name: Some(name),
                            input: Some(input),
                            partial_input_json: None,
                            lifecycle_output: None,
                            result: None,
                            is_error: None,
                        }),
                        advisor,
                        ..ProjectedPresentation::default()
                    },
                });
            }
            "web_search_tool_result"
            | "web_fetch_tool_result"
            | "code_execution_tool_result"
            | "bash_code_execution_tool_result"
            | "text_editor_code_execution_tool_result"
            | "tool_search_tool_result"
            | "mcp_tool_result"
            | "container_upload"
            | "advisor_tool_result" => {
                let (tool_use_id, result, is_error) = assistant_result_fields(
                    &block_type,
                    block,
                    &format!("user block {index} at sequence {}", envelope.sequence),
                )?;
                let name = tool_use_id
                    .as_ref()
                    .and_then(|id| self.tool_names.get(id))
                    .cloned();
                let advisor = if block_type == "advisor_tool_result" {
                    Some(advisor_result_presentation(
                        block,
                        &format!("user block {index} at sequence {}", envelope.sequence),
                    )?)
                } else {
                    None
                };
                if let (Some(tool_use_id), Some(AdvisorPresentation::Result(advisor_result))) =
                    (tool_use_id.as_deref(), advisor.as_ref())
                {
                    self.resolve_advisor_invocation(tool_use_id, advisor_result);
                }
                self.append_item(ProjectedItem {
                    key: envelope_key(envelope, "user-tool-result", index),
                    kind: ProjectedKind::ToolResult,
                    title: if advisor.is_some() {
                        "Advisor feedback".to_string()
                    } else {
                        name.as_ref().map_or_else(
                            || block_type.replace('_', " "),
                            |name| format!("{name} result"),
                        )
                    },
                    text: if block_type == "advisor_tool_result" {
                        advisor_result_text(block)?
                    } else {
                        content_to_text(block.get("content"))?
                    },
                    streaming: false,
                    raw_sequences: vec![envelope.sequence],
                    tool_use_id,
                    presentation: ProjectedPresentation {
                        tool: Some(ToolPresentation {
                            name: name.or_else(|| Some(result_tool_name(&block_type))),
                            input: None,
                            partial_input_json: None,
                            lifecycle_output: None,
                            result,
                            is_error,
                        }),
                        advisor,
                        ..ProjectedPresentation::default()
                    },
                });
            }
            "compaction" => {
                validate_compaction_block(
                    block,
                    &format!(
                        "user compaction block {index} at sequence {}",
                        envelope.sequence
                    ),
                )?;
            }
            _ => {
                return Err(format!(
                    "unknown user content block type `{block_type}` at sequence {}",
                    envelope.sequence
                ));
            }
        }
        if let (Some(fields), Some(block_type)) = (direct_user, direct_block_type) {
            let presentation = fields.for_block(block_type, image_position);
            for item in &mut self.items[item_count_before..] {
                item.presentation.direct_user = Some(presentation.clone());
            }
        }
        Ok(())
    }

    fn project_assistant(&mut self, envelope: &RawEnvelope) -> Result<(), String> {
        let value = &envelope.value;
        let is_direct = value.get("session_id").is_none();
        if !is_direct {
            validate_sdk_identity(value, "SDK assistant", envelope)?;
            required_nullable_string_at(value, &["parent_tool_use_id"], "SDK assistant", envelope)?;
        } else {
            required_string_at(value, &["uuid"], "direct assistant", envelope)?;
            required_string_at(value, &["timestamp"], "direct assistant", envelope)?;
            if value.get("parent_tool_use_id").is_some() {
                return Err(format!(
                    "assistant mixed direct-query identity with SDK parent_tool_use_id at sequence {}",
                    envelope.sequence
                ));
            }
        }
        if let Some(error) = optional_string_at(value, &["error"], "assistant", envelope)?
            && !matches!(
                error.as_str(),
                "authentication_failed"
                    | "billing_error"
                    | "rate_limit"
                    | "invalid_request"
                    | "server_error"
                    | "unknown"
                    | "max_output_tokens"
            )
        {
            return Err(format!(
                "assistant has unsupported error `{error}` at sequence {}",
                envelope.sequence
            ));
        }
        self.observe_session(value);
        let message = value
            .get("message")
            .ok_or_else(|| "assistant envelope omitted message".to_string())?;
        let message_id = string_at(message, &["id"]).ok_or_else(|| {
            format!(
                "assistant message omitted id at sequence {}",
                envelope.sequence
            )
        })?;
        let direct_assistant = if is_direct {
            let usage = match message.get("usage") {
                None => None,
                Some(usage) if usage.is_object() => Some(DirectAssistantUsage {
                    input_tokens: required_number_at(
                        usage,
                        &["input_tokens"],
                        "direct assistant.message.usage",
                        envelope,
                    )?,
                    cache_creation_input_tokens: optional_nullable_number_at(
                        usage,
                        &["cache_creation_input_tokens"],
                        "direct assistant.message.usage",
                        envelope,
                    )?,
                    cache_read_input_tokens: optional_nullable_number_at(
                        usage,
                        &["cache_read_input_tokens"],
                        "direct assistant.message.usage",
                        envelope,
                    )?,
                }),
                Some(_) => {
                    return Err(format!(
                        "direct assistant.message has non-object usage at sequence {}",
                        envelope.sequence
                    ));
                }
            };
            Some(DirectAssistantPresentation {
                identity: DirectMessageIdentity {
                    uuid: required_string_at(value, &["uuid"], "direct assistant", envelope)?,
                },
                timestamp: required_string_at(value, &["timestamp"], "direct assistant", envelope)?,
                request_id: optional_string_at(
                    value,
                    &["requestId"],
                    "direct assistant",
                    envelope,
                )?,
                is_api_error_message: optional_bool_at(
                    value,
                    &["isApiErrorMessage"],
                    "direct assistant",
                    envelope,
                )?,
                advisor_model: optional_string_at(
                    value,
                    &["advisorModel"],
                    "direct assistant",
                    envelope,
                )?,
                message_id: message_id.clone(),
                model: required_string_at(
                    message,
                    &["model"],
                    "direct assistant.message",
                    envelope,
                )?,
                usage,
            })
        } else {
            None
        };
        let blocks = message
            .get("content")
            .and_then(Value::as_array)
            .ok_or_else(|| "assistant message content is not an array".to_string())?;
        let reconciliation_id =
            string_at(value, &["uuid"]).map(|uuid| format!("{message_id}:{uuid}"));
        // QueryModel emits one completed assistant envelope synchronously for
        // each content_block_stop, but that one-block envelope no longer
        // carries the source stream index. Stream indices are ordered, so the
        // lowest unclaimed active index with the same message id and block type
        // is the exact next producer block. Memoizing by assistant UUID makes a
        // repeated delivery idempotent instead of consuming the next block.
        let reconciled_stream_keys = reconciliation_id
            .as_ref()
            .and_then(|identity| self.assistant_stream_reconciliations.get(identity))
            .cloned()
            .unwrap_or_else(|| {
                let keys = blocks
                    .iter()
                    .map(|block| {
                        let block_type = string_at(block, &["type"])?;
                        self.claim_stream_block(&message_id, &block_type)
                    })
                    .collect::<Vec<_>>();
                if keys.iter().any(Option::is_some)
                    && let Some(identity) = reconciliation_id.as_ref()
                {
                    self.assistant_stream_reconciliations
                        .insert(identity.clone(), keys.clone());
                }
                keys
            });
        for (index, block) in blocks.iter().enumerate() {
            let key = reconciled_stream_keys
                .get(index)
                .cloned()
                .flatten()
                .map_or_else(
                    || format!("assistant:{message_id}:{index}"),
                    |stream_key| stream_item_key(&stream_key),
                );
            self.project_assistant_block(envelope, block, index, key.clone())?;
            if let Some(presentation) = direct_assistant.as_ref()
                && let Some(item) = self.item_mut(&key)
            {
                item.presentation.direct_assistant = Some(presentation.clone());
            }
        }
        Ok(())
    }

    fn project_assistant_block(
        &mut self,
        envelope: &RawEnvelope,
        block: &Value,
        index: usize,
        key: String,
    ) -> Result<(), String> {
        let block_type = string_at(block, &["type"])
            .ok_or_else(|| format!("assistant block {index} omitted type"))?;
        match block_type.as_str() {
            "text" => {
                let text = string_at(block, &["text"]).ok_or_else(|| {
                    format!(
                        "assistant text block {index} omitted text at sequence {}",
                        envelope.sequence
                    )
                })?;
                self.upsert_final_item_with_presentation(
                    key,
                    ProjectedKind::Assistant,
                    "Assistant",
                    text,
                    envelope.sequence,
                    None,
                    ProjectedPresentation {
                        assistant_block: Some(AssistantBlockType::Text),
                        ..ProjectedPresentation::default()
                    },
                );
            }
            "connector_text" => {
                let text = connector_text_projection(
                    block,
                    &format!(
                        "assistant connector_text block {index} at sequence {}",
                        envelope.sequence
                    ),
                )?;
                self.upsert_final_item_with_presentation(
                    key,
                    ProjectedKind::Assistant,
                    "Assistant",
                    text,
                    envelope.sequence,
                    None,
                    ProjectedPresentation {
                        assistant_block: Some(AssistantBlockType::ConnectorText),
                        ..ProjectedPresentation::default()
                    },
                );
            }
            "thinking" | "redacted_thinking" => {
                let redacted = block_type == "redacted_thinking";
                let content_field = if redacted { "data" } else { "thinking" };
                let content = string_at(block, &[content_field]).ok_or_else(|| {
                    format!(
                        "assistant {block_type} block {index} omitted {content_field} at sequence {}",
                        envelope.sequence
                    )
                })?;
                let signature = if redacted {
                    None
                } else {
                    Some(string_at(block, &["signature"]).ok_or_else(|| {
                        format!(
                            "assistant thinking block {index} omitted signature at sequence {}",
                            envelope.sequence
                        )
                    })?)
                };
                self.upsert_final_item_with_presentation(
                    key,
                    ProjectedKind::Thinking,
                    if redacted {
                        "Redacted thinking"
                    } else {
                        "Thinking"
                    },
                    content.clone(),
                    envelope.sequence,
                    None,
                    ProjectedPresentation {
                        assistant_block: Some(if redacted {
                            AssistantBlockType::RedactedThinking
                        } else {
                            AssistantBlockType::Thinking
                        }),
                        thinking: Some(ThinkingPresentation {
                            kind: if redacted {
                                ThinkingKind::Redacted
                            } else {
                                ThinkingKind::Thinking
                            },
                            content,
                            signature,
                        }),
                        ..ProjectedPresentation::default()
                    },
                );
            }
            "tool_use" | "server_tool_use" | "mcp_tool_use" => {
                let id = string_at(block, &["id"]).ok_or_else(|| {
                    format!(
                        "assistant {block_type} block {index} omitted id at sequence {}",
                        envelope.sequence
                    )
                })?;
                let name = string_at(block, &["name"]).ok_or_else(|| {
                    format!(
                        "assistant {block_type} block {index} omitted name at sequence {}",
                        envelope.sequence
                    )
                })?;
                let input = block.get("input").cloned().ok_or_else(|| {
                    format!(
                        "assistant {block_type} block {index} omitted input at sequence {}",
                        envelope.sequence
                    )
                })?;
                self.tool_names.insert(id.clone(), name.clone());
                let advisor = if block_type == "server_tool_use" && name == "advisor" {
                    Some(advisor_invocation_presentation(
                        &input,
                        &format!(
                            "assistant advisor server_tool_use block {index} at sequence {}",
                            envelope.sequence
                        ),
                    )?)
                } else {
                    None
                };
                self.upsert_final_item_with_presentation(
                    key,
                    ProjectedKind::ToolUse,
                    if advisor.is_some() { "Advising" } else { &name },
                    pretty_json(&input),
                    envelope.sequence,
                    Some(id),
                    ProjectedPresentation {
                        assistant_block: Some(match block_type.as_str() {
                            "tool_use" => AssistantBlockType::ToolUse,
                            "server_tool_use" => AssistantBlockType::ServerToolUse,
                            "mcp_tool_use" => AssistantBlockType::McpToolUse,
                            _ => unreachable!("the match arm validated the block type"),
                        }),
                        tool: Some(ToolPresentation {
                            name: Some(name.clone()),
                            input: Some(input),
                            partial_input_json: None,
                            lifecycle_output: None,
                            result: None,
                            is_error: None,
                        }),
                        advisor,
                        ..ProjectedPresentation::default()
                    },
                );
            }
            "web_search_tool_result"
            | "web_fetch_tool_result"
            | "code_execution_tool_result"
            | "bash_code_execution_tool_result"
            | "text_editor_code_execution_tool_result"
            | "tool_search_tool_result"
            | "mcp_tool_result"
            | "container_upload"
            | "advisor_tool_result" => {
                let (tool_use_id, result, is_error) = assistant_result_fields(
                    &block_type,
                    block,
                    &format!("assistant block {index} at sequence {}", envelope.sequence),
                )?;
                let name = tool_use_id
                    .as_ref()
                    .and_then(|id| self.tool_names.get(id))
                    .cloned();
                let advisor = if block_type == "advisor_tool_result" {
                    Some(advisor_result_presentation(
                        block,
                        &format!("assistant block {index} at sequence {}", envelope.sequence),
                    )?)
                } else {
                    None
                };
                if let (Some(tool_use_id), Some(AdvisorPresentation::Result(advisor_result))) =
                    (tool_use_id.as_deref(), advisor.as_ref())
                {
                    self.resolve_advisor_invocation(tool_use_id, advisor_result);
                }
                let tool = Some(ToolPresentation {
                    name: name.or_else(|| Some(result_tool_name(&block_type))),
                    input: None,
                    partial_input_json: None,
                    lifecycle_output: None,
                    result,
                    is_error,
                });
                let result_title = if advisor.is_some() {
                    "Advisor feedback".to_string()
                } else {
                    block_type.replace('_', " ")
                };
                self.upsert_final_item_with_presentation(
                    key,
                    ProjectedKind::ToolResult,
                    &result_title,
                    if block_type == "advisor_tool_result" {
                        advisor_result_text(block)?
                    } else {
                        content_to_text(block.get("content"))?
                    },
                    envelope.sequence,
                    tool_use_id,
                    ProjectedPresentation {
                        assistant_block: Some(
                            assistant_result_block_type(&block_type).ok_or_else(|| {
                                format!(
                                    "assistant result block `{block_type}` lacks a typed projection"
                                )
                            })?,
                        ),
                        tool,
                        advisor,
                        ..ProjectedPresentation::default()
                    },
                );
            }
            "compaction" => {
                validate_compaction_block(
                    block,
                    &format!(
                        "assistant compaction block {index} at sequence {}",
                        envelope.sequence
                    ),
                )?;
            }
            _ => {
                self.record_compatibility(
                    envelope.sequence,
                    ProjectionCompatibilityKind::UnknownPresentation,
                    None,
                    None,
                    format!(
                        "Unsupported assistant presentation block `{block_type}` was retained without stopping the backend"
                    ),
                    true,
                );
            }
        }
        Ok(())
    }

    fn project_result(&mut self, envelope: &RawEnvelope) -> Result<ProjectionEffect, String> {
        let value = &envelope.value;
        validate_sdk_identity(value, "result", envelope)?;
        self.observe_session(value);
        let subtype = validate_required_enum_at(
            value,
            &["subtype"],
            &[
                "success",
                "error_during_execution",
                "error_max_turns",
                "error_max_budget_usd",
                "error_max_structured_output_retries",
            ],
            "result",
            envelope,
        )?;
        for field in [
            "duration_ms",
            "duration_api_ms",
            "num_turns",
            "total_cost_usd",
        ] {
            required_number_at(value, &[field], "result", envelope)?;
        }
        let is_error = required_bool_at(value, &["is_error"], "result", envelope)?;
        required_nullable_string_at(value, &["stop_reason"], "result", envelope)?;
        if value.get("usage").is_none() {
            return Err(format!(
                "result omitted usage at sequence {}",
                envelope.sequence
            ));
        }
        let model_usage = required_object_at(value, &["modelUsage"], "result", envelope)?;
        for (model, usage) in model_usage {
            let usage = usage.as_object().ok_or_else(|| {
                format!(
                    "result modelUsage.{model} is not an object at sequence {}",
                    envelope.sequence
                )
            })?;
            for field in [
                "inputTokens",
                "outputTokens",
                "cacheReadInputTokens",
                "cacheCreationInputTokens",
                "webSearchRequests",
                "costUSD",
                "contextWindow",
                "maxOutputTokens",
            ] {
                if !usage.get(field).is_some_and(Value::is_number) {
                    return Err(format!(
                        "result modelUsage.{model} omitted number {field} at sequence {}",
                        envelope.sequence
                    ));
                }
            }
        }
        let denials = required_array_at(value, &["permission_denials"], "result", envelope)?;
        for (index, denial) in denials.iter().enumerate() {
            let denial = denial.as_object().ok_or_else(|| {
                format!(
                    "result permission_denials[{index}] is not an object at sequence {}",
                    envelope.sequence
                )
            })?;
            for field in ["tool_name", "tool_use_id"] {
                if !denial.get(field).is_some_and(Value::is_string) {
                    return Err(format!(
                        "result permission_denials[{index}] omitted string {field} at sequence {}",
                        envelope.sequence
                    ));
                }
            }
            if !denial.get("tool_input").is_some_and(Value::is_object) {
                return Err(format!(
                    "result permission_denials[{index}] omitted object tool_input at sequence {}",
                    envelope.sequence
                ));
            }
        }
        validate_optional_enum_at(
            value,
            &["fast_mode_state"],
            &["off", "cooldown", "on"],
            "result",
            envelope,
        )?;
        if subtype == "success" {
            required_string_at(value, &["result"], "successful result", envelope)?;
        } else {
            required_string_array_at(value, &["errors"], "error result", envelope)?;
        }
        // `result` is the authoritative end of the direct model-request
        // lifecycle. Retaining the previous Responding/ToolUse phase lets a
        // later task_notification re-open a foreground spinner even though it
        // belongs to an idle-surviving watcher.
        self.direct_stream_activity = DirectStreamActivityState {
            phase: DirectStreamActivityPhase::Idle,
            ttft_ms: self.direct_stream_activity.ttft_ms.clone(),
            raw_sequence: Some(envelope.sequence),
            turn_generation: self.direct_stream_activity.turn_generation,
            request_started_sequence: None,
        };
        Ok(ProjectionEffect::TurnCompleted {
            subtype,
            is_error,
            raw_sequence: envelope.sequence,
        })
    }

    fn project_direct_system(
        &mut self,
        envelope: &RawEnvelope,
        subtype: &DirectSystemSubtype,
    ) -> Result<(), String> {
        let direct = project_direct_system_presentation(&envelope.value, subtype, envelope)?;
        if let DirectSystemData::StopHookSummary {
            hook_count,
            tool_use_id: Some(tool_use_id),
            ..
        } = &direct.data
        {
            self.observe_direct_stop_hook_summary(envelope, tool_use_id, hook_count)?;
        }
        let level = projected_system_level(&envelope.value, "direct query system message")?;
        self.append_item(ProjectedItem {
            key: envelope_key(envelope, "direct-system", 0),
            kind: ProjectedKind::System,
            title: "Historical system record".to_string(),
            text: pretty_json(&envelope.value),
            streaming: false,
            raw_sequences: vec![envelope.sequence],
            tool_use_id: None,
            presentation: ProjectedPresentation {
                system: Some(SystemPresentation {
                    subtype: ProjectedSystemSubtype::Historical(subtype.as_str().to_string()),
                    level,
                    direct: Some(direct),
                }),
                ..ProjectedPresentation::default()
            },
        });
        Ok(())
    }

    fn project_system(
        &mut self,
        envelope: &RawEnvelope,
        subtype: &SystemSubtype,
    ) -> Result<ProjectionEffect, String> {
        let value = &envelope.value;
        validate_sdk_identity(value, "SDK system envelope", envelope)?;
        self.observe_session(value);
        let presentation = ProjectedPresentation {
            system: Some(SystemPresentation {
                subtype: ProjectedSystemSubtype::Sdk(subtype.clone()),
                level: projected_system_level(value, "SDK system envelope")?,
                direct: None,
            }),
            ..ProjectedPresentation::default()
        };
        match subtype {
            SystemSubtype::Init => {
                validate_required_enum_at(
                    value,
                    &["apiKeySource"],
                    &[
                        "ACOSMI_API_KEY",
                        "apiKeyHelper",
                        "/login managed key",
                        "none",
                    ],
                    "system:init",
                    envelope,
                )?;
                required_string_at(value, &["crab_code_version"], "system:init", envelope)?;
                let cwd = required_string_at(value, &["cwd"], "system:init", envelope)?;
                let model = required_string_at(value, &["model"], "system:init", envelope)?;
                let permission_mode = validate_required_enum_at(
                    value,
                    &["permissionMode"],
                    &[
                        "default",
                        "acceptEdits",
                        "bypassPermissions",
                        "plan",
                        "dontAsk",
                        "auto",
                    ],
                    "system:init",
                    envelope,
                )?;
                required_string_at(value, &["output_style"], "system:init", envelope)?;
                for field in ["tools", "slash_commands", "skills"] {
                    required_string_array_at(value, &[field], "system:init", envelope)?;
                }
                for field in ["agents", "betas"] {
                    if value.get(field).is_some() {
                        required_string_array_at(value, &[field], "system:init", envelope)?;
                    }
                }
                let mcp_servers =
                    required_array_at(value, &["mcp_servers"], "system:init", envelope)?;
                validate_object_array_string_fields(
                    mcp_servers,
                    &["name", "status"],
                    &[],
                    &format!("system:init mcp_servers at sequence {}", envelope.sequence),
                )?;
                let plugins = required_array_at(value, &["plugins"], "system:init", envelope)?;
                validate_object_array_string_fields(
                    plugins,
                    &["name", "path"],
                    &["source"],
                    &format!("system:init plugins at sequence {}", envelope.sequence),
                )?;
                validate_optional_enum_at(
                    value,
                    &["fast_mode_state"],
                    &["off", "cooldown", "on"],
                    "system:init",
                    envelope,
                )?;
                self.cwd = Some(cwd);
                self.model = Some(model);
                self.permission_mode = Some(permission_mode);
                Ok(ProjectionEffect::Initialized {
                    session_id: self.session_id.clone(),
                    cwd: self.cwd.clone(),
                    model: self.model.clone(),
                    permission_mode: self.permission_mode.clone(),
                })
            }
            SystemSubtype::Status => {
                if let Some(mode) = validate_optional_enum_at(
                    value,
                    &["permissionMode"],
                    &[
                        "default",
                        "acceptEdits",
                        "bypassPermissions",
                        "plan",
                        "dontAsk",
                        "auto",
                    ],
                    "status",
                    envelope,
                )? {
                    self.permission_mode = Some(mode);
                }
                let status_value = value
                    .get("status")
                    .ok_or_else(|| "status envelope omitted status".to_string())?;
                match status_value {
                    Value::Null => {}
                    Value::String(status)
                        if matches!(
                            status.as_str(),
                            "compacting" | "processing_background_task"
                        ) => {}
                    _ => {
                        return Err(format!(
                            "status envelope has unsupported status at sequence {}",
                            envelope.sequence
                        ));
                    }
                }
                let status = value_to_inline_text(status_value);
                self.append_system_once(envelope, "Status", status, presentation);
                Ok(ProjectionEffect::None)
            }
            SystemSubtype::SessionStateChanged => {
                let state = validate_required_enum_at(
                    value,
                    &["state"],
                    &["idle", "running", "requires_action"],
                    "session_state_changed",
                    envelope,
                )?;
                self.session_state = Some(state.clone());
                self.append_system_once(envelope, "Session", state.clone(), presentation);
                Ok(ProjectionEffect::SessionStateChanged(state))
            }
            SystemSubtype::LocalCommandOutput => {
                let content =
                    required_string_at(value, &["content"], "local_command_output", envelope)?;
                self.append_item(ProjectedItem {
                    key: envelope_key(envelope, "local-command", 0),
                    kind: ProjectedKind::TerminalOutput,
                    title: "Local command".to_string(),
                    text: content,
                    streaming: false,
                    raw_sequences: vec![envelope.sequence],
                    tool_use_id: None,
                    presentation,
                });
                Ok(ProjectionEffect::None)
            }
            SystemSubtype::HookStarted => {
                required_string_at(value, &["hook_id"], "hook_started", envelope)?;
                let hook_name =
                    required_string_at(value, &["hook_name"], "hook_started", envelope)?;
                let hook_event =
                    required_string_at(value, &["hook_event"], "hook_started", envelope)?;
                self.append_system_once(
                    envelope,
                    "Hook started",
                    format!("{hook_name} · {hook_event}"),
                    presentation,
                );
                Ok(ProjectionEffect::None)
            }
            SystemSubtype::HookProgress => {
                let hook_id = required_string_at(value, &["hook_id"], "hook_progress", envelope)?;
                let hook_name =
                    required_string_at(value, &["hook_name"], "hook_progress", envelope)?;
                let hook_event =
                    required_string_at(value, &["hook_event"], "hook_progress", envelope)?;
                required_string_at(value, &["output"], "hook_progress", envelope)?;
                required_string_at(value, &["stdout"], "hook_progress", envelope)?;
                required_string_at(value, &["stderr"], "hook_progress", envelope)?;
                self.append_item(ProjectedItem {
                    key: format!("hook:{hook_id}"),
                    kind: ProjectedKind::TerminalOutput,
                    title: format!("{hook_name} · {hook_event}"),
                    text: join_present(value, &["output", "stdout", "stderr"], "\n"),
                    streaming: true,
                    raw_sequences: vec![envelope.sequence],
                    tool_use_id: None,
                    presentation,
                });
                Ok(ProjectionEffect::None)
            }
            SystemSubtype::HookResponse => {
                let hook_id = required_string_at(value, &["hook_id"], "hook_response", envelope)?;
                let hook_name =
                    required_string_at(value, &["hook_name"], "hook_response", envelope)?;
                let hook_event =
                    required_string_at(value, &["hook_event"], "hook_response", envelope)?;
                required_string_at(value, &["output"], "hook_response", envelope)?;
                required_string_at(value, &["stdout"], "hook_response", envelope)?;
                required_string_at(value, &["stderr"], "hook_response", envelope)?;
                optional_number_at(value, &["exit_code"], "hook_response", envelope)?;
                let outcome = required_string_at(value, &["outcome"], "hook_response", envelope)?;
                if !matches!(outcome.as_str(), "success" | "error" | "cancelled") {
                    return Err(format!(
                        "hook_response has unsupported outcome `{outcome}` at sequence {}",
                        envelope.sequence
                    ));
                }
                self.upsert_final_item_with_presentation(
                    format!("hook:{hook_id}"),
                    if outcome == "success" {
                        ProjectedKind::TerminalOutput
                    } else {
                        ProjectedKind::Error
                    },
                    &format!("{hook_name} · {hook_event} · {outcome}"),
                    join_present(value, &["output", "stdout", "stderr"], "\n"),
                    envelope.sequence,
                    None,
                    presentation,
                );
                Ok(ProjectionEffect::None)
            }
            SystemSubtype::TaskStarted
            | SystemSubtype::TaskProgress
            | SystemSubtype::TaskNotification => {
                let task_id = required_string_at(value, &["task_id"], "task event", envelope)?;
                let tool_use_id =
                    optional_string_at(value, &["tool_use_id"], "task event", envelope)?;
                match subtype {
                    SystemSubtype::TaskStarted => {
                        required_string_at(value, &["description"], "task_started", envelope)?;
                        optional_string_at(value, &["task_type"], "task_started", envelope)?;
                        optional_string_at(value, &["workflow_name"], "task_started", envelope)?;
                        optional_string_at(value, &["prompt"], "task_started", envelope)?;
                    }
                    SystemSubtype::TaskProgress => {
                        required_string_at(value, &["description"], "task_progress", envelope)?;
                        validate_task_usage(value, true, "task_progress", envelope)?;
                        optional_string_at(value, &["last_tool_name"], "task_progress", envelope)?;
                        optional_string_at(value, &["summary"], "task_progress", envelope)?;
                    }
                    SystemSubtype::TaskNotification => {
                        let status =
                            required_string_at(value, &["status"], "task_notification", envelope)?;
                        if !matches!(status.as_str(), "completed" | "failed" | "stopped") {
                            return Err(format!(
                                "task_notification has unsupported status `{status}` at sequence {}",
                                envelope.sequence
                            ));
                        }
                        required_string_at(value, &["output_file"], "task_notification", envelope)?;
                        required_string_at(value, &["summary"], "task_notification", envelope)?;
                        validate_task_usage(value, false, "task_notification", envelope)?;
                    }
                    _ => unreachable!("the outer match restricts task subtypes"),
                }
                let terminal = matches!(subtype, SystemSubtype::TaskNotification);
                let title = match subtype {
                    SystemSubtype::TaskStarted => "Task started",
                    SystemSubtype::TaskProgress => "Task progress",
                    SystemSubtype::TaskNotification => {
                        match value.get("status").and_then(serde_json::Value::as_str) {
                            Some("completed") => "Task completed",
                            Some("failed") => "Task failed",
                            Some("stopped") => "Task stopped",
                            _ => unreachable!("task_notification status was validated above"),
                        }
                    }
                    _ => unreachable!("the outer match restricts task subtypes"),
                };
                let text = join_present(
                    value,
                    &[
                        "description",
                        "summary",
                        "status",
                        "output_file",
                        "last_tool_name",
                    ],
                    "\n",
                );
                let key = format!("task:{task_id}");
                if terminal {
                    self.upsert_final_item_with_presentation(
                        key,
                        ProjectedKind::Progress,
                        title,
                        text,
                        envelope.sequence,
                        tool_use_id,
                        presentation,
                    );
                } else {
                    self.upsert_stream_item_with_presentation(
                        key,
                        ProjectedKind::Progress,
                        title,
                        text,
                        envelope.sequence,
                        tool_use_id,
                        presentation,
                    );
                }
                Ok(ProjectionEffect::None)
            }
            SystemSubtype::FilesPersisted => {
                let files = required_array_at(value, &["files"], "files_persisted", envelope)?;
                validate_object_array_string_fields(
                    files,
                    &["filename", "file_id"],
                    &[],
                    &format!("files_persisted files at sequence {}", envelope.sequence),
                )?;
                let failed = required_array_at(value, &["failed"], "files_persisted", envelope)?;
                validate_object_array_string_fields(
                    failed,
                    &["filename", "error"],
                    &[],
                    &format!("files_persisted failed at sequence {}", envelope.sequence),
                )?;
                required_string_at(value, &["processed_at"], "files_persisted", envelope)?;
                self.append_system_once(
                    envelope,
                    "Files persisted",
                    format!("{} succeeded · {} failed", files.len(), failed.len()),
                    presentation,
                );
                Ok(ProjectionEffect::None)
            }
            SystemSubtype::ApiRetry => {
                required_number_at(value, &["attempt"], "api_retry", envelope)?;
                required_number_at(value, &["max_retries"], "api_retry", envelope)?;
                required_number_at(value, &["retry_delay_ms"], "api_retry", envelope)?;
                match value.get("error_status") {
                    Some(Value::Null | Value::Number(_)) => {}
                    Some(_) => {
                        return Err(format!(
                            "api_retry has non-number/non-null error_status at sequence {}",
                            envelope.sequence
                        ));
                    }
                    None => {
                        return Err(format!(
                            "api_retry omitted error_status at sequence {}",
                            envelope.sequence
                        ));
                    }
                }
                validate_required_enum_at(
                    value,
                    &["error"],
                    &[
                        "authentication_failed",
                        "billing_error",
                        "rate_limit",
                        "invalid_request",
                        "server_error",
                        "unknown",
                        "max_output_tokens",
                    ],
                    "api_retry",
                    envelope,
                )?;
                self.append_item(ProjectedItem {
                    key: envelope_key(envelope, "api-retry", 0),
                    kind: ProjectedKind::Warning,
                    title: "API retry".to_string(),
                    text: join_present(
                        value,
                        &[
                            "error",
                            "attempt",
                            "max_retries",
                            "retry_delay_ms",
                            "error_status",
                        ],
                        " · ",
                    ),
                    streaming: false,
                    raw_sequences: vec![envelope.sequence],
                    tool_use_id: None,
                    presentation,
                });
                Ok(ProjectionEffect::None)
            }
            SystemSubtype::PostTurnSummary => {
                required_string_at(value, &["summarizes_uuid"], "post_turn_summary", envelope)?;
                validate_required_enum_at(
                    value,
                    &["status_category"],
                    &["blocked", "waiting", "completed", "review_ready", "failed"],
                    "post_turn_summary",
                    envelope,
                )?;
                for field in [
                    "status_detail",
                    "title",
                    "description",
                    "recent_action",
                    "needs_action",
                ] {
                    required_string_at(value, &[field], "post_turn_summary", envelope)?;
                }
                required_bool_at(value, &["is_noteworthy"], "post_turn_summary", envelope)?;
                required_string_array_at(value, &["artifact_urls"], "post_turn_summary", envelope)?;
                self.append_system_once(
                    envelope,
                    &join_present(value, &["title", "status_category"], " · "),
                    join_present(
                        value,
                        &[
                            "description",
                            "status_detail",
                            "recent_action",
                            "needs_action",
                        ],
                        "\n",
                    ),
                    presentation,
                );
                Ok(ProjectionEffect::None)
            }
            SystemSubtype::CompactBoundary => {
                let metadata =
                    required_object_at(value, &["compact_metadata"], "compact_boundary", envelope)?;
                validate_required_enum_at(
                    value,
                    &["compact_metadata", "trigger"],
                    &["manual", "auto"],
                    "compact_boundary",
                    envelope,
                )?;
                required_number_at(
                    value,
                    &["compact_metadata", "pre_tokens"],
                    "compact_boundary",
                    envelope,
                )?;
                if metadata.get("preserved_segment").is_some() {
                    required_object_at(
                        value,
                        &["compact_metadata", "preserved_segment"],
                        "compact_boundary",
                        envelope,
                    )?;
                    for field in ["head_uuid", "anchor_uuid", "tail_uuid"] {
                        required_string_at(
                            value,
                            &["compact_metadata", "preserved_segment", field],
                            "compact_boundary",
                            envelope,
                        )?;
                    }
                }
                self.append_system_once(
                    envelope,
                    "Context compacted",
                    required_string_at(
                        value,
                        &["compact_metadata", "trigger"],
                        "compact_boundary",
                        envelope,
                    )?,
                    presentation,
                );
                Ok(ProjectionEffect::None)
            }
            SystemSubtype::ElicitationComplete => {
                let server = required_string_at(
                    value,
                    &["mcp_server_name"],
                    "elicitation_complete",
                    envelope,
                )?;
                let id = required_string_at(
                    value,
                    &["elicitation_id"],
                    "elicitation_complete",
                    envelope,
                )?;
                self.append_system_once(
                    envelope,
                    "MCP elicitation complete",
                    format!("{server} · {id}"),
                    presentation,
                );
                Ok(ProjectionEffect::None)
            }
        }
    }

    fn project_stream_event(
        &mut self,
        envelope: &RawEnvelope,
        declared_type: Option<&str>,
    ) -> Result<ProjectionEffect, String> {
        // SDK/session identity is an authority boundary and is validated
        // before the presentation event discriminator. Its failures remain
        // protocol-fatal instead of being downgraded by a stream policy.
        let context = match stream_context(&envelope.value, envelope) {
            Ok(context) => context,
            Err(reason) => {
                return Ok(ProjectionEffect::FailClosed {
                    sequence: envelope.sequence,
                    reason,
                });
            }
        };
        let Some(event) = envelope.value.get("event") else {
            return Ok(ProjectionEffect::AbortTurn {
                sequence: envelope.sequence,
                code: "stream_event_missing".to_string(),
                reason: "stream_event omitted event".to_string(),
            });
        };
        let Some(event_type) = event.get("type").and_then(Value::as_str) else {
            return Ok(ProjectionEffect::AbortTurn {
                sequence: envelope.sequence,
                code: "stream_event_type_missing".to_string(),
                reason: "stream_event omitted string event.type".to_string(),
            });
        };
        if declared_type != Some(event_type) {
            return Ok(ProjectionEffect::FailClosed {
                sequence: envelope.sequence,
                reason: format!(
                    "stream_event classification disagrees with event.type at sequence {}",
                    envelope.sequence
                ),
            });
        }
        let mut effect = ProjectionEffect::None;
        match event_type {
            "message_start" => {
                let message_id = event
                    .pointer("/message/id")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .ok_or_else(|| {
                        format!(
                            "stream message_start omitted message.id at sequence {}",
                            envelope.sequence
                        )
                    })?;
                if let Some(active) = self.active_message_by_context.get(&context).cloned() {
                    if active == message_id {
                        self.record_compatibility(
                            envelope.sequence,
                            ProjectionCompatibilityKind::StreamReplay,
                            None,
                            None,
                            format!(
                                "deduplicated replayed stream message_start for `{message_id}`"
                            ),
                            false,
                        );
                    } else {
                        self.record_compatibility(
                            envelope.sequence,
                            ProjectionCompatibilityKind::StreamOverlap,
                            None,
                            None,
                            format!(
                                "stream message_start for `{message_id}` replaced still-active message `{active}`; the previous renderer generation was finalized without stopping the backend"
                            ),
                            true,
                        );
                        let stale_slots = self
                            .stream_blocks
                            .keys()
                            .filter(|slot| slot.context == context && slot.message_id == active)
                            .cloned()
                            .collect::<Vec<_>>();
                        for slot in stale_slots {
                            self.finalize_stream_slot(&slot, envelope.sequence);
                        }
                    }
                }
                self.active_message_by_context
                    .insert(context.clone(), message_id);
            }
            "content_block_start" => {
                let index = u64_at(event, &["index"]).ok_or_else(|| {
                    format!(
                        "stream content_block_start omitted index at sequence {}",
                        envelope.sequence
                    )
                })?;
                let message_id = self.stream_message_id(event, &context, envelope.sequence)?;
                let block = event.get("content_block").ok_or_else(|| {
                    format!(
                        "stream content_block_start omitted content_block at sequence {}",
                        envelope.sequence
                    )
                })?;
                let block_type = string_at(block, &["type"]).ok_or_else(|| {
                    format!(
                        "stream content_block_start omitted content_block.type at sequence {}",
                        envelope.sequence
                    )
                })?;
                let slot = StreamBlockSlot {
                    context: context.clone(),
                    message_id: message_id.clone(),
                    index,
                };
                if let Some(active) = self.stream_blocks.get(&slot).cloned() {
                    if active.start_payload == *block {
                        if !active.item_key.is_empty()
                            && let Some(item) = self.item_mut_metadata(&active.item_key)
                            && !item.raw_sequences.contains(&envelope.sequence)
                        {
                            item.raw_sequences.push(envelope.sequence);
                        }
                        self.record_compatibility(
                            envelope.sequence,
                            ProjectionCompatibilityKind::StreamReplay,
                            Some(&slot),
                            Some(active.key.generation),
                            format!(
                                "deduplicated replayed content_block_start for message `{message_id}` source index {index} generation {}",
                                active.key.generation
                            ),
                            false,
                        );
                        if context == StreamContext::DirectQuery {
                            self.observe_direct_stream_event_activity(event_type, event, envelope)?;
                        }
                        return Ok(ProjectionEffect::None);
                    }

                    self.record_compatibility(
                        envelope.sequence,
                        ProjectionCompatibilityKind::StreamOverlap,
                        Some(&slot),
                        Some(active.key.generation),
                        format!(
                            "conflicting content_block_start overlapped active message `{message_id}` source index {index}; finalized generation {} and opened a compatibility generation without stopping the backend",
                            active.key.generation
                        ),
                        true,
                    );
                    self.finalize_stream_slot(&slot, envelope.sequence);
                }
                let Some(assistant_block) = assistant_block_type(&block_type) else {
                    let key = self.allocate_stream_key(&slot);
                    let item_key = stream_item_key(&key);
                    self.stream_blocks.insert(
                        slot.clone(),
                        StreamBlockState {
                            key: key.clone(),
                            block_type: block_type.clone(),
                            item_key: item_key.clone(),
                            start_payload: block.clone(),
                            started_sequence: envelope.sequence,
                            reconciled: false,
                        },
                    );
                    self.append_item(ProjectedItem {
                        key: item_key,
                        kind: ProjectedKind::System,
                        title: "Renderer compatibility".to_string(),
                        text: format!(
                            "Unsupported stream content block `{block_type}` is retained for a future renderer update"
                        ),
                        streaming: true,
                        raw_sequences: vec![envelope.sequence],
                        tool_use_id: None,
                        presentation: ProjectedPresentation {
                            plain_system: true,
                            ..ProjectedPresentation::default()
                        },
                    });
                    self.record_compatibility(
                        envelope.sequence,
                        ProjectionCompatibilityKind::UnknownPresentation,
                        Some(&slot),
                        Some(key.generation),
                        format!(
                            "Unsupported stream content block `{block_type}` retained without stopping the backend"
                        ),
                        false,
                    );
                    if context == StreamContext::DirectQuery {
                        self.observe_direct_stream_event_activity(event_type, event, envelope)?;
                    }
                    return Ok(ProjectionEffect::None);
                };
                let mut tool_use_id = string_at(block, &["tool_use_id"]);
                let mut title = stream_title(&block_type).to_string();
                let (initial, presentation) = match block_type.as_str() {
                    "text" => {
                        string_at(block, &["text"]).ok_or_else(|| {
                            format!(
                                "stream text block omitted text at sequence {}",
                                envelope.sequence
                            )
                        })?;
                        (
                            String::new(),
                            ProjectedPresentation {
                                assistant_block: Some(assistant_block),
                                ..ProjectedPresentation::default()
                            },
                        )
                    }
                    "connector_text" => (
                        connector_text_projection(
                            block,
                            &format!(
                                "stream connector_text block at sequence {}",
                                envelope.sequence
                            ),
                        )?,
                        ProjectedPresentation {
                            assistant_block: Some(assistant_block),
                            ..ProjectedPresentation::default()
                        },
                    ),
                    "thinking" => {
                        string_at(block, &["thinking"]).ok_or_else(|| {
                            format!(
                                "stream thinking block omitted thinking at sequence {}",
                                envelope.sequence
                            )
                        })?;
                        string_at(block, &["signature"]).ok_or_else(|| {
                            format!(
                                "stream thinking block omitted signature at sequence {}",
                                envelope.sequence
                            )
                        })?;
                        (
                            String::new(),
                            ProjectedPresentation {
                                assistant_block: Some(assistant_block),
                                thinking: Some(ThinkingPresentation {
                                    kind: ThinkingKind::Thinking,
                                    content: String::new(),
                                    signature: Some(String::new()),
                                }),
                                ..ProjectedPresentation::default()
                            },
                        )
                    }
                    "redacted_thinking" => {
                        let content = string_at(block, &["data"]).ok_or_else(|| {
                            format!(
                                "stream redacted_thinking block omitted data at sequence {}",
                                envelope.sequence
                            )
                        })?;
                        (
                            content.clone(),
                            ProjectedPresentation {
                                assistant_block: Some(assistant_block),
                                thinking: Some(ThinkingPresentation {
                                    kind: ThinkingKind::Redacted,
                                    content,
                                    signature: None,
                                }),
                                ..ProjectedPresentation::default()
                            },
                        )
                    }
                    "tool_use" | "server_tool_use" | "mcp_tool_use" => {
                        let id = string_at(block, &["id"]).ok_or_else(|| {
                            format!(
                                "stream {block_type} block omitted id at sequence {}",
                                envelope.sequence
                            )
                        })?;
                        let name = string_at(block, &["name"]).ok_or_else(|| {
                            format!(
                                "stream {block_type} block omitted name at sequence {}",
                                envelope.sequence
                            )
                        })?;
                        let input = block.get("input").cloned().ok_or_else(|| {
                            format!(
                                "stream {block_type} block omitted input at sequence {}",
                                envelope.sequence
                            )
                        })?;
                        self.tool_names.insert(id.clone(), name.clone());
                        tool_use_id = Some(id);
                        let advisor = if block_type == "server_tool_use" && name == "advisor" {
                            Some(advisor_invocation_presentation(
                                &input,
                                &format!(
                                    "stream advisor server_tool_use block at sequence {}",
                                    envelope.sequence
                                ),
                            )?)
                        } else {
                            None
                        };
                        if advisor.is_some() {
                            title = "Advising".to_string();
                        } else {
                            title.clone_from(&name);
                        }
                        let delta_assembled =
                            matches!(block_type.as_str(), "tool_use" | "server_tool_use");
                        (
                            if delta_assembled || input.is_null() {
                                String::new()
                            } else {
                                pretty_json(&input)
                            },
                            ProjectedPresentation {
                                assistant_block: Some(assistant_block),
                                tool: Some(ToolPresentation {
                                    name: Some(name),
                                    input: (!delta_assembled).then_some(input),
                                    partial_input_json: delta_assembled.then(String::new),
                                    lifecycle_output: None,
                                    result: None,
                                    is_error: None,
                                }),
                                advisor,
                                ..ProjectedPresentation::default()
                            },
                        )
                    }
                    "web_search_tool_result"
                    | "web_fetch_tool_result"
                    | "code_execution_tool_result"
                    | "bash_code_execution_tool_result"
                    | "text_editor_code_execution_tool_result"
                    | "tool_search_tool_result"
                    | "mcp_tool_result"
                    | "container_upload"
                    | "advisor_tool_result" => {
                        let (validated_tool_use_id, result, is_error) = assistant_result_fields(
                            &block_type,
                            block,
                            &format!("stream block at sequence {}", envelope.sequence),
                        )?;
                        tool_use_id = validated_tool_use_id;
                        let name = tool_use_id
                            .as_ref()
                            .and_then(|id| self.tool_names.get(id))
                            .cloned();
                        let advisor = if block_type == "advisor_tool_result" {
                            Some(advisor_result_presentation(
                                block,
                                &format!("stream block at sequence {}", envelope.sequence),
                            )?)
                        } else {
                            None
                        };
                        if let (
                            Some(tool_use_id),
                            Some(AdvisorPresentation::Result(advisor_result)),
                        ) = (tool_use_id.as_deref(), advisor.as_ref())
                        {
                            self.resolve_advisor_invocation(tool_use_id, advisor_result);
                        }
                        if advisor.is_some() {
                            title = "Advisor feedback".to_string();
                        }
                        let tool = Some(ToolPresentation {
                            name: name.or_else(|| Some(result_tool_name(&block_type))),
                            input: None,
                            partial_input_json: None,
                            lifecycle_output: None,
                            result,
                            is_error,
                        });
                        (
                            if block_type == "advisor_tool_result" {
                                advisor_result_text(block)?
                            } else {
                                content_to_text(block.get("content"))?
                            },
                            ProjectedPresentation {
                                assistant_block: Some(assistant_block),
                                tool,
                                advisor,
                                ..ProjectedPresentation::default()
                            },
                        )
                    }
                    "compaction" => {
                        validate_compaction_block(
                            block,
                            &format!("stream compaction block at sequence {}", envelope.sequence),
                        )?;
                        (
                            String::new(),
                            ProjectedPresentation {
                                assistant_block: Some(assistant_block),
                                ..ProjectedPresentation::default()
                            },
                        )
                    }
                    unknown => {
                        return Err(format!(
                            "unknown stream content block type `{unknown}` at sequence {}",
                            envelope.sequence
                        ));
                    }
                };
                let key = self.allocate_stream_key(&slot);
                let generation = key.generation;
                if generation > 0 {
                    self.record_compatibility(
                        envelope.sequence,
                        ProjectionCompatibilityKind::StreamIndexReuse,
                        Some(&slot),
                        Some(generation),
                        format!(
                            "source index {index} was reused after stop for message `{message_id}`; opened renderer generation {generation}"
                        ),
                        false,
                    );
                }
                let item_key = if block_type == "compaction" {
                    String::new()
                } else {
                    stream_item_key(&key)
                };
                self.stream_blocks.insert(
                    slot,
                    StreamBlockState {
                        key: key.clone(),
                        block_type: block_type.clone(),
                        item_key: item_key.clone(),
                        start_payload: block.clone(),
                        started_sequence: envelope.sequence,
                        reconciled: false,
                    },
                );
                if block_type != "compaction" {
                    self.upsert_stream_item_with_presentation(
                        item_key,
                        stream_projected_kind(&block_type),
                        &title,
                        initial,
                        envelope.sequence,
                        tool_use_id,
                        presentation,
                    );
                }
            }
            "content_block_delta" => {
                let index = u64_at(event, &["index"]).ok_or_else(|| {
                    format!(
                        "stream content_block_delta omitted index at sequence {}",
                        envelope.sequence
                    )
                })?;
                let delta = event.get("delta").ok_or_else(|| {
                    format!(
                        "stream content_block_delta omitted delta at sequence {}",
                        envelope.sequence
                    )
                })?;
                let delta_type = string_at(delta, &["type"])
                    .ok_or_else(|| "stream content delta omitted type".to_string())?;
                if !matches!(
                    delta_type.as_str(),
                    "text_delta"
                        | "thinking_delta"
                        | "input_json_delta"
                        | "connector_text_delta"
                        | "citations_delta"
                        | "signature_delta"
                ) {
                    let possible_slot = self
                        .stream_message_id(event, &context, envelope.sequence)
                        .ok()
                        .map(|message_id| StreamBlockSlot {
                            context: context.clone(),
                            message_id,
                            index,
                        });
                    let generation = possible_slot
                        .as_ref()
                        .and_then(|slot| self.stream_blocks.get(slot))
                        .map(|state| state.key.generation);
                    self.record_compatibility(
                        envelope.sequence,
                        ProjectionCompatibilityKind::UnknownPresentation,
                        possible_slot.as_ref(),
                        generation,
                        format!(
                            "Unsupported stream delta `{delta_type}` retained without stopping the backend"
                        ),
                        true,
                    );
                    if context == StreamContext::DirectQuery {
                        self.observe_direct_stream_event_activity(event_type, event, envelope)?;
                    }
                    return Ok(ProjectionEffect::None);
                }
                let message_id = self.stream_message_id(event, &context, envelope.sequence)?;
                let slot = StreamBlockSlot {
                    context: context.clone(),
                    message_id,
                    index,
                };
                let (expected_block, chunk) = match delta_type.as_str() {
                    "text_delta" => (
                        "text",
                        string_at(delta, &["text"])
                            .ok_or_else(|| "stream text_delta omitted text".to_string())?,
                    ),
                    "thinking_delta" => (
                        "thinking",
                        string_at(delta, &["thinking"])
                            .ok_or_else(|| "stream thinking_delta omitted thinking".to_string())?,
                    ),
                    "input_json_delta" => (
                        "tool_use",
                        string_at(delta, &["partial_json"]).ok_or_else(|| {
                            "stream input_json_delta omitted partial_json".to_string()
                        })?,
                    ),
                    "connector_text_delta" => (
                        "connector_text",
                        string_at(delta, &["connector_text"]).ok_or_else(|| {
                            "stream connector_text_delta omitted connector_text".to_string()
                        })?,
                    ),
                    // The current CrabCode query pipeline explicitly accepts
                    // citation deltas without projecting them into UI text.
                    // Their complete payload remains in the raw journal.
                    "citations_delta" => ("*", String::new()),
                    // Signatures are backend integrity metadata, retained raw
                    // but never rendered as conversational text.
                    "signature_delta" => ("thinking", String::new()),
                    _ => unreachable!("the additive delta branch returned above"),
                };
                let Some(active) = self.stream_blocks.get(&slot).cloned() else {
                    self.record_compatibility(
                        envelope.sequence,
                        ProjectionCompatibilityKind::OrphanStreamEvent,
                        Some(&slot),
                        None,
                        format!(
                            "ignored stream {delta_type} without an active content block; raw event retained"
                        ),
                        true,
                    );
                    if context == StreamContext::DirectQuery {
                        self.observe_direct_stream_event_activity(event_type, event, envelope)?;
                    }
                    return Ok(ProjectionEffect::None);
                };
                let block_type = active.block_type.clone();
                if !stream_delta_matches_block(&block_type, expected_block) {
                    self.record_compatibility(
                        envelope.sequence,
                        ProjectionCompatibilityKind::StreamOverlap,
                        Some(&slot),
                        Some(active.key.generation),
                        format!(
                            "ignored stream {delta_type} that does not match active `{block_type}` generation {}; raw event retained",
                            active.key.generation
                        ),
                        true,
                    );
                    if context == StreamContext::DirectQuery {
                        self.observe_direct_stream_event_activity(event_type, event, envelope)?;
                    }
                    return Ok(ProjectionEffect::None);
                }
                let item_key = active.item_key.clone();
                self.append_stream_delta(
                    item_key.clone(),
                    stream_projected_kind(&block_type),
                    stream_title(&block_type),
                    &chunk,
                    envelope.sequence,
                )?;
                if let Some(item) = self.item_mut(&item_key) {
                    match delta_type.as_str() {
                        "thinking_delta" => {
                            let thinking =
                                item.presentation.thinking.as_mut().ok_or_else(|| {
                                    "thinking delta item lost thinking presentation metadata"
                                        .to_string()
                                })?;
                            thinking.content.push_str(&chunk);
                        }
                        "input_json_delta" => {
                            let tool = item.presentation.tool.as_mut().ok_or_else(|| {
                                "tool input delta item lost tool presentation metadata".to_string()
                            })?;
                            let partial = tool.partial_input_json.get_or_insert_with(String::new);
                            partial.push_str(&chunk);
                        }
                        "text_delta"
                        | "connector_text_delta"
                        | "citations_delta"
                        | "signature_delta" => {}
                        _ => unreachable!("delta type was validated above"),
                    }
                }
            }
            "content_block_stop" => {
                let index = u64_at(event, &["index"]).ok_or_else(|| {
                    format!(
                        "stream content_block_stop omitted index at sequence {}",
                        envelope.sequence
                    )
                })?;
                let message_id = self.stream_message_id(event, &context, envelope.sequence)?;
                let slot = StreamBlockSlot {
                    context: context.clone(),
                    message_id,
                    index,
                };
                if self.stream_blocks.contains_key(&slot) {
                    self.finalize_stream_slot(&slot, envelope.sequence);
                } else if let Some(finalized) = self
                    .finalized_stream_blocks
                    .values()
                    .filter(|state| state.key.slot == slot)
                    .max_by_key(|state| state.key.generation)
                    .cloned()
                {
                    self.record_compatibility(
                        envelope.sequence,
                        ProjectionCompatibilityKind::StreamReplay,
                        Some(&slot),
                        Some(finalized.key.generation),
                        format!(
                            "deduplicated replayed content_block_stop for generation {}",
                            finalized.key.generation
                        ),
                        false,
                    );
                    if !finalized.item_key.is_empty()
                        && let Some(item) = self.item_mut_metadata(&finalized.item_key)
                        && !item.raw_sequences.contains(&envelope.sequence)
                    {
                        item.raw_sequences.push(envelope.sequence);
                    }
                } else {
                    self.record_compatibility(
                        envelope.sequence,
                        ProjectionCompatibilityKind::OrphanStreamEvent,
                        Some(&slot),
                        None,
                        "ignored content_block_stop without an active or finalized block; raw event retained",
                        true,
                    );
                }
            }
            // The fixed historical direct TUI uses message_delta only to keep
            // its response spinner active. QueryEngine owns stop semantics,
            // and `ingest` has already retained this complete raw envelope;
            // projecting stop_reason as a transcript row would invent UI.
            "message_delta" => {}
            "error" => {
                let stream_error = parse_stream_error(event, envelope)?;
                let reason = stream_error.message.clone();
                if let Some(message_id) = self.active_message_by_context.remove(&context) {
                    self.finish_stream_message(&context, &message_id, envelope.sequence);
                }
                let active_slots = self
                    .stream_blocks
                    .keys()
                    .filter(|slot| slot.context == context)
                    .cloned()
                    .collect::<Vec<_>>();
                for slot in active_slots {
                    self.finalize_stream_slot(&slot, envelope.sequence);
                }
                self.append_item(ProjectedItem {
                    key: envelope_key(envelope, "stream-error", 0),
                    kind: ProjectedKind::Error,
                    title: "Stream error".to_string(),
                    text: stream_error.message.clone(),
                    streaming: false,
                    raw_sequences: vec![envelope.sequence],
                    tool_use_id: None,
                    presentation: ProjectedPresentation {
                        stream_error: Some(stream_error),
                        ..ProjectedPresentation::default()
                    },
                });
                effect = ProjectionEffect::AbortTurn {
                    sequence: envelope.sequence,
                    code: "upstream_stream_error".to_string(),
                    reason,
                };
            }
            "message_stop" => {
                let Some(message_id) = self.active_message_by_context.remove(&context) else {
                    self.record_compatibility(
                        envelope.sequence,
                        ProjectionCompatibilityKind::OrphanStreamEvent,
                        None,
                        None,
                        "ignored message_stop without a matching active message_start; raw event retained",
                        true,
                    );
                    if context == StreamContext::DirectQuery {
                        self.observe_direct_stream_event_activity(event_type, event, envelope)?;
                    }
                    return Ok(ProjectionEffect::None);
                };
                self.finish_stream_message(&context, &message_id, envelope.sequence);
            }
            // CrabCode's source stream-event union declares `ping` as a
            // payload-free heartbeat. The complete envelope is already in the
            // raw journal; it must not create conversational transcript text.
            "ping" => {}
            // Empty search provenance is a legal zero-result presentation
            // event. It is intentionally inert: no transcript row, activity,
            // TTFT, token, or turn-state mutation. A malformed payload is
            // retained as bounded compatibility evidence and also remains
            // non-fatal. Only a non-empty, valid event reaches the ordinary
            // direct-query activity update below.
            "sources" => match validate_stream_sources_event(event) {
                SourcesEventValidation::Empty => return Ok(ProjectionEffect::None),
                SourcesEventValidation::Valid => {}
                SourcesEventValidation::Malformed(code) => {
                    self.record_compatibility(
                        envelope.sequence,
                        ProjectionCompatibilityKind::MalformedPresentation,
                        None,
                        None,
                        format!("ignored malformed sources event ({code})"),
                        false,
                    );
                    return Ok(ProjectionEffect::CompatibilityFault {
                        sequence: envelope.sequence,
                        event_type: "sources".to_string(),
                        code: code.to_string(),
                    });
                }
            },
            unknown => {
                self.record_compatibility(
                    envelope.sequence,
                    ProjectionCompatibilityKind::UnknownPresentation,
                    None,
                    None,
                    format!(
                        "Unsupported stream event `{unknown}` retained without stopping the backend"
                    ),
                    false,
                );
                return Ok(ProjectionEffect::CompatibilityFault {
                    sequence: envelope.sequence,
                    event_type: unknown.to_string(),
                    code: "unknown_stream_event".to_string(),
                });
            }
        }
        if context == StreamContext::DirectQuery {
            self.observe_direct_stream_event_activity(event_type, event, envelope)?;
        }
        Ok(effect)
    }

    fn finish_stream_message(&mut self, context: &StreamContext, message_id: &str, sequence: u64) {
        let item_keys = self
            .items
            .iter()
            .filter(|item| item.key.starts_with(&format!("assistant:{message_id}:")))
            .map(|item| item.key.clone())
            .collect::<Vec<_>>();
        for key in item_keys {
            if let Some(item) = self.item_mut(&key) {
                item.streaming = false;
                if !item.raw_sequences.contains(&sequence) {
                    item.raw_sequences.push(sequence);
                }
            }
        }
        let active_slots = self
            .stream_blocks
            .keys()
            .filter(|slot| &slot.context == context && slot.message_id == message_id)
            .cloned()
            .collect::<Vec<_>>();
        for slot in active_slots {
            self.finalize_stream_slot(&slot, sequence);
        }
    }

    fn project_tool_progress(&mut self, envelope: &RawEnvelope) -> Result<(), String> {
        let value = &envelope.value;
        validate_sdk_identity(value, "tool_progress", envelope)?;
        let id = string_at(value, &["tool_use_id"]).ok_or_else(|| {
            format!(
                "tool_progress omitted tool_use_id at sequence {}",
                envelope.sequence
            )
        })?;
        let name = string_at(value, &["tool_name"]).ok_or_else(|| {
            format!(
                "tool_progress omitted tool_name at sequence {}",
                envelope.sequence
            )
        })?;
        required_nullable_string_at(value, &["parent_tool_use_id"], "tool_progress", envelope)?;
        required_number_at(value, &["elapsed_time_seconds"], "tool_progress", envelope)?;
        optional_string_at(value, &["task_id"], "tool_progress", envelope)?;
        self.tool_names.insert(id.clone(), name.clone());
        self.upsert_stream_item_with_presentation(
            format!("tool-progress:{id}"),
            ProjectedKind::Progress,
            &name,
            join_present(
                value,
                &["elapsed_time_seconds", "task_id", "parent_tool_use_id"],
                " · ",
            ),
            envelope.sequence,
            Some(id),
            ProjectedPresentation {
                tool: Some(ToolPresentation {
                    name: Some(name.clone()),
                    input: None,
                    partial_input_json: None,
                    lifecycle_output: None,
                    result: None,
                    is_error: None,
                }),
                ..ProjectedPresentation::default()
            },
        );
        Ok(())
    }

    fn project_direct_progress(
        &mut self,
        envelope: &RawEnvelope,
        progress_type: &str,
    ) -> Result<(), String> {
        let observed_type = required_string_at(
            &envelope.value,
            &["data", "type"],
            "direct progress",
            envelope,
        )?;
        if observed_type != progress_type {
            return Err(format!(
                "direct progress classification `{progress_type}` disagrees with data.type `{observed_type}` at sequence {}",
                envelope.sequence
            ));
        }
        let identity = DirectProgressIdentity {
            uuid: required_string_at(&envelope.value, &["uuid"], "direct progress", envelope)?,
            tool_use_id: required_string_at(
                &envelope.value,
                &["toolUseID"],
                "direct progress",
                envelope,
            )?,
            parent_tool_use_id: required_string_at(
                &envelope.value,
                &["parentToolUseID"],
                "direct progress",
                envelope,
            )?,
            progress_type: progress_type.to_string(),
            raw_sequence: envelope.sequence,
        };
        required_string_at(&envelope.value, &["timestamp"], "direct progress", envelope)?;

        match progress_type {
            "bash_progress" | "powershell_progress" => {
                self.project_direct_shell_progress(envelope, progress_type)
            }
            "agent_progress" | "skill_progress" => {
                self.project_direct_nested_progress(envelope, progress_type)
            }
            "mcp_progress" => self.project_direct_mcp_progress(envelope),
            "query_update" | "search_results_received" => {
                self.project_direct_search_progress(envelope, progress_type)
            }
            "waiting_for_task" => self.project_direct_waiting_progress(envelope),
            "hook_progress" => self.project_direct_hook_progress(envelope, &identity),
            "compact_progress" => self.project_direct_compact_progress(envelope),
            "workflow_progress" => self.project_direct_workflow_progress(envelope),
            // The source documents this as an ant-only placeholder and does
            // not define a renderable payload. Preserve the exact envelope in
            // diagnostics and surface that limitation without inventing data.
            "repl_progress" => {
                self.record_compatibility(
                    envelope.sequence,
                    ProjectionCompatibilityKind::UnknownPresentation,
                    None,
                    None,
                    "REPL progress has no open payload contract; raw metadata was retained"
                        .to_string(),
                    true,
                );
                Ok(())
            }
            unknown => Err(format!(
                "unknown direct progress type `{unknown}` at sequence {}",
                envelope.sequence
            )),
        }?;

        for item in &mut self.items {
            if item.raw_sequences.contains(&envelope.sequence) {
                item.presentation.direct_progress_identity = Some(identity.clone());
            }
        }
        self.direct_progress_identities.push(identity);
        Ok(())
    }

    fn project_direct_compact_progress(&mut self, envelope: &RawEnvelope) -> Result<(), String> {
        let value = &envelope.value;
        let parent_tool_use_id = required_string_at(
            value,
            &["parentToolUseID"],
            "direct compact progress",
            envelope,
        )?;
        let data = required_object_at(value, &["data"], "direct compact progress", envelope)?;
        let phase = required_string_at(
            value,
            &["data", "phase"],
            "direct compact progress",
            envelope,
        )?;

        let key = format!("direct-compact-progress:{parent_tool_use_id}");
        let (phase, hook_type, text) = match phase.as_str() {
            "hooks_start" => {
                if data.len() != 3
                    || !data.contains_key("type")
                    || !data.contains_key("phase")
                    || !data.contains_key("hookType")
                {
                    return Err(format!(
                        "direct compact progress hooks_start data must contain exactly type, phase, and hookType at sequence {}",
                        envelope.sequence
                    ));
                }
                let hook_type = required_string_at(
                    value,
                    &["data", "hookType"],
                    "direct compact progress",
                    envelope,
                )?;
                let (hook_type, text) = match hook_type.as_str() {
                    "pre_compact" => (
                        DirectCompactHookType::PreCompact,
                        "Running pre-compaction hooks…",
                    ),
                    "post_compact" => (
                        DirectCompactHookType::PostCompact,
                        "Running post-compaction hooks…",
                    ),
                    "session_start" => (
                        DirectCompactHookType::SessionStart,
                        "Running session-start hooks…",
                    ),
                    unknown => {
                        return Err(format!(
                            "direct compact progress has unknown hookType `{unknown}` at sequence {}",
                            envelope.sequence
                        ));
                    }
                };
                (
                    DirectCompactProgressPhase::HooksStart,
                    Some(hook_type),
                    text,
                )
            }
            "compact_start" | "compact_end" => {
                if data.len() != 2 || !data.contains_key("type") || !data.contains_key("phase") {
                    return Err(format!(
                        "direct compact progress {phase} data must contain exactly type and phase at sequence {}",
                        envelope.sequence
                    ));
                }
                if phase == "compact_start" {
                    (
                        DirectCompactProgressPhase::CompactStart,
                        None,
                        "Summarizing conversation…",
                    )
                } else {
                    // `compact_end` is emitted from a `finally` block. It says
                    // only that the transient lifecycle is over; success,
                    // failure, and cancellation are reported by later
                    // boundary/stdout and stderr/result envelopes. Keeping a
                    // completed green row here would therefore turn every
                    // failed compaction into a visual success. Remove the
                    // running row instead and retain the raw identity below.
                    self.remove_item(&key, envelope.sequence);
                    return Ok(());
                }
            }
            unknown => {
                return Err(format!(
                    "direct compact progress has unknown phase `{unknown}` at sequence {}",
                    envelope.sequence
                ));
            }
        };

        let presentation = ProjectedPresentation {
            direct_progress: Some(DirectProgressPresentation::Compact { phase, hook_type }),
            ..ProjectedPresentation::default()
        };
        self.upsert_stream_item_with_presentation(
            key,
            ProjectedKind::Progress,
            "Compact",
            text.to_string(),
            envelope.sequence,
            Some(parent_tool_use_id),
            presentation,
        );
        Ok(())
    }

    fn project_direct_shell_progress(
        &mut self,
        envelope: &RawEnvelope,
        progress_type: &str,
    ) -> Result<(), String> {
        let title = match progress_type {
            "bash_progress" => "Bash",
            "powershell_progress" => "PowerShell",
            _ => unreachable!("shell progress dispatcher validated the discriminator"),
        };
        let value = &envelope.value;
        let parent_tool_use_id = string_at(value, &["parentToolUseID"]).ok_or_else(|| {
            format!(
                "direct shell progress omitted parentToolUseID at sequence {}",
                envelope.sequence
            )
        })?;
        let output = string_at(value, &["data", "output"]).ok_or_else(|| {
            format!(
                "direct shell progress omitted data.output at sequence {}",
                envelope.sequence
            )
        })?;
        let full_output = string_at(value, &["data", "fullOutput"]).ok_or_else(|| {
            format!(
                "direct shell progress omitted data.fullOutput at sequence {}",
                envelope.sequence
            )
        })?;
        let elapsed_time_seconds = required_number_at(
            value,
            &["data", "elapsedTimeSeconds"],
            "direct shell progress",
            envelope,
        )?;
        let total_lines = required_number_at(
            value,
            &["data", "totalLines"],
            "direct shell progress",
            envelope,
        )?;
        let total_bytes = optional_number_at(
            value,
            &["data", "totalBytes"],
            "direct shell progress",
            envelope,
        )?;
        // `totalBytes` is non-zero exactly when the producer truncated
        // `fullOutput`: both shell tools forward
        // `lastTotalBytes = isIncomplete ? totalBytes : 0`. The wire therefore
        // already states whether a window that fails to overlap is routine or
        // genuinely anomalous, so read it instead of inferring.
        let producer_declared_truncation = total_bytes
            .as_ref()
            .and_then(serde_json::Number::as_u64)
            .is_some_and(|bytes| bytes > 0);
        let timeout_ms = optional_number_at(
            value,
            &["data", "timeoutMs"],
            "direct shell progress",
            envelope,
        )?;
        let task_id = optional_string_at(
            value,
            &["data", "taskId"],
            "direct shell progress",
            envelope,
        )?;
        let direct_progress = DirectProgressPresentation::Shell {
            progress_type: progress_type.to_string(),
            output,
            elapsed_time_seconds,
            total_lines,
            total_bytes,
            timeout_ms,
            task_id,
        };
        let key = format!("direct-shell-progress:{parent_tool_use_id}");
        self.tool_names
            .insert(parent_tool_use_id.clone(), title.to_string());
        if self.item_mut(&key).is_some() {
            let mut dropped_bytes = 0usize;
            {
                let item = self
                    .item_mut(&key)
                    .expect("presence checked on the line above");
                if full_output.starts_with(&item.text) {
                    // Fast path: the producer's tail window still covers every
                    // byte projected so far, so append only its exact new
                    // suffix. Arbitrary UTF-8 chunk boundaries keep byte order
                    // and content without adding or changing a wire field.
                    item.text.push_str(&full_output[item.text.len()..]);
                } else {
                    // `fullOutput` is a *bounded tail window* -- TaskOutput
                    // keeps only the last PROGRESS_TAIL_BYTES / 100 lines --
                    // not a cumulative buffer. A single burst larger than that
                    // window scrolls already-projected bytes out of it. Re-anchor
                    // on the longest overlap and mark the hole: a shell that
                    // prints faster than the poll interval is not a protocol
                    // violation and must never stop the runtime.
                    let overlap =
                        shell_progress_window_overlap(&item.text, &full_output);
                    if overlap == 0 && !item.text.is_empty() {
                        dropped_bytes = item.text.len();
                        item.text.push_str(SHELL_PROGRESS_WINDOW_GAP);
                    }
                    item.text.push_str(&full_output[overlap..]);
                }
                trim_shell_progress_text(&mut item.text);
                item.streaming = true;
                item.raw_sequences.push(envelope.sequence);
                item.presentation.direct_progress = Some(direct_progress);
            }
            // A gap the producer itself declared is routine -- a command simply
            // outran the poll interval -- and the scrollback marker already
            // tells the reader. Journalling every one of those would let a
            // chatty build evict real diagnostics from the retention budget, so
            // only an *undeclared* gap is recorded as a compatibility signal.
            if dropped_bytes > 0 && !producer_declared_truncation {
                self.record_compatibility(
                    envelope.sequence,
                    ProjectionCompatibilityKind::StreamOverlap,
                    None,
                    None,
                    format!(
                        "direct shell progress tail window advanced past the \
                         {dropped_bytes} projected bytes at sequence {} while \
                         reporting complete output; the scrollback marks the \
                         gap and the tool result keeps the saved output path",
                        envelope.sequence
                    ),
                    false,
                );
            }
            return Ok(());
        }
        self.append_item(ProjectedItem {
            key,
            kind: ProjectedKind::TerminalOutput,
            title: title.to_string(),
            text: full_output,
            streaming: true,
            raw_sequences: vec![envelope.sequence],
            tool_use_id: Some(parent_tool_use_id),
            presentation: ProjectedPresentation {
                tool: Some(ToolPresentation {
                    name: Some(title.to_string()),
                    input: None,
                    partial_input_json: None,
                    lifecycle_output: None,
                    result: None,
                    is_error: None,
                }),
                direct_progress: Some(direct_progress),
                ..ProjectedPresentation::default()
            },
        });
        Ok(())
    }

    fn project_direct_nested_progress(
        &mut self,
        envelope: &RawEnvelope,
        progress_type: &str,
    ) -> Result<(), String> {
        let value = &envelope.value;
        let parent_tool_use_id = required_string_at(
            value,
            &["parentToolUseID"],
            "direct nested progress",
            envelope,
        )?;
        let progress_tool_use_id =
            required_string_at(value, &["toolUseID"], "direct nested progress", envelope)?;
        let prompt = required_string_at(
            value,
            &["data", "prompt"],
            "direct nested progress",
            envelope,
        )?;
        let agent_id = required_string_at(
            value,
            &["data", "agentId"],
            "direct nested progress",
            envelope,
        )?;
        let message = value
            .pointer("/data/message")
            .filter(|message| message.is_object())
            .cloned()
            .ok_or_else(|| {
                format!(
                    "direct nested progress omitted object data.message at sequence {}",
                    envelope.sequence
                )
            })?;
        let message_type = required_string_at(
            &message,
            &["type"],
            "direct nested progress data.message",
            envelope,
        )?;
        required_string_at(
            &message,
            &["uuid"],
            "direct nested progress data.message",
            envelope,
        )?;
        required_string_at(
            &message,
            &["timestamp"],
            "direct nested progress data.message",
            envelope,
        )?;

        // AgentTool's fixed external renderer reads the first prompt-bearing
        // progress record, then filters user records from its visible
        // transcript. Later records intentionally carry an empty prompt.
        if !prompt.is_empty() {
            self.direct_nested_prompts
                .entry(parent_tool_use_id.clone())
                .or_insert_with(|| prompt.clone());
        }
        let effective_prompt = self
            .direct_nested_prompts
            .get(&parent_tool_use_id)
            .cloned()
            .unwrap_or(prompt);
        let usage = if message_type == "assistant" {
            match message.pointer("/message/usage") {
                None => None,
                Some(usage) if usage.is_object() => Some(DirectNestedAssistantUsage {
                    input_tokens: required_number_at(
                        usage,
                        &["input_tokens"],
                        "direct nested assistant message.usage",
                        envelope,
                    )?,
                    output_tokens: required_number_at(
                        usage,
                        &["output_tokens"],
                        "direct nested assistant message.usage",
                        envelope,
                    )?,
                    cache_creation_input_tokens: optional_nullable_number_at(
                        usage,
                        &["cache_creation_input_tokens"],
                        "direct nested assistant message.usage",
                        envelope,
                    )?,
                    cache_read_input_tokens: optional_nullable_number_at(
                        usage,
                        &["cache_read_input_tokens"],
                        "direct nested assistant message.usage",
                        envelope,
                    )?,
                }),
                Some(_) => {
                    return Err(format!(
                        "direct nested assistant message has non-object usage at sequence {}",
                        envelope.sequence
                    ));
                }
            }
        } else {
            None
        };
        let presentation = DirectProgressPresentation::Nested {
            progress_type: progress_type.to_string(),
            parent_tool_use_id: parent_tool_use_id.clone(),
            progress_tool_use_id,
            prompt: effective_prompt,
            agent_id,
            message_kind: match message_type.as_str() {
                "user" => DirectNestedMessageKind::User,
                "assistant" => DirectNestedMessageKind::Assistant,
                unknown => {
                    return Err(format!(
                        "direct `{progress_type}` producer supplied unsupported nested `{unknown}` message at sequence {}",
                        envelope.sequence
                    ));
                }
            },
            usage,
        };

        match message_type.as_str() {
            // The fixed external AgentTool UI deliberately filters every user
            // record. Retain one renderer-private envelope marker so its first
            // prompt, empty/initializing state, outer-message grouping, and
            // tool completion lookup survive without rendering user content.
            "user" if progress_type == "agent_progress" => {
                self.record_direct_nested_tool_completions(&message, &parent_tool_use_id);
                self.append_direct_nested_envelope_marker(
                    envelope,
                    &parent_tool_use_id,
                    presentation,
                )?;
                Ok(())
            }
            "user" => self.project_direct_nested_user(
                envelope,
                &message,
                &parent_tool_use_id,
                presentation,
            ),
            "assistant" => self.project_direct_nested_assistant(
                envelope,
                &message,
                &parent_tool_use_id,
                presentation,
            ),
            unknown => Err(format!(
                "direct `{progress_type}` producer supplied unsupported nested `{unknown}` message at sequence {}",
                envelope.sequence
            )),
        }
    }

    fn project_direct_nested_assistant(
        &mut self,
        envelope: &RawEnvelope,
        message: &Value,
        parent_tool_use_id: &str,
        presentation: DirectProgressPresentation,
    ) -> Result<(), String> {
        let blocks = message
            .pointer("/message/content")
            .and_then(Value::as_array)
            .ok_or_else(|| {
                format!(
                    "direct nested assistant omitted message.content array at sequence {}",
                    envelope.sequence
                )
            })?;
        let progress_identity = required_string_at(
            &envelope.value,
            &["uuid"],
            "direct nested assistant progress",
            envelope,
        )?;
        let mut emitted = false;
        for (index, block) in blocks.iter().enumerate() {
            let block_type =
                required_string_at(block, &["type"], "direct nested assistant block", envelope)?;
            let key =
                format!("direct-nested-progress:{parent_tool_use_id}:{progress_identity}:{index}");
            match block_type.as_str() {
                "text" => {
                    let text = required_string_at(
                        block,
                        &["text"],
                        "direct nested assistant text block",
                        envelope,
                    )?;
                    self.append_item(ProjectedItem {
                        key,
                        kind: ProjectedKind::Assistant,
                        title: "Subagent".to_string(),
                        text,
                        streaming: false,
                        raw_sequences: vec![envelope.sequence],
                        tool_use_id: Some(parent_tool_use_id.to_string()),
                        presentation: ProjectedPresentation {
                            assistant_block: Some(AssistantBlockType::Text),
                            direct_progress: Some(presentation.clone()),
                            ..ProjectedPresentation::default()
                        },
                    });
                    emitted = true;
                }
                "thinking" | "redacted_thinking" => {
                    let redacted = block_type == "redacted_thinking";
                    let content_field = if redacted { "data" } else { "thinking" };
                    let content = required_string_at(
                        block,
                        &[content_field],
                        "direct nested assistant thinking block",
                        envelope,
                    )?;
                    let signature = if redacted {
                        None
                    } else {
                        Some(required_string_at(
                            block,
                            &["signature"],
                            "direct nested assistant thinking block",
                            envelope,
                        )?)
                    };
                    self.append_item(ProjectedItem {
                        key,
                        kind: ProjectedKind::Thinking,
                        title: if redacted {
                            "Redacted thinking"
                        } else {
                            "Thinking"
                        }
                        .to_string(),
                        text: content.clone(),
                        streaming: false,
                        raw_sequences: vec![envelope.sequence],
                        tool_use_id: Some(parent_tool_use_id.to_string()),
                        presentation: ProjectedPresentation {
                            assistant_block: assistant_block_type(&block_type),
                            thinking: Some(ThinkingPresentation {
                                kind: if redacted {
                                    ThinkingKind::Redacted
                                } else {
                                    ThinkingKind::Thinking
                                },
                                content,
                                signature,
                            }),
                            direct_progress: Some(presentation.clone()),
                            ..ProjectedPresentation::default()
                        },
                    });
                    emitted = true;
                }
                "tool_use" | "server_tool_use" | "mcp_tool_use" => {
                    let id = required_string_at(
                        block,
                        &["id"],
                        "direct nested assistant tool-use block",
                        envelope,
                    )?;
                    let name = required_string_at(
                        block,
                        &["name"],
                        "direct nested assistant tool-use block",
                        envelope,
                    )?;
                    let input = block.get("input").cloned().ok_or_else(|| {
                        format!(
                            "direct nested assistant tool-use block omitted input at sequence {}",
                            envelope.sequence
                        )
                    })?;
                    let tool_identity = (parent_tool_use_id.to_string(), id.clone());
                    let streaming = !self
                        .direct_nested_resolved_tool_uses
                        .contains(&tool_identity);
                    self.direct_nested_tool_names
                        .insert(tool_identity.clone(), name.clone());
                    self.direct_nested_tool_item_keys
                        .insert(tool_identity, key.clone());
                    self.append_item(ProjectedItem {
                        key,
                        kind: ProjectedKind::ToolUse,
                        title: name.clone(),
                        text: pretty_json(&input),
                        streaming,
                        raw_sequences: vec![envelope.sequence],
                        tool_use_id: Some(id),
                        presentation: ProjectedPresentation {
                            assistant_block: assistant_block_type(&block_type),
                            tool: Some(ToolPresentation {
                                name: Some(name),
                                input: Some(input),
                                partial_input_json: None,
                                lifecycle_output: None,
                                result: None,
                                is_error: None,
                            }),
                            direct_progress: Some(presentation.clone()),
                            ..ProjectedPresentation::default()
                        },
                    });
                    emitted = true;
                }
                "web_search_tool_result"
                | "web_fetch_tool_result"
                | "code_execution_tool_result"
                | "bash_code_execution_tool_result"
                | "text_editor_code_execution_tool_result"
                | "tool_search_tool_result"
                | "mcp_tool_result"
                | "container_upload"
                | "advisor_tool_result" => {
                    let (tool_use_id, result, is_error) = assistant_result_fields(
                        &block_type,
                        block,
                        "direct nested assistant result block",
                    )?;
                    let name = tool_use_id.as_ref().and_then(|id| {
                        self.direct_nested_tool_names
                            .get(&(parent_tool_use_id.to_string(), id.clone()))
                            .cloned()
                    });
                    if let Some(tool_use_id) = tool_use_id.as_deref() {
                        self.complete_direct_nested_tool_use(parent_tool_use_id, tool_use_id);
                    }
                    self.append_item(ProjectedItem {
                        key,
                        kind: ProjectedKind::ToolResult,
                        title: name.as_ref().map_or_else(
                            || block_type.replace('_', " "),
                            |name| format!("{name} result"),
                        ),
                        text: if block_type == "advisor_tool_result" {
                            advisor_result_text(block)?
                        } else {
                            content_to_text(block.get("content"))?
                        },
                        streaming: false,
                        raw_sequences: vec![envelope.sequence],
                        tool_use_id: tool_use_id
                            .clone()
                            .or_else(|| Some(parent_tool_use_id.to_string())),
                        presentation: ProjectedPresentation {
                            assistant_block: assistant_result_block_type(&block_type),
                            tool: Some(ToolPresentation {
                                name: name.or_else(|| Some(result_tool_name(&block_type))),
                                input: None,
                                partial_input_json: None,
                                lifecycle_output: None,
                                result,
                                is_error,
                            }),
                            direct_progress: Some(presentation.clone()),
                            ..ProjectedPresentation::default()
                        },
                    });
                    emitted = true;
                }
                "connector_text" => {
                    self.append_item(ProjectedItem {
                        key,
                        kind: ProjectedKind::Assistant,
                        title: "Subagent".to_string(),
                        text: connector_text_projection(
                            block,
                            "direct nested assistant connector_text block",
                        )?,
                        streaming: false,
                        raw_sequences: vec![envelope.sequence],
                        tool_use_id: Some(parent_tool_use_id.to_string()),
                        presentation: ProjectedPresentation {
                            assistant_block: Some(AssistantBlockType::ConnectorText),
                            direct_progress: Some(presentation.clone()),
                            ..ProjectedPresentation::default()
                        },
                    });
                    emitted = true;
                }
                "compaction" => {
                    validate_compaction_block(block, "direct nested assistant compaction block")?;
                }
                unknown => {
                    return Err(format!(
                        "direct nested assistant has unknown block `{unknown}` at sequence {}",
                        envelope.sequence
                    ));
                }
            }
        }
        if !emitted {
            self.append_direct_nested_envelope_marker(envelope, parent_tool_use_id, presentation)?;
        }
        Ok(())
    }

    fn project_direct_nested_user(
        &mut self,
        envelope: &RawEnvelope,
        message: &Value,
        parent_tool_use_id: &str,
        presentation: DirectProgressPresentation,
    ) -> Result<(), String> {
        let progress_identity = required_string_at(
            &envelope.value,
            &["uuid"],
            "direct nested user progress",
            envelope,
        )?;
        let content = message.pointer("/message/content").ok_or_else(|| {
            format!(
                "direct nested user omitted message.content at sequence {}",
                envelope.sequence
            )
        })?;
        if let Some(text) = content.as_str() {
            self.append_item(ProjectedItem {
                key: format!("direct-nested-progress:{parent_tool_use_id}:{progress_identity}:0"),
                kind: ProjectedKind::User,
                title: "Skill".to_string(),
                text: text.to_string(),
                streaming: false,
                raw_sequences: vec![envelope.sequence],
                tool_use_id: Some(parent_tool_use_id.to_string()),
                presentation: ProjectedPresentation {
                    direct_progress: Some(presentation),
                    ..ProjectedPresentation::default()
                },
            });
            return Ok(());
        }
        let blocks = content.as_array().ok_or_else(|| {
            format!(
                "direct nested user message.content is neither string nor array at sequence {}",
                envelope.sequence
            )
        })?;
        for (index, block) in blocks.iter().enumerate() {
            let block_type =
                required_string_at(block, &["type"], "direct nested user block", envelope)?;
            let key =
                format!("direct-nested-progress:{parent_tool_use_id}:{progress_identity}:{index}");
            match block_type.as_str() {
                "text" => {
                    let text = required_string_at(
                        block,
                        &["text"],
                        "direct nested user text block",
                        envelope,
                    )?;
                    self.append_item(ProjectedItem {
                        key,
                        kind: ProjectedKind::User,
                        title: "Skill".to_string(),
                        text,
                        streaming: false,
                        raw_sequences: vec![envelope.sequence],
                        tool_use_id: Some(parent_tool_use_id.to_string()),
                        presentation: ProjectedPresentation {
                            direct_progress: Some(presentation.clone()),
                            ..ProjectedPresentation::default()
                        },
                    });
                }
                "tool_result" => {
                    let inner_tool_use_id = required_string_at(
                        block,
                        &["tool_use_id"],
                        "direct nested user tool-result block",
                        envelope,
                    )?;
                    let is_error = optional_bool_field(
                        block,
                        "is_error",
                        "direct nested user tool-result block",
                    )?;
                    let result = block.get("content").cloned();
                    let name = self
                        .direct_nested_tool_names
                        .get(&(parent_tool_use_id.to_string(), inner_tool_use_id.clone()))
                        .cloned();
                    self.complete_direct_nested_tool_use(parent_tool_use_id, &inner_tool_use_id);
                    let terminal = name.as_deref().is_some_and(is_terminal_tool);
                    self.append_item(ProjectedItem {
                        key,
                        kind: if terminal {
                            ProjectedKind::TerminalOutput
                        } else {
                            ProjectedKind::ToolResult
                        },
                        title: name.as_ref().map_or_else(
                            || "Tool result".to_string(),
                            |name| format!("{name} result"),
                        ),
                        text: content_to_text(block.get("content"))?,
                        streaming: false,
                        raw_sequences: vec![envelope.sequence],
                        tool_use_id: Some(inner_tool_use_id),
                        presentation: ProjectedPresentation {
                            tool: Some(ToolPresentation {
                                name,
                                input: None,
                                partial_input_json: None,
                                lifecycle_output: None,
                                result,
                                is_error,
                            }),
                            direct_progress: Some(presentation.clone()),
                            ..ProjectedPresentation::default()
                        },
                    });
                }
                unknown => {
                    return Err(format!(
                        "direct nested skill progress has unsupported user block `{unknown}` at sequence {}",
                        envelope.sequence
                    ));
                }
            }
        }
        if blocks.is_empty() {
            self.append_direct_nested_envelope_marker(envelope, parent_tool_use_id, presentation)?;
        }
        Ok(())
    }

    fn append_direct_nested_envelope_marker(
        &mut self,
        envelope: &RawEnvelope,
        parent_tool_use_id: &str,
        presentation: DirectProgressPresentation,
    ) -> Result<(), String> {
        let progress_identity = required_string_at(
            &envelope.value,
            &["uuid"],
            "direct nested envelope marker",
            envelope,
        )?;
        self.append_item(ProjectedItem {
            key: format!(
                "direct-nested-progress:{parent_tool_use_id}:{progress_identity}:envelope"
            ),
            kind: ProjectedKind::Progress,
            title: "Nested message envelope".to_string(),
            text: String::new(),
            streaming: false,
            raw_sequences: vec![envelope.sequence],
            tool_use_id: Some(parent_tool_use_id.to_string()),
            presentation: ProjectedPresentation {
                direct_progress: Some(presentation),
                ..ProjectedPresentation::default()
            },
        });
        Ok(())
    }

    /// Complete nested tool invocations from AgentTool's filtered user
    /// envelopes without turning those envelopes into visible transcript rows.
    ///
    /// The fixed lookup consumes only exact `tool_result.tool_use_id` fields.
    /// Other user content remains opaque here and cannot widen the renderer
    /// protocol or cause a projection failure.
    fn record_direct_nested_tool_completions(&mut self, message: &Value, parent_tool_use_id: &str) {
        let Some(blocks) = message
            .pointer("/message/content")
            .and_then(Value::as_array)
        else {
            return;
        };
        for block in blocks {
            if block.get("type").and_then(Value::as_str) != Some("tool_result") {
                continue;
            }
            let Some(tool_use_id) = block.get("tool_use_id").and_then(Value::as_str) else {
                continue;
            };
            self.complete_direct_nested_tool_use(parent_tool_use_id, tool_use_id);
        }
    }

    fn complete_direct_nested_tool_use(&mut self, parent_tool_use_id: &str, tool_use_id: &str) {
        let identity = (parent_tool_use_id.to_string(), tool_use_id.to_string());
        self.direct_nested_resolved_tool_uses
            .insert(identity.clone());
        let Some(item_key) = self.direct_nested_tool_item_keys.get(&identity).cloned() else {
            return;
        };
        if let Some(item) = self.item_mut(&item_key) {
            item.streaming = false;
        }
    }

    fn project_direct_mcp_progress(&mut self, envelope: &RawEnvelope) -> Result<(), String> {
        let value = &envelope.value;
        let parent_tool_use_id =
            required_string_at(value, &["parentToolUseID"], "direct MCP progress", envelope)?;
        let status =
            required_string_at(value, &["data", "status"], "direct MCP progress", envelope)?;
        if !matches!(
            status.as_str(),
            "started" | "progress" | "completed" | "failed"
        ) {
            return Err(format!(
                "direct MCP progress has unknown status `{status}` at sequence {}",
                envelope.sequence
            ));
        }
        let server_name = required_string_at(
            value,
            &["data", "serverName"],
            "direct MCP progress",
            envelope,
        )?;
        let tool_name = required_string_at(
            value,
            &["data", "toolName"],
            "direct MCP progress",
            envelope,
        )?;
        let progress = optional_number_at(
            value,
            &["data", "progress"],
            "direct MCP progress",
            envelope,
        )?;
        let total = optional_number_at(value, &["data", "total"], "direct MCP progress", envelope)?;
        let elapsed_time_ms = optional_number_at(
            value,
            &["data", "elapsedTimeMs"],
            "direct MCP progress",
            envelope,
        )?;
        let progress_message = optional_string_at(
            value,
            &["data", "progressMessage"],
            "direct MCP progress",
            envelope,
        )?;
        let percentage = match (
            progress.as_ref().and_then(serde_json::Number::as_f64),
            total.as_ref().and_then(serde_json::Number::as_f64),
        ) {
            (Some(progress), Some(total)) if total > 0.0 => {
                Some(((progress / total).clamp(0.0, 1.0) * 100.0).round() as u8)
            }
            _ => None,
        };
        let text = match status.as_str() {
            "completed" => progress_message
                .clone()
                .unwrap_or_else(|| "Completed".to_string()),
            "failed" => progress_message
                .clone()
                .unwrap_or_else(|| "Failed".to_string()),
            _ if progress.is_none() => "Running…".to_string(),
            _ if percentage.is_some() => {
                let percentage = percentage.expect("the branch established percentage");
                progress_message.as_ref().map_or_else(
                    || format!("{percentage}%"),
                    |message| format!("{message}\n{percentage}%"),
                )
            }
            _ => progress_message.clone().unwrap_or_else(|| {
                format!(
                    "Processing… {}",
                    progress.as_ref().expect("the branch established progress")
                )
            }),
        };
        self.upsert_stream_item_with_presentation(
            format!("direct-mcp-progress:{parent_tool_use_id}"),
            ProjectedKind::Progress,
            &format!("{server_name} · {tool_name}"),
            text,
            envelope.sequence,
            Some(parent_tool_use_id),
            ProjectedPresentation {
                direct_progress: Some(DirectProgressPresentation::Mcp {
                    status,
                    server_name,
                    tool_name,
                    progress,
                    total,
                    elapsed_time_ms,
                    progress_message,
                    percentage,
                }),
                ..ProjectedPresentation::default()
            },
        );
        Ok(())
    }

    fn project_direct_search_progress(
        &mut self,
        envelope: &RawEnvelope,
        progress_type: &str,
    ) -> Result<(), String> {
        let value = &envelope.value;
        let parent_tool_use_id = required_string_at(
            value,
            &["parentToolUseID"],
            "direct search progress",
            envelope,
        )?;
        let query = required_string_at(
            value,
            &["data", "query"],
            "direct search progress",
            envelope,
        )?;
        let (text, presentation) = match progress_type {
            "query_update" => (
                format!("Searching: {query}"),
                DirectProgressPresentation::SearchQuery { query },
            ),
            "search_results_received" => {
                let result_count = required_u64_at(
                    value,
                    &["data", "resultCount"],
                    "direct search progress",
                    envelope,
                )?;
                (
                    format!("Found {result_count} results for \"{query}\""),
                    DirectProgressPresentation::SearchResults {
                        query,
                        result_count,
                    },
                )
            }
            _ => unreachable!("search progress dispatcher validated the discriminator"),
        };
        self.upsert_stream_item_with_presentation(
            format!("direct-search-progress:{parent_tool_use_id}"),
            ProjectedKind::Progress,
            "Web search",
            text,
            envelope.sequence,
            Some(parent_tool_use_id),
            ProjectedPresentation {
                direct_progress: Some(presentation),
                ..ProjectedPresentation::default()
            },
        );
        Ok(())
    }

    fn project_direct_waiting_progress(&mut self, envelope: &RawEnvelope) -> Result<(), String> {
        let value = &envelope.value;
        let parent_tool_use_id = required_string_at(
            value,
            &["parentToolUseID"],
            "direct task progress",
            envelope,
        )?;
        let task_description = required_string_at(
            value,
            &["data", "taskDescription"],
            "direct task progress",
            envelope,
        )?;
        let task_type = required_string_at(
            value,
            &["data", "taskType"],
            "direct task progress",
            envelope,
        )?;
        let waiting =
            "\u{a0}\u{a0}\u{a0}\u{a0}\u{a0}Waiting for task (esc to give additional instructions)";
        let text = if task_description.is_empty() {
            waiting.to_string()
        } else {
            format!("\u{a0}\u{a0}{task_description}\n{waiting}")
        };
        self.upsert_stream_item_with_presentation(
            format!("direct-task-waiting:{parent_tool_use_id}"),
            ProjectedKind::Progress,
            "Task output",
            text,
            envelope.sequence,
            Some(parent_tool_use_id),
            ProjectedPresentation {
                direct_progress: Some(DirectProgressPresentation::WaitingForTask {
                    task_description,
                    task_type,
                }),
                ..ProjectedPresentation::default()
            },
        );
        Ok(())
    }

    fn project_direct_workflow_progress(&mut self, envelope: &RawEnvelope) -> Result<(), String> {
        let value = &envelope.value;
        let parent_tool_use_id = required_string_at(
            value,
            &["parentToolUseID"],
            "direct workflow progress",
            envelope,
        )?;
        let task_id = required_string_at(
            value,
            &["data", "taskId"],
            "direct workflow progress",
            envelope,
        )?;
        let workflow = required_string_at(
            value,
            &["data", "workflow"],
            "direct workflow progress",
            envelope,
        )?;
        let phase = optional_string_at(
            value,
            &["data", "phase"],
            "direct workflow progress",
            envelope,
        )?;
        let phase_index = required_i64_at(
            value,
            &["data", "phaseIndex"],
            "direct workflow progress",
            envelope,
        )?;
        if phase_index < -1 {
            return Err(format!(
                "direct workflow progress has phaseIndex below -1 at sequence {}",
                envelope.sequence
            ));
        }
        if phase.is_some() && phase_index < 0 {
            return Err(format!(
                "direct workflow progress has a phase with negative phaseIndex at sequence {}",
                envelope.sequence
            ));
        }
        let message = required_string_at(
            value,
            &["data", "message"],
            "direct workflow progress",
            envelope,
        )?;
        let agents_started = required_u32_at(
            value,
            &["data", "agentsStarted"],
            "direct workflow progress",
            envelope,
        )?;
        let agents_completed = required_u32_at(
            value,
            &["data", "agentsCompleted"],
            "direct workflow progress",
            envelope,
        )?;
        if agents_completed > agents_started {
            return Err(format!(
                "direct workflow progress completed more agents than it started at sequence {}",
                envelope.sequence
            ));
        }

        let key = direct_workflow_item_key(&task_id);
        let mut phases = self
            .item_index
            .get(&key)
            .and_then(|index| self.items.get(*index))
            .and_then(|item| item.presentation.direct_progress.as_ref())
            .and_then(|progress| match progress {
                DirectProgressPresentation::Workflow { phases, .. } => Some(phases.clone()),
                _ => None,
            })
            .unwrap_or_default();
        if let Some(phase) = phase.as_ref() {
            if let Some(existing) = phases.iter_mut().find(|entry| entry.index == phase_index) {
                existing.title.clone_from(phase);
            } else {
                phases.push(DirectWorkflowPhase {
                    index: phase_index,
                    title: phase.clone(),
                    state: DirectWorkflowPhaseState::Active,
                });
                phases.sort_by_key(|entry| entry.index);
            }
        }
        for entry in &mut phases {
            entry.state = if entry.index < phase_index {
                DirectWorkflowPhaseState::Done
            } else if entry.index == phase_index {
                DirectWorkflowPhaseState::Active
            } else {
                DirectWorkflowPhaseState::Pending
            };
        }

        let prior_status = self
            .item_index
            .get(&key)
            .and_then(|index| self.items.get(*index))
            .and_then(|item| {
                item.presentation
                    .direct_progress
                    .as_ref()
                    .and_then(|progress| match progress {
                        DirectProgressPresentation::Workflow { status, .. } => Some(*status),
                        _ => None,
                    })
                    .or_else(|| {
                        item.presentation
                            .direct_attachment
                            .as_ref()
                            .and_then(|attachment| match &attachment.data {
                                DirectAttachmentData::TaskStatus {
                                    task_type: DirectTaskType::LocalWorkflow,
                                    status,
                                    ..
                                } => Some(direct_task_status_to_workflow(*status)),
                                _ => None,
                            })
                    })
            });
        let status = prior_status
            .filter(|status| *status != DirectWorkflowStatus::Running)
            .unwrap_or(DirectWorkflowStatus::Running);
        let direct_progress = DirectProgressPresentation::Workflow {
            task_id: task_id.clone(),
            workflow: workflow.clone(),
            phase,
            phase_index,
            message: message.clone(),
            agents_started,
            agents_completed,
            phases,
            status,
        };

        if let Some(item) = self.item_mut(&key) {
            item.kind = ProjectedKind::Progress;
            item.title = workflow;
            item.text = message;
            item.streaming = status == DirectWorkflowStatus::Running;
            item.raw_sequences.push(envelope.sequence);
            item.tool_use_id = Some(parent_tool_use_id);
            item.presentation.direct_progress = Some(direct_progress);
        } else {
            self.append_item(ProjectedItem {
                key,
                kind: ProjectedKind::Progress,
                title: workflow,
                text: message,
                streaming: status == DirectWorkflowStatus::Running,
                raw_sequences: vec![envelope.sequence],
                tool_use_id: Some(parent_tool_use_id),
                presentation: ProjectedPresentation {
                    direct_progress: Some(direct_progress),
                    ..ProjectedPresentation::default()
                },
            });
        }
        Ok(())
    }

    fn project_direct_hook_progress(
        &mut self,
        envelope: &RawEnvelope,
        identity: &DirectProgressIdentity,
    ) -> Result<(), String> {
        let value = &envelope.value;
        let parent_tool_use_id = required_string_at(
            value,
            &["parentToolUseID"],
            "direct hook progress",
            envelope,
        )?;
        let hook_event = required_string_at(
            value,
            &["data", "hookEvent"],
            "direct hook progress",
            envelope,
        )?;
        if !DIRECT_HOOK_EVENTS.contains(&hook_event.as_str()) {
            return Err(format!(
                "direct hook progress has unknown HookEvent `{hook_event}` at sequence {}",
                envelope.sequence
            ));
        }
        let hook_name = required_string_at(
            value,
            &["data", "hookName"],
            "direct hook progress",
            envelope,
        )?;
        let command = required_string_at(
            value,
            &["data", "command"],
            "direct hook progress",
            envelope,
        )?;
        optional_string_at(
            value,
            &["data", "promptText"],
            "direct hook progress",
            envelope,
        )?;
        let status_message = optional_string_at(
            value,
            &["data", "statusMessage"],
            "direct hook progress",
            envelope,
        )?;
        self.direct_hook_progress_entries
            .push(DirectHookProgressEntry {
                identity: identity.clone(),
                hook_event: hook_event.clone(),
                hook_name,
                command,
                status_message,
            });
        let key = DirectHookKey {
            parent_tool_use_id: parent_tool_use_id.clone(),
            hook_event: hook_event.clone(),
        };
        let count = self
            .direct_hook_progress_counts
            .entry(key.clone())
            .or_default();
        *count = count.saturating_add(1);
        let presentation = self
            .direct_hook_progress_presentation(&parent_tool_use_id, &hook_event)
            .expect("the hook progress count was just retained");
        let in_progress_count = presentation.in_progress_count;
        let resolved_count = presentation.resolved_count;

        // Fixed prompt-mode Ink behavior hides PreToolUse/PostToolUse progress.
        // Transcript mode renders a static count, which is carried in the
        // presentation data for the Rust transcript renderer.
        if matches!(hook_event.as_str(), "PreToolUse" | "PostToolUse") {
            return Ok(());
        }
        if resolved_count >= in_progress_count {
            self.remove_item(&direct_hook_item_key(&key), envelope.sequence);
            return Ok(());
        }
        let text = format!(
            "Running {hook_event} {}",
            if in_progress_count == 1 {
                "hook…"
            } else {
                "hooks…"
            }
        );
        self.upsert_stream_item_with_presentation(
            direct_hook_item_key(&key),
            ProjectedKind::Progress,
            "Hook",
            text,
            envelope.sequence,
            Some(parent_tool_use_id),
            ProjectedPresentation {
                direct_progress: Some(DirectProgressPresentation::Hook {
                    hook_event,
                    in_progress_count,
                    resolved_count,
                }),
                ..ProjectedPresentation::default()
            },
        );
        Ok(())
    }

    fn project_direct_attachment(
        &mut self,
        envelope: &RawEnvelope,
        attachment_type: &str,
    ) -> Result<(), String> {
        let attachment = envelope
            .value
            .get("attachment")
            .filter(|attachment| attachment.is_object())
            .ok_or_else(|| {
                format!(
                    "direct attachment omitted object attachment at sequence {}",
                    envelope.sequence
                )
            })?;

        // Every hook attachment carries correlation fields that belong to the
        // private renderer lifecycle, including null-rendering variants.
        // Only the five primary outcomes finish one execution. A hook can emit
        // system/additional-context/stopped-continuation attachments in
        // addition to its primary outcome, so treating those as completions
        // clears a multi-hook row before the batch has actually finished.
        let primary_hook_terminal = match attachment_type {
            "hook_blocking_error"
            | "hook_cancelled"
            | "hook_error_during_execution"
            | "hook_non_blocking_error"
            | "hook_success" => Some(true),
            "hook_system_message" | "hook_additional_context" | "hook_stopped_continuation" => {
                Some(false)
            }
            _ => None,
        };
        if let Some(primary_terminal) = primary_hook_terminal {
            self.observe_direct_hook_attachment(envelope, attachment, primary_terminal)?;
        }

        if NULL_RENDERING_DIRECT_ATTACHMENT_TYPES.contains(&attachment_type) {
            return Ok(());
        }
        if RENDERER_GATED_DIRECT_ATTACHMENT_TYPES.contains(&attachment_type) {
            let gated =
                project_direct_renderer_gated_attachment(envelope, attachment_type, attachment)?;
            self.direct_renderer_gated_attachments.push(gated);
            return Ok(());
        }

        let projected = match attachment_type {
            "directory" => DirectAttachmentItem {
                kind: ProjectedKind::System,
                title: "Context",
                text: format!(
                    "Listed directory {}{}",
                    required_string_at(
                        attachment,
                        &["displayPath"],
                        "directory attachment",
                        envelope,
                    )?,
                    std::path::MAIN_SEPARATOR
                ),
            },
            "file" | "already_read_file" => DirectAttachmentItem {
                kind: ProjectedKind::System,
                title: "Context",
                text: direct_file_attachment_text(attachment, envelope)?,
            },
            "compact_file_reference" => DirectAttachmentItem {
                kind: ProjectedKind::System,
                title: "Context",
                text: format!(
                    "Referenced file {}",
                    required_string_at(
                        attachment,
                        &["displayPath"],
                        "compact file attachment",
                        envelope,
                    )?
                ),
            },
            "pdf_reference" => {
                let display_path = required_string_at(
                    attachment,
                    &["displayPath"],
                    "PDF reference attachment",
                    envelope,
                )?;
                let page_count = required_u64_at(
                    attachment,
                    &["pageCount"],
                    "PDF reference attachment",
                    envelope,
                )?;
                required_number_at(
                    attachment,
                    &["fileSize"],
                    "PDF reference attachment",
                    envelope,
                )?;
                DirectAttachmentItem {
                    kind: ProjectedKind::System,
                    title: "Context",
                    text: format!("Referenced PDF {display_path} ({page_count} pages)"),
                }
            }
            "selected_lines_in_ide" => {
                let line_start = required_u64_at(
                    attachment,
                    &["lineStart"],
                    "selected-lines attachment",
                    envelope,
                )?;
                let line_end = required_u64_at(
                    attachment,
                    &["lineEnd"],
                    "selected-lines attachment",
                    envelope,
                )?;
                let line_count = line_end
                    .checked_sub(line_start)
                    .and_then(|count| count.checked_add(1))
                    .ok_or_else(|| {
                        format!(
                            "selected-lines attachment has lineEnd before lineStart at sequence {}",
                            envelope.sequence
                        )
                    })?;
                let display_path = required_string_at(
                    attachment,
                    &["displayPath"],
                    "selected-lines attachment",
                    envelope,
                )?;
                let ide_name = required_string_at(
                    attachment,
                    &["ideName"],
                    "selected-lines attachment",
                    envelope,
                )?;
                DirectAttachmentItem {
                    kind: ProjectedKind::System,
                    title: "Context",
                    text: format!(
                        "⧉ Selected {line_count} lines from {display_path} in {ide_name}"
                    ),
                }
            }
            "nested_memory" => DirectAttachmentItem {
                kind: ProjectedKind::System,
                title: "Context",
                text: format!(
                    "Loaded {}",
                    required_string_at(
                        attachment,
                        &["displayPath"],
                        "nested-memory attachment",
                        envelope,
                    )?
                ),
            },
            "relevant_memories" => {
                let memories = required_array_at(
                    attachment,
                    &["memories"],
                    "relevant-memories attachment",
                    envelope,
                )?;
                DirectAttachmentItem {
                    kind: ProjectedKind::System,
                    title: "Context",
                    text: format!(
                        "Recalled {} {}",
                        memories.len(),
                        if memories.len() == 1 {
                            "memory"
                        } else {
                            "memories"
                        }
                    ),
                }
            }
            "dynamic_skill" => {
                let skill_names = required_array_at(
                    attachment,
                    &["skillNames"],
                    "dynamic-skill attachment",
                    envelope,
                )?;
                for (index, name) in skill_names.iter().enumerate() {
                    if !name.is_string() {
                        return Err(format!(
                            "dynamic-skill attachment skillNames[{index}] is not a string at sequence {}",
                            envelope.sequence
                        ));
                    }
                }
                let display_path = required_string_at(
                    attachment,
                    &["displayPath"],
                    "dynamic-skill attachment",
                    envelope,
                )?;
                DirectAttachmentItem {
                    kind: ProjectedKind::System,
                    title: "Context",
                    text: format!(
                        "Loaded {} {} from {display_path}",
                        skill_names.len(),
                        plural_word(skill_names.len(), "skill", "skills")
                    ),
                }
            }
            "skill_listing" => {
                let is_initial = required_bool_at(
                    attachment,
                    &["isInitial"],
                    "skill-listing attachment",
                    envelope,
                )?;
                let skill_count = required_u64_at(
                    attachment,
                    &["skillCount"],
                    "skill-listing attachment",
                    envelope,
                )?;
                if is_initial {
                    return Ok(());
                }
                DirectAttachmentItem {
                    kind: ProjectedKind::System,
                    title: "Context",
                    text: format!(
                        "{skill_count} {} available",
                        plural_word(skill_count as usize, "skill", "skills")
                    ),
                }
            }
            "agent_listing_delta" => {
                let is_initial = required_bool_at(
                    attachment,
                    &["isInitial"],
                    "agent-listing attachment",
                    envelope,
                )?;
                let added = required_array_at(
                    attachment,
                    &["addedTypes"],
                    "agent-listing attachment",
                    envelope,
                )?;
                for (index, agent_type) in added.iter().enumerate() {
                    if !agent_type.is_string() {
                        return Err(format!(
                            "agent-listing attachment addedTypes[{index}] is not a string at sequence {}",
                            envelope.sequence
                        ));
                    }
                }
                if is_initial || added.is_empty() {
                    return Ok(());
                }
                DirectAttachmentItem {
                    kind: ProjectedKind::System,
                    title: "Context",
                    text: format!(
                        "{} agent {} available",
                        added.len(),
                        plural_word(added.len(), "type", "types")
                    ),
                }
            }
            "queued_command" => {
                let prompt = attachment.get("prompt").ok_or_else(|| {
                    format!(
                        "queued-command attachment omitted prompt at sequence {}",
                        envelope.sequence
                    )
                })?;
                let text = direct_queued_prompt_text(prompt, envelope)?;
                if let Some(ids) = attachment.get("imagePasteIds") {
                    let ids = ids.as_array().ok_or_else(|| {
                        format!(
                            "queued-command attachment has non-array imagePasteIds at sequence {}",
                            envelope.sequence
                        )
                    })?;
                    for (index, id) in ids.iter().enumerate() {
                        if id.as_u64().is_none() {
                            return Err(format!(
                                "queued-command attachment imagePasteIds[{index}] is not an unsigned integer at sequence {}",
                                envelope.sequence
                            ));
                        }
                    }
                }
                DirectAttachmentItem {
                    kind: ProjectedKind::User,
                    title: "You",
                    text,
                }
            }
            "plan_file_reference" => DirectAttachmentItem {
                kind: ProjectedKind::System,
                title: "Context",
                text: format!(
                    "Plan file referenced ({})",
                    required_string_at(
                        attachment,
                        &["planFilePath"],
                        "plan-file attachment",
                        envelope,
                    )?
                ),
            },
            "invoked_skills" => {
                let skills = required_array_at(
                    attachment,
                    &["skills"],
                    "invoked-skills attachment",
                    envelope,
                )?;
                if skills.is_empty() {
                    return Ok(());
                }
                let mut names = Vec::with_capacity(skills.len());
                for (index, skill) in skills.iter().enumerate() {
                    names.push(string_at(skill, &["name"]).ok_or_else(|| {
                        format!(
                            "invoked-skills attachment skills[{index}] omitted name at sequence {}",
                            envelope.sequence
                        )
                    })?);
                }
                DirectAttachmentItem {
                    kind: ProjectedKind::System,
                    title: "Context",
                    text: format!("Skills restored ({})", names.join(", ")),
                }
            }
            "diagnostics" => {
                let files =
                    required_array_at(attachment, &["files"], "diagnostics attachment", envelope)?;
                if files.is_empty() {
                    return Ok(());
                }
                let mut issue_count = 0_usize;
                for (index, file) in files.iter().enumerate() {
                    let diagnostics = file
                        .get("diagnostics")
                        .and_then(Value::as_array)
                        .ok_or_else(|| {
                            format!(
                                "diagnostics attachment files[{index}] omitted diagnostics array at sequence {}",
                                envelope.sequence
                            )
                        })?;
                    issue_count = issue_count.saturating_add(diagnostics.len());
                }
                DirectAttachmentItem {
                    kind: ProjectedKind::System,
                    title: "Diagnostics",
                    text: format!(
                        "Found {issue_count} new diagnostic {} in {} {}",
                        plural_word(issue_count, "issue", "issues"),
                        files.len(),
                        plural_word(files.len(), "file", "files")
                    ),
                }
            }
            "mcp_resource" => {
                let name =
                    required_string_at(attachment, &["name"], "MCP-resource attachment", envelope)?;
                let server = required_string_at(
                    attachment,
                    &["server"],
                    "MCP-resource attachment",
                    envelope,
                )?;
                required_string_at(attachment, &["uri"], "MCP-resource attachment", envelope)?;
                if !attachment.get("content").is_some_and(Value::is_object) {
                    return Err(format!(
                        "MCP-resource attachment omitted object content at sequence {}",
                        envelope.sequence
                    ));
                }
                DirectAttachmentItem {
                    kind: ProjectedKind::System,
                    title: "Context",
                    text: format!("Read MCP resource {name} from {server}"),
                }
            }
            "hook_blocking_error" => {
                let hook_event = required_string_at(
                    attachment,
                    &["hookEvent"],
                    "blocking-hook attachment",
                    envelope,
                )?;
                if matches!(hook_event.as_str(), "Stop" | "SubagentStop") {
                    return Ok(());
                }
                let hook_name = required_string_at(
                    attachment,
                    &["hookName"],
                    "blocking-hook attachment",
                    envelope,
                )?;
                let stderr = required_string_at(
                    attachment,
                    &["blockingError", "blockingError"],
                    "blocking-hook attachment",
                    envelope,
                )?;
                let stderr = stderr.trim();
                DirectAttachmentItem {
                    kind: ProjectedKind::Error,
                    title: "Hook",
                    text: if stderr.is_empty() {
                        format!("{hook_name} hook returned blocking error")
                    } else {
                        format!("{hook_name} hook returned blocking error\n{stderr}")
                    },
                }
            }
            "hook_non_blocking_error" => {
                let hook_event = required_string_at(
                    attachment,
                    &["hookEvent"],
                    "non-blocking-hook attachment",
                    envelope,
                )?;
                if matches!(hook_event.as_str(), "Stop" | "SubagentStop") {
                    return Ok(());
                }
                DirectAttachmentItem {
                    kind: ProjectedKind::Error,
                    title: "Hook",
                    text: format!(
                        "{} hook error",
                        required_string_at(
                            attachment,
                            &["hookName"],
                            "non-blocking-hook attachment",
                            envelope,
                        )?
                    ),
                }
            }
            "hook_error_during_execution" => {
                let hook_event = required_string_at(
                    attachment,
                    &["hookEvent"],
                    "hook-execution-error attachment",
                    envelope,
                )?;
                if matches!(hook_event.as_str(), "Stop" | "SubagentStop") {
                    return Ok(());
                }
                DirectAttachmentItem {
                    kind: ProjectedKind::Warning,
                    title: "Hook",
                    text: format!(
                        "{} hook warning",
                        required_string_at(
                            attachment,
                            &["hookName"],
                            "hook-execution-error attachment",
                            envelope,
                        )?
                    ),
                }
            }
            "hook_stopped_continuation" => {
                let hook_event = required_string_at(
                    attachment,
                    &["hookEvent"],
                    "hook-stopped attachment",
                    envelope,
                )?;
                if matches!(hook_event.as_str(), "Stop" | "SubagentStop") {
                    return Ok(());
                }
                let hook_name = required_string_at(
                    attachment,
                    &["hookName"],
                    "hook-stopped attachment",
                    envelope,
                )?;
                let message = required_string_at(
                    attachment,
                    &["message"],
                    "hook-stopped attachment",
                    envelope,
                )?;
                DirectAttachmentItem {
                    kind: ProjectedKind::Warning,
                    title: "Hook",
                    text: format!("{hook_name} hook stopped continuation: {message}"),
                }
            }
            "hook_system_message" => {
                let hook_name = required_string_at(
                    attachment,
                    &["hookName"],
                    "hook-system attachment",
                    envelope,
                )?;
                let content = required_string_at(
                    attachment,
                    &["content"],
                    "hook-system attachment",
                    envelope,
                )?;
                DirectAttachmentItem {
                    kind: ProjectedKind::System,
                    title: "Hook",
                    text: format!("{hook_name} says: {content}"),
                }
            }
            "hook_permission_decision" => {
                let decision = required_string_at(
                    attachment,
                    &["decision"],
                    "hook-permission attachment",
                    envelope,
                )?;
                let action = match decision.as_str() {
                    "allow" => "Allowed",
                    "deny" => "Denied",
                    unknown => {
                        return Err(format!(
                            "hook-permission attachment has unknown decision `{unknown}` at sequence {}",
                            envelope.sequence
                        ));
                    }
                };
                let hook_event = required_string_at(
                    attachment,
                    &["hookEvent"],
                    "hook-permission attachment",
                    envelope,
                )?;
                DirectAttachmentItem {
                    kind: ProjectedKind::System,
                    title: "Hook",
                    text: format!("{action} by {hook_event} hook"),
                }
            }
            "task_status" => {
                let description = required_string_at(
                    attachment,
                    &["description"],
                    "task-status attachment",
                    envelope,
                )?;
                let status = required_string_at(
                    attachment,
                    &["status"],
                    "task-status attachment",
                    envelope,
                )?;
                let status_text = match status.as_str() {
                    "completed" => "completed in background",
                    "killed" => "stopped",
                    "running" => "still running in background",
                    "pending" => "pending",
                    "failed" => "failed",
                    unknown => {
                        return Err(format!(
                            "task-status attachment has unknown status `{unknown}` at sequence {}",
                            envelope.sequence
                        ));
                    }
                };
                required_string_at(attachment, &["taskId"], "task-status attachment", envelope)?;
                required_string_at(
                    attachment,
                    &["taskType"],
                    "task-status attachment",
                    envelope,
                )?;
                DirectAttachmentItem {
                    kind: ProjectedKind::System,
                    title: "Task",
                    text: format!("Task \"{description}\" {status_text}"),
                }
            }
            "teammate_shutdown_batch" => {
                let count = required_u64_at(
                    attachment,
                    &["count"],
                    "teammate-shutdown attachment",
                    envelope,
                )?;
                DirectAttachmentItem {
                    kind: ProjectedKind::System,
                    title: "Team",
                    text: format!(
                        "{count} {} shut down gracefully",
                        plural_word(count as usize, "teammate", "teammates")
                    ),
                }
            }
            "skill_discovery" | "teammate_mailbox" | "async_hook_response" => {
                unreachable!("renderer-gated attachments were retained before item projection")
            }
            // `command_permissions` and `hook_success` were handled by the
            // exact null-rendering set before this match.
            unknown => {
                return Err(format!(
                    "direct attachment `{unknown}` has no fixed projection disposition at sequence {}",
                    envelope.sequence
                ));
            }
        };
        let presentation =
            project_direct_attachment_presentation(envelope, attachment_type, attachment)?;
        if let DirectAttachmentData::TaskStatus {
            task_id,
            task_type,
            status,
            ..
        } = &presentation.data
        {
            match status {
                DirectTaskStatus::Pending | DirectTaskStatus::Running => {
                    self.active_direct_tasks.insert(task_id.clone(), *task_type);
                }
                DirectTaskStatus::Completed
                | DirectTaskStatus::Failed
                | DirectTaskStatus::Killed => {
                    self.active_direct_tasks.remove(task_id);
                }
            }
        }
        if let DirectAttachmentData::TaskStatus {
            task_id,
            task_type: DirectTaskType::LocalWorkflow,
            status,
            ..
        } = &presentation.data
        {
            let key = direct_workflow_item_key(task_id);
            if let Some(existing) = self.item_mut(&key)
                && let Some(DirectProgressPresentation::Workflow {
                    status: workflow_status,
                    ..
                }) = existing.presentation.direct_progress.as_mut()
            {
                let incoming_status = direct_task_status_to_workflow(*status);
                if *workflow_status == DirectWorkflowStatus::Running
                    || incoming_status != DirectWorkflowStatus::Running
                {
                    *workflow_status = incoming_status;
                }
                existing.kind = ProjectedKind::Progress;
                existing.streaming = *workflow_status == DirectWorkflowStatus::Running;
                if !existing.raw_sequences.contains(&envelope.sequence) {
                    existing.raw_sequences.push(envelope.sequence);
                }
                existing.presentation.direct_attachment = Some(presentation);
                return Ok(());
            }
        }
        let (key, streaming) = match &presentation.data {
            DirectAttachmentData::TaskStatus {
                task_id,
                task_type,
                status,
                ..
            } => (
                if *task_type == DirectTaskType::LocalWorkflow {
                    direct_workflow_item_key(task_id)
                } else {
                    format!("direct-task-status:{task_id}")
                },
                matches!(
                    status,
                    DirectTaskStatus::Pending | DirectTaskStatus::Running
                ),
            ),
            _ => (envelope_key(envelope, "direct-attachment", 0), false),
        };
        let projected_item = ProjectedItem {
            key: key.clone(),
            kind: projected.kind,
            title: projected.title.to_string(),
            text: projected.text,
            streaming,
            raw_sequences: vec![envelope.sequence],
            // The fixed attachment renderer correlates hook attachments by
            // `attachment.toolUseID`; it never consumes the optional outer
            // `AttachmentMessage.toolUseID`.
            tool_use_id: None,
            presentation: ProjectedPresentation {
                direct_attachment: Some(presentation),
                ..ProjectedPresentation::default()
            },
        };
        if let Some(existing) = self.item_mut(&key) {
            let mut raw_sequences = std::mem::take(&mut existing.raw_sequences);
            if !raw_sequences.contains(&envelope.sequence) {
                raw_sequences.push(envelope.sequence);
            }
            *existing = projected_item;
            existing.raw_sequences = raw_sequences;
        } else {
            self.append_item(projected_item);
        }
        Ok(())
    }

    fn observe_direct_hook_attachment(
        &mut self,
        envelope: &RawEnvelope,
        attachment: &Value,
        primary_terminal: bool,
    ) -> Result<(), String> {
        let parent_tool_use_id = required_string_at(
            attachment,
            &["toolUseID"],
            "hook completion attachment",
            envelope,
        )?;
        let hook_event = required_string_at(
            attachment,
            &["hookEvent"],
            "hook completion attachment",
            envelope,
        )?;
        let hook_name = required_string_at(
            attachment,
            &["hookName"],
            "hook completion attachment",
            envelope,
        )?;
        let key = DirectHookKey {
            parent_tool_use_id,
            hook_event,
        };
        // `hookName` is required by the producer contract but cannot identify
        // an execution: all hooks matched by one event/matcher share it. Keep
        // validating the field without deriving identity from its value.
        let _ = hook_name;
        if !primary_terminal {
            return Ok(());
        }
        let resolved = self
            .direct_resolved_hook_counts
            .entry(key.clone())
            .or_default();
        *resolved = resolved.saturating_add(1);
        let Some(presentation) =
            self.direct_hook_progress_presentation(&key.parent_tool_use_id, &key.hook_event)
        else {
            // The direct producer can deliver a terminal attachment before a
            // retained progress record. There is no visible state until a
            // matching progress message establishes a non-zero started count.
            return Ok(());
        };
        let in_progress_count = presentation.in_progress_count;
        let resolved_count = presentation.resolved_count;
        let item_key = direct_hook_item_key(&key);
        if in_progress_count > 0 && resolved_count >= in_progress_count {
            self.remove_item(&item_key, envelope.sequence);
        } else if let Some(item) = self.item_mut(&item_key) {
            item.raw_sequences.push(envelope.sequence);
            item.presentation.direct_progress = Some(DirectProgressPresentation::Hook {
                hook_event: key.hook_event,
                in_progress_count,
                resolved_count,
            });
        }
        Ok(())
    }

    /// Close the exact synchronous Stop/SubagentStop batch named by the
    /// backend's terminal summary.
    ///
    /// This is not a synthetic timeout. `handleStopHooks` emits the summary
    /// only after `executeStopHooks` has drained the batch, and carries the
    /// same random tool-use id plus the number of progress records it yielded.
    /// That terminal is required for valid outcomes which intentionally have
    /// no primary attachment (function-hook success/blocking and backgrounded
    /// hooks). Historical summaries loaded without their transient progress
    /// records remain ordinary transcript items and do not fabricate state.
    fn observe_direct_stop_hook_summary(
        &mut self,
        envelope: &RawEnvelope,
        tool_use_id: &str,
        hook_count: &serde_json::Number,
    ) -> Result<(), String> {
        let summary_count = hook_count
            .as_u64()
            .and_then(|count| usize::try_from(count).ok())
            .ok_or_else(|| {
                format!(
                    "direct stop-hook summary has non-cardinal hookCount `{hook_count}` at sequence {}",
                    envelope.sequence
                )
            })?;
        let matching_keys = self
            .direct_hook_progress_counts
            .keys()
            .filter(|key| {
                key.parent_tool_use_id == tool_use_id
                    && matches!(key.hook_event.as_str(), "Stop" | "SubagentStop")
            })
            .cloned()
            .collect::<Vec<_>>();

        for key in matching_keys {
            let started_count = self
                .direct_hook_progress_counts
                .get(&key)
                .copied()
                .expect("matching key came from the started-count map");
            if started_count != summary_count {
                return Err(format!(
                    "direct {} hook summary count {summary_count} disagrees with {started_count} progress records for toolUseID `{tool_use_id}` at sequence {}",
                    key.hook_event, envelope.sequence
                ));
            }
            let resolved_count = self
                .direct_resolved_hook_counts
                .entry(key.clone())
                .or_default();
            *resolved_count = (*resolved_count).max(started_count);
            self.remove_item(&direct_hook_item_key(&key), envelope.sequence);
        }
        Ok(())
    }

    fn project_direct_tombstone(
        &mut self,
        envelope: &RawEnvelope,
        message_type: &str,
    ) -> Result<(), String> {
        // The fixed historical producer has one tombstone emission site:
        // streaming fallback removes the assistant messages accumulated by
        // the abandoned attempt. Supporting other Message-union members here
        // without a producer and renderer contract would be a guess.
        if message_type != "assistant" {
            return Err(format!(
                "direct tombstone targeted unsupported `{message_type}` message at sequence {}",
                envelope.sequence
            ));
        }
        let target = envelope
            .value
            .get("message")
            .ok_or_else(|| "direct tombstone lost its target message".to_string())?;
        let target_uuid =
            required_string_at(target, &["uuid"], "direct assistant tombstone", envelope)?;
        let message_id = string_at(target, &["message", "id"]).ok_or_else(|| {
            format!(
                "direct assistant tombstone omitted message.id at sequence {}",
                envelope.sequence
            )
        })?;

        if let Some(blocks) = target.pointer("/message/content").and_then(Value::as_array) {
            for block in blocks {
                if matches!(
                    string_at(block, &["type"]).as_deref(),
                    Some("tool_use" | "server_tool_use" | "mcp_tool_use")
                ) && let Some(tool_use_id) = string_at(block, &["id"])
                {
                    self.tool_names.remove(&tool_use_id);
                }
            }
        }

        let item_prefix = format!("assistant:{message_id}:");
        let item_count_before = self.items.len();
        let removed_keys = self
            .items
            .iter()
            .filter(|item| {
                let exact_uuid_match = item
                    .presentation
                    .direct_assistant
                    .as_ref()
                    .is_some_and(|assistant| assistant.identity.uuid == target_uuid);
                exact_uuid_match || item.key.starts_with(&item_prefix)
            })
            .map(|item| item.key.clone())
            .collect::<Vec<_>>();
        self.items.retain(|item| {
            let exact_uuid_match = item
                .presentation
                .direct_assistant
                .as_ref()
                .is_some_and(|assistant| assistant.identity.uuid == target_uuid);
            !exact_uuid_match && !item.key.starts_with(&item_prefix)
        });
        for key in removed_keys {
            self.record_item_removal(key, envelope.sequence);
        }
        let removed_item_count = item_count_before.saturating_sub(self.items.len());
        self.rebuild_item_index();
        self.stream_blocks
            .retain(|slot, _| slot.message_id != message_id);
        self.finalized_stream_blocks
            .retain(|key, _| key.slot.message_id != message_id);
        self.next_stream_generation
            .retain(|slot, _| slot.message_id != message_id);
        self.assistant_stream_reconciliations.retain(|_, keys| {
            !keys
                .iter()
                .flatten()
                .any(|key| key.slot.message_id == message_id)
        });
        self.active_message_by_context
            .retain(|_, active| active != &message_id);
        self.direct_tombstone_delete_effects
            .push(DirectTombstoneDeleteEffect {
                target_uuid,
                target_message_id: message_id,
                removed_item_count,
                raw_sequence: envelope.sequence,
            });
        Ok(())
    }

    fn project_auth_status(&mut self, envelope: &RawEnvelope) -> Result<(), String> {
        let value = &envelope.value;
        validate_sdk_identity(value, "auth_status", envelope)?;
        let active = required_bool_at(value, &["isAuthenticating"], "auth_status", envelope)?;
        let output = required_array_at(value, &["output"], "auth_status", envelope)?;
        let mut text = output
            .iter()
            .map(|line| {
                line.as_str().ok_or_else(|| {
                    format!(
                        "auth_status output contains a non-string member at sequence {}",
                        envelope.sequence
                    )
                })
            })
            .collect::<Result<Vec<_>, _>>()?
            .join("\n");
        let error = optional_string_at(value, &["error"], "auth_status", envelope)?;
        if let Some(error) = error.as_deref() {
            if !text.is_empty() {
                text.push('\n');
            }
            text.push_str(error);
        }
        // SDK-only state: the fixed direct message adapter explicitly ignores
        // auth_status instead of inserting it into the conversational
        // transcript. Validation above still fail-closes malformed payloads
        // and the exact envelope remains available in the bounded raw journal.
        let _ = (active, text);
        Ok(())
    }

    fn project_rate_limit(&mut self, envelope: &RawEnvelope) -> Result<(), String> {
        validate_sdk_identity(&envelope.value, "rate_limit_event", envelope)?;
        let info = envelope
            .value
            .get("rate_limit_info")
            .filter(|info| info.is_object())
            .ok_or_else(|| {
                format!(
                    "rate_limit_event omitted object rate_limit_info at sequence {}",
                    envelope.sequence
                )
            })?;
        let status = required_string_at(info, &["status"], "rate_limit_info", envelope)?;
        if !matches!(status.as_str(), "allowed" | "allowed_warning" | "rejected") {
            return Err(format!(
                "rate_limit_info has unsupported status `{status}` at sequence {}",
                envelope.sequence
            ));
        }
        for field in ["tokenRemaining", "tokenQuota", "callRemaining", "callQuota"] {
            required_number_at(info, &[field], "rate_limit_info", envelope)?;
        }
        // This event is an SDK-only state notification. The fixed CrabCode
        // direct renderer explicitly returns `ignored` for
        // `rate_limit_event`; its visible rate-limit surface is instead
        // produced by assistant API-error text and the product's own
        // rate-limit options lifecycle. Retain the validated envelope in the
        // bounded raw journal, but do not invent a transcript card or map it
        // onto the pinned renderer's semantically different credit product.
        Ok(())
    }

    fn project_named_text(
        &mut self,
        envelope: &RawEnvelope,
        kind: ProjectedKind,
        title: &str,
        fields: &[&str],
        presentation: ProjectedPresentation,
    ) -> Result<(), String> {
        validate_sdk_identity(&envelope.value, title, envelope)?;
        let text = fields
            .iter()
            .map(|field| required_string_at(&envelope.value, &[*field], title, envelope))
            .collect::<Result<Vec<_>, _>>()?
            .join("\n");
        self.append_item(ProjectedItem {
            key: envelope_key(envelope, "named", 0),
            kind,
            title: title.to_string(),
            text,
            streaming: false,
            raw_sequences: vec![envelope.sequence],
            tool_use_id: None,
            presentation,
        });
        Ok(())
    }

    fn observe_session(&mut self, value: &Value) {
        if let Some(session) = string_at(value, &["session_id"]) {
            self.session_id = Some(session);
        }
    }

    fn resolve_advisor_invocation(
        &mut self,
        tool_use_id: &str,
        result: &AdvisorResultPresentation,
    ) {
        let state = match result {
            AdvisorResultPresentation::Feedback { .. } | AdvisorResultPresentation::Redacted => {
                AdvisorInvocationState::Succeeded
            }
            AdvisorResultPresentation::Error { .. } => AdvisorInvocationState::Failed,
        };
        if let Some(AdvisorPresentation::Invocation {
            state: invocation_state,
            ..
        }) = self
            .items
            .iter_mut()
            .rev()
            .find(|item| item.tool_use_id.as_deref() == Some(tool_use_id))
            .and_then(|item| item.presentation.advisor.as_mut())
        {
            *invocation_state = state;
        }
    }

    /// Claim the earliest un-reconciled stream generation matching one
    /// completed assistant block. QueryModel emits the completed envelope
    /// before forwarding its `content_block_stop`, so candidates can be
    /// active or already finalized depending on the producer/replay order.
    fn claim_stream_block(&mut self, message_id: &str, block_type: &str) -> Option<StreamBlockKey> {
        let candidate = self
            .stream_blocks
            .values()
            .chain(self.finalized_stream_blocks.values())
            .filter(|state| {
                state.key.slot.message_id == message_id
                    && state.block_type == block_type
                    && !state.reconciled
            })
            .min_by_key(|state| state.started_sequence)
            .map(|state| state.key.clone())?;

        if let Some(active) = self.stream_blocks.get_mut(&candidate.slot)
            && active.key == candidate
        {
            active.reconciled = true;
            return Some(candidate);
        }
        if let Some(finalized) = self.finalized_stream_blocks.get_mut(&candidate) {
            finalized.reconciled = true;
            return Some(candidate);
        }
        None
    }

    fn allocate_stream_key(&mut self, slot: &StreamBlockSlot) -> StreamBlockKey {
        let next = self.next_stream_generation.entry(slot.clone()).or_default();
        let generation = *next;
        *next = next.saturating_add(1);
        StreamBlockKey {
            slot: slot.clone(),
            generation,
        }
    }

    fn stream_message_id(
        &self,
        event: &Value,
        context: &StreamContext,
        sequence: u64,
    ) -> Result<String, String> {
        event
            .pointer("/message/id")
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| self.active_message_by_context.get(context).cloned())
            .ok_or_else(|| {
                format!(
                    "stream event has no message id or matching message_start at sequence {sequence}"
                )
            })
    }

    fn observe_direct_stream_event_activity(
        &mut self,
        event_type: &str,
        event: &Value,
        envelope: &RawEnvelope,
    ) -> Result<(), String> {
        let phase = match event_type {
            "error" => Some(DirectStreamActivityPhase::Idle),
            "message_stop" => Some(DirectStreamActivityPhase::ToolUse),
            "message_delta" | "ping" => Some(DirectStreamActivityPhase::Responding),
            "content_block_start" => {
                match required_string_at(
                    event,
                    &["content_block", "type"],
                    "direct stream content_block_start",
                    envelope,
                )?
                .as_str()
                {
                    "thinking" | "redacted_thinking" => Some(DirectStreamActivityPhase::Thinking),
                    "text" | "connector_text" => Some(DirectStreamActivityPhase::Responding),
                    "tool_use"
                    | "server_tool_use"
                    | "web_search_tool_result"
                    | "web_fetch_tool_result"
                    | "code_execution_tool_result"
                    | "bash_code_execution_tool_result"
                    | "text_editor_code_execution_tool_result"
                    | "tool_search_tool_result"
                    | "mcp_tool_use"
                    | "mcp_tool_result"
                    | "container_upload"
                    | "advisor_tool_result"
                    | "compaction" => Some(DirectStreamActivityPhase::ToolInput),
                    _ => None,
                }
            }
            "sources" => Some(DirectStreamActivityPhase::Responding),
            "message_start" | "content_block_delta" | "content_block_stop" => None,
            _ => None,
        };
        if let Some(phase) = phase {
            self.direct_stream_activity.phase = phase;
        }
        if event_type == "message_start" {
            self.direct_stream_activity.ttft_ms = optional_number_at(
                &envelope.value,
                &["ttftMs"],
                "direct stream_event",
                envelope,
            )?;
        }
        self.direct_stream_activity.raw_sequence = Some(envelope.sequence);
        Ok(())
    }

    fn finalize_stream_slot(&mut self, slot: &StreamBlockSlot, sequence: u64) {
        let Some(state) = self.stream_blocks.remove(slot) else {
            return;
        };
        if !state.item_key.is_empty()
            && let Some(item) = self.item_mut(&state.item_key)
        {
            item.streaming = false;
            if !item.raw_sequences.contains(&sequence) {
                item.raw_sequences.push(sequence);
            }
        }
        self.finalized_stream_blocks
            .insert(state.key.clone(), state);
    }

    fn append_stream_delta(
        &mut self,
        key: String,
        kind: ProjectedKind,
        title: &str,
        chunk: &str,
        sequence: u64,
    ) -> Result<(), String> {
        if let Some(item) = self.item_mut(&key) {
            item.text.push_str(chunk);
            item.streaming = true;
            item.raw_sequences.push(sequence);
            return Ok(());
        }
        Err(format!(
            "stream delta lost projected item `{key}` ({kind:?}, {title}) at sequence {sequence}"
        ))
    }

    #[allow(clippy::too_many_arguments)]
    fn upsert_stream_item_with_presentation(
        &mut self,
        key: String,
        kind: ProjectedKind,
        title: &str,
        text: String,
        sequence: u64,
        tool_use_id: Option<String>,
        presentation: ProjectedPresentation,
    ) {
        if let Some(item) = self.item_mut(&key) {
            item.kind = kind;
            item.title = title.to_string();
            item.text = text;
            item.streaming = true;
            item.raw_sequences.push(sequence);
            if tool_use_id.is_some() {
                item.tool_use_id = tool_use_id;
            }
            item.presentation = presentation;
            return;
        }
        self.append_item(ProjectedItem {
            key,
            kind,
            title: title.to_string(),
            text,
            streaming: true,
            raw_sequences: vec![sequence],
            tool_use_id,
            presentation,
        });
    }

    #[allow(clippy::too_many_arguments)]
    fn upsert_final_item_with_presentation(
        &mut self,
        key: String,
        kind: ProjectedKind,
        title: &str,
        text: String,
        sequence: u64,
        tool_use_id: Option<String>,
        mut presentation: ProjectedPresentation,
    ) {
        if let Some(item) = self.item_mut(&key) {
            if let (Some(previous), Some(completed)) =
                (&item.presentation.tool, presentation.tool.as_mut())
                && completed.partial_input_json.is_none()
            {
                completed.partial_input_json = previous.partial_input_json.clone();
            }
            if let (
                Some(AdvisorPresentation::Invocation {
                    state: previous_state,
                    ..
                }),
                Some(AdvisorPresentation::Invocation {
                    state: completed_state,
                    ..
                }),
            ) = (
                item.presentation.advisor.as_ref(),
                presentation.advisor.as_mut(),
            ) && *previous_state != AdvisorInvocationState::InProgress
            {
                *completed_state = *previous_state;
            }
            item.kind = kind;
            item.title = title.to_string();
            item.text = text;
            item.streaming = false;
            item.raw_sequences.push(sequence);
            if tool_use_id.is_some() {
                item.tool_use_id = tool_use_id;
            }
            item.presentation = presentation;
            return;
        }
        self.append_item(ProjectedItem {
            key,
            kind,
            title: title.to_string(),
            text,
            streaming: false,
            raw_sequences: vec![sequence],
            tool_use_id,
            presentation,
        });
    }

    fn append_system_once(
        &mut self,
        envelope: &RawEnvelope,
        title: &str,
        text: String,
        presentation: ProjectedPresentation,
    ) {
        self.append_item(ProjectedItem {
            key: envelope_key(envelope, "system", 0),
            kind: ProjectedKind::System,
            title: title.to_string(),
            text,
            streaming: false,
            raw_sequences: vec![envelope.sequence],
            tool_use_id: None,
            presentation,
        });
    }

    fn append_item(&mut self, item: ProjectedItem) {
        if let Some(index) = self.item_index.get(&item.key).copied() {
            let previous = &self.items[index];
            let visible_changed = previous.kind != item.kind
                || previous.title != item.title
                || previous.text != item.text
                || previous.streaming != item.streaming
                || previous.tool_use_id != item.tool_use_id
                || previous.presentation != item.presentation;
            if visible_changed {
                self.bump_visible_output_epoch();
            }
            self.items[index] = item;
            return;
        }
        let index = self.items.len();
        self.item_index.insert(item.key.clone(), index);
        self.items.push(item);
        self.bump_visible_output_epoch();
    }

    fn item_mut(&mut self, key: &str) -> Option<&mut ProjectedItem> {
        let index = self.item_index.get(key).copied()?;
        self.bump_visible_output_epoch();
        self.items.get_mut(index)
    }

    /// Mutate diagnostic provenance only. Used for deduplicated provider
    /// replays whose raw sequence is retained but whose visible block is
    /// intentionally unchanged.
    fn item_mut_metadata(&mut self, key: &str) -> Option<&mut ProjectedItem> {
        let index = self.item_index.get(key).copied()?;
        self.items.get_mut(index)
    }

    fn remove_item(&mut self, key: &str, raw_sequence: u64) -> Option<ProjectedItem> {
        let index = self.item_index.get(key).copied()?;
        let removed = self.items.remove(index);
        self.bump_visible_output_epoch();
        self.record_item_removal(removed.key.clone(), raw_sequence);
        self.rebuild_item_index();
        Some(removed)
    }

    fn bump_visible_output_epoch(&mut self) {
        self.visible_output_epoch = self.visible_output_epoch.wrapping_add(1);
    }

    fn record_item_removal(&mut self, key: String, raw_sequence: u64) {
        self.next_item_removal_id = self.next_item_removal_id.saturating_add(1);
        self.item_removals.push(ProjectionItemRemoval {
            id: self.next_item_removal_id,
            key,
            raw_sequence,
        });
    }

    fn rebuild_item_index(&mut self) {
        self.item_index.clear();
        self.item_index.extend(
            self.items
                .iter()
                .enumerate()
                .map(|(index, item)| (item.key.clone(), index)),
        );
    }
}

fn optional_true_at(
    value: &Value,
    path: &[&str],
    context: &str,
    envelope: &RawEnvelope,
) -> Result<Option<bool>, String> {
    match optional_bool_at(value, path, context, envelope)? {
        None => Ok(None),
        Some(true) => Ok(Some(true)),
        Some(false) => Err(format!(
            "{context} has false true-only optional {} at sequence {}",
            path.join("."),
            envelope.sequence
        )),
    }
}

fn parse_direct_message_origin(
    value: &Value,
    path: &[&str],
    context: &str,
    envelope: &RawEnvelope,
) -> Result<Option<DirectMessageOriginKind>, String> {
    let Some(origin) = value_at(value, path) else {
        return Ok(None);
    };
    if !origin.is_object() {
        return Err(format!(
            "{context} has non-object optional {} at sequence {}",
            path.join("."),
            envelope.sequence
        ));
    }
    let kind = required_string_at(origin, &["kind"], context, envelope)?;
    match kind.as_str() {
        "human" => Ok(Some(DirectMessageOriginKind::Human)),
        "task-notification" => Ok(Some(DirectMessageOriginKind::TaskNotification)),
        "coordinator" => Ok(Some(DirectMessageOriginKind::Coordinator)),
        "channel" => {
            // `server` is backend/source identity rather than a renderer
            // field, but validating it preserves the fixed discriminated
            // union while only `kind` enters presentation state.
            required_string_at(origin, &["server"], context, envelope)?;
            Ok(Some(DirectMessageOriginKind::Channel))
        }
        "auto-accept" => Ok(Some(DirectMessageOriginKind::AutoAccept)),
        unknown => Err(format!(
            "{context} has unsupported origin.kind `{unknown}` at sequence {}",
            envelope.sequence
        )),
    }
}

fn parse_direct_user_envelope_fields(
    value: &Value,
    envelope: &RawEnvelope,
) -> Result<DirectUserEnvelopeFields, String> {
    let compact_summary = match value.get("summarizeMetadata") {
        None => None,
        Some(metadata) if metadata.is_object() => {
            let direction = match optional_string_at(
                metadata,
                &["direction"],
                "direct user summarizeMetadata",
                envelope,
            )? {
                None => None,
                Some(direction) => Some(match direction.as_str() {
                    "leading" => DirectCompactDirection::Leading,
                    "trailing" => DirectCompactDirection::Trailing,
                    "from" => DirectCompactDirection::From,
                    "up_to" => DirectCompactDirection::UpTo,
                    unknown => {
                        return Err(format!(
                            "direct user summarizeMetadata has unsupported direction `{unknown}` at sequence {}",
                            envelope.sequence
                        ));
                    }
                }),
            };
            Some(DirectCompactSummaryPresentation {
                messages_summarized: required_u64_at(
                    metadata,
                    &["messagesSummarized"],
                    "direct user summarizeMetadata",
                    envelope,
                )?,
                user_context: optional_string_at(
                    metadata,
                    &["userContext"],
                    "direct user summarizeMetadata",
                    envelope,
                )?,
                direction,
            })
        }
        Some(_) => {
            return Err(format!(
                "direct user has non-object summarizeMetadata at sequence {}",
                envelope.sequence
            ));
        }
    };
    let image_paste_ids = match value.get("imagePasteIds") {
        None => Vec::new(),
        Some(ids) => ids
            .as_array()
            .ok_or_else(|| {
                format!(
                    "direct user has non-array imagePasteIds at sequence {}",
                    envelope.sequence
                )
            })?
            .iter()
            .enumerate()
            .map(|(index, id)| {
                id.as_u64().ok_or_else(|| {
                    format!(
                        "direct user imagePasteIds[{index}] is not an unsigned integer at sequence {}",
                        envelope.sequence
                    )
                })
            })
            .collect::<Result<Vec<_>, _>>()?,
    };
    Ok(DirectUserEnvelopeFields {
        identity: DirectMessageIdentity {
            uuid: required_string_at(value, &["uuid"], "direct user", envelope)?,
        },
        timestamp: required_string_at(value, &["timestamp"], "direct user", envelope)?,
        is_meta: optional_true_at(value, &["isMeta"], "direct user", envelope)?,
        is_visible_in_transcript_only: optional_true_at(
            value,
            &["isVisibleInTranscriptOnly"],
            "direct user",
            envelope,
        )?,
        is_compact_summary: optional_true_at(
            value,
            &["isCompactSummary"],
            "direct user",
            envelope,
        )?,
        source_tool_use_id: optional_string_at(
            value,
            &["sourceToolUseID"],
            "direct user",
            envelope,
        )?,
        origin: parse_direct_message_origin(value, &["origin"], "direct user", envelope)?,
        compact_summary,
        plan_content: optional_string_at(value, &["planContent"], "direct user", envelope)?,
        tool_use_result: value.get("toolUseResult").cloned(),
        image_paste_ids,
    })
}

fn direct_user_block_type(block_type: &str, sequence: u64) -> Result<DirectUserBlockType, String> {
    Ok(match block_type {
        "text" => DirectUserBlockType::Text,
        "image" => DirectUserBlockType::Image,
        "document" => DirectUserBlockType::Document,
        "thinking" => DirectUserBlockType::Thinking,
        "redacted_thinking" => DirectUserBlockType::RedactedThinking,
        "tool_use" => DirectUserBlockType::ToolUse,
        "tool_result" => DirectUserBlockType::ToolResult,
        "server_tool_use" => DirectUserBlockType::ServerToolUse,
        "mcp_tool_use" => DirectUserBlockType::McpToolUse,
        "web_search_tool_result" => DirectUserBlockType::WebSearchToolResult,
        "web_fetch_tool_result" => DirectUserBlockType::WebFetchToolResult,
        "code_execution_tool_result" => DirectUserBlockType::CodeExecutionToolResult,
        "bash_code_execution_tool_result" => DirectUserBlockType::BashCodeExecutionToolResult,
        "text_editor_code_execution_tool_result" => {
            DirectUserBlockType::TextEditorCodeExecutionToolResult
        }
        "tool_search_tool_result" => DirectUserBlockType::ToolSearchToolResult,
        "mcp_tool_result" => DirectUserBlockType::McpToolResult,
        "container_upload" => DirectUserBlockType::ContainerUpload,
        "connector_text" => DirectUserBlockType::ConnectorText,
        "advisor_tool_result" => DirectUserBlockType::AdvisorToolResult,
        "compaction" => DirectUserBlockType::Compaction,
        unknown => {
            return Err(format!(
                "unknown direct user content block type `{unknown}` at sequence {sequence}"
            ));
        }
    })
}

struct DirectAttachmentItem {
    kind: ProjectedKind,
    title: &'static str,
    text: String,
}

fn project_direct_renderer_gated_attachment(
    envelope: &RawEnvelope,
    attachment_type: &str,
    attachment: &Value,
) -> Result<DirectRendererGatedAttachment, String> {
    let identity = DirectMessageIdentity {
        uuid: required_string_at(
            &envelope.value,
            &["uuid"],
            "renderer-gated direct attachment",
            envelope,
        )?,
    };
    let data = match attachment_type {
        "skill_discovery" => {
            let skills = required_array_at(
                attachment,
                &["skills"],
                "skill-discovery attachment",
                envelope,
            )?
            .iter()
            .enumerate()
            .map(|(index, skill)| {
                if !skill.is_object() {
                    return Err(format!(
                        "skill-discovery attachment skills[{index}] is not an object at sequence {}",
                        envelope.sequence
                    ));
                }
                Ok(DirectDiscoveredSkill {
                    name: required_string_at(
                        skill,
                        &["name"],
                        "skill-discovery attachment skill",
                        envelope,
                    )?,
                    short_id: optional_string_at(
                        skill,
                        &["shortId"],
                        "skill-discovery attachment skill",
                        envelope,
                    )?,
                })
            })
            .collect::<Result<Vec<_>, _>>()?;
            DirectRendererGatedAttachmentData::SkillDiscovery { skills }
        }
        "async_hook_response" => {
            let hook_event = required_string_at(
                attachment,
                &["hookEvent"],
                "async-hook-response attachment",
                envelope,
            )?;
            if !DIRECT_HOOK_EVENTS.contains(&hook_event.as_str())
                && !matches!(hook_event.as_str(), "StatusLine" | "FileSuggestion")
            {
                return Err(format!(
                    "async-hook-response attachment has unsupported hookEvent `{hook_event}` at sequence {}",
                    envelope.sequence
                ));
            }
            DirectRendererGatedAttachmentData::AsyncHookResponse { hook_event }
        }
        "teammate_mailbox" => {
            let messages = required_array_at(
                attachment,
                &["messages"],
                "teammate-mailbox attachment",
                envelope,
            )?
            .iter()
            .enumerate()
            .map(|(index, message)| {
                if !message.is_object() {
                    return Err(format!(
                        "teammate-mailbox attachment messages[{index}] is not an object at sequence {}",
                        envelope.sequence
                    ));
                }
                // Timestamp is part of the fixed mailbox producer shape but
                // has no renderer read. Validate it without duplicating it
                // into presentation state.
                required_string_at(
                    message,
                    &["timestamp"],
                    "teammate-mailbox attachment message",
                    envelope,
                )?;
                Ok(DirectTeammateMailboxMessage {
                    text: required_string_at(
                        message,
                        &["text"],
                        "teammate-mailbox attachment message",
                        envelope,
                    )?,
                    from: required_string_at(
                        message,
                        &["from"],
                        "teammate-mailbox attachment message",
                        envelope,
                    )?,
                    color: optional_string_at(
                        message,
                        &["color"],
                        "teammate-mailbox attachment message",
                        envelope,
                    )?,
                    summary: optional_string_at(
                        message,
                        &["summary"],
                        "teammate-mailbox attachment message",
                        envelope,
                    )?,
                })
            })
            .collect::<Result<Vec<_>, _>>()?;
            DirectRendererGatedAttachmentData::TeammateMailbox { messages }
        }
        unknown => {
            return Err(format!(
                "direct attachment `{unknown}` is not renderer-gated at sequence {}",
                envelope.sequence
            ));
        }
    };
    Ok(DirectRendererGatedAttachment {
        identity,
        raw_sequence: envelope.sequence,
        data,
    })
}

fn required_direct_hook_event(
    attachment: &Value,
    context: &str,
    envelope: &RawEnvelope,
) -> Result<String, String> {
    let hook_event = required_string_at(attachment, &["hookEvent"], context, envelope)?;
    if DIRECT_HOOK_EVENTS.contains(&hook_event.as_str()) {
        Ok(hook_event)
    } else {
        Err(format!(
            "{context} has unsupported hookEvent `{hook_event}` at sequence {}",
            envelope.sequence
        ))
    }
}

fn project_direct_attachment_presentation(
    envelope: &RawEnvelope,
    attachment_type: &str,
    attachment: &Value,
) -> Result<DirectAttachmentPresentation, String> {
    required_string_at(
        &envelope.value,
        &["timestamp"],
        "direct attachment",
        envelope,
    )?;
    optional_string_at(
        &envelope.value,
        &["toolUseID"],
        "direct attachment",
        envelope,
    )?;
    let identity = DirectMessageIdentity {
        uuid: required_string_at(&envelope.value, &["uuid"], "direct attachment", envelope)?,
    };
    let data = match attachment_type {
        "directory" => DirectAttachmentData::Directory {
            display_path: required_string_at(
                attachment,
                &["displayPath"],
                "directory attachment",
                envelope,
            )?,
        },
        "file" | "already_read_file" => {
            let context = "file attachment";
            let content_type =
                required_string_at(attachment, &["content", "type"], context, envelope)?;
            let content = match content_type.as_str() {
                "notebook" => DirectFileAttachmentContent::Notebook {
                    cell_count: required_array_at(
                        attachment,
                        &["content", "file", "cells"],
                        context,
                        envelope,
                    )?
                    .len(),
                },
                "file_unchanged" => DirectFileAttachmentContent::Unchanged,
                "text" => DirectFileAttachmentContent::Text {
                    line_count: required_u64_at(
                        attachment,
                        &["content", "file", "numLines"],
                        context,
                        envelope,
                    )?,
                    truncated: optional_bool_at(attachment, &["truncated"], context, envelope)?
                        .unwrap_or(false),
                },
                "image" | "pdf" | "parts" => DirectFileAttachmentContent::Binary {
                    original_size: required_number_at(
                        attachment,
                        &["content", "file", "originalSize"],
                        context,
                        envelope,
                    )?,
                },
                unknown => {
                    return Err(format!(
                        "{context} has unsupported content.type `{unknown}` at sequence {}",
                        envelope.sequence
                    ));
                }
            };
            DirectAttachmentData::File {
                display_path: required_string_at(attachment, &["displayPath"], context, envelope)?,
                content,
            }
        }
        "compact_file_reference" => DirectAttachmentData::CompactFileReference {
            display_path: required_string_at(
                attachment,
                &["displayPath"],
                "compact file attachment",
                envelope,
            )?,
        },
        "pdf_reference" => DirectAttachmentData::PdfReference {
            display_path: required_string_at(
                attachment,
                &["displayPath"],
                "PDF reference attachment",
                envelope,
            )?,
            page_count: required_u64_at(
                attachment,
                &["pageCount"],
                "PDF reference attachment",
                envelope,
            )?,
        },
        "selected_lines_in_ide" => DirectAttachmentData::SelectedLines {
            ide_name: required_string_at(
                attachment,
                &["ideName"],
                "selected-lines attachment",
                envelope,
            )?,
            line_start: required_u64_at(
                attachment,
                &["lineStart"],
                "selected-lines attachment",
                envelope,
            )?,
            line_end: required_u64_at(
                attachment,
                &["lineEnd"],
                "selected-lines attachment",
                envelope,
            )?,
            display_path: required_string_at(
                attachment,
                &["displayPath"],
                "selected-lines attachment",
                envelope,
            )?,
        },
        "nested_memory" => DirectAttachmentData::NestedMemory {
            display_path: required_string_at(
                attachment,
                &["displayPath"],
                "nested-memory attachment",
                envelope,
            )?,
        },
        "relevant_memories" => {
            let mut memories = Vec::new();
            for (index, memory) in required_array_at(
                attachment,
                &["memories"],
                "relevant-memories attachment",
                envelope,
            )?
            .iter()
            .enumerate()
            {
                let context = format!("relevant-memories attachment memories[{index}]");
                memories.push(DirectRelevantMemory {
                    path: required_string_at(memory, &["path"], &context, envelope)?,
                    content: required_string_at(memory, &["content"], &context, envelope)?,
                    mtime_ms: required_number_at(memory, &["mtimeMs"], &context, envelope)?,
                    header: optional_string_at(memory, &["header"], &context, envelope)?,
                    limit: optional_u64_at(memory, &["limit"], &context, envelope)?,
                });
            }
            DirectAttachmentData::RelevantMemories { memories }
        }
        "dynamic_skill" => DirectAttachmentData::DynamicSkill {
            skill_names: required_string_vec_at(
                attachment,
                &["skillNames"],
                "dynamic-skill attachment",
                envelope,
            )?,
            display_path: required_string_at(
                attachment,
                &["displayPath"],
                "dynamic-skill attachment",
                envelope,
            )?,
        },
        "skill_listing" => DirectAttachmentData::SkillListing {
            skill_count: required_u64_at(
                attachment,
                &["skillCount"],
                "skill-listing attachment",
                envelope,
            )?,
            is_initial: required_bool_at(
                attachment,
                &["isInitial"],
                "skill-listing attachment",
                envelope,
            )?,
        },
        "agent_listing_delta" => DirectAttachmentData::AgentListingDelta {
            added_types: required_string_vec_at(
                attachment,
                &["addedTypes"],
                "agent-listing attachment",
                envelope,
            )?,
            is_initial: required_bool_at(
                attachment,
                &["isInitial"],
                "agent-listing attachment",
                envelope,
            )?,
        },
        "queued_command" => {
            let prompt = attachment.get("prompt").ok_or_else(|| {
                format!(
                    "queued-command attachment omitted prompt at sequence {}",
                    envelope.sequence
                )
            })?;
            let image_paste_ids = match attachment.get("imagePasteIds") {
                None => Vec::new(),
                Some(_) => required_array_at(
                    attachment,
                    &["imagePasteIds"],
                    "queued-command attachment",
                    envelope,
                )?
                .iter()
                .enumerate()
                .map(|(index, value)| {
                    value.as_u64().ok_or_else(|| {
                        format!(
                            "queued-command attachment imagePasteIds[{index}] is not an unsigned integer at sequence {}",
                            envelope.sequence
                        )
                    })
                })
                .collect::<Result<Vec<_>, _>>()?,
            };
            DirectAttachmentData::QueuedCommand {
                text: direct_queued_prompt_text(prompt, envelope)?,
                image_paste_ids,
                command_mode: optional_string_at(
                    attachment,
                    &["commandMode"],
                    "queued-command attachment",
                    envelope,
                )?,
                is_meta: optional_bool_at(
                    attachment,
                    &["isMeta"],
                    "queued-command attachment",
                    envelope,
                )?,
                origin: parse_direct_message_origin(
                    attachment,
                    &["origin"],
                    "queued-command attachment",
                    envelope,
                )?,
            }
        }
        "plan_file_reference" => DirectAttachmentData::PlanFileReference {
            plan_file_path: required_string_at(
                attachment,
                &["planFilePath"],
                "plan-file attachment",
                envelope,
            )?,
        },
        "invoked_skills" => {
            let mut skill_names = Vec::new();
            for (index, skill) in required_array_at(
                attachment,
                &["skills"],
                "invoked-skills attachment",
                envelope,
            )?
            .iter()
            .enumerate()
            {
                skill_names.push(required_string_at(
                    skill,
                    &["name"],
                    &format!("invoked-skills attachment skills[{index}]"),
                    envelope,
                )?);
            }
            DirectAttachmentData::InvokedSkills { skill_names }
        }
        "diagnostics" => {
            let mut files = Vec::new();
            for (file_index, file) in
                required_array_at(attachment, &["files"], "diagnostics attachment", envelope)?
                    .iter()
                    .enumerate()
            {
                let file_context = format!("diagnostics attachment files[{file_index}]");
                let mut diagnostics = Vec::new();
                for (diagnostic_index, diagnostic) in
                    required_array_at(file, &["diagnostics"], &file_context, envelope)?
                        .iter()
                        .enumerate()
                {
                    let context = format!("{file_context}.diagnostics[{diagnostic_index}]");
                    let severity =
                        match required_string_at(diagnostic, &["severity"], &context, envelope)?
                            .as_str()
                        {
                            "Error" => DirectDiagnosticSeverity::Error,
                            "Warning" => DirectDiagnosticSeverity::Warning,
                            "Info" => DirectDiagnosticSeverity::Info,
                            "Hint" => DirectDiagnosticSeverity::Hint,
                            unknown => {
                                return Err(format!(
                                    "{context} has unsupported severity `{unknown}` at sequence {}",
                                    envelope.sequence
                                ));
                            }
                        };
                    diagnostics.push(DirectDiagnostic {
                        message: required_string_at(diagnostic, &["message"], &context, envelope)?,
                        severity,
                        start_line: required_number_at(
                            diagnostic,
                            &["range", "start", "line"],
                            &context,
                            envelope,
                        )?,
                        start_character: required_number_at(
                            diagnostic,
                            &["range", "start", "character"],
                            &context,
                            envelope,
                        )?,
                        code: optional_string_at(diagnostic, &["code"], &context, envelope)?,
                        source: optional_string_at(diagnostic, &["source"], &context, envelope)?,
                    });
                }
                files.push(DirectDiagnosticFile {
                    uri: required_string_at(file, &["uri"], &file_context, envelope)?,
                    diagnostics,
                });
            }
            DirectAttachmentData::Diagnostics { files }
        }
        "mcp_resource" => DirectAttachmentData::McpResource {
            name: required_string_at(attachment, &["name"], "MCP-resource attachment", envelope)?,
            server: required_string_at(
                attachment,
                &["server"],
                "MCP-resource attachment",
                envelope,
            )?,
            uri: required_string_at(attachment, &["uri"], "MCP-resource attachment", envelope)?,
        },
        "hook_blocking_error" => DirectAttachmentData::HookBlockingError {
            hook_name: required_string_at(
                attachment,
                &["hookName"],
                "blocking-hook attachment",
                envelope,
            )?,
            tool_use_id: required_string_at(
                attachment,
                &["toolUseID"],
                "blocking-hook attachment",
                envelope,
            )?,
            hook_event: required_direct_hook_event(
                attachment,
                "blocking-hook attachment",
                envelope,
            )?,
            blocking_error: required_string_at(
                attachment,
                &["blockingError", "blockingError"],
                "blocking-hook attachment",
                envelope,
            )?,
        },
        "hook_non_blocking_error" => DirectAttachmentData::HookNonBlockingError {
            hook_name: required_string_at(
                attachment,
                &["hookName"],
                "non-blocking-hook attachment",
                envelope,
            )?,
            tool_use_id: required_string_at(
                attachment,
                &["toolUseID"],
                "non-blocking-hook attachment",
                envelope,
            )?,
            hook_event: required_direct_hook_event(
                attachment,
                "non-blocking-hook attachment",
                envelope,
            )?,
        },
        "hook_error_during_execution" => DirectAttachmentData::HookErrorDuringExecution {
            hook_name: required_string_at(
                attachment,
                &["hookName"],
                "hook-execution-error attachment",
                envelope,
            )?,
            tool_use_id: required_string_at(
                attachment,
                &["toolUseID"],
                "hook-execution-error attachment",
                envelope,
            )?,
            hook_event: required_direct_hook_event(
                attachment,
                "hook-execution-error attachment",
                envelope,
            )?,
        },
        "hook_stopped_continuation" => DirectAttachmentData::HookStoppedContinuation {
            hook_name: required_string_at(
                attachment,
                &["hookName"],
                "hook-stopped attachment",
                envelope,
            )?,
            tool_use_id: required_string_at(
                attachment,
                &["toolUseID"],
                "hook-stopped attachment",
                envelope,
            )?,
            hook_event: required_direct_hook_event(
                attachment,
                "hook-stopped attachment",
                envelope,
            )?,
            message: required_string_at(
                attachment,
                &["message"],
                "hook-stopped attachment",
                envelope,
            )?,
        },
        "hook_system_message" => DirectAttachmentData::HookSystemMessage {
            hook_name: required_string_at(
                attachment,
                &["hookName"],
                "hook-system attachment",
                envelope,
            )?,
            tool_use_id: required_string_at(
                attachment,
                &["toolUseID"],
                "hook-system attachment",
                envelope,
            )?,
            hook_event: required_direct_hook_event(attachment, "hook-system attachment", envelope)?,
            content: required_string_at(
                attachment,
                &["content"],
                "hook-system attachment",
                envelope,
            )?,
        },
        "hook_permission_decision" => {
            let decision = match required_string_at(
                attachment,
                &["decision"],
                "hook-permission attachment",
                envelope,
            )?
            .as_str()
            {
                "allow" => DirectHookPermissionDecision::Allow,
                "deny" => DirectHookPermissionDecision::Deny,
                unknown => {
                    return Err(format!(
                        "hook-permission attachment has unsupported decision `{unknown}` at sequence {}",
                        envelope.sequence
                    ));
                }
            };
            DirectAttachmentData::HookPermissionDecision {
                tool_use_id: required_string_at(
                    attachment,
                    &["toolUseID"],
                    "hook-permission attachment",
                    envelope,
                )?,
                hook_event: required_direct_hook_event(
                    attachment,
                    "hook-permission attachment",
                    envelope,
                )?,
                decision,
            }
        }
        "task_status" => {
            let task_type = match required_string_at(
                attachment,
                &["taskType"],
                "task-status attachment",
                envelope,
            )?
            .as_str()
            {
                "local_bash" => DirectTaskType::LocalBash,
                "local_agent" => DirectTaskType::LocalAgent,
                "remote_agent" => DirectTaskType::RemoteAgent,
                "in_process_teammate" => DirectTaskType::InProcessTeammate,
                "local_workflow" => DirectTaskType::LocalWorkflow,
                "monitor_mcp" => DirectTaskType::MonitorMcp,
                "dream" => DirectTaskType::Dream,
                unknown => {
                    return Err(format!(
                        "task-status attachment has unsupported taskType `{unknown}` at sequence {}",
                        envelope.sequence
                    ));
                }
            };
            let status = match required_string_at(
                attachment,
                &["status"],
                "task-status attachment",
                envelope,
            )?
            .as_str()
            {
                "pending" => DirectTaskStatus::Pending,
                "running" => DirectTaskStatus::Running,
                "completed" => DirectTaskStatus::Completed,
                "failed" => DirectTaskStatus::Failed,
                "killed" => DirectTaskStatus::Killed,
                unknown => {
                    return Err(format!(
                        "task-status attachment has unsupported status `{unknown}` at sequence {}",
                        envelope.sequence
                    ));
                }
            };
            DirectAttachmentData::TaskStatus {
                task_id: required_string_at(
                    attachment,
                    &["taskId"],
                    "task-status attachment",
                    envelope,
                )?,
                task_type,
                status,
                description: required_string_at(
                    attachment,
                    &["description"],
                    "task-status attachment",
                    envelope,
                )?,
            }
        }
        "teammate_shutdown_batch" => DirectAttachmentData::TeammateShutdownBatch {
            count: required_u64_at(
                attachment,
                &["count"],
                "teammate-shutdown attachment",
                envelope,
            )?,
        },
        unknown => {
            return Err(format!(
                "direct attachment `{unknown}` reached typed renderer projection without a disposition at sequence {}",
                envelope.sequence
            ));
        }
    };
    Ok(DirectAttachmentPresentation { identity, data })
}

fn direct_hook_item_key(key: &DirectHookKey) -> String {
    format!(
        "direct-hook-progress:{}:{}",
        key.parent_tool_use_id, key.hook_event
    )
}

fn direct_workflow_item_key(task_id: &str) -> String {
    format!("direct-workflow:{task_id}")
}

fn direct_task_status_to_workflow(status: DirectTaskStatus) -> DirectWorkflowStatus {
    match status {
        DirectTaskStatus::Pending | DirectTaskStatus::Running => DirectWorkflowStatus::Running,
        DirectTaskStatus::Completed => DirectWorkflowStatus::Completed,
        DirectTaskStatus::Failed => DirectWorkflowStatus::Failed,
        DirectTaskStatus::Killed => DirectWorkflowStatus::Cancelled,
    }
}

fn parse_tool_artifacts(
    value: &Value,
    envelope: &RawEnvelope,
) -> Result<Vec<ProjectedToolArtifact>, String> {
    let artifacts = value.as_array().ok_or_else(|| {
        format!(
            "SDK user has non-array tool_artifacts at sequence {}",
            envelope.sequence
        )
    })?;
    if artifacts.len() > MAX_TOOL_ARTIFACTS_PER_RESULT {
        return Err(format!(
            "SDK user tool_artifacts count {} exceeds existing producer limit {} at sequence {}",
            artifacts.len(),
            MAX_TOOL_ARTIFACTS_PER_RESULT,
            envelope.sequence
        ));
    }

    let mut projected = Vec::with_capacity(artifacts.len());
    let mut total_declared_bytes = 0_u64;
    for (index, artifact) in artifacts.iter().enumerate() {
        let context = format!("SDK user tool_artifacts[{index}]");
        let object = artifact.as_object().ok_or_else(|| {
            format!(
                "{context} is not an object at sequence {}",
                envelope.sequence
            )
        })?;
        let id = required_string_at(artifact, &["id"], &context, envelope)?;
        let kind = match required_string_at(artifact, &["kind"], &context, envelope)?.as_str() {
            "image" => ProjectedToolArtifactKind::Image,
            "video" => ProjectedToolArtifactKind::Video,
            "audio" => ProjectedToolArtifactKind::Audio,
            "document" => ProjectedToolArtifactKind::Document,
            "archive" => ProjectedToolArtifactKind::Archive,
            "other" => ProjectedToolArtifactKind::Other,
            unknown => {
                return Err(format!(
                    "{context} has unsupported kind `{unknown}` at sequence {}",
                    envelope.sequence
                ));
            }
        };
        let mime_type = required_string_at(artifact, &["mimeType"], &context, envelope)?;
        let display_name = required_string_at(artifact, &["displayName"], &context, envelope)?;
        let producer_tool_use_id =
            required_string_at(artifact, &["producerToolUseId"], &context, envelope)?;
        if id.is_empty() || producer_tool_use_id.is_empty() {
            return Err(format!(
                "{context} has an empty artifact or producer identity at sequence {}",
                envelope.sequence
            ));
        }
        let byte_size = optional_u64_at(artifact, &["byteSize"], &context, envelope)?;
        if let Some(byte_size) = byte_size {
            if byte_size > kind.byte_limit() {
                return Err(format!(
                    "{context} byteSize {byte_size} exceeds the existing {:?} limit {} at sequence {}",
                    kind,
                    kind.byte_limit(),
                    envelope.sequence
                ));
            }
            total_declared_bytes =
                total_declared_bytes.checked_add(byte_size).ok_or_else(|| {
                    format!(
                        "{context} byteSize total overflowed at sequence {}",
                        envelope.sequence
                    )
                })?;
        }
        let sha256 = optional_string_at(artifact, &["sha256"], &context, envelope)?;
        required_object_at(artifact, &["location"], &context, envelope)?;
        let location_value = object
            .get("location")
            .expect("required_object_at established location");
        let location_type = required_string_at(location_value, &["type"], &context, envelope)?;
        let location = match location_type.as_str() {
            "runtimePath" => ProjectedToolArtifactLocation::RuntimePath {
                path: required_string_at(location_value, &["path"], &context, envelope)?,
            },
            "externalUri" => ProjectedToolArtifactLocation::ExternalUri {
                uri: required_string_at(location_value, &["uri"], &context, envelope)?,
            },
            "localHandle" => {
                let authorization = validate_required_enum_at(
                    location_value,
                    &["authorization"],
                    &["desktop-observe-local-preview"],
                    &context,
                    envelope,
                )?;
                let audit_status = validate_required_enum_at(
                    location_value,
                    &["auditStatus"],
                    &[
                        "not_started",
                        "recorded",
                        "preflight_failed",
                        "result_failed",
                    ],
                    &context,
                    envelope,
                )?;
                ProjectedToolArtifactLocation::LocalHandle {
                    handle: required_string_at(location_value, &["handle"], &context, envelope)?,
                    account_epoch_ms: optional_u64_at(
                        location_value,
                        &["accountEpochMs"],
                        &context,
                        envelope,
                    )?,
                    created_at_ms: required_u64_at(
                        location_value,
                        &["createdAtMs"],
                        &context,
                        envelope,
                    )?,
                    expires_at_ms: required_u64_at(
                        location_value,
                        &["expiresAtMs"],
                        &context,
                        envelope,
                    )?,
                    capture_id: required_string_at(
                        location_value,
                        &["captureId"],
                        &context,
                        envelope,
                    )?,
                    authorization,
                    audit_status,
                    audit_ref: optional_string_at(
                        location_value,
                        &["auditRef"],
                        &context,
                        envelope,
                    )?,
                    owner_thread_id: optional_string_at(
                        location_value,
                        &["ownerThreadId"],
                        &context,
                        envelope,
                    )?,
                    owner_turn_id: optional_string_at(
                        location_value,
                        &["ownerTurnId"],
                        &context,
                        envelope,
                    )?,
                }
            }
            unknown => {
                return Err(format!(
                    "{context} has unsupported location.type `{unknown}` at sequence {}",
                    envelope.sequence
                ));
            }
        };
        projected.push(ProjectedToolArtifact {
            id,
            kind,
            mime_type,
            display_name,
            location,
            byte_size,
            sha256,
            producer_tool_use_id,
            raw_sequences: vec![envelope.sequence],
        });
    }
    if total_declared_bytes > MAX_TOTAL_TOOL_ARTIFACT_BYTES_PER_RESULT {
        return Err(format!(
            "SDK user tool_artifacts declared byte total {total_declared_bytes} exceeds existing producer limit {MAX_TOTAL_TOOL_ARTIFACT_BYTES_PER_RESULT} at sequence {}",
            envelope.sequence
        ));
    }
    Ok(projected)
}

fn value_at<'a>(value: &'a Value, path: &[&str]) -> Option<&'a Value> {
    let mut current = value;
    for component in path {
        current = current.get(*component)?;
    }
    Some(current)
}

fn required_string_at(
    value: &Value,
    path: &[&str],
    context: &str,
    envelope: &RawEnvelope,
) -> Result<String, String> {
    value_at(value, path)
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| {
            format!(
                "{context} omitted string {} at sequence {}",
                path.join("."),
                envelope.sequence
            )
        })
}

fn optional_string_at(
    value: &Value,
    path: &[&str],
    context: &str,
    envelope: &RawEnvelope,
) -> Result<Option<String>, String> {
    let Some(raw) = value_at(value, path) else {
        return Ok(None);
    };
    raw.as_str()
        .map(|text| Some(text.to_string()))
        .ok_or_else(|| {
            format!(
                "{context} has non-string optional {} at sequence {}",
                path.join("."),
                envelope.sequence
            )
        })
}

fn required_nullable_string_at(
    value: &Value,
    path: &[&str],
    context: &str,
    envelope: &RawEnvelope,
) -> Result<Option<String>, String> {
    match value_at(value, path) {
        Some(Value::Null) => Ok(None),
        Some(Value::String(text)) => Ok(Some(text.clone())),
        Some(_) => Err(format!(
            "{context} has non-string/non-null {} at sequence {}",
            path.join("."),
            envelope.sequence
        )),
        None => Err(format!(
            "{context} omitted string/null {} at sequence {}",
            path.join("."),
            envelope.sequence
        )),
    }
}

fn required_bool_at(
    value: &Value,
    path: &[&str],
    context: &str,
    envelope: &RawEnvelope,
) -> Result<bool, String> {
    value_at(value, path)
        .and_then(Value::as_bool)
        .ok_or_else(|| {
            format!(
                "{context} omitted boolean {} at sequence {}",
                path.join("."),
                envelope.sequence
            )
        })
}

fn optional_bool_at(
    value: &Value,
    path: &[&str],
    context: &str,
    envelope: &RawEnvelope,
) -> Result<Option<bool>, String> {
    let Some(raw) = value_at(value, path) else {
        return Ok(None);
    };
    raw.as_bool().map(Some).ok_or_else(|| {
        format!(
            "{context} has non-boolean optional {} at sequence {}",
            path.join("."),
            envelope.sequence
        )
    })
}

fn required_u64_at(
    value: &Value,
    path: &[&str],
    context: &str,
    envelope: &RawEnvelope,
) -> Result<u64, String> {
    value_at(value, path)
        .and_then(Value::as_u64)
        .ok_or_else(|| {
            format!(
                "{context} omitted unsigned integer {} at sequence {}",
                path.join("."),
                envelope.sequence
            )
        })
}

fn required_u32_at(
    value: &Value,
    path: &[&str],
    context: &str,
    envelope: &RawEnvelope,
) -> Result<u32, String> {
    let raw = required_u64_at(value, path, context, envelope)?;
    u32::try_from(raw).map_err(|_| {
        format!(
            "{context} has out-of-range unsigned integer {} at sequence {}",
            path.join("."),
            envelope.sequence
        )
    })
}

fn required_i64_at(
    value: &Value,
    path: &[&str],
    context: &str,
    envelope: &RawEnvelope,
) -> Result<i64, String> {
    value_at(value, path)
        .and_then(Value::as_i64)
        .ok_or_else(|| {
            format!(
                "{context} omitted signed integer {} at sequence {}",
                path.join("."),
                envelope.sequence
            )
        })
}

fn optional_u64_at(
    value: &Value,
    path: &[&str],
    context: &str,
    envelope: &RawEnvelope,
) -> Result<Option<u64>, String> {
    let Some(raw) = value_at(value, path) else {
        return Ok(None);
    };
    raw.as_u64().map(Some).ok_or_else(|| {
        format!(
            "{context} has non-u64 optional {} at sequence {}",
            path.join("."),
            envelope.sequence
        )
    })
}

fn required_number_at(
    value: &Value,
    path: &[&str],
    context: &str,
    envelope: &RawEnvelope,
) -> Result<serde_json::Number, String> {
    value_at(value, path)
        .and_then(Value::as_number)
        .cloned()
        .ok_or_else(|| {
            format!(
                "{context} omitted number {} at sequence {}",
                path.join("."),
                envelope.sequence
            )
        })
}

fn optional_nullable_number_at(
    value: &Value,
    path: &[&str],
    context: &str,
    envelope: &RawEnvelope,
) -> Result<Option<serde_json::Number>, String> {
    match value_at(value, path) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Number(number)) => Ok(Some(number.clone())),
        Some(_) => Err(format!(
            "{context} has non-number/non-null optional {} at sequence {}",
            path.join("."),
            envelope.sequence
        )),
    }
}

fn optional_number_at(
    value: &Value,
    path: &[&str],
    context: &str,
    envelope: &RawEnvelope,
) -> Result<Option<serde_json::Number>, String> {
    let Some(raw) = value_at(value, path) else {
        return Ok(None);
    };
    raw.as_number().cloned().map(Some).ok_or_else(|| {
        format!(
            "{context} has non-number optional {} at sequence {}",
            path.join("."),
            envelope.sequence
        )
    })
}

fn required_array_at<'a>(
    value: &'a Value,
    path: &[&str],
    context: &str,
    envelope: &RawEnvelope,
) -> Result<&'a Vec<Value>, String> {
    value_at(value, path)
        .and_then(Value::as_array)
        .ok_or_else(|| {
            format!(
                "{context} omitted array {} at sequence {}",
                path.join("."),
                envelope.sequence
            )
        })
}

fn required_object_at<'a>(
    value: &'a Value,
    path: &[&str],
    context: &str,
    envelope: &RawEnvelope,
) -> Result<&'a serde_json::Map<String, Value>, String> {
    value_at(value, path)
        .and_then(Value::as_object)
        .ok_or_else(|| {
            format!(
                "{context} omitted object {} at sequence {}",
                path.join("."),
                envelope.sequence
            )
        })
}

fn required_string_array_at(
    value: &Value,
    path: &[&str],
    context: &str,
    envelope: &RawEnvelope,
) -> Result<(), String> {
    let values = required_array_at(value, path, context, envelope)?;
    if values.iter().all(Value::is_string) {
        Ok(())
    } else {
        Err(format!(
            "{context} has non-string member in {} at sequence {}",
            path.join("."),
            envelope.sequence
        ))
    }
}

fn validate_sdk_identity(
    value: &Value,
    context: &str,
    envelope: &RawEnvelope,
) -> Result<(), String> {
    required_string_at(value, &["uuid"], context, envelope)?;
    required_string_at(value, &["session_id"], context, envelope)?;
    Ok(())
}

fn validate_required_enum_at(
    value: &Value,
    path: &[&str],
    allowed: &[&str],
    context: &str,
    envelope: &RawEnvelope,
) -> Result<String, String> {
    let observed = required_string_at(value, path, context, envelope)?;
    if allowed.contains(&observed.as_str()) {
        Ok(observed)
    } else {
        Err(format!(
            "{context} has unsupported {} `{observed}` at sequence {}",
            path.join("."),
            envelope.sequence
        ))
    }
}

fn validate_optional_enum_at(
    value: &Value,
    path: &[&str],
    allowed: &[&str],
    context: &str,
    envelope: &RawEnvelope,
) -> Result<Option<String>, String> {
    let Some(observed) = optional_string_at(value, path, context, envelope)? else {
        return Ok(None);
    };
    if allowed.contains(&observed.as_str()) {
        Ok(Some(observed))
    } else {
        Err(format!(
            "{context} has unsupported optional {} `{observed}` at sequence {}",
            path.join("."),
            envelope.sequence
        ))
    }
}

fn validate_object_array_string_fields(
    values: &[Value],
    required: &[&str],
    optional: &[&str],
    context: &str,
) -> Result<(), String> {
    for (index, value) in values.iter().enumerate() {
        let object = value
            .as_object()
            .ok_or_else(|| format!("{context}[{index}] is not an object"))?;
        for field in required {
            if !object.get(*field).is_some_and(Value::is_string) {
                return Err(format!("{context}[{index}] omitted string field `{field}`"));
            }
        }
        for field in optional {
            if object.get(*field).is_some_and(|value| !value.is_string()) {
                return Err(format!(
                    "{context}[{index}] has non-string optional field `{field}`"
                ));
            }
        }
    }
    Ok(())
}

fn required_string_vec_at(
    value: &Value,
    path: &[&str],
    context: &str,
    envelope: &RawEnvelope,
) -> Result<Vec<String>, String> {
    required_string_array_at(value, path, context, envelope)?;
    Ok(required_array_at(value, path, context, envelope)?
        .iter()
        .filter_map(Value::as_str)
        .map(str::to_string)
        .collect())
}

fn first_serialized_error_cause_code(
    error: &Value,
    envelope: &RawEnvelope,
) -> Result<Option<String>, String> {
    let mut current = error.get("cause");
    for depth in 0..5 {
        let Some(value) = current else {
            return Ok(None);
        };
        let object = value.as_object().ok_or_else(|| {
            format!(
                "direct system api_error cause depth {depth} is not an object at sequence {}",
                envelope.sequence
            )
        })?;
        if let Some(code) = object.get("code") {
            return code.as_str().map(|value| Some(value.to_string())).ok_or_else(|| {
                format!(
                    "direct system api_error cause depth {depth} has non-string code at sequence {}",
                    envelope.sequence
                )
            });
        }
        current = object.get("cause");
    }
    Ok(None)
}

fn project_direct_system_presentation(
    value: &Value,
    subtype: &DirectSystemSubtype,
    envelope: &RawEnvelope,
) -> Result<DirectSystemPresentation, String> {
    validate_direct_system(value, subtype, envelope)?;
    let context = "direct system";
    let identity = DirectMessageIdentity {
        uuid: required_string_at(value, &["uuid"], context, envelope)?,
    };
    let content = || required_string_at(value, &["content"], context, envelope);
    let data = match subtype {
        DirectSystemSubtype::Informational => DirectSystemData::Informational {
            content: content()?,
            tool_use_id: optional_string_at(value, &["toolUseID"], context, envelope)?,
        },
        DirectSystemSubtype::PermissionRetry => DirectSystemData::PermissionRetry {
            commands: required_string_vec_at(value, &["commands"], context, envelope)?,
        },
        DirectSystemSubtype::ScheduledTaskFire => DirectSystemData::ScheduledTaskFire {
            content: content()?,
        },
        DirectSystemSubtype::StopHookSummary => {
            let mut hook_infos = Vec::new();
            for info in required_array_at(value, &["hookInfos"], context, envelope)? {
                hook_infos.push(DirectStopHookInfo {
                    hook_name: required_string_at(info, &["hookName"], context, envelope)?,
                    duration_ms: required_number_at(info, &["durationMs"], context, envelope)?,
                });
            }
            DirectSystemData::StopHookSummary {
                hook_count: required_number_at(value, &["hookCount"], context, envelope)?,
                hook_infos,
                hook_errors: required_string_vec_at(value, &["hookErrors"], context, envelope)?,
                prevented_continuation: required_bool_at(
                    value,
                    &["preventedContinuation"],
                    context,
                    envelope,
                )?,
                stop_reason: optional_string_at(value, &["stopReason"], context, envelope)?,
                has_output: required_bool_at(value, &["hasOutput"], context, envelope)?,
                tool_use_id: optional_string_at(value, &["toolUseID"], context, envelope)?,
                hook_label: optional_string_at(value, &["hookLabel"], context, envelope)?,
                total_duration_ms: optional_number_at(
                    value,
                    &["totalDurationMs"],
                    context,
                    envelope,
                )?,
            }
        }
        DirectSystemSubtype::TurnDuration => DirectSystemData::TurnDuration {
            duration_ms: required_number_at(value, &["durationMs"], context, envelope)?,
            budget_tokens: optional_number_at(value, &["budgetTokens"], context, envelope)?,
            budget_limit: optional_number_at(value, &["budgetLimit"], context, envelope)?,
            budget_nudges: optional_number_at(value, &["budgetNudges"], context, envelope)?,
        },
        DirectSystemSubtype::AwaySummary => DirectSystemData::AwaySummary {
            content: content()?,
        },
        DirectSystemSubtype::MemorySaved => DirectSystemData::MemorySaved {
            written_paths: required_string_vec_at(value, &["writtenPaths"], context, envelope)?,
            team_count: optional_number_at(value, &["teamCount"], context, envelope)?,
        },
        DirectSystemSubtype::AgentsKilled => DirectSystemData::AgentsKilled,
        DirectSystemSubtype::ApiMetrics => DirectSystemData::ApiMetrics,
        DirectSystemSubtype::LocalCommand => DirectSystemData::LocalCommand {
            content: content()?,
        },
        DirectSystemSubtype::ApiError => {
            let error_value = value_at(value, &["error"])
                .expect("validate_direct_system established api_error.error");
            let status = match error_value.get("status") {
                None => None,
                Some(Value::Number(status)) => Some(status.clone()),
                Some(_) => {
                    return Err(format!(
                        "{context} api_error.error has non-number status at sequence {}",
                        envelope.sequence
                    ));
                }
            };
            if let Some(response_body) = error_value.get("error")
                && !response_body.is_object()
            {
                return Err(format!(
                    "{context} api_error.error.error is not an object at sequence {}",
                    envelope.sequence
                ));
            }
            DirectSystemData::ApiError {
                error: DirectApiErrorPresentation {
                    message: optional_string_at(error_value, &["message"], context, envelope)?,
                    status,
                    nested_message: optional_string_at(
                        error_value,
                        &["error", "message"],
                        context,
                        envelope,
                    )?,
                    deeply_nested_message: optional_string_at(
                        error_value,
                        &["error", "error", "message"],
                        context,
                        envelope,
                    )?,
                    connection_code: first_serialized_error_cause_code(error_value, envelope)?,
                },
                retry_in_ms: required_number_at(value, &["retryInMs"], context, envelope)?,
                retry_attempt: required_number_at(value, &["retryAttempt"], context, envelope)?,
                max_retries: required_number_at(value, &["maxRetries"], context, envelope)?,
            }
        }
        DirectSystemSubtype::CompactBoundary => DirectSystemData::CompactBoundary,
        DirectSystemSubtype::MicrocompactBoundary => DirectSystemData::MicrocompactBoundary,
        DirectSystemSubtype::CommandInput => DirectSystemData::CommandInput {
            content: content()?,
        },
        DirectSystemSubtype::Thinking => DirectSystemData::Thinking,
        DirectSystemSubtype::FileSnapshot => DirectSystemData::FileSnapshot {
            content: content()?,
        },
    };
    Ok(DirectSystemPresentation { identity, data })
}

fn validate_direct_system(
    value: &Value,
    subtype: &DirectSystemSubtype,
    envelope: &RawEnvelope,
) -> Result<(), String> {
    let context = "direct system";
    required_string_at(value, &["uuid"], context, envelope)?;
    required_string_at(value, &["timestamp"], context, envelope)?;
    optional_bool_at(value, &["isMeta"], context, envelope)?;
    let require_content =
        |value: &Value| required_string_at(value, &["content"], context, envelope).map(|_| ());
    let require_level = |value: &Value| {
        validate_required_enum_at(
            value,
            &["level"],
            &["info", "warning", "error", "suggestion"],
            context,
            envelope,
        )
        .map(|_| ())
    };
    match subtype {
        DirectSystemSubtype::Informational => {
            require_content(value)?;
            require_level(value)?;
            optional_string_at(value, &["toolUseID"], context, envelope)?;
            optional_bool_at(value, &["preventContinuation"], context, envelope)?;
        }
        DirectSystemSubtype::PermissionRetry => {
            require_content(value)?;
            require_level(value)?;
            required_string_array_at(value, &["commands"], context, envelope)?;
        }
        DirectSystemSubtype::ScheduledTaskFire
        | DirectSystemSubtype::AwaySummary
        | DirectSystemSubtype::CommandInput
        | DirectSystemSubtype::Thinking => require_content(value)?,
        DirectSystemSubtype::StopHookSummary => {
            required_number_at(value, &["hookCount"], context, envelope)?;
            let hook_infos = required_array_at(value, &["hookInfos"], context, envelope)?;
            for (index, info) in hook_infos.iter().enumerate() {
                let info = info.as_object().ok_or_else(|| {
                    format!(
                        "{context} hookInfos[{index}] is not an object at sequence {}",
                        envelope.sequence
                    )
                })?;
                if !info.get("hookName").is_some_and(Value::is_string)
                    || !info.get("durationMs").is_some_and(Value::is_number)
                    || info.get("output").is_some_and(|output| !output.is_string())
                {
                    return Err(format!(
                        "{context} hookInfos[{index}] violates StopHookInfo at sequence {}",
                        envelope.sequence
                    ));
                }
            }
            required_string_array_at(value, &["hookErrors"], context, envelope)?;
            required_bool_at(value, &["preventedContinuation"], context, envelope)?;
            optional_string_at(value, &["stopReason"], context, envelope)?;
            required_bool_at(value, &["hasOutput"], context, envelope)?;
            require_level(value)?;
            optional_string_at(value, &["toolUseID"], context, envelope)?;
            optional_string_at(value, &["hookLabel"], context, envelope)?;
            optional_number_at(value, &["totalDurationMs"], context, envelope)?;
        }
        DirectSystemSubtype::TurnDuration => {
            required_number_at(value, &["durationMs"], context, envelope)?;
            for field in [
                "budgetTokens",
                "budgetLimit",
                "budgetNudges",
                "messageCount",
            ] {
                optional_number_at(value, &[field], context, envelope)?;
            }
        }
        DirectSystemSubtype::MemorySaved => {
            required_string_array_at(value, &["writtenPaths"], context, envelope)?;
            optional_number_at(value, &["teamCount"], context, envelope)?;
        }
        DirectSystemSubtype::AgentsKilled => {}
        DirectSystemSubtype::ApiMetrics => {
            required_number_at(value, &["ttftMs"], context, envelope)?;
            required_number_at(value, &["otps"], context, envelope)?;
            optional_bool_at(value, &["isP50"], context, envelope)?;
            for field in [
                "hookDurationMs",
                "turnDurationMs",
                "toolDurationMs",
                "classifierDurationMs",
                "toolCount",
                "hookCount",
                "classifierCount",
                "configWriteCount",
            ] {
                optional_number_at(value, &[field], context, envelope)?;
            }
        }
        DirectSystemSubtype::LocalCommand => {
            require_content(value)?;
            validate_optional_enum_at(
                value,
                &["level"],
                &["info", "warning", "error", "suggestion"],
                context,
                envelope,
            )?;
        }
        DirectSystemSubtype::ApiError => {
            let level = required_string_at(value, &["level"], context, envelope)?;
            if level != "error" {
                return Err(format!(
                    "{context} api_error has non-error level `{level}` at sequence {}",
                    envelope.sequence
                ));
            }
            required_object_at(value, &["error"], context, envelope)?;
            for field in ["retryInMs", "retryAttempt", "maxRetries"] {
                required_number_at(value, &[field], context, envelope)?;
            }
        }
        DirectSystemSubtype::CompactBoundary => {
            require_content(value)?;
            require_level(value)?;
            required_object_at(value, &["compactMetadata"], context, envelope)?;
            validate_required_enum_at(
                value,
                &["compactMetadata", "trigger"],
                &["manual", "auto"],
                context,
                envelope,
            )?;
            required_number_at(value, &["compactMetadata", "preTokens"], context, envelope)?;
            optional_string_at(
                value,
                &["compactMetadata", "userContext"],
                context,
                envelope,
            )?;
            optional_number_at(
                value,
                &["compactMetadata", "messagesSummarized"],
                context,
                envelope,
            )?;
            if value
                .pointer("/compactMetadata/preCompactDiscoveredTools")
                .is_some()
            {
                required_string_array_at(
                    value,
                    &["compactMetadata", "preCompactDiscoveredTools"],
                    context,
                    envelope,
                )?;
            }
            if value.pointer("/compactMetadata/preservedSegment").is_some() {
                required_object_at(
                    value,
                    &["compactMetadata", "preservedSegment"],
                    context,
                    envelope,
                )?;
                for field in ["headUuid", "anchorUuid", "tailUuid"] {
                    required_string_at(
                        value,
                        &["compactMetadata", "preservedSegment", field],
                        context,
                        envelope,
                    )?;
                }
            }
            optional_string_at(value, &["logicalParentUuid"], context, envelope)?;
        }
        DirectSystemSubtype::MicrocompactBoundary => {
            require_content(value)?;
            require_level(value)?;
            required_object_at(value, &["microcompactMetadata"], context, envelope)?;
            let trigger = required_string_at(
                value,
                &["microcompactMetadata", "trigger"],
                context,
                envelope,
            )?;
            if trigger != "auto" {
                return Err(format!(
                    "{context} microcompact trigger is `{trigger}` at sequence {}",
                    envelope.sequence
                ));
            }
            for field in ["preTokens", "tokensSaved"] {
                required_number_at(value, &["microcompactMetadata", field], context, envelope)?;
            }
            for field in ["compactedToolIds", "clearedAttachmentUUIDs"] {
                required_string_array_at(
                    value,
                    &["microcompactMetadata", field],
                    context,
                    envelope,
                )?;
            }
        }
        DirectSystemSubtype::FileSnapshot => {
            require_content(value)?;
            require_level(value)?;
            let files = required_array_at(value, &["snapshotFiles"], context, envelope)?;
            validate_object_array_string_fields(
                files,
                &["key", "path", "content"],
                &[],
                &format!("{context} snapshotFiles at sequence {}", envelope.sequence),
            )?;
        }
    }
    Ok(())
}

fn validate_task_usage(
    value: &Value,
    required: bool,
    context: &str,
    envelope: &RawEnvelope,
) -> Result<(), String> {
    match value.get("usage") {
        None if !required => return Ok(()),
        Some(Value::Object(_)) => {}
        None => {
            return Err(format!(
                "{context} omitted object usage at sequence {}",
                envelope.sequence
            ));
        }
        Some(_) => {
            return Err(format!(
                "{context} has non-object usage at sequence {}",
                envelope.sequence
            ));
        }
    }
    for field in ["total_tokens", "tool_uses", "duration_ms"] {
        required_number_at(value, &["usage", field], context, envelope)?;
    }
    Ok(())
}

fn plural_word<'a>(count: usize, singular: &'a str, plural: &'a str) -> &'a str {
    if count == 1 { singular } else { plural }
}

fn direct_file_attachment_text(
    attachment: &Value,
    envelope: &RawEnvelope,
) -> Result<String, String> {
    let display_path =
        required_string_at(attachment, &["displayPath"], "file attachment", envelope)?;
    let content_type = required_string_at(
        attachment,
        &["content", "type"],
        "file attachment",
        envelope,
    )?;
    let detail = match content_type.as_str() {
        "notebook" => {
            let cells = required_array_at(
                attachment,
                &["content", "file", "cells"],
                "notebook file attachment",
                envelope,
            )?;
            format!("{} cells", cells.len())
        }
        "file_unchanged" => "unchanged".to_string(),
        "text" => {
            let lines = required_u64_at(
                attachment,
                &["content", "file", "numLines"],
                "text file attachment",
                envelope,
            )?;
            let truncated = match value_at(attachment, &["truncated"]) {
                Some(value) => value.as_bool().ok_or_else(|| {
                    format!(
                        "file attachment has non-boolean truncated at sequence {}",
                        envelope.sequence
                    )
                })?,
                None => false,
            };
            format!("{lines}{} lines", if truncated { "+" } else { "" })
        }
        "image" | "pdf" | "parts" => {
            let size = required_number_at(
                attachment,
                &["content", "file", "originalSize"],
                "binary file attachment",
                envelope,
            )?;
            format_file_size_like_fixed_source(size.as_f64().ok_or_else(|| {
                format!(
                    "binary file attachment originalSize is not finite at sequence {}",
                    envelope.sequence
                )
            })?)
        }
        unknown => {
            return Err(format!(
                "file attachment has unknown content type `{unknown}` at sequence {}",
                envelope.sequence
            ));
        }
    };
    Ok(format!("Read {display_path} ({detail})"))
}

fn format_file_size_like_fixed_source(size_in_bytes: f64) -> String {
    fn one_decimal_without_zero(value: f64) -> String {
        let formatted = format!("{value:.1}");
        formatted
            .strip_suffix(".0")
            .map_or(formatted.clone(), str::to_string)
    }

    let kb = size_in_bytes / 1024.0;
    if kb < 1.0 {
        return format!("{size_in_bytes} bytes");
    }
    if kb < 1024.0 {
        return format!("{}KB", one_decimal_without_zero(kb));
    }
    let mb = kb / 1024.0;
    if mb < 1024.0 {
        return format!("{}MB", one_decimal_without_zero(mb));
    }
    let gb = mb / 1024.0;
    format!("{}GB", one_decimal_without_zero(gb))
}

fn direct_queued_prompt_text(prompt: &Value, envelope: &RawEnvelope) -> Result<String, String> {
    if let Some(text) = prompt.as_str() {
        return Ok(text.to_string());
    }
    let blocks = prompt.as_array().ok_or_else(|| {
        format!(
            "queued-command attachment prompt is neither string nor array at sequence {}",
            envelope.sequence
        )
    })?;
    let mut text = Vec::new();
    for block in blocks {
        if string_at(block, &["type"]).as_deref() == Some("text") {
            text.push(required_string_at(
                block,
                &["text"],
                "queued-command text block",
                envelope,
            )?);
        }
    }
    Ok(text.join("\n").trim().to_string())
}

fn envelope_key(envelope: &RawEnvelope, prefix: &str, index: usize) -> String {
    let identity = string_at(&envelope.value, &["uuid"])
        .unwrap_or_else(|| format!("sequence-{}", envelope.sequence));
    format!("{prefix}:{identity}:{index}")
}

fn parse_stream_error(
    event: &Value,
    envelope: &RawEnvelope,
) -> Result<StreamErrorPresentation, String> {
    if let Some(error) = event.get("error")
        && !error.is_object()
    {
        return Err(format!(
            "stream error event has non-object error at sequence {}",
            envelope.sequence
        ));
    }
    let error_type = optional_string_at(event, &["error", "type"], "stream error event", envelope)?;
    let error_code = optional_string_at(event, &["errorCode"], "stream error event", envelope)?;
    let source_message =
        optional_string_at(event, &["error", "message"], "stream error event", envelope)?;
    let message = source_message
        .filter(|message| !message.trim().is_empty())
        .or_else(|| {
            error_type
                .as_ref()
                .map(|kind| format!("Upstream stream error: {kind}"))
        })
        .or_else(|| {
            error_code
                .as_ref()
                .map(|code| format!("Upstream stream error: {code}"))
        })
        .unwrap_or_else(|| "Upstream stream error".to_string());
    Ok(StreamErrorPresentation {
        error_type,
        error_code,
        message,
    })
}

/// The policy class the contract *declares* for this envelope's stream event.
///
/// This is a static property of the event type, fixed before ingestion, and it
/// says what would happen **if** the projection rejected the envelope. It is
/// not a result, and on its own it never means anything went wrong. Non-stream
/// envelopes declare no class.
fn declared_stream_disposition(envelope: &RawEnvelope) -> Option<&'static str> {
    let EnvelopeClass::StreamEvent {
        event_type: Some(event_type),
    } = &envelope.classification
    else {
        return None;
    };
    Some(match generated_stream_event_disposition(event_type) {
        Some(GeneratedEventDisposition::PresentationOnly) => "presentation-only",
        Some(GeneratedEventDisposition::Recoverable) => "recoverable",
        Some(GeneratedEventDisposition::TurnFatal) => "turn-fatal",
        Some(GeneratedEventDisposition::ProtocolFatal) => "protocol-fatal",
        None => "recoverable",
    })
}

/// Diagnostic fields for one ingested envelope, as
/// `(outcome, declared_disposition, issue_code, root_error_code)`.
///
/// `outcome` is what actually happened to this envelope and is the only field
/// that reports a failure. `declared_disposition` is the contract's static
/// policy class for the event type, carried alongside so a reader can tell a
/// severe *policy* from a severe *result*.
///
/// These were previously one conflated `disposition` field, which reported an
/// accepted envelope under the name of its declared class. A journal from a
/// healthy session consequently read as thousands of "turn-fatal" records, and
/// the one genuine failure was indistinguishable from them at a glance.
fn projection_effect_diagnostic_fields<'a>(
    effect: &'a ProjectionEffect,
    envelope: &RawEnvelope,
) -> (
    &'static str,
    Option<&'static str>,
    Option<&'a str>,
    Option<&'static str>,
) {
    let declared = declared_stream_disposition(envelope);
    match effect {
        ProjectionEffect::SessionTransition { effect, .. } => {
            projection_effect_diagnostic_fields(effect, envelope)
        }
        ProjectionEffect::CompatibilityFault { code, .. } => {
            ("recoverable", declared, Some(code.as_str()), None)
        }
        ProjectionEffect::AbortTurn { code, .. } => (
            "turn-fatal",
            declared,
            Some(code.as_str()),
            Some("projection_turn_fatal"),
        ),
        ProjectionEffect::FailClosed { .. } => (
            "protocol-fatal",
            declared,
            None,
            Some("projection_protocol_fatal"),
        ),
        // The projection accepted the envelope. Say so, whatever the event
        // type's declared class happens to be.
        _ => ("accepted", declared, None, None),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SourcesEventValidation {
    Empty,
    Valid,
    Malformed(&'static str),
}

fn validate_stream_sources_event(event: &Value) -> SourcesEventValidation {
    let Some(object) = event.as_object() else {
        return SourcesEventValidation::Malformed("missing_sources");
    };
    let Some(sources) = object.get("sources") else {
        return SourcesEventValidation::Malformed("missing_sources");
    };
    if object
        .get("session_id")
        .is_some_and(|session_id| !session_id.is_string())
    {
        return SourcesEventValidation::Malformed("session_id_invalid");
    }
    let Some(sources) = sources.as_array() else {
        return SourcesEventValidation::Malformed("sources_not_array");
    };
    if sources.is_empty() {
        return SourcesEventValidation::Empty;
    }
    for source in sources {
        let Some(source) = source.as_object() else {
            return SourcesEventValidation::Malformed("source_not_object");
        };
        if !source.get("title").is_some_and(Value::is_string) {
            return SourcesEventValidation::Malformed("source_title_invalid");
        }
        if !source.get("url").is_some_and(Value::is_string) {
            return SourcesEventValidation::Malformed("source_url_invalid");
        }
        if source
            .get("snippet")
            .is_some_and(|snippet| !snippet.is_string())
        {
            return SourcesEventValidation::Malformed("source_snippet_invalid");
        }
    }
    SourcesEventValidation::Valid
}

fn stream_context(value: &Value, envelope: &RawEnvelope) -> Result<StreamContext, String> {
    match (value.get("session_id"), value.get("parent_tool_use_id")) {
        (None, None) => {
            // Fixed historical `StreamEvent` declares only `event` plus the
            // optional direct-query metadata `ttftMs` and `uuid`.
            optional_string_at(value, &["uuid"], "direct stream_event", envelope)?;
            optional_number_at(value, &["ttftMs"], "direct stream_event", envelope)?;
            Ok(StreamContext::DirectQuery)
        }
        (Some(session_id), Some(parent_tool_use_id)) => {
            let session_id = session_id.as_str().ok_or_else(|| {
                format!(
                    "SDK stream_event has non-string session_id at sequence {}",
                    envelope.sequence
                )
            })?;
            let parent_tool_use_id = match parent_tool_use_id {
                Value::Null => None,
                Value::String(parent) => Some(parent.clone()),
                _ => {
                    return Err(format!(
                        "SDK stream_event has non-string/non-null parent_tool_use_id at sequence {}",
                        envelope.sequence
                    ));
                }
            };
            required_string_at(value, &["uuid"], "SDK stream_event", envelope)?;
            Ok(StreamContext::Sdk {
                session_id: session_id.to_string(),
                parent_tool_use_id,
            })
        }
        _ => Err(format!(
            "stream_event mixed direct-query and SDK context fields at sequence {}",
            envelope.sequence
        )),
    }
}

fn stream_item_key(key: &StreamBlockKey) -> String {
    let base = format!("assistant:{}:{}", key.slot.message_id, key.slot.index);
    if key.generation == 0 {
        base
    } else {
        format!("{base}:g{}", key.generation)
    }
}

fn stream_projected_kind(block_type: &str) -> ProjectedKind {
    match block_type {
        "thinking" | "redacted_thinking" => ProjectedKind::Thinking,
        "tool_use" | "server_tool_use" | "mcp_tool_use" => ProjectedKind::ToolUse,
        "web_search_tool_result"
        | "web_fetch_tool_result"
        | "code_execution_tool_result"
        | "bash_code_execution_tool_result"
        | "text_editor_code_execution_tool_result"
        | "tool_search_tool_result"
        | "mcp_tool_result"
        | "container_upload"
        | "advisor_tool_result" => ProjectedKind::ToolResult,
        _ => ProjectedKind::Assistant,
    }
}

fn stream_title(block_type: &str) -> &str {
    match block_type {
        "thinking" => "Thinking",
        "redacted_thinking" => "Redacted thinking",
        "tool_use" | "server_tool_use" | "mcp_tool_use" => "Tool",
        "web_search_tool_result"
        | "web_fetch_tool_result"
        | "code_execution_tool_result"
        | "bash_code_execution_tool_result"
        | "text_editor_code_execution_tool_result"
        | "tool_search_tool_result"
        | "mcp_tool_result"
        | "container_upload"
        | "advisor_tool_result" => "Tool result",
        _ => "Assistant",
    }
}

fn assistant_block_type(block_type: &str) -> Option<AssistantBlockType> {
    Some(match block_type {
        "text" => AssistantBlockType::Text,
        "thinking" => AssistantBlockType::Thinking,
        "redacted_thinking" => AssistantBlockType::RedactedThinking,
        "tool_use" => AssistantBlockType::ToolUse,
        "server_tool_use" => AssistantBlockType::ServerToolUse,
        "mcp_tool_use" => AssistantBlockType::McpToolUse,
        "web_search_tool_result" => AssistantBlockType::WebSearchToolResult,
        "web_fetch_tool_result" => AssistantBlockType::WebFetchToolResult,
        "code_execution_tool_result" => AssistantBlockType::CodeExecutionToolResult,
        "bash_code_execution_tool_result" => AssistantBlockType::BashCodeExecutionToolResult,
        "text_editor_code_execution_tool_result" => {
            AssistantBlockType::TextEditorCodeExecutionToolResult
        }
        "tool_search_tool_result" => AssistantBlockType::ToolSearchToolResult,
        "mcp_tool_result" => AssistantBlockType::McpToolResult,
        "container_upload" => AssistantBlockType::ContainerUpload,
        "connector_text" => AssistantBlockType::ConnectorText,
        "advisor_tool_result" => AssistantBlockType::AdvisorToolResult,
        "compaction" => AssistantBlockType::Compaction,
        _ => return None,
    })
}

fn assistant_result_block_type(block_type: &str) -> Option<AssistantBlockType> {
    let block = assistant_block_type(block_type)?;
    matches!(
        block,
        AssistantBlockType::WebSearchToolResult
            | AssistantBlockType::WebFetchToolResult
            | AssistantBlockType::CodeExecutionToolResult
            | AssistantBlockType::BashCodeExecutionToolResult
            | AssistantBlockType::TextEditorCodeExecutionToolResult
            | AssistantBlockType::ToolSearchToolResult
            | AssistantBlockType::McpToolResult
            | AssistantBlockType::ContainerUpload
            | AssistantBlockType::AdvisorToolResult
    )
    .then_some(block)
}

fn connector_text_projection(block: &Value, context: &str) -> Result<String, String> {
    string_at(block, &["text"]).ok_or_else(|| format!("{context} omitted required text"))?;
    if let Some(signature) = block.get("signature")
        && !signature.is_string()
    {
        return Err(format!("{context} has a non-string signature"));
    }
    match block.get("connector_text") {
        Some(Value::String(text)) => Ok(text.clone()),
        Some(_) => Err(format!("{context} has a non-string connector_text")),
        // CrabCode's existing CONNECTOR_TEXT renderer reads connector_text,
        // not the signature-bound fallback text field.
        None => Ok(String::new()),
    }
}

fn validate_compaction_block(block: &Value, context: &str) -> Result<(), String> {
    match block.get("content") {
        Some(Value::String(_)) | Some(Value::Null) => Ok(()),
        Some(_) => Err(format!("{context} has non-string/non-null content")),
        None => Err(format!("{context} omitted content")),
    }
}

fn advisor_invocation_presentation(
    input: &Value,
    context: &str,
) -> Result<AdvisorPresentation, String> {
    if !input.is_object() {
        return Err(format!("{context} advisor input is not an object"));
    }
    Ok(AdvisorPresentation::Invocation {
        input: input.clone(),
        state: AdvisorInvocationState::InProgress,
    })
}

fn advisor_result_payload<'a>(
    block: &'a Value,
    context: &str,
) -> Result<
    (
        &'a serde_json::Map<String, Value>,
        AdvisorResultPresentation,
    ),
    String,
> {
    let content = block
        .get("content")
        .and_then(Value::as_object)
        .ok_or_else(|| format!("{context} omitted object content"))?;
    let subtype = content
        .get("type")
        .and_then(Value::as_str)
        .ok_or_else(|| format!("{context} content omitted type"))?;
    let result = match subtype {
        "advisor_result" => {
            let text = content
                .get("text")
                .and_then(Value::as_str)
                .ok_or_else(|| format!("{context} advisor_result omitted text"))?;
            AdvisorResultPresentation::Feedback {
                text: text.to_string(),
            }
        }
        "advisor_redacted_result" => {
            if !content
                .get("encrypted_content")
                .is_some_and(Value::is_string)
            {
                return Err(format!(
                    "{context} advisor_redacted_result omitted encrypted_content"
                ));
            }
            AdvisorResultPresentation::Redacted
        }
        "advisor_tool_result_error" => {
            let error_code = content
                .get("error_code")
                .and_then(Value::as_str)
                .ok_or_else(|| format!("{context} advisor_tool_result_error omitted error_code"))?;
            AdvisorResultPresentation::Error {
                error_code: error_code.to_string(),
            }
        }
        unknown => {
            return Err(format!(
                "{context} has unknown advisor result type `{unknown}`"
            ));
        }
    };
    Ok((content, result))
}

fn advisor_result_presentation(
    block: &Value,
    context: &str,
) -> Result<AdvisorPresentation, String> {
    let (_, result) = advisor_result_payload(block, context)?;
    Ok(AdvisorPresentation::Result(result))
}

fn advisor_result_text(block: &Value) -> Result<String, String> {
    let (_, result) = advisor_result_payload(block, "advisor tool result")?;
    Ok(match result {
        AdvisorResultPresentation::Feedback { text } => text,
        AdvisorResultPresentation::Redacted => {
            "Advisor has reviewed the conversation and will apply the feedback".to_string()
        }
        AdvisorResultPresentation::Error { error_code } => {
            format!("Advisor unavailable ({error_code})")
        }
    })
}

#[allow(clippy::type_complexity)]
fn assistant_result_fields(
    block_type: &str,
    block: &Value,
    context: &str,
) -> Result<(Option<String>, Option<Value>, Option<bool>), String> {
    if block_type == "container_upload" {
        string_at(block, &["file_id"])
            .ok_or_else(|| format!("{context} container_upload omitted file_id"))?;
        return Ok((None, Some(block.clone()), None));
    }
    if block_type == "advisor_tool_result" {
        let tool_use_id = string_at(block, &["tool_use_id"])
            .ok_or_else(|| format!("{context} advisor_tool_result omitted tool_use_id"))?;
        let (content, result) = advisor_result_payload(block, context)?;
        // Redacted ciphertext remains available only in the bounded raw
        // journal. It is not copied into generic renderer state where a future
        // fallback formatter could accidentally print it.
        let generic_result = (!matches!(&result, AdvisorResultPresentation::Redacted))
            .then(|| Value::Object(content.clone()));
        let is_error = matches!(&result, AdvisorResultPresentation::Error { .. });
        return Ok((Some(tool_use_id), generic_result, Some(is_error)));
    }
    let tool_use_id = string_at(block, &["tool_use_id"])
        .ok_or_else(|| format!("{context} {block_type} omitted tool_use_id"))?;
    let result = block
        .get("content")
        .cloned()
        .ok_or_else(|| format!("{context} {block_type} omitted content"))?;
    let is_error = if block_type == "mcp_tool_result" {
        Some(
            optional_bool_field(block, "is_error", context)?
                .ok_or_else(|| format!("{context} mcp_tool_result omitted is_error"))?,
        )
    } else {
        optional_bool_field(block, "is_error", context)?
    };
    Ok((Some(tool_use_id), Some(result), is_error))
}

fn result_tool_name(block_type: &str) -> String {
    block_type
        .strip_suffix("_tool_result")
        .unwrap_or(block_type)
        .to_string()
}

fn stream_delta_matches_block(block_type: &str, expected: &str) -> bool {
    match expected {
        "*" => true,
        "tool_use" => matches!(block_type, "tool_use" | "server_tool_use" | "mcp_tool_use"),
        _ => block_type == expected,
    }
}

fn is_terminal_tool(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "bash"
            | "bashtool"
            | "shell"
            | "execute"
            | "execute_command"
            | "run_command"
            | "localcommand"
    )
}

fn projected_system_level(value: &Value, context: &str) -> Result<Option<SystemLevel>, String> {
    let Some(level) = value.get("level") else {
        return Ok(None);
    };
    let level = level
        .as_str()
        .ok_or_else(|| format!("{context} has a non-string level"))?;
    let projected = match level {
        "info" => SystemLevel::Info,
        "warning" => SystemLevel::Warning,
        "error" => SystemLevel::Error,
        "suggestion" => SystemLevel::Suggestion,
        unknown => return Err(format!("{context} has unknown level `{unknown}`")),
    };
    Ok(Some(projected))
}

fn optional_bool_field(value: &Value, field: &str, context: &str) -> Result<Option<bool>, String> {
    let Some(raw) = value.get(field) else {
        return Ok(None);
    };
    raw.as_bool()
        .map(Some)
        .ok_or_else(|| format!("{context} has a non-boolean `{field}` field"))
}

fn document_projection(block: &Value, sequence: u64, index: usize) -> Result<String, String> {
    let source = block.get("source").ok_or_else(|| {
        format!("user document block {index} omitted source at sequence {sequence}")
    })?;
    let source_type = string_at(source, &["type"]).ok_or_else(|| {
        format!("user document block {index} omitted source.type at sequence {sequence}")
    })?;
    match source_type.as_str() {
        "base64" => {
            let media_type = string_at(source, &["media_type"]).ok_or_else(|| {
                format!(
                    "user document block {index} omitted source.media_type at sequence {sequence}"
                )
            })?;
            let data = string_at(source, &["data"]).ok_or_else(|| {
                format!("user document block {index} omitted source.data at sequence {sequence}")
            })?;
            Ok(format!(
                "{media_type} · encoded document payload {} bytes (complete payload received; CrabCode transcript authoritative)",
                data.len()
            ))
        }
        "url" => {
            let url = string_at(source, &["url"]).ok_or_else(|| {
                format!("user document block {index} omitted source.url at sequence {sequence}")
            })?;
            Ok(format!("document URL · {url}"))
        }
        unknown => Err(format!(
            "user document block {index} has unknown source type `{unknown}` at sequence {sequence}"
        )),
    }
}

fn image_projection(
    block: &Value,
    sequence: u64,
    index: usize,
) -> Result<(String, ImageProvenance), String> {
    let source = block
        .get("source")
        .ok_or_else(|| format!("user image block {index} omitted source at sequence {sequence}"))?;
    let source_type = string_at(source, &["type"]).ok_or_else(|| {
        format!("user image block {index} omitted source.type at sequence {sequence}")
    })?;
    match source_type.as_str() {
        "base64" => {
            let media = string_at(source, &["media_type"]).ok_or_else(|| {
                format!(
                    "user base64 image block {index} omitted source.media_type at sequence {sequence}"
                )
            })?;
            let media_type = match media.as_str() {
                "image/jpeg" => ImageMediaType::Jpeg,
                "image/png" => ImageMediaType::Png,
                "image/gif" => ImageMediaType::Gif,
                "image/webp" => ImageMediaType::Webp,
                unknown => {
                    return Err(format!(
                        "user image block {index} has unknown media type `{unknown}` at sequence {sequence}"
                    ));
                }
            };
            let data = string_at(source, &["data"]).ok_or_else(|| {
                format!(
                    "user base64 image block {index} omitted source.data at sequence {sequence}"
                )
            })?;
            let encoded_len = data.len();
            Ok((
                format!(
                    "{media} · encoded payload {encoded_len} bytes (complete payload received; CrabCode transcript authoritative)"
                ),
                ImageProvenance::Base64 {
                    media_type,
                    encoded_len,
                },
            ))
        }
        "url" => {
            let url = string_at(source, &["url"]).ok_or_else(|| {
                format!("user URL image block {index} omitted source.url at sequence {sequence}")
            })?;
            Ok((format!("image URL · {url}"), ImageProvenance::Url { url }))
        }
        "file" => {
            let file_id = string_at(source, &["file_id"]).ok_or_else(|| {
                format!(
                    "user file image block {index} omitted source.file_id at sequence {sequence}"
                )
            })?;
            Ok((
                format!("image file · {file_id}"),
                ImageProvenance::File { file_id },
            ))
        }
        unknown => Err(format!(
            "user image block {index} has unknown source type `{unknown}` at sequence {sequence}"
        )),
    }
}

fn content_to_text(value: Option<&Value>) -> Result<String, String> {
    Ok(match value {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(values)) => values
            .iter()
            .map(|value| {
                if value.get("type").and_then(Value::as_str) == Some("text") {
                    value
                        .get("text")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                        .ok_or_else(|| {
                            "tool-result text content block omitted string text".to_string()
                        })
                } else if let Some(text) = value.as_str() {
                    Ok(text.to_string())
                } else {
                    Ok(pretty_json(value))
                }
            })
            .collect::<Result<Vec<_>, String>>()?
            .join("\n"),
        Some(value) => pretty_json(value),
    })
}

fn pretty_json(value: &Value) -> String {
    serde_json::to_string_pretty(value).unwrap_or_else(|_| "<unrenderable JSON>".to_string())
}

fn value_to_inline_text(value: &Value) -> String {
    match value {
        Value::Null => "null".to_string(),
        Value::String(text) => text.clone(),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => value.to_string(),
        other => serde_json::to_string(other).unwrap_or_else(|_| "<unrenderable>".to_string()),
    }
}

/// Marks where the producer's bounded progress tail window advanced past bytes
/// the renderer had already projected. The complete output stays addressable
/// through the saved-output path the tool result carries.
const SHELL_PROGRESS_WINDOW_GAP: &str =
    "
... output truncated (progress tail window advanced) ...
";

/// Upper bound on the text one direct-shell item keeps projected. The tool
/// result still carries the authoritative saved-output path, so the scrollback
/// only needs a bounded recent view. Without this bound a chatty command would
/// grow the projection without limit now that an advanced tail window is
/// reconciled instead of stopping the runtime.
const SHELL_PROGRESS_MAX_PROJECTED_BYTES: usize = 256 * 1024;

/// Drop the oldest projected shell bytes once the item exceeds its retention
/// bound, marking the hole exactly like an advanced producer window does.
fn trim_shell_progress_text(text: &mut String) {
    if text.len() <= SHELL_PROGRESS_MAX_PROJECTED_BYTES {
        return;
    }
    let mut cut = text.len() - SHELL_PROGRESS_MAX_PROJECTED_BYTES;
    while cut < text.len() && !text.is_char_boundary(cut) {
        cut += 1;
    }
    let kept = text.split_off(cut);
    text.clear();
    text.push_str(SHELL_PROGRESS_WINDOW_GAP.trim_start_matches('\n'));
    text.push_str(&kept);
}

/// Longest suffix of `projected` that is also a prefix of `window`, in bytes.
/// Only UTF-8 character boundaries are considered so callers can slice safely.
fn shell_progress_window_overlap(projected: &str, window: &str) -> usize {
    let mut candidate = projected.len().min(window.len());
    while candidate > 0 {
        if projected.is_char_boundary(projected.len() - candidate)
            && window.is_char_boundary(candidate)
            && projected.as_bytes()[projected.len() - candidate..]
                == window.as_bytes()[..candidate]
        {
            return candidate;
        }
        candidate -= 1;
    }
    0
}

fn string_at(value: &Value, path: &[&str]) -> Option<String> {
    let mut current = value;
    for component in path {
        current = current.get(*component)?;
    }
    current.as_str().map(str::to_string)
}

fn u64_at(value: &Value, path: &[&str]) -> Option<u64> {
    let mut current = value;
    for component in path {
        current = current.get(*component)?;
    }
    current.as_u64()
}

fn join_present(value: &Value, keys: &[&str], separator: &str) -> String {
    keys.iter()
        .filter_map(|key| value.get(*key))
        .filter(|value| !value.is_null())
        .map(value_to_inline_text)
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join(separator)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::generated_renderer_contract::{
        GENERATED_ASSISTANT_CONTENT_BLOCK_TYPES, GENERATED_SDK_RESULT_SUBTYPES,
        GENERATED_STREAM_EVENT_TYPES, GENERATED_USER_CONTENT_BLOCK_TYPES,
    };

    fn raw(sequence: u64, value: Value) -> RawEnvelope {
        let classification = crate::sdk_runtime::classify_envelope(&value).unwrap_or_else(|_| {
            EnvelopeClass::Unclassified {
                observed_type: value
                    .get("type")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                observed_system_subtype: value
                    .get("subtype")
                    .and_then(Value::as_str)
                    .map(str::to_string),
            }
        });
        RawEnvelope {
            sequence,
            encoded_len: serde_json::to_vec(&value).expect("encode").len(),
            value,
            classification,
            correlation: None,
        }
    }

    fn parse_jsonl_fixture(source: &str) -> Vec<Value> {
        source
            .lines()
            .filter(|line| !line.trim().is_empty())
            .map(|line| serde_json::from_str(line).expect("valid renderer replay fixture"))
            .collect()
    }

    #[test]
    fn archived_stream_anomaly_fixtures_replay_without_runtime_stop() {
        let fixtures = [
            (
                "incident-sequence-122-reconstruction",
                include_str!(
                    "../tests/fixtures/renderer/incident-sequence-122-reconstruction.jsonl"
                ),
                ProjectionCompatibilityKind::StreamIndexReuse,
            ),
            (
                "index-reuse",
                include_str!("../tests/fixtures/renderer/index-reuse.jsonl"),
                ProjectionCompatibilityKind::StreamIndexReuse,
            ),
            (
                "exact-replay",
                include_str!("../tests/fixtures/renderer/exact-replay.jsonl"),
                ProjectionCompatibilityKind::StreamReplay,
            ),
            (
                "conflicting-overlap",
                include_str!("../tests/fixtures/renderer/conflicting-overlap.jsonl"),
                ProjectionCompatibilityKind::StreamOverlap,
            ),
        ];

        for (name, source, expected_diagnostic) in fixtures {
            let values = parse_jsonl_fixture(source);
            let mut projection = Projection::default();
            assert_eq!(
                projection.project_wire_fixtures(&values, 100),
                Ok(values.len()),
                "{name} must remain replayable"
            );
            assert!(
                projection
                    .compatibility_diagnostics()
                    .iter()
                    .any(|entry| { entry.kind == expected_diagnostic }),
                "{name} must retain its compatibility disposition"
            );
            assert!(projection.items().iter().all(|item| !item.streaming));
        }

        let reuse =
            parse_jsonl_fixture(include_str!("../tests/fixtures/renderer/index-reuse.jsonl"));
        let mut projection = Projection::default();
        projection.project_wire_fixtures(&reuse, 200).unwrap();
        assert!(
            projection
                .items()
                .iter()
                .any(|item| { item.key == "assistant:reuse-message:1" && item.text == "first" })
        );
        assert!(projection.items().iter().any(|item| {
            item.key == "assistant:reuse-message:1:g1"
                && item.presentation.tool.as_ref().is_some_and(|tool| {
                    tool.partial_input_json.as_deref() == Some("{\"file_path\":\"README.md\"}")
                })
        }));

        // Reconstruction from the r11 transcript (the original raw provider
        // frames were not retained): two completed tool blocks reused source
        // index 1 under the same provider message id. Both generations must
        // survive with their own tool identity and the renderer must continue.
        let incident = parse_jsonl_fixture(include_str!(
            "../tests/fixtures/renderer/incident-sequence-122-reconstruction.jsonl"
        ));
        let mut projection = Projection::default();
        projection.project_wire_fixtures(&incident, 120).unwrap();
        let tools = projection
            .items()
            .iter()
            .filter_map(|item| {
                item.presentation
                    .tool
                    .as_ref()
                    .and_then(|tool| tool.name.as_deref())
                    .map(|name| (item.key.as_str(), name))
            })
            .collect::<Vec<_>>();
        assert!(tools.contains(&(
            "assistant:msg_9010afc7-1fcc-4884-9565-7c7bba57cc71:1",
            "Agent"
        )));
        assert!(tools.contains(&(
            "assistant:msg_9010afc7-1fcc-4884-9565-7c7bba57cc71:1:g1",
            "web_search"
        )));
    }

    fn sdk_assistant(uuid: &str, message_id: &str, session_id: &str, text: &str) -> Value {
        json!({
            "type": "assistant",
            "uuid": uuid,
            "session_id": session_id,
            "parent_tool_use_id": null,
            "message": {
                "id": message_id,
                "content": [{"type": "text", "text": text}]
            }
        })
    }

    fn direct_assistant(uuid: &str, message_id: &str, text: &str) -> Value {
        json!({
            "type": "assistant",
            "uuid": uuid,
            "timestamp": "2026-07-29T00:00:00.000Z",
            "message": {
                "id": message_id,
                "model": "fixed-direct-model",
                "content": [{"type": "text", "text": text}]
            }
        })
    }

    #[test]
    fn first_observed_session_id_preserves_existing_direct_projection() {
        let mut projection = Projection::default();
        assert_eq!(
            projection.ingest(raw(
                0,
                direct_assistant("direct-before", "direct-message", "before")
            )),
            ProjectionEffect::None
        );
        assert_eq!(projection.session_id(), None);
        assert_eq!(
            projection.ingest(raw(
                1,
                sdk_assistant("sdk-first", "sdk-message", "session-1", "first")
            )),
            ProjectionEffect::None
        );
        assert_eq!(projection.session_id(), Some("session-1"));
        assert_eq!(
            projection
                .items()
                .iter()
                .map(|item| item.text.as_str())
                .collect::<Vec<_>>(),
            ["before", "first"]
        );
    }

    #[test]
    fn repeated_session_id_preserves_existing_projection() {
        let mut projection = Projection::default();
        assert_eq!(
            projection.ingest(raw(
                0,
                sdk_assistant("sdk-1", "message-1", "session-1", "first")
            )),
            ProjectionEffect::None
        );
        assert_eq!(
            projection.ingest(raw(
                1,
                sdk_assistant("sdk-2", "message-2", "session-1", "second")
            )),
            ProjectionEffect::None
        );
        assert_eq!(projection.session_id(), Some("session-1"));
        assert_eq!(
            projection
                .items()
                .iter()
                .map(|item| item.text.as_str())
                .collect::<Vec<_>>(),
            ["first", "second"]
        );
    }

    #[test]
    fn changed_session_id_atomically_clears_old_projection_and_enters_new_envelope() {
        let mut projection = Projection::default();
        assert_eq!(
            projection.ingest(raw(
                0,
                sdk_assistant("sdk-old", "message-old", "session-old", "old")
            )),
            ProjectionEffect::None
        );
        assert_eq!(
            projection.ingest(raw(
                1,
                json!({
                    "type": "prompt_suggestion",
                    "suggestion": "old suggestion",
                    "uuid": "suggestion-old",
                    "session_id": "session-old"
                })
            )),
            ProjectionEffect::PromptSuggestion("old suggestion".to_string())
        );

        assert_eq!(
            projection.ingest(raw(
                2,
                sdk_assistant("sdk-new", "message-new", "session-new", "new")
            )),
            ProjectionEffect::SessionTransition {
                previous_session_id: "session-old".to_string(),
                session_id: "session-new".to_string(),
                effect: Box::new(ProjectionEffect::None),
            }
        );
        assert_eq!(projection.session_id(), Some("session-new"));
        assert_eq!(projection.prompt_suggestion(), None);
        assert_eq!(projection.items().len(), 1);
        assert_eq!(projection.items()[0].text, "new");
        assert_eq!(
            projection.raw_envelope_count(),
            3,
            "the bounded diagnostic journal remains independent of visible session projection"
        );
    }

    #[test]
    fn retention_budget_evicts_old_diagnostics_without_failing_the_session() {
        let mut projection = Projection {
            raw_retention_limit_override: Some(
                RAW_ENVELOPE_ALLOCATION_CHARGE_BYTES.saturating_add(1),
            ),
            ..Projection::default()
        };
        let first = json!({"type": "keep_alive", "future": "evicted"});
        let latest = json!({"type": "keep_alive", "future": "retained"});
        assert_eq!(projection.ingest(raw(7, first)), ProjectionEffect::None);
        assert_eq!(
            projection.ingest(raw(8, latest.clone())),
            ProjectionEffect::None
        );
        assert_eq!(projection.raw_envelopes().len(), 1);
        assert_eq!(projection.raw_envelopes()[0].value, latest);
        assert_eq!(projection.raw_envelope_count(), 2);
        assert_eq!(projection.raw_evicted_count(), 1);
        assert!(projection.raw_retention_charge_bytes() > RAW_ENVELOPE_ALLOCATION_CHARGE_BYTES);
    }

    #[test]
    fn retention_budget_always_keeps_one_complete_oversized_diagnostic() {
        let mut projection = Projection {
            raw_retention_limit_override: Some(1),
            ..Projection::default()
        };
        let value = json!({"type": "keep_alive", "future": "retained"});
        assert_eq!(
            projection.ingest(raw(7, value.clone())),
            ProjectionEffect::None
        );
        assert_eq!(projection.raw_envelopes().len(), 1);
        assert_eq!(projection.raw_envelopes()[0].value, value);
        assert_eq!(projection.raw_evicted_count(), 0);
    }

    #[test]
    fn typed_tool_artifact_provenance_survives_raw_journal_eviction() {
        let mut projection = Projection {
            raw_retention_limit_override: Some(
                RAW_ENVELOPE_ALLOCATION_CHARGE_BYTES.saturating_add(1),
            ),
            ..Projection::default()
        };
        assert_eq!(
            projection.ingest(raw(
                7,
                json!({
                    "type": "user",
                    "message": {"role": "user", "content": "result"},
                    "parent_tool_use_id": "tool-7",
                    "uuid": "user-7",
                    "session_id": "session-7",
                    "tool_artifacts": [{
                        "id": "artifact-7",
                        "kind": "image",
                        "mimeType": "image/png",
                        "displayName": "result.png",
                        "location": {
                            "type": "runtimePath",
                            "path": "/tmp/result.png"
                        },
                        "byteSize": 1024,
                        "sha256": "abc123",
                        "producerToolUseId": "tool-7"
                    }]
                })
            )),
            ProjectionEffect::None
        );
        assert_eq!(
            projection.ingest(raw(8, json!({"type": "keep_alive"}))),
            ProjectionEffect::None
        );
        assert_eq!(projection.raw_envelopes().len(), 1);
        assert_eq!(projection.raw_envelopes()[0].sequence, 8);
        assert_eq!(projection.raw_evicted_count(), 1);

        assert_eq!(
            projection.tool_artifacts_for("tool-7"),
            &[ProjectedToolArtifact {
                id: "artifact-7".to_string(),
                kind: ProjectedToolArtifactKind::Image,
                mime_type: "image/png".to_string(),
                display_name: "result.png".to_string(),
                location: ProjectedToolArtifactLocation::RuntimePath {
                    path: "/tmp/result.png".to_string(),
                },
                byte_size: Some(1024),
                sha256: Some("abc123".to_string()),
                producer_tool_use_id: "tool-7".to_string(),
                raw_sequences: vec![7],
            }]
        );
        assert!(
            projection.tool_artifacts_for("unrelated-tool").is_empty(),
            "artifact provenance is keyed only by the exact producer tool-use id"
        );
    }

    #[test]
    fn malformed_or_oversized_tool_artifacts_fail_closed_without_provenance() {
        let mut projection = Projection::default();
        let malformed = projection.ingest(raw(
            7,
            json!({
                "type": "user",
                "message": {"role": "user", "content": "result"},
                "parent_tool_use_id": "tool-malformed",
                "uuid": "user-malformed",
                "session_id": "session",
                "tool_artifacts": [{
                    "id": "artifact",
                    "kind": "image",
                    "mimeType": "image/png",
                    "displayName": "result.png",
                    "location": {"type": "future-location", "path": "/tmp/result.png"},
                    "producerToolUseId": "tool-malformed"
                }]
            }),
        ));
        assert!(matches!(
            malformed,
            ProjectionEffect::FailClosed { sequence: 7, .. }
        ));
        assert!(projection.tool_artifacts_for("tool-malformed").is_empty());

        let oversized = projection.ingest(raw(
            8,
            json!({
                "type": "user",
                "message": {"role": "user", "content": "result"},
                "parent_tool_use_id": "tool-oversized",
                "uuid": "user-oversized",
                "session_id": "session",
                "tool_artifacts": [{
                    "id": "artifact",
                    "kind": "image",
                    "mimeType": "image/png",
                    "displayName": "result.png",
                    "location": {"type": "runtimePath", "path": "/tmp/result.png"},
                    "byteSize": 26214401,
                    "producerToolUseId": "tool-oversized"
                }]
            }),
        ));
        assert!(matches!(
            oversized,
            ProjectionEffect::FailClosed { sequence: 8, .. }
        ));
        assert!(projection.tool_artifacts_for("tool-oversized").is_empty());
    }

    #[test]
    fn conflicting_tool_artifact_replay_cannot_replace_provenance() {
        let mut projection = Projection::default();
        let user_with_path = |sequence: u64, path: &str| {
            raw(
                sequence,
                json!({
                    "type": "user",
                    "message": {"role": "user", "content": "result"},
                    "parent_tool_use_id": "tool-stable",
                    "uuid": format!("user-{sequence}"),
                    "session_id": "session",
                    "tool_artifacts": [{
                        "id": "artifact-stable",
                        "kind": "image",
                        "mimeType": "image/png",
                        "displayName": "result.png",
                        "location": {"type": "runtimePath", "path": path},
                        "producerToolUseId": "tool-stable"
                    }]
                }),
            )
        };
        assert_eq!(
            projection.ingest(user_with_path(7, "/tmp/original.png")),
            ProjectionEffect::None
        );
        assert!(matches!(
            projection.ingest(user_with_path(8, "/tmp/replaced.png")),
            ProjectionEffect::FailClosed { sequence: 8, .. }
        ));
        assert_eq!(
            projection.tool_artifacts_for("tool-stable")[0].location,
            ProjectedToolArtifactLocation::RuntimePath {
                path: "/tmp/original.png".to_string(),
            }
        );
    }

    #[test]
    fn journals_complete_unknown_presentation_without_stopping_runtime() {
        let value = json!({
            "type": "future_backend_event",
            "secret_new_field": {"nested": [1, 2, 3]}
        });
        let mut projection = Projection::default();
        let effect = projection.ingest(raw(7, value.clone()));
        assert_eq!(effect, ProjectionEffect::None);
        assert_eq!(projection.raw_envelopes()[0].value, value);
        assert!(
            projection
                .items()
                .iter()
                .any(|item| item.title == "Renderer compatibility"),
            "an additive presentation event must remain visible and diagnosable"
        );
        assert_eq!(
            projection.compatibility_diagnostics()[0].kind,
            ProjectionCompatibilityKind::UnknownPresentation
        );
    }

    #[test]
    fn extra_fields_survive_known_message_projection_verbatim() {
        let value = json!({
            "type": "system",
            "subtype": "status",
            "status": "compacting",
            "uuid": "status",
            "session_id": "session",
            "future": {"must": "survive"}
        });
        let mut projection = Projection::default();
        assert_eq!(
            projection.ingest(raw(0, value.clone())),
            ProjectionEffect::None
        );
        assert_eq!(projection.raw_envelopes()[0].value, value);
        assert_eq!(projection.items()[0].text, "compacting");
    }

    #[test]
    fn fixed_direct_shell_progress_appends_exact_cumulative_suffixes() {
        let fragments = [
            ("Com", "Com"),
            ("pili", "Compili"),
            ("ng ", "Compiling "),
            ("crat", "Compiling crat"),
            ("e\n", "Compiling crate\n"),
        ];
        let mut projection = Projection::default();
        for (sequence, (output, full_output)) in fragments.into_iter().enumerate() {
            let value = json!({
                "type":"progress",
                "data":{
                    "type":"bash_progress",
                    "output":output,
                    "fullOutput":full_output,
                    "elapsedTimeSeconds":sequence,
                    "totalLines":1
                },
                "toolUseID":format!("bash-progress-{sequence}"),
                "parentToolUseID":"shell-tool-1",
                "uuid":format!("progress-{sequence}"),
                "timestamp":"2026-07-27T00:00:00.000Z"
            });
            assert_eq!(
                projection.ingest(raw(sequence as u64, value)),
                ProjectionEffect::None
            );
        }

        assert_eq!(projection.raw_envelope_count(), 5);
        assert_eq!(projection.items().len(), 1);
        let item = &projection.items()[0];
        assert_eq!(item.key, "direct-shell-progress:shell-tool-1");
        assert_eq!(item.kind, ProjectedKind::TerminalOutput);
        assert_eq!(item.title, "Bash");
        assert_eq!(item.text, "Compiling crate\n");
        assert!(item.streaming);
        assert_eq!(item.raw_sequences, [0, 1, 2, 3, 4]);
        assert_eq!(item.tool_use_id.as_deref(), Some("shell-tool-1"));
        assert_eq!(
            item.presentation
                .tool
                .as_ref()
                .and_then(|tool| tool.name.as_deref()),
            Some("Bash")
        );
        assert!(matches!(
            item.presentation.direct_progress.as_ref(),
            Some(DirectProgressPresentation::Shell {
                progress_type,
                output,
                elapsed_time_seconds,
                total_lines,
                total_bytes: None,
                timeout_ms: None,
                task_id: None,
            }) if progress_type == "bash_progress"
                && output == "e\n"
                && elapsed_time_seconds.as_u64() == Some(4)
                && total_lines.as_u64() == Some(1)
        ));
    }

    #[test]
    fn fixed_direct_shell_progress_recovers_from_an_advanced_tail_window() {
        let mut projection = Projection::default();
        let first = json!({
            "type":"progress",
            "data":{
                "type":"powershell_progress",
                "output":"alpha",
                "fullOutput":"alpha",
                "elapsedTimeSeconds":1,
                "totalLines":1
            },
            "toolUseID":"powershell-progress-0",
            "parentToolUseID":"shell-tool-2",
            "uuid":"progress-0",
            "timestamp":"2026-07-27T00:00:00.000Z"
        });
        let conflicting = json!({
            "type":"progress",
            "data":{
                "type":"powershell_progress",
                "output":"beta",
                "fullOutput":"beta",
                "elapsedTimeSeconds":2,
                "totalLines":1
            },
            "toolUseID":"powershell-progress-1",
            "parentToolUseID":"shell-tool-2",
            "uuid":"progress-1",
            "timestamp":"2026-07-27T00:00:01.000Z"
        });
        assert_eq!(projection.ingest(raw(0, first)), ProjectionEffect::None);
        // The producer's `fullOutput` is a bounded tail window, so a burst that
        // outruns it legitimately drops projected bytes. The renderer re-anchors
        // and marks the gap instead of stopping the runtime.
        assert_eq!(
            projection.ingest(raw(1, conflicting.clone())),
            ProjectionEffect::None
        );
        assert_eq!(projection.raw_envelopes()[1].value, conflicting);
        assert_eq!(
            projection.items()[0].text,
            format!("alpha{SHELL_PROGRESS_WINDOW_GAP}beta")
        );
        assert_eq!(projection.items().len(), 1);
        assert!(projection
            .compatibility_diagnostics()
            .iter()
            .any(|diagnostic| diagnostic.sequence == 1
                && diagnostic.reason.contains("tail window advanced past")));
    }

    #[test]
    fn an_accepted_envelope_is_journalled_as_accepted_whatever_its_declared_class() {
        // `content_block_delta` -- among the most common events in any session
        // -- declares TurnFatal, meaning "if this one is rejected, the turn
        // dies". Before the split, every accepted delta was journalled under
        // that class, so a healthy session produced thousands of "turn-fatal"
        // records and the single real failure was invisible among them.
        let delta = raw(
            0,
            json!({
                "type":"stream_event",
                "event":{"type":"content_block_delta"}
            }),
        );
        let (outcome, declared, issue, root) =
            projection_effect_diagnostic_fields(&ProjectionEffect::None, &delta);
        assert_eq!(outcome, "accepted");
        assert_eq!(declared, Some("turn-fatal"));
        assert_eq!(issue, None);
        assert_eq!(root, None);

        // A real protocol failure still reports the failure in `outcome`, and
        // the declared class rides alongside it rather than replacing it.
        let (outcome, declared, _, root) = projection_effect_diagnostic_fields(
            &ProjectionEffect::FailClosed {
                sequence: 0,
                reason: "boom".to_string(),
            },
            &delta,
        );
        assert_eq!(outcome, "protocol-fatal");
        assert_eq!(declared, Some("turn-fatal"));
        assert_eq!(root, Some("projection_protocol_fatal"));

        // A non-stream envelope declares no class at all.
        let progress = raw(1, json!({"type":"progress","data":{"type":"x"}}));
        let (outcome, declared, _, _) =
            projection_effect_diagnostic_fields(&ProjectionEffect::None, &progress);
        assert_eq!(outcome, "accepted");
        assert_eq!(declared, None);
    }

    #[test]
    fn declared_tail_truncation_marks_the_gap_without_a_compatibility_record() {
        let mut projection = Projection::default();
        let progress = |sequence: u64, full: &str, total_bytes: u64| {
            raw(
                sequence,
                json!({
                    "type":"progress",
                    "data":{
                        "type":"bash_progress",
                        "output":full,
                        "fullOutput":full,
                        "elapsedTimeSeconds":sequence + 1,
                        "totalLines":1,
                        // Non-zero `totalBytes` is the producer stating outright
                        // that `fullOutput` is a truncated view of the output.
                        "totalBytes":total_bytes
                    },
                    "toolUseID":format!("bash-progress-{sequence}"),
                    "parentToolUseID":"shell-tool-4",
                    "uuid":format!("progress-{sequence}"),
                    "timestamp":"2026-07-27T00:00:00.000Z"
                }),
            )
        };
        assert_eq!(
            projection.ingest(progress(0, "alpha", 0)),
            ProjectionEffect::None
        );
        // A burst that outruns the poll interval: no overlap at all, and the
        // producer says so. The session keeps running, the scrollback shows the
        // hole, and no compatibility budget is spent on a declared truncation.
        assert_eq!(
            projection.ingest(progress(1, "omega", 16_528)),
            ProjectionEffect::None
        );
        assert_eq!(
            projection.items()[0].text,
            format!("alpha{SHELL_PROGRESS_WINDOW_GAP}omega")
        );
        assert!(!projection
            .compatibility_diagnostics()
            .iter()
            .any(|diagnostic| diagnostic.sequence == 1));
    }

    #[test]
    fn fixed_direct_shell_progress_reanchors_on_an_overlapping_tail_window() {
        let mut projection = Projection::default();
        let progress = |sequence: u64, full: &str, elapsed: u64| {
            raw(
                sequence,
                json!({
                    "type":"progress",
                    "data":{
                        "type":"bash_progress",
                        "output":full,
                        "fullOutput":full,
                        "elapsedTimeSeconds":elapsed,
                        "totalLines":1
                    },
                    "toolUseID":format!("bash-progress-{sequence}"),
                    "parentToolUseID":"shell-tool-3",
                    "uuid":format!("progress-{sequence}"),
                    "timestamp":"2026-07-27T00:00:00.000Z"
                }),
            )
        };
        assert_eq!(
            projection.ingest(progress(0, "abcdef", 1)),
            ProjectionEffect::None
        );
        // The window slid forward by two bytes but still overlaps on "cdef",
        // so only the exact new suffix is appended and no gap is marked.
        assert_eq!(
            projection.ingest(progress(1, "cdefgh", 2)),
            ProjectionEffect::None
        );
        assert_eq!(projection.items()[0].text, "abcdefgh");
        assert!(!projection.items()[0]
            .text
            .contains(SHELL_PROGRESS_WINDOW_GAP));
    }

    #[test]
    fn shell_progress_text_stays_within_its_retention_bound() {
        let mut text = "x".repeat(SHELL_PROGRESS_MAX_PROJECTED_BYTES + 10_000);
        trim_shell_progress_text(&mut text);
        assert!(text.len() <= SHELL_PROGRESS_MAX_PROJECTED_BYTES
            + SHELL_PROGRESS_WINDOW_GAP.len());
        assert!(text.starts_with(SHELL_PROGRESS_WINDOW_GAP.trim_start_matches('\n')));

        // A text already inside the bound is left byte-for-byte alone.
        let mut small = "abc".to_string();
        trim_shell_progress_text(&mut small);
        assert_eq!(small, "abc");
    }

    #[test]
    fn shell_progress_window_overlap_stays_on_utf8_boundaries() {
        // A multi-byte character must never be split when re-anchoring.
        assert_eq!(shell_progress_window_overlap("ab\u{4f60}\u{597d}", "\u{4f60}\u{597d}cd"), 6);
        assert_eq!(shell_progress_window_overlap("abc", "xyz"), 0);
        assert_eq!(shell_progress_window_overlap("", "abc"), 0);
    }

    #[test]
    fn fixed_direct_tombstone_removes_the_abandoned_assistant_attempt() {
        let assistant = json!({
            "type":"assistant",
            "uuid":"assistant-abandoned",
            "timestamp":"2026-07-27T00:00:00.000Z",
            "error":"unknown",
            "message":{
                "id":"message-abandoned",
                "model":"fixed-model",
                "content":[
                    {"type":"text","text":"partial answer"},
                    {
                        "type":"tool_use",
                        "id":"tool-abandoned",
                        "name":"Bash",
                        "input":{"command":"echo abandoned"}
                    }
                ]
            }
        });
        let tombstone = json!({
            "type":"tombstone",
            "message":assistant.clone(),
            "uuid":"tombstone-abandoned"
        });
        let mut projection = Projection::default();
        assert_eq!(
            projection.ingest(raw(0, assistant.clone())),
            ProjectionEffect::None
        );
        assert_eq!(
            projection.items().len(),
            2,
            "the fixed assistant renderer projects message.content only; \
             assistant.error remains raw backend metadata"
        );

        assert_eq!(
            projection.ingest(raw(1, tombstone.clone())),
            ProjectionEffect::None
        );
        assert!(projection.items().is_empty());
        assert_eq!(
            projection.direct_tombstone_delete_effects(),
            &[DirectTombstoneDeleteEffect {
                target_uuid: "assistant-abandoned".to_string(),
                target_message_id: "message-abandoned".to_string(),
                removed_item_count: 2,
                raw_sequence: 1,
            }]
        );
        assert_eq!(projection.raw_envelopes()[0].value, assistant);
        assert_eq!(projection.raw_envelopes()[1].value, tombstone);

        // The historical handler's identity filter is a no-op if the same
        // target is already absent; duplicate control delivery must not
        // resurrect or fabricate transcript state.
        assert_eq!(
            projection.ingest(raw(
                2,
                json!({
                    "type":"tombstone",
                    "message":{
                        "type":"assistant",
                        "uuid":"assistant-abandoned",
                        "timestamp":"2026-07-27T00:00:00.000Z",
                        "message":{"id":"message-abandoned","content":[]}
                    }
                })
            )),
            ProjectionEffect::None
        );
        assert!(projection.items().is_empty());
        assert_eq!(
            projection.direct_tombstone_delete_effects()[1],
            DirectTombstoneDeleteEffect {
                target_uuid: "assistant-abandoned".to_string(),
                target_message_id: "message-abandoned".to_string(),
                removed_item_count: 0,
                raw_sequence: 2,
            },
            "a duplicate tombstone records the exact idempotent no-op"
        );
    }

    #[test]
    fn fixed_direct_assistant_retains_feedback_request_and_plan_usage_fields() {
        let mut projection = Projection::default();
        assert_eq!(
            projection.ingest(raw(
                0,
                json!({
                    "type":"assistant",
                    "uuid":"assistant-fields",
                    "timestamp":"2026-07-27T00:00:00.000Z",
                    "requestId":"request-fixed",
                    "message":{
                        "id":"message-fields",
                        "model":"fixed-model",
                        "content":[{"type":"text","text":"answer"}],
                        "usage":{
                            "input_tokens":101,
                            "output_tokens":7,
                            "cache_creation_input_tokens":11,
                            "cache_read_input_tokens":null
                        }
                    }
                }),
            )),
            ProjectionEffect::None
        );

        let presentation = projection.items()[0]
            .presentation
            .direct_assistant
            .as_ref()
            .expect("direct assistant presentation");
        assert_eq!(presentation.request_id.as_deref(), Some("request-fixed"));
        let usage = presentation.usage.as_ref().expect("typed usage");
        assert_eq!(usage.input_tokens.as_u64(), Some(101));
        assert_eq!(
            usage
                .cache_creation_input_tokens
                .as_ref()
                .and_then(serde_json::Number::as_u64),
            Some(11)
        );
        assert_eq!(usage.cache_read_input_tokens, None);
    }

    #[test]
    fn fixed_direct_assistant_accepts_sparse_nullable_cache_usage_without_inventing_zero() {
        for (sequence, usage, expected_creation, expected_read) in [
            (0, json!({"input_tokens":1, "output_tokens":1}), None, None),
            (
                1,
                json!({
                    "input_tokens":2,
                    "output_tokens":1,
                    "cache_creation_input_tokens":null,
                    "cache_read_input_tokens":null
                }),
                None,
                None,
            ),
            (
                2,
                json!({
                    "input_tokens":3,
                    "output_tokens":1,
                    "cache_creation_input_tokens":7
                }),
                Some(7),
                None,
            ),
            (
                3,
                json!({
                    "input_tokens":4,
                    "output_tokens":1,
                    "cache_read_input_tokens":9
                }),
                None,
                Some(9),
            ),
        ] {
            let mut projection = Projection::default();
            assert_eq!(
                projection.ingest(raw(
                    sequence,
                    json!({
                        "type":"assistant",
                        "uuid":format!("assistant-{sequence}"),
                        "timestamp":"2026-07-27T00:00:00.000Z",
                        "message":{
                            "id":format!("message-{sequence}"),
                            "model":"fixed-model",
                            "content":[{"type":"text","text":"answer"}],
                            "usage":usage
                        }
                    }),
                )),
                ProjectionEffect::None
            );
            let usage = projection.items()[0]
                .presentation
                .direct_assistant
                .as_ref()
                .and_then(|presentation| presentation.usage.as_ref())
                .expect("typed sparse usage");
            assert_eq!(
                usage
                    .cache_creation_input_tokens
                    .as_ref()
                    .and_then(serde_json::Number::as_u64),
                expected_creation
            );
            assert_eq!(
                usage
                    .cache_read_input_tokens
                    .as_ref()
                    .and_then(serde_json::Number::as_u64),
                expected_read
            );
        }
    }

    #[test]
    fn fixed_direct_assistant_rejects_required_or_mistyped_usage_without_guessing() {
        for (sequence, usage, expected_reason) in [
            (0, json!({"output_tokens":1}), "omitted number input_tokens"),
            (
                1,
                json!({"input_tokens":"1", "output_tokens":1}),
                "omitted number input_tokens",
            ),
            (
                2,
                json!({
                    "input_tokens":1,
                    "output_tokens":1,
                    "cache_creation_input_tokens":"7"
                }),
                "non-number/non-null optional cache_creation_input_tokens",
            ),
            (
                3,
                json!({
                    "input_tokens":1,
                    "output_tokens":1,
                    "cache_read_input_tokens":false
                }),
                "non-number/non-null optional cache_read_input_tokens",
            ),
        ] {
            let mut projection = Projection::default();
            assert!(matches!(
                projection.ingest(raw(
                    sequence,
                    json!({
                        "type":"assistant",
                        "uuid":format!("assistant-invalid-{sequence}"),
                        "timestamp":"2026-07-27T00:00:00.000Z",
                        "message":{
                            "id":format!("message-invalid-{sequence}"),
                            "model":"fixed-model",
                            "content":[{"type":"text","text":"answer"}],
                            "usage":usage
                        }
                    }),
                )),
                ProjectionEffect::FailClosed {
                    sequence: failed_sequence,
                    reason,
                } if failed_sequence == sequence && reason.contains(expected_reason)
            ));
        }
    }

    #[test]
    fn fixed_direct_success_result_uses_lossless_envelope_tool_use_result() {
        let mut projection = Projection::default();
        assert_eq!(
            projection.ingest(raw(
                0,
                json!({
                    "type":"assistant",
                    "uuid":"assistant-tool",
                    "timestamp":"2026-07-27T00:00:00.000Z",
                    "message":{
                        "id":"message-tool",
                        "model":"fixed-model",
                        "content":[{
                            "type":"tool_use",
                            "id":"tool-fixed",
                            "name":"RepoProbe",
                            "input":{"query":"typed"}
                        }]
                    }
                }),
            )),
            ProjectionEffect::None
        );
        let renderer_result = json!({
            "matches":["a","b"],
            "nested":{"preserved":true}
        });
        assert_eq!(
            projection.ingest(raw(
                1,
                json!({
                    "type":"user",
                    "uuid":"user-tool",
                    "timestamp":"2026-07-27T00:00:01.000Z",
                    "toolUseResult":renderer_result.clone(),
                    "message":{
                        "role":"user",
                        "content":[{
                            "type":"tool_result",
                            "tool_use_id":"tool-fixed",
                            "content":"display fallback",
                            "is_error":false
                        }]
                    }
                }),
            )),
            ProjectionEffect::None
        );

        let item = projection.items().last().expect("tool result item");
        let direct_user = item
            .presentation
            .direct_user
            .as_ref()
            .expect("direct user presentation");
        assert_eq!(direct_user.tool_use_result.as_ref(), Some(&renderer_result));
        assert_eq!(
            item.presentation
                .tool
                .as_ref()
                .and_then(|tool| tool.result.as_ref()),
            Some(&renderer_result)
        );
        assert_eq!(item.text, "display fallback");
    }

    #[test]
    fn direct_tombstone_rejects_a_target_without_a_fixed_producer_contract() {
        let target = json!({
            "type":"user",
            "uuid":"user-1",
            "timestamp":"2026-07-27T00:00:00.000Z",
            "message":{"role":"user","content":"question"}
        });
        let value = json!({
            "type":"tombstone",
            "message":target
        });
        let mut projection = Projection::default();
        assert!(matches!(
            projection.ingest(raw(0, value.clone())),
            ProjectionEffect::FailClosed {
                sequence: 0,
                reason
            } if reason.contains("unsupported `user`")
        ));
        assert_eq!(projection.raw_envelopes()[0].value, value);
    }

    #[test]
    fn current_direct_query_event_boundary_retains_all_nine_source_objects() {
        let values = vec![
            json!({
                "type":"assistant",
                "uuid":"assistant-1",
                "timestamp":"2026-07-27T00:00:00.000Z",
                "message":{
                    "id":"message-1",
                    "model":"fixed-model",
                    "content":[{"type":"text","text":"answer"}]
                }
            }),
            json!({
                "type":"user",
                "uuid":"user-1",
                "timestamp":"2026-07-27T00:00:00.000Z",
                "message":{"role":"user","content":"question"}
            }),
            json!({
                "type":"progress",
                "data":{"type":"repl_progress","opaque":{"kept":true}},
                "toolUseID":"tool-1",
                "parentToolUseID":"parent-1",
                "uuid":"progress-1",
                "timestamp":"2026-07-27T00:00:00.000Z"
            }),
            json!({
                "type":"attachment",
                "attachment":{"type":"structured_output","data":{"kept":true}},
                "uuid":"attachment-1",
                "timestamp":"2026-07-27T00:00:00.000Z"
            }),
            json!({
                "type":"system",
                "subtype":"informational",
                "content":"notice",
                "level":"info",
                "uuid":"system-1",
                "timestamp":"2026-07-27T00:00:00.000Z"
            }),
            json!({"type":"stream_event","event":{"type":"ping"},"ttftMs":12,"uuid":"stream-1"}),
            json!({"type":"stream_request_start","uuid":"request-1"}),
            json!({
                "type":"tombstone",
                "message":{
                    "type":"assistant",
                    "uuid":"assistant-removed",
                    "timestamp":"2026-07-27T00:00:00.000Z",
                    "message":{"id":"removed","content":[]}
                },
                "uuid":"tombstone-1"
            }),
            json!({
                "type":"tool_use_summary",
                "summary":"Read 2 files",
                "preceding_tool_use_ids":["tool-1"],
                "uuid":"summary-1",
                "session_id":"session-1"
            }),
        ];
        let mut projection = Projection::default();
        for (sequence, value) in values.iter().cloned().enumerate() {
            let expected = if sequence == 6 {
                ProjectionEffect::StreamRequestStarted
            } else {
                ProjectionEffect::None
            };
            assert_eq!(projection.ingest(raw(sequence as u64, value)), expected);
        }
        assert_eq!(
            projection
                .raw_envelopes()
                .iter()
                .map(|envelope| envelope.value.clone())
                .collect::<Vec<_>>(),
            values
        );
        let unprojected_query_types: &[&str] = &UNPROJECTED_DIRECT_QUERY_EVENT_TYPES;
        let expected_unprojected_query_types: &[&str] = &[];
        assert_eq!(unprojected_query_types, expected_unprojected_query_types);
        assert_eq!(DIAGNOSTIC_FALLBACK_DIRECT_PROGRESS_TYPES, ["repl_progress"]);
        assert_eq!(
            projection
                .items()
                .iter()
                .map(|item| item.kind)
                .collect::<Vec<_>>(),
            [
                ProjectedKind::Assistant,
                ProjectedKind::User,
                ProjectedKind::System,
                ProjectedKind::System
            ]
        );
    }

    #[test]
    fn fixed_direct_system_union_retains_typed_renderer_fields() {
        let timestamp = "2026-07-27T00:00:00.000Z";
        let values = vec![
            json!({
                "type":"system","subtype":"informational","content":"notice","level":"info",
                "toolUseID":"tool-info","preventContinuation":true,
                "uuid":"system-0","timestamp":timestamp,"isMeta":true
            }),
            json!({
                "type":"system","subtype":"permission_retry","content":"allowed","level":"info",
                "commands":["git status","pwd"],"uuid":"system-1","timestamp":timestamp
            }),
            json!({
                "type":"system","subtype":"scheduled_task_fire","content":"scheduled",
                "uuid":"system-3","timestamp":timestamp
            }),
            json!({
                "type":"system","subtype":"stop_hook_summary","hookCount":1,
                "hookInfos":[{"hookName":"prompt","durationMs":12,"output":"prompt text"}],
                "hookErrors":["failed"],"preventedContinuation":true,"stopReason":"blocked",
                "hasOutput":true,"level":"warning","toolUseID":"tool-stop","hookLabel":"stop",
                "totalDurationMs":12,"uuid":"system-4","timestamp":timestamp
            }),
            json!({
                "type":"system","subtype":"turn_duration","durationMs":1500,"budgetTokens":100,
                "budgetLimit":200,"budgetNudges":2,"messageCount":3,
                "uuid":"system-5","timestamp":timestamp
            }),
            json!({
                "type":"system","subtype":"away_summary","content":"away",
                "uuid":"system-6","timestamp":timestamp
            }),
            json!({
                "type":"system","subtype":"memory_saved","writtenPaths":["/tmp/a","/tmp/b"],
                "teamCount":1,"uuid":"system-7","timestamp":timestamp
            }),
            json!({
                "type":"system","subtype":"agents_killed",
                "uuid":"system-8","timestamp":timestamp
            }),
            json!({
                "type":"system","subtype":"api_metrics","ttftMs":10,"otps":20,"isP50":true,
                "hookDurationMs":1,"turnDurationMs":2,"toolDurationMs":3,
                "classifierDurationMs":4,"toolCount":5,"hookCount":6,
                "classifierCount":7,"configWriteCount":8,
                "uuid":"system-9","timestamp":timestamp
            }),
            json!({
                "type":"system","subtype":"local_command","content":"local","level":"suggestion",
                "uuid":"system-10","timestamp":timestamp
            }),
            json!({
                "type":"system","subtype":"api_error","level":"error",
                "error":{
                    "message":"Connection error.","status":503,
                    "error":{"error":{"message":"deep response"}},
                    "cause":{"code":"ETIMEDOUT"}
                },
                "retryInMs":1000,"retryAttempt":2,"maxRetries":4,
                "uuid":"system-11","timestamp":timestamp
            }),
            json!({
                "type":"system","subtype":"compact_boundary","content":"compacted","level":"info",
                "compactMetadata":{
                    "trigger":"manual","preTokens":100,"userContext":"keep this",
                    "messagesSummarized":5,"preCompactDiscoveredTools":["Read","Bash"],
                    "preservedSegment":{"headUuid":"head","anchorUuid":"anchor","tailUuid":"tail"}
                },
                "logicalParentUuid":"parent","uuid":"system-12","timestamp":timestamp
            }),
            json!({
                "type":"system","subtype":"microcompact_boundary","content":"micro","level":"info",
                "microcompactMetadata":{
                    "trigger":"auto","preTokens":80,"tokensSaved":20,
                    "compactedToolIds":["tool-a"],"clearedAttachmentUUIDs":["attachment-a"]
                },
                "uuid":"system-13","timestamp":timestamp
            }),
            json!({
                "type":"system","subtype":"command_input","content":"/status",
                "uuid":"system-14","timestamp":timestamp
            }),
            json!({
                "type":"system","subtype":"thinking","content":"working",
                "uuid":"system-15","timestamp":timestamp
            }),
            json!({
                "type":"system","subtype":"file_snapshot","content":"snapshot","level":"info",
                "snapshotFiles":[{"key":"a","path":"/tmp/a","content":"large source body"}],
                "uuid":"system-16","timestamp":timestamp
            }),
        ];

        let mut projection = Projection::default();
        for (sequence, value) in values.iter().cloned().enumerate() {
            assert_eq!(
                projection.ingest(raw(sequence as u64, value)),
                ProjectionEffect::None
            );
        }
        assert_eq!(projection.items().len(), values.len());
        let direct = projection
            .items()
            .iter()
            .map(|item| {
                item.presentation
                    .system
                    .as_ref()
                    .and_then(|system| system.direct.as_ref())
                    .expect("typed direct system presentation")
            })
            .collect::<Vec<_>>();
        assert_eq!(direct[0].identity.uuid, "system-0");
        assert!(matches!(
            &direct[0].data,
            DirectSystemData::Informational {
                content,
                tool_use_id: Some(tool_use_id),
            } if content == "notice" && tool_use_id == "tool-info"
        ));
        assert!(matches!(
            &direct[1].data,
            DirectSystemData::PermissionRetry { commands }
                if commands == &["git status", "pwd"]
        ));
        assert!(matches!(
            &direct[3].data,
            DirectSystemData::StopHookSummary {
                hook_infos,
                hook_errors,
                prevented_continuation: true,
                stop_reason: Some(reason),
                has_output: true,
                tool_use_id: Some(tool_use_id),
                ..
            } if hook_infos == &[DirectStopHookInfo {
                    hook_name: "prompt".to_string(),
                    duration_ms: 12.into(),
                }]
                && hook_errors == &["failed"]
                && reason == "blocked"
                && tool_use_id == "tool-stop"
        ));
        assert!(matches!(
            &direct[4].data,
            DirectSystemData::TurnDuration {
                duration_ms,
                budget_tokens: Some(budget_tokens),
                budget_limit: Some(budget_limit),
                budget_nudges: Some(budget_nudges),
            } if duration_ms.as_u64() == Some(1500)
                && budget_tokens.as_u64() == Some(100)
                && budget_limit.as_u64() == Some(200)
                && budget_nudges.as_u64() == Some(2)
        ));
        assert!(matches!(&direct[8].data, DirectSystemData::ApiMetrics));
        assert!(matches!(
            &direct[10].data,
            DirectSystemData::ApiError {
                error: DirectApiErrorPresentation {
                    message: Some(message),
                    status: Some(status),
                    deeply_nested_message: Some(deep),
                    connection_code: Some(code),
                    ..
                },
                ..
            } if message == "Connection error."
                && status.as_u64() == Some(503)
                && deep == "deep response"
                && code == "ETIMEDOUT"
        ));
        assert!(matches!(
            &direct[11].data,
            DirectSystemData::CompactBoundary
        ));
        assert!(matches!(
            &direct[12].data,
            DirectSystemData::MicrocompactBoundary
        ));
        assert!(matches!(&direct[14].data, DirectSystemData::Thinking));
        assert!(matches!(
            &direct[15].data,
            DirectSystemData::FileSnapshot { content } if content == "snapshot"
        ));
        let renderer_state = format!("{direct:?}");
        assert!(
            !renderer_state.contains(timestamp)
                && !renderer_state.contains("prompt text")
                && !renderer_state.contains("keep this")
                && !renderer_state.contains("large source body"),
            "producer-only values must remain validated/raw without being duplicated into renderer state"
        );
    }

    #[test]
    fn stream_context_accepts_only_the_two_source_declared_shapes() {
        for exact in [
            json!({"type":"stream_event","event":{"type":"ping"}}),
            json!({"type":"stream_event","event":{"type":"ping"},"ttftMs":12,"uuid":"direct"}),
            json!({
                "type":"stream_event","event":{"type":"ping"},
                "uuid":"sdk","session_id":"session","parent_tool_use_id":null
            }),
            json!({
                "type":"stream_event","event":{"type":"ping"},
                "uuid":"sdk-child","session_id":"session","parent_tool_use_id":"tool"
            }),
        ] {
            let mut projection = Projection::default();
            assert_eq!(projection.ingest(raw(0, exact)), ProjectionEffect::None);
        }

        for hybrid in [
            json!({
                "type":"stream_event","event":{"type":"ping"},
                "uuid":"missing-parent","session_id":"session"
            }),
            json!({
                "type":"stream_event","event":{"type":"ping"},
                "uuid":"missing-session","parent_tool_use_id":null
            }),
            json!({
                "type":"stream_event","event":{"type":"ping"},
                "session_id":"session","parent_tool_use_id":null
            }),
            json!({
                "type":"stream_event","event":{"type":"ping"},
                "ttftMs":"not-a-number"
            }),
        ] {
            let mut projection = Projection::default();
            assert!(matches!(
                projection.ingest(raw(0, hybrid)),
                ProjectionEffect::FailClosed { sequence: 0, .. }
            ));
        }
    }

    #[test]
    fn fixed_direct_attachment_denominator_has_one_exact_disposition_per_member() {
        let expected = HashSet::from([
            "file",
            "compact_file_reference",
            "pdf_reference",
            "already_read_file",
            "edited_text_file",
            "edited_image_file",
            "directory",
            "selected_lines_in_ide",
            "opened_file_in_ide",
            "todo_reminder",
            "task_reminder",
            "nested_memory",
            "relevant_memories",
            "dynamic_skill",
            "skill_listing",
            "skill_discovery",
            "queued_command",
            "output_style",
            "diagnostics",
            "plan_mode",
            "plan_mode_reentry",
            "plan_mode_exit",
            "auto_mode",
            "auto_mode_exit",
            "critical_system_reminder",
            "plan_file_reference",
            "mcp_resource",
            "command_permissions",
            "agent_mention",
            "task_status",
            "async_hook_response",
            "token_usage",
            "budget_usd",
            "output_token_usage",
            "structured_output",
            "teammate_mailbox",
            "team_context",
            "hook_cancelled",
            "hook_blocking_error",
            "hook_non_blocking_error",
            "hook_error_during_execution",
            "hook_stopped_continuation",
            "hook_success",
            "hook_additional_context",
            "hook_system_message",
            "hook_permission_decision",
            "invoked_skills",
            "verify_plan_reminder",
            "max_turns_reached",
            "current_session_memory",
            "teammate_shutdown_batch",
            "compaction_reminder",
            "context_efficiency",
            "date_change",
            "ultrathink_effort",
            "deferred_tools_delta",
            "agent_listing_delta",
            "mcp_instructions_delta",
            "companion_intro",
            "bagel_console",
        ]);
        let mut classified = HashSet::new();
        for attachment_type in NULL_RENDERING_DIRECT_ATTACHMENT_TYPES
            .into_iter()
            .chain(PROJECTED_DIRECT_ATTACHMENT_TYPES)
            .chain(RENDERER_GATED_DIRECT_ATTACHMENT_TYPES)
        {
            assert!(
                classified.insert(attachment_type),
                "duplicate attachment disposition for {attachment_type}"
            );
        }
        assert_eq!(classified, expected);
        assert_eq!(classified.len(), 60);
    }

    #[test]
    fn every_payload_rendered_direct_attachment_reaches_its_typed_projector() {
        let attachments = vec![
            json!({
                "type":"file",
                "filename":"/workspace/a.rs",
                "displayPath":"a.rs",
                "content":{"type":"text","file":{"numLines":3}}
            }),
            json!({
                "type":"compact_file_reference",
                "filename":"/workspace/a.rs",
                "displayPath":"a.rs"
            }),
            json!({
                "type":"pdf_reference",
                "filename":"/workspace/a.pdf",
                "displayPath":"a.pdf",
                "pageCount":2,
                "fileSize":2048
            }),
            json!({
                "type":"already_read_file",
                "filename":"/workspace/a.rs",
                "displayPath":"a.rs",
                "content":{"type":"file_unchanged"}
            }),
            json!({
                "type":"directory",
                "path":"/workspace/src",
                "displayPath":"src",
                "content":"a.rs"
            }),
            json!({
                "type":"selected_lines_in_ide",
                "ideName":"Code",
                "lineStart":2,
                "lineEnd":4,
                "filename":"/workspace/a.rs",
                "displayPath":"a.rs",
                "content":"selected"
            }),
            json!({
                "type":"nested_memory",
                "path":"/workspace/CRABCODE.md",
                "displayPath":"CRABCODE.md",
                "content":{}
            }),
            json!({
                "type":"relevant_memories",
                "memories":[{"path":"memory.md","content":"remember","mtimeMs":1}]
            }),
            json!({
                "type":"dynamic_skill",
                "skillDir":"/workspace/.crabcode/skills",
                "skillNames":["audit"],
                "displayPath":".crabcode/skills"
            }),
            json!({
                "type":"skill_listing",
                "content":"audit",
                "skillCount":1,
                "isInitial":false
            }),
            json!({
                "type":"queued_command",
                "prompt":[{"type":"text","text":"next command"}],
                "imagePasteIds":[7]
            }),
            json!({
                "type":"diagnostics",
                "isNew":true,
                "files":[{
                    "uri":"file:///workspace/a.rs",
                    "diagnostics":[{
                        "message":"type mismatch",
                        "severity":"Error",
                        "range":{
                            "start":{"line":2,"character":4},
                            "end":{"line":2,"character":8}
                        },
                        "code":"E0308",
                        "source":"rustc"
                    }]
                }]
            }),
            json!({
                "type":"plan_file_reference",
                "planFilePath":"/workspace/plan.md",
                "planContent":"plan"
            }),
            json!({
                "type":"mcp_resource",
                "server":"filesystem",
                "uri":"file:///workspace/a.rs",
                "name":"a.rs",
                "content":{"contents":[]}
            }),
            json!({
                "type":"task_status",
                "taskId":"task-1",
                "taskType":"local_bash",
                "status":"running",
                "description":"compile",
                "deltaSummary":null
            }),
            json!({
                "type":"hook_blocking_error",
                "blockingError":{"blockingError":"blocked","command":"check"},
                "hookName":"policy",
                "toolUseID":"tool-1",
                "hookEvent":"SessionStart"
            }),
            json!({
                "type":"hook_non_blocking_error",
                "hookName":"notice",
                "stderr":"warning",
                "stdout":"",
                "exitCode":1,
                "toolUseID":"tool-1",
                "hookEvent":"SessionStart"
            }),
            json!({
                "type":"hook_error_during_execution",
                "content":"warning",
                "hookName":"notice",
                "toolUseID":"tool-1",
                "hookEvent":"SessionStart"
            }),
            json!({
                "type":"hook_stopped_continuation",
                "message":"stop",
                "hookName":"policy",
                "toolUseID":"tool-1",
                "hookEvent":"SessionStart"
            }),
            json!({
                "type":"hook_system_message",
                "content":"notice",
                "hookName":"policy",
                "toolUseID":"tool-1",
                "hookEvent":"SessionStart"
            }),
            json!({
                "type":"hook_permission_decision",
                "decision":"allow",
                "toolUseID":"tool-1",
                "hookEvent":"PreToolUse"
            }),
            json!({
                "type":"invoked_skills",
                "skills":[{"name":"audit","path":"/skills/audit","content":"skill"}]
            }),
            json!({"type":"teammate_shutdown_batch","count":2}),
            json!({
                "type":"agent_listing_delta",
                "addedTypes":["Explore"],
                "addedLines":["Explore"],
                "removedTypes":[],
                "isInitial":false,
                "showConcurrencyNote":false
            }),
        ];
        assert_eq!(attachments.len(), PROJECTED_DIRECT_ATTACHMENT_TYPES.len());
        let observed_types = attachments
            .iter()
            .filter_map(|attachment| string_at(attachment, &["type"]))
            .collect::<HashSet<_>>();
        assert_eq!(
            observed_types,
            PROJECTED_DIRECT_ATTACHMENT_TYPES
                .into_iter()
                .map(str::to_string)
                .collect()
        );

        for (index, attachment) in attachments.into_iter().enumerate() {
            let attachment_type = string_at(&attachment, &["type"]).expect("fixture type");
            let mut projection = Projection::default();
            assert_eq!(
                projection.ingest(raw(
                    index as u64,
                    json!({
                        "type":"attachment",
                        "attachment":attachment.clone(),
                        "uuid":format!("attachment-{index}"),
                        "timestamp":"2026-07-27T00:00:00.000Z",
                        "toolUseID":"outer-attachment-tool"
                    })
                )),
                ProjectionEffect::None,
                "{attachment_type}"
            );
            assert_eq!(
                projection.items().len(),
                1,
                "{attachment_type} must produce one source-visible carrier"
            );
            let projected = projection.items()[0]
                .presentation
                .direct_attachment
                .as_ref()
                .expect("payload-rendered attachment must retain typed presentation");
            assert_eq!(
                projected.identity.uuid,
                format!("attachment-{index}"),
                "{attachment_type}"
            );
            assert_eq!(projection.items()[0].tool_use_id, None, "{attachment_type}");
            let renderer_state = format!("{projected:?}");
            assert!(
                !renderer_state.contains("2026-07-27T00:00:00.000Z")
                    && !renderer_state.contains("outer-attachment-tool"),
                "{attachment_type} duplicated producer-only outer fields into renderer state"
            );
            assert!(
                matches!(
                    (attachment_type.as_str(), &projected.data),
                    (
                        "file" | "already_read_file",
                        DirectAttachmentData::File { .. }
                    ) | (
                        "compact_file_reference",
                        DirectAttachmentData::CompactFileReference { .. }
                    ) | ("pdf_reference", DirectAttachmentData::PdfReference { .. })
                        | ("directory", DirectAttachmentData::Directory { .. })
                        | (
                            "selected_lines_in_ide",
                            DirectAttachmentData::SelectedLines { .. }
                        )
                        | ("nested_memory", DirectAttachmentData::NestedMemory { .. })
                        | (
                            "relevant_memories",
                            DirectAttachmentData::RelevantMemories { .. }
                        )
                        | ("dynamic_skill", DirectAttachmentData::DynamicSkill { .. })
                        | ("skill_listing", DirectAttachmentData::SkillListing { .. })
                        | ("queued_command", DirectAttachmentData::QueuedCommand { .. })
                        | ("diagnostics", DirectAttachmentData::Diagnostics { .. })
                        | (
                            "plan_file_reference",
                            DirectAttachmentData::PlanFileReference { .. }
                        )
                        | ("mcp_resource", DirectAttachmentData::McpResource { .. })
                        | ("task_status", DirectAttachmentData::TaskStatus { .. })
                        | (
                            "hook_blocking_error",
                            DirectAttachmentData::HookBlockingError { .. }
                        )
                        | (
                            "hook_non_blocking_error",
                            DirectAttachmentData::HookNonBlockingError { .. }
                        )
                        | (
                            "hook_error_during_execution",
                            DirectAttachmentData::HookErrorDuringExecution { .. }
                        )
                        | (
                            "hook_stopped_continuation",
                            DirectAttachmentData::HookStoppedContinuation { .. }
                        )
                        | (
                            "hook_system_message",
                            DirectAttachmentData::HookSystemMessage { .. }
                        )
                        | (
                            "hook_permission_decision",
                            DirectAttachmentData::HookPermissionDecision { .. }
                        )
                        | ("invoked_skills", DirectAttachmentData::InvokedSkills { .. })
                        | (
                            "teammate_shutdown_batch",
                            DirectAttachmentData::TeammateShutdownBatch { .. }
                        )
                        | (
                            "agent_listing_delta",
                            DirectAttachmentData::AgentListingDelta { .. }
                        )
                ),
                "{attachment_type} reached the wrong typed attachment variant: {:?}",
                projected.data
            );
        }
    }

    #[test]
    fn direct_attachment_renderer_enums_and_required_fields_fail_closed() {
        let malformed = [
            (
                json!({
                    "type":"diagnostics",
                    "files":[{
                        "uri":"file:///workspace/a.rs",
                        "diagnostics":[{
                            "message":"bad",
                            "severity":"Critical",
                            "range":{"start":{"line":1,"character":2}}
                        }]
                    }]
                }),
                "unsupported severity `Critical`",
            ),
            (
                json!({
                    "type":"hook_permission_decision",
                    "decision":"ask",
                    "toolUseID":"tool-1",
                    "hookEvent":"PreToolUse"
                }),
                "unknown decision `ask`",
            ),
            (
                json!({
                    "type":"task_status",
                    "taskId":"task-1",
                    "taskType":"local_bash",
                    "status":"paused",
                    "description":"compile"
                }),
                "unknown status `paused`",
            ),
            (
                json!({
                    "type":"hook_system_message",
                    "content":"notice",
                    "hookName":"policy",
                    "toolUseID":"tool-1",
                    "hookEvent":"InventedHook"
                }),
                "unsupported hookEvent `InventedHook`",
            ),
            (
                json!({
                    "type":"relevant_memories",
                    "memories":[{"path":"memory.md","mtimeMs":1}]
                }),
                "omitted string content",
            ),
        ];
        for (index, (attachment, expected_reason)) in malformed.into_iter().enumerate() {
            let value = json!({
                "type":"attachment",
                "attachment":attachment,
                "uuid":format!("attachment-{index}"),
                "timestamp":"2026-07-27T00:00:00.000Z"
            });
            let mut projection = Projection::default();
            let effect = projection.ingest(raw(index as u64, value.clone()));
            assert!(
                matches!(
                    &effect,
                    ProjectionEffect::FailClosed { reason, .. }
                        if reason.contains(expected_reason)
                ),
                "unexpected fail-closed effect for malformed attachment {index}: {effect:?}"
            );
            assert_eq!(projection.raw_envelopes()[0].value, value);
            assert!(
                projection
                    .items()
                    .iter()
                    .all(|item| item.presentation.direct_attachment.is_none()),
                "malformed attachment must not enter typed renderer state"
            );
        }
    }

    #[test]
    fn source_null_and_renderer_gated_attachments_stay_journaled_without_rows() {
        for (index, attachment_type) in NULL_RENDERING_DIRECT_ATTACHMENT_TYPES
            .into_iter()
            .enumerate()
        {
            let mut attachment = json!({"type":attachment_type});
            if matches!(
                attachment_type,
                "hook_success" | "hook_additional_context" | "hook_cancelled"
            ) {
                let object = attachment.as_object_mut().expect("fixture object");
                object.insert("hookName".to_string(), json!("hook"));
                object.insert("toolUseID".to_string(), json!("tool"));
                object.insert("hookEvent".to_string(), json!("SessionStart"));
            }
            let value = json!({
                "type":"attachment",
                "attachment":attachment,
                "uuid":format!("null-attachment-{index}"),
                "timestamp":"2026-07-27T00:00:00.000Z"
            });
            let mut projection = Projection::default();
            assert_eq!(
                projection.ingest(raw(index as u64, value.clone())),
                ProjectionEffect::None,
                "{attachment_type}"
            );
            assert!(projection.items().is_empty(), "{attachment_type}");
            assert_eq!(projection.raw_envelopes()[0].value, value);
        }

        for (index, attachment) in [
            json!({
                "type":"skill_discovery",
                "skills":[{"name":"audit","description":"audit"}],
                "signal":{},
                "source":"native"
            }),
            json!({
                "type":"async_hook_response",
                "processId":"1",
                "hookName":"hook",
                "hookEvent":"SessionStart",
                "response":{},
                "stdout":"",
                "stderr":""
            }),
            json!({"type":"teammate_mailbox","messages":[]}),
        ]
        .into_iter()
        .enumerate()
        {
            let attachment_type = string_at(&attachment, &["type"]).expect("fixture type");
            let value = json!({
                "type":"attachment",
                "attachment":attachment,
                "uuid":format!("gated-attachment-{index}"),
                "timestamp":"2026-07-27T00:00:00.000Z"
            });
            let mut projection = Projection::default();
            assert_eq!(
                projection.ingest(raw(index as u64, value.clone())),
                ProjectionEffect::None,
                "{attachment_type}"
            );
            assert!(projection.items().is_empty(), "{attachment_type}");
            assert_eq!(projection.raw_envelopes()[0].value, value);
        }
    }

    #[test]
    fn fixed_direct_nested_progress_retains_first_prompt_and_typed_message_kind() {
        let mut projection = Projection::default();
        let initial = json!({
            "type":"progress",
            "data":{
                "type":"agent_progress",
                "prompt":"inspect the repository",
                "agentId":"agent-1",
                "message":{
                    "type":"user",
                    "uuid":"nested-user",
                    "timestamp":"2026-07-27T00:00:00.000Z",
                    "message":{"role":"user","content":"inspect the repository"}
                }
            },
            "toolUseID":"agent-progress-1",
            "parentToolUseID":"agent-tool-1",
            "uuid":"progress-1",
            "timestamp":"2026-07-27T00:00:00.000Z"
        });
        assert_eq!(projection.ingest(raw(0, initial)), ProjectionEffect::None);
        assert_eq!(projection.items().len(), 1);
        assert_eq!(projection.items()[0].kind, ProjectedKind::Progress);
        assert!(!projection.items()[0].streaming);
        assert!(matches!(
            projection.items()[0].presentation.direct_progress.as_ref(),
            Some(DirectProgressPresentation::Nested {
                prompt,
                message_kind: DirectNestedMessageKind::User,
                ..
            }) if prompt == "inspect the repository"
        ));
        assert_eq!(
            projection.direct_progress_identities(),
            &[DirectProgressIdentity {
                uuid: "progress-1".to_string(),
                tool_use_id: "agent-progress-1".to_string(),
                parent_tool_use_id: "agent-tool-1".to_string(),
                progress_type: "agent_progress".to_string(),
                raw_sequence: 0,
            }]
        );

        let nested_message = json!({
            "type":"assistant",
            "uuid":"nested-assistant",
            "timestamp":"2026-07-27T00:00:01.000Z",
            "message":{
                "id":"nested-message",
                "role":"assistant",
                "content":[{"type":"text","text":"repository inspected"}]
            }
        });
        let update = json!({
            "type":"progress",
            "data":{
                "type":"agent_progress",
                "prompt":"",
                "agentId":"agent-1",
                "message":nested_message.clone()
            },
            "toolUseID":"agent-progress-2",
            "parentToolUseID":"agent-tool-1",
            "uuid":"progress-2",
            "timestamp":"2026-07-27T00:00:01.000Z"
        });
        assert_eq!(projection.ingest(raw(1, update)), ProjectionEffect::None);
        assert_eq!(projection.items().len(), 2);
        assert_eq!(projection.items()[1].text, "repository inspected");
        assert!(!projection.items()[1].streaming);
        assert_eq!(
            projection.items()[1]
                .presentation
                .direct_progress_identity
                .as_ref(),
            Some(&DirectProgressIdentity {
                uuid: "progress-2".to_string(),
                tool_use_id: "agent-progress-2".to_string(),
                parent_tool_use_id: "agent-tool-1".to_string(),
                progress_type: "agent_progress".to_string(),
                raw_sequence: 1,
            })
        );
        assert_eq!(projection.direct_progress_identities().len(), 2);
        assert!(matches!(
            projection.items()[1].presentation.direct_progress.as_ref(),
            Some(DirectProgressPresentation::Nested {
                progress_type,
                parent_tool_use_id,
                progress_tool_use_id,
                prompt,
                agent_id,
                message_kind,
                usage,
            }) if progress_type == "agent_progress"
                && parent_tool_use_id == "agent-tool-1"
                && progress_tool_use_id == "agent-progress-2"
                && prompt == "inspect the repository"
                && agent_id == "agent-1"
                && *message_kind == DirectNestedMessageKind::Assistant
                && usage.is_none()
        ));
    }

    #[test]
    fn fixed_direct_nested_progress_retains_exact_assistant_usage() {
        let mut projection = Projection::default();
        let update = json!({
            "type":"progress",
            "data":{
                "type":"agent_progress",
                "prompt":"inspect",
                "agentId":"agent-1",
                "message":{
                    "type":"assistant",
                    "uuid":"nested-assistant-usage",
                    "timestamp":"2026-07-27T00:00:01.000Z",
                    "message":{
                        "id":"nested-message-usage",
                        "role":"assistant",
                        "content":[{"type":"text","text":"repository inspected"}],
                        "usage":{
                            "input_tokens":1000,
                            "output_tokens":200,
                            "cache_creation_input_tokens":50,
                            "cache_read_input_tokens":null
                        }
                    }
                }
            },
            "toolUseID":"agent-progress-usage",
            "parentToolUseID":"agent-tool-usage",
            "uuid":"progress-usage",
            "timestamp":"2026-07-27T00:00:01.000Z"
        });

        assert_eq!(projection.ingest(raw(0, update)), ProjectionEffect::None);
        let usage = match projection.items()[0].presentation.direct_progress.as_ref() {
            Some(DirectProgressPresentation::Nested {
                usage: Some(usage), ..
            }) => usage,
            other => panic!("expected exact nested assistant usage, got {other:?}"),
        };
        assert_eq!(
            usage,
            &DirectNestedAssistantUsage {
                input_tokens: serde_json::Number::from(1_000_u64),
                output_tokens: serde_json::Number::from(200_u64),
                cache_creation_input_tokens: Some(serde_json::Number::from(50_u64)),
                cache_read_input_tokens: None,
            }
        );
    }

    #[test]
    fn fixed_direct_nested_progress_accepts_sparse_nullable_cache_usage() {
        for (sequence, usage, expected_creation, expected_read) in [
            (
                0,
                json!({"input_tokens":1000, "output_tokens":200}),
                None,
                None,
            ),
            (
                1,
                json!({
                    "input_tokens":1000,
                    "output_tokens":200,
                    "cache_creation_input_tokens":null,
                    "cache_read_input_tokens":null
                }),
                None,
                None,
            ),
            (
                2,
                json!({
                    "input_tokens":1000,
                    "output_tokens":200,
                    "cache_creation_input_tokens":50,
                    "cache_read_input_tokens":25
                }),
                Some(50),
                Some(25),
            ),
        ] {
            let mut projection = Projection::default();
            let update = json!({
                "type":"progress",
                "data":{
                    "type":"agent_progress",
                    "prompt":"inspect",
                    "agentId":"agent-1",
                    "message":{
                        "type":"assistant",
                        "uuid":format!("nested-assistant-sparse-{sequence}"),
                        "timestamp":"2026-07-27T00:00:01.000Z",
                        "message":{
                            "id":format!("nested-message-sparse-{sequence}"),
                            "role":"assistant",
                            "content":[{"type":"text","text":"repository inspected"}],
                            "usage":usage
                        }
                    }
                },
                "toolUseID":format!("agent-progress-sparse-{sequence}"),
                "parentToolUseID":format!("agent-tool-sparse-{sequence}"),
                "uuid":format!("progress-sparse-{sequence}"),
                "timestamp":"2026-07-27T00:00:01.000Z"
            });

            assert_eq!(
                projection.ingest(raw(sequence, update)),
                ProjectionEffect::None
            );
            let usage = match projection.items()[0].presentation.direct_progress.as_ref() {
                Some(DirectProgressPresentation::Nested {
                    usage: Some(usage), ..
                }) => usage,
                other => panic!("expected sparse nested assistant usage, got {other:?}"),
            };
            assert_eq!(
                usage
                    .cache_creation_input_tokens
                    .as_ref()
                    .and_then(serde_json::Number::as_u64),
                expected_creation
            );
            assert_eq!(
                usage
                    .cache_read_input_tokens
                    .as_ref()
                    .and_then(serde_json::Number::as_u64),
                expected_read
            );
        }
    }

    #[test]
    fn fixed_direct_nested_progress_rejects_malformed_assistant_usage() {
        let cases = [
            (
                json!({
                    "output_tokens":200,
                }),
                "omitted number input_tokens",
            ),
            (
                json!({
                    "input_tokens":1000,
                    "cache_creation_input_tokens":50
                }),
                "omitted number output_tokens",
            ),
            (
                json!({
                    "input_tokens":1000,
                    "output_tokens":200,
                    "cache_read_input_tokens":"25"
                }),
                "non-number/non-null optional cache_read_input_tokens",
            ),
            (json!("1000"), "non-object usage"),
        ];

        for (index, (usage, expected_reason)) in cases.into_iter().enumerate() {
            let mut projection = Projection::default();
            let update = json!({
                "type":"progress",
                "data":{
                    "type":"agent_progress",
                    "prompt":"inspect",
                    "agentId":"agent-1",
                    "message":{
                        "type":"assistant",
                        "uuid":format!("nested-assistant-usage-{index}"),
                        "timestamp":"2026-07-27T00:00:01.000Z",
                        "message":{
                            "id":format!("nested-message-usage-{index}"),
                            "role":"assistant",
                            "content":[{"type":"text","text":"repository inspected"}],
                            "usage":usage
                        }
                    }
                },
                "toolUseID":format!("agent-progress-usage-{index}"),
                "parentToolUseID":format!("agent-tool-usage-{index}"),
                "uuid":format!("progress-usage-{index}"),
                "timestamp":"2026-07-27T00:00:01.000Z"
            });

            assert!(matches!(
                projection.ingest(raw(index as u64, update)),
                ProjectionEffect::FailClosed { sequence, reason }
                    if sequence == index as u64 && reason.contains(expected_reason)
            ));
            assert!(
                projection.items().is_empty(),
                "malformed renderer facts must not produce a partial item"
            );
        }
    }

    #[test]
    fn fixed_direct_nested_tool_completion_updates_only_renderer_running_state() {
        let mut projection = Projection::default();
        let tool_use = json!({
            "type":"progress",
            "data":{
                "type":"agent_progress",
                "prompt":"inspect",
                "agentId":"agent-1",
                "message":{
                    "type":"assistant",
                    "uuid":"nested-assistant-use",
                    "timestamp":"2026-07-27T00:00:00.000Z",
                    "message":{
                        "id":"nested-message-use",
                        "role":"assistant",
                        "content":[{
                            "type":"tool_use",
                            "id":"nested-tool-1",
                            "name":"Read",
                            "input":{"file_path":"README.md"}
                        }]
                    }
                }
            },
            "toolUseID":"agent-progress-use",
            "parentToolUseID":"agent-tool-1",
            "uuid":"progress-use",
            "timestamp":"2026-07-27T00:00:00.000Z"
        });
        assert_eq!(projection.ingest(raw(0, tool_use)), ProjectionEffect::None);
        let tool_key = projection
            .items()
            .iter()
            .find(|item| item.kind == ProjectedKind::ToolUse)
            .expect("nested tool-use row")
            .key
            .clone();
        assert!(
            projection
                .items()
                .iter()
                .find(|item| item.key == tool_key)
                .is_some_and(|item| item.streaming)
        );

        let tool_result = json!({
            "type":"progress",
            "data":{
                "type":"agent_progress",
                "prompt":"",
                "agentId":"agent-1",
                "message":{
                    "type":"user",
                    "uuid":"nested-user-result",
                    "timestamp":"2026-07-27T00:00:01.000Z",
                    "message":{
                        "role":"user",
                        "content":[{
                            "type":"tool_result",
                            "tool_use_id":"nested-tool-1",
                            "content":"done"
                        }]
                    }
                }
            },
            "toolUseID":"agent-progress-result",
            "parentToolUseID":"agent-tool-1",
            "uuid":"progress-result",
            "timestamp":"2026-07-27T00:00:01.000Z"
        });
        assert_eq!(
            projection.ingest(raw(1, tool_result)),
            ProjectionEffect::None
        );
        assert!(
            projection
                .items()
                .iter()
                .find(|item| item.key == tool_key)
                .is_some_and(|item| !item.streaming),
            "the filtered Agent user envelope closes its correlated tool use"
        );
        assert!(projection.items().iter().any(|item| {
            item.kind == ProjectedKind::Progress
                && matches!(
                    item.presentation.direct_progress.as_ref(),
                    Some(DirectProgressPresentation::Nested {
                        message_kind: DirectNestedMessageKind::User,
                        ..
                    })
                )
        }));
    }

    #[test]
    fn fixed_direct_nested_completion_is_order_independent_like_complete_lookup_scan() {
        let mut projection = Projection::default();
        let result_first = json!({
            "type":"progress",
            "data":{
                "type":"agent_progress",
                "prompt":"inspect",
                "agentId":"agent-1",
                "message":{
                    "type":"user",
                    "uuid":"nested-result-first",
                    "timestamp":"2026-07-27T00:00:00.000Z",
                    "message":{
                        "role":"user",
                        "content":[{
                            "type":"tool_result",
                            "tool_use_id":"nested-tool-1",
                            "content":"done"
                        }]
                    }
                }
            },
            "toolUseID":"progress-result-first",
            "parentToolUseID":"agent-tool-1",
            "uuid":"progress-result-first-envelope",
            "timestamp":"2026-07-27T00:00:00.000Z"
        });
        assert_eq!(
            projection.ingest(raw(0, result_first)),
            ProjectionEffect::None
        );

        let tool_use_later = json!({
            "type":"progress",
            "data":{
                "type":"agent_progress",
                "prompt":"",
                "agentId":"agent-1",
                "message":{
                    "type":"assistant",
                    "uuid":"nested-use-later",
                    "timestamp":"2026-07-27T00:00:01.000Z",
                    "message":{
                        "id":"nested-message-use-later",
                        "role":"assistant",
                        "content":[{
                            "type":"tool_use",
                            "id":"nested-tool-1",
                            "name":"Read",
                            "input":{"file_path":"README.md"}
                        }]
                    }
                }
            },
            "toolUseID":"progress-use-later",
            "parentToolUseID":"agent-tool-1",
            "uuid":"progress-use-later-envelope",
            "timestamp":"2026-07-27T00:00:01.000Z"
        });
        assert_eq!(
            projection.ingest(raw(1, tool_use_later)),
            ProjectionEffect::None
        );
        assert!(
            projection
                .items()
                .iter()
                .find(|item| item.kind == ProjectedKind::ToolUse)
                .is_some_and(|item| !item.streaming),
            "the complete-message lookup scan treats a previously resolved ID as static"
        );
    }

    #[test]
    fn fixed_direct_skill_tool_completion_retains_the_blank_result_envelope_fact() {
        let mut projection = Projection::default();
        let tool_use = json!({
            "type":"progress",
            "data":{
                "type":"skill_progress",
                "prompt":"",
                "agentId":"skill-1",
                "message":{
                    "type":"assistant",
                    "uuid":"skill-assistant-use",
                    "timestamp":"2026-07-27T00:00:00.000Z",
                    "message":{
                        "id":"skill-message-use",
                        "role":"assistant",
                        "content":[{
                            "type":"tool_use",
                            "id":"skill-tool-1",
                            "name":"Read",
                            "input":{"file_path":"README.md"}
                        }]
                    }
                }
            },
            "toolUseID":"skill-progress-use",
            "parentToolUseID":"skill-parent",
            "uuid":"skill-progress-use-envelope",
            "timestamp":"2026-07-27T00:00:00.000Z"
        });
        assert_eq!(projection.ingest(raw(0, tool_use)), ProjectionEffect::None);
        let tool_key = projection
            .items()
            .iter()
            .find(|item| item.kind == ProjectedKind::ToolUse)
            .expect("nested Skill tool-use row")
            .key
            .clone();
        assert!(
            projection
                .items()
                .iter()
                .find(|item| item.key == tool_key)
                .is_some_and(|item| item.streaming)
        );

        let tool_result = json!({
            "type":"progress",
            "data":{
                "type":"skill_progress",
                "prompt":"",
                "agentId":"skill-1",
                "message":{
                    "type":"user",
                    "uuid":"skill-user-result",
                    "timestamp":"2026-07-27T00:00:01.000Z",
                    "message":{
                        "role":"user",
                        "content":[{
                            "type":"tool_result",
                            "tool_use_id":"skill-tool-1",
                            "content":"done"
                        }]
                    }
                }
            },
            "toolUseID":"skill-progress-result",
            "parentToolUseID":"skill-parent",
            "uuid":"skill-progress-result-envelope",
            "timestamp":"2026-07-27T00:00:01.000Z"
        });
        assert_eq!(
            projection.ingest(raw(1, tool_result)),
            ProjectionEffect::None
        );
        assert!(
            projection
                .items()
                .iter()
                .find(|item| item.key == tool_key)
                .is_some_and(|item| !item.streaming),
            "the correlated Skill user result closes its nested invocation"
        );
        assert!(projection.items().iter().any(|item| {
            item.kind == ProjectedKind::ToolResult
                && matches!(
                    item.presentation.direct_progress.as_ref(),
                    Some(DirectProgressPresentation::Nested {
                        message_kind: DirectNestedMessageKind::User,
                        ..
                    })
                )
        }));
    }

    #[test]
    fn compact_progress_upserts_one_typed_row_and_compact_end_removes_it() {
        let mut projection = Projection::default();
        let phases = [
            (
                json!({"type":"compact_progress","phase":"hooks_start","hookType":"pre_compact"}),
                DirectCompactProgressPhase::HooksStart,
                Some(DirectCompactHookType::PreCompact),
                "Running pre-compaction hooks…",
            ),
            (
                json!({"type":"compact_progress","phase":"compact_start"}),
                DirectCompactProgressPhase::CompactStart,
                None,
                "Summarizing conversation…",
            ),
            (
                json!({"type":"compact_progress","phase":"hooks_start","hookType":"session_start"}),
                DirectCompactProgressPhase::HooksStart,
                Some(DirectCompactHookType::SessionStart),
                "Running session-start hooks…",
            ),
            (
                json!({"type":"compact_progress","phase":"hooks_start","hookType":"post_compact"}),
                DirectCompactProgressPhase::HooksStart,
                Some(DirectCompactHookType::PostCompact),
                "Running post-compaction hooks…",
            ),
        ];

        for (sequence, (data, phase, hook_type, text)) in phases.into_iter().enumerate() {
            assert_eq!(
                projection.ingest(raw(
                    sequence as u64,
                    json!({
                        "type":"progress",
                        "data":data,
                        "toolUseID":"compact-progress-1",
                        "parentToolUseID":"compact-progress-1",
                        "uuid":format!("compact-progress-{sequence}"),
                        "timestamp":"2026-08-10T00:00:00.000Z"
                    })
                )),
                ProjectionEffect::None
            );
            assert_eq!(projection.items().len(), 1);
            let item = &projection.items()[0];
            assert_eq!(item.kind, ProjectedKind::Progress);
            assert_eq!(item.tool_use_id.as_deref(), Some("compact-progress-1"));
            assert_eq!(item.text, text);
            assert!(item.streaming);
            assert_eq!(
                item.presentation.direct_progress.as_ref(),
                Some(&DirectProgressPresentation::Compact { phase, hook_type })
            );
            assert_eq!(item.raw_sequences.len(), sequence + 1);
        }

        assert_eq!(
            projection.ingest(raw(
                4,
                json!({
                    "type":"progress",
                    "data":{"type":"compact_progress","phase":"compact_end"},
                    "toolUseID":"compact-progress-1",
                    "parentToolUseID":"compact-progress-1",
                    "uuid":"compact-progress-4",
                    "timestamp":"2026-08-10T00:00:00.000Z"
                })
            )),
            ProjectionEffect::None
        );
        assert!(
            projection.items().is_empty(),
            "finally-only compact_end must remove the running row instead of rendering success"
        );
        assert!(projection.item_removals().iter().any(|removal| {
            removal.key == "direct-compact-progress:compact-progress-1" && removal.raw_sequence == 4
        }));

        assert_eq!(projection.direct_progress_identities().len(), 5);
        assert!(
            projection
                .direct_progress_identities()
                .iter()
                .all(|identity| {
                    identity.progress_type == "compact_progress"
                        && identity.parent_tool_use_id == "compact-progress-1"
                        && identity.tool_use_id == "compact-progress-1"
                })
        );
    }

    #[test]
    fn compact_progress_projection_rejects_phase_hook_mismatch_if_classification_is_bypassed() {
        let value = json!({
            "type":"progress",
            "data":{
                "type":"compact_progress",
                "phase":"compact_start",
                "hookType":"pre_compact"
            },
            "toolUseID":"compact-progress-1",
            "parentToolUseID":"compact-progress-1",
            "uuid":"compact-progress-malformed",
            "timestamp":"2026-08-10T00:00:00.000Z"
        });
        let effect = Projection::default().ingest(RawEnvelope {
            sequence: 0,
            encoded_len: serde_json::to_vec(&value).expect("encode").len(),
            value,
            classification: EnvelopeClass::DirectProgress {
                progress_type: "compact_progress".to_string(),
            },
            correlation: None,
        });
        assert!(matches!(
            effect,
            ProjectionEffect::FailClosed { ref reason, .. }
                if reason.contains("must contain exactly type and phase")
        ));
    }

    #[test]
    fn fixed_direct_mcp_search_and_waiting_progress_upsert_source_state() {
        let mut mcp = Projection::default();
        for (sequence, data) in [
            json!({
                "type":"mcp_progress",
                "status":"started",
                "serverName":"filesystem",
                "toolName":"read_file"
            }),
            json!({
                "type":"mcp_progress",
                "status":"progress",
                "serverName":"filesystem",
                "toolName":"read_file",
                "elapsedTimeMs":250,
                "progress":3,
                "total":4,
                "progressMessage":"Reading"
            }),
        ]
        .into_iter()
        .enumerate()
        {
            assert_eq!(
                mcp.ingest(raw(
                    sequence as u64,
                    json!({
                        "type":"progress",
                        "data":data,
                        "toolUseID":format!("mcp-progress-{sequence}"),
                        "parentToolUseID":"mcp-tool-1",
                        "uuid":format!("mcp-{sequence}"),
                        "timestamp":"2026-07-27T00:00:00.000Z"
                    })
                )),
                ProjectionEffect::None
            );
        }
        assert_eq!(mcp.items().len(), 1);
        assert_eq!(mcp.items()[0].title, "filesystem · read_file");
        assert_eq!(mcp.items()[0].text, "Reading\n75%");
        assert_eq!(mcp.items()[0].raw_sequences, [0, 1]);
        assert!(matches!(
            mcp.items()[0].presentation.direct_progress.as_ref(),
            Some(DirectProgressPresentation::Mcp {
                status,
                progress,
                total,
                elapsed_time_ms,
                progress_message,
                percentage: Some(75),
                ..
            }) if status == "progress"
                && progress.as_ref().and_then(serde_json::Number::as_u64) == Some(3)
                && total.as_ref().and_then(serde_json::Number::as_u64) == Some(4)
                && elapsed_time_ms.as_ref().and_then(serde_json::Number::as_u64) == Some(250)
                && progress_message.as_deref() == Some("Reading")
        ));

        for (status, expected_text) in [("completed", "Completed"), ("failed", "Failed")] {
            let mut terminal = Projection::default();
            assert_eq!(
                terminal.ingest(raw(
                    0,
                    json!({
                        "type":"progress",
                        "data":{
                            "type":"mcp_progress",
                            "status":status,
                            "serverName":"filesystem",
                            "toolName":"read_file",
                            "elapsedTimeMs":250
                        },
                        "toolUseID":format!("mcp-{status}-progress"),
                        "parentToolUseID":format!("mcp-{status}-tool"),
                        "uuid":format!("mcp-{status}"),
                        "timestamp":"2026-07-27T00:00:00.000Z"
                    })
                )),
                ProjectionEffect::None
            );
            assert_eq!(terminal.items()[0].text, expected_text, "status: {status}");
            assert!(matches!(
                terminal.items()[0].presentation.direct_progress.as_ref(),
                Some(DirectProgressPresentation::Mcp {
                    status: projected_status,
                    progress: None,
                    total: None,
                    progress_message: None,
                    ..
                }) if projected_status == status
            ));
        }

        let mut search = Projection::default();
        for (sequence, data) in [
            json!({"type":"query_update","query":"rust tui"}),
            json!({
                "type":"search_results_received",
                "query":"rust tui",
                "resultCount":7
            }),
        ]
        .into_iter()
        .enumerate()
        {
            assert_eq!(
                search.ingest(raw(
                    sequence as u64,
                    json!({
                        "type":"progress",
                        "data":data,
                        "toolUseID":format!("search-progress-{sequence}"),
                        "parentToolUseID":"search-tool-1",
                        "uuid":format!("search-{sequence}"),
                        "timestamp":"2026-07-27T00:00:00.000Z"
                    })
                )),
                ProjectionEffect::None
            );
        }
        assert_eq!(search.items().len(), 1);
        assert_eq!(search.items()[0].text, "Found 7 results for \"rust tui\"");
        assert!(matches!(
            search.items()[0].presentation.direct_progress.as_ref(),
            Some(DirectProgressPresentation::SearchResults {
                query,
                result_count: 7
            }) if query == "rust tui"
        ));

        let mut waiting = Projection::default();
        assert_eq!(
            waiting.ingest(raw(
                0,
                json!({
                    "type":"progress",
                    "data":{
                        "type":"waiting_for_task",
                        "taskDescription":"Compile workspace",
                        "taskType":"local_bash"
                    },
                    "toolUseID":"task-progress-1",
                    "parentToolUseID":"task-tool-1",
                    "uuid":"waiting-1",
                    "timestamp":"2026-07-27T00:00:00.000Z"
                })
            )),
            ProjectionEffect::None
        );
        assert_eq!(
            waiting.items()[0].text,
            "\u{a0}\u{a0}Compile workspace\n\u{a0}\u{a0}\u{a0}\u{a0}\u{a0}Waiting for task (esc to give additional instructions)"
        );
        assert!(matches!(
            waiting.items()[0].presentation.direct_progress.as_ref(),
            Some(DirectProgressPresentation::WaitingForTask {
                task_description,
                task_type
            }) if task_description == "Compile workspace" && task_type == "local_bash"
        ));
    }

    #[test]
    fn direct_workflow_progress_uses_task_identity_and_closes_from_task_status() {
        let mut projection = Projection::default();
        for (sequence, data) in [
            json!({
                "type":"workflow_progress",
                "taskId":"local_workflow_1",
                "workflow":"deep-research",
                "phase":"Discover",
                "phaseIndex":0,
                "message":"researcher: running",
                "agentsStarted":1,
                "agentsCompleted":0
            }),
            json!({
                "type":"workflow_progress",
                "taskId":"local_workflow_1",
                "workflow":"deep-research",
                "phase":"Synthesize",
                "phaseIndex":1,
                "message":"writer: running",
                "agentsStarted":2,
                "agentsCompleted":1
            }),
        ]
        .into_iter()
        .enumerate()
        {
            assert_eq!(
                projection.ingest(raw(
                    sequence as u64,
                    json!({
                        "type":"progress",
                        "data":data,
                        "toolUseID":format!("workflow-progress-{sequence}"),
                        "parentToolUseID":"workflow-tool-use",
                        "uuid":format!("workflow-envelope-{sequence}"),
                        "timestamp":"2026-08-01T00:00:00.000Z"
                    })
                )),
                ProjectionEffect::None
            );
        }

        assert_eq!(projection.items().len(), 1);
        let item = &projection.items()[0];
        assert_eq!(item.key, "direct-workflow:local_workflow_1");
        assert_eq!(item.raw_sequences, [0, 1]);
        assert!(item.streaming);
        assert!(matches!(
            item.presentation.direct_progress.as_ref(),
            Some(DirectProgressPresentation::Workflow {
                task_id,
                workflow,
                phase: Some(phase),
                phase_index: 1,
                agents_started: 2,
                agents_completed: 1,
                phases,
                status: DirectWorkflowStatus::Running,
                ..
            }) if task_id == "local_workflow_1"
                && workflow == "deep-research"
                && phase == "Synthesize"
                && phases.len() == 2
                && phases[0].state == DirectWorkflowPhaseState::Done
                && phases[1].state == DirectWorkflowPhaseState::Active
        ));

        assert_eq!(
            projection.ingest(raw(
                2,
                json!({
                    "type":"attachment",
                    "attachment":{
                        "type":"task_status",
                        "taskId":"local_workflow_1",
                        "taskType":"local_workflow",
                        "status":"completed",
                        "description":"Deep research",
                        "deltaSummary":null
                    },
                    "uuid":"workflow-terminal",
                    "timestamp":"2026-08-01T00:00:01.000Z"
                })
            )),
            ProjectionEffect::None
        );
        assert_eq!(projection.items().len(), 1);
        let item = &projection.items()[0];
        assert!(!item.streaming);
        assert_eq!(item.raw_sequences, [0, 1, 2]);
        assert!(item.presentation.direct_attachment.is_some());
        assert!(matches!(
            item.presentation.direct_progress.as_ref(),
            Some(DirectProgressPresentation::Workflow {
                status: DirectWorkflowStatus::Completed,
                ..
            })
        ));
    }

    #[test]
    fn direct_hook_progress_resolves_each_primary_terminal_occurrence() {
        let mut projection = Projection::default();
        for (sequence, command) in ["run-first", "run-second"].into_iter().enumerate() {
            assert_eq!(
                projection.ingest(raw(
                    sequence as u64,
                    json!({
                        "type":"progress",
                        "data":{
                            "type":"hook_progress",
                            "hookEvent":"SessionStart",
                            // executeHooks names every member of this batch by
                            // its shared event/matcher, not by hook instance.
                            "hookName":"SessionStart:startup",
                            "command":command,
                            "statusMessage":format!("status-{sequence}")
                        },
                        "toolUseID":format!("hook-progress-{sequence}"),
                        "parentToolUseID":"parent-tool",
                        "uuid":format!("hook-{sequence}"),
                        "timestamp":"2026-07-27T00:00:00.000Z"
                    })
                )),
                ProjectionEffect::None
            );
        }
        assert_eq!(
            projection.direct_hook_progress_entries(),
            &[
                DirectHookProgressEntry {
                    identity: DirectProgressIdentity {
                        uuid: "hook-0".to_string(),
                        tool_use_id: "hook-progress-0".to_string(),
                        parent_tool_use_id: "parent-tool".to_string(),
                        progress_type: "hook_progress".to_string(),
                        raw_sequence: 0,
                    },
                    hook_event: "SessionStart".to_string(),
                    hook_name: "SessionStart:startup".to_string(),
                    command: "run-first".to_string(),
                    status_message: Some("status-0".to_string()),
                },
                DirectHookProgressEntry {
                    identity: DirectProgressIdentity {
                        uuid: "hook-1".to_string(),
                        tool_use_id: "hook-progress-1".to_string(),
                        parent_tool_use_id: "parent-tool".to_string(),
                        progress_type: "hook_progress".to_string(),
                        raw_sequence: 1,
                    },
                    hook_event: "SessionStart".to_string(),
                    hook_name: "SessionStart:startup".to_string(),
                    command: "run-second".to_string(),
                    status_message: Some("status-1".to_string()),
                },
            ]
        );
        let progress_key = "direct-hook-progress:parent-tool:SessionStart";
        let progress = projection
            .items()
            .iter()
            .find(|item| item.key == progress_key)
            .expect("hook progress item");
        assert_eq!(progress.text, "Running SessionStart hooks…");
        assert!(matches!(
            progress.presentation.direct_progress.as_ref(),
            Some(DirectProgressPresentation::Hook {
                in_progress_count: 2,
                resolved_count: 0,
                ..
            })
        ));
        assert_eq!(
            projection.direct_hook_progress_presentation("parent-tool", "SessionStart"),
            Some(DirectHookProgressPresentation {
                tool_use_id: "parent-tool".to_string(),
                hook_event: "SessionStart".to_string(),
                in_progress_count: 2,
                resolved_count: 0,
            })
        );

        for sequence in [2, 3] {
            assert_eq!(
                projection.ingest(raw(
                    sequence,
                    json!({
                        "type":"attachment",
                        "attachment":{
                            "type":"hook_success",
                            "content":"",
                            "hookName":"SessionStart:startup",
                            "toolUseID":"parent-tool",
                            "hookEvent":"SessionStart"
                        },
                        "uuid":format!("hook-resolution-{sequence}"),
                        "timestamp":"2026-07-27T00:00:00.000Z"
                    })
                )),
                ProjectionEffect::None
            );
            if sequence == 2 {
                let progress = projection
                    .items()
                    .iter()
                    .find(|item| item.key == progress_key)
                    .expect("one primary outcome cannot finish a two-hook batch");
                assert!(matches!(
                    progress.presentation.direct_progress.as_ref(),
                    Some(DirectProgressPresentation::Hook {
                        resolved_count: 1,
                        ..
                    })
                ));
            }
        }
        assert!(
            projection
                .items()
                .iter()
                .all(|item| item.key != progress_key)
        );
        assert_eq!(
            projection.direct_hook_progress_presentation("parent-tool", "SessionStart"),
            Some(DirectHookProgressPresentation {
                tool_use_id: "parent-tool".to_string(),
                hook_event: "SessionStart".to_string(),
                in_progress_count: 2,
                resolved_count: 2,
            }),
            "resolution removes only the transient row, not transcript lookup state"
        );
    }

    #[test]
    fn direct_supplemental_hook_attachments_do_not_finish_an_execution() {
        let mut projection = Projection::default();
        assert_eq!(
            projection.ingest(raw(
                0,
                json!({
                    "type":"progress",
                    "data":{
                        "type":"hook_progress",
                        "hookEvent":"SessionStart",
                        "hookName":"SessionStart:startup",
                        "command":"run-startup"
                    },
                    "toolUseID":"hook-progress",
                    "parentToolUseID":"hook-batch",
                    "uuid":"hook-progress",
                    "timestamp":"2026-07-27T00:00:00.000Z"
                })
            )),
            ProjectionEffect::None
        );
        let progress_key = "direct-hook-progress:hook-batch:SessionStart";

        for (sequence, attachment) in [
            json!({
                "type":"hook_system_message",
                "content":"notice",
                "hookName":"SessionStart:startup",
                "toolUseID":"hook-batch",
                "hookEvent":"SessionStart"
            }),
            json!({
                "type":"hook_stopped_continuation",
                "message":"continue was stopped",
                "hookName":"SessionStart:startup",
                "toolUseID":"hook-batch",
                "hookEvent":"SessionStart"
            }),
            json!({
                "type":"hook_additional_context",
                "content":["context"],
                "hookName":"SessionStart:startup",
                "toolUseID":"hook-batch",
                "hookEvent":"SessionStart"
            }),
        ]
        .into_iter()
        .enumerate()
        {
            let sequence = sequence as u64 + 1;
            assert_eq!(
                projection.ingest(raw(
                    sequence,
                    json!({
                        "type":"attachment",
                        "attachment":attachment,
                        "uuid":format!("supplemental-{sequence}"),
                        "timestamp":"2026-07-27T00:00:01.000Z"
                    })
                )),
                ProjectionEffect::None
            );
            assert!(
                projection
                    .items()
                    .iter()
                    .any(|item| item.key == progress_key),
                "supplemental attachment at sequence {sequence} closed the primary lifecycle"
            );
            assert_eq!(
                projection
                    .direct_hook_progress_presentation("hook-batch", "SessionStart")
                    .expect("started hook")
                    .resolved_count,
                0
            );
        }

        assert_eq!(
            projection.ingest(raw(
                4,
                json!({
                    "type":"attachment",
                    "attachment":{
                        "type":"hook_success",
                        "content":"",
                        "hookName":"SessionStart:startup",
                        "toolUseID":"hook-batch",
                        "hookEvent":"SessionStart"
                    },
                    "uuid":"primary-terminal",
                    "timestamp":"2026-07-27T00:00:02.000Z"
                })
            )),
            ProjectionEffect::None
        );
        assert!(
            projection
                .items()
                .iter()
                .all(|item| item.key != progress_key)
        );
        assert_eq!(
            projection
                .direct_hook_progress_presentation("hook-batch", "SessionStart")
                .expect("retained hook lifecycle")
                .resolved_count,
            1
        );
    }

    #[test]
    fn direct_stop_summary_closes_same_name_and_missing_attachment_outcomes() {
        for hook_event in ["Stop", "SubagentStop"] {
            let mut projection = Projection::default();
            for sequence in 0..2_u64 {
                assert_eq!(
                    projection.ingest(raw(
                        sequence,
                        json!({
                            "type":"progress",
                            "data":{
                                "type":"hook_progress",
                                "hookEvent":hook_event,
                                "hookName":hook_event,
                                "command":format!("run-{sequence}")
                            },
                            "toolUseID":format!("progress-{sequence}"),
                            "parentToolUseID":"stop-batch",
                            "uuid":format!("progress-{sequence}"),
                            "timestamp":"2026-07-27T00:00:00.000Z"
                        })
                    )),
                    ProjectionEffect::None
                );
            }

            // One ordinary hook produced its primary attachment. A valid
            // function/background outcome produced none; the batch summary is
            // the producer's terminal for both.
            assert_eq!(
                projection.ingest(raw(
                    2,
                    json!({
                        "type":"attachment",
                        "attachment":{
                            "type":"hook_success",
                            "content":"",
                            "hookName":hook_event,
                            "toolUseID":"stop-batch",
                            "hookEvent":hook_event
                        },
                        "uuid":"one-primary-terminal",
                        "timestamp":"2026-07-27T00:00:01.000Z"
                    })
                )),
                ProjectionEffect::None
            );
            assert_eq!(
                projection
                    .direct_hook_progress_presentation("stop-batch", hook_event)
                    .expect("active stop batch")
                    .resolved_count,
                1
            );

            assert_eq!(
                projection.ingest(raw(
                    3,
                    json!({
                        "type":"system",
                        "subtype":"stop_hook_summary",
                        "hookCount":2,
                        "hookInfos":[
                            {"hookName":"run-0","durationMs":10},
                            {"hookName":"run-1","durationMs":11}
                        ],
                        "hookErrors":[],
                        "preventedContinuation":false,
                        "stopReason":"",
                        "hasOutput":false,
                        "level":"suggestion",
                        "toolUseID":"stop-batch",
                        "uuid":"stop-summary",
                        "timestamp":"2026-07-27T00:00:02.000Z"
                    })
                )),
                ProjectionEffect::None
            );
            assert!(projection.items().iter().all(|item| {
                item.key != format!("direct-hook-progress:stop-batch:{hook_event}")
            }));
            assert_eq!(
                projection
                    .direct_hook_progress_presentation("stop-batch", hook_event)
                    .expect("retained terminal stop batch")
                    .resolved_count,
                2
            );
            assert!(projection.items().iter().any(|item| {
                matches!(
                    item.presentation.system.as_ref().map(|system| &system.subtype),
                    Some(ProjectedSystemSubtype::Historical(subtype))
                        if subtype == "stop_hook_summary"
                )
            }));
        }
    }

    #[test]
    fn direct_stop_summary_without_transient_progress_does_not_fabricate_lifecycle() {
        let mut projection = Projection::default();
        assert_eq!(
            projection.ingest(raw(
                0,
                json!({
                    "type":"system",
                    "subtype":"stop_hook_summary",
                    "hookCount":2,
                    "hookInfos":[],
                    "hookErrors":[],
                    "preventedContinuation":false,
                    "stopReason":"",
                    "hasOutput":false,
                    "level":"suggestion",
                    "toolUseID":"historical-stop-batch",
                    "uuid":"historical-stop-summary",
                    "timestamp":"2026-07-27T00:00:00.000Z"
                })
            )),
            ProjectionEffect::None
        );
        assert_eq!(
            projection.direct_hook_progress_presentation("historical-stop-batch", "Stop"),
            None
        );
        assert_eq!(projection.items().len(), 1);
        assert!(projection.items()[0].presentation.system.is_some());
    }

    #[test]
    fn direct_stop_summary_rejects_a_count_that_disagrees_with_its_progress_batch() {
        let mut projection = Projection::default();
        for sequence in 0..2_u64 {
            assert_eq!(
                projection.ingest(raw(
                    sequence,
                    json!({
                        "type":"progress",
                        "data":{
                            "type":"hook_progress",
                            "hookEvent":"Stop",
                            "hookName":"Stop",
                            "command":format!("run-{sequence}")
                        },
                        "toolUseID":format!("stop-progress-{sequence}"),
                        "parentToolUseID":"stop-batch",
                        "uuid":format!("stop-progress-{sequence}"),
                        "timestamp":"2026-07-27T00:00:00.000Z"
                    })
                )),
                ProjectionEffect::None
            );
        }

        let effect = projection.ingest(raw(
            2,
            json!({
                "type":"system",
                "subtype":"stop_hook_summary",
                "hookCount":1,
                "hookInfos":[{"hookName":"run-0","durationMs":10}],
                "hookErrors":[],
                "preventedContinuation":false,
                "stopReason":"",
                "hasOutput":false,
                "level":"suggestion",
                "toolUseID":"stop-batch",
                "uuid":"mismatched-stop-summary",
                "timestamp":"2026-07-27T00:00:01.000Z"
            }),
        ));
        assert!(
            matches!(
                &effect,
                ProjectionEffect::FailClosed { reason, .. }
                    if reason.contains("summary count 1 disagrees with 2 progress records")
            ),
            "mismatched producer lifecycle was not rejected: {effect:?}"
        );
        assert!(
            projection
                .items()
                .iter()
                .any(|item| { item.key == "direct-hook-progress:stop-batch:Stop" })
        );
    }

    #[test]
    fn fixed_direct_pre_and_post_hook_transcript_state_is_exactly_keyed() {
        let mut projection = Projection::default();
        for (sequence, parent_tool_use_id, hook_event, hook_name) in [
            (0, "target-a", "PreToolUse", "pre-first"),
            (1, "target-a", "PreToolUse", "pre-second"),
            (2, "target-a", "PostToolUse", "post-only"),
            (3, "target-b", "PreToolUse", "other-target"),
        ] {
            assert_eq!(
                projection.ingest(raw(
                    sequence,
                    json!({
                        "type":"progress",
                        "data":{
                            "type":"hook_progress",
                            "hookEvent":hook_event,
                            "hookName":hook_name,
                            "command":format!("run-{hook_name}")
                        },
                        "toolUseID":format!("hook-progress-{sequence}"),
                        "parentToolUseID":parent_tool_use_id,
                        "uuid":format!("hook-{sequence}"),
                        "timestamp":"2026-07-27T00:00:00.000Z"
                    })
                )),
                ProjectionEffect::None
            );
        }

        assert!(
            projection.items().is_empty(),
            "fixed live mode hides PreToolUse and PostToolUse progress"
        );
        assert_eq!(
            projection.direct_hook_progress_presentation("target-a", "PreToolUse"),
            Some(DirectHookProgressPresentation {
                tool_use_id: "target-a".to_string(),
                hook_event: "PreToolUse".to_string(),
                in_progress_count: 2,
                resolved_count: 0,
            })
        );
        assert_eq!(
            projection.direct_hook_progress_presentation("target-a", "PostToolUse"),
            Some(DirectHookProgressPresentation {
                tool_use_id: "target-a".to_string(),
                hook_event: "PostToolUse".to_string(),
                in_progress_count: 1,
                resolved_count: 0,
            })
        );
        assert_eq!(
            projection.direct_hook_progress_presentation("target-b", "PreToolUse"),
            Some(DirectHookProgressPresentation {
                tool_use_id: "target-b".to_string(),
                hook_event: "PreToolUse".to_string(),
                in_progress_count: 1,
                resolved_count: 0,
            })
        );
        assert_eq!(
            projection.direct_hook_progress_presentation("target-b", "PostToolUse"),
            None,
            "tool-use id and hook event are both exact key components"
        );

        for sequence in [4, 5] {
            assert_eq!(
                projection.ingest(raw(
                    sequence,
                    json!({
                        "type":"attachment",
                        "attachment":{
                            "type":"hook_success",
                            "content":"",
                            "hookName":"PreToolUse:Read",
                            "toolUseID":"target-a",
                            "hookEvent":"PreToolUse"
                        },
                        "uuid":format!("hook-resolution-{sequence}"),
                        "timestamp":"2026-07-27T00:00:00.000Z"
                    })
                )),
                ProjectionEffect::None
            );
        }
        assert_eq!(
            projection.direct_hook_progress_presentation("target-a", "PreToolUse"),
            Some(DirectHookProgressPresentation {
                tool_use_id: "target-a".to_string(),
                hook_event: "PreToolUse".to_string(),
                in_progress_count: 2,
                resolved_count: 2,
            }),
            "same-name primary outcomes resolve both executions while retained transcript state survives"
        );
        assert_eq!(
            projection.direct_hook_progress_presentation("target-a", "PostToolUse"),
            Some(DirectHookProgressPresentation {
                tool_use_id: "target-a".to_string(),
                hook_event: "PostToolUse".to_string(),
                in_progress_count: 1,
                resolved_count: 0,
            }),
            "resolving one event cannot alter another event for the same tool"
        );

        assert_eq!(
            projection.ingest(raw(
                7,
                json!({
                    "type":"attachment",
                    "attachment":{
                        "type":"hook_success",
                        "content":"",
                        "hookName":"completed-before-progress",
                        "toolUseID":"target-c",
                        "hookEvent":"PreToolUse"
                    },
                    "uuid":"early-hook-resolution",
                    "timestamp":"2026-07-27T00:00:00.000Z"
                })
            )),
            ProjectionEffect::None
        );
        assert_eq!(
            projection.direct_hook_progress_presentation("target-c", "PreToolUse"),
            None,
            "a completion alone does not fabricate a started HookProgress row"
        );
        assert_eq!(
            projection.ingest(raw(
                8,
                json!({
                    "type":"progress",
                    "data":{
                        "type":"hook_progress",
                        "hookEvent":"PreToolUse",
                        "hookName":"completed-before-progress",
                        "command":"run-completed-before-progress"
                    },
                    "toolUseID":"late-progress-envelope",
                    "parentToolUseID":"target-c",
                    "uuid":"late-hook-progress",
                    "timestamp":"2026-07-27T00:00:00.000Z"
                })
            )),
            ProjectionEffect::None
        );
        assert_eq!(
            projection.direct_hook_progress_presentation("target-c", "PreToolUse"),
            Some(DirectHookProgressPresentation {
                tool_use_id: "target-c".to_string(),
                hook_event: "PreToolUse".to_string(),
                in_progress_count: 1,
                resolved_count: 1,
            }),
            "retained resolution names are observed when matching progress arrives later"
        );
    }

    #[test]
    fn direct_hook_lookup_survives_raw_eviction_without_replay() {
        let mut projection = Projection {
            raw_retention_limit_override: Some(
                RAW_ENVELOPE_ALLOCATION_CHARGE_BYTES.saturating_add(1),
            ),
            ..Projection::default()
        };

        for (sequence, hook_name) in [(0, "first"), (1, "second")] {
            assert_eq!(
                projection.ingest(raw(
                    sequence,
                    json!({
                        "type":"progress",
                        "data":{
                            "type":"hook_progress",
                            "hookEvent":"SessionStart",
                            "hookName":hook_name,
                            "command":format!("run-{hook_name}")
                        },
                        "toolUseID":format!("hook-progress-{sequence}"),
                        "parentToolUseID":"retained-target",
                        "uuid":format!("hook-{sequence}"),
                        "timestamp":"2026-07-27T00:00:00.000Z"
                    })
                )),
                ProjectionEffect::None
            );
        }
        for (sequence, hook_name) in [(2, "first"), (3, "second")] {
            assert_eq!(
                projection.ingest(raw(
                    sequence,
                    json!({
                        "type":"attachment",
                        "attachment":{
                            "type":"hook_success",
                            "content":"",
                            "hookName":hook_name,
                            "toolUseID":"retained-target",
                            "hookEvent":"SessionStart"
                        },
                        "uuid":format!("hook-resolution-{sequence}"),
                        "timestamp":"2026-07-27T00:00:00.000Z"
                    })
                )),
                ProjectionEffect::None
            );
        }
        assert_eq!(
            projection.ingest(raw(4, json!({"type":"keep_alive"}))),
            ProjectionEffect::None
        );

        assert_eq!(projection.raw_envelopes().len(), 1);
        assert_eq!(
            projection.raw_envelopes()[0].value,
            json!({"type":"keep_alive"})
        );
        assert_eq!(projection.raw_envelope_count(), 5);
        assert_eq!(projection.raw_evicted_count(), 4);
        assert!(
            projection
                .items()
                .iter()
                .all(|item| item.key != "direct-hook-progress:retained-target:SessionStart"),
            "resolved transient row is gone independently of retained transcript state"
        );

        let raw_count_before_lookup = projection.raw_envelope_count();
        let first_lookup = projection
            .direct_hook_progress_presentation("retained-target", "SessionStart")
            .expect("retained hook state");
        let second_lookup = projection
            .direct_hook_progress_presentation("retained-target", "SessionStart")
            .expect("repeat retained hook state");
        assert_eq!(
            first_lookup,
            DirectHookProgressPresentation {
                tool_use_id: "retained-target".to_string(),
                hook_event: "SessionStart".to_string(),
                in_progress_count: 2,
                resolved_count: 2,
            }
        );
        assert_eq!(second_lookup, first_lookup);
        assert_eq!(
            projection.raw_envelope_count(),
            raw_count_before_lookup,
            "renderer lookup is a pure retained-state read, not raw-journal replay"
        );
    }

    #[test]
    fn init_and_result_are_control_records_not_transcript_items() {
        let init = json!({
            "type":"system",
            "subtype":"init",
            "apiKeySource":"none",
            "crab_code_version":"1.0.0",
            "cwd":"/workspace",
            "tools":[],
            "mcp_servers":[],
            "model":"model-from-backend",
            "permissionMode":"default",
            "slash_commands":[],
            "output_style":"default",
            "skills":[],
            "plugins":[],
            "session_id":"session-1",
            "uuid":"init-1"
        });
        let result = json!({
            "type":"result",
            "subtype":"success",
            "is_error":false,
            "duration_ms":100,
            "duration_api_ms":80,
            "num_turns":1,
            "result":"done",
            "stop_reason":null,
            "total_cost_usd":0,
            "usage":{"input_tokens":1},
            "modelUsage":{},
            "permission_denials":[],
            "session_id":"session-1",
            "uuid":"result-1"
        });
        let mut projection = Projection::default();
        assert!(matches!(
            projection.ingest(raw(0, init.clone())),
            ProjectionEffect::Initialized { .. }
        ));
        assert_eq!(
            projection.ingest(raw(1, result.clone())),
            ProjectionEffect::TurnCompleted {
                subtype: "success".to_string(),
                is_error: false,
                raw_sequence: 1
            }
        );
        assert!(projection.items().is_empty());
        assert_eq!(projection.raw_envelopes()[0].value, init);
        assert_eq!(projection.raw_envelopes()[1].value, result);
    }

    #[test]
    fn auto_permission_mode_is_accepted_on_init_and_status_updates() {
        let init = |permission_mode: &str, session_id: &str| {
            json!({
                "type":"system",
                "subtype":"init",
                "apiKeySource":"none",
                "crab_code_version":"1.0.0",
                "cwd":"/workspace",
                "tools":[],
                "mcp_servers":[],
                "model":"model-from-backend",
                "permissionMode":permission_mode,
                "slash_commands":[],
                "output_style":"default",
                "skills":[],
                "plugins":[],
                "session_id":session_id,
                "uuid":format!("init-{session_id}")
            })
        };

        let mut init_projection = Projection::default();
        assert!(matches!(
            init_projection.ingest(raw(0, init("auto", "auto-init"))),
            ProjectionEffect::Initialized {
                permission_mode: Some(ref mode),
                ..
            } if mode == "auto"
        ));
        assert_eq!(init_projection.permission_mode(), Some("auto"));

        let mut status_projection = Projection::default();
        assert!(matches!(
            status_projection.ingest(raw(0, init("default", "auto-status"))),
            ProjectionEffect::Initialized { .. }
        ));
        assert_eq!(
            status_projection.ingest(raw(
                1,
                json!({
                    "type":"system",
                    "subtype":"status",
                    "status":null,
                    "permissionMode":"auto",
                    "session_id":"auto-status",
                    "uuid":"status-auto"
                })
            )),
            ProjectionEffect::None
        );
        assert_eq!(status_projection.permission_mode(), Some("auto"));
    }

    #[test]
    fn init_accepts_only_the_existing_backend_api_key_source_domain() {
        let init = |api_key_source: &str| {
            json!({
                "type":"system",
                "subtype":"init",
                "apiKeySource":api_key_source,
                "crab_code_version":"1.0.0",
                "cwd":"/workspace",
                "tools":[],
                "mcp_servers":[],
                "model":"model-from-backend",
                "permissionMode":"default",
                "slash_commands":[],
                "output_style":"default",
                "skills":[],
                "plugins":[],
                "session_id":"session-1",
                "uuid":"init-1"
            })
        };

        for source in [
            "ACOSMI_API_KEY",
            "apiKeyHelper",
            "/login managed key",
            "none",
        ] {
            let mut projection = Projection::default();
            assert!(
                matches!(
                    projection.ingest(raw(0, init(source))),
                    ProjectionEffect::Initialized { .. }
                ),
                "fixed backend ApiKeySource `{source}` must remain renderable"
            );
        }

        let mut projection = Projection::default();
        assert!(matches!(
            projection.ingest(raw(0, init("user"))),
            ProjectionEffect::FailClosed { sequence: 0, ref reason }
                if reason.contains("unsupported apiKeySource `user`")
        ));
    }

    #[test]
    fn stream_deltas_reconcile_with_final_assistant_without_duplicate() {
        let mut projection = Projection::default();
        for (sequence, value) in [
            (
                0,
                json!({
                    "type": "stream_event",
                    "uuid": "stream",
                    "session_id": "s",
                    "parent_tool_use_id": null,
                    "event": {"type": "message_start", "message": {"id": "m"}}
                }),
            ),
            (
                1,
                json!({
                    "type": "stream_event",
                    "uuid": "stream",
                    "session_id": "s",
                    "parent_tool_use_id": null,
                    "event": {
                        "type": "content_block_start",
                        "index": 0,
                        "content_block": {"type": "text", "text": ""}
                    }
                }),
            ),
            (
                2,
                json!({
                    "type": "stream_event",
                    "uuid": "stream",
                    "session_id": "s",
                    "parent_tool_use_id": null,
                    "event": {
                        "type": "content_block_delta",
                        "index": 0,
                        "delta": {"type": "text_delta", "text": "hello"}
                    }
                }),
            ),
            (
                3,
                json!({
                    "type": "stream_event",
                    "uuid": "stream",
                    "session_id": "s",
                    "parent_tool_use_id": null,
                    "event": {
                        "type": "content_block_delta",
                        "index": 0,
                        "delta": {"type": "text_delta", "text": " world"}
                    }
                }),
            ),
            (
                4,
                json!({
                    "type": "assistant",
                    "session_id": "s",
                    "uuid": "u",
                    "parent_tool_use_id": null,
                    "message": {
                        "id": "m",
                        "content": [{"type": "text", "text": "hello world"}]
                    },
                    "future_assistant_metadata": {"preserved": true}
                }),
            ),
        ] {
            assert_eq!(
                projection.ingest(raw(sequence, value)),
                ProjectionEffect::None
            );
        }
        let assistant = projection
            .items()
            .iter()
            .filter(|item| item.kind == ProjectedKind::Assistant)
            .collect::<Vec<_>>();
        assert_eq!(assistant.len(), 1);
        assert_eq!(assistant[0].text, "hello world");
        assert!(!assistant[0].streaming);
        assert_eq!(assistant[0].raw_sequences, vec![1, 2, 3, 4]);
        assert_eq!(
            projection.raw_envelopes()[4]
                .value
                .pointer("/future_assistant_metadata/preserved"),
            Some(&Value::Bool(true))
        );
    }

    #[test]
    fn visible_output_epoch_resets_per_turn_and_ignores_diagnostic_only_replay() {
        let mut projection = Projection::default();
        assert!(!projection.output_since_last_finish());

        let start = |sequence| {
            raw(
                sequence,
                json!({
                    "type":"stream_event",
                    "uuid":format!("stream-{sequence}"),
                    "session_id":"s",
                    "parent_tool_use_id":null,
                    "event":{
                        "type":"content_block_start",
                        "index":0,
                        "content_block":{"type":"text","text":""}
                    }
                }),
            )
        };
        projection.ingest(raw(
            0,
            json!({
                "type":"stream_event",
                "uuid":"message-start",
                "session_id":"s",
                "parent_tool_use_id":null,
                "event":{"type":"message_start","message":{"id":"m"}}
            }),
        ));
        projection.ingest(start(1));
        assert!(projection.output_since_last_finish());
        projection.finish_output_epoch();
        assert!(!projection.output_since_last_finish());

        projection.ingest(start(2));
        assert!(
            !projection.output_since_last_finish(),
            "a replay that only appends diagnostic provenance is not visible output"
        );
        projection.ingest(raw(
            3,
            json!({
                "type":"stream_event",
                "uuid":"stream-3",
                "session_id":"s",
                "parent_tool_use_id":null,
                "event":{
                    "type":"content_block_delta",
                    "index":0,
                    "delta":{"type":"text_delta","text":"visible"}
                }
            }),
        ));
        assert!(projection.output_since_last_finish());
    }

    #[test]
    fn stopped_source_index_reuse_opens_a_new_renderer_generation() {
        let mut projection = Projection::default();
        let events = [
            json!({"type":"message_start","message":{"id":"m"}}),
            json!({"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}),
            json!({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"first"}}),
            json!({"type":"content_block_stop","index":0}),
            json!({"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}),
            json!({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"second"}}),
            json!({"type":"content_block_stop","index":0}),
            json!({"type":"message_stop"}),
        ];
        for (sequence, event) in events.into_iter().enumerate() {
            assert_eq!(
                projection.ingest(raw(
                    sequence as u64,
                    json!({
                        "type":"stream_event","uuid":format!("stream-{sequence}"),
                        "session_id":"s","parent_tool_use_id":null,"event":event
                    }),
                )),
                ProjectionEffect::None
            );
        }

        let assistant = projection
            .items()
            .iter()
            .filter(|item| item.kind == ProjectedKind::Assistant)
            .collect::<Vec<_>>();
        assert_eq!(assistant.len(), 2);
        assert_eq!(assistant[0].key, "assistant:m:0");
        assert_eq!(assistant[0].text, "first");
        assert_eq!(assistant[1].key, "assistant:m:0:g1");
        assert_eq!(assistant[1].text, "second");
        assert!(assistant.iter().all(|item| !item.streaming));
        assert!(projection.compatibility_diagnostics().iter().any(|entry| {
            entry.kind == ProjectionCompatibilityKind::StreamIndexReuse
                && entry.source_index == Some(0)
                && entry.generation == Some(1)
        }));
    }

    #[test]
    fn exact_active_start_replay_is_idempotent() {
        let mut projection = Projection::default();
        let message_start = json!({
            "type":"stream_event","uuid":"start","session_id":"s","parent_tool_use_id":null,
            "event":{"type":"message_start","message":{"id":"m"}}
        });
        let block_start = json!({
            "type":"stream_event","uuid":"block","session_id":"s","parent_tool_use_id":null,
            "event":{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}
        });
        assert_eq!(
            projection.ingest(raw(0, message_start)),
            ProjectionEffect::None
        );
        assert_eq!(
            projection.ingest(raw(1, block_start.clone())),
            ProjectionEffect::None
        );
        assert_eq!(
            projection.ingest(raw(2, block_start)),
            ProjectionEffect::None
        );

        assert_eq!(projection.items().len(), 1);
        assert_eq!(projection.items()[0].key, "assistant:m:0");
        assert_eq!(projection.items()[0].raw_sequences, vec![1, 2]);
        assert!(projection.compatibility_diagnostics().iter().any(|entry| {
            entry.kind == ProjectionCompatibilityKind::StreamReplay
                && entry.source_index == Some(0)
                && entry.generation == Some(0)
        }));
    }

    #[test]
    fn conflicting_active_start_is_isolated_without_stopping_backend() {
        let mut projection = Projection::default();
        for (sequence, event) in [
            json!({"type":"message_start","message":{"id":"m"}}),
            json!({"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}),
            json!({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"answer"}}),
            json!({"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}),
            json!({"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"reason"}}),
        ]
        .into_iter()
        .enumerate()
        {
            assert_eq!(
                projection.ingest(raw(
                    sequence as u64,
                    json!({
                        "type":"stream_event","uuid":format!("stream-{sequence}"),
                        "session_id":"s","parent_tool_use_id":null,"event":event
                    }),
                )),
                ProjectionEffect::None
            );
        }

        assert!(projection.items().iter().any(|item| {
            item.key == "assistant:m:0" && item.text == "answer" && !item.streaming
        }));
        assert!(projection.items().iter().any(|item| {
            item.key == "assistant:m:0:g1"
                && item.kind == ProjectedKind::Thinking
                && item.text == "reason"
                && item.streaming
        }));
        assert!(projection.items().iter().any(|item| {
            item.title == "Renderer compatibility" && item.text.contains("overlapped active")
        }));
        assert!(projection.compatibility_diagnostics().iter().any(|entry| {
            entry.kind == ProjectionCompatibilityKind::StreamOverlap && entry.generation == Some(0)
        }));
    }

    #[test]
    fn delta_assembled_stream_starts_ignore_nonempty_seed_values() {
        let mut projection = Projection::default();
        assert_eq!(
            projection.ingest(raw(
                0,
                json!({
                    "type": "stream_event",
                    "uuid": "stream",
                    "session_id": "s",
                    "parent_tool_use_id": null,
                    "event": {
                        "type": "message_start",
                        "message": {
                            "id": "m",
                            "content": [{"type": "text", "text": "must not seed projection"}]
                        }
                    }
                })
            )),
            ProjectionEffect::None
        );
        assert!(projection.items().is_empty());

        for (sequence, value) in [
            (
                1,
                json!({
                    "type":"stream_event","uuid":"stream","session_id":"s","parent_tool_use_id":null,
                    "event":{"type":"content_block_start","index":0,
                        "content_block":{"type":"text","text":"hello"}}
                }),
            ),
            (
                2,
                json!({
                    "type":"stream_event","uuid":"stream","session_id":"s","parent_tool_use_id":null,
                    "event":{"type":"content_block_delta","index":0,
                        "delta":{"type":"text_delta","text":"hello"}}
                }),
            ),
            (
                3,
                json!({
                    "type":"assistant","uuid":"text-final","session_id":"s",
                    "parent_tool_use_id":null,
                    "message":{"id":"m","content":[{"type":"text","text":"hello"}]}
                }),
            ),
            (
                4,
                json!({
                    "type":"stream_event","uuid":"stream","session_id":"s","parent_tool_use_id":null,
                    "event":{"type":"content_block_stop","index":0}
                }),
            ),
            (
                5,
                json!({
                    "type":"stream_event","uuid":"stream","session_id":"s","parent_tool_use_id":null,
                    "event":{"type":"content_block_start","index":1,
                        "content_block":{
                            "type":"thinking","thinking":"reason","signature":"start-signature"
                        }}
                }),
            ),
            (
                6,
                json!({
                    "type":"stream_event","uuid":"stream","session_id":"s","parent_tool_use_id":null,
                    "event":{"type":"content_block_delta","index":1,
                        "delta":{"type":"thinking_delta","thinking":"reason"}}
                }),
            ),
            (
                7,
                json!({
                    "type":"stream_event","uuid":"stream","session_id":"s","parent_tool_use_id":null,
                    "event":{"type":"content_block_delta","index":1,
                        "delta":{"type":"signature_delta","signature":"delta-signature"}}
                }),
            ),
            (
                8,
                json!({
                    "type":"assistant","uuid":"thinking-final","session_id":"s",
                    "parent_tool_use_id":null,
                    "message":{"id":"m","content":[{
                        "type":"thinking","thinking":"reason","signature":"complete-signature"
                    }]}
                }),
            ),
            (
                9,
                json!({
                    "type":"stream_event","uuid":"stream","session_id":"s","parent_tool_use_id":null,
                    "event":{"type":"content_block_stop","index":1}
                }),
            ),
            (
                10,
                json!({
                    "type":"stream_event","uuid":"stream","session_id":"s","parent_tool_use_id":null,
                    "event":{"type":"content_block_start","index":2,
                        "content_block":{
                            "type":"tool_use","id":"tool","name":"Bash",
                            "input":{"command":"pwd"}
                        }}
                }),
            ),
            (
                11,
                json!({
                    "type":"stream_event","uuid":"stream","session_id":"s","parent_tool_use_id":null,
                    "event":{"type":"content_block_delta","index":2,
                        "delta":{"type":"input_json_delta",
                            "partial_json":"{\"command\":\"pwd\"}"}}
                }),
            ),
            (
                12,
                json!({
                    "type":"assistant","uuid":"tool-final","session_id":"s",
                    "parent_tool_use_id":null,
                    "message":{"id":"m","content":[{
                        "type":"tool_use","id":"tool","name":"Bash",
                        "input":{"command":"pwd"}
                    }]}
                }),
            ),
            (
                13,
                json!({
                    "type":"stream_event","uuid":"stream","session_id":"s","parent_tool_use_id":null,
                    "event":{"type":"content_block_stop","index":2}
                }),
            ),
        ] {
            assert_eq!(
                projection.ingest(raw(sequence, value)),
                ProjectionEffect::None
            );
            if sequence == 1 {
                assert_eq!(projection.items()[0].text, "");
            }
            if sequence == 2 {
                assert_eq!(projection.items()[0].text, "hello");
            }
            if sequence == 5 {
                let thinking = projection.items()[1]
                    .presentation
                    .thinking
                    .as_ref()
                    .expect("stream thinking presentation");
                assert_eq!(projection.items()[1].text, "");
                assert_eq!(thinking.content, "");
                assert_eq!(thinking.signature.as_deref(), Some(""));
            }
            if sequence == 6 {
                assert_eq!(projection.items()[1].text, "reason");
                assert_eq!(
                    projection.items()[1]
                        .presentation
                        .thinking
                        .as_ref()
                        .expect("stream thinking presentation")
                        .content,
                    "reason"
                );
            }
            if sequence == 10 {
                let tool = projection.items()[2]
                    .presentation
                    .tool
                    .as_ref()
                    .expect("stream tool presentation");
                assert_eq!(projection.items()[2].text, "");
                assert_eq!(tool.input, None);
                assert_eq!(tool.partial_input_json.as_deref(), Some(""));
            }
            if sequence == 11 {
                let tool = projection.items()[2]
                    .presentation
                    .tool
                    .as_ref()
                    .expect("stream tool presentation");
                assert_eq!(projection.items()[2].text, r#"{"command":"pwd"}"#);
                assert_eq!(
                    tool.partial_input_json.as_deref(),
                    Some(r#"{"command":"pwd"}"#)
                );
            }
        }

        assert_eq!(projection.items().len(), 3);
        assert_eq!(projection.items()[0].key, "assistant:m:0");
        assert_eq!(projection.items()[0].text, "hello");
        assert_eq!(projection.items()[1].key, "assistant:m:1");
        assert_eq!(projection.items()[1].text, "reason");
        assert_eq!(
            projection.items()[1]
                .presentation
                .thinking
                .as_ref()
                .expect("completed thinking presentation")
                .signature
                .as_deref(),
            Some("complete-signature")
        );
        assert_eq!(projection.items()[2].key, "assistant:m:2");
        assert_eq!(
            projection.items()[2]
                .presentation
                .tool
                .as_ref()
                .expect("completed tool presentation")
                .input,
            Some(json!({"command":"pwd"}))
        );
    }

    #[test]
    fn one_block_final_envelopes_reconcile_to_their_actual_stream_indices() {
        let mut projection = Projection::default();
        for (sequence, value) in [
            (
                0,
                json!({
                    "type":"stream_event","uuid":"stream","session_id":"s","parent_tool_use_id":null,
                    "event":{"type":"message_start","message":{"id":"m"}}
                }),
            ),
            (
                1,
                json!({
                    "type":"stream_event","uuid":"stream","session_id":"s","parent_tool_use_id":null,
                    "event":{"type":"content_block_start","index":0,
                        "content_block":{"type":"text","text":""}}
                }),
            ),
            (
                2,
                json!({
                    "type":"stream_event","uuid":"stream","session_id":"s","parent_tool_use_id":null,
                    "event":{"type":"content_block_delta","index":0,
                        "delta":{"type":"text_delta","text":"first"}}
                }),
            ),
            (
                3,
                json!({
                    "type":"assistant","uuid":"final-0","session_id":"s",
                    "parent_tool_use_id":null,
                    "message":{"id":"m","content":[{"type":"text","text":"first"}]}
                }),
            ),
            (
                4,
                json!({
                    "type":"stream_event","uuid":"stream","session_id":"s","parent_tool_use_id":null,
                    "event":{"type":"content_block_stop","index":0}
                }),
            ),
            (
                5,
                json!({
                    "type":"stream_event","uuid":"stream","session_id":"s","parent_tool_use_id":null,
                    "event":{"type":"content_block_start","index":1,
                        "content_block":{"type":"tool_use","id":"tool","name":"Bash","input":{}}}
                }),
            ),
            (
                6,
                json!({
                    "type":"stream_event","uuid":"stream","session_id":"s","parent_tool_use_id":null,
                    "event":{"type":"content_block_delta","index":1,
                        "delta":{"type":"input_json_delta",
                            "partial_json":"{\"command\":\"pwd\"}"}}
                }),
            ),
            (
                7,
                json!({
                    "type":"assistant","uuid":"final-1","session_id":"s",
                    "parent_tool_use_id":null,
                    "message":{"id":"m","content":[{
                        "type":"tool_use","id":"tool","name":"Bash","input":{"command":"pwd"}
                    }]}
                }),
            ),
            (
                8,
                json!({
                    "type":"stream_event","uuid":"stream","session_id":"s","parent_tool_use_id":null,
                    "event":{"type":"content_block_stop","index":1}
                }),
            ),
            (
                9,
                json!({
                    "type":"stream_event","uuid":"stream","session_id":"s","parent_tool_use_id":null,
                    "event":{"type":"message_stop"}
                }),
            ),
        ] {
            assert_eq!(
                projection.ingest(raw(sequence, value)),
                ProjectionEffect::None
            );
        }

        let message_items = projection
            .items()
            .iter()
            .filter(|item| item.key.starts_with("assistant:m:"))
            .collect::<Vec<_>>();
        assert_eq!(message_items.len(), 2);
        assert_eq!(message_items[0].key, "assistant:m:0");
        assert_eq!(message_items[0].kind, ProjectedKind::Assistant);
        assert_eq!(message_items[0].text, "first");
        assert_eq!(message_items[1].key, "assistant:m:1");
        assert_eq!(message_items[1].kind, ProjectedKind::ToolUse);
        assert_eq!(
            message_items[1]
                .presentation
                .tool
                .as_ref()
                .expect("completed tool presentation")
                .input,
            Some(json!({"command":"pwd"}))
        );
    }

    #[test]
    fn repeated_one_block_final_envelopes_keep_same_type_fifo_mapping_stable() {
        let mut projection = Projection::default();
        for (sequence, value) in [
            (
                0,
                json!({
                    "type":"stream_event","uuid":"stream","session_id":"s","parent_tool_use_id":null,
                    "event":{"type":"message_start","message":{"id":"m"}}
                }),
            ),
            (
                1,
                json!({
                    "type":"stream_event","uuid":"stream","session_id":"s","parent_tool_use_id":null,
                    "event":{"type":"content_block_start","index":0,
                        "content_block":{"type":"text","text":""}}
                }),
            ),
            (
                2,
                json!({
                    "type":"stream_event","uuid":"stream","session_id":"s","parent_tool_use_id":null,
                    "event":{"type":"content_block_delta","index":0,
                        "delta":{"type":"text_delta","text":"first"}}
                }),
            ),
            (
                3,
                json!({
                    "type":"assistant","uuid":"final-0","session_id":"s",
                    "parent_tool_use_id":null,
                    "message":{"id":"m","content":[{"type":"text","text":"first"}]}
                }),
            ),
            (
                4,
                json!({
                    "type":"assistant","uuid":"final-0","session_id":"s",
                    "parent_tool_use_id":null,
                    "message":{"id":"m","content":[{"type":"text","text":"first"}]}
                }),
            ),
            (
                5,
                json!({
                    "type":"stream_event","uuid":"stream","session_id":"s","parent_tool_use_id":null,
                    "event":{"type":"content_block_stop","index":0}
                }),
            ),
            (
                6,
                json!({
                    "type":"stream_event","uuid":"stream","session_id":"s","parent_tool_use_id":null,
                    "event":{"type":"content_block_start","index":1,
                        "content_block":{"type":"text","text":""}}
                }),
            ),
            (
                7,
                json!({
                    "type":"stream_event","uuid":"stream","session_id":"s","parent_tool_use_id":null,
                    "event":{"type":"content_block_delta","index":1,
                        "delta":{"type":"text_delta","text":"second"}}
                }),
            ),
            (
                8,
                json!({
                    "type":"assistant","uuid":"final-1","session_id":"s",
                    "parent_tool_use_id":null,
                    "message":{"id":"m","content":[{"type":"text","text":"second"}]}
                }),
            ),
            (
                9,
                json!({
                    "type":"assistant","uuid":"final-1","session_id":"s",
                    "parent_tool_use_id":null,
                    "message":{"id":"m","content":[{"type":"text","text":"second"}]}
                }),
            ),
            (
                10,
                json!({
                    "type":"stream_event","uuid":"stream","session_id":"s","parent_tool_use_id":null,
                    "event":{"type":"content_block_stop","index":1}
                }),
            ),
        ] {
            assert_eq!(
                projection.ingest(raw(sequence, value)),
                ProjectionEffect::None
            );
        }

        let first = projection
            .items()
            .iter()
            .find(|item| item.key == "assistant:m:0")
            .expect("first text block");
        let second = projection
            .items()
            .iter()
            .find(|item| item.key == "assistant:m:1")
            .expect("second text block");
        assert_eq!(first.text, "first");
        assert_eq!(first.raw_sequences, vec![1, 2, 3, 4, 5]);
        assert_eq!(second.text, "second");
        assert_eq!(second.raw_sequences, vec![6, 7, 8, 9, 10]);
        assert_eq!(
            projection
                .items()
                .iter()
                .filter(|item| item.key.starts_with("assistant:m:"))
                .count(),
            2
        );
    }

    #[test]
    fn non_stream_multi_block_assistant_keeps_envelope_local_indices() {
        let mut projection = Projection::default();
        assert_eq!(
            projection.ingest(raw(
                0,
                json!({
                    "type":"assistant","uuid":"standalone","session_id":"s",
                    "parent_tool_use_id":null,
                    "message":{"id":"standalone-message","content":[
                        {"type":"text","text":"first"},
                        {"type":"text","text":"second"}
                    ]}
                })
            )),
            ProjectionEffect::None
        );
        assert_eq!(projection.items().len(), 2);
        assert_eq!(projection.items()[0].key, "assistant:standalone-message:0");
        assert_eq!(projection.items()[0].text, "first");
        assert_eq!(projection.items()[1].key, "assistant:standalone-message:1");
        assert_eq!(projection.items()[1].text, "second");
    }

    #[test]
    fn source_declared_stream_ping_is_journaled_without_transcript_item() {
        let value = json!({
            "type": "stream_event",
            "uuid": "ping-1",
            "session_id": "s",
            "parent_tool_use_id": null,
            "event": {"type": "ping"}
        });
        let mut projection = Projection::default();
        assert_eq!(
            projection.ingest(raw(0, value.clone())),
            ProjectionEffect::None
        );
        assert_eq!(projection.raw_envelopes()[0].value, value);
        assert!(projection.items().is_empty());
    }

    #[test]
    fn typed_stream_sources_are_null_rendered_without_disturbing_nested_agent_state() {
        let mut projection = Projection::default();
        assert_eq!(
            projection.ingest(raw(
                0,
                json!({
                    "type":"progress",
                    "data":{
                        "type":"agent_progress",
                        "prompt":"research the repository",
                        "agentId":"agent-1",
                        "message":{
                            "type":"user",
                            "uuid":"nested-user",
                            "timestamp":"2026-07-27T00:00:00.000Z",
                            "message":{"role":"user","content":"research the repository"}
                        }
                    },
                    "toolUseID":"agent-progress-1",
                    "parentToolUseID":"agent-tool-1",
                    "uuid":"agent-progress-1",
                    "timestamp":"2026-07-27T00:00:00.000Z"
                })
            )),
            ProjectionEffect::None
        );
        let nested_items = projection.items().to_vec();

        let direct_sources = json!({
            "type":"stream_event",
            "uuid":"direct-sources",
            "event":{
                "type":"sources",
                "sources":[
                    {
                        "title":"Primary source",
                        "url":"https://example.invalid/primary",
                        "snippet":"Relevant excerpt"
                    },
                    {
                        "title":"Secondary source",
                        "url":"https://example.invalid/secondary"
                    }
                ],
                "session_id":"gateway-session"
            }
        });
        assert_eq!(
            projection.ingest(raw(1, direct_sources.clone())),
            ProjectionEffect::None
        );
        assert_eq!(projection.items(), nested_items.as_slice());
        assert_eq!(projection.raw_envelopes()[1].value, direct_sources);
        assert_eq!(
            projection.direct_stream_activity(),
            &DirectStreamActivityState {
                phase: DirectStreamActivityPhase::Responding,
                ttft_ms: None,
                raw_sequence: Some(1),
                turn_generation: 0,
                request_started_sequence: None,
            },
            "the fixed renderer default branch advances sources to responding without a transcript row"
        );

        let mut sdk_projection = Projection::default();
        let sdk_sources = json!({
            "type":"stream_event",
            "uuid":"sdk-sources",
            "session_id":"session",
            "parent_tool_use_id":"agent-tool-1",
            "event":{
                "type":"sources",
                "sources":[{
                    "title":"Agent source",
                    "url":"https://example.invalid/agent"
                }]
            }
        });
        assert_eq!(
            sdk_projection.ingest(raw(0, sdk_sources.clone())),
            ProjectionEffect::None
        );
        assert!(sdk_projection.items().is_empty());
        assert_eq!(sdk_projection.raw_envelopes()[0].value, sdk_sources);
    }

    #[test]
    fn known_raw_stream_events_and_additive_future_events_are_compatible() {
        assert_eq!(
            KNOWN_RAW_STREAM_EVENT_TYPES,
            [
                "message_start",
                "message_delta",
                "message_stop",
                "content_block_start",
                "content_block_delta",
                "content_block_stop",
                "error",
                "ping",
                "sources",
            ]
        );

        let frames = [
            json!({"type":"message_start","message":{"id":"m"}}),
            json!({
                "type":"content_block_start","index":0,
                "content_block":{"type":"text","text":""}
            }),
            json!({
                "type":"content_block_delta","index":0,
                "delta":{"type":"text_delta","text":"answer"}
            }),
            json!({"type":"content_block_stop","index":0}),
            json!({"type":"message_delta","delta":{},"usage":{}}),
            json!({"type":"ping"}),
            json!({
                "type":"sources",
                "sources":[{"title":"Source","url":"https://example.invalid"}]
            }),
            json!({"type":"message_stop"}),
        ];
        let mut observed = frames
            .iter()
            .map(|event| event.get("type").and_then(Value::as_str).unwrap())
            .collect::<HashSet<_>>();
        observed.insert("error");
        assert_eq!(
            observed,
            KNOWN_RAW_STREAM_EVENT_TYPES
                .iter()
                .copied()
                .collect::<HashSet<_>>()
        );

        let mut projection = Projection::default();
        for (sequence, event) in frames.into_iter().enumerate() {
            assert_eq!(
                projection.ingest(raw(
                    sequence as u64,
                    json!({
                        "type":"stream_event",
                        "uuid":format!("stream-{sequence}"),
                        "event":event
                    }),
                )),
                ProjectionEffect::None
            );
        }
        assert_eq!(projection.raw_envelopes().len(), 8);
        assert_eq!(projection.items().len(), 1);
        assert_eq!(projection.items()[0].text, "answer");

        let mut future_projection = Projection::default();
        let effect = future_projection.ingest(raw(
            8,
            json!({
                "type":"stream_event",
                "uuid":"future",
                "event":{"type":"future_sdk_event"}
            }),
        ));
        assert_eq!(
            effect,
            ProjectionEffect::CompatibilityFault {
                sequence: 8,
                event_type: "future_sdk_event".to_string(),
                code: "unknown_stream_event".to_string(),
            }
        );
        assert!(future_projection.items().is_empty());
        assert!(
            future_projection
                .compatibility_diagnostics()
                .iter()
                .any(|entry| {
                    entry.kind == ProjectionCompatibilityKind::UnknownPresentation
                        && entry.reason.contains("future_sdk_event")
                })
        );

        let missing_discriminator = Projection::default().ingest(raw(
            9,
            json!({
                "type":"stream_event",
                "uuid":"missing-type",
                "event":{
                    "sources":[{"title":"Source","url":"https://example.invalid"}]
                }
            }),
        ));
        assert!(matches!(
            missing_discriminator,
            ProjectionEffect::AbortTurn { code, reason, .. }
                if code == "stream_event_type_missing"
                    && reason.contains("stream_event omitted string event.type")
        ));
    }

    #[test]
    fn in_stream_error_is_visible_and_finalizes_the_active_generation() {
        let frames = [
            json!({"type":"message_start","message":{"id":"m"}}),
            json!({
                "type":"content_block_start","index":0,
                "content_block":{"type":"text","text":""}
            }),
            json!({
                "type":"content_block_delta","index":0,
                "delta":{"type":"text_delta","text":"partial answer"}
            }),
            json!({
                "type":"error",
                "error":{"type":"overloaded_error","message":"gateway overloaded"},
                "errorCode":"NEXUS_OVERLOADED"
            }),
        ];
        let mut projection = Projection::default();
        for (sequence, event) in frames.into_iter().enumerate() {
            let effect = projection.ingest(raw(
                sequence as u64,
                json!({
                    "type":"stream_event",
                    "uuid":format!("stream-{sequence}"),
                    "event":event
                }),
            ));
            if sequence == 3 {
                assert_eq!(
                    effect,
                    ProjectionEffect::AbortTurn {
                        sequence: 3,
                        code: "upstream_stream_error".to_string(),
                        reason: "gateway overloaded".to_string(),
                    }
                );
            } else {
                assert_eq!(effect, ProjectionEffect::None);
            }
        }

        assert_eq!(projection.items().len(), 2);
        assert_eq!(projection.items()[0].text, "partial answer");
        assert!(!projection.items()[0].streaming);
        let error = &projection.items()[1];
        assert_eq!(error.kind, ProjectedKind::Error);
        assert!(!error.streaming);
        assert!(matches!(
            error.presentation.stream_error.as_ref(),
            Some(StreamErrorPresentation {
                error_type: Some(error_type),
                error_code: Some(error_code),
                message,
            }) if error_type == "overloaded_error"
                && error_code == "NEXUS_OVERLOADED"
                && message == "gateway overloaded"
        ));
        assert!(projection.stream_blocks.is_empty());
        assert!(projection.active_message_by_context.is_empty());
        assert_eq!(
            projection.direct_stream_activity().phase,
            DirectStreamActivityPhase::Idle
        );
    }

    #[test]
    fn typed_sources_preserve_active_nested_agent_stream_state() {
        let frames = [
            json!({"type":"message_start","message":{"id":"nested-message"}}),
            json!({
                "type":"content_block_start","index":0,
                "content_block":{"type":"text","text":""}
            }),
            json!({
                "type":"content_block_delta","index":0,
                "delta":{"type":"text_delta","text":"before "}
            }),
            json!({
                "type":"sources",
                "sources":[{
                    "title":"Nested source",
                    "url":"https://example.invalid/nested",
                    "snippet":"typed provenance"
                }],
                "session_id":"gateway-session"
            }),
            json!({
                "type":"content_block_delta","index":0,
                "delta":{"type":"text_delta","text":"after"}
            }),
            json!({"type":"content_block_stop","index":0}),
            json!({"type":"message_stop"}),
        ];
        let mut projection = Projection::default();
        for (sequence, event) in frames.into_iter().enumerate() {
            assert_eq!(
                projection.ingest(raw(
                    sequence as u64,
                    json!({
                        "type":"stream_event",
                        "uuid":format!("nested-{sequence}"),
                        "session_id":"session",
                        "parent_tool_use_id":"agent-tool-use",
                        "event":event
                    }),
                )),
                ProjectionEffect::None
            );
        }

        assert_eq!(projection.items().len(), 1);
        assert_eq!(projection.items()[0].text, "before after");
        assert!(!projection.items()[0].streaming);
        assert_eq!(projection.raw_envelopes().len(), 7);
        assert_eq!(
            projection.direct_stream_activity(),
            &DirectStreamActivityState::default(),
            "nested SDK sources must not mutate the direct renderer spinner"
        );
    }

    #[test]
    fn empty_stream_sources_are_inert_and_malformed_sources_are_recoverable() {
        let mut empty_projection = Projection::default();
        let incident_fixture =
            include_str!("../../../tests/fixtures/renderer/empty-sources-sequence-6034.jsonl")
                .trim_end();
        assert_eq!(incident_fixture.as_bytes().len(), 63);
        let empty: Value = serde_json::from_str(incident_fixture).expect("incident fixture parses");
        assert_eq!(
            empty_projection.ingest(raw(6034, empty.clone())),
            ProjectionEffect::None
        );
        assert_eq!(empty_projection.raw_envelopes()[0].value, empty);
        assert!(empty_projection.items().is_empty());
        assert_eq!(
            empty_projection.direct_stream_activity(),
            &DirectStreamActivityState::default()
        );
        assert!(empty_projection.compatibility_diagnostics().is_empty());

        for (sequence, event, expected_code) in [
            (0, json!({"type":"sources"}), "missing_sources"),
            (
                1,
                json!({"type":"sources","sources":{}}),
                "sources_not_array",
            ),
            (
                2,
                json!({"type":"sources","sources":["not-an-object"]}),
                "source_not_object",
            ),
            (
                3,
                json!({"type":"sources","sources":[{"url":"https://example.invalid"}]}),
                "source_title_invalid",
            ),
            (
                4,
                json!({"type":"sources","sources":[{"title":"Missing URL"}]}),
                "source_url_invalid",
            ),
            (
                5,
                json!({
                    "type":"sources",
                    "sources":[{
                        "title":"Invalid snippet",
                        "url":"https://example.invalid",
                        "snippet":7
                    }]
                }),
                "source_snippet_invalid",
            ),
            (
                6,
                json!({
                    "type":"sources",
                    "sources":[{"title":"Source","url":"https://example.invalid"}],
                    "session_id":7
                }),
                "session_id_invalid",
            ),
        ] {
            let mut projection = Projection::default();
            let effect = projection.ingest(raw(
                sequence,
                json!({"type":"stream_event","uuid":format!("sources-{sequence}"),"event":event}),
            ));
            assert_eq!(
                effect,
                ProjectionEffect::CompatibilityFault {
                    sequence,
                    event_type: "sources".to_string(),
                    code: expected_code.to_string(),
                },
                "malformed sources sequence {sequence} did not classify as `{expected_code}`"
            );
            assert!(projection.items().is_empty());
            assert!(projection.compatibility_diagnostics().iter().any(|entry| {
                entry.kind == ProjectionCompatibilityKind::MalformedPresentation
                    && entry.reason.contains(expected_code)
            }));
        }
    }

    #[test]
    fn direct_stream_activity_matches_the_fixed_spinner_and_ttft_lifecycle() {
        let mut projection = Projection::default();
        assert_eq!(
            projection.ingest(raw(0, json!({"type":"stream_request_start"}))),
            ProjectionEffect::StreamRequestStarted
        );
        assert_eq!(
            projection.direct_stream_activity(),
            &DirectStreamActivityState {
                phase: DirectStreamActivityPhase::Requesting,
                ttft_ms: None,
                raw_sequence: Some(0),
                turn_generation: 1,
                request_started_sequence: Some(0),
            }
        );

        assert_eq!(
            projection.ingest(raw(
                1,
                json!({
                    "type":"stream_event",
                    "ttftMs":12,
                    "event":{
                        "type":"message_start",
                        "message":{"id":"direct-stream-message","content":[]}
                    }
                })
            )),
            ProjectionEffect::None
        );
        assert_eq!(
            projection
                .direct_stream_activity()
                .ttft_ms
                .as_ref()
                .and_then(serde_json::Number::as_u64),
            Some(12)
        );
        assert_eq!(
            projection.direct_stream_activity().phase,
            DirectStreamActivityPhase::Requesting,
            "message_start emits metrics but does not change the fixed spinner mode"
        );

        assert_eq!(
            projection.ingest(raw(
                2,
                json!({
                    "type":"stream_event",
                    "event":{
                        "type":"content_block_start",
                        "index":0,
                        "content_block":{
                            "type":"thinking",
                            "thinking":"",
                            "signature":""
                        }
                    }
                })
            )),
            ProjectionEffect::None
        );
        assert_eq!(
            projection.direct_stream_activity().phase,
            DirectStreamActivityPhase::Thinking
        );

        assert_eq!(
            projection.ingest(raw(
                3,
                json!({"type":"stream_event","event":{"type":"message_delta"}})
            )),
            ProjectionEffect::None
        );
        assert_eq!(
            projection.direct_stream_activity().phase,
            DirectStreamActivityPhase::Responding
        );

        assert_eq!(
            projection.ingest(raw(
                4,
                json!({"type":"stream_event","event":{"type":"ping"}})
            )),
            ProjectionEffect::None
        );
        assert_eq!(
            projection.direct_stream_activity(),
            &DirectStreamActivityState {
                phase: DirectStreamActivityPhase::Responding,
                ttft_ms: Some(serde_json::Number::from(12)),
                raw_sequence: Some(4),
                turn_generation: 1,
                request_started_sequence: Some(0),
            },
            "the fixed default branch keeps ping response activity without a transcript row"
        );

        assert_eq!(
            projection.ingest(raw(
                5,
                json!({"type":"stream_event","event":{"type":"message_stop"}})
            )),
            ProjectionEffect::None
        );
        assert_eq!(
            projection.direct_stream_activity().phase,
            DirectStreamActivityPhase::ToolUse
        );
    }

    #[test]
    fn source_declared_extended_assistant_blocks_keep_typed_meaning() {
        let value = json!({
            "type": "assistant",
            "uuid": "assistant-extended",
            "session_id": "s",
            "parent_tool_use_id": null,
            "message": {
                "id": "m",
                "content": [
                    {
                        "type": "connector_text",
                        "text": "signature-bound fallback",
                        "connector_text": "visible connector text",
                        "signature": "signature"
                    },
                    {
                        "type": "advisor_tool_result",
                        "tool_use_id": "advisor-1",
                        "content": {
                            "type": "advisor_result",
                            "text": "verified advice"
                        }
                    },
                    {
                        "type": "compaction",
                        "content": null
                    }
                ]
            }
        });
        let mut projection = Projection::default();
        assert_eq!(
            projection.ingest(raw(0, value.clone())),
            ProjectionEffect::None
        );
        assert_eq!(projection.raw_envelopes()[0].value, value);
        assert_eq!(projection.items().len(), 2);
        assert_eq!(projection.items()[0].text, "visible connector text");
        assert_eq!(
            projection.items()[0].presentation.assistant_block,
            Some(AssistantBlockType::ConnectorText)
        );
        assert_eq!(projection.items()[1].text, "verified advice");
        assert_eq!(
            projection.items()[1].presentation.assistant_block,
            Some(AssistantBlockType::AdvisorToolResult)
        );
        assert_eq!(
            projection.items()[1].presentation.advisor,
            Some(AdvisorPresentation::Result(
                AdvisorResultPresentation::Feedback {
                    text: "verified advice".to_string()
                }
            ))
        );
        let advisor = projection.items()[1]
            .presentation
            .tool
            .as_ref()
            .expect("advisor tool-result metadata");
        assert_eq!(
            advisor.result,
            Some(json!({
                "type": "advisor_result",
                "text": "verified advice"
            }))
        );
        assert_eq!(advisor.is_error, Some(false));
    }

    #[test]
    fn final_advisor_use_and_feedback_keep_typed_input_and_resolution_state() {
        let mut projection = Projection::default();
        let frames = [
            json!({
                "type":"assistant","uuid":"advisor-use","session_id":"s","parent_tool_use_id":null,
                "message":{"id":"m-use","content":[{
                    "type":"server_tool_use","id":"advisor-1","name":"advisor",
                    "input":{"focus":"protocol fidelity"}
                }]}
            }),
            json!({
                "type":"user","uuid":"advisor-result","session_id":"s",
                "parent_tool_use_id":"advisor-1",
                "message":{"content":[{
                    "type":"advisor_tool_result","tool_use_id":"advisor-1",
                    "content":{"type":"advisor_result","text":"Keep the exact backend contract."}
                }]}
            }),
        ];
        for (sequence, frame) in frames.into_iter().enumerate() {
            assert_eq!(
                projection.ingest(raw(sequence as u64, frame)),
                ProjectionEffect::None
            );
        }

        assert_eq!(projection.items().len(), 2);
        assert_eq!(projection.items()[0].title, "Advising");
        assert_eq!(
            projection.items()[0].presentation.advisor,
            Some(AdvisorPresentation::Invocation {
                input: json!({"focus":"protocol fidelity"}),
                state: AdvisorInvocationState::Succeeded,
            })
        );
        assert_eq!(
            projection.items()[1].presentation.advisor,
            Some(AdvisorPresentation::Result(
                AdvisorResultPresentation::Feedback {
                    text: "Keep the exact backend contract.".to_string(),
                }
            ))
        );
    }

    #[test]
    fn stream_advisor_use_and_error_keep_exact_code_and_failed_state() {
        let mut projection = Projection::default();
        let frames = [
            json!({
                "type":"stream_event","uuid":"0","session_id":"s","parent_tool_use_id":null,
                "event":{"type":"message_start","message":{"id":"m"}}
            }),
            json!({
                "type":"stream_event","uuid":"1","session_id":"s","parent_tool_use_id":null,
                "event":{"type":"content_block_start","index":0,"content_block":{
                    "type":"server_tool_use","id":"advisor-1","name":"advisor",
                    "input":{"focus":"stream"}
                }}
            }),
            json!({
                "type":"stream_event","uuid":"2","session_id":"s","parent_tool_use_id":null,
                "event":{"type":"content_block_stop","index":0}
            }),
            json!({
                "type":"stream_event","uuid":"3","session_id":"s","parent_tool_use_id":null,
                "event":{"type":"content_block_start","index":1,"content_block":{
                    "type":"advisor_tool_result","tool_use_id":"advisor-1",
                    "content":{"type":"advisor_tool_result_error","error_code":"capacity_exhausted"}
                }}
            }),
            json!({
                "type":"stream_event","uuid":"4","session_id":"s","parent_tool_use_id":null,
                "event":{"type":"content_block_stop","index":1}
            }),
            json!({
                "type":"stream_event","uuid":"5","session_id":"s","parent_tool_use_id":null,
                "event":{"type":"message_stop"}
            }),
        ];
        for (sequence, frame) in frames.into_iter().enumerate() {
            assert_eq!(
                projection.ingest(raw(sequence as u64, frame)),
                ProjectionEffect::None
            );
        }

        assert_eq!(
            projection.items()[0].presentation.advisor,
            Some(AdvisorPresentation::Invocation {
                input: json!({"focus":"stream"}),
                state: AdvisorInvocationState::Failed,
            })
        );
        assert_eq!(
            projection.items()[1].presentation.advisor,
            Some(AdvisorPresentation::Result(
                AdvisorResultPresentation::Error {
                    error_code: "capacity_exhausted".to_string(),
                }
            ))
        );
        assert_eq!(
            projection.items()[1].text,
            "Advisor unavailable (capacity_exhausted)"
        );
    }

    #[test]
    fn source_declared_extended_stream_blocks_and_deltas_are_consumed() {
        let mut projection = Projection::default();
        let frames = [
            json!({
                "type":"stream_event","uuid":"0","session_id":"s","parent_tool_use_id":null,
                "event":{"type":"message_start","message":{"id":"m"}}
            }),
            json!({
                "type":"stream_event","uuid":"1","session_id":"s","parent_tool_use_id":null,
                "event":{"type":"content_block_start","index":0,
                    "content_block":{"type":"connector_text","text":"","connector_text":"","signature":""}}
            }),
            json!({
                "type":"stream_event","uuid":"2","session_id":"s","parent_tool_use_id":null,
                "event":{"type":"content_block_delta","index":0,
                    "delta":{"type":"connector_text_delta","connector_text":"visible"}}
            }),
            json!({
                "type":"stream_event","uuid":"3","session_id":"s","parent_tool_use_id":null,
                "event":{"type":"content_block_delta","index":0,
                    "delta":{"type":"citations_delta","citation":{"url":"https://example.test"}}}
            }),
            json!({
                "type":"stream_event","uuid":"4","session_id":"s","parent_tool_use_id":null,
                "event":{"type":"content_block_stop","index":0}
            }),
            json!({
                "type":"stream_event","uuid":"5","session_id":"s","parent_tool_use_id":null,
                "event":{"type":"content_block_start","index":1,
                    "content_block":{"type":"advisor_tool_result","tool_use_id":"advisor-1",
                        "content":{"type":"advisor_tool_result_error","error_code":"advisor_unavailable"}}}
            }),
            json!({
                "type":"stream_event","uuid":"6","session_id":"s","parent_tool_use_id":null,
                "event":{"type":"content_block_stop","index":1}
            }),
            json!({
                "type":"stream_event","uuid":"7","session_id":"s","parent_tool_use_id":null,
                "event":{"type":"content_block_start","index":2,
                    "content_block":{"type":"compaction","content":"internal summary"}}
            }),
            json!({
                "type":"stream_event","uuid":"8","session_id":"s","parent_tool_use_id":null,
                "event":{"type":"content_block_stop","index":2}
            }),
            json!({
                "type":"stream_event","uuid":"9","session_id":"s","parent_tool_use_id":null,
                "event":{"type":"message_stop"}
            }),
        ];
        for (sequence, frame) in frames.into_iter().enumerate() {
            assert_eq!(
                projection.ingest(raw(sequence as u64, frame)),
                ProjectionEffect::None
            );
        }
        assert_eq!(projection.items().len(), 2);
        assert_eq!(projection.items()[0].text, "visible");
        assert_eq!(projection.items()[0].raw_sequences, vec![1, 2, 3, 4, 9]);
        assert_eq!(
            projection.items()[1].text,
            "Advisor unavailable (advisor_unavailable)"
        );
        assert_eq!(
            projection.items()[1]
                .presentation
                .tool
                .as_ref()
                .and_then(|tool| tool.is_error),
            Some(true)
        );
        assert_eq!(projection.raw_envelopes().len(), 10);
    }

    #[test]
    fn advisor_redacted_result_never_projects_encrypted_payload() {
        let encrypted = "do-not-render-encrypted-advisor-payload";
        let mut projection = Projection::default();
        assert_eq!(
            projection.ingest(raw(
                0,
                json!({
                    "type":"assistant","uuid":"a","session_id":"s","parent_tool_use_id":null,
                    "message":{"id":"m","content":[{
                        "type":"advisor_tool_result","tool_use_id":"advisor-1",
                        "content":{"type":"advisor_redacted_result","encrypted_content":encrypted}
                    }]}
                })
            )),
            ProjectionEffect::None
        );
        assert_eq!(
            projection.items()[0].text,
            "Advisor has reviewed the conversation and will apply the feedback"
        );
        assert!(!projection.items()[0].text.contains(encrypted));
        assert_eq!(
            projection.items()[0].presentation.advisor,
            Some(AdvisorPresentation::Result(
                AdvisorResultPresentation::Redacted
            ))
        );
        assert_eq!(
            projection.items()[0]
                .presentation
                .tool
                .as_ref()
                .and_then(|tool| tool.result.as_ref()),
            None
        );
        assert!(
            !format!("{:?}", projection.items()[0].presentation).contains(encrypted),
            "renderer-owned presentation must not retain redacted ciphertext"
        );
        assert_eq!(
            projection.raw_envelopes()[0]
                .value
                .pointer("/message/content/0/content/encrypted_content")
                .and_then(Value::as_str),
            Some(encrypted)
        );
    }

    #[test]
    fn source_declared_user_content_block_denominator_is_projected_without_loss() {
        let encoded_document = "document-payload-must-not-be-rendered";
        let value = json!({
            "type":"user",
            "uuid":"user-blocks",
            "session_id":"s",
            "parent_tool_use_id":null,
            "message":{"role":"user","content":[
                {"type":"text","text":"hello"},
                {"type":"image","source":{"type":"url","url":"https://example.test/image.png"}},
                {"type":"document","source":{"type":"base64","media_type":"application/pdf","data":encoded_document}},
                {"type":"thinking","thinking":"reason","signature":"sig"},
                {"type":"redacted_thinking","data":"opaque"},
                {"type":"tool_use","id":"tool-1","name":"Bash","input":{"command":"pwd"}},
                {"type":"tool_result","tool_use_id":"tool-1","content":"ok","is_error":false},
                {"type":"server_tool_use","id":"server-1","name":"web_search","input":{"query":"q"}},
                {"type":"web_search_tool_result","tool_use_id":"server-1","content":{"hits":[]}},
                {"type":"web_fetch_tool_result","tool_use_id":"server-2","content":{"body":"ok"}},
                {"type":"code_execution_tool_result","tool_use_id":"server-3","content":{"stdout":"ok"}},
                {"type":"bash_code_execution_tool_result","tool_use_id":"server-4","content":{"stdout":"ok"}},
                {"type":"text_editor_code_execution_tool_result","tool_use_id":"server-5","content":{"patch":"ok"}},
                {"type":"tool_search_tool_result","tool_use_id":"server-6","content":{"tools":[]}},
                {"type":"mcp_tool_use","id":"mcp-1","name":"read","input":{"path":"x"},"server_name":"server"},
                {"type":"mcp_tool_result","tool_use_id":"mcp-1","content":"done","is_error":false},
                {"type":"container_upload","file_id":"file-1"},
                {"type":"compaction","content":"internal summary"},
                {"type":"connector_text","text":"bound fallback","connector_text":"visible connector","signature":"sig"},
                {"type":"advisor_tool_result","tool_use_id":"advisor-1",
                    "content":{"type":"advisor_result","text":"advice"}}
            ]}
        });
        let mut projection = Projection::default();
        assert_eq!(
            projection.ingest(raw(0, value.clone())),
            ProjectionEffect::None
        );
        assert_eq!(projection.raw_envelopes()[0].value, value);
        assert_eq!(projection.items().len(), 19);
        assert!(
            projection
                .items()
                .iter()
                .all(|item| !item.text.contains(encoded_document))
        );
        assert!(
            projection
                .items()
                .iter()
                .any(|item| item.text == "visible connector")
        );
        assert!(projection.items().iter().any(|item| item.text == "advice"));
        assert!(
            projection
                .items()
                .iter()
                .any(|item| item.kind == ProjectedKind::TerminalOutput && item.text == "ok")
        );
    }

    #[test]
    fn tool_use_and_terminal_result_keep_identity() {
        let mut projection = Projection::default();
        projection.ingest(raw(
            0,
            json!({
                "type": "assistant",
                "session_id": "s",
                "uuid": "a",
                "parent_tool_use_id": null,
                "message": {
                    "id": "m",
                    "content": [{
                        "type": "tool_use",
                        "id": "tool-1",
                        "name": "Bash",
                        "input": {"command": "printf ok"}
                    }]
                }
            }),
        ));
        projection.ingest(raw(
            1,
            json!({
                "type": "user",
                "session_id": "s",
                "uuid": "r",
                "parent_tool_use_id": "tool-1",
                "message": {
                    "role": "user",
                    "content": [{
                        "type": "tool_result",
                        "tool_use_id": "tool-1",
                        "content": "\u{001b}[32mok\u{001b}[0m"
                    }]
                }
            }),
        ));
        let result = projection
            .items()
            .iter()
            .find(|item| item.kind == ProjectedKind::TerminalOutput)
            .expect("terminal result");
        assert_eq!(result.tool_use_id.as_deref(), Some("tool-1"));
        assert!(
            result.text.contains('\u{1b}'),
            "VTE stage receives raw ANSI"
        );
    }

    #[test]
    fn permission_and_elicitation_are_never_auto_decided() {
        let mut projection = Projection::default();
        for (sequence, subtype) in [(0, "can_use_tool"), (1, "elicitation")] {
            let effect = projection.ingest(raw(
                sequence,
                json!({
                    "type": "control_request",
                    "request_id": format!("request-{sequence}"),
                    "request": {
                        "subtype": subtype,
                        "input": {"path": "/tmp/a"},
                        "future_field": "retained"
                    }
                }),
            ));
            let ProjectionEffect::ReverseControlOpened(pending) = effect else {
                panic!("request must be presented");
            };
            assert_eq!(pending.subtype, subtype);
            assert_eq!(pending.request["future_field"], "retained");
        }
        assert_eq!(projection.pending_controls().count(), 2);
    }

    #[test]
    fn cancelled_reverse_request_is_removed_without_fabricating_a_response() {
        let mut projection = Projection::default();
        projection.ingest(raw(
            0,
            json!({
                "type": "control_request",
                "request_id": "p",
                "request": {"subtype": "can_use_tool", "input": {}}
            }),
        ));
        let effect = projection.ingest(raw(
            1,
            json!({"type": "control_cancel_request", "request_id": "p"}),
        ));
        assert_eq!(
            effect,
            ProjectionEffect::ReverseControlCancelled {
                request_id: "p".to_string()
            }
        );
        assert!(projection.pending_control("p").is_none());
    }

    #[test]
    fn authoritative_idle_state_is_projected_separately_from_result() {
        let mut projection = Projection::default();
        let effect = projection.ingest(raw(
            0,
            json!({
                "type": "system",
                "subtype": "session_state_changed",
                "state": "idle",
                "session_id": "s",
                "uuid": "state"
            }),
        ));
        assert_eq!(
            effect,
            ProjectionEffect::SessionStateChanged("idle".to_string())
        );
        assert_eq!(projection.session_state(), Some("idle"));
        assert_eq!(projection.session_id(), Some("s"));
    }

    #[test]
    fn unknown_assistant_block_and_stream_delta_are_nonfatal_and_diagnosable() {
        let mut projection = Projection::default();
        let assistant = json!({
            "type": "assistant",
            "uuid": "a",
            "session_id": "s",
            "parent_tool_use_id": null,
            "message": {"id": "m", "content": [{"type": "future_block", "x": 1}]}
        });
        assert_eq!(
            projection.ingest(raw(0, assistant.clone())),
            ProjectionEffect::None
        );
        assert_eq!(projection.raw_envelopes()[0].value, assistant);

        let delta = json!({
            "type": "stream_event",
            "event": {
                "type": "content_block_delta",
                "index": 0,
                "delta": {"type": "future_delta", "payload": {"x": 1}}
            }
        });
        assert_eq!(
            projection.ingest(raw(1, delta.clone())),
            ProjectionEffect::None
        );
        assert_eq!(projection.raw_envelopes()[1].value, delta);
        assert_eq!(projection.compatibility_diagnostics().len(), 2);
    }

    #[test]
    fn historical_assistant_metadata_is_raw_only_and_adds_no_transcript_item() {
        let errors = [
            "authentication_failed",
            "billing_error",
            "invalid_request",
            "max_output_tokens",
            "rate_limit",
            "server_error",
            "unknown",
        ];
        let stop_reasons = [
            "compaction",
            "end_turn",
            "max_tokens",
            "model_context_window_exceeded",
            "pause_turn",
            "refusal",
            "stop_sequence",
            "tool_use",
        ];
        let recovery_kinds = [
            "identity_repair_required",
            "permissions_required",
            "requires_enablement",
        ];

        for (index, stop_reason) in stop_reasons.into_iter().enumerate() {
            let baseline = json!({
                "type": "assistant",
                "uuid": format!("assistant-{index}"),
                "session_id": "s",
                "parent_tool_use_id": null,
                "message": {
                    "id": format!("message-{index}"),
                    "content": [{"type": "text", "text": "answer"}]
                }
            });
            let value = json!({
                "type": "assistant",
                "uuid": format!("assistant-{index}"),
                "session_id": "s",
                "parent_tool_use_id": null,
                "error": errors[index % errors.len()],
                "automationRecovery": {
                    "kind": recovery_kinds[index % recovery_kinds.len()],
                    "backend": "desktop-automation",
                    "setupAction": "bootstrap_computer_control",
                    "requiresUserGesture": true
                },
                "message": {
                    "id": format!("message-{index}"),
                    "content": [{"type": "text", "text": "answer"}],
                    "stop_reason": stop_reason
                }
            });
            let mut baseline_projection = Projection::default();
            let mut projection = Projection::default();

            assert_eq!(
                baseline_projection.ingest(raw(index as u64, baseline)),
                ProjectionEffect::None
            );
            assert_eq!(
                projection.ingest(raw(index as u64, value.clone())),
                ProjectionEffect::None
            );
            assert_eq!(projection.raw_envelopes().len(), 1);
            assert_eq!(projection.raw_envelopes()[0].value, value);
            assert_eq!(projection.items(), baseline_projection.items());
            assert_eq!(projection.items().len(), 1);
        }
    }

    #[test]
    fn historical_stream_metadata_is_raw_only_and_adds_no_transcript_item() {
        let message_start_snapshots = [
            json!({"type":"advisor_tool_result","content":{"type":"advisor_redacted_result"}}),
            json!({"type":"advisor_tool_result","content":{"type":"advisor_result"}}),
            json!({"type":"advisor_tool_result","content":{"type":"advisor_tool_result_error"}}),
            json!({"type":"server_tool_use","name":"advisor"}),
            json!({"type":"advisor_tool_result"}),
            json!({"type":"bash_code_execution_tool_result"}),
            json!({"type":"code_execution_tool_result"}),
            json!({"type":"compaction"}),
            json!({"type":"connector_text"}),
            json!({"type":"container_upload"}),
            json!({"type":"mcp_tool_result"}),
            json!({"type":"mcp_tool_use"}),
            json!({"type":"redacted_thinking"}),
            json!({"type":"server_tool_use"}),
            json!({"type":"text_editor_code_execution_tool_result"}),
            json!({"type":"text"}),
            json!({"type":"thinking"}),
            json!({"type":"tool_search_tool_result"}),
            json!({"type":"tool_use"}),
            json!({"type":"web_fetch_tool_result"}),
            json!({"type":"web_search_tool_result"}),
        ];
        let stop_reasons = [
            "compaction",
            "end_turn",
            "max_tokens",
            "model_context_window_exceeded",
            "pause_turn",
            "refusal",
            "stop_sequence",
            "tool_use",
        ];

        for (index, snapshot) in message_start_snapshots.into_iter().enumerate() {
            let start = json!({
                "type": "stream_event",
                "uuid": format!("stream-{index}"),
                "session_id": "s",
                "parent_tool_use_id": null,
                "event": {
                    "type": "message_start",
                    "message": {
                        "id": format!("message-{index}"),
                        "content": [snapshot],
                        "stop_reason": stop_reasons[index % stop_reasons.len()]
                    }
                }
            });
            let delta = json!({
                "type": "stream_event",
                "uuid": format!("stream-{index}"),
                "session_id": "s",
                "parent_tool_use_id": null,
                "event": {
                    "type": "message_delta",
                    "delta": {
                        "stop_reason": stop_reasons[(index + 1) % stop_reasons.len()]
                    }
                }
            });
            let mut projection = Projection::default();

            assert_eq!(
                projection.ingest(raw(0, start.clone())),
                ProjectionEffect::None
            );
            assert!(projection.items().is_empty());
            assert_eq!(
                projection.ingest(raw(1, delta.clone())),
                ProjectionEffect::None
            );
            assert!(projection.items().is_empty());
            assert_eq!(projection.raw_envelopes().len(), 2);
            assert_eq!(projection.raw_envelopes()[0].value, start);
            assert_eq!(projection.raw_envelopes()[1].value, delta);
        }
    }

    #[test]
    fn result_retains_metrics_without_projecting_a_transcript_row() {
        let value = json!({
            "type": "result",
            "subtype": "success",
            "duration_ms": 100,
            "duration_api_ms": 80,
            "is_error": false,
            "num_turns": 2,
            "result": "done",
            "stop_reason": "end_turn",
            "total_cost_usd": 0.2,
            "usage": {"input_tokens": 1},
            "modelUsage": {"m": {
                "inputTokens":1,
                "outputTokens":2,
                "cacheReadInputTokens":3,
                "cacheCreationInputTokens":4,
                "webSearchRequests":5,
                "costUSD":0.2,
                "contextWindow":200000,
                "maxOutputTokens":8192
            }},
            "permission_denials": [{
                "tool_name":"Bash",
                "tool_use_id":"tool-1",
                "tool_input":{"command":"pwd"}
            }],
            "structured_output": {"ok": true},
            "session_id": "s",
            "uuid": "r"
        });
        let mut projection = Projection::default();
        assert_eq!(
            projection.ingest(raw(0, value.clone())),
            ProjectionEffect::TurnCompleted {
                subtype: "success".to_string(),
                is_error: false,
                raw_sequence: 0
            }
        );
        assert_eq!(projection.raw_envelopes()[0].value, value);
        assert!(projection.items().is_empty());
        assert_eq!(
            projection.raw_envelopes()[0]
                .value
                .pointer("/structured_output/ok"),
            Some(&Value::Bool(true))
        );
    }

    #[test]
    fn task_notification_title_matches_terminal_status() {
        for (sequence, (status, expected_title)) in [
            ("completed", "Task completed"),
            ("failed", "Task failed"),
            ("stopped", "Task stopped"),
        ]
        .into_iter()
        .enumerate()
        {
            let mut projection = Projection::default();
            assert_eq!(
                projection.ingest(raw(
                    sequence as u64,
                    json!({
                        "type":"system",
                        "subtype":"task_notification",
                        "task_id":format!("task-{status}"),
                        "status":status,
                        "output_file":format!("/tmp/task-{status}"),
                        "summary":format!("task {status}"),
                        "uuid":format!("notification-{status}"),
                        "session_id":"s"
                    })
                )),
                ProjectionEffect::None
            );
            let item = projection.items().first().expect("task notification row");
            assert_eq!(item.title, expected_title, "status: {status}");
            assert!(item.text.lines().any(|line| line == status));
            assert!(!item.streaming);
        }
    }

    #[test]
    fn non_conversational_sdk_families_have_exact_display_or_source_null_dispositions() {
        let messages = vec![
            json!({"type":"tool_progress","tool_use_id":"t","tool_name":"Read","parent_tool_use_id":null,"elapsed_time_seconds":1,"uuid":"0","session_id":"s"}),
            json!({"type":"auth_status","isAuthenticating":true,"output":["open browser"],"uuid":"1","session_id":"s"}),
            json!({"type":"tool_use_summary","summary":"Read 2 files","preceding_tool_use_ids":["t"],"uuid":"2","session_id":"s"}),
            json!({"type":"rate_limit_event","rate_limit_info":{"status":"allowed_warning","tokenRemaining":1,"tokenQuota":2,"callRemaining":3,"callQuota":4},"uuid":"3","session_id":"s"}),
            json!({"type":"prompt_suggestion","suggestion":"run tests","uuid":"4","session_id":"s"}),
            json!({"type":"streamlined_text","text":"answer","uuid":"5","session_id":"s"}),
            json!({"type":"streamlined_tool_use_summary","tool_summary":"used Read","uuid":"6","session_id":"s"}),
            json!({"type":"system","subtype":"task_started","task_id":"task","description":"work","uuid":"7","session_id":"s"}),
            json!({"type":"system","subtype":"task_progress","task_id":"task","description":"half","usage":{"total_tokens":1,"tool_uses":1,"duration_ms":1},"uuid":"8","session_id":"s"}),
            json!({"type":"system","subtype":"task_notification","task_id":"task","status":"completed","output_file":"x","summary":"done","uuid":"9","session_id":"s"}),
            json!({"type":"system","subtype":"files_persisted","files":[],"failed":[],"processed_at":"2026-07-28T00:00:00.000Z","uuid":"10","session_id":"s"}),
            json!({"type":"system","subtype":"elicitation_complete","mcp_server_name":"m","elicitation_id":"e","uuid":"11","session_id":"s"}),
        ];
        let mut projection = Projection::default();
        for (sequence, message) in messages.into_iter().enumerate() {
            assert!(!matches!(
                projection.ingest(raw(sequence as u64, message)),
                ProjectionEffect::FailClosed { .. }
            ));
        }
        assert_eq!(projection.raw_envelopes().len(), 12);
        assert_eq!(projection.prompt_suggestion(), Some("run tests"));
        // Three task lifecycle envelopes intentionally collapse into one
        // stable task row; auth/tool-summary/rate-limit/prompt-suggestion are
        // source-null or non-transcript state.
        assert_eq!(projection.items().len(), 6);
        assert!(projection.items().iter().any(|item| {
            item.kind == ProjectedKind::Assistant
                && item.presentation.assistant_block == Some(AssistantBlockType::Text)
        }));
        assert!(
            projection.items().iter().any(|item| {
                item.kind == ProjectedKind::System && item.presentation.plain_system
            })
        );
        assert!(!projection.items().iter().any(|item| {
            matches!(
                item.title.as_str(),
                "Authenticating" | "Authentication" | "Rate limit · allowed_warning"
            )
        }));
    }

    #[test]
    fn sdk_rate_limit_event_is_validated_raw_state_not_a_transcript_card() {
        let mut projection = Projection::default();
        let event = json!({
            "type":"rate_limit_event",
            "rate_limit_info":{
                "status":"allowed_warning",
                "tokenRemaining":1,
                "tokenQuota":2,
                "callRemaining":3,
                "callQuota":4
            },
            "uuid":"rate",
            "session_id":"s"
        });

        assert_eq!(
            projection.ingest(raw(0, event.clone())),
            ProjectionEffect::None
        );
        assert!(projection.items().is_empty());
        assert_eq!(projection.raw_envelopes()[0].value, event);
    }

    #[test]
    fn completed_assistant_blocks_retain_every_typed_discriminator_and_payload() {
        let blocks = json!([
            {"type":"text","text":"answer"},
            {"type":"thinking","thinking":"reason","signature":"sig"},
            {"type":"redacted_thinking","data":"opaque"},
            {"type":"tool_use","id":"local","name":"Bash","input":{"command":"pwd"}},
            {"type":"server_tool_use","id":"server","name":"WebSearch","input":{"query":"q"}},
            {"type":"mcp_tool_use","id":"mcp","name":"mcp__server__read","input":{"uri":"x"},"server_name":"server"},
            {"type":"web_search_tool_result","tool_use_id":"server","content":{"hits":1}},
            {"type":"web_fetch_tool_result","tool_use_id":"server","content":{"body":"x"}},
            {"type":"code_execution_tool_result","tool_use_id":"server","content":{"stdout":"ok"}},
            {"type":"bash_code_execution_tool_result","tool_use_id":"server","content":{"stdout":"ok"}},
            {"type":"text_editor_code_execution_tool_result","tool_use_id":"server","content":{"path":"a"}},
            {"type":"tool_search_tool_result","tool_use_id":"server","content":{"tools":["Read"]}},
            {"type":"mcp_tool_result","tool_use_id":"mcp","content":"denied","is_error":true},
            {"type":"container_upload","file_id":"file-1"}
        ]);
        let expected = [
            AssistantBlockType::Text,
            AssistantBlockType::Thinking,
            AssistantBlockType::RedactedThinking,
            AssistantBlockType::ToolUse,
            AssistantBlockType::ServerToolUse,
            AssistantBlockType::McpToolUse,
            AssistantBlockType::WebSearchToolResult,
            AssistantBlockType::WebFetchToolResult,
            AssistantBlockType::CodeExecutionToolResult,
            AssistantBlockType::BashCodeExecutionToolResult,
            AssistantBlockType::TextEditorCodeExecutionToolResult,
            AssistantBlockType::ToolSearchToolResult,
            AssistantBlockType::McpToolResult,
            AssistantBlockType::ContainerUpload,
        ];
        let mut projection = Projection::default();
        assert_eq!(
            projection.ingest(raw(
                10,
                json!({
                    "type":"assistant",
                    "uuid":"assistant-1",
                    "session_id":"session",
                    "parent_tool_use_id":null,
                    "message":{"id":"message-1","content":blocks}
                })
            )),
            ProjectionEffect::None
        );
        assert_eq!(projection.items().len(), expected.len());
        for (item, expected_type) in projection.items().iter().zip(expected) {
            assert_eq!(
                item.presentation.assistant_block,
                Some(expected_type),
                "typed discriminator for {}",
                item.key
            );
        }

        let thinking = projection.items()[1]
            .presentation
            .thinking
            .as_ref()
            .expect("thinking metadata");
        assert_eq!(thinking.kind, ThinkingKind::Thinking);
        assert_eq!(thinking.content, "reason");
        assert_eq!(thinking.signature.as_deref(), Some("sig"));
        let redacted = projection.items()[2]
            .presentation
            .thinking
            .as_ref()
            .expect("redacted metadata");
        assert_eq!(redacted.kind, ThinkingKind::Redacted);
        assert_eq!(redacted.content, "opaque");
        assert_eq!(redacted.signature, None);

        let use_metadata = projection.items()[3]
            .presentation
            .tool
            .as_ref()
            .expect("tool-use metadata");
        assert_eq!(use_metadata.name.as_deref(), Some("Bash"));
        assert_eq!(use_metadata.input, Some(json!({"command":"pwd"})));
        assert_eq!(use_metadata.result, None);
        assert_eq!(use_metadata.is_error, None);

        let mcp_result = projection.items()[12]
            .presentation
            .tool
            .as_ref()
            .expect("MCP result metadata");
        assert_eq!(mcp_result.name.as_deref(), Some("mcp__server__read"));
        assert_eq!(mcp_result.result, Some(json!("denied")));
        assert_eq!(mcp_result.is_error, Some(true));
    }

    #[test]
    fn stream_tool_input_metadata_survives_completed_frame_reconciliation() {
        let mut projection = Projection::default();
        for (sequence, value) in [
            (
                0,
                json!({
                    "type":"stream_event","uuid":"stream","session_id":"s","parent_tool_use_id":null,
                    "event":{"type":"message_start","message":{"id":"m"}}
                }),
            ),
            (
                1,
                json!({
                    "type":"stream_event","uuid":"stream","session_id":"s","parent_tool_use_id":null,
                    "event":{"type":"content_block_start","index":0,
                        "content_block":{"type":"tool_use","id":"tool","name":"Bash","input":{}}}
                }),
            ),
            (
                2,
                json!({
                    "type":"stream_event","uuid":"stream","session_id":"s","parent_tool_use_id":null,
                    "event":{"type":"content_block_delta","index":0,
                        "delta":{"type":"input_json_delta","partial_json":"{\"command\":\""}}
                }),
            ),
            (
                3,
                json!({
                    "type":"stream_event","uuid":"stream","session_id":"s","parent_tool_use_id":null,
                    "event":{"type":"content_block_delta","index":0,
                        "delta":{"type":"input_json_delta","partial_json":"pwd\"}"}}
                }),
            ),
            (
                4,
                json!({
                    "type":"stream_event","uuid":"stream","session_id":"s","parent_tool_use_id":null,
                    "event":{"type":"content_block_stop","index":0}
                }),
            ),
            (
                5,
                json!({
                    "type":"assistant","uuid":"a","session_id":"s","parent_tool_use_id":null,
                    "message":{"id":"m","content":[
                        {"type":"tool_use","id":"tool","name":"Bash","input":{"command":"pwd"}}
                    ]}
                }),
            ),
        ] {
            assert_eq!(
                projection.ingest(raw(sequence, value)),
                ProjectionEffect::None
            );
        }
        let item = projection
            .items()
            .iter()
            .find(|item| item.key == "assistant:m:0")
            .expect("reconciled tool item");
        assert!(!item.streaming);
        assert_eq!(item.raw_sequences, vec![1, 2, 3, 4, 5]);
        let tool = item.presentation.tool.as_ref().expect("tool metadata");
        assert_eq!(tool.name.as_deref(), Some("Bash"));
        assert_eq!(tool.input, Some(json!({"command":"pwd"})));
        assert_eq!(
            tool.partial_input_json.as_deref(),
            Some("{\"command\":\"pwd\"}")
        );
        assert_eq!(
            item.presentation.assistant_block,
            Some(AssistantBlockType::ToolUse)
        );
    }

    #[test]
    fn stream_thinking_metadata_is_updated_by_delta_and_completed_signature() {
        let mut projection = Projection::default();
        for (sequence, value) in [
            (
                0,
                json!({
                    "type":"stream_event","uuid":"stream","session_id":"s","parent_tool_use_id":null,
                    "event":{"type":"message_start","message":{"id":"m"}}
                }),
            ),
            (
                1,
                json!({
                    "type":"stream_event","uuid":"stream","session_id":"s","parent_tool_use_id":null,
                    "event":{"type":"content_block_start","index":0,
                        "content_block":{"type":"thinking","thinking":"","signature":""}}
                }),
            ),
            (
                2,
                json!({
                    "type":"stream_event","uuid":"stream","session_id":"s","parent_tool_use_id":null,
                    "event":{"type":"content_block_delta","index":0,
                        "delta":{"type":"thinking_delta","thinking":"reason"}}
                }),
            ),
            (
                3,
                json!({
                    "type":"assistant","uuid":"a","session_id":"s","parent_tool_use_id":null,
                    "message":{"id":"m","content":[
                        {"type":"thinking","thinking":"reason","signature":"complete-signature"}
                    ]}
                }),
            ),
        ] {
            assert_eq!(
                projection.ingest(raw(sequence, value)),
                ProjectionEffect::None
            );
        }
        let item = &projection.items()[0];
        assert_eq!(item.text, "reason");
        assert_eq!(item.raw_sequences, vec![1, 2, 3]);
        let thinking = item
            .presentation
            .thinking
            .as_ref()
            .expect("thinking metadata");
        assert_eq!(thinking.content, "reason");
        assert_eq!(thinking.signature.as_deref(), Some("complete-signature"));
    }

    #[test]
    fn repeated_equal_stream_deltas_are_appended_as_wire_deltas() {
        let mut projection = Projection::default();
        for (sequence, value) in [
            (
                0,
                json!({
                    "type":"stream_event","uuid":"stream","session_id":"s","parent_tool_use_id":null,
                    "event":{"type":"message_start","message":{"id":"m"}}
                }),
            ),
            (
                1,
                json!({
                    "type":"stream_event","uuid":"stream","session_id":"s","parent_tool_use_id":null,
                    "event":{"type":"content_block_start","index":0,
                        "content_block":{"type":"text","text":""}}
                }),
            ),
            (
                2,
                json!({
                    "type":"stream_event","uuid":"stream","session_id":"s","parent_tool_use_id":null,
                    "event":{"type":"content_block_delta","index":0,
                        "delta":{"type":"text_delta","text":"ha"}}
                }),
            ),
            (
                3,
                json!({
                    "type":"stream_event","uuid":"stream","session_id":"s","parent_tool_use_id":null,
                    "event":{"type":"content_block_delta","index":0,
                        "delta":{"type":"text_delta","text":"ha"}}
                }),
            ),
        ] {
            assert_eq!(
                projection.ingest(raw(sequence, value)),
                ProjectionEffect::None
            );
        }
        assert_eq!(projection.items()[0].text, "haha");
        assert_eq!(projection.items()[0].raw_sequences, vec![1, 2, 3]);
    }

    #[test]
    fn image_blocks_retain_base64_url_and_file_provenance_without_payload_copy() {
        let mut projection = Projection::default();
        assert_eq!(
            projection.ingest(raw(
                7,
                json!({
                    "type":"user","uuid":"u","session_id":"s","parent_tool_use_id":null,
                    "message":{"content":[
                        {"type":"image","source":{"type":"base64","media_type":"image/png","data":"AAAA"}},
                        {"type":"image","source":{"type":"url","url":"https://example.invalid/image.png"}},
                        {"type":"image","source":{"type":"file","file_id":"file-1"}}
                    ]}
                })
            )),
            ProjectionEffect::None
        );
        assert_eq!(
            projection.items()[0].presentation.image,
            Some(ImageProvenance::Base64 {
                media_type: ImageMediaType::Png,
                encoded_len: 4,
            })
        );
        assert_eq!(
            projection.items()[1].presentation.image,
            Some(ImageProvenance::Url {
                url: "https://example.invalid/image.png".to_string(),
            })
        );
        assert_eq!(
            projection.items()[2].presentation.image,
            Some(ImageProvenance::File {
                file_id: "file-1".to_string(),
            })
        );
        assert!(
            !format!("{:?}", projection.items()[0].presentation).contains("AAAA"),
            "presentation metadata stores only provenance summary, not a second payload copy"
        );
    }

    #[test]
    fn every_classified_sdk_system_subtype_is_retained_as_typed_metadata() {
        let cases = vec![
            (
                json!({
                    "type":"system","subtype":"init",
                    "apiKeySource":"none","crab_code_version":"1.0.0",
                    "cwd":"/workspace","tools":[],"mcp_servers":[],
                    "model":"model","permissionMode":"default",
                    "slash_commands":[],"output_style":"default",
                    "skills":[],"plugins":[],"uuid":"0","session_id":"s"
                }),
                SystemSubtype::Init,
            ),
            (
                json!({"type":"system","subtype":"compact_boundary","compact_metadata":{"trigger":"auto","pre_tokens":100},"uuid":"1","session_id":"s"}),
                SystemSubtype::CompactBoundary,
            ),
            (
                json!({"type":"system","subtype":"status","status":null,"uuid":"2","session_id":"s"}),
                SystemSubtype::Status,
            ),
            (
                json!({
                    "type":"system","subtype":"post_turn_summary",
                    "summarizes_uuid":"assistant","status_category":"completed",
                    "status_detail":"done","is_noteworthy":false,"title":"Done",
                    "description":"Completed","recent_action":"Tested",
                    "needs_action":"","artifact_urls":[],"uuid":"3","session_id":"s"
                }),
                SystemSubtype::PostTurnSummary,
            ),
            (
                json!({"type":"system","subtype":"api_retry","attempt":1,"max_retries":3,"retry_delay_ms":100,"error_status":null,"error":"server_error","uuid":"4","session_id":"s"}),
                SystemSubtype::ApiRetry,
            ),
            (
                json!({"type":"system","subtype":"local_command_output","content":"x","uuid":"5","session_id":"s"}),
                SystemSubtype::LocalCommandOutput,
            ),
            (
                json!({"type":"system","subtype":"hook_started","hook_id":"h","hook_name":"command","hook_event":"PreToolUse","uuid":"6","session_id":"s"}),
                SystemSubtype::HookStarted,
            ),
            (
                json!({"type":"system","subtype":"hook_progress","hook_id":"hp","hook_name":"command","hook_event":"PreToolUse","stdout":"","stderr":"","output":"running","uuid":"7","session_id":"s"}),
                SystemSubtype::HookProgress,
            ),
            (
                json!({"type":"system","subtype":"hook_response","hook_id":"hr","hook_name":"command","hook_event":"PreToolUse","stdout":"","stderr":"","output":"done","outcome":"success","uuid":"8","session_id":"s"}),
                SystemSubtype::HookResponse,
            ),
            (
                json!({"type":"system","subtype":"task_notification","task_id":"tn","status":"completed","output_file":"/tmp/task","summary":"done","uuid":"9","session_id":"s"}),
                SystemSubtype::TaskNotification,
            ),
            (
                json!({"type":"system","subtype":"task_started","task_id":"ts","description":"start","uuid":"10","session_id":"s"}),
                SystemSubtype::TaskStarted,
            ),
            (
                json!({"type":"system","subtype":"task_progress","task_id":"tp","description":"work","usage":{"total_tokens":1,"tool_uses":2,"duration_ms":3},"uuid":"11","session_id":"s"}),
                SystemSubtype::TaskProgress,
            ),
            (
                json!({"type":"system","subtype":"session_state_changed","state":"idle","uuid":"12","session_id":"s"}),
                SystemSubtype::SessionStateChanged,
            ),
            (
                json!({"type":"system","subtype":"files_persisted","files":[],"failed":[],"processed_at":"2026-07-28T00:00:00.000Z","uuid":"13","session_id":"s"}),
                SystemSubtype::FilesPersisted,
            ),
            (
                json!({"type":"system","subtype":"elicitation_complete","mcp_server_name":"server","elicitation_id":"elicitation","uuid":"14","session_id":"s"}),
                SystemSubtype::ElicitationComplete,
            ),
        ];
        let mut projection = Projection::default();
        for (sequence, (value, expected)) in cases.into_iter().enumerate() {
            let effect = projection.ingest(raw(sequence as u64, value));
            assert!(!matches!(effect, ProjectionEffect::FailClosed { .. }));
            if expected == SystemSubtype::Init {
                assert!(matches!(effect, ProjectionEffect::Initialized { .. }));
                assert!(
                    projection
                        .items()
                        .iter()
                        .all(|item| !item.raw_sequences.contains(&(sequence as u64))),
                    "system:init remains typed process control, not transcript"
                );
                continue;
            }
            let item = projection
                .items()
                .iter()
                .find(|item| item.raw_sequences.contains(&(sequence as u64)))
                .expect("system item with source sequence");
            assert_eq!(
                item.presentation
                    .system
                    .as_ref()
                    .map(|system| &system.subtype),
                Some(&ProjectedSystemSubtype::Sdk(expected))
            );
        }
    }

    /// Executes the complete current backend-to-renderer projection
    /// denominator as one immutable evidence target.
    ///
    /// The source-derived gate owns the independent count (143 inbound rows;
    /// the sole `update_environment_variables` outbound row is exercised by
    /// the transport evidence test).  This test deliberately composes the
    /// item-specific tests below instead of introducing a second fixture
    /// vocabulary that could drift from the production classifier.
    #[test]
    fn complete_backend_adapter_projection_denominator_is_lossless() {
        // 22 assistant rows: top-level envelope, every completed block,
        // advisor name/content refinements, and the three advisor results.
        completed_assistant_blocks_retain_every_typed_discriminator_and_payload();
        source_declared_extended_assistant_blocks_keep_typed_meaning();
        final_advisor_use_and_feedback_keep_typed_input_and_resolution_state();
        advisor_redacted_result_never_projects_encrypted_payload();

        // 21 user rows: top-level envelope plus all twenty content members.
        source_declared_user_content_block_denominator_is_projected_without_loss();

        // 35 visible stream rows plus the two source-declared raw-only event
        // families: top-level envelope, event members, content starts, deltas,
        // advisor refinements, ping, and typed search/RAG sources.
        stream_deltas_reconcile_with_final_assistant_without_duplicate();
        delta_assembled_stream_starts_ignore_nonempty_seed_values();
        source_declared_stream_ping_is_journaled_without_transcript_item();
        typed_stream_sources_are_null_rendered_without_disturbing_nested_agent_state();
        known_raw_stream_events_and_additive_future_events_are_compatible();
        stream_advisor_use_and_error_keep_exact_code_and_failed_state();
        source_declared_extended_stream_blocks_and_deltas_are_consumed();
        stream_tool_input_metadata_survives_completed_frame_reconciliation();
        stream_thinking_metadata_is_updated_by_delta_and_completed_signature();

        // 16 SDK system rows and the twelve other non-conversational
        // top-level families have exact display or source-null dispositions.
        every_classified_sdk_system_subtype_is_retained_as_typed_metadata();
        non_conversational_sdk_families_have_exact_display_or_source_null_dispositions();

        // All five result subtypes share the exact required metrics/identity
        // envelope and differ only in success.result versus error.errors.
        for (sequence, subtype) in GENERATED_SDK_RESULT_SUBTYPES.iter().copied().enumerate() {
            let is_success = subtype == "success";
            let mut value = json!({
                "type": "result",
                "subtype": subtype,
                "duration_ms": 100,
                "duration_api_ms": 80,
                "is_error": !is_success,
                "num_turns": 1,
                "stop_reason": null,
                "total_cost_usd": 0,
                "usage": {},
                "modelUsage": {},
                "permission_denials": [],
                "session_id": "projection-denominator",
                "uuid": format!("result-{sequence}")
            });
            if is_success {
                value
                    .as_object_mut()
                    .expect("result object")
                    .insert("result".to_string(), Value::String("done".to_string()));
            } else {
                value.as_object_mut().expect("result object").insert(
                    "errors".to_string(),
                    Value::Array(vec![Value::String("source error".to_string())]),
                );
            }
            let mut projection = Projection::default();
            assert_eq!(
                projection.ingest(raw(sequence as u64, value.clone())),
                ProjectionEffect::TurnCompleted {
                    subtype: subtype.to_string(),
                    is_error: !is_success,
                    raw_sequence: sequence as u64,
                }
            );
            assert_eq!(projection.raw_envelopes()[0].value, value);
            assert!(projection.items().is_empty());
        }

        // All 32 backend control request leaves are carried unchanged into
        // the pending reverse-control registry. `crabcode_tui_setup` is
        // intentionally absent: its separate closed renderer-private gate
        // proves that it is not a backend-oracle row.
        let backend_control_subtypes = [
            "initialize",
            "interrupt",
            "can_use_tool",
            "set_permission_mode",
            "set_model",
            "set_max_thinking_tokens",
            "mcp_status",
            "get_context_usage",
            "rewind_files",
            "cancel_async_message",
            "seed_read_state",
            "hook_callback",
            "mcp_message",
            "mcp_set_servers",
            "reload_plugins",
            "mcp_reconnect",
            "mcp_toggle",
            "stop_task",
            "apply_flag_settings",
            "get_settings",
            "elicitation",
            "end_session",
            "channel_enable",
            "mcp_authenticate",
            "mcp_oauth_callback_url",
            "crabcode_authenticate",
            "crabcode_oauth_callback",
            "crabcode_oauth_wait_for_completion",
            "mcp_clear_auth",
            "generate_session_title",
            "side_question",
            "set_proactive",
        ];
        assert_eq!(backend_control_subtypes.len(), 32);
        let mut projection = Projection::default();
        for (sequence, subtype) in backend_control_subtypes.into_iter().enumerate() {
            let request_id = format!("control-{sequence}");
            let value = json!({
                "type": "control_request",
                "request_id": request_id,
                "request": {
                    "subtype": subtype,
                    "opaque_source_field": {"retained": true}
                }
            });
            let effect = projection.ingest(raw(sequence as u64, value.clone()));
            let ProjectionEffect::ReverseControlOpened(pending) = effect else {
                panic!("backend control subtype {subtype} must open a correlated request");
            };
            assert_eq!(pending.request_id, request_id);
            assert_eq!(pending.subtype, subtype);
            assert_eq!(
                pending.request["opaque_source_field"],
                json!({"retained": true})
            );
            assert_eq!(projection.raw_envelopes()[sequence].value, value);
        }
        assert_eq!(projection.pending_controls().count(), 32);

        // Both control-response outcomes retain the complete response object.
        for (sequence, response) in [
            json!({
                "subtype": "success",
                "request_id": "success",
                "response": {"opaque_source_field": true}
            }),
            json!({
                "subtype": "error",
                "request_id": "error",
                "error": "refused",
                "pending_permission_requests": [{"request_id": "pending"}]
            }),
        ]
        .into_iter()
        .enumerate()
        {
            let value = json!({"type": "control_response", "response": response});
            let mut projection = Projection::default();
            let ProjectionEffect::ControlResponse {
                request_id,
                success,
                payload,
                raw_sequence,
                ..
            } = projection.ingest(raw(sequence as u64, value.clone()))
            else {
                panic!("control response must remain a typed control effect");
            };
            assert_eq!(request_id, if success { "success" } else { "error" });
            assert_eq!(raw_sequence, sequence as u64);
            assert_eq!(payload, value["response"]);
            assert_eq!(projection.raw_envelopes()[0].value, value);
        }

        // The remaining control-cancel and keep-alive rows are raw-retained
        // state transitions, never invented transcript content.
        cancelled_reverse_request_is_removed_without_fabricating_a_response();
        let keep_alive = json!({"type": "keep_alive", "opaque_source_field": true});
        let mut projection = Projection::default();
        assert_eq!(
            projection.ingest(raw(0, keep_alive.clone())),
            ProjectionEffect::None
        );
        assert_eq!(projection.raw_envelopes()[0].value, keep_alive);
        assert!(projection.items().is_empty());

        // Raw-before-projection and the fixed failure-scope policy apply
        // across the complete denominator, not just to one discriminator
        // family.
        extra_fields_survive_known_message_projection_verbatim();
        journals_complete_unknown_presentation_without_stopping_runtime();
        unknown_assistant_block_and_stream_delta_are_nonfatal_and_diagnosable();
        malformed_typed_variants_follow_fixed_failure_scope_without_guessing_defaults();
    }

    #[test]
    fn compiler_generated_projection_families_reach_typed_rust_discriminators() {
        let generated_stream = GENERATED_STREAM_EVENT_TYPES
            .iter()
            .copied()
            .collect::<HashSet<_>>();
        let runtime_stream = KNOWN_RAW_STREAM_EVENT_TYPES
            .iter()
            .copied()
            .collect::<HashSet<_>>();
        assert_eq!(
            generated_stream, runtime_stream,
            "the generated TypeScript stream union and Rust projection denominator must remain exact"
        );

        for block_type in GENERATED_ASSISTANT_CONTENT_BLOCK_TYPES {
            assert!(
                assistant_block_type(block_type).is_some(),
                "assistant content block {block_type} lacks a native discriminator"
            );
        }
        for block_type in GENERATED_USER_CONTENT_BLOCK_TYPES {
            assert!(
                direct_user_block_type(block_type, 0).is_ok(),
                "user content block {block_type} lacks a native discriminator"
            );
        }
        assert_eq!(
            GENERATED_SDK_RESULT_SUBTYPES,
            [
                "error_during_execution",
                "error_max_budget_usd",
                "error_max_structured_output_retries",
                "error_max_turns",
                "success",
            ]
        );
    }

    #[test]
    fn malformed_typed_variants_follow_fixed_failure_scope_without_guessing_defaults() {
        let mut projection = Projection::default();
        let unknown_image = json!({
            "type":"user","uuid":"u","session_id":"s","parent_tool_use_id":null,
            "message":{"content":[
                {"type":"image","source":{"type":"future_image","opaque":"x"}}
            ]}
        });
        assert!(matches!(
            projection.ingest(raw(1, unknown_image.clone())),
            ProjectionEffect::FailClosed { sequence: 1, .. }
        ));
        assert_eq!(projection.raw_envelopes()[0].value, unknown_image);

        let orphan_delta = json!({
            "type":"stream_event","uuid":"stream","session_id":"s","parent_tool_use_id":null,
            "event":{"type":"content_block_delta","index":0,
                "delta":{"type":"text_delta","text":"must not invent message"}}
        });
        assert!(matches!(
            projection.ingest(raw(2, orphan_delta.clone())),
            ProjectionEffect::AbortTurn { sequence: 2, code, .. }
                if code == "content_block_delta_invalid"
        ));
        assert_eq!(projection.raw_envelopes()[1].value, orphan_delta);

        let missing_tool_name = json!({
            "type":"assistant","uuid":"a","session_id":"s","parent_tool_use_id":null,
            "message":{"id":"m","content":[
                {"type":"tool_use","id":"tool","input":{}}
            ]}
        });
        assert!(matches!(
            projection.ingest(raw(3, missing_tool_name.clone())),
            ProjectionEffect::FailClosed { sequence: 3, .. }
        ));
        assert_eq!(projection.raw_envelopes()[2].value, missing_tool_name);

        let malformed = [
            json!({"type":"prompt_suggestion","uuid":"p","session_id":"s"}),
            json!({"type":"system","subtype":"local_command_output","uuid":"l","session_id":"s"}),
            json!({"type":"system","subtype":"task_started","task_id":"t","summary":"not description","uuid":"t","session_id":"s"}),
            json!({"type":"auth_status","output":[],"uuid":"auth","session_id":"s"}),
            json!({"type":"auth_status","isAuthenticating":true,"output":[1],"uuid":"auth-lines","session_id":"s"}),
            json!({"type":"rate_limit_event","rate_limit_info":{"status":"future","tokenRemaining":1,"tokenQuota":2,"callRemaining":3,"callQuota":4},"uuid":"rate","session_id":"s"}),
            json!({"type":"stream_event","session_id":"s","event":{"type":"message_start","message":{"id":"m"}}}),
            json!({"type":"tool_use_summary","preceding_tool_use_ids":[],"uuid":"summary","session_id":"s"}),
            json!({"type":"streamlined_text","uuid":"streamlined","session_id":"s"}),
            json!({"type":"system","subtype":"status","uuid":"status","session_id":"s"}),
            json!({
                "type":"progress",
                "data":{
                    "type":"agent_progress",
                    "prompt":"p",
                    "agentId":"agent",
                    "message":{
                        "type":"assistant",
                        "uuid":"nested",
                        "message":{"id":"m","content":[]}
                    }
                },
                "toolUseID":"nested-tool",
                "parentToolUseID":"parent",
                "uuid":"progress",
                "timestamp":"2026-07-27T00:00:00.000Z"
            }),
            json!({
                "type":"progress",
                "data":{
                    "type":"hook_progress",
                    "hookEvent":"FutureHook",
                    "hookName":"hook",
                    "command":"true"
                },
                "toolUseID":"hook-tool",
                "parentToolUseID":"parent",
                "uuid":"hook-progress",
                "timestamp":"2026-07-27T00:00:00.000Z"
            }),
        ];
        for (offset, value) in malformed.into_iter().enumerate() {
            let sequence = 4 + offset as u64;
            assert!(
                matches!(
                    projection.ingest(raw(sequence, value.clone())),
                    ProjectionEffect::FailClosed {
                        sequence: failed_sequence,
                        ..
                    } if failed_sequence == sequence
                ),
                "malformed exact-schema fixture must fail closed: {value}"
            );
            assert_eq!(
                projection.raw_envelopes().last().map(|raw| &raw.value),
                Some(&value),
                "the malformed envelope remains in the bounded raw journal"
            );
        }
    }

    #[test]
    fn tool_result_content_does_not_treat_arbitrary_object_keys_as_text_aliases() {
        let mut projection = Projection::default();
        let effect = projection.ingest(raw(
            1,
            json!({
                "type":"user",
                "uuid":"u",
                "session_id":"s",
                "parent_tool_use_id":null,
                "message":{"content":[{
                    "type":"tool_result",
                    "tool_use_id":"tool",
                    "content":[{"content":"must remain structured"}]
                }]}
            }),
        ));
        assert!(!matches!(effect, ProjectionEffect::FailClosed { .. }));
        let item = projection.items().last().expect("tool-result projection");
        assert_ne!(item.text, "must remain structured");
        assert!(item.text.contains("\"content\""), "{}", item.text);
    }
}
