import { isProtocolRoom } from "@nearlink/protocol";

export const HUB_SETTING_KEY = "nearlink.hub";
export const ROOM_SETTING_KEY = "nearlink.room";
export const RECENT_ROOMS_SETTING_KEY = "nearlink.recent-rooms";
export const MAX_RECENT_ROOMS = 10;

export interface SettingsPort {
  readRoom(): string | null;
  readRecentRooms(): string[];
  readHubUrl(): string | null;
  writeRoom(room: string): boolean;
  writeRecentRooms(rooms: readonly string[]): boolean;
  writeHubUrl(url: string): boolean;
}

export type StorageProvider = () => Storage;

function safely<T>(fallback: T, operation: (storage: Storage) => T, storageProvider: StorageProvider): T {
  try {
    return operation(storageProvider());
  } catch {
    return fallback;
  }
}

function readString(key: string, storageProvider: StorageProvider): string | null {
  return safely(null, (storage) => storage.getItem(key), storageProvider);
}

function writeString(key: string, value: string, storageProvider: StorageProvider): boolean {
  return safely(false, (storage) => {
    storage.setItem(key, value);
    return true;
  }, storageProvider);
}

function parseRecentRooms(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    const rooms: string[] = [];
    for (const room of parsed) {
      if (isProtocolRoom(room) && !rooms.includes(room)) rooms.push(room);
      if (rooms.length === MAX_RECENT_ROOMS) break;
    }
    return rooms;
  } catch {
    return [];
  }
}

export function createBrowserSettings(storageProvider: StorageProvider = () => globalThis.localStorage): SettingsPort {
  return {
    readRoom: () => readString(ROOM_SETTING_KEY, storageProvider),
    readRecentRooms: () => parseRecentRooms(readString(RECENT_ROOMS_SETTING_KEY, storageProvider)),
    readHubUrl: () => readString(HUB_SETTING_KEY, storageProvider),
    writeRoom: (room) => writeString(ROOM_SETTING_KEY, room, storageProvider),
    writeRecentRooms: (rooms) => writeString(RECENT_ROOMS_SETTING_KEY, JSON.stringify(parseRecentRooms(JSON.stringify(rooms))), storageProvider),
    writeHubUrl: (url) => writeString(HUB_SETTING_KEY, url, storageProvider),
  };
}

export const browserSettings = createBrowserSettings();
