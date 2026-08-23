//! Bounded, privacy-conscious renderer diagnostics.
//!
//! Metadata is recorded by default so a presentation failure can be replayed
//! without preserving prompts or tool output. A redacted raw-event journal is
//! available only when `CRABCODE_TUI_RAW_EVENT_DUMP=1` is set. Diagnostic I/O
//! is deliberately fail-soft: it must never become a second runtime failure.
//!
//! Recording costs the calling thread one capture and one non-blocking send.
//! The journals are opened once and stay open for the life of the process; a
//! single writer thread owns those handles, builds every record, and appends
//! it, so the thread that owns the keyboard neither encodes nor waits on a
//! file system. When the queue is full the record is dropped rather than
//! queued, and the loss is reported in `dropped_since_last` on the next record
//! that lands.

use std::fs::{self, File, OpenOptions};
use std::io::{self, BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, SyncSender};

use serde_json::{Map, Value, json};
use sha2::{Digest as _, Sha256};

use crate::sdk_runtime::RawEnvelope;

const RAW_EVENT_DUMP_ENV: &str = "CRABCODE_TUI_RAW_EVENT_DUMP";
const METADATA_FILE: &str = "tui-renderer-metadata.jsonl";
const RAW_FILE: &str = "tui-renderer-raw-ring.jsonl";
/// One generation is retained. Rotation replaces this file rather than
/// appending to it, so the journals cost at most twice `MAX_JOURNAL_BYTES`.
const METADATA_ROTATED_FILE: &str = "tui-renderer-metadata.1.jsonl";
const RAW_ROTATED_FILE: &str = "tui-renderer-raw-ring.1.jsonl";
const MAX_JOURNAL_BYTES: u64 = 8 * 1024 * 1024;
/// How many captured records may wait for the writer thread. Past this the
/// recorder drops rather than waits: a renderer that outruns its own journal
/// must keep rendering, and the drop is accounted for rather than hidden.
const QUEUE_CAPACITY: usize = 4096;
/// v3 added `dropped_since_last`. Records now reach the journal through a
/// bounded queue, so a burst the writer thread cannot keep up with leaves
/// `sequence` gaps. That field says how many records the gap before this one
/// accounts for; a v3 gap is therefore explained rather than unexplained loss,
/// and a v3 reader must not treat a gap as a dropped *envelope* in the
/// projection. v2 and older journals have no such gaps.
///
/// v2 split the single `disposition` field, which used to report an accepted
/// envelope under the name of its event type's declared policy class. It now
/// carries the outcome only, and the class moved to `declared_disposition`.
/// A v1 journal must not be read as if severe `disposition` values were
/// failures: in v1 they usually were not.
const DIAGNOSTIC_SCHEMA_VERSION: u64 = 3;

#[derive(Clone, Default)]
pub(crate) struct RendererDiagnostics {
    channel: Option<Arc<DiagnosticChannel>>,
}

impl std::fmt::Debug for RendererDiagnostics {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("RendererDiagnostics")
            .field("enabled", &self.channel.is_some())
            .finish()
    }
}

impl RendererDiagnostics {
    pub(crate) fn from_state_root(state_root: &Path) -> io::Result<Self> {
        Self::new(
            state_root.join("debug"),
            std::env::var(RAW_EVENT_DUMP_ENV).as_deref() == Ok("1"),
            MAX_JOURNAL_BYTES,
        )
    }

    fn new(directory: PathBuf, raw_enabled: bool, max_bytes: u64) -> io::Result<Self> {
        // Opening the journals here rather than on the writer thread keeps the
        // failure reportable: a caller that cannot record still learns why.
        let sink = DiagnosticSink::new(directory, raw_enabled, max_bytes)?;
        let (sender, receiver) = mpsc::sync_channel(QUEUE_CAPACITY);
        // The handle is deliberately dropped. The thread ends when the last
        // recorder is dropped, after draining what is still queued.
        std::thread::Builder::new()
            .name("crabcode-renderer-diagnostics".to_string())
            .spawn(move || run_writer(&receiver, sink))?;
        Ok(Self {
            channel: Some(Arc::new(DiagnosticChannel {
                sender,
                dropped: AtomicU64::new(0),
            })),
        })
    }

    /// `outcome` is what actually happened to the envelope;
    /// `declared_disposition` is the contract's static policy class for its
    /// event type. Keeping them apart is what lets a reader tell a severe
    /// policy from a severe result.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn record_envelope(
        &self,
        envelope: &RawEnvelope,
        turn_generation: u64,
        block_generation: Option<u64>,
        outcome: &str,
        declared_disposition: Option<&str>,
        issue_code: Option<&str>,
        root_error_code: Option<&str>,
        compatibility_count: usize,
    ) {
        let Some(channel) = self.channel.as_ref() else {
            return;
        };
        // Claim the outstanding losses before capturing: whichever record
        // reaches the journal first reports them, and a record that cannot be
        // queued hands them back together with itself.
        let dropped_since_last = channel.dropped.swap(0, Ordering::Relaxed);
        let pending = PendingRecord {
            value: envelope.value.clone(),
            sequence: envelope.sequence,
            encoded_len: envelope.encoded_len,
            turn_generation,
            block_generation,
            outcome: outcome.into(),
            declared_disposition: declared_disposition.map(Box::from),
            issue_code: issue_code.map(Box::from),
            root_error_code: root_error_code.map(Box::from),
            compatibility_count,
            dropped_since_last,
        };
        // One message per envelope, so a full queue can never leave the raw
        // journal describing an envelope the metadata journal lost.
        if channel
            .sender
            .try_send(DiagnosticMessage::Record(pending))
            .is_err()
        {
            channel.return_claim_with_loss(dropped_since_last);
        }
    }

    #[cfg(test)]
    fn flush_for_test(&self) {
        let Some(channel) = self.channel.as_ref() else {
            return;
        };
        let (acknowledge, acknowledged) = mpsc::channel();
        if channel
            .sender
            .send(DiagnosticMessage::Barrier(acknowledge))
            .is_ok()
        {
            let _ = acknowledged.recv();
        }
    }

    /// Holds the writer thread until the returned sender is dropped. Recording
    /// must stay non-blocking while it is held.
    #[cfg(test)]
    fn block_writer_for_test(&self) -> mpsc::Sender<()> {
        let channel = self.channel.as_ref().expect("a blocked writer exists");
        let (release, gate) = mpsc::channel();
        let (ready, blocked) = mpsc::channel();
        channel
            .sender
            .send(DiagnosticMessage::Block { ready, gate })
            .expect("the writer thread accepts the gate");
        blocked.recv().expect("the writer thread reaches the gate");
        release
    }
}

struct DiagnosticChannel {
    sender: SyncSender<DiagnosticMessage>,
    dropped: AtomicU64,
}

impl DiagnosticChannel {
    /// Return a claimed loss count together with the record that just failed,
    /// so the next record that lands reports both.
    fn return_claim_with_loss(&self, claimed: u64) {
        self.dropped
            .fetch_add(claimed.saturating_add(1), Ordering::Relaxed);
    }
}

enum DiagnosticMessage {
    Record(PendingRecord),
    /// Flushes both journals and acknowledges, so a test can read what it
    /// recorded without racing the writer thread.
    #[cfg(test)]
    Barrier(mpsc::Sender<()>),
    #[cfg(test)]
    Block {
        ready: mpsc::Sender<()>,
        gate: Receiver<()>,
    },
}

/// Everything a journal record is derived from, captured on the recording
/// thread and built into records on the writer thread.
///
/// Building a record costs a canonical shape, a SHA-256 over it and two
/// serializations — about 420 µs per envelope in an unoptimized build against
/// 19 µs to clone the value it describes. Capturing rather than encoding is
/// what keeps that cost off the thread that owns the keyboard; the writer
/// thread has nothing else to do with it.
struct PendingRecord {
    value: Value,
    sequence: u64,
    encoded_len: usize,
    turn_generation: u64,
    block_generation: Option<u64>,
    outcome: Box<str>,
    declared_disposition: Option<Box<str>>,
    issue_code: Option<Box<str>>,
    root_error_code: Option<Box<str>>,
    compatibility_count: usize,
    /// Losses this record accounts for, claimed when it was captured.
    dropped_since_last: u64,
}

/// Flush when the queue drains rather than after every record: a burst
/// coalesces into few writes, and the moment the renderer goes quiet the
/// journal on disk is already complete, which is what keeps an abrupt process
/// exit from costing anything worth replaying.
fn run_writer(receiver: &Receiver<DiagnosticMessage>, mut sink: DiagnosticSink) {
    while let Ok(message) = receiver.recv() {
        sink.handle(message);
        while let Ok(next) = receiver.try_recv() {
            sink.handle(next);
        }
        sink.flush();
    }
    // `recv` fails only once every sender is gone *and* the queue is empty, so
    // everything that was queued has been written by the time we get here.
    sink.flush();
}

struct DiagnosticSink {
    metadata: JournalWriter,
    raw: Option<JournalWriter>,
}

impl DiagnosticSink {
    fn new(directory: PathBuf, raw_enabled: bool, max_bytes: u64) -> io::Result<Self> {
        prepare_private_directory(&directory)?;
        let metadata = JournalWriter::open(
            directory.join(METADATA_FILE),
            directory.join(METADATA_ROTATED_FILE),
            max_bytes,
        )?;
        let raw = if raw_enabled {
            Some(JournalWriter::open(
                directory.join(RAW_FILE),
                directory.join(RAW_ROTATED_FILE),
                max_bytes,
            )?)
        } else {
            None
        };
        Ok(Self { metadata, raw })
    }

    fn handle(&mut self, message: DiagnosticMessage) {
        match message {
            DiagnosticMessage::Record(pending) => {
                if let Some(line) = encode_line(&metadata_record(&pending)) {
                    self.metadata.append(&line);
                }
                if let Some(journal) = self.raw.as_mut()
                    && let Some(line) = encode_line(&raw_record(&pending))
                {
                    journal.append(&line);
                }
            }
            #[cfg(test)]
            DiagnosticMessage::Barrier(acknowledge) => {
                self.flush();
                let _ = acknowledge.send(());
            }
            #[cfg(test)]
            DiagnosticMessage::Block { ready, gate } => {
                let _ = ready.send(());
                let _ = gate.recv();
            }
        }
    }

    fn flush(&mut self) {
        self.metadata.flush();
        if let Some(raw) = self.raw.as_mut() {
            raw.flush();
        }
    }
}

/// A journal file held open for the life of the process. The symlink and
/// regular-file checks that used to run per record now run per handle — once
/// at startup and once per rotation — because that is the only moment at which
/// the file this handle refers to can still change.
struct JournalWriter {
    path: PathBuf,
    rotated_path: PathBuf,
    max_bytes: u64,
    file: Option<BufWriter<File>>,
    written: u64,
}

impl JournalWriter {
    fn open(path: PathBuf, rotated_path: PathBuf, max_bytes: u64) -> io::Result<Self> {
        let (file, written) = open_private_journal(&path)?;
        Ok(Self {
            path,
            rotated_path,
            max_bytes,
            file: Some(BufWriter::new(file)),
            written,
        })
    }

    fn append(&mut self, line: &[u8]) {
        if self.write_line(line).is_err() {
            // Fail-soft: a journal that cannot be written is closed instead of
            // retried per record, so a broken disk cannot turn diagnostics
            // into a second failure competing for it.
            self.file = None;
        }
    }

    fn write_line(&mut self, line: &[u8]) -> io::Result<()> {
        if self.file.is_none() {
            return Ok(());
        }
        let length = line.len() as u64;
        if length > self.max_bytes {
            return Ok(());
        }
        if self.written.saturating_add(length) > self.max_bytes {
            self.rotate()?;
        }
        let Some(file) = self.file.as_mut() else {
            return Ok(());
        };
        file.write_all(line)?;
        self.written = self.written.saturating_add(length);
        Ok(())
    }

    /// Rename the full journal aside and start a new one. Truncating instead
    /// would discard the history the journal exists to preserve; renaming
    /// keeps exactly one previous generation, which the next rotation
    /// replaces.
    fn rotate(&mut self) -> io::Result<()> {
        if let Some(mut file) = self.file.take() {
            let _ = file.flush();
        }
        // The rename replaces whatever occupies the rotated path, including a
        // symlink planted there, without following it.
        fs::rename(&self.path, &self.rotated_path)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            fs::set_permissions(&self.rotated_path, fs::Permissions::from_mode(0o600))?;
        }
        let (file, written) = open_private_journal(&self.path)?;
        self.file = Some(BufWriter::new(file));
        self.written = written;
        Ok(())
    }

    fn flush(&mut self) {
        if let Some(file) = self.file.as_mut()
            && file.flush().is_err()
        {
            self.file = None;
        }
    }
}

fn encode_line(value: &Value) -> Option<Vec<u8>> {
    let mut bytes = serde_json::to_vec(value).ok()?;
    bytes.push(b'\n');
    Some(bytes)
}

fn raw_record(pending: &PendingRecord) -> Value {
    json!({
        "sequence": pending.sequence,
        "envelope_type": safe_discriminator(pending.value.get("type").and_then(Value::as_str)),
        "stream_event_type": safe_discriminator(pending.value.pointer("/event/type").and_then(Value::as_str)),
        "value": redact_value(&pending.value),
    })
}

fn metadata_record(pending: &PendingRecord) -> Value {
    let PendingRecord {
        value,
        sequence,
        encoded_len,
        turn_generation,
        block_generation,
        outcome,
        declared_disposition,
        issue_code,
        root_error_code,
        compatibility_count,
        dropped_since_last,
    } = pending;
    let event = value.get("event");
    let shape = canonical_type_shape(value);
    let shape_bytes = serde_json::to_vec(&shape).expect("canonical diagnostic shape encodes");
    let shape_hash = Sha256::digest(shape_bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();

    json!({
        "schema_version": DIAGNOSTIC_SCHEMA_VERSION,
        "sequence": sequence,
        "encoded_len": encoded_len,
        "envelope_type": safe_discriminator(value.get("type").and_then(Value::as_str)),
        "stream_event_type": safe_discriminator(event.and_then(|event| event.get("type")).and_then(Value::as_str)),
        // What actually happened to this envelope. "accepted" unless the
        // projection reported a fault, so a scan for failures is a scan of
        // this field alone.
        "disposition": outcome,
        // The contract's static policy class for the event type: what *would*
        // happen if this envelope were rejected. Severe values here are normal
        // in a healthy session and are not failures.
        "declared_disposition": declared_disposition,
        "issue_code": issue_code,
        "root_error_code": root_error_code,
        "turn_generation": turn_generation,
        "block_generation": block_generation,
        "known_fields_bitmap": known_fields_bitmap(value),
        "event_known_fields_bitmap": event.map(known_fields_bitmap),
        "unknown_field_count": unknown_field_count(value),
        "event_unknown_field_count": event.map(unknown_field_count),
        "top_level_array_lengths": top_level_array_lengths(value),
        "compatibility_count": compatibility_count,
        // Envelopes recorded since the previous journal line whose record the
        // bounded queue could not accept. Non-zero means the renderer outran
        // the writer thread and kept rendering, which is the intended
        // trade: it explains a `sequence` gap that is not a projection fault.
        "dropped_since_last": dropped_since_last,
        "shape_sha256": shape_hash,
    })
}

const KNOWN_FIELDS: &[&str] = &[
    "type",
    "subtype",
    "event",
    "message",
    "content",
    "content_block",
    "delta",
    "error",
    "sources",
    "session_id",
    "parent_tool_use_id",
    "request_id",
    "request",
    "response",
    "uuid",
    "timestamp",
    "index",
    "title",
    "url",
    "snippet",
    "id",
    "role",
    "usage",
    "tools",
    "mcp_servers",
    "permission_denials",
];

fn safe_discriminator(value: Option<&str>) -> Option<String> {
    value.map(|value| {
        if value.len() <= 64
            && value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
        {
            value.to_string()
        } else {
            "$invalid".to_string()
        }
    })
}

fn known_fields_bitmap(value: &Value) -> String {
    let bits = value.as_object().map_or(0_u64, |object| {
        KNOWN_FIELDS
            .iter()
            .enumerate()
            .fold(0_u64, |bits, (index, field)| {
                bits | u64::from(object.contains_key(*field)) << index
            })
    });
    format!("{bits:016x}")
}

fn unknown_field_count(value: &Value) -> usize {
    value.as_object().map_or(0, |object| {
        object
            .keys()
            .filter(|key| !KNOWN_FIELDS.contains(&key.as_str()))
            .count()
    })
}

fn top_level_array_lengths(value: &Value) -> Value {
    let lengths = [
        "content",
        "sources",
        "tools",
        "mcp_servers",
        "permission_denials",
    ]
    .into_iter()
    .map(|field| {
        value
            .get(field)
            .and_then(Value::as_array)
            .map_or(Value::Null, |array| json!(array.len()))
    })
    .collect::<Vec<_>>();
    Value::Array(lengths)
}

fn canonical_type_shape(value: &Value) -> Value {
    match value {
        Value::Null => Value::String("$null".to_string()),
        Value::Bool(_) => Value::String("$bool".to_string()),
        Value::Number(_) => Value::String("$number".to_string()),
        Value::String(_) => Value::String("$string".to_string()),
        Value::Array(values) => Value::Array(values.iter().map(canonical_type_shape).collect()),
        Value::Object(object) => {
            let mut known = object
                .iter()
                .filter(|(key, _)| KNOWN_FIELDS.contains(&key.as_str()))
                .map(|(key, value)| (key.clone(), canonical_type_shape(value)))
                .collect::<Vec<_>>();
            known.sort_by(|left, right| left.0.cmp(&right.0));
            let mut result = known.into_iter().collect::<Map<_, _>>();
            let mut unknown = object
                .iter()
                .filter(|(key, _)| !KNOWN_FIELDS.contains(&key.as_str()))
                .map(|(_, value)| canonical_type_shape(value))
                .collect::<Vec<_>>();
            unknown.sort_by_key(|shape| serde_json::to_string(shape).unwrap_or_default());
            if !unknown.is_empty() {
                result.insert("$unknown".to_string(), Value::Array(unknown));
            }
            Value::Object(result)
        }
    }
}

fn redact_value(value: &Value) -> Value {
    redact_value_for_key(None, value)
}

fn redact_value_for_key(key: Option<&str>, value: &Value) -> Value {
    if key.is_some_and(sensitive_key) {
        return Value::String("<redacted>".to_string());
    }
    match value {
        Value::Object(object) => {
            let mut result = object
                .iter()
                .filter(|(key, _)| KNOWN_FIELDS.contains(&key.as_str()))
                .map(|(key, value)| (key.clone(), redact_value_for_key(Some(key), value)))
                .collect::<Map<_, _>>();
            let mut unknown = object
                .iter()
                .filter(|(key, _)| !KNOWN_FIELDS.contains(&key.as_str()))
                .map(|(_, value)| redact_value_for_key(None, value))
                .collect::<Vec<_>>();
            unknown.sort_by_key(|value| serde_json::to_string(value).unwrap_or_default());
            if !unknown.is_empty() {
                result.insert("$unknown".to_string(), Value::Array(unknown));
            }
            Value::Object(result)
        }
        Value::Array(values) => Value::Array(
            values
                .iter()
                .map(|value| redact_value_for_key(key, value))
                .collect(),
        ),
        Value::String(value)
            if key.is_some_and(|key| matches!(key, "type" | "subtype" | "kind" | "status")) =>
        {
            Value::String(safe_discriminator(Some(value)).unwrap_or_else(|| "$invalid".to_string()))
        }
        Value::String(_) => Value::String("<redacted:string>".to_string()),
        Value::Null => Value::String("$null".to_string()),
        Value::Bool(_) => Value::String("$bool".to_string()),
        Value::Number(_) => Value::String("$number".to_string()),
    }
}

fn sensitive_key(key: &str) -> bool {
    let normalized = key
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect::<String>();
    [
        "authorization",
        "accesstoken",
        "refreshtoken",
        "apikey",
        "password",
        "passwd",
        "secret",
        "cookie",
        "sessiontoken",
        "privatekey",
        "prompt",
        "query",
        "title",
        "url",
        "snippet",
        "token",
        "toolinput",
        "tooloutput",
    ]
    .iter()
    .any(|needle| normalized.contains(needle))
}

fn prepare_private_directory(path: &Path) -> io::Result<()> {
    if let Ok(metadata) = fs::symlink_metadata(path)
        && (metadata.file_type().is_symlink() || !metadata.is_dir())
    {
        return Err(io::Error::other(
            "renderer diagnostic path must be a real directory",
        ));
    }
    fs::create_dir_all(path)?;
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(io::Error::other(
            "renderer diagnostic path must remain a real directory",
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

/// Opens the journal for append and returns its current length. Every safety
/// check the per-record path used to repeat happens here, on the handle that
/// will serve every subsequent record.
fn open_private_journal(path: &Path) -> io::Result<(File, u64)> {
    reject_unsafe_file(path)?;
    let mut options = OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    let file = options.open(path)?;
    enforce_private_file(&file)?;
    let written = file.metadata()?.len();
    Ok((file, written))
}

fn reject_unsafe_file(path: &Path) -> io::Result<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => Err(
            io::Error::other("renderer diagnostic journal must be a regular file"),
        ),
        Ok(_) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

fn enforce_private_file(file: &File) -> io::Result<()> {
    if !file.metadata()?.is_file() {
        return Err(io::Error::other(
            "renderer diagnostic journal must remain a regular file",
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        file.set_permissions(fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::time::{Duration, Instant};

    use serde_json::json;

    use super::*;
    use crate::sdk_runtime::EnvelopeClass;

    fn envelope(sequence: u64, value: Value) -> RawEnvelope {
        RawEnvelope {
            sequence,
            encoded_len: serde_json::to_vec(&value).unwrap().len(),
            value,
            classification: EnvelopeClass::StreamEvent {
                event_type: Some("content_block_start".to_string()),
            },
            correlation: None,
        }
    }

    fn streaming_envelope(sequence: u64) -> RawEnvelope {
        envelope(
            sequence,
            json!({
                "type": "stream_event",
                "event": {
                    "type": "content_block_delta",
                    "index": 0,
                    "delta": {"type": "text_delta", "text": "a streamed token"}
                }
            }),
        )
    }

    fn record(recorder: &RendererDiagnostics, envelope: &RawEnvelope) {
        recorder.record_envelope(
            envelope,
            3,
            None,
            "accepted",
            Some("presentation-only"),
            None,
            None,
            0,
        );
    }

    fn read_records(path: &Path) -> Vec<Value> {
        fs::read_to_string(path)
            .unwrap()
            .lines()
            .filter(|line| !line.is_empty())
            .map(|line| serde_json::from_str::<Value>(line).unwrap())
            .collect()
    }

    fn pending(
        envelope: &RawEnvelope,
        turn_generation: u64,
        block_generation: Option<u64>,
        outcome: &str,
        declared_disposition: Option<&str>,
        issue_code: Option<&str>,
        root_error_code: Option<&str>,
    ) -> PendingRecord {
        PendingRecord {
            value: envelope.value.clone(),
            sequence: envelope.sequence,
            encoded_len: envelope.encoded_len,
            turn_generation,
            block_generation,
            outcome: outcome.into(),
            declared_disposition: declared_disposition.map(Box::from),
            issue_code: issue_code.map(Box::from),
            root_error_code: root_error_code.map(Box::from),
            compatibility_count: 0,
            dropped_since_last: 0,
        }
    }

    #[test]
    fn default_recorder_is_an_explicit_no_op() {
        let recorder = RendererDiagnostics::default();
        assert!(recorder.channel.is_none());
        recorder.record_envelope(
            &envelope(0, json!({"type":"stream_event","event":{"type":"ping"}})),
            0,
            None,
            "accepted",
            Some("presentation-only"),
            None,
            None,
            0,
        );
        assert!(recorder.channel.is_none());
    }

    #[test]
    fn metadata_is_an_allowlist_and_excludes_prompt_content() {
        let raw = envelope(
            12,
            json!({
                "type": "stream_event",
                "event": {
                    "type": "content_block_start",
                    "index": 2,
                    "message": {"id": "message-1"},
                    "content_block": {"type": "text", "text": "private prompt"}
                },
                "api_key": "sk-secret"
            }),
        );
        let encoded = serde_json::to_string(&metadata_record(&pending(
            &raw,
            4,
            Some(1),
            "turn-fatal",
            Some("turn-fatal"),
            Some("content_block_start_invalid"),
            Some("projection_turn_fatal"),
        )))
        .unwrap();
        assert!(encoded.contains("content_block_start_invalid"));
        assert!(encoded.contains("block_generation"));
        assert!(encoded.contains("\"schema_version\":3"));
        assert!(encoded.contains("\"dropped_since_last\":0"));
        assert!(!encoded.contains("message-1"));
        assert!(!encoded.contains("private prompt"));
        assert!(!encoded.contains("sk-secret"));
    }

    #[test]
    fn raw_dump_redacts_secret_keys_and_token_shaped_values() {
        let redacted = redact_value(&json!({
            "authorization": "Bearer secret",
            "nested": {"apiKey": "sk-secret"},
            "text": "Bearer another-secret",
            "ordinary": "visible",
            "private_field_name": 424242,
            "event": {
                "type": "ping",
                "private_nested_field": true,
                "index": 7
            }
        }));
        let encoded = serde_json::to_string(&redacted).unwrap();
        assert!(!encoded.contains("secret"));
        assert!(!encoded.contains("visible"));
        assert!(!encoded.contains("private_field_name"));
        assert!(!encoded.contains("private_nested_field"));
        assert!(!encoded.contains("424242"));
        assert!(!encoded.contains("\"index\":7"));
        assert!(encoded.contains("\"index\":\"$number\""));
        assert!(encoded.contains("$unknown"));
        assert!(encoded.contains("redacted:string"));
    }

    #[cfg(unix)]
    #[test]
    fn journal_open_rejects_a_symlink_substitution() {
        use std::os::unix::fs::symlink;

        let temporary = tempfile::tempdir().unwrap();
        let target = temporary.path().join("target");
        let journal = temporary.path().join("journal.jsonl");
        fs::write(&target, b"unchanged").unwrap();
        symlink(&target, &journal).unwrap();

        let error = open_private_journal(&journal)
            .expect_err("a substituted symlink must be rejected")
            .to_string();
        assert!(error.contains("must be a regular file"), "{error}");
        assert_eq!(fs::read(&target).unwrap(), b"unchanged");

        // The same substitution must also be refused when it is the whole
        // sink that opens the journals.
        let directory = temporary.path().join("diagnostics");
        fs::create_dir_all(&directory).unwrap();
        symlink(&target, directory.join(METADATA_FILE)).unwrap();
        DiagnosticSink::new(directory, false, 700)
            .err()
            .expect("the sink refuses a substituted journal");
        assert_eq!(fs::read(&target).unwrap(), b"unchanged");
    }

    #[test]
    fn journals_are_private_and_bounded() {
        let temporary = tempfile::tempdir().unwrap();
        let directory = temporary.path().join("diagnostics");
        let recorder = RendererDiagnostics::new(directory.clone(), true, 700).unwrap();
        for sequence in 0..40 {
            record(
                &recorder,
                &envelope(
                    sequence,
                    json!({
                        "type": "stream_event",
                        "event": {"type": "ping"},
                        "token": "sk-secret"
                    }),
                ),
            );
        }
        recorder.flush_for_test();
        for file_name in [
            METADATA_FILE,
            RAW_FILE,
            METADATA_ROTATED_FILE,
            RAW_ROTATED_FILE,
        ] {
            let path = directory.join(file_name);
            let metadata = fs::metadata(&path).unwrap();
            assert!(
                metadata.len() <= 700,
                "{file_name} is {} bytes",
                metadata.len()
            );
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt as _;
                assert_eq!(metadata.permissions().mode() & 0o777, 0o600);
            }
        }
        assert!(
            !fs::read_to_string(directory.join(RAW_FILE))
                .unwrap()
                .contains("sk-secret")
        );
    }

    #[test]
    fn explicit_recorder_writes_only_below_the_injected_state_root() {
        let temporary = tempfile::tempdir().unwrap();
        let recorder = RendererDiagnostics::from_state_root(temporary.path()).unwrap();
        record(
            &recorder,
            &envelope(
                7,
                json!({
                    "type":"stream_event",
                    "event":{"type":"sources","sources":[]}
                }),
            ),
        );
        recorder.flush_for_test();
        assert!(temporary.path().join("debug").join(METADATA_FILE).is_file());
    }

    /// The audit's budget for ten thousand records is 200 ms, against the
    /// 1.675 ms per envelope that the synchronous open/stat/write/close this
    /// replaced cost on Windows: roughly 16.7 s of the thread that owns the
    /// keyboard for the ten thousand envelopes one answer can produce.
    ///
    /// Ten thousand records measure 161 ms idle and 196 ms under load on the
    /// audited machine in an unoptimized build — inside that budget, but by
    /// too little to assert on a slower machine, and `cargo test`, CI
    /// included, builds unoptimized. The unoptimized budget is therefore 1 s.
    /// Both budgets still fail if the record is built on this thread (8.8 s
    /// measured) or if the write returns to it (16.7 s measured), which are
    /// the regressions worth catching.
    const RECORDING_BUDGET: Duration = if cfg!(debug_assertions) {
        Duration::from_secs(1)
    } else {
        Duration::from_millis(200)
    };

    #[test]
    fn ten_thousand_records_do_not_stall_the_calling_thread() {
        let temporary = tempfile::tempdir().unwrap();
        let recorder = RendererDiagnostics::new(
            temporary.path().join("diagnostics"),
            false,
            MAX_JOURNAL_BYTES,
        )
        .unwrap();
        let mut envelope = streaming_envelope(0);

        let started = Instant::now();
        for sequence in 0..10_000 {
            envelope.sequence = sequence;
            record(&recorder, &envelope);
        }
        let elapsed = started.elapsed();

        recorder.flush_for_test();
        println!("10,000 records cost the calling thread {elapsed:?}");
        assert!(
            elapsed < RECORDING_BUDGET,
            "recording 10,000 envelopes cost the calling thread {elapsed:?}"
        );
    }

    #[test]
    fn a_blocked_writer_drops_records_instead_of_blocking_the_caller() {
        let temporary = tempfile::tempdir().unwrap();
        let directory = temporary.path().join("diagnostics");
        let recorder =
            RendererDiagnostics::new(directory.clone(), false, MAX_JOURNAL_BYTES).unwrap();
        let release = recorder.block_writer_for_test();

        let attempted = QUEUE_CAPACITY as u64 + 256;
        let mut envelope = streaming_envelope(0);
        let started = Instant::now();
        for sequence in 0..attempted {
            envelope.sequence = sequence;
            record(&recorder, &envelope);
        }
        let elapsed = started.elapsed();
        // A blocking send would never return here: the writer thread is held
        // and the queue is long past full.
        assert!(
            elapsed < RECORDING_BUDGET,
            "recording against a blocked writer cost {elapsed:?}"
        );

        drop(release);
        recorder.flush_for_test();
        let queued = read_records(&directory.join(METADATA_FILE));
        assert!(
            (queued.len() as u64) < attempted,
            "the bounded queue must have dropped records"
        );
        assert!(
            queued
                .iter()
                .all(|record| record["dropped_since_last"] == json!(0)),
            "nothing was lost before the queue filled"
        );

        envelope.sequence = attempted;
        record(&recorder, &envelope);
        recorder.flush_for_test();
        let records = read_records(&directory.join(METADATA_FILE));
        assert_eq!(records.len(), queued.len() + 1);
        let last = records.last().unwrap();
        assert_eq!(last["sequence"], json!(attempted));
        // Every attempt is accounted for: it is either a line in the journal
        // or one of the losses this line reports.
        assert_eq!(
            last["dropped_since_last"],
            json!(attempted - queued.len() as u64)
        );
        assert!(last["dropped_since_last"].as_u64().unwrap() > 0);
    }

    #[test]
    fn reaching_the_bound_rotates_the_journal_instead_of_discarding_history() {
        let temporary = tempfile::tempdir().unwrap();
        let directory = temporary.path().join("diagnostics");
        let max_bytes = 20_000;
        let recorder = RendererDiagnostics::new(directory.clone(), false, max_bytes).unwrap();

        record(&recorder, &streaming_envelope(0));
        recorder.flush_for_test();
        let line_bytes = fs::metadata(directory.join(METADATA_FILE)).unwrap().len();
        assert!(line_bytes > 0);

        // Just past a single bound, so exactly one rotation happens and the
        // rotated generation still begins at sequence 0.
        let attempted = max_bytes / line_bytes + 3;
        for sequence in 1..attempted {
            record(&recorder, &streaming_envelope(sequence));
        }
        recorder.flush_for_test();

        let rotated = directory.join(METADATA_ROTATED_FILE);
        assert!(rotated.is_file(), "the filled generation must be kept");
        let rotated_records = read_records(&rotated);
        let current_records = read_records(&directory.join(METADATA_FILE));
        assert_eq!(
            rotated_records.first().unwrap()["sequence"],
            json!(0),
            "the oldest record must survive the roll"
        );
        assert_eq!(
            rotated_records.len() + current_records.len(),
            attempted as usize,
            "no record may be lost across the roll"
        );
        assert_eq!(
            current_records.last().unwrap()["sequence"],
            json!(attempted - 1)
        );
        for path in [directory.join(METADATA_FILE), rotated] {
            let metadata = fs::metadata(&path).unwrap();
            assert!(metadata.len() <= max_bytes);
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt as _;
                assert_eq!(metadata.permissions().mode() & 0o777, 0o600);
            }
        }
    }

    #[test]
    fn a_second_rotation_replaces_the_single_retained_generation() {
        let temporary = tempfile::tempdir().unwrap();
        let directory = temporary.path().join("diagnostics");
        let max_bytes = 4_000;
        let recorder = RendererDiagnostics::new(directory.clone(), false, max_bytes).unwrap();

        record(&recorder, &streaming_envelope(0));
        recorder.flush_for_test();
        let line_bytes = fs::metadata(directory.join(METADATA_FILE)).unwrap().len();
        let per_generation = max_bytes / line_bytes;
        for sequence in 1..(per_generation * 3 + 6) {
            record(&recorder, &streaming_envelope(sequence));
        }
        recorder.flush_for_test();

        let rotated = read_records(&directory.join(METADATA_ROTATED_FILE));
        assert!(
            rotated.first().unwrap()["sequence"].as_u64().unwrap() > 0,
            "only one generation is retained, so sequence 0 is gone"
        );
        assert_eq!(fs::read_dir(&directory).unwrap().count(), 2);
    }
}
