//! Bounded, privacy-conscious renderer diagnostics.
//!
//! Metadata is recorded by default so a presentation failure can be replayed
//! without preserving prompts or tool output. A redacted raw-event journal is
//! available only when `CRABCODE_TUI_RAW_EVENT_DUMP=1` is set. Diagnostic I/O
//! is deliberately fail-soft: it must never become a second runtime failure.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde_json::{Map, Value, json};
use sha2::{Digest as _, Sha256};

use crate::sdk_runtime::RawEnvelope;

const RAW_EVENT_DUMP_ENV: &str = "CRABCODE_TUI_RAW_EVENT_DUMP";
const METADATA_FILE: &str = "tui-renderer-metadata.jsonl";
const RAW_FILE: &str = "tui-renderer-raw-ring.jsonl";
const MAX_JOURNAL_BYTES: u64 = 8 * 1024 * 1024;
/// v2 split the single `disposition` field, which used to report an accepted
/// envelope under the name of its event type's declared policy class. It now
/// carries the outcome only, and the class moved to `declared_disposition`.
/// A v1 journal must not be read as if severe `disposition` values were
/// failures: in v1 they usually were not.
const DIAGNOSTIC_SCHEMA_VERSION: u64 = 2;

#[derive(Clone, Default)]
pub(crate) struct RendererDiagnostics {
    sink: Option<Arc<Mutex<DiagnosticSink>>>,
}

impl std::fmt::Debug for RendererDiagnostics {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("RendererDiagnostics")
            .field("enabled", &self.sink.is_some())
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
        Ok(Self {
            sink: Some(Arc::new(Mutex::new(DiagnosticSink::new(
                directory,
                raw_enabled,
                max_bytes,
            )?))),
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
        let Some(sink) = self.sink.as_ref() else {
            return;
        };
        let Ok(mut sink) = sink.lock() else {
            return;
        };
        let _ = sink.record(
            envelope,
            turn_generation,
            block_generation,
            outcome,
            declared_disposition,
            issue_code,
            root_error_code,
            compatibility_count,
        );
    }
}

struct DiagnosticSink {
    directory: PathBuf,
    raw_enabled: bool,
    max_bytes: u64,
}

impl DiagnosticSink {
    fn new(directory: PathBuf, raw_enabled: bool, max_bytes: u64) -> io::Result<Self> {
        prepare_private_directory(&directory)?;
        Ok(Self {
            directory,
            raw_enabled,
            max_bytes,
        })
    }

    fn record(
        &mut self,
        envelope: &RawEnvelope,
        turn_generation: u64,
        block_generation: Option<u64>,
        outcome: &str,
        declared_disposition: Option<&str>,
        issue_code: Option<&str>,
        root_error_code: Option<&str>,
        compatibility_count: usize,
    ) -> io::Result<()> {
        let metadata = metadata_record(
            envelope,
            turn_generation,
            block_generation,
            outcome,
            declared_disposition,
            issue_code,
            root_error_code,
            compatibility_count,
        );
        append_bounded_json_line(
            &self.directory.join(METADATA_FILE),
            &metadata,
            self.max_bytes,
        )?;

        if self.raw_enabled {
            let raw = json!({
                "sequence": envelope.sequence,
                "envelope_type": safe_discriminator(envelope.value.get("type").and_then(Value::as_str)),
                "stream_event_type": safe_discriminator(envelope.value.pointer("/event/type").and_then(Value::as_str)),
                "value": redact_value(&envelope.value),
            });
            append_bounded_json_line(&self.directory.join(RAW_FILE), &raw, self.max_bytes)?;
        }
        Ok(())
    }
}

#[allow(clippy::too_many_arguments)]
fn metadata_record(
    envelope: &RawEnvelope,
    turn_generation: u64,
    block_generation: Option<u64>,
    outcome: &str,
    declared_disposition: Option<&str>,
    issue_code: Option<&str>,
    root_error_code: Option<&str>,
    compatibility_count: usize,
) -> Value {
    let value = &envelope.value;
    let event = value.get("event");
    let shape = canonical_type_shape(value);
    let shape_bytes = serde_json::to_vec(&shape).expect("canonical diagnostic shape encodes");
    let shape_hash = Sha256::digest(shape_bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();

    json!({
        "schema_version": DIAGNOSTIC_SCHEMA_VERSION,
        "sequence": envelope.sequence,
        "encoded_len": envelope.encoded_len,
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

fn append_bounded_json_line(path: &Path, value: &Value, max_bytes: u64) -> io::Result<()> {
    reject_unsafe_file(path)?;
    let mut bytes = serde_json::to_vec(value).map_err(io::Error::other)?;
    bytes.push(b'\n');
    if bytes.len() as u64 > max_bytes {
        return Ok(());
    }

    let should_roll = fs::metadata(path)
        .map(|metadata| metadata.len().saturating_add(bytes.len() as u64) > max_bytes)
        .unwrap_or(false);
    let mut options = OpenOptions::new();
    options.create(true).write(true);
    if should_roll {
        options.truncate(true);
    } else {
        options.append(true);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    let mut file = options.open(path)?;
    enforce_private_file(&file)?;
    file.write_all(&bytes)?;
    file.flush()
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

    #[test]
    fn default_recorder_is_an_explicit_no_op() {
        let recorder = RendererDiagnostics::default();
        assert!(recorder.sink.is_none());
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
        assert!(recorder.sink.is_none());
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
        let encoded = serde_json::to_string(&metadata_record(
            &raw,
            4,
            Some(1),
            "turn-fatal",
            Some("turn-fatal"),
            Some("content_block_start_invalid"),
            Some("projection_turn_fatal"),
            0,
        ))
        .unwrap();
        assert!(encoded.contains("content_block_start_invalid"));
        assert!(encoded.contains("block_generation"));
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

        let error = append_bounded_json_line(&journal, &json!({"type": "ping"}), 700)
            .expect_err("a substituted symlink must be rejected");
        assert_eq!(error.kind(), io::ErrorKind::Other);
        assert_eq!(fs::read(&target).unwrap(), b"unchanged");
    }

    #[test]
    fn journals_are_private_and_bounded() {
        let temporary = tempfile::tempdir().unwrap();
        let directory = temporary.path().join("diagnostics");
        let mut sink = DiagnosticSink::new(directory.clone(), true, 700).unwrap();
        for sequence in 0..40 {
            sink.record(
                &envelope(
                    sequence,
                    json!({
                        "type": "stream_event",
                        "event": {"type": "ping"},
                        "token": "sk-secret"
                    }),
                ),
                3,
                None,
                "accepted",
                Some("presentation-only"),
                None,
                None,
                0,
            )
            .unwrap();
        }
        for file_name in [METADATA_FILE, RAW_FILE] {
            let path = directory.join(file_name);
            let metadata = fs::metadata(&path).unwrap();
            assert!(metadata.len() <= 700);
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt as _;
                assert_eq!(metadata.permissions().mode() & 0o777, 0o600);
            }
        }
    }

    #[test]
    fn explicit_recorder_writes_only_below_the_injected_state_root() {
        let temporary = tempfile::tempdir().unwrap();
        let recorder = RendererDiagnostics::from_state_root(temporary.path()).unwrap();
        recorder.record_envelope(
            &envelope(
                7,
                json!({
                    "type":"stream_event",
                    "event":{"type":"sources","sources":[]}
                }),
            ),
            1,
            None,
            "accepted",
            Some("presentation-only"),
            None,
            None,
            0,
        );
        assert!(temporary.path().join("debug").join(METADATA_FILE).is_file());
    }
}
