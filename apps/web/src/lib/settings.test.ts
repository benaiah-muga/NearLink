import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBrowserSettings, HUB_SETTING_KEY, RECENT_ROOMS_SETTING_KEY, ROOM_SETTING_KEY } from "./settings";

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key); },
    setItem: (key, value) => { values.set(key, String(value)); },
  };
}

describe("browser settings adapter", () => {
  let storage: Storage;

  beforeEach(() => {
    storage = memoryStorage();
  });

  it("persists typed settings so a new adapter instance can restore them", () => {
    const firstLoad = createBrowserSettings(() => storage);
    expect(firstLoad.writeRoom("saved-room")).toBe(true);
    expect(firstLoad.writeHubUrl("ws://localhost:8000/ws")).toBe(true);
    expect(firstLoad.writeRecentRooms(["saved-room", "other-room"])).toBe(true);

    const afterReload = createBrowserSettings(() => storage);
    expect(afterReload.readRoom()).toBe("saved-room");
    expect(afterReload.readHubUrl()).toBe("ws://localhost:8000/ws");
    expect(afterReload.readRecentRooms()).toEqual(["saved-room", "other-room"]);
  });

  it("treats corrupt or invalid recent-room values as empty and filters writes", () => {
    storage.setItem(RECENT_ROOMS_SETTING_KEY, "{broken json");
    const settings = createBrowserSettings(() => storage);
    expect(settings.readRecentRooms()).toEqual([]);
    storage.setItem(RECENT_ROOMS_SETTING_KEY, JSON.stringify(["ok-room", "has spaces", "ok-room", 4, ...Array.from({ length: 12 }, (_, index) => `room-${index}`)]));
    expect(settings.readRecentRooms()).toEqual(["ok-room", ...Array.from({ length: 9 }, (_, index) => `room-${index}`)]);
    expect(settings.writeRecentRooms(["valid-room", "bad room", "valid-room"])).toBe(true);
    expect(settings.readRecentRooms()).toEqual(["valid-room"]);
  });

  it("returns safe defaults when storage access is unavailable or denied", () => {
    const denied = createBrowserSettings(() => { throw new DOMException("Denied", "SecurityError"); });
    expect(denied.readRoom()).toBeNull();
    expect(denied.readHubUrl()).toBeNull();
    expect(denied.readRecentRooms()).toEqual([]);
    expect(denied.writeRoom("valid-room")).toBe(false);
    expect(denied.writeHubUrl("ws://localhost:8000/ws")).toBe(false);
    expect(denied.writeRecentRooms(["valid-room"])).toBe(false);
  });

  it("returns failure when storage operations throw", () => {
    const blocked = memoryStorage();
    vi.spyOn(blocked, "getItem").mockImplementation(() => { throw new Error("read denied"); });
    vi.spyOn(blocked, "setItem").mockImplementation(() => { throw new Error("write denied"); });
    const settings = createBrowserSettings(() => blocked);
    expect(settings.readRoom()).toBeNull();
    expect(settings.readRecentRooms()).toEqual([]);
    expect(settings.writeRoom("valid-room")).toBe(false);
    expect(settings.writeHubUrl("ws://localhost:8000/ws")).toBe(false);
    expect(settings.writeRecentRooms(["valid-room"])).toBe(false);
  });

  it("uses only the established setting keys", () => {
    const settings = createBrowserSettings(() => storage);
    settings.writeRoom("room-a");
    settings.writeHubUrl("ws://localhost:8000/ws");
    settings.writeRecentRooms(["room-a"]);
    expect([storage.key(0), storage.key(1), storage.key(2)]).toEqual([ROOM_SETTING_KEY, HUB_SETTING_KEY, RECENT_ROOMS_SETTING_KEY]);
  });
});
