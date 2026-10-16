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
use crate::{
    is_sync_inventory_page_packet, is_sync_missing_request_packet, is_sync_page_complete_packet,
    MAX_SYNC_INVENTORY_IDS,
};

/// Maximum request IDs retained by one ephemeral sync exchange.
pub const MAX_SYNC_REQUESTS: usize = 64;
/// Maximum packet bytes retained while matching messages to open requests.
pub const MAX_SYNC_OBSERVED_BYTES: usize = 2 * 1024 * 1024;
/// Maximum packet count retained while matching messages to open requests.
pub const MAX_SYNC_OBSERVED_MESSAGES: usize = 128;

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
/// Maximum number of local IDs accepted in one missing-ID scan chunk.
pub const MAX_SYNC_SELECTION_CHUNK_IDS: usize = 4_096;
/// Maximum requested IDs in one browser accepted-message adapter result.
pub const MAX_SYNC_ACCEPTED_MESSAGE_BATCH_IDS: usize = 100;
/// Maximum UTF-8 JSON input size enforced by the WASM adapter.
pub const MAX_SYNC_ACCEPTED_MESSAGE_BATCH_BYTES: usize = 2 * 1024 * 1024;

/// Room state observed by one accepted-message storage read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SyncAcceptedMessageRoomState {
    Available,
    Unavailable,
}

/// Versioned packet-only result for a bounded synchronization storage read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SyncAcceptedMessageBatch {
    pub version: u8,
    pub room: String,
    pub requested_ids: Vec<String>,
    pub room_state: SyncAcceptedMessageRoomState,
    pub messages: Vec<Value>,
}

/// Validate the untrusted result of a bounded accepted-message storage read.
/// `expected_ids` is the exact request context and must match the DTO unchanged.
pub fn validate_sync_accepted_message_batch(
    value: &Value,
    expected_room: &str,
    expected_ids: &[String],
) -> Result<SyncAcceptedMessageBatch, SyncError> {
    if !is_protocol_room(expected_room) {
        return Err(SyncError::InvalidRoom);
    }
    if expected_ids.len() > MAX_SYNC_ACCEPTED_MESSAGE_BATCH_IDS
        || expected_ids.iter().any(|id| !is_protocol_identifier(id))
        || expected_ids.iter().collect::<BTreeSet<_>>().len() != expected_ids.len()
    {
        return Err(SyncError::InvalidSyncRequest);
    }
    let Some(object) = value.as_object() else {
        return Err(SyncError::InvalidSyncAcceptedMessageBatch);
    };
    let fields = ["version", "room", "requestedIds", "roomState", "messages"];
    if object.len() != fields.len() || object.keys().any(|field| !fields.contains(&field.as_str()))
    {
        return Err(SyncError::InvalidSyncAcceptedMessageBatch);
    }
    if value.get("version").and_then(Value::as_f64) != Some(1.0) {
        return Err(SyncError::InvalidSyncAcceptedMessageBatch);
    }
    let room = value
        .get("room")
        .and_then(Value::as_str)
        .ok_or(SyncError::InvalidSyncAcceptedMessageBatch)?;
    if !is_protocol_room(room) {
        return Err(SyncError::InvalidRoom);
    }
    if room != expected_room {
        return Err(SyncError::RoomMismatch);
    }
    let requested_ids = value
        .get("requestedIds")
        .and_then(Value::as_array)
        .ok_or(SyncError::InvalidSyncAcceptedMessageBatch)?
        .iter()
        .map(|id| {
            id.as_str()
                .map(str::to_owned)
                .ok_or(SyncError::InvalidSyncAcceptedMessageBatch)
        })
        .collect::<Result<Vec<_>, _>>()?;
    if requested_ids != expected_ids {
        return Err(SyncError::InvalidSyncRequest);
    }
    let room_state = match value.get("roomState").and_then(Value::as_str) {
        Some("available") => SyncAcceptedMessageRoomState::Available,
        Some("unavailable") => SyncAcceptedMessageRoomState::Unavailable,
        _ => return Err(SyncError::InvalidSyncAcceptedMessageBatch),
    };
    let messages = value
        .get("messages")
        .and_then(Value::as_array)
        .ok_or(SyncError::InvalidSyncAcceptedMessageBatch)?;
    if messages.len() > MAX_SYNC_ACCEPTED_MESSAGE_BATCH_IDS || messages.len() > expected_ids.len() {
        return Err(SyncError::InvalidSyncAcceptedMessageBatch);
    }
    if room_state == SyncAcceptedMessageRoomState::Unavailable && !messages.is_empty() {
        return Err(SyncError::InvalidSyncAcceptedMessageBatch);
    }
    let mut previous_index = None;
    for message in messages {
        if !is_message_packet(message) {
            return Err(SyncError::InvalidMessage);
        }
        if message.get("room").and_then(Value::as_str) != Some(expected_room) {
            return Err(SyncError::RoomMismatch);
        }
        let id = message
            .get("id")
            .and_then(Value::as_str)
            .ok_or(SyncError::InvalidMessage)?;
        let index = expected_ids
            .iter()
            .position(|requested| requested == id)
            .ok_or(SyncError::InvalidSyncAcceptedMessageBatch)?;
        if previous_index.is_some_and(|previous| previous >= index) {
            return Err(SyncError::InvalidSyncAcceptedMessageBatch);
        }
        previous_index = Some(index);
    }
    Ok(SyncAcceptedMessageBatch {
        version: 1,
        room: room.to_owned(),
        requested_ids,
        room_state,
        messages: messages.clone(),
    })
}

/// Frozen, validated local inventory for one synchronization session.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalInventory {
    room: String,
    ids: Vec<String>,
    limit_reached: bool,
}

impl LocalInventory {
    /// Validate versioned storage output. IDs must already be sorted and unique.
    pub fn from_snapshot(
        version: u8,
        room: &str,
        ids: Vec<String>,
        scan_complete: bool,
        accepted_id_overflow: bool,
    ) -> Result<Self, SyncError> {
        if version != 1 || !crate::is_protocol_room(room) {
            return Err(SyncError::InvalidLocalInventory);
        }
        if ids.len() > MAX_SYNC_INVENTORY_IDS
            || ids.iter().any(|id| !is_protocol_identifier(id))
            || ids.windows(2).any(|pair| pair[0] >= pair[1])
        {
            return Err(SyncError::InvalidLocalInventory);
        }
        if accepted_id_overflow {
            if ids.len() != MAX_SYNC_INVENTORY_IDS {
                return Err(SyncError::InvalidLocalInventory);
            }
        } else if !scan_complete {
            return Err(SyncError::IncompleteLocalInventory);
        }
        Ok(Self {
            room: room.to_owned(),
            ids,
            limit_reached: accepted_id_overflow,
        })
    }

    pub fn room(&self) -> &str {
        &self.room
    }

    pub fn contains(&self, id: &str) -> bool {
        self.ids
            .binary_search_by(|candidate| candidate.as_str().cmp(id))
            .is_ok()
    }

    pub fn missing_ids(&self, peer_ids: &[String]) -> Result<Vec<String>, SyncError> {
        validate_ordered_ids(peer_ids)?;
        Ok(peer_ids
            .iter()
            .filter(|id| !self.contains(id))
            .cloned()
            .collect())
    }

    /// Return one deterministic protocol inventory page as a packet value.
    pub fn page(&self, sender: &str, sync_id: &str, offset: usize) -> Result<Value, SyncError> {
        if !is_protocol_identifier(sender) || !is_protocol_identifier(sync_id) {
            return Err(SyncError::InvalidIdentifier);
        }
        if offset > self.ids.len() || (offset != 0 && offset == self.ids.len()) {
            return Err(SyncError::InvalidPageLimit);
        }
        let end = (offset + crate::MAX_SYNC_PACKET_IDS).min(self.ids.len());
        let ids = &self.ids[offset..end];
        let has_more = end < self.ids.len();
        Ok(serde_json::json!({
            "version": crate::PROTOCOL_VERSION,
            "type": "sync_inventory_page",
            "room": self.room,
            "syncId": sync_id,
            "sender": sender,
            "cursor": if offset == 0 { None::<String> } else { Some(self.ids[offset - 1].clone()) },
            "messageIds": ids,
            "nextCursor": ids.last().cloned(),
            "hasMore": has_more,
            "limitReached": self.limit_reached && !has_more,
        }))
    }
}

/// Aggregates only the coverage outcome for one synchronization exchange.
/// Storage, transport, and peer scheduling remain owned by the caller.
#[derive(Debug, Default, Clone, Copy, Eq, PartialEq)]
pub struct SyncCoverage {
    incomplete: bool,
    active_plans: usize,
}

impl SyncCoverage {
    pub fn mark_incomplete(&mut self) {
        self.incomplete = true;
    }

    pub fn begin_plan(&mut self) {
        self.active_plans = self.active_plans.saturating_add(1);
    }

    pub fn finish_plan(&mut self) {
        self.active_plans = self.active_plans.saturating_sub(1);
    }

    pub fn abandon_plan(&mut self) {
        self.mark_incomplete();
        self.finish_plan();
    }

    pub fn outcome(&self) -> &'static str {
        if self.incomplete {
            "partial"
        } else if self.active_plans > 0 {
            "syncing"
        } else {
            "complete"
        }
    }

    pub fn active_plan_count(&self) -> usize {
        self.active_plans
    }
}

/// Bounded selector for a peer inventory and a streaming local-ID scan.
/// Only the peer's bounded inventory and one membership bit per peer ID are
/// retained. Local IDs may be supplied in any number of bounded chunks.
#[derive(Debug, Clone)]
pub struct MissingIdSelector {
    peer_ids: Vec<String>,
    locally_present: Vec<bool>,
    finished: bool,
}

impl MissingIdSelector {
    /// Construct a selector from one unique, ordered peer inventory.
    pub fn new(peer_ids: &[String]) -> Result<Self, SyncError> {
        validate_ordered_ids(peer_ids)?;
        Ok(Self {
            peer_ids: peer_ids.to_vec(),
            locally_present: vec![false; peer_ids.len()],
            finished: false,
        })
    }

    /// Record membership matches from one bounded local-ID chunk.
    /// Repeated local IDs are idempotent, matching set membership semantics.
    pub fn observe_local_ids(&mut self, local_ids: &[String]) -> Result<(), SyncError> {
        if self.finished || local_ids.len() > MAX_SYNC_SELECTION_CHUNK_IDS {
            return Err(SyncError::InvalidPageLimit);
        }
        for local_id in local_ids {
            if !is_protocol_identifier(local_id) {
                return Err(SyncError::InvalidIdentifier);
            }
            if let Ok(index) = self.peer_ids.binary_search(local_id) {
                self.locally_present[index] = true;
            }
        }
        Ok(())
    }

    /// Finalize the local scan and return peer IDs not found locally.
    pub fn finish(&mut self) -> Result<Vec<String>, SyncError> {
        if self.finished {
            return Err(SyncError::InvalidPageLimit);
        }
        self.finished = true;
        Ok(self
            .peer_ids
            .iter()
            .zip(&self.locally_present)
            .filter_map(|(peer_id, present)| (!present).then_some(peer_id.clone()))
            .collect())
    }
}

/// Return one deterministic, protocol-sized batch from a missing-ID plan.
pub fn plan_missing_batch(missing_ids: &[String], offset: usize) -> Result<Vec<String>, SyncError> {
    validate_ordered_ids(missing_ids)?;
    if offset > missing_ids.len() {
        return Err(SyncError::InvalidPageLimit);
    }
    Ok(missing_ids[offset..(offset + crate::MAX_SYNC_PACKET_IDS).min(missing_ids.len())].to_vec())
}

fn validate_ordered_ids(ids: &[String]) -> Result<(), SyncError> {
    if ids.len() > MAX_SYNC_INVENTORY_IDS {
        return Err(SyncError::KnownIdLimit);
    }
    if ids.iter().any(|id| !is_protocol_identifier(id))
        || ids.windows(2).any(|pair| pair[0] >= pair[1])
    {
        return Err(SyncError::InvalidIdentifier);
    }
    Ok(())
}

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
    /// An inventory page failed structural validation.
    InvalidInventoryPage,
    /// Inventory pages changed exchange identity or broke cursor/order rules.
    InvalidInventorySequence,
    /// A repeated inventory cursor carried different contents.
    InventoryConflict,
    /// An inventory exceeded the 4,096 ID bound.
    InventoryLimit,
    /// A versioned local inventory snapshot is malformed.
    InvalidLocalInventory,
    /// Storage stopped before complete enumeration without proving overflow.
    IncompleteLocalInventory,
    /// A missing-message request failed structural validation.
    InvalidSyncRequest,
    /// The bounded set of outstanding sync requests is full.
    SyncRequestLimit,
    /// A request ID was reused with different contents.
    SyncRequestConflict,
    /// Retained requested messages exceed the exchange count or byte bound.
    SyncObservedLimit,
    /// A completion did not match its request or contained unrequested IDs.
    InvalidSyncCompletion,
    /// A versioned accepted-message batch did not match its request context.
    InvalidSyncAcceptedMessageBatch,
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
            Self::InvalidInventoryPage => "invalid synchronization inventory page",
            Self::InvalidInventorySequence => "synchronization inventory sequence is invalid",
            Self::InventoryConflict => "synchronization inventory cursor conflicts",
            Self::InventoryLimit => "synchronization inventory exceeds count limit",
            Self::InvalidLocalInventory => "local synchronization inventory snapshot is invalid",
            Self::IncompleteLocalInventory => "local synchronization inventory scan is incomplete",
            Self::InvalidSyncRequest => "invalid synchronization request",
            Self::SyncRequestLimit => "outstanding synchronization requests exceed count limit",
            Self::SyncRequestConflict => "synchronization request ID conflicts",
            Self::SyncObservedLimit => {
                "retained synchronization messages exceed the exchange limit"
            }
            Self::InvalidSyncCompletion => "synchronization completion does not match its request",
            Self::InvalidSyncAcceptedMessageBatch => {
                "synchronization accepted-message batch is invalid"
            }
        };
        formatter.write_str(message)
    }
}

impl std::error::Error for SyncError {}

/// Result of accepting a synchronization inventory page.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InventoryPageOutcome {
    /// A new page was added to the inventory.
    Accepted,
    /// An exact retransmission of an already accepted page was ignored.
    Duplicate,
}

/// Bounded receiver for one lexicographically paged message-ID inventory.
///
/// Construct a fresh receiver for each `(room, sender, syncId)` exchange.
/// Pages are accepted only in cursor order. The receiver retains at most 4,096
/// IDs and 4,096 page envelopes, and exact retransmissions are idempotent.
#[derive(Debug, Clone)]
pub struct SyncInventoryReceiver {
    room: Option<String>,
    sync_id: Option<String>,
    sender: Option<String>,
    expected_cursor: Option<String>,
    ids: Vec<String>,
    pages: BTreeMap<Option<String>, Value>,
    complete: bool,
    limit_reached: bool,
    missing_ids: Option<Vec<String>>,
    next_missing_offset: usize,
}

impl Default for SyncInventoryReceiver {
    fn default() -> Self {
        Self::new()
    }
}

impl SyncInventoryReceiver {
    pub fn new() -> Self {
        Self {
            room: None,
            sync_id: None,
            sender: None,
            expected_cursor: None,
            ids: Vec::new(),
            pages: BTreeMap::new(),
            complete: false,
            limit_reached: false,
            missing_ids: None,
            next_missing_offset: 0,
        }
    }

    /// Accept one validated inventory page or an exact duplicate.
    pub fn accept_page(&mut self, page: Value) -> Result<InventoryPageOutcome, SyncError> {
        if !is_sync_inventory_page_packet(&page) {
            return Err(SyncError::InvalidInventoryPage);
        }
        let room = page["room"].as_str().expect("validated room");
        let sync_id = page["syncId"].as_str().expect("validated sync ID");
        let sender = page["sender"].as_str().expect("validated sender");
        let cursor = page["cursor"].as_str().map(str::to_owned);

        if let Some(previous) = self.pages.get(&cursor) {
            return if previous == &page {
                Ok(InventoryPageOutcome::Duplicate)
            } else {
                Err(SyncError::InventoryConflict)
            };
        }
        if self.complete {
            return Err(SyncError::InvalidInventorySequence);
        }
        if self.room.as_deref().is_some_and(|value| value != room)
            || self
                .sync_id
                .as_deref()
                .is_some_and(|value| value != sync_id)
            || self.sender.as_deref().is_some_and(|value| value != sender)
            || cursor != self.expected_cursor
        {
            return Err(SyncError::InvalidInventorySequence);
        }

        let page_ids = page["messageIds"]
            .as_array()
            .expect("validated message IDs");
        let page_len = page_ids.len();
        let has_more = page["hasMore"].as_bool().expect("validated flag");
        let new_inventory_len = self.ids.len().saturating_add(page_len);
        if new_inventory_len > MAX_SYNC_INVENTORY_IDS
            || (new_inventory_len == MAX_SYNC_INVENTORY_IDS && has_more)
        {
            return Err(SyncError::InventoryLimit);
        }
        let last_existing = self.ids.last().map(String::as_str);
        if page_ids.iter().any(|value| {
            let id = value.as_str().expect("validated ID");
            last_existing.is_some_and(|last| id <= last)
        }) {
            return Err(SyncError::InvalidInventorySequence);
        }

        if self.room.is_none() {
            self.room = Some(room.to_owned());
            self.sync_id = Some(sync_id.to_owned());
            self.sender = Some(sender.to_owned());
        }
        self.ids.extend(
            page_ids
                .iter()
                .map(|value| value.as_str().expect("validated ID").to_owned()),
        );
        self.limit_reached = page["limitReached"].as_bool().expect("validated flag");
        self.expected_cursor = if has_more {
            page["nextCursor"].as_str().map(str::to_owned)
        } else {
            None
        };
        self.complete = !has_more;
        self.pages.insert(cursor, page);
        Ok(InventoryPageOutcome::Accepted)
    }

    pub fn ids(&self) -> &[String] {
        &self.ids
    }

    pub fn is_complete(&self) -> bool {
        self.complete
    }

    pub fn limit_reached(&self) -> bool {
        self.complete && self.limit_reached
    }

    /// Store the result of comparing this inventory with the local snapshot.
    pub fn set_missing_ids(&mut self, missing_ids: Vec<String>) -> Result<(), SyncError> {
        if !self.complete {
            return Err(SyncError::InvalidInventorySequence);
        }
        validate_ordered_ids(&missing_ids)?;
        if missing_ids
            .iter()
            .any(|id| self.ids.binary_search(id).is_err())
        {
            return Err(SyncError::InvalidSyncRequest);
        }
        if let Some(previous) = &self.missing_ids {
            return if previous == &missing_ids {
                Ok(())
            } else {
                Err(SyncError::SyncRequestConflict)
            };
        }
        self.missing_ids = Some(missing_ids);
        self.next_missing_offset = 0;
        Ok(())
    }

    /// Return and consume the next bounded request batch from the frozen plan.
    pub fn next_missing_batch(&mut self) -> Result<(Vec<String>, bool), SyncError> {
        let missing_ids = self
            .missing_ids
            .as_ref()
            .ok_or(SyncError::InvalidSyncRequest)?;
        let ids = plan_missing_batch(missing_ids, self.next_missing_offset)?;
        self.next_missing_offset += ids.len();
        let has_more = self.next_missing_offset < missing_ids.len();
        Ok((ids, has_more))
    }

    pub fn has_missing_plan(&self) -> bool {
        self.missing_ids.is_some()
    }

    pub fn has_missing_ids_remaining(&self) -> bool {
        self.missing_ids
            .as_ref()
            .is_some_and(|ids| self.next_missing_offset < ids.len())
    }
}

/// Result of recording a missing-message request or completion.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SyncRequestOutcome {
    Accepted,
    Duplicate,
}

/// Result of matching a durably accepted message to an outstanding request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SyncMessageOutcome {
    Matched,
    Unmatched,
}

#[derive(Debug, Clone)]
struct TrackedRequest {
    packet: Value,
    received: BTreeMap<String, Value>,
    staged_completion: Option<Value>,
    completion: Option<Value>,
}

/// Bounded validator for requests and their completion packets in one exchange.
///
/// Each request contains at most 100 sorted IDs. Up to 64 request packets and
/// their completion packets are retained. Observed packet copies are capped at
/// 128 messages and 2 MiB per book, preventing unbounded replay and match state.
#[derive(Debug, Clone, Default)]
pub struct SyncRequestBook {
    requests: BTreeMap<String, TrackedRequest>,
    session: Option<(String, String, String, String)>,
    observed_bytes: usize,
    observed_count: usize,
}

impl SyncRequestBook {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register_request(&mut self, packet: Value) -> Result<SyncRequestOutcome, SyncError> {
        if !is_sync_missing_request_packet(&packet) {
            return Err(SyncError::InvalidSyncRequest);
        }
        let request_id = packet["requestId"].as_str().expect("validated request ID");
        let identity = (
            packet["room"].as_str().expect("validated room").to_owned(),
            packet["syncId"]
                .as_str()
                .expect("validated sync ID")
                .to_owned(),
            packet["sender"]
                .as_str()
                .expect("validated sender")
                .to_owned(),
            packet["targetSender"]
                .as_str()
                .expect("validated target sender")
                .to_owned(),
        );
        if self
            .session
            .as_ref()
            .is_some_and(|session| session != &identity)
        {
            return Err(SyncError::InvalidSyncRequest);
        }
        if let Some(existing) = self.requests.get(request_id) {
            return if existing.packet == packet {
                Ok(SyncRequestOutcome::Duplicate)
            } else {
                Err(SyncError::SyncRequestConflict)
            };
        }
        if self.requests.len() >= MAX_SYNC_REQUESTS {
            return Err(SyncError::SyncRequestLimit);
        }
        self.requests.insert(
            request_id.to_owned(),
            TrackedRequest {
                packet,
                received: BTreeMap::new(),
                staged_completion: None,
                completion: None,
            },
        );
        self.session.get_or_insert(identity);
        Ok(SyncRequestOutcome::Accepted)
    }

    pub fn accept_completion(&mut self, packet: Value) -> Result<SyncRequestOutcome, SyncError> {
        match self.stage_completion(packet.clone())? {
            SyncRequestOutcome::Duplicate => Ok(SyncRequestOutcome::Duplicate),
            SyncRequestOutcome::Accepted => {
                self.finish_completion(
                    packet["requestId"].as_str().expect("validated request ID"),
                    true,
                )?;
                Ok(SyncRequestOutcome::Accepted)
            }
        }
    }

    /// Observe a message after the caller has durably accepted it.
    /// The packet is retained only when it matches an outstanding request.
    pub fn observe_message(&mut self, packet: Value) -> Result<SyncMessageOutcome, SyncError> {
        if !is_message_packet(&packet) {
            return Err(SyncError::InvalidMessage);
        }
        let id = packet["id"].as_str().expect("validated message ID");
        let room = packet["room"].as_str().expect("validated message room");
        let sender = packet["sender"].as_str().expect("validated message sender");
        let matches_request = |tracked: &TrackedRequest| {
            tracked.completion.is_none()
                && tracked.packet["room"] == room
                && tracked.packet["targetSender"] == sender
                && tracked.packet["messageIds"]
                    .as_array()
                    .expect("validated request IDs")
                    .iter()
                    .any(|requested| requested.as_str() == Some(id))
        };
        let matching_requests = self
            .requests
            .values()
            .filter(|tracked| matches_request(tracked))
            .collect::<Vec<_>>();
        if matching_requests.iter().any(|tracked| {
            tracked
                .staged_completion
                .as_ref()
                .is_some_and(|completion| {
                    !completion["messageIds"]
                        .as_array()
                        .expect("validated completion IDs")
                        .iter()
                        .any(|completed| completed.as_str() == Some(id))
                })
        }) {
            return Err(SyncError::InvalidSyncCompletion);
        }
        if matching_requests.iter().any(|tracked| {
            tracked
                .received
                .get(id)
                .is_some_and(|previous| previous != &packet)
        }) {
            return Err(SyncError::MessageConflict);
        }
        if matching_requests.is_empty() {
            return Ok(SyncMessageOutcome::Unmatched);
        }
        let additional = matching_requests
            .iter()
            .filter(|tracked| !tracked.received.contains_key(id))
            .count();
        if additional > 0 {
            let packet_bytes = compact_json_len_with_limit(&packet, MAX_ENVELOPE_BYTES)
                .ok_or(SyncError::EnvelopeTooLarge)?;
            if self.observed_count.saturating_add(additional) > MAX_SYNC_OBSERVED_MESSAGES
                || self
                    .observed_bytes
                    .saturating_add(packet_bytes.saturating_mul(additional))
                    > MAX_SYNC_OBSERVED_BYTES
            {
                return Err(SyncError::SyncObservedLimit);
            }
            self.observed_count += additional;
            self.observed_bytes += packet_bytes * additional;
        }
        for tracked in self.requests.values_mut() {
            if tracked.completion.is_some()
                || tracked.packet["room"] != room
                || tracked.packet["targetSender"] != sender
                || !tracked.packet["messageIds"]
                    .as_array()
                    .expect("validated request IDs")
                    .iter()
                    .any(|requested| requested.as_str() == Some(id))
            {
                continue;
            }
            if let Some(previous) = tracked.received.get(id) {
                debug_assert_eq!(previous, &packet);
                continue;
            }
            tracked.received.insert(id.to_owned(), packet.clone());
        }
        Ok(SyncMessageOutcome::Matched)
    }

    /// Validate a completion and stage it while the caller checks durable storage.
    /// The staged value is not considered complete until `finish_completion(true)`.
    pub fn stage_completion(&mut self, packet: Value) -> Result<SyncRequestOutcome, SyncError> {
        if !is_sync_page_complete_packet(&packet) {
            return Err(SyncError::InvalidSyncCompletion);
        }
        let request_id = packet["requestId"].as_str().expect("validated request ID");
        let tracked = self
            .requests
            .get_mut(request_id)
            .ok_or(SyncError::InvalidSyncCompletion)?;
        if let Some(previous) = &tracked.completion {
            return if previous == &packet {
                Ok(SyncRequestOutcome::Duplicate)
            } else {
                Err(SyncError::SyncRequestConflict)
            };
        }
        if let Some(previous) = &tracked.staged_completion {
            return if previous == &packet {
                Ok(SyncRequestOutcome::Duplicate)
            } else {
                Err(SyncError::SyncRequestConflict)
            };
        }
        let request = &tracked.packet;
        if packet["room"] != request["room"]
            || packet["syncId"] != request["syncId"]
            || packet["sender"] != request["targetSender"]
            || packet["targetSender"] != request["sender"]
        {
            return Err(SyncError::InvalidSyncCompletion);
        }
        let requested = request["messageIds"]
            .as_array()
            .expect("validated request IDs");
        let mut request_offset = 0usize;
        for completed_id in packet["messageIds"]
            .as_array()
            .expect("validated completion IDs")
        {
            let completed_id = completed_id.as_str().expect("validated ID");
            while request_offset < requested.len()
                && requested[request_offset].as_str() != Some(completed_id)
            {
                request_offset += 1;
            }
            if request_offset == requested.len() {
                return Err(SyncError::InvalidSyncCompletion);
            }
            request_offset += 1;
        }
        let completed_ids = packet["messageIds"]
            .as_array()
            .expect("validated completion IDs");
        if tracked
            .received
            .keys()
            .any(|id| !completed_ids.iter().any(|value| value.as_str() == Some(id)))
        {
            return Err(SyncError::InvalidSyncCompletion);
        }
        tracked.staged_completion = Some(packet);
        Ok(SyncRequestOutcome::Accepted)
    }

    /// Commit or discard a previously staged completion after durable checks.
    pub fn finish_completion(&mut self, request_id: &str, durable: bool) -> Result<(), SyncError> {
        let tracked = self
            .requests
            .get_mut(request_id)
            .ok_or(SyncError::InvalidSyncCompletion)?;
        let staged = tracked
            .staged_completion
            .take()
            .ok_or(SyncError::InvalidSyncCompletion)?;
        if durable {
            for packet in tracked.received.values() {
                if let Some(bytes) = compact_json_len_with_limit(packet, MAX_ENVELOPE_BYTES) {
                    self.observed_bytes = self.observed_bytes.saturating_sub(bytes);
                    self.observed_count = self.observed_count.saturating_sub(1);
                }
            }
            tracked.completion = Some(staged);
            tracked.received.clear();
        }
        Ok(())
    }

    pub fn requested_ids(&self, request_id: &str) -> Option<Vec<String>> {
        self.requests.get(request_id).map(|tracked| {
            tracked.packet["messageIds"]
                .as_array()
                .expect("validated request IDs")
                .iter()
                .map(|value| value.as_str().expect("validated ID").to_owned())
                .collect()
        })
    }

    pub fn observed_ids(&self, request_id: &str) -> Option<Vec<String>> {
        self.requests
            .get(request_id)
            .map(|tracked| tracked.received.keys().cloned().collect())
    }

    pub fn completion_ids(&self, request_id: &str) -> Option<Vec<String>> {
        self.requests.get(request_id).and_then(|tracked| {
            tracked
                .staged_completion
                .as_ref()
                .or(tracked.completion.as_ref())
                .map(|packet| {
                    packet["messageIds"]
                        .as_array()
                        .expect("validated completion IDs")
                        .iter()
                        .map(|value| value.as_str().expect("validated ID").to_owned())
                        .collect()
                })
        })
    }

    pub fn is_completed(&self, request_id: &str) -> bool {
        self.requests
            .get(request_id)
            .is_some_and(|tracked| tracked.completion.is_some())
    }

    pub fn verify_durable_messages(
        &self,
        request_id: &str,
        packets: &[Value],
    ) -> Result<bool, SyncError> {
        let tracked = self
            .requests
            .get(request_id)
            .ok_or(SyncError::InvalidSyncCompletion)?;
        let mut durable = BTreeMap::new();
        for packet in packets {
            if !is_message_packet(packet) || packet["room"] != tracked.packet["room"] {
                return Err(SyncError::InvalidMessage);
            }
            let id = packet["id"]
                .as_str()
                .expect("validated message ID")
                .to_owned();
            if durable.insert(id, packet).is_some() {
                return Ok(false);
            }
        }
        Ok(tracked.received.len() == durable.len()
            && tracked
                .received
                .iter()
                .all(|(id, expected)| durable.get(id).is_some_and(|actual| *actual == expected)))
    }

    pub fn has_request(&self, request_id: &str) -> bool {
        self.requests.contains_key(request_id)
    }

    pub fn has_outstanding_message_id(&self, id: &str) -> bool {
        self.requests.values().any(|tracked| {
            tracked.completion.is_none()
                && tracked.packet["messageIds"]
                    .as_array()
                    .expect("validated request IDs")
                    .iter()
                    .any(|value| value.as_str() == Some(id))
        })
    }

    pub fn len(&self) -> usize {
        self.requests.len()
    }

    pub fn is_empty(&self) -> bool {
        self.requests.is_empty()
    }
}

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
        let encoded_len = compact_json_len_with_limit(&packet, MAX_ENVELOPE_BYTES)
            .ok_or(SyncError::EnvelopeTooLarge)?;
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

    #[test]
    fn shared_accepted_message_batch_vectors_match_core_validation() {
        let vectors: Vec<Value> = serde_json::from_str(include_str!(
            "../../../packages/protocol/vectors/sync-accepted-message-batch-v1.json"
        ))
        .expect("shared accepted-message batch vectors are valid JSON");
        for vector in vectors {
            let mut batch = vector["batch"].clone();
            let mut expected_ids = vector["expectedIds"].clone();
            if let Some(id_count) = vector["largeRequestedIdCount"].as_u64() {
                let ids = (0..id_count)
                    .map(|index| format!("id{index:03}"))
                    .collect::<Vec<_>>();
                batch["requestedIds"] = serde_json::to_value(&ids).unwrap();
                expected_ids = serde_json::to_value(ids).unwrap();
            }
            if let Some(body_length) = vector["largeBodyChars"].as_u64() {
                batch["messages"][0]["body"] = Value::String("x".repeat(body_length as usize));
            }
            let expected_ids = expected_ids
                .as_array()
                .unwrap()
                .iter()
                .map(|id| id.as_str().unwrap().to_owned())
                .collect::<Vec<_>>();
            let actual = validate_sync_accepted_message_batch(
                &batch,
                vector["expectedRoom"].as_str().unwrap(),
                &expected_ids,
            )
            .is_ok();
            assert_eq!(actual, vector["valid"], "vector: {}", vector["name"]);
        }
    }

    #[test]
    fn local_inventory_validates_snapshot_and_freezes_pages_and_membership() {
        assert_eq!(
            LocalInventory::from_snapshot(2, "room", vec![], true, false),
            Err(SyncError::InvalidLocalInventory)
        );
        assert_eq!(
            LocalInventory::from_snapshot(1, "room", vec!["b".into(), "a".into()], true, false),
            Err(SyncError::InvalidLocalInventory)
        );
        assert_eq!(
            LocalInventory::from_snapshot(1, "room", vec![], false, false),
            Err(SyncError::IncompleteLocalInventory)
        );
        assert_eq!(
            LocalInventory::from_snapshot(1, "room", vec!["a".into()], false, true),
            Err(SyncError::InvalidLocalInventory)
        );

        let empty = LocalInventory::from_snapshot(1, "room", vec![], true, false).unwrap();
        let packet = empty.page("sender", "session", 0).unwrap();
        assert!(crate::is_sync_inventory_page_packet(&packet));
        assert_eq!(packet["messageIds"], serde_json::json!([]));
        assert!(!packet["limitReached"].as_bool().unwrap());

        let ids: Vec<String> = (0..101).map(|index| format!("id-{index:03}")).collect();
        let inventory = LocalInventory::from_snapshot(1, "room", ids.clone(), true, false).unwrap();
        assert!(inventory.contains("id-050"));
        assert!(!inventory.contains("missing"));
        let first = inventory.page("sender", "session", 0).unwrap();
        let last = inventory.page("sender", "session", 100).unwrap();
        assert!(crate::is_sync_inventory_page_packet(&first));
        assert!(crate::is_sync_inventory_page_packet(&last));
        assert_eq!(first["messageIds"].as_array().unwrap().len(), 100);
        assert_eq!(first["hasMore"], true);
        assert_eq!(last["messageIds"], serde_json::json!(["id-100"]));
        assert_eq!(
            inventory
                .missing_ids(&["id-050".into(), "id-101".into()])
                .unwrap(),
            vec!["id-101"]
        );
    }

    #[test]
    fn only_verified_4097th_accepted_id_sets_inventory_limit_flag() {
        let ids: Vec<String> = (0..MAX_SYNC_INVENTORY_IDS)
            .map(|index| format!("id-{index:04}"))
            .collect();
        assert_eq!(
            LocalInventory::from_snapshot(1, "room", ids.clone(), false, false),
            Err(SyncError::IncompleteLocalInventory)
        );
        let inventory = LocalInventory::from_snapshot(1, "room", ids, false, true).unwrap();
        let final_page = inventory.page("sender", "session", 4_000).unwrap();
        assert!(crate::is_sync_inventory_page_packet(&final_page));
        assert_eq!(final_page["limitReached"], true);
        assert_eq!(
            inventory.page("sender", "session", 0).unwrap()["limitReached"],
            false
        );
    }

    #[test]
    fn coverage_outcome_waits_for_every_active_plan_and_keeps_incompleteness() {
        let mut coverage = SyncCoverage::default();
        assert_eq!(coverage.outcome(), "complete");
        coverage.begin_plan();
        coverage.begin_plan();
        assert_eq!(coverage.outcome(), "syncing");
        coverage.finish_plan();
        assert_eq!(coverage.outcome(), "syncing");
        coverage.abandon_plan();
        assert_eq!(coverage.active_plan_count(), 0);
        assert_eq!(coverage.outcome(), "partial");
        coverage.begin_plan();
        assert_eq!(coverage.outcome(), "partial");
        coverage.finish_plan();
        assert_eq!(coverage.outcome(), "partial");
    }

    fn inventory_page(
        sync_id: &str,
        cursor: Option<&str>,
        ids: &[&str],
        has_more: bool,
        limit_reached: bool,
    ) -> Value {
        serde_json::json!({
            "version": 1,
            "type": "sync_inventory_page",
            "room": "room1",
            "syncId": sync_id,
            "sender": "device-a",
            "cursor": cursor,
            "messageIds": ids,
            "nextCursor": ids.last().copied(),
            "hasMore": has_more,
            "limitReached": limit_reached,
        })
    }

    fn sync_request(request_id: &str, ids: &[&str]) -> Value {
        serde_json::json!({
            "version": 1,
            "type": "sync_missing_request",
            "room": "room1",
            "syncId": "sync-1",
            "requestId": request_id,
            "sender": "device-a",
            "targetSender": "device-b",
            "messageIds": ids,
        })
    }

    fn sync_completion(request_id: &str, ids: &[&str]) -> Value {
        serde_json::json!({
            "version": 1,
            "type": "sync_page_complete",
            "room": "room1",
            "syncId": "sync-1",
            "requestId": request_id,
            "sender": "device-b",
            "targetSender": "device-a",
            "messageIds": ids,
        })
    }

    #[test]
    fn shared_sync_state_vectors_match_core_outcomes() {
        let vectors: Value = serde_json::from_str(include_str!(
            "../../../packages/protocol/vectors/sync-state-v1.json"
        ))
        .expect("shared sync state vectors are valid JSON");

        for vector in vectors.as_array().expect("vector list") {
            let mut inventory = SyncInventoryReceiver::new();
            let mut requests = SyncRequestBook::new();
            let mut selector: Option<MissingIdSelector> = None;
            for operation in vector["operations"].as_array().expect("operations") {
                let value = operation["value"].clone();
                let actual = match operation["kind"].as_str().expect("operation kind") {
                    "selector_start" => {
                        let peer_ids: Vec<String> =
                            serde_json::from_value(value["peerIds"].clone()).expect("peer IDs");
                        match MissingIdSelector::new(&peer_ids) {
                            Ok(created) => {
                                selector = Some(created);
                                serde_json::json!({ "ok": true })
                            }
                            Err(error) => serde_json::json!({
                                "ok": false,
                                "code": match error {
                                    SyncError::KnownIdLimit => "known_id_limit",
                                    SyncError::InvalidIdentifier => "invalid_identifier",
                                    _ => panic!("unexpected selector creation error: {error}"),
                                },
                            }),
                        }
                    }
                    "selector_local" => {
                        let local_ids: Vec<String> =
                            serde_json::from_value(value["localIds"].clone()).expect("local IDs");
                        match selector
                            .as_mut()
                            .expect("selector initialized")
                            .observe_local_ids(&local_ids)
                        {
                            Ok(()) => serde_json::json!({ "ok": true }),
                            Err(error) => serde_json::json!({
                                "ok": false,
                                "code": match error {
                                    SyncError::InvalidPageLimit => "invalid_page_limit",
                                    SyncError::InvalidIdentifier => "invalid_identifier",
                                    _ => panic!("unexpected local scan error: {error}"),
                                },
                            }),
                        }
                    }
                    "selector_finish" => {
                        match selector.as_mut().expect("selector initialized").finish() {
                            Ok(missing_ids) => {
                                serde_json::json!({ "ok": true, "missingIds": missing_ids })
                            }
                            Err(error) => serde_json::json!({
                                "ok": false,
                                "code": match error {
                                    SyncError::InvalidPageLimit => "invalid_page_limit",
                                    _ => panic!("unexpected selector finish error: {error}"),
                                },
                            }),
                        }
                    }
                    "plan_batch" => {
                        let missing_ids: Vec<String> =
                            serde_json::from_value(value["missingIds"].clone())
                                .expect("missing IDs");
                        let offset: usize =
                            serde_json::from_value(value["offset"].clone()).expect("batch offset");
                        match plan_missing_batch(&missing_ids, offset) {
                            Ok(ids) => {
                                let next_offset = offset + ids.len();
                                serde_json::json!({
                                    "ok": true,
                                    "ids": ids,
                                    "nextOffset": next_offset,
                                    "hasMore": next_offset < missing_ids.len(),
                                })
                            }
                            Err(error) => serde_json::json!({
                                "ok": false,
                                "code": match error {
                                    SyncError::KnownIdLimit => "known_id_limit",
                                    SyncError::InvalidIdentifier => "invalid_identifier",
                                    SyncError::InvalidPageLimit => "invalid_page_limit",
                                    _ => panic!("unexpected batch vector error: {error}"),
                                },
                            }),
                        }
                    }
                    "inventory_page" => match inventory.accept_page(value) {
                        Ok(outcome) => serde_json::json!({
                            "ok": true,
                            "outcome": match outcome {
                                InventoryPageOutcome::Accepted => "accepted",
                                InventoryPageOutcome::Duplicate => "duplicate",
                            },
                            "ids": inventory.ids(),
                            "complete": inventory.is_complete(),
                            "limitReached": inventory.limit_reached(),
                        }),
                        Err(error) => serde_json::json!({
                            "ok": false,
                            "code": match error {
                                SyncError::InventoryConflict => "inventory_conflict",
                                SyncError::InvalidInventorySequence => "invalid_inventory_sequence",
                                _ => panic!("unexpected inventory vector error: {error}"),
                            },
                        }),
                    },
                    "set_missing_ids" => {
                        let ids: Vec<String> =
                            serde_json::from_value(value["ids"].clone()).unwrap();
                        match inventory.set_missing_ids(ids) {
                            Ok(()) => serde_json::json!({"ok": true}),
                            Err(error) => serde_json::json!({"ok": false, "code": match error {
                                SyncError::InvalidInventorySequence => "invalid_inventory_sequence",
                                SyncError::InvalidSyncRequest => "invalid_sync_request",
                                SyncError::InvalidIdentifier => "invalid_identifier",
                                _ => panic!("unexpected missing-plan vector error: {error}"),
                            }}),
                        }
                    }
                    "inventory_batch" => match inventory.next_missing_batch() {
                        Ok((ids, has_more)) => {
                            serde_json::json!({"ok": true, "ids": ids, "hasMore": has_more})
                        }
                        Err(error) => serde_json::json!({"ok": false, "code": match error {
                            SyncError::InvalidSyncRequest => "invalid_sync_request",
                            _ => panic!("unexpected inventory-batch vector error: {error}"),
                        }}),
                    },
                    "request" => match requests.register_request(value) {
                        Ok(outcome) => serde_json::json!({
                            "ok": true,
                            "outcome": match outcome {
                                SyncRequestOutcome::Accepted => "accepted",
                                SyncRequestOutcome::Duplicate => "duplicate",
                            },
                        }),
                        Err(error) => serde_json::json!({
                            "ok": false,
                            "code": match error {
                                SyncError::SyncRequestConflict => "sync_request_conflict",
                                SyncError::SyncRequestLimit => "sync_request_limit",
                                _ => panic!("unexpected request vector error: {error}"),
                            },
                        }),
                    },
                    "completion" => match requests.accept_completion(value) {
                        Ok(outcome) => serde_json::json!({
                            "ok": true,
                            "outcome": match outcome {
                                SyncRequestOutcome::Accepted => "accepted",
                                SyncRequestOutcome::Duplicate => "duplicate",
                            },
                        }),
                        Err(error) => serde_json::json!({
                            "ok": false,
                            "code": match error {
                                SyncError::InvalidSyncCompletion => "invalid_sync_completion",
                                SyncError::SyncRequestConflict => "sync_request_conflict",
                                _ => panic!("unexpected completion vector error: {error}"),
                            },
                        }),
                    },
                    "observe_message" => match requests.observe_message(value) {
                        Ok(outcome) => serde_json::json!({
                            "ok": true,
                            "outcome": match outcome {
                                SyncMessageOutcome::Matched => "matched",
                                SyncMessageOutcome::Unmatched => "unmatched",
                            },
                        }),
                        Err(error) => serde_json::json!({
                            "ok": false,
                            "code": match error {
                                SyncError::MessageConflict => "message_conflict",
                                SyncError::InvalidMessage => "invalid_message",
                                SyncError::SyncObservedLimit => "sync_observed_limit",
                                _ => panic!("unexpected observed-message vector error: {error}"),
                            },
                        }),
                    },
                    "stage_completion" => match requests.stage_completion(value) {
                        Ok(outcome) => {
                            let request_id = operation["value"]["requestId"].as_str().unwrap();
                            serde_json::json!({
                                "ok": true,
                                "outcome": match outcome {
                                    SyncRequestOutcome::Accepted => "accepted",
                                    SyncRequestOutcome::Duplicate => "duplicate",
                                },
                                "requestedIds": requests.requested_ids(request_id).unwrap_or_default(),
                                "observedIds": requests.observed_ids(request_id).unwrap_or_default(),
                                "completedIds": requests.completion_ids(request_id).unwrap_or_default(),
                                "isCompleted": requests.is_completed(request_id),
                            })
                        }
                        Err(error) => serde_json::json!({
                            "ok": false,
                            "code": match error {
                                SyncError::InvalidSyncCompletion => "invalid_sync_completion",
                                SyncError::SyncRequestConflict => "sync_request_conflict",
                                _ => panic!("unexpected staged-completion vector error: {error}"),
                            },
                        }),
                    },
                    "finish_completion" => {
                        let request_id = value["requestId"].as_str().unwrap();
                        match requests
                            .finish_completion(request_id, value["durable"].as_bool().unwrap())
                        {
                            Ok(()) => serde_json::json!({"ok": true}),
                            Err(error) => serde_json::json!({"ok": false, "code": match error {
                                SyncError::InvalidSyncCompletion => "invalid_sync_completion",
                                _ => panic!("unexpected finish-completion vector error: {error}"),
                            }}),
                        }
                    }
                    "outstanding" => serde_json::json!({
                        "ok": true,
                        "outstanding": requests.has_outstanding_message_id(value["id"].as_str().unwrap())
                    }),
                    "durable_check" => {
                        let packets: Vec<Value> =
                            serde_json::from_value(value["packets"].clone()).unwrap();
                        match requests
                            .verify_durable_messages(value["requestId"].as_str().unwrap(), &packets)
                        {
                            Ok(matches) => serde_json::json!({"ok": true, "matches": matches}),
                            Err(error) => serde_json::json!({"ok": false, "code": match error {
                                SyncError::InvalidSyncCompletion => "invalid_sync_completion",
                                SyncError::InvalidMessage => "invalid_message",
                                _ => panic!("unexpected durable-check vector error: {error}"),
                            }}),
                        }
                    }
                    "reset_state" => {
                        inventory = SyncInventoryReceiver::new();
                        requests = SyncRequestBook::new();
                        serde_json::json!({"ok": true})
                    }
                    "fill_requests" => {
                        let count = value["count"].as_u64().unwrap() as usize;
                        for index in 0..count {
                            let request = serde_json::json!({
                                "version": 1, "type": "sync_missing_request", "room": "room1",
                                "syncId": "sync-1", "requestId": format!("bounded-{index}"),
                                "sender": "device-a", "targetSender": "device-b", "messageIds": ["alpha"]
                            });
                            requests
                                .register_request(request)
                                .expect("fill within request bound");
                        }
                        serde_json::json!({"ok": true, "count": requests.len()})
                    }
                    kind => panic!("unknown sync vector operation: {kind}"),
                };
                assert_eq!(actual, operation["expected"], "vector: {}", vector["name"]);
                if actual["ok"] == false {
                    assert_eq!(actual.as_object().expect("error result").len(), 2);
                }
            }
        }
    }

    #[test]
    fn missing_id_planning_is_ordered_bounded_and_offset_checked() {
        let peer = vec!["a".to_owned(), "b".to_owned(), "c".to_owned()];
        let local = vec!["b".to_owned()];
        let mut selector = MissingIdSelector::new(&peer).unwrap();
        selector.observe_local_ids(&local).unwrap();
        assert_eq!(selector.finish().unwrap(), ["a", "c"]);
        assert_eq!(selector.finish(), Err(SyncError::InvalidPageLimit));
        let mut duplicate_selector = MissingIdSelector::new(&peer).unwrap();
        duplicate_selector
            .observe_local_ids(&["b".into(), "b".into()])
            .unwrap();
        assert_eq!(duplicate_selector.finish().unwrap(), ["a", "c"]);
        assert_eq!(
            MissingIdSelector::new(&["b".into(), "a".into()]).unwrap_err(),
            SyncError::InvalidIdentifier
        );
        assert_eq!(
            plan_missing_batch(&peer, 4),
            Err(SyncError::InvalidPageLimit)
        );
        let over_limit = (0..=MAX_SYNC_INVENTORY_IDS)
            .map(|i| format!("id{i:04}"))
            .collect::<Vec<_>>();
        assert_eq!(
            MissingIdSelector::new(&over_limit).unwrap_err(),
            SyncError::KnownIdLimit
        );
        assert_eq!(
            plan_missing_batch(&over_limit, 0),
            Err(SyncError::KnownIdLimit)
        );
        let ids = (0..crate::MAX_SYNC_PACKET_IDS + 1)
            .map(|i| format!("id{i:03}"))
            .collect::<Vec<_>>();
        assert_eq!(
            plan_missing_batch(&ids, 0).unwrap().len(),
            crate::MAX_SYNC_PACKET_IDS
        );
        assert_eq!(
            plan_missing_batch(&ids, crate::MAX_SYNC_PACKET_IDS).unwrap(),
            [ids.last().unwrap().clone()]
        );
        let mut many_local_selector = MissingIdSelector::new(&peer).unwrap();
        for _ in 0..2 {
            many_local_selector
                .observe_local_ids(&vec!["b".to_owned(); MAX_SYNC_SELECTION_CHUNK_IDS])
                .unwrap();
        }
        assert_eq!(many_local_selector.finish().unwrap(), ["a", "c"]);
        assert_eq!(
            many_local_selector.observe_local_ids(&[]),
            Err(SyncError::InvalidPageLimit)
        );
    }

    #[test]
    fn inventory_receiver_enforces_cursor_identity_order_and_idempotency() {
        let first = inventory_page("sync-1", None, &["a", "b"], true, false);
        let second = inventory_page("sync-1", Some("b"), &["c"], false, true);
        let mut receiver = SyncInventoryReceiver::new();

        assert_eq!(
            receiver.accept_page(first.clone()),
            Ok(InventoryPageOutcome::Accepted)
        );
        assert_eq!(
            receiver.accept_page(first.clone()),
            Ok(InventoryPageOutcome::Duplicate)
        );
        assert_eq!(receiver.ids(), &["a", "b"]);
        assert!(!receiver.is_complete());
        assert_eq!(
            receiver.accept_page(inventory_page("other", Some("b"), &["c"], false, false)),
            Err(SyncError::InvalidInventorySequence)
        );
        assert_eq!(
            receiver.accept_page(inventory_page("sync-1", Some("a"), &["c"], false, false)),
            Err(SyncError::InvalidInventorySequence)
        );
        assert_eq!(
            receiver.accept_page(second.clone()),
            Ok(InventoryPageOutcome::Accepted)
        );
        assert_eq!(
            receiver.accept_page(second),
            Ok(InventoryPageOutcome::Duplicate)
        );
        assert!(receiver.is_complete());
        assert!(receiver.limit_reached());
        assert_eq!(receiver.ids(), &["a", "b", "c"]);
        assert_eq!(
            receiver.accept_page(inventory_page("sync-1", Some("c"), &["d"], false, false)),
            Err(SyncError::InvalidInventorySequence)
        );
    }

    #[test]
    fn inventory_receiver_rejects_changed_page_for_same_cursor_and_count_overflow() {
        let first = inventory_page("sync-1", None, &["a"], true, false);
        let mut receiver = SyncInventoryReceiver::new();
        receiver.accept_page(first).unwrap();
        assert_eq!(
            receiver.accept_page(inventory_page("sync-1", None, &["a"], false, false)),
            Err(SyncError::InventoryConflict)
        );

        let mut receiver = SyncInventoryReceiver::new();
        for page_index in 0..40 {
            let start = page_index * 100;
            let end = (start + 100).min(MAX_SYNC_INVENTORY_IDS);
            let ids = (start..end)
                .map(|index| format!("id-{index:04}"))
                .collect::<Vec<_>>();
            let cursor = if start == 0 {
                None
            } else {
                Some(format!("id-{:04}", start - 1))
            };
            let value = serde_json::json!({
                "version": 1,
                "type": "sync_inventory_page",
                "room": "room1",
                "syncId": "sync-max",
                "sender": "device-a",
                "cursor": cursor,
                "messageIds": ids,
                "nextCursor": format!("id-{:04}", end - 1),
                "hasMore": true,
                "limitReached": false,
            });
            receiver.accept_page(value).unwrap();
        }
        assert_eq!(receiver.ids().len(), 4_000);
        assert!(!receiver.is_complete());
        let overflowing_ids = (4_000..4_100)
            .map(|index| format!("id-{index:04}"))
            .collect::<Vec<_>>();
        assert_eq!(
            receiver.accept_page(serde_json::json!({
                "version": 1,
                "type": "sync_inventory_page",
                "room": "room1",
                "syncId": "sync-max",
                "sender": "device-a",
                "cursor": "id-3999",
                "messageIds": overflowing_ids,
                "nextCursor": "id-4099",
                "hasMore": false,
                "limitReached": true,
            })),
            Err(SyncError::InventoryLimit)
        );
        assert_eq!(receiver.ids().len(), 4_000);
    }

    #[test]
    fn request_book_bounds_and_matches_completion_to_requested_subset() {
        let mut book = SyncRequestBook::new();
        let request = sync_request("request-1", &["a", "c", "e"]);
        assert_eq!(
            book.register_request(request.clone()),
            Ok(SyncRequestOutcome::Accepted)
        );
        assert_eq!(
            book.register_request(request),
            Ok(SyncRequestOutcome::Duplicate)
        );
        assert_eq!(
            book.register_request(sync_request("request-1", &["a", "b"])),
            Err(SyncError::SyncRequestConflict)
        );
        assert_eq!(
            book.register_request(sync_request("request-2", &["a", "c"])),
            Ok(SyncRequestOutcome::Accepted)
        );
        assert_eq!(
            book.register_request({
                let mut other = sync_request("request-3", &["a"]);
                other["syncId"] = Value::String("different-sync".to_owned());
                other
            }),
            Err(SyncError::InvalidSyncRequest)
        );

        let completion = sync_completion("request-1", &["a", "e"]);
        assert_eq!(
            book.accept_completion(completion.clone()),
            Ok(SyncRequestOutcome::Accepted)
        );
        assert_eq!(
            book.accept_completion(completion),
            Ok(SyncRequestOutcome::Duplicate)
        );
        assert_eq!(
            book.accept_completion(sync_completion("request-1", &["b"])),
            Err(SyncError::SyncRequestConflict)
        );
        assert_eq!(
            book.accept_completion(sync_completion("request-2", &["b"])),
            Err(SyncError::InvalidSyncCompletion)
        );
        assert_eq!(
            book.accept_completion(sync_completion("unknown", &["a"])),
            Err(SyncError::InvalidSyncCompletion)
        );
    }

    #[test]
    fn request_book_has_a_hard_outstanding_request_bound() {
        let mut book = SyncRequestBook::new();
        for index in 0..MAX_SYNC_REQUESTS {
            assert_eq!(
                book.register_request(sync_request(&format!("request-{index}"), &["a"])),
                Ok(SyncRequestOutcome::Accepted)
            );
        }
        assert_eq!(book.len(), MAX_SYNC_REQUESTS);
        assert_eq!(
            book.register_request(sync_request("one-too-many", &["a"])),
            Err(SyncError::SyncRequestLimit)
        );
    }

    #[test]
    fn request_book_bounds_observed_packets_and_keeps_limit_failure_atomic() {
        let mut book = SyncRequestBook::new();
        for index in 0..MAX_SYNC_REQUESTS {
            let request = sync_request(&format!("request-{index}"), &["a", "b", "c"]);
            book.register_request(request).unwrap();
        }
        let observed = |id: &str| {
            serde_json::json!({
                "version": 1,
                "type": "message",
                "id": id,
                "room": "room1",
                "sender": "device-b",
                "senderName": "B",
                "createdAt": "2026-10-14T12:00:00Z",
                "body": "payload",
            })
        };
        assert_eq!(
            book.observe_message(observed("a")),
            Ok(SyncMessageOutcome::Matched)
        );
        assert_eq!(
            book.observe_message(observed("b")),
            Ok(SyncMessageOutcome::Matched)
        );
        assert_eq!(book.observed_count, MAX_SYNC_OBSERVED_MESSAGES);
        assert_eq!(
            book.observe_message(observed("c")),
            Err(SyncError::SyncObservedLimit)
        );
        assert_eq!(book.observed_count, MAX_SYNC_OBSERVED_MESSAGES);
        for index in 0..MAX_SYNC_REQUESTS {
            assert_eq!(
                book.observed_ids(&format!("request-{index}")).unwrap(),
                ["a", "b"]
            );
        }
    }

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
            Err(SyncError::EnvelopeTooLarge)
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

    #[test]
    #[allow(non_snake_case)]
    fn generated_sync_invariants_NEARLINK_SYNC_PROPERTIES_OK() {
        let chunk_sizes = [1usize, 17, 3, MAX_SYNC_SELECTION_CHUNK_IDS, 29, 0, 257];
        for case in 0..24usize {
            let peer_count = (case * 13) % 81;
            let peer_ids = (0..peer_count)
                .map(|index| format!("peer-{index:04}"))
                .collect::<Vec<_>>();
            let mut local_ids = (0..(case * 19 % 173))
                .map(|index| {
                    if index % 3 == 0 && peer_count > 0 {
                        peer_ids[(index * 7 + case) % peer_count].clone()
                    } else {
                        format!("local-{case:02}-{index:04}")
                    }
                })
                .collect::<Vec<_>>();
            if peer_count > 0 {
                local_ids.extend([peer_ids[0].clone(), peer_ids[0].clone()]);
                local_ids.extend(peer_ids.iter().step_by(5).cloned());
            }
            if case == 23 {
                local_ids.extend(std::iter::repeat("peer-0000".to_owned()).take(4_500));
            }

            let local_set = local_ids.iter().cloned().collect::<BTreeSet<_>>();
            let expected_missing = peer_ids
                .iter()
                .filter(|id| !local_set.contains(*id))
                .cloned()
                .collect::<Vec<_>>();
            let mut selector = MissingIdSelector::new(&peer_ids).unwrap();
            let mut offset = 0usize;
            let mut chunk_index = case % chunk_sizes.len();
            while offset < local_ids.len() {
                let requested_size = chunk_sizes[chunk_index % chunk_sizes.len()];
                chunk_index += 1;
                let size = if requested_size == 0 {
                    1
                } else {
                    requested_size
                };
                let end = (offset + size.min(MAX_SYNC_SELECTION_CHUNK_IDS)).min(local_ids.len());
                selector.observe_local_ids(&local_ids[offset..end]).unwrap();
                offset = end;
            }
            assert_eq!(
                selector.finish().unwrap(),
                expected_missing,
                "selector case {case}"
            );
        }

        let boundary_peer = vec!["boundary-a".to_owned(), "boundary-b".to_owned()];
        let over_limit_local = vec!["boundary-b".to_owned(); MAX_SYNC_SELECTION_CHUNK_IDS + 1];
        let mut boundary_selector = MissingIdSelector::new(&boundary_peer).unwrap();
        assert_eq!(
            boundary_selector.observe_local_ids(&over_limit_local),
            Err(SyncError::InvalidPageLimit)
        );
        assert_eq!(boundary_selector.finish().unwrap(), boundary_peer);

        for case in 0..18usize {
            let message_count = case * 9;
            let ids = (0..message_count)
                .map(|index| format!("msg-{index:04}"))
                .collect::<Vec<_>>();
            let known_ids = ids
                .iter()
                .enumerate()
                .filter(|(index, _)| (index + case) % 4 == 0)
                .map(|(_, id)| id.clone())
                .collect::<Vec<_>>();
            let known = known_ids.iter().cloned().collect::<BTreeSet<_>>();
            let expected = ids
                .iter()
                .filter(|id| !known.contains(*id))
                .cloned()
                .collect::<Vec<_>>();
            let page_size = case % 11 + 1;
            let mut index = MessageIndex::new("room1").unwrap();
            for index_id in (0..message_count).rev() {
                let id = &ids[index_id];
                let value = packet(
                    id,
                    &format!("body-{case}-{index_id}"),
                    "2026-10-14T12:00:00Z",
                );
                assert_eq!(index.insert(value.clone()), Ok(InsertOutcome::Inserted));
                assert_eq!(index.insert(value), Ok(InsertOutcome::Duplicate));
            }

            let mut actual = Vec::new();
            let mut cursor: Option<String> = None;
            loop {
                let page = index
                    .page_missing_from(&known_ids, cursor.as_deref(), page_size)
                    .unwrap();
                let page_ids = page
                    .messages
                    .iter()
                    .map(|value| value["id"].as_str().unwrap().to_owned())
                    .collect::<Vec<_>>();
                let oracle_offset = actual.len();
                let oracle_end = (oracle_offset + page_size).min(expected.len());
                assert_eq!(
                    page_ids,
                    expected[oracle_offset..oracle_end],
                    "page case {case}"
                );
                actual.extend(page_ids);
                assert_eq!(page.next_cursor, actual.last().cloned());
                assert_eq!(page.has_more, actual.len() < expected.len());
                if !page.has_more {
                    break;
                }
                cursor = page.next_cursor;
            }
            assert_eq!(actual, expected, "continuation case {case}");
        }

        for case in 0..20usize {
            let mut index = MessageIndex::new("room1").unwrap();
            let count = 1 + (case % 15);
            let mut expected = Vec::new();
            for item in 0..count {
                let id = format!("conflict-{case:02}-{item:03}");
                let original = packet(&id, &format!("original-{item}"), "2026-10-14T12:00:00Z");
                assert_eq!(index.insert(original.clone()), Ok(InsertOutcome::Inserted));
                assert_eq!(index.insert(original.clone()), Ok(InsertOutcome::Duplicate));
                expected.push(original);
            }
            let before = index
                .page_missing_from(&[], None, MAX_PAGE_MESSAGES)
                .unwrap();
            let conflict_id = format!("conflict-{case:02}-{:03}", count / 2);
            assert_eq!(
                index.insert(packet(
                    &conflict_id,
                    "different packet",
                    "2026-10-14T12:00:00Z"
                )),
                Err(SyncError::MessageConflict)
            );
            let after = index
                .page_missing_from(&[], None, MAX_PAGE_MESSAGES)
                .unwrap();
            assert_eq!(after.messages, expected, "conflict case {case}");
            assert_eq!(after, before, "conflict observable page case {case}");
        }

        for case in 0..16usize {
            let inventory_ids = (0..(case * 7 % 49))
                .map(|index| format!("inventory-{index:04}"))
                .collect::<Vec<_>>();
            let partition = case % 5 + 1;
            let mut receiver = SyncInventoryReceiver::new();
            let mut cursor = None;
            for (chunk_index, chunk) in inventory_ids.chunks(partition).enumerate() {
                let chunk_refs = chunk.iter().map(String::as_str).collect::<Vec<_>>();
                let has_more = (chunk_index + 1) * partition < inventory_ids.len();
                let page = inventory_page(
                    &format!("sync-{case}"),
                    cursor.as_deref(),
                    &chunk_refs,
                    has_more,
                    !has_more && case % 2 == 0,
                );
                assert_eq!(
                    receiver.accept_page(page.clone()),
                    Ok(InventoryPageOutcome::Accepted)
                );
                assert_eq!(
                    receiver.accept_page(page),
                    Ok(InventoryPageOutcome::Duplicate)
                );
                cursor = chunk.last().cloned();
            }
            if inventory_ids.is_empty() {
                let empty_page = inventory_page(&format!("sync-{case}"), None, &[], false, false);
                assert_eq!(
                    receiver.accept_page(empty_page.clone()),
                    Ok(InventoryPageOutcome::Accepted)
                );
                assert_eq!(
                    receiver.accept_page(empty_page),
                    Ok(InventoryPageOutcome::Duplicate)
                );
            }
            assert_eq!(
                receiver.ids(),
                inventory_ids,
                "inventory replay case {case}"
            );
            assert!(receiver.is_complete());

            let expected_missing = inventory_ids
                .iter()
                .enumerate()
                .filter(|(index, _)| (index + case) % 3 != 0)
                .map(|(_, id)| id.clone())
                .collect::<Vec<_>>();
            receiver.set_missing_ids(expected_missing.clone()).unwrap();
            receiver.set_missing_ids(expected_missing.clone()).unwrap();
            assert_eq!(
                receiver.set_missing_ids(inventory_ids.clone()),
                if inventory_ids == expected_missing {
                    Ok(())
                } else {
                    Err(SyncError::SyncRequestConflict)
                }
            );
            let mut batched = Vec::new();
            while receiver.has_missing_ids_remaining() {
                let (batch, has_more) = receiver.next_missing_batch().unwrap();
                assert_eq!(
                    has_more,
                    batched.len() + batch.len() < expected_missing.len()
                );
                batched.extend(batch);
            }
            assert_eq!(batched, expected_missing, "request replay case {case}");
        }

        for case in 0..20usize {
            let requested = (0..(case % 7 + 1))
                .map(|index| format!("requested-{index:03}"))
                .collect::<Vec<_>>();
            let requested_refs = requested.iter().map(String::as_str).collect::<Vec<_>>();
            let request = sync_request(&format!("request-{case}"), &requested_refs);
            let mut book = SyncRequestBook::new();
            assert_eq!(
                book.register_request(request.clone()),
                Ok(SyncRequestOutcome::Accepted)
            );
            assert_eq!(
                book.register_request(request),
                Ok(SyncRequestOutcome::Duplicate)
            );
            assert_eq!(
                book.register_request(sync_request(
                    &format!("request-{case}"),
                    &["different-message"],
                )),
                Err(SyncError::SyncRequestConflict)
            );
            assert_eq!(
                book.requested_ids(&format!("request-{case}")).unwrap(),
                requested
            );
            let mut observed = BTreeSet::new();
            for (index, id) in requested.iter().enumerate() {
                if (index + case) % 2 == 0 {
                    let mut value =
                        packet(id, &format!("body-{case}-{index}"), "2026-10-14T12:00:00Z");
                    value["sender"] = Value::String("device-b".to_owned());
                    assert_eq!(
                        book.observe_message(value.clone()),
                        Ok(SyncMessageOutcome::Matched)
                    );
                    assert_eq!(book.observe_message(value), Ok(SyncMessageOutcome::Matched));
                    observed.insert(id.clone());
                }
            }
            assert_eq!(
                book.observed_ids(&format!("request-{case}")).unwrap(),
                observed.iter().cloned().collect::<Vec<_>>()
            );
            let completed = observed.iter().cloned().collect::<Vec<_>>();
            let completed_refs = completed.iter().map(String::as_str).collect::<Vec<_>>();
            let completion = sync_completion(&format!("request-{case}"), &completed_refs);
            assert_eq!(
                book.accept_completion(completion.clone()),
                Ok(SyncRequestOutcome::Accepted)
            );
            assert_eq!(
                book.accept_completion(completion),
                Ok(SyncRequestOutcome::Duplicate)
            );
            assert!(book.is_completed(&format!("request-{case}")));
            assert_eq!(
                book.completion_ids(&format!("request-{case}")),
                Some(completed)
            );
        }
    }
}
