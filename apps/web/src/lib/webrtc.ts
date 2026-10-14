/**
 * Direct WebRTC transport for peers that can exchange signaling out of band.
 * This module deliberately has no dependency on the application message format.
 * WebRTC provides an encrypted connection, but this transport does not
 * authenticate peer identity. Compare peerFingerprint out of band when needed.
 */

export const WEBRTC_SIGNAL_VERSION = 1 as const;
export const MAX_SIGNALING_BYTES = 256 * 1024;
export const DEFAULT_ICE_GATHERING_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 60_000;

export type SignalType = "offer" | "answer";

export interface WebRtcSignal {
  version: typeof WEBRTC_SIGNAL_VERSION;
  type: SignalType;
  sdp: string;
}

export type TransportState =
  | "new"
  | "connecting"
  | "connected"
  | "disconnected"
  | "failed"
  | "closed";

export type TransportErrorCode =
  | "invalid_signal"
  | "wrong_signal_type"
  | "already_started"
  | "closed"
  | "ice_timeout"
  | "connection_failed"
  | "data_channel_unavailable";

export class WebRtcTransportError extends Error {
  readonly code: TransportErrorCode;

  constructor(code: TransportErrorCode, message: string) {
    super(message);
    this.name = "WebRtcTransportError";
    this.code = code;
  }
}

export interface DirectWebRtcTransportOptions {
  /** A test seam. Production uses the browser's RTCPeerConnection. */
  peerConnectionFactory?: (configuration: RTCConfiguration) => RTCPeerConnection;
  iceGatheringTimeoutMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function validateSdp(sdp: unknown): sdp is string {
  if (typeof sdp !== "string" || sdp.length === 0 || utf8Length(sdp) > MAX_SIGNALING_BYTES) return false;
  if (!/^v=0(?:\r?\n)/.test(sdp) || !/(?:^|\r?\n)m=application\s/.test(sdp)) return false;
  if (!/(?:^|\r?\n)a=fingerprint:(?:sha-256|sha-384|sha-512)\s+[0-9A-Fa-f:]+(?:\r?\n|$)/i.test(sdp)) return false;

  // This transport only supports directly reachable peers. Do not accept
  // server-reflexive or relay candidates supplied by remote signaling.
  const candidateLines = sdp.split(/\r?\n/).filter((line) => line.startsWith("a=candidate:"));
  if (candidateLines.length === 0) return false;
  return candidateLines.every((line) => /\btyp host(?:\s|$)/.test(line));
}

/** Parse a bounded, exact-shape JSON signaling message before applying SDP. */
export function parseWebRtcSignal(input: string, expectedType?: SignalType): WebRtcSignal {
  if (typeof input !== "string" || utf8Length(input) > MAX_SIGNALING_BYTES) {
    throw new WebRtcTransportError("invalid_signal", "Signaling payload exceeds the size limit.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    throw new WebRtcTransportError("invalid_signal", "Signaling payload is not valid JSON.");
  }

  if (!isRecord(parsed)
    || Object.keys(parsed).length !== 3
    || !Object.hasOwn(parsed, "version")
    || !Object.hasOwn(parsed, "type")
    || !Object.hasOwn(parsed, "sdp")
    || parsed.version !== WEBRTC_SIGNAL_VERSION
    || (parsed.type !== "offer" && parsed.type !== "answer")
    || !validateSdp(parsed.sdp)) {
    throw new WebRtcTransportError("invalid_signal", "Signaling payload has an unsupported or invalid shape.");
  }

  if (expectedType && parsed.type !== expectedType) {
    throw new WebRtcTransportError("wrong_signal_type", `Expected a WebRTC ${expectedType}.`);
  }

  return { version: WEBRTC_SIGNAL_VERSION, type: parsed.type, sdp: parsed.sdp };
}

export function serializeWebRtcSignal(signal: WebRtcSignal): string {
  const parsed = parseWebRtcSignal(JSON.stringify(signal));
  return JSON.stringify(parsed);
}

/**
 * One direct peer connection. The offerer calls createOffer(); the answerer
 * calls acceptOffer(); the offerer then calls acceptAnswer(). Exchange the
 * returned signaling JSON through an out-of-band channel.
 */
export class DirectWebRtcTransport {
  readonly peerConnection: RTCPeerConnection;
  readonly iceGatheringTimeoutMs: number;
  onMessage: ((data: unknown) => void) | null = null;
  onStateChange: ((state: TransportState) => void) | null = null;
  onError: ((error: WebRtcTransportError) => void) | null = null;

  private channel: RTCDataChannel | null = null;
  private started = false;
  private closed = false;
  private state: TransportState = "new";
  private _peerFingerprint: string | null = null;
  private cancelIceGathering: ((error: WebRtcTransportError) => void) | null = null;

  constructor(options: DirectWebRtcTransportOptions = {}) {
    const timeout = options.iceGatheringTimeoutMs ?? DEFAULT_ICE_GATHERING_TIMEOUT_MS;
    if (!Number.isFinite(timeout) || timeout <= 0 || timeout > MAX_TIMEOUT_MS) {
      throw new RangeError(`ICE gathering timeout must be between 1 and ${MAX_TIMEOUT_MS} ms.`);
    }
    this.iceGatheringTimeoutMs = timeout;

    // An empty ICE server list prevents implicit public STUN/TURN dependency.
    const configuration: RTCConfiguration = { iceServers: [], iceTransportPolicy: "all" };
    const factory = options.peerConnectionFactory ?? ((config) => new RTCPeerConnection(config));
    this.peerConnection = factory(configuration);
    this.peerConnection.onconnectionstatechange = () => this.syncConnectionState();
    this.peerConnection.oniceconnectionstatechange = () => {
      if (this.peerConnection.iceConnectionState === "failed") {
        this.fail(new WebRtcTransportError("connection_failed", "The direct WebRTC connection failed."));
      }
    };
    this.peerConnection.ondatachannel = (event) => this.attachChannel(event.channel);
  }

  get currentState(): TransportState {
    return this.state;
  }

  /** Fingerprint from the remote SDP. It identifies a DTLS certificate only. */
  get peerFingerprint(): string | null {
    return this._peerFingerprint;
  }

  get dataChannel(): RTCDataChannel | null {
    return this.channel;
  }

  async createOffer(): Promise<string> {
    this.assertOpen();
    if (this.started) throw new WebRtcTransportError("already_started", "This transport has already started.");
    this.started = true;
    try {
      this.attachChannel(this.peerConnection.createDataChannel("nearlink", { ordered: true }));
      const offer = await this.peerConnection.createOffer();
      this.assertOpen();
      await this.peerConnection.setLocalDescription(offer);
      await this.waitForIceGathering();
      this.assertOpen();
      const sdp = this.peerConnection.localDescription?.sdp;
      if (!validateSdp(sdp)) throw new WebRtcTransportError("invalid_signal", "Local offer did not produce usable host candidates.");
      return serializeWebRtcSignal({ version: WEBRTC_SIGNAL_VERSION, type: "offer", sdp });
    } catch (error) {
      this.close();
      throw error;
    }
  }

  async acceptOffer(input: string): Promise<string> {
    this.assertOpen();
    if (this.started) throw new WebRtcTransportError("already_started", "This transport has already started.");
    const signal = parseWebRtcSignal(input, "offer");
    this.started = true;
    try {
      this.setPeerFingerprint(signal.sdp);
      await this.peerConnection.setRemoteDescription({ type: "offer", sdp: signal.sdp });
      this.assertOpen();
      const answer = await this.peerConnection.createAnswer();
      this.assertOpen();
      await this.peerConnection.setLocalDescription(answer);
      await this.waitForIceGathering();
      this.assertOpen();
      const sdp = this.peerConnection.localDescription?.sdp;
      if (!validateSdp(sdp)) throw new WebRtcTransportError("invalid_signal", "Local answer did not produce usable host candidates.");
      return serializeWebRtcSignal({ version: WEBRTC_SIGNAL_VERSION, type: "answer", sdp });
    } catch (error) {
      this.close();
      throw error;
    }
  }

  async acceptAnswer(input: string): Promise<void> {
    this.assertOpen();
    if (!this.started || this.peerConnection.signalingState !== "have-local-offer") {
      throw new WebRtcTransportError("already_started", "No local offer is waiting for an answer.");
    }
    const signal = parseWebRtcSignal(input, "answer");
    try {
      this.setPeerFingerprint(signal.sdp);
      await this.peerConnection.setRemoteDescription({ type: "answer", sdp: signal.sdp });
      this.assertOpen();
    } catch (error) {
      this.close();
      throw error;
    }
  }

  send(data: string | ArrayBuffer | Blob | ArrayBufferView<ArrayBuffer>): void {
    this.assertOpen();
    if (!this.channel || this.channel.readyState !== "open") {
      throw new WebRtcTransportError("data_channel_unavailable", "The direct data channel is not open.");
    }
    if (typeof data === "string") this.channel.send(data);
    else if (data instanceof ArrayBuffer) this.channel.send(data);
    else if (data instanceof Blob) this.channel.send(data);
    else this.channel.send(data);
  }

  close(): void {
    if (!this.closed) {
      this.closed = true;
      this.cancelIceGathering?.(new WebRtcTransportError("closed", "The direct WebRTC transport was closed during ICE gathering."));
      this.releaseResources();
      if (this.state !== "failed") this.setState("closed");
    }
    this.onMessage = null;
    this.onError = null;
    this.onStateChange = null;
  }

  private attachChannel(channel: RTCDataChannel): void {
    if (this.closed) {
      channel.close();
      return;
    }
    if (channel.ordered !== true || channel.maxRetransmits !== null || channel.maxPacketLifeTime !== null) {
      channel.close();
      this.fail(new WebRtcTransportError("data_channel_unavailable", "The peer supplied a data channel without reliable ordered delivery."));
      return;
    }
    if (this.channel && this.channel !== channel) {
      channel.close();
      this.fail(new WebRtcTransportError("data_channel_unavailable", "Only one data channel is supported."));
      return;
    }
    this.channel = channel;
    channel.onmessage = (event) => this.onMessage?.(event.data);
    channel.onopen = () => this.setState("connected");
    channel.onclose = () => {
      if (!this.closed) this.setState("disconnected");
    };
    channel.onerror = () => this.fail(new WebRtcTransportError("connection_failed", "The direct data channel reported an error."));
  }

  private detachAndCloseChannel(): void {
    const channel = this.channel;
    this.channel = null;
    if (!channel) return;
    channel.onmessage = null;
    channel.onopen = null;
    channel.onclose = null;
    channel.onerror = null;
    try {
      channel.close();
    } catch {
      // Continue closing the peer connection even if the channel throws.
    }
  }

  private releaseResources(): void {
    this.peerConnection.onconnectionstatechange = null;
    this.peerConnection.oniceconnectionstatechange = null;
    this.peerConnection.onicegatheringstatechange = null;
    this.peerConnection.ondatachannel = null;
    this.detachAndCloseChannel();
    try {
      this.peerConnection.close();
    } catch {
      // Continue after a close error so the public state remains terminal.
    }
  }

  private async waitForIceGathering(): Promise<void> {
    this.assertOpen();
    if (this.peerConnection.iceGatheringState === "complete") return;
    this.setState("connecting");
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        clearTimeout(timer);
        this.peerConnection.removeEventListener("icegatheringstatechange", onGathering);
        this.peerConnection.onicegatheringstatechange = priorHandler;
      };
      const finish = (error?: WebRtcTransportError) => {
        if (settled) return;
        settled = true;
        cleanup();
        this.cancelIceGathering = null;
        if (error) reject(error);
        else resolve();
      };
      const priorHandler = this.peerConnection.onicegatheringstatechange;
      const onGathering = () => {
        if (this.peerConnection.iceGatheringState === "complete") finish();
      };
      const timer = setTimeout(() => finish(new WebRtcTransportError("ice_timeout", "ICE gathering exceeded its time limit.")), this.iceGatheringTimeoutMs);
      this.cancelIceGathering = finish;
      this.peerConnection.onicegatheringstatechange = (event) => {
        priorHandler?.call(this.peerConnection, event);
        onGathering();
      };
      this.peerConnection.addEventListener("icegatheringstatechange", onGathering);
      // Cover a completion between the initial check and listener registration.
      onGathering();
    });
  }

  private setPeerFingerprint(sdp: string): void {
    const match = /(?:^|\r?\n)a=fingerprint:(sha-256|sha-384|sha-512)\s+([0-9A-Fa-f:]+)(?:\r?\n|$)/i.exec(sdp);
    if (!match) throw new WebRtcTransportError("invalid_signal", "Remote SDP does not contain a DTLS fingerprint.");
    this._peerFingerprint = `${match[1].toLowerCase()} ${match[2].toUpperCase()}`;
  }

  private syncConnectionState(): void {
    if (this.closed) return;
    const connectionState = this.peerConnection.connectionState;
    if (connectionState === "connected") this.setState("connected");
    else if (connectionState === "connecting") this.setState("connecting");
    else if (connectionState === "disconnected") this.setState("disconnected");
    else if (connectionState === "failed") this.fail(new WebRtcTransportError("connection_failed", "The direct WebRTC connection failed."));
  }

  private fail(error: WebRtcTransportError): void {
    if (this.closed) return;
    this.closed = true;
    this.cancelIceGathering?.(error);
    this.releaseResources();
    const onError = this.onError;
    this.setState("failed");
    this.onMessage = null;
    this.onError = null;
    this.onStateChange = null;
    onError?.(error);
  }

  private setState(state: TransportState): void {
    if (this.state === state) return;
    this.state = state;
    try {
      this.onStateChange?.(state);
    } catch {
      // Consumer callbacks must not interrupt transport cleanup or state changes.
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new WebRtcTransportError("closed", "The direct WebRTC transport is closed.");
  }
}
