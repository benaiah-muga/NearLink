type SecureCrypto = {
  getRandomValues(bytes: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer>;
  randomUUID?: () => string;
};

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class SecureRandomUnavailableError extends Error {
  constructor() {
    super("Secure random number generation is unavailable.");
    this.name = "SecureRandomUnavailableError";
  }
}

function browserCryptoSource(): SecureCrypto | null {
  try {
    if (typeof globalThis.crypto === "undefined") return null;
    const source = globalThis.crypto;
    return {
      getRandomValues: (bytes) => source.getRandomValues(bytes),
      ...(typeof source.randomUUID === "function" ? { randomUUID: () => source.randomUUID() } : {}),
    };
  } catch {
    return null;
  }
}

export function createSecureUuid(source: SecureCrypto | null = browserCryptoSource()): string | null {
  if (!source) return null;

  if (typeof source.randomUUID === "function") {
    try {
      const uuid = source.randomUUID();
      if (UUID_V4_PATTERN.test(uuid)) return uuid;
    } catch {
      // Fall through to getRandomValues, which is the secure UUID v4 primitive.
    }
  }

  try {
    const bytes = source.getRandomValues(new Uint8Array(new ArrayBuffer(16)));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    const uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    return UUID_V4_PATTERN.test(uuid) ? uuid : null;
  } catch {
    return null;
  }
}
