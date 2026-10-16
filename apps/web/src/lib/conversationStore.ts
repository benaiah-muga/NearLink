import type {
  LocalIdentity,
  StoragePersistenceResult,
  StoredMessage,
  DeliveryState,
  InboundAcceptanceResult,
  LocalMessagePage,
  LocalMessagePageCursor,
  QueuedMessagePage,
  QueuedMessagePageCursor,
} from "./storage";
import type { MessagePacket } from "@nearlink/protocol";

/** Persistence operations used by the browser application layer. */
export interface ConversationStore {
  loadIdentity(): Promise<LocalIdentity | null>;
  saveIdentity(identity: LocalIdentity): Promise<void>;
  loadMessages(room: string): Promise<StoredMessage[]>;
  loadMessage(room: string, id: string): Promise<StoredMessage | null>;
  loadMessagePage(room: string, before?: LocalMessagePageCursor | null, limit?: number): Promise<LocalMessagePage>;
  loadQueuedMessagePage(room: string, transport: "hub" | "direct", after?: QueuedMessagePageCursor | null, limit?: number): Promise<QueuedMessagePage>;
  loadAcceptedMessageIds(room: string, validate: (packet: StoredMessage["packet"]) => boolean): Promise<AcceptedMessageIdSnapshot>;
  loadSyncAcceptedMessageBatch(room: string, ids: string[], validate: (packet: StoredMessage["packet"]) => boolean): Promise<SyncAcceptedMessageBatch>;
  loadRequestedMessages(room: string, ids: string[], validate: (packet: StoredMessage["packet"]) => boolean): Promise<StoredMessage[]>;
  saveMessage(message: StoredMessage): Promise<boolean>;
  acceptInboundMessage(message: StoredMessage): Promise<InboundAcceptanceResult>;
  updateDelivery(room: string, id: string, delivery: DeliveryState, failure?: StoredMessage["failure"] | null): Promise<void>;
  beginRoomDeletion(room: string): Promise<void>;
  cancelRoomDeletion(room: string): Promise<void>;
  deleteRoomMessages(room: string): Promise<number>;
  isRoomMessagesDeleted(room: string): Promise<boolean>;
  resumeRoomMessages(room: string): Promise<void>;
  reconcileHubReplayOrder(room: string, orderedIds: string[]): Promise<boolean>;
  saveHubHistoryPage(messages: StoredMessage[], cursor: string | null, requestStartOrder: number): Promise<boolean>;
  requestStoragePersistence(): Promise<StoragePersistenceResult>;
}

export interface AcceptedMessageIdSnapshot {
  version: 1;
  room: string;
  ids: string[];
  scanComplete: boolean;
  acceptedIdOverflow: boolean;
}

/** Versioned adapter result for one bounded sync read of accepted messages. */
export interface SyncAcceptedMessageBatch {
  version: 1;
  room: string;
  requestedIds: string[];
  roomState: "available" | "unavailable";
  messages: MessagePacket[];
}
