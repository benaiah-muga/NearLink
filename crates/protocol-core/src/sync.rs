//! Bounded, deterministic reconciliation for validated protocol v1 messages.
//!
//! [`MessageIndex`] retains at most 4,096 messages and 16 MiB of compact JSON
//! packet data. Each packet is limited to 18 KiB. A reconciliation request may
//! name at most 4,096 known IDs, and a page may contain at most 128 messages
//! and 512 KiB of packet data. Limits are checked before a new packet or page
//! is retained or emitted. Packet inspection is also limited to 512 JSON
//! values, a nesting depth of 32, and 18 KiB of combined string and object-key
//! bytes. These bounds limit work performed after the caller supplies a
//! [`Value`]; they cannot bound memory already used to allocate that input.
//!
//! IDs are opaque protocol identifiers. Pages are ordered lexicographically
//! by ID solely to provide deterministic continuation with an exclusive
//! cursor. Timestamps are not inspected for ordering. Each index is bound to
//! one validated room. To paginate a reconciliation, callers must reuse the
//! same known-ID snapshot for every page. If that snapshot changes, restart
//! at `after: None`; continuing with a cursor from another snapshot can omit
//! messages. Exact duplicate JSON values are idempotent; a previously seen ID
//! with any different packet value is a conflict.
//!
//! This is an in-memory primitive over packets accepted by
//! [`crate::is_message_packet`]. It does not provide persistence, peer
//! authentication, encryption, canonical serialization, or cross-device
//! delivery guarantees. Errors contain no message contents.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::io::{self, Write};
use std::ops::Bound::{Excluded, Unbounded};

use serde_json::Value;

use crate::{is_message_packet, is_protocol_identifier, is_protocol_room};

/// Maximum number of unique message packets retained by one index.
pub const MAX_INDEX_MESSAGES: usize = 4_096;
/// Maximum aggregate compact JSON packet size retained by one index.
pub const MAX_INDEX_BYTES: usize = 16 * 1024 * 1024;
/// Maximum compact JSON packet size accepted for one message.
pub const MAX_ENVELOPE_BYTES: usize = 18 * 1024;
/// Maximum JSON values inspected in one input packet.
pub const MAX_ENVELOPE_NODES: usize = 512;
/// Maximum nesting depth inspected in one input packet.
pub const MAX_ENVELOPE_DEPTH: usize = 32;
/// Maximum combined UTF-8 bytes across packet strings and object keys.
pub const MAX_ENVELOPE_TEXT_BYTES: usize = 18 * 1024;
/// Maximum number of peer-known IDs supplied to one page request.
pub const MAX_KNOWN_IDS: usize = 4_096;
/// Maximum number of messages returned in one page.
pub const MAX_PAGE_MESSAGES: usize = 128;
/// Maximum aggregate compact JSON packet size returned in one page.
pub const MAX_PAGE_BYTES: usize = 512 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct IndexedMessage {
    encoded_len: usize,
}

/// An in-memory bounded set of validated messages for exactly one room.
#[derive(Debug, Clone)]
pub struct MessageIndex {
    room: String,
    messages: BTreeMap<String, (Value, IndexedMessage)>,
    encoded_bytes: usize,
}

/// Result of adding one validated message to an index.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InsertOutcome {
    /// The message ID was not present and the packet was retained.
    Inserted,
    /// The ID and complete JSON value exactly matched a retained packet.
    Duplicate,
}

/// Typed reconciliation failures. Variants deliberately carry no packet data.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SyncError {
    /// The input is not a valid protocol v1 message packet.
    InvalidMessage,
    /// The room supplied to [`MessageIndex::new`] is invalid.
    InvalidRoom,
    /// The valid message belongs to a different room than this index.
    RoomMismatch,
    /// The packet exceeds the bounded traversal complexity.
    EnvelopeComplexityLimit,
    /// The compact JSON packet exceeds [`MAX_ENVELOPE_BYTES`].
    EnvelopeTooLarge,
    /// Retaining the message would exceed [`MAX_INDEX_MESSAGES`].
    IndexMessageLimit,
    /// Retaining the message would exceed [`MAX_INDEX_BYTES`].
    IndexByteLimit,
    /// The same ID is already associated with a different packet value.
    MessageConflict,
    /// The peer ID list exceeds [`MAX_KNOWN_IDS`].
    KnownIdLimit,
    /// A supplied peer ID or continuation cursor is not a protocol identifier.
    InvalidIdentifier,
    /// Requested page size is zero or exceeds [`MAX_PAGE_MESSAGES`].
    InvalidPageLimit,
}

impl fmt::Display for SyncError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let message = match self {
            Self::InvalidMessage => "invalid message packet",
            Self::InvalidRoom => "invalid room identifier",
            Self::RoomMismatch => "message belongs to a different room",
            Self::EnvelopeComplexityLimit => "message packet exceeds complexity limit",
            Self::EnvelopeTooLarge => "message packet exceeds size limit",
            Self::IndexMessageLimit => "message index exceeds count limit",
            Self::IndexByteLimit => "message index exceeds byte limit",
            Self::MessageConflict => "message ID conflicts with retained packet",
            Self::KnownIdLimit => "peer ID list exceeds count limit",
            Self::InvalidIdentifier => "invalid message identifier",
            Self::InvalidPageLimit => "page size is outside the allowed range",
        };
        formatter.write_str(message)
    }
}

impl std::error::Error for SyncError {}

struct CappedCounter {
    bytes: usize,
    limit: usize,
}

impl Write for CappedCounter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if bytes.len() > self.limit.saturating_sub(self.bytes) {
            return Err(io::Error::other("serialization limit exceeded"));
        }
        self.bytes += bytes.len();
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

fn compact_json_len_with_limit(packet: &Value, limit: usize) -> Option<usize> {
    let mut counter = CappedCounter { bytes: 0, limit };
    serde_json::to_writer(&mut counter, packet)
        .ok()
        .map(|()| counter.bytes)
}

fn within_packet_complexity_limit(packet: &Value) -> bool {
    let mut pending = vec![(packet, 0usize)];
    let mut nodes = 0usize;
    let mut text_bytes = 0usize;

    while let Some((value, depth)) = pending.pop() {
        nodes += 1;
        if nodes > MAX_ENVELOPE_NODES || depth > MAX_ENVELOPE_DEPTH {
            return false;
        }
        match value {
            Value::String(text) => {
                text_bytes = text_bytes.saturating_add(text.len());
            }
            Value::Array(values) => {
                if nodes
                    .saturating_add(pending.len())
                    .saturating_add(values.len())
                    > MAX_ENVELOPE_NODES
                    || depth == MAX_ENVELOPE_DEPTH && !values.is_empty()
                {
                    return false;
                }
                pending.extend(values.iter().map(|child| (child, depth + 1)));
            }
            Value::Object(fields) => {
                if nodes
                    .saturating_add(pending.len())
                    .saturating_add(fields.len())
                    > MAX_ENVELOPE_NODES
                    || depth == MAX_ENVELOPE_DEPTH && !fields.is_empty()
                {
                    return false;
                }
                for (key, child) in fields {
                    text_bytes = text_bytes.saturating_add(key.len());
                    pending.push((child, depth + 1));
                }
            }
            Value::Null | Value::Bool(_) | Value::Number(_) => {}
        }
        if text_bytes > MAX_ENVELOPE_TEXT_BYTES {
            return false;
        }
    }

    true
}

/// A deterministic page of messages absent from a peer's known ID set.
#[derive(Debug, Clone, PartialEq)]
pub struct SyncPage {
    /// Messages in lexicographic opaque-ID order.
    pub messages: Vec<Value>,
    /// Exclusive continuation cursor, set to the last emitted ID when present.
    pub next_cursor: Option<String>,
    /// Whether another matching message exists after `next_cursor`.
    pub has_more: bool,
}

impl MessageIndex {
    /// Create an empty index bound to one validated protocol room.
    pub fn new(room: &str) -> Result<Self, SyncError> {
        if !is_protocol_room(room) {
            return Err(SyncError::InvalidRoom);
        }
        Ok(Self {
            room: room.to_owned(),
            messages: BTreeMap::new(),
            encoded_bytes: 0,
        })
    }

    /// The protocol room this index accepts and reconciles.
    pub fn room(&self) -> &str {
        &self.room
    }

    /// Number of unique packets currently retained.
    pub fn len(&self) -> usize {
        self.messages.len()
    }

    /// Whether the index contains no packets.
    pub fn is_empty(&self) -> bool {
        self.messages.is_empty()
    }

    /// Aggregate compact JSON byte size of retained packets.
    pub fn encoded_bytes(&self) -> usize {
        self.encoded_bytes
    }

    /// Validate and retain a packet, treating exact duplicate values as no-op.
    ///
    /// Validation and per-packet size checks occur before index mutation. A
    /// conflicting packet is rejected without changing the existing entry.
    pub fn insert(&mut self, packet: Value) -> Result<InsertOutcome, SyncError> {
        if !within_packet_complexity_limit(&packet) {
            return Err(SyncError::EnvelopeComplexityLimit);
        }
        if !is_message_packet(&packet) {
            return Err(SyncError::InvalidMessage);
        }
        if packet.get("room").and_then(Value::as_str) != Some(self.room.as_str()) {
            return Err(SyncError::RoomMismatch);
        }
        let id = packet
            .get("id")
            .and_then(Value::as_str)
            .ok_or(SyncError::InvalidMessage)?;
        if let Some((existing, _)) = self.messages.get(id) {
            return if existing == &packet {
                Ok(InsertOutcome::Duplicate)
            } else {
                Err(SyncError::MessageConflict)
            };
        }
        let encoded_len = compact_json_len_with_limit(&packet, MAX_ENVELOPE_BYTES)
            .ok_or(SyncError::EnvelopeTooLarge)?;
        if self.messages.len() >= MAX_INDEX_MESSAGES {
            return Err(SyncError::IndexMessageLimit);
        }
        if self.encoded_bytes.saturating_add(encoded_len) > MAX_INDEX_BYTES {
            return Err(SyncError::IndexByteLimit);
        }

        self.encoded_bytes += encoded_len;
        self.messages
            .insert(id.to_owned(), (packet, IndexedMessage { encoded_len }));
        Ok(InsertOutcome::Inserted)
    }

    /// Return a bounded page of packets not named by `known_ids`.
    ///
    /// `after` is an exclusive opaque-ID cursor. Callers must use the same
    /// `known_ids` snapshot for every page in one reconciliation. If that
    /// snapshot changes, restart with `after: None`, since resuming an old
    /// cursor may skip newly missing IDs before it. Results remain
    /// deterministic because the index is ordered by ID. The requested
    /// `limit` must be between 1 and [`MAX_PAGE_MESSAGES`].
    pub fn page_missing_from(
        &self,
        known_ids: &[String],
        after: Option<&str>,
        limit: usize,
    ) -> Result<SyncPage, SyncError> {
        if known_ids.len() > MAX_KNOWN_IDS {
            return Err(SyncError::KnownIdLimit);
        }
        if !(1..=MAX_PAGE_MESSAGES).contains(&limit) {
            return Err(SyncError::InvalidPageLimit);
        }
        if after.is_some_and(|cursor| !is_protocol_identifier(cursor)) {
            return Err(SyncError::InvalidIdentifier);
        }

        let mut known = BTreeSet::new();
        for id in known_ids {
            if !is_protocol_identifier(id) {
                return Err(SyncError::InvalidIdentifier);
            }
            known.insert(id.as_str());
        }

        let entries = match after {
            Some(cursor) => self.messages.range::<str, _>((Excluded(cursor), Unbounded)),
            None => self.messages.range::<str, _>((Unbounded, Unbounded)),
        };
        let mut messages = Vec::with_capacity(limit.min(self.messages.len()));
        let mut page_bytes = 0usize;
        let mut next_cursor = None;
        let mut has_more = false;

        for (id, (packet, metadata)) in entries {
            if known.contains(id.as_str()) {
                continue;
            }
            if messages.len() == limit
                || page_bytes.saturating_add(metadata.encoded_len) > MAX_PAGE_BYTES
            {
                has_more = true;
                break;
            }
            page_bytes += metadata.encoded_len;
            messages.push(packet.clone());
            next_cursor = Some(id.clone());
        }

        Ok(SyncPage {
            messages,
            next_cursor,
            has_more,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn packet(id: &str, body: &str, created_at: &str) -> Value {
        serde_json::json!({
            "version": 1,
            "type": "message",
            "id": id,
            "room": "room1",
            "sender": "device1",
            "senderName": "Amina",
            "createdAt": created_at,
            "body": body
        })
    }

    #[test]
    fn inserts_valid_packet_and_exact_duplicate_idempotently() {
        let value = packet("m1", "hello", "2026-10-14T12:00:00Z");
        let mut index = MessageIndex::new("room1").unwrap();

        assert_eq!(index.insert(value.clone()), Ok(InsertOutcome::Inserted));
        let retained_bytes = index.encoded_bytes();
        assert_eq!(index.insert(value), Ok(InsertOutcome::Duplicate));
        assert_eq!(index.len(), 1);
        assert_eq!(index.encoded_bytes(), retained_bytes);
    }

    #[test]
    fn same_id_with_different_packet_is_rejected_without_mutation() {
        let mut index = MessageIndex::new("room1").unwrap();
        let original = packet("m1", "hello", "2026-10-14T12:00:00Z");
        index.insert(original.clone()).expect("valid first packet");
        let bytes = index.encoded_bytes();

        assert_eq!(
            index.insert(packet("m1", "changed", "2026-10-14T12:00:00Z")),
            Err(SyncError::MessageConflict)
        );
        let mut oversized_conflict = packet("m1", "hello", "2026-10-14T12:00:00Z");
        oversized_conflict["extension"] = Value::String("\0".repeat(4_000));
        assert_eq!(
            index.insert(oversized_conflict),
            Err(SyncError::MessageConflict)
        );
        assert_eq!(index.encoded_bytes(), bytes);
        assert_eq!(
            index.page_missing_from(&[], None, 1).unwrap().messages,
            vec![original]
        );
    }

    #[test]
    fn pages_use_opaque_id_order_and_exclusive_incremental_cursor() {
        let mut index = MessageIndex::new("room1").unwrap();
        index
            .insert(packet("z-last", "older timestamp", "2020-01-01T00:00:00Z"))
            .unwrap();
        index
            .insert(packet("a-first", "newer timestamp", "2026-10-14T12:00:00Z"))
            .unwrap();
        index
            .insert(packet("m-middle", "middle", "2023-01-01T00:00:00Z"))
            .unwrap();

        let first = index.page_missing_from(&[], None, 2).unwrap();
        assert_eq!(
            first
                .messages
                .iter()
                .map(|item| item["id"].as_str().unwrap())
                .collect::<Vec<_>>(),
            vec!["a-first", "m-middle"]
        );
        assert_eq!(first.next_cursor.as_deref(), Some("m-middle"));
        assert!(first.has_more);

        let second = index
            .page_missing_from(&[], first.next_cursor.as_deref(), 2)
            .unwrap();
        assert_eq!(second.messages[0]["id"], "z-last");
        assert_eq!(second.next_cursor.as_deref(), Some("z-last"));
        assert!(!second.has_more);
    }

    #[test]
    fn page_cursor_uses_a_stable_known_id_snapshot() {
        let mut index = MessageIndex::new("room1").unwrap();
        for id in ["a", "b", "c", "d", "e"] {
            index
                .insert(packet(id, id, "2026-10-14T12:00:00Z"))
                .unwrap();
        }
        let snapshot = vec!["a".to_owned(), "b".to_owned(), "d".to_owned()];
        let first = index.page_missing_from(&snapshot, None, 1).unwrap();
        let second = index
            .page_missing_from(&snapshot, first.next_cursor.as_deref(), 1)
            .unwrap();

        assert_eq!(first.messages[0]["id"], "c");
        assert_eq!(second.messages[0]["id"], "e");
        assert!(!second.has_more);

        let changed_snapshot = vec!["b".to_owned(), "d".to_owned()];
        let stale_resume = index
            .page_missing_from(&changed_snapshot, second.next_cursor.as_deref(), 10)
            .unwrap();
        assert!(stale_resume.messages.is_empty());
        let restarted = index
            .page_missing_from(&changed_snapshot, None, 10)
            .unwrap();
        assert_eq!(
            restarted
                .messages
                .iter()
                .map(|message| message["id"].as_str().unwrap())
                .collect::<Vec<_>>(),
            vec!["a", "c", "e"]
        );
    }

    #[test]
    fn index_is_validated_and_bound_to_one_room() {
        assert_eq!(
            MessageIndex::new("bad room").err(),
            Some(SyncError::InvalidRoom)
        );
        let mut index = MessageIndex::new("room1").unwrap();
        let mut other_room = packet("m1", "hello", "2026-10-14T12:00:00Z");
        other_room["room"] = Value::String("room2".to_owned());

        assert_eq!(index.room(), "room1");
        assert_eq!(index.insert(other_room), Err(SyncError::RoomMismatch));
        assert!(index.is_empty());
    }

    #[test]
    fn same_message_id_is_independent_across_room_indexes() {
        let mut room_one = MessageIndex::new("room1").unwrap();
        let mut room_two = MessageIndex::new("room2").unwrap();
        let mut first = packet("shared-id", "first room", "2026-10-14T12:00:00Z");
        let mut second = packet("shared-id", "second room", "2026-10-14T12:00:00Z");
        first["room"] = Value::String("room1".to_owned());
        second["room"] = Value::String("room2".to_owned());

        assert_eq!(room_one.insert(first), Ok(InsertOutcome::Inserted));
        assert_eq!(room_two.insert(second), Ok(InsertOutcome::Inserted));
        assert_eq!(room_one.len(), 1);
        assert_eq!(room_two.len(), 1);
        assert_eq!(
            room_one.page_missing_from(&[], None, 1).unwrap().messages[0]["room"],
            "room1"
        );
        assert_eq!(
            room_two.page_missing_from(&[], None, 1).unwrap().messages[0]["room"],
            "room2"
        );
    }

    #[test]
    fn invalid_packets_are_rejected_before_retention() {
        let mut index = MessageIndex::new("room1").unwrap();
        assert_eq!(
            index.insert(serde_json::json!({"type": "message"})),
            Err(SyncError::InvalidMessage)
        );
        assert!(index.is_empty());
        assert_eq!(index.encoded_bytes(), 0);
    }

    #[test]
    fn oversized_envelope_is_rejected_before_retention() {
        let mut oversized = packet("m1", "valid body", "2026-10-14T12:00:00Z");
        oversized["extension"] = Value::String("\0".repeat(4_000));
        let mut index = MessageIndex::new("room1").unwrap();
        assert_eq!(index.insert(oversized), Err(SyncError::EnvelopeTooLarge));
        assert!(index.is_empty());
    }

    #[test]
    fn packet_complexity_bounds_cover_nodes_depth_and_text() {
        let mut index = MessageIndex::new("room1").unwrap();

        let mut too_many_nodes = packet("nodes", "valid", "2026-10-14T12:00:00Z");
        too_many_nodes["extension"] = Value::Array(vec![Value::Null; MAX_ENVELOPE_NODES]);
        assert_eq!(
            index.insert(too_many_nodes),
            Err(SyncError::EnvelopeComplexityLimit)
        );

        let mut deeply_nested = Value::Null;
        for _ in 0..=MAX_ENVELOPE_DEPTH {
            deeply_nested = Value::Array(vec![deeply_nested]);
        }
        let mut too_deep = packet("depth", "valid", "2026-10-14T12:00:00Z");
        too_deep["extension"] = deeply_nested;
        assert_eq!(
            index.insert(too_deep),
            Err(SyncError::EnvelopeComplexityLimit)
        );

        let mut too_much_text = packet("text", "valid", "2026-10-14T12:00:00Z");
        too_much_text["extension"] = Value::String("x".repeat(MAX_ENVELOPE_TEXT_BYTES));
        assert_eq!(
            index.insert(too_much_text),
            Err(SyncError::EnvelopeComplexityLimit)
        );
        assert!(index.is_empty());
    }

    #[test]
    fn page_request_limits_and_identifier_validation_are_typed() {
        let index = MessageIndex::new("room1").unwrap();
        assert_eq!(
            index.page_missing_from(&[], None, 0),
            Err(SyncError::InvalidPageLimit)
        );
        assert_eq!(
            index.page_missing_from(&[], None, MAX_PAGE_MESSAGES + 1),
            Err(SyncError::InvalidPageLimit)
        );
        assert_eq!(
            index.page_missing_from(&[], Some("bad cursor"), 1),
            Err(SyncError::InvalidIdentifier)
        );
        assert_eq!(
            index.page_missing_from(&[String::new()], None, 1),
            Err(SyncError::InvalidIdentifier)
        );
        let too_many = vec!["id".to_owned(); MAX_KNOWN_IDS + 1];
        assert_eq!(
            index.page_missing_from(&too_many, None, 1),
            Err(SyncError::KnownIdLimit)
        );
    }

    #[test]
    fn output_page_obeys_message_count_limit() {
        let mut index = MessageIndex::new("room1").unwrap();
        for number in 0..=MAX_PAGE_MESSAGES {
            index
                .insert(packet(
                    &format!("m{number:03}"),
                    "x",
                    "2026-10-14T12:00:00Z",
                ))
                .unwrap();
        }
        let page = index
            .page_missing_from(&[], None, MAX_PAGE_MESSAGES)
            .unwrap();
        assert_eq!(page.messages.len(), MAX_PAGE_MESSAGES);
        assert!(page.has_more);
        assert!(page.next_cursor.is_some());
    }

    #[test]
    fn index_rejects_a_packet_past_the_message_count_limit() {
        let mut index = MessageIndex::new("room1").unwrap();
        for number in 0..MAX_INDEX_MESSAGES {
            index
                .insert(packet(
                    &format!("m{number:04}"),
                    "x",
                    "2026-10-14T12:00:00Z",
                ))
                .unwrap();
        }
        assert_eq!(index.len(), MAX_INDEX_MESSAGES);
        assert_eq!(
            index.insert(packet("zz-last", "x", "2026-10-14T12:00:00Z")),
            Err(SyncError::IndexMessageLimit)
        );
        assert_eq!(index.len(), MAX_INDEX_MESSAGES);
    }

    #[test]
    fn index_rejects_a_packet_past_aggregate_byte_limit() {
        let mut index = MessageIndex::new("room1").unwrap();
        let mut stopped_at_limit = false;
        for number in 0..1_100 {
            let mut value = packet(&format!("m{number:04}"), "x", "2026-10-14T12:00:00Z");
            value["extension"] = Value::String("x".repeat(16 * 1024));
            match index.insert(value) {
                Ok(InsertOutcome::Inserted) => {}
                Err(SyncError::IndexByteLimit) => {
                    stopped_at_limit = true;
                    break;
                }
                other => panic!("unexpected bounded insert result: {other:?}"),
            }
        }
        assert!(stopped_at_limit);
        assert!(index.encoded_bytes() <= MAX_INDEX_BYTES);
        assert!(index.encoded_bytes() > MAX_INDEX_BYTES - MAX_ENVELOPE_BYTES);
    }

    #[test]
    fn page_obeys_aggregate_byte_limit() {
        let mut index = MessageIndex::new("room1").unwrap();
        for number in 0..40 {
            let mut value = packet(&format!("m{number:02}"), "x", "2026-10-14T12:00:00Z");
            value["extension"] = Value::String("x".repeat(16 * 1024));
            index.insert(value).unwrap();
        }
        let page = index
            .page_missing_from(&[], None, MAX_PAGE_MESSAGES)
            .unwrap();
        let page_bytes: usize = page
            .messages
            .iter()
            .map(|value| serde_json::to_vec(value).unwrap().len())
            .sum();

        assert!(page_bytes <= MAX_PAGE_BYTES);
        assert!(page.messages.len() < 40);
        assert!(page.has_more);
    }

    #[test]
    fn duplicate_known_ids_do_not_change_deterministic_results() {
        let mut index = MessageIndex::new("room1").unwrap();
        index
            .insert(packet("b", "second", "2026-10-14T12:00:00Z"))
            .unwrap();
        index
            .insert(packet("a", "first", "2026-10-14T12:00:00Z"))
            .unwrap();
        let once = index
            .page_missing_from(&["a".to_owned()], None, 10)
            .unwrap();
        let repeated = index
            .page_missing_from(&["a".to_owned(), "a".to_owned()], None, 10)
            .unwrap();
        assert_eq!(once, repeated);
    }
}
