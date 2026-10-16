//! A JSON-string WebAssembly facade for NearLink's protocol validators and
//! bounded reconciliation core.
//!
//! The facade accepts message packets as JSON strings so it can reject inputs
//! above the documented byte limit before asking Serde to parse them. These
//! checks happen after wasm-bindgen has copied JavaScript strings into
//! WebAssembly memory. The core crate remains independent of JavaScript and
//! wasm-bindgen.
//!
//! Every operation returns a JSON string. Failures use stable `code` values
//! and never include packet contents. This binding exposes the core validators
//! and bounded in-memory reconciliation. It does not add persistence, peer
//! identity, authentication, encryption, or transport behavior.

use nearlink_protocol_core::sync::{
    plan_missing_batch, InsertOutcome, InventoryPageOutcome, MessageIndex, MissingIdSelector,
    SyncCoverage, SyncError, SyncInventoryReceiver, SyncMessageOutcome, SyncRequestBook,
    SyncRequestOutcome, MAX_ENVELOPE_BYTES, MAX_SYNC_SELECTION_CHUNK_IDS,
};
use nearlink_protocol_core::{
    classify_inbound_acceptance, is_client_packet, is_history_page_complete_packet,
    is_history_request_packet, is_join_packet, is_message_packet, is_protocol_identifier,
    is_protocol_room, is_protocol_timestamp, is_server_packet, is_sync_inventory_page_packet,
    is_sync_missing_request_packet, is_sync_page_complete_packet, InboundAcceptance,
    InboundAcceptanceError, MAX_PROTOCOL_ENVELOPE_BYTES,
};
use serde_json::{json, Value};
use wasm_bindgen::prelude::*;

/// Maximum JSON byte size accepted for the peer-known-ID array.
///
/// This admits 4,096 protocol IDs at their 128-byte maximum in compact JSON,
/// with room for some whitespace and escaping. Arrays that use extensive JSON
/// escaping may exceed the byte limit even if they decode to valid IDs.
pub const MAX_KNOWN_IDS_JSON_BYTES: usize = 600 * 1024;

/// Stateful coverage outcome aggregator for one caller-managed sync exchange.
#[wasm_bindgen]
#[derive(Default)]
pub struct WasmSyncCoverage {
    inner: SyncCoverage,
}

#[wasm_bindgen]
impl WasmSyncCoverage {
    #[wasm_bindgen(constructor)]
    pub fn new() -> WasmSyncCoverage {
        WasmSyncCoverage::default()
    }

    pub fn mark_incomplete(&mut self) {
        self.inner.mark_incomplete();
    }

    pub fn begin_plan(&mut self) {
        self.inner.begin_plan();
    }

    pub fn finish_plan(&mut self) {
        self.inner.finish_plan();
    }

    pub fn abandon_plan(&mut self) {
        self.inner.abandon_plan();
    }

    pub fn outcome(&self) -> String {
        self.inner.outcome().to_owned()
    }
}

#[derive(Clone, Copy)]
enum ErrorCode {
    InvalidRoom,
    InvalidJson,
    InputTooLarge,
    UnknownValidator,
    InvalidMessage,
    RoomMismatch,
    EnvelopeComplexityLimit,
    EnvelopeTooLarge,
    IndexMessageLimit,
    IndexByteLimit,
    MessageConflict,
    KnownIdLimit,
    InvalidIdentifier,
    InvalidPageLimit,
    InvalidInventoryPage,
    InvalidInventorySequence,
    InventoryConflict,
    InventoryLimit,
    InvalidSyncRequest,
    SyncRequestLimit,
    SyncRequestConflict,
    SyncObservedLimit,
    InvalidSyncCompletion,
}

impl ErrorCode {
    fn as_str(self) -> &'static str {
        match self {
            Self::InvalidRoom => "invalid_room",
            Self::InvalidJson => "invalid_json",
            Self::InputTooLarge => "input_too_large",
            Self::UnknownValidator => "unknown_validator",
            Self::InvalidMessage => "invalid_message",
            Self::RoomMismatch => "room_mismatch",
            Self::EnvelopeComplexityLimit => "envelope_complexity_limit",
            Self::EnvelopeTooLarge => "envelope_too_large",
            Self::IndexMessageLimit => "index_message_limit",
            Self::IndexByteLimit => "index_byte_limit",
            Self::MessageConflict => "message_conflict",
            Self::KnownIdLimit => "known_id_limit",
            Self::InvalidIdentifier => "invalid_identifier",
            Self::InvalidPageLimit => "invalid_page_limit",
            Self::InvalidInventoryPage => "invalid_inventory_page",
            Self::InvalidInventorySequence => "invalid_inventory_sequence",
            Self::InventoryConflict => "inventory_conflict",
            Self::InventoryLimit => "inventory_limit",
            Self::InvalidSyncRequest => "invalid_sync_request",
            Self::SyncRequestLimit => "sync_request_limit",
            Self::SyncRequestConflict => "sync_request_conflict",
            Self::SyncObservedLimit => "sync_observed_limit",
            Self::InvalidSyncCompletion => "invalid_sync_completion",
        }
    }
}

fn acceptance_error_json(error: InboundAcceptanceError) -> String {
    json!({"ok": false, "code": error.code()}).to_string()
}

/// Classify a candidate packet against the room state read by the caller.
/// This bounded, synchronous decision performs no storage or transport work.
#[wasm_bindgen]
pub fn classify_inbound_json(
    expected_room: &str,
    room_deleted: bool,
    candidate_json: &str,
    existing_json: Option<String>,
) -> String {
    if candidate_json.len() > MAX_PROTOCOL_ENVELOPE_BYTES
        || existing_json
            .as_ref()
            .is_some_and(|json| json.len() > MAX_PROTOCOL_ENVELOPE_BYTES)
    {
        return acceptance_error_json(InboundAcceptanceError::InputTooLarge);
    }
    let candidate: Value = match serde_json::from_str(candidate_json) {
        Ok(value) => value,
        Err(_) => return acceptance_error_json(InboundAcceptanceError::InvalidJson),
    };
    let existing = match existing_json.as_deref() {
        Some(encoded) => match serde_json::from_str(encoded) {
            Ok(value) => Some(value),
            Err(_) => return acceptance_error_json(InboundAcceptanceError::InvalidJson),
        },
        None => None,
    };
    match classify_inbound_acceptance(expected_room, room_deleted, &candidate, existing.as_ref()) {
        Ok(outcome) => {
            let outcome = match outcome {
                InboundAcceptance::Saved => "saved",
                InboundAcceptance::Duplicate => "duplicate",
                InboundAcceptance::Conflict => "conflict",
                InboundAcceptance::RoomDeleted => "room_deleted",
            };
            json!({"ok": true, "outcome": outcome}).to_string()
        }
        Err(error) => acceptance_error_json(error),
    }
}

impl From<SyncError> for ErrorCode {
    fn from(error: SyncError) -> Self {
        match error {
            SyncError::InvalidMessage => Self::InvalidMessage,
            SyncError::InvalidRoom => Self::InvalidRoom,
            SyncError::RoomMismatch => Self::RoomMismatch,
            SyncError::EnvelopeComplexityLimit => Self::EnvelopeComplexityLimit,
            SyncError::EnvelopeTooLarge => Self::EnvelopeTooLarge,
            SyncError::IndexMessageLimit => Self::IndexMessageLimit,
            SyncError::IndexByteLimit => Self::IndexByteLimit,
            SyncError::MessageConflict => Self::MessageConflict,
            SyncError::KnownIdLimit => Self::KnownIdLimit,
            SyncError::InvalidIdentifier => Self::InvalidIdentifier,
            SyncError::InvalidPageLimit => Self::InvalidPageLimit,
            SyncError::InvalidInventoryPage => Self::InvalidInventoryPage,
            SyncError::InvalidInventorySequence => Self::InvalidInventorySequence,
            SyncError::InventoryConflict => Self::InventoryConflict,
            SyncError::InventoryLimit => Self::InventoryLimit,
            SyncError::InvalidSyncRequest => Self::InvalidSyncRequest,
            SyncError::SyncRequestLimit => Self::SyncRequestLimit,
            SyncError::SyncRequestConflict => Self::SyncRequestConflict,
            SyncError::SyncObservedLimit => Self::SyncObservedLimit,
            SyncError::InvalidSyncCompletion => Self::InvalidSyncCompletion,
        }
    }
}

fn error_json(code: ErrorCode) -> String {
    json!({"ok": false, "code": code.as_str()}).to_string()
}

fn sync_error_json(error: SyncError) -> String {
    error_json(error.into())
}

/// Run one protocol-core validator against a bounded JSON value.
///
/// Supported names match `packages/protocol/vectors/v1.json`: `client`,
/// `join`, `message`, `history_request`, `server`, `history_page_complete`,
/// `sync_inventory_page`, `sync_missing_request`, `sync_page_complete`,
/// `timestamp`, `identifier`, and `room`.
/// Input above 18 KiB is rejected before JSON parsing. Known validators return
/// `{"ok":true,"valid":true}` or `{"ok":true,"valid":false}`.
#[wasm_bindgen]
pub fn validate_json(validator: &str, value_json: &str) -> String {
    if validator.len() > 32 {
        return error_json(ErrorCode::UnknownValidator);
    }
    if value_json.len() > MAX_ENVELOPE_BYTES {
        return error_json(ErrorCode::InputTooLarge);
    }
    let value: Value = match serde_json::from_str(value_json) {
        Ok(value) => value,
        Err(_) => return error_json(ErrorCode::InvalidJson),
    };
    let valid = match validator {
        "client" => is_client_packet(&value),
        "join" => is_join_packet(&value),
        "message" => is_message_packet(&value),
        "history_request" => is_history_request_packet(&value),
        "server" => is_server_packet(&value),
        "history_page_complete" => is_history_page_complete_packet(&value),
        "sync_inventory_page" => is_sync_inventory_page_packet(&value),
        "sync_missing_request" => is_sync_missing_request_packet(&value),
        "sync_page_complete" => is_sync_page_complete_packet(&value),
        "timestamp" => value.as_str().is_some_and(is_protocol_timestamp),
        "identifier" => value.as_str().is_some_and(is_protocol_identifier),
        "room" => value.as_str().is_some_and(is_protocol_room),
        _ => return error_json(ErrorCode::UnknownValidator),
    };
    json!({"ok": true, "valid": valid}).to_string()
}

/// Return one bounded message-ID batch from a sorted missing-ID plan.
#[wasm_bindgen]
pub fn plan_missing_batch_json(missing_ids_json: &str, offset: usize) -> String {
    if missing_ids_json.len() > MAX_KNOWN_IDS_JSON_BYTES {
        return error_json(ErrorCode::InputTooLarge);
    }
    let missing_ids: Vec<String> = match serde_json::from_str(missing_ids_json) {
        Ok(ids) => ids,
        Err(_) => return error_json(ErrorCode::InvalidJson),
    };
    match plan_missing_batch(&missing_ids, offset) {
        Ok(ids) => {
            let next_offset = offset + ids.len();
            json!({
                "ok": true,
                "ids": ids,
                "nextOffset": next_offset,
                "hasMore": next_offset < missing_ids.len(),
            })
            .to_string()
        }
        Err(error) => sync_error_json(error),
    }
}

/// Stateful bounded selector comparing a peer's inventory with local IDs.
/// The local snapshot is streamed in chunks so local history may exceed the
/// peer inventory limit without allocating a second unbounded set in WASM.
#[wasm_bindgen]
pub struct WasmMissingIdSelector {
    inner: Result<MissingIdSelector, ErrorCode>,
}

#[wasm_bindgen]
impl WasmMissingIdSelector {
    /// Construct from a unique, ascending peer inventory of at most 4,096 IDs.
    #[wasm_bindgen(constructor)]
    pub fn new(peer_ids_json: &str) -> WasmMissingIdSelector {
        if peer_ids_json.len() > MAX_KNOWN_IDS_JSON_BYTES {
            return WasmMissingIdSelector {
                inner: Err(ErrorCode::InputTooLarge),
            };
        }
        let peer_ids: Vec<String> = match serde_json::from_str(peer_ids_json) {
            Ok(ids) => ids,
            Err(_) => {
                return WasmMissingIdSelector {
                    inner: Err(ErrorCode::InvalidJson),
                }
            }
        };
        WasmMissingIdSelector {
            inner: MissingIdSelector::new(&peer_ids).map_err(ErrorCode::from),
        }
    }

    /// Check whether construction succeeded without throwing across the JS boundary.
    pub fn status_json(&self) -> String {
        match &self.inner {
            Ok(_) => "{\"ok\":true}".to_owned(),
            Err(error) => error_json(*error),
        }
    }

    /// Observe one local-ID chunk. Each chunk is limited to 4,096 IDs.
    pub fn observe_local_ids_json(&mut self, local_ids_json: &str) -> String {
        if local_ids_json.len() > MAX_KNOWN_IDS_JSON_BYTES {
            return error_json(ErrorCode::InputTooLarge);
        }
        let local_ids: Vec<String> = match serde_json::from_str(local_ids_json) {
            Ok(ids) => ids,
            Err(_) => return error_json(ErrorCode::InvalidJson),
        };
        if local_ids.len() > MAX_SYNC_SELECTION_CHUNK_IDS {
            return sync_error_json(SyncError::InvalidPageLimit);
        }
        match &mut self.inner {
            Ok(selector) => match selector.observe_local_ids(&local_ids) {
                Ok(()) => "{\"ok\":true}".to_owned(),
                Err(error) => sync_error_json(error),
            },
            Err(error) => error_json(*error),
        }
    }

    /// Finish the local scan and return the peer IDs not present locally.
    pub fn finish_json(&mut self) -> String {
        match &mut self.inner {
            Ok(selector) => match selector.finish() {
                Ok(missing_ids) => json!({ "ok": true, "missingIds": missing_ids }).to_string(),
                Err(error) => sync_error_json(error),
            },
            Err(error) => error_json(*error),
        }
    }
}

/// Stateful facade around one room-scoped bounded message index.
#[wasm_bindgen]
pub struct WasmMessageIndex {
    inner: Result<MessageIndex, SyncError>,
}

#[wasm_bindgen]
impl WasmMessageIndex {
    /// Construct an index for one protocol room.
    ///
    /// The constructor does not throw. Call [`status_json`](Self::status_json)
    /// to check whether the supplied room was valid. Each later operation on
    /// an invalid instance returns `{"ok":false,"code":"invalid_room"}`.
    #[wasm_bindgen(constructor)]
    pub fn new(room: &str) -> WasmMessageIndex {
        WasmMessageIndex {
            inner: MessageIndex::new(room),
        }
    }

    /// Return whether construction succeeded as a stable JSON result.
    pub fn status_json(&self) -> String {
        match &self.inner {
            Ok(_) => "{\"ok\":true}".to_owned(),
            Err(error) => sync_error_json(*error),
        }
    }

    /// Parse and insert a protocol message from JSON.
    ///
    /// Input above 18 KiB is rejected before JSON parsing. Success returns
    /// `{"ok":true,"outcome":"inserted"}` or the same shape with
    /// `"duplicate"`. Failure returns `{"ok":false,"code":"..."}`.
    pub fn insert_json(&mut self, packet_json: &str) -> String {
        if packet_json.len() > MAX_ENVELOPE_BYTES {
            return error_json(ErrorCode::InputTooLarge);
        }
        let packet: Value = match serde_json::from_str(packet_json) {
            Ok(packet) => packet,
            Err(_) => return error_json(ErrorCode::InvalidJson),
        };
        let index = match &mut self.inner {
            Ok(index) => index,
            Err(error) => return sync_error_json(*error),
        };

        match index.insert(packet) {
            Ok(InsertOutcome::Inserted) => "{\"ok\":true,\"outcome\":\"inserted\"}".to_owned(),
            Ok(InsertOutcome::Duplicate) => "{\"ok\":true,\"outcome\":\"duplicate\"}".to_owned(),
            Err(error) => sync_error_json(error),
        }
    }

    /// Return one bounded page of messages absent from a JSON array of IDs.
    ///
    /// Keep `known_ids_json` unchanged while following `nextCursor`. Restart
    /// from `after: None` if the peer-known-ID snapshot changes. A successful
    /// result has `messages`, `nextCursor`, and `hasMore` fields. Errors use
    /// the same stable JSON shape as [`insert_json`](Self::insert_json).
    pub fn page_json(&self, known_ids_json: &str, after: Option<String>, limit: usize) -> String {
        if known_ids_json.len() > MAX_KNOWN_IDS_JSON_BYTES {
            return error_json(ErrorCode::InputTooLarge);
        }
        if after.as_ref().is_some_and(|cursor| cursor.len() > 128) {
            return error_json(ErrorCode::InvalidIdentifier);
        }
        let known_ids: Vec<String> = match serde_json::from_str(known_ids_json) {
            Ok(known_ids) => known_ids,
            Err(_) => return error_json(ErrorCode::InvalidJson),
        };
        let index = match &self.inner {
            Ok(index) => index,
            Err(error) => return sync_error_json(*error),
        };
        let page = match index.page_missing_from(&known_ids, after.as_deref(), limit) {
            Ok(page) => page,
            Err(error) => return sync_error_json(error),
        };

        json!({
            "ok": true,
            "messages": page.messages,
            "nextCursor": page.next_cursor,
            "hasMore": page.has_more,
        })
        .to_string()
    }
}

/// Stateful, bounded receiver for one synchronization inventory sequence.
#[wasm_bindgen]
pub struct WasmSyncInventoryReceiver {
    inner: SyncInventoryReceiver,
}

#[wasm_bindgen]
impl WasmSyncInventoryReceiver {
    #[wasm_bindgen(constructor)]
    pub fn new() -> WasmSyncInventoryReceiver {
        WasmSyncInventoryReceiver {
            inner: SyncInventoryReceiver::new(),
        }
    }

    /// Validate and accept one inventory page or exact retransmission.
    pub fn accept_page_json(&mut self, page_json: &str) -> String {
        if page_json.len() > MAX_ENVELOPE_BYTES {
            return error_json(ErrorCode::InputTooLarge);
        }
        let page: Value = match serde_json::from_str(page_json) {
            Ok(page) => page,
            Err(_) => return error_json(ErrorCode::InvalidJson),
        };
        match self.inner.accept_page(page) {
            Ok(InventoryPageOutcome::Accepted) => json!({
                "ok": true,
                "outcome": "accepted",
                "ids": self.inner.ids(),
                "complete": self.inner.is_complete(),
                "limitReached": self.inner.limit_reached(),
            })
            .to_string(),
            Ok(InventoryPageOutcome::Duplicate) => json!({
                "ok": true,
                "outcome": "duplicate",
                "ids": self.inner.ids(),
                "complete": self.inner.is_complete(),
                "limitReached": self.inner.limit_reached(),
            })
            .to_string(),
            Err(error) => sync_error_json(error),
        }
    }

    pub fn set_missing_ids_json(&mut self, missing_ids_json: &str) -> String {
        if missing_ids_json.len() > MAX_KNOWN_IDS_JSON_BYTES {
            return error_json(ErrorCode::InputTooLarge);
        }
        let missing_ids: Vec<String> = match serde_json::from_str(missing_ids_json) {
            Ok(ids) => ids,
            Err(_) => return error_json(ErrorCode::InvalidJson),
        };
        match self.inner.set_missing_ids(missing_ids) {
            Ok(()) => "{\"ok\":true}".to_owned(),
            Err(error) => sync_error_json(error),
        }
    }

    pub fn next_missing_batch_json(&mut self) -> String {
        match self.inner.next_missing_batch() {
            Ok((ids, has_more)) => json!({"ok": true, "ids": ids, "hasMore": has_more}).to_string(),
            Err(error) => sync_error_json(error),
        }
    }

    pub fn has_missing_plan(&self) -> bool {
        self.inner.has_missing_plan()
    }

    pub fn has_missing_ids_remaining(&self) -> bool {
        self.inner.has_missing_ids_remaining()
    }
}

impl Default for WasmSyncInventoryReceiver {
    fn default() -> Self {
        Self::new()
    }
}

/// Bounded receiver for synchronization requests and their completion packets.
#[wasm_bindgen]
pub struct WasmSyncRequestBook {
    inner: SyncRequestBook,
}

#[wasm_bindgen]
impl WasmSyncRequestBook {
    #[wasm_bindgen(constructor)]
    pub fn new() -> WasmSyncRequestBook {
        WasmSyncRequestBook {
            inner: SyncRequestBook::new(),
        }
    }

    pub fn register_request_json(&mut self, request_json: &str) -> String {
        if request_json.len() > MAX_ENVELOPE_BYTES {
            return error_json(ErrorCode::InputTooLarge);
        }
        let request: Value = match serde_json::from_str(request_json) {
            Ok(request) => request,
            Err(_) => return error_json(ErrorCode::InvalidJson),
        };
        match self.inner.register_request(request) {
            Ok(SyncRequestOutcome::Accepted) => {
                json!({"ok": true, "outcome": "accepted"}).to_string()
            }
            Ok(SyncRequestOutcome::Duplicate) => {
                json!({"ok": true, "outcome": "duplicate"}).to_string()
            }
            Err(error) => sync_error_json(error),
        }
    }

    pub fn accept_completion_json(&mut self, completion_json: &str) -> String {
        if completion_json.len() > MAX_ENVELOPE_BYTES {
            return error_json(ErrorCode::InputTooLarge);
        }
        let completion: Value = match serde_json::from_str(completion_json) {
            Ok(completion) => completion,
            Err(_) => return error_json(ErrorCode::InvalidJson),
        };
        match self.inner.accept_completion(completion) {
            Ok(SyncRequestOutcome::Accepted) => {
                json!({"ok": true, "outcome": "accepted"}).to_string()
            }
            Ok(SyncRequestOutcome::Duplicate) => {
                json!({"ok": true, "outcome": "duplicate"}).to_string()
            }
            Err(error) => sync_error_json(error),
        }
    }

    /// Record a message only after the browser has durably accepted it.
    pub fn observe_message_json(&mut self, message_json: &str) -> String {
        if message_json.len() > MAX_ENVELOPE_BYTES {
            return error_json(ErrorCode::InputTooLarge);
        }
        let message: Value = match serde_json::from_str(message_json) {
            Ok(message) => message,
            Err(_) => return error_json(ErrorCode::InvalidJson),
        };
        match self.inner.observe_message(message) {
            Ok(SyncMessageOutcome::Matched) => {
                json!({"ok": true, "outcome": "matched"}).to_string()
            }
            Ok(SyncMessageOutcome::Unmatched) => {
                json!({"ok": true, "outcome": "unmatched"}).to_string()
            }
            Err(error) => sync_error_json(error),
        }
    }

    pub fn has_outstanding_message_id(&self, id: &str) -> bool {
        self.inner.has_outstanding_message_id(id)
    }

    /// Validate and stage a peer completion while the browser checks storage.
    pub fn stage_completion_json(&mut self, completion_json: &str) -> String {
        if completion_json.len() > MAX_ENVELOPE_BYTES {
            return error_json(ErrorCode::InputTooLarge);
        }
        let completion: Value = match serde_json::from_str(completion_json) {
            Ok(completion) => completion,
            Err(_) => return error_json(ErrorCode::InvalidJson),
        };
        let request_id = completion
            .get("requestId")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned();
        if !self.inner.has_request(&request_id) {
            return json!({"ok": true, "outcome": "unknown"}).to_string();
        }
        match self.inner.stage_completion(completion) {
            Ok(outcome) => {
                let requested = self.inner.requested_ids(&request_id).unwrap_or_default();
                let observed = self.inner.observed_ids(&request_id).unwrap_or_default();
                let completed = self.inner.completion_ids(&request_id).unwrap_or_default();
                json!({"ok": true, "outcome": match outcome { SyncRequestOutcome::Accepted => "accepted", SyncRequestOutcome::Duplicate => "duplicate" }, "requestedIds": requested, "observedIds": observed, "completedIds": completed, "isCompleted": self.inner.is_completed(&request_id)}).to_string()
            }
            Err(error) => sync_error_json(error),
        }
    }

    /// Finish a staged completion after durable validation, or discard its stage.
    pub fn finish_completion_json(&mut self, request_id: &str, durable: bool) -> String {
        match self.inner.finish_completion(request_id, durable) {
            Ok(()) => "{\"ok\":true}".to_owned(),
            Err(error) => sync_error_json(error),
        }
    }

    pub fn verify_durable_messages_json(&self, request_id: &str, messages_json: &str) -> String {
        if messages_json.len() > 2 * 1024 * 1024 {
            return error_json(ErrorCode::InputTooLarge);
        }
        let messages: Vec<Value> = match serde_json::from_str(messages_json) {
            Ok(messages) => messages,
            Err(_) => return error_json(ErrorCode::InvalidJson),
        };
        match self.inner.verify_durable_messages(request_id, &messages) {
            Ok(matches) => json!({"ok": true, "matches": matches}).to_string(),
            Err(error) => sync_error_json(error),
        }
    }
}

impl Default for WasmSyncRequestBook {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn synchronization_coverage_facade_waits_and_persists_partial_outcome() {
        let mut coverage = WasmSyncCoverage::new();
        assert_eq!(coverage.outcome(), "complete");
        coverage.begin_plan();
        coverage.begin_plan();
        assert_eq!(coverage.outcome(), "syncing");
        coverage.finish_plan();
        assert_eq!(coverage.outcome(), "syncing");
        coverage.mark_incomplete();
        coverage.abandon_plan();
        assert_eq!(coverage.outcome(), "partial");
        coverage.finish_plan();
        assert_eq!(coverage.outcome(), "partial");
    }

    fn packet(id: &str, body: &str) -> String {
        json!({
            "version": 1,
            "type": "message",
            "id": id,
            "room": "room1",
            "sender": "device1",
            "senderName": "Amina",
            "createdAt": "2026-10-14T12:00:00Z",
            "body": body,
        })
        .to_string()
    }

    fn parse_result(value: &str) -> Value {
        serde_json::from_str(value).expect("facade result is JSON")
    }

    #[test]
    fn shared_protocol_vectors_match_core_validators_through_the_facade() {
        let vectors: Vec<Value> =
            serde_json::from_str(include_str!("../../../packages/protocol/vectors/v1.json"))
                .expect("shared protocol vectors are valid JSON");

        for vector in vectors {
            let validator = vector["validator"].as_str().expect("validator name");
            let value_json = vector["value"].to_string();
            let expected = vector["valid"].as_bool().expect("expected result");
            let actual = parse_result(&validate_json(validator, &value_json));
            assert_eq!(
                actual,
                json!({"ok": true, "valid": expected}),
                "vector: {vector}"
            );
        }
    }

    #[test]
    fn shared_inbound_acceptance_vectors_match_through_the_facade() {
        let vectors: Vec<Value> = serde_json::from_str(include_str!(
            "../../../packages/protocol/vectors/inbound-acceptance-v1.json"
        ))
        .expect("shared acceptance vectors are valid JSON");
        for vector in vectors {
            let candidate = vector
                .get("candidateJson")
                .and_then(Value::as_str)
                .map(str::to_owned)
                .unwrap_or_else(|| vector["candidate"].to_string());
            let existing = vector.get("existing").map(Value::to_string);
            let actual = parse_result(&classify_inbound_json(
                vector["expectedRoom"].as_str().unwrap(),
                vector["roomDeleted"].as_bool().unwrap(),
                &candidate,
                existing,
            ));
            let expected = &vector["expected"];
            let expected_result = if let Some(outcome) = expected.get("outcome") {
                json!({"ok": true, "outcome": outcome})
            } else {
                json!({"ok": false, "code": expected["code"]})
            };
            assert_eq!(actual, expected_result, "vector: {}", vector["name"]);
            if actual["ok"] == false {
                assert_eq!(
                    actual.as_object().unwrap().len(),
                    2,
                    "error leaked packet data"
                );
            }
        }
    }

    #[test]
    fn validator_input_errors_are_bounded_and_typed() {
        assert_eq!(
            parse_result(&validate_json("unknown", "null")),
            json!({"ok": false, "code": "unknown_validator"})
        );
        assert_eq!(
            parse_result(&validate_json("room", "{")),
            json!({"ok": false, "code": "invalid_json"})
        );
        assert_eq!(
            parse_result(&validate_json("room", &" ".repeat(MAX_ENVELOPE_BYTES + 1))),
            json!({"ok": false, "code": "input_too_large"})
        );
        let escaped_body = json!({
            "version": 1,
            "type": "message",
            "id": "m1",
            "room": "room1",
            "sender": "device1",
            "senderName": "Amina",
            "createdAt": "2026-10-14T12:00:00Z",
            "body": "\u{1}".repeat(4_000),
        })
        .to_string();
        assert!(escaped_body.len() > MAX_ENVELOPE_BYTES);
        assert_eq!(
            parse_result(&validate_json("message", &escaped_body)),
            json!({"ok": false, "code": "input_too_large"})
        );
    }

    #[test]
    fn constructor_reports_room_validation_without_throwing() {
        assert_eq!(
            parse_result(&WasmMessageIndex::new("room1").status_json()),
            json!({"ok": true})
        );
        assert_eq!(
            parse_result(&WasmMessageIndex::new("bad room").status_json()),
            json!({"ok": false, "code": "invalid_room"})
        );
    }

    #[test]
    fn insert_json_returns_stable_success_and_typed_errors() {
        let mut index = WasmMessageIndex::new("room1");
        assert_eq!(
            parse_result(&index.insert_json(&packet("m1", "hello"))),
            json!({"ok": true, "outcome": "inserted"})
        );
        assert_eq!(
            parse_result(&index.insert_json(&packet("m1", "hello"))),
            json!({"ok": true, "outcome": "duplicate"})
        );
        assert_eq!(
            parse_result(&index.insert_json("{")),
            json!({"ok": false, "code": "invalid_json"})
        );
        assert_eq!(
            parse_result(&index.insert_json(&packet("m1", "changed"))),
            json!({"ok": false, "code": "message_conflict"})
        );
        assert_eq!(
            parse_result(&WasmMessageIndex::new("bad room").insert_json("{}")),
            json!({"ok": false, "code": "invalid_room"})
        );
    }

    #[test]
    fn input_byte_limits_are_checked_before_json_parse() {
        let mut index = WasmMessageIndex::new("room1");
        let oversized_packet = " ".repeat(MAX_ENVELOPE_BYTES + 1);
        assert_eq!(
            parse_result(&index.insert_json(&oversized_packet)),
            json!({"ok": false, "code": "input_too_large"})
        );
        let oversized_ids = " ".repeat(MAX_KNOWN_IDS_JSON_BYTES + 1);
        assert_eq!(
            parse_result(&index.page_json(&oversized_ids, None, 1)),
            json!({"ok": false, "code": "input_too_large"})
        );
    }

    #[test]
    fn missing_id_selector_and_batch_inputs_are_bounded() {
        let oversized = " ".repeat(MAX_KNOWN_IDS_JSON_BYTES + 1);
        assert_eq!(
            parse_result(&WasmMissingIdSelector::new(&oversized).status_json()),
            json!({"ok": false, "code": "input_too_large"})
        );
        assert_eq!(
            parse_result(&plan_missing_batch_json(&oversized, 0)),
            json!({"ok": false, "code": "input_too_large"})
        );

        let mut selector = WasmMissingIdSelector::new("[\"peer\"]");
        assert_eq!(
            parse_result(&selector.observe_local_ids_json(&oversized)),
            json!({"ok": false, "code": "input_too_large"})
        );
        let too_many_local_ids =
            serde_json::to_string(&vec!["peer"; MAX_SYNC_SELECTION_CHUNK_IDS + 1])
                .expect("local IDs encode");
        assert_eq!(
            parse_result(&selector.observe_local_ids_json(&too_many_local_ids)),
            json!({"ok": false, "code": "invalid_page_limit"})
        );
        let too_many_peer_ids =
            serde_json::to_string(&vec!["peer"; 4_097]).expect("peer IDs encode");
        assert_eq!(
            parse_result(&WasmMissingIdSelector::new(&too_many_peer_ids).status_json()),
            json!({"ok": false, "code": "known_id_limit"})
        );
    }

    #[test]
    fn page_json_exposes_bounded_core_results_and_error_codes() {
        let mut index = WasmMessageIndex::new("room1");
        index.insert_json(&packet("b", "second"));
        index.insert_json(&packet("a", "first"));

        let first = parse_result(&index.page_json("[]", None, 1));
        assert_eq!(first["messages"][0]["id"], "a");
        assert_eq!(first["nextCursor"], "a");
        assert_eq!(first["hasMore"], true);
        let second = parse_result(&index.page_json("[]", Some("a".to_owned()), 1));
        assert_eq!(second["messages"][0]["id"], "b");
        assert_eq!(second["hasMore"], false);

        assert_eq!(
            parse_result(&index.page_json("{}", None, 1)),
            json!({"ok": false, "code": "invalid_json"})
        );
        assert_eq!(
            parse_result(&index.page_json("[]", None, 0)),
            json!({"ok": false, "code": "invalid_page_limit"})
        );
        assert_eq!(
            parse_result(&index.page_json("[]", Some("a".repeat(129)), 1)),
            json!({"ok": false, "code": "invalid_identifier"})
        );
    }

    #[test]
    fn synchronization_facade_enforces_inventory_sequence_and_request_completion() {
        let first = json!({
            "version": 1,
            "type": "sync_inventory_page",
            "room": "room1",
            "syncId": "sync-1",
            "sender": "device-a",
            "cursor": null,
            "messageIds": ["a", "b"],
            "nextCursor": "b",
            "hasMore": true,
            "limitReached": false,
        });
        let mut inventory = WasmSyncInventoryReceiver::new();
        assert_eq!(
            parse_result(&inventory.accept_page_json(&first.to_string()))["ids"],
            json!(["a", "b"])
        );
        assert_eq!(
            parse_result(&inventory.accept_page_json(&first.to_string()))["outcome"],
            "duplicate"
        );
        let wrong_cursor = json!({
            "version": 1,
            "type": "sync_inventory_page",
            "room": "room1",
            "syncId": "sync-1",
            "sender": "device-a",
            "cursor": "a",
            "messageIds": ["c"],
            "nextCursor": "c",
            "hasMore": false,
            "limitReached": false,
        });
        assert_eq!(
            parse_result(&inventory.accept_page_json(&wrong_cursor.to_string())),
            json!({"ok": false, "code": "invalid_inventory_sequence"})
        );

        let request = json!({
            "version": 1,
            "type": "sync_missing_request",
            "room": "room1",
            "syncId": "sync-1",
            "requestId": "request-1",
            "sender": "device-a",
            "targetSender": "device-b",
            "messageIds": ["a", "c"],
        });
        let mut requests = WasmSyncRequestBook::new();
        assert_eq!(
            parse_result(&requests.register_request_json(&request.to_string())),
            json!({"ok": true, "outcome": "accepted"})
        );
        let completion = json!({
            "version": 1,
            "type": "sync_page_complete",
            "room": "room1",
            "syncId": "sync-1",
            "requestId": "request-1",
            "sender": "device-b",
            "targetSender": "device-a",
            "messageIds": ["c"],
        });
        assert_eq!(
            parse_result(&requests.accept_completion_json(&completion.to_string())),
            json!({"ok": true, "outcome": "accepted"})
        );
        assert_eq!(
            parse_result(&requests.accept_completion_json(&completion.to_string())),
            json!({"ok": true, "outcome": "duplicate"})
        );
    }

    #[test]
    fn shared_sync_exchange_vectors_match_through_wasm_facade() {
        let vectors: Vec<Value> = serde_json::from_str(include_str!(
            "../../../packages/protocol/vectors/sync-state-v1.json"
        ))
        .expect("shared synchronization vectors are valid JSON");
        for vector in vectors {
            let mut inventory = WasmSyncInventoryReceiver::new();
            let mut requests = WasmSyncRequestBook::new();
            for operation in vector["operations"].as_array().unwrap() {
                let kind = operation["kind"].as_str().unwrap();
                let value = &operation["value"];
                let actual = match kind {
                    "inventory_page" => {
                        parse_result(&inventory.accept_page_json(&value.to_string()))
                    }
                    "set_missing_ids" => {
                        parse_result(&inventory.set_missing_ids_json(&value["ids"].to_string()))
                    }
                    "inventory_batch" => parse_result(&inventory.next_missing_batch_json()),
                    "request" => parse_result(&requests.register_request_json(&value.to_string())),
                    "completion" => {
                        parse_result(&requests.accept_completion_json(&value.to_string()))
                    }
                    "observe_message" => {
                        parse_result(&requests.observe_message_json(&value.to_string()))
                    }
                    "stage_completion" => {
                        parse_result(&requests.stage_completion_json(&value.to_string()))
                    }
                    "finish_completion" => parse_result(&requests.finish_completion_json(
                        value["requestId"].as_str().unwrap(),
                        value["durable"].as_bool().unwrap(),
                    )),
                    "outstanding" => json!({
                        "ok": true,
                        "outstanding": requests.has_outstanding_message_id(value["id"].as_str().unwrap())
                    }),
                    "durable_check" => parse_result(&requests.verify_durable_messages_json(
                        value["requestId"].as_str().unwrap(),
                        &value["packets"].to_string(),
                    )),
                    "reset_state" => {
                        inventory = WasmSyncInventoryReceiver::new();
                        requests = WasmSyncRequestBook::new();
                        json!({"ok": true})
                    }
                    "fill_requests" => {
                        let count = value["count"].as_u64().unwrap() as usize;
                        for index in 0..count {
                            let request = json!({
                                "version": 1, "type": "sync_missing_request", "room": "room1",
                                "syncId": "sync-1", "requestId": format!("bounded-{index}"),
                                "sender": "device-a", "targetSender": "device-b", "messageIds": ["alpha"]
                            });
                            requests.register_request_json(&request.to_string());
                        }
                        json!({"ok": true, "count": count})
                    }
                    _ => continue,
                };
                assert_eq!(actual, operation["expected"], "vector: {}", vector["name"]);
            }
        }
    }
}
