import { describe, expect, it, vi } from "vitest";
import { createSecureUuid } from "./secureId";

describe("createSecureUuid", () => {
  it("builds a UUID v4 with the RFC variant from getRandomValues", () => {
    const getRandomValues = vi.fn((bytes: Uint8Array<ArrayBuffer>) => {
      bytes.fill(0);
      return bytes;
    });

    const uuid = createSecureUuid({ getRandomValues });

    expect(uuid).toBe("00000000-0000-4000-8000-000000000000");
    expect(getRandomValues).toHaveBeenCalledOnce();
    expect(getRandomValues).toHaveBeenCalledWith(expect.any(Uint8Array));
  });

  it("uses randomUUID when available", () => {
    const randomUUID = vi.fn(() => "c3c94f6e-64e4-47ca-a1dd-04b7835cf2b9");
    const getRandomValues = vi.fn((bytes: Uint8Array<ArrayBuffer>) => bytes);

    expect(createSecureUuid({ randomUUID, getRandomValues })).toBe("c3c94f6e-64e4-47ca-a1dd-04b7835cf2b9");
    expect(randomUUID).toHaveBeenCalledOnce();
    expect(getRandomValues).not.toHaveBeenCalled();
  });

  it("falls back to getRandomValues when randomUUID is absent", () => {
    const uuid = createSecureUuid({ getRandomValues: (bytes: Uint8Array<ArrayBuffer>) => {
      bytes.fill(0xab);
      return bytes;
    } });

    expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });

  it("returns null when no secure random source is available", () => {
    expect(createSecureUuid(null)).toBeNull();
    expect(createSecureUuid({ getRandomValues: () => { throw new Error("Unavailable"); } })).toBeNull();
  });

  it("rejects a non-v4 randomUUID result and uses getRandomValues instead", () => {
    const getRandomValues = vi.fn((bytes: Uint8Array<ArrayBuffer>) => {
      bytes.fill(0);
      return bytes;
    });

    expect(createSecureUuid({ randomUUID: () => "not-a-uuid", getRandomValues })).toBe("00000000-0000-4000-8000-000000000000");
    expect(getRandomValues).toHaveBeenCalledOnce();
  });
});
