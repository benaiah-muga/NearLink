import type {
  LocalIdentity,
  StoragePersistenceResult,
  StoredMessage,
  DeliveryState,
} from "./storage";

/** Persistence operations used by the browser application layer. */
export interface ConversationStore {
  loadIdentity(): Promise<LocalIdentity | null>;
  saveIdentity(identity: LocalIdentity): Promise<void>;
  loadMessages(room: string): Promise<StoredMessage[]>;
  saveMessage(message: StoredMessage): Promise<boolean>;
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
