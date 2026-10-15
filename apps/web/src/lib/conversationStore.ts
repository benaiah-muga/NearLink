import type {
  LocalIdentity,
  StoragePersistenceResult,
  StoredMessage,
  DeliveryState,
  InboundAcceptanceResult,
} from "./storage";

/** Persistence operations used by the browser application layer. */
export interface ConversationStore {
  loadIdentity(): Promise<LocalIdentity | null>;
  saveIdentity(identity: LocalIdentity): Promise<void>;
  loadMessages(room: string): Promise<StoredMessage[]>;
  loadAcceptedMessageIds(room: string, validate: (packet: StoredMessage["packet"]) => boolean): Promise<AcceptedMessageIdSnapshot>;
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
  ids: string[];
  truncated: boolean;
}
