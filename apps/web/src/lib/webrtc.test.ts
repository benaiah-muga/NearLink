import { describe, expect, it, vi } from "vitest";
import {
  DirectWebRtcTransport,
  MAX_SIGNALING_BYTES,
  WebRtcTransportError,
  parseWebRtcSignal,
  serializeWebRtcSignal,
  type DirectWebRtcTransportOptions,
  WEBRTC_SIGNAL_VERSION,
} from "./webrtc";

const fingerprint = "a=fingerprint:sha-256 01:23:45:67:89:AB:CD:EF\r\n";
const offerSdp = `v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=mid:0\r\n${fingerprint}a=sctp-port:5000\r\na=candidate:1 1 UDP 2130706431 192.168.1.10 5000 typ host generation 0\r\n`;
const answerSdp = offerSdp.replace("192.168.1.10", "192.168.1.11");
const signal = (type: "offer" | "answer", sdp = offerSdp) => JSON.stringify({ version: 1, type, sdp });

class FakeChannel extends EventTarget {
  ordered = true;
  maxRetransmits: number | null = null;
  maxPacketLifeTime: number | null = null;
  readyState: RTCDataChannelState = "connecting";
  bufferedAmount = 0;
  maxBufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  sent: unknown[] = [];
  closed = false;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onopen: ((event: Event) => void) | null = null;
  onclose: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onbufferedamountlow: ((event: Event) => void) | null = null;

  send(data: string | ArrayBuffer | Blob | ArrayBufferView): void {
    this.sent.push(data);
    if (typeof data === "string") this.bufferedAmount += new TextEncoder().encode(data).byteLength;
    else if (data instanceof ArrayBuffer) this.bufferedAmount += data.byteLength;
    else if (data instanceof Blob) this.bufferedAmount += data.size;
    else this.bufferedAmount += data.byteLength;
    this.maxBufferedAmount = Math.max(this.maxBufferedAmount, this.bufferedAmount);
  }

  drainTo(bytes: number): void {
    const previous = this.bufferedAmount;
    this.bufferedAmount = bytes;
    if (previous > this.bufferedAmountLowThreshold && this.bufferedAmount <= this.bufferedAmountLowThreshold) {
      this.onbufferedamountlow?.(new Event("bufferedamountlow"));
    }
  }

  close(): void {
    this.closed = true;
    this.readyState = "closed";
  }
}

class FakePeerConnection extends EventTarget {
  localDescription: RTCSessionDescription | null = null;
  remoteDescription: RTCSessionDescription | null = null;
  signalingState: RTCSignalingState = "stable";
  iceGatheringState: RTCIceGatheringState = "new";
  iceConnectionState: RTCIceConnectionState = "new";
  connectionState: RTCPeerConnectionState = "new";
  onconnectionstatechange: ((event: Event) => void) | null = null;
  oniceconnectionstatechange: ((event: Event) => void) | null = null;
  onicegatheringstatechange: ((event: Event) => void) | null = null;
  ondatachannel: ((event: RTCDataChannelEvent) => void) | null = null;
  closed = false;
  dataChannel: FakeChannel | null = null;
  setRemoteDescriptionCalls = 0;
  blockGathering = false;
  failGathering = false;

  createDataChannel(label: string, options?: RTCDataChannelInit): RTCDataChannel {
    if (label !== "nearlink" || options?.ordered !== true) throw new Error("wrong data channel config");
    this.dataChannel = new FakeChannel();
    return this.dataChannel as unknown as RTCDataChannel;
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    return { type: "offer", sdp: offerSdp };
  }

  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    return { type: "answer", sdp: answerSdp };
  }

  async setLocalDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.localDescription = description as RTCSessionDescription;
    this.signalingState = description.type === "offer" ? "have-local-offer" : "stable";
    this.iceGatheringState = this.blockGathering ? "gathering" : "complete";
    if (this.failGathering) this.iceGatheringState = "gathering";
    this.onicegatheringstatechange?.(new Event("icegatheringstatechange"));
    this.dispatchEvent(new Event("icegatheringstatechange"));
  }

  async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.setRemoteDescriptionCalls += 1;
    this.remoteDescription = description as RTCSessionDescription;
    this.signalingState = description.type === "offer" ? "have-remote-offer" : "stable";
  }

  close(): void {
    this.closed = true;
    this.connectionState = "closed";
  }
}

function makeTransport(connection = new FakePeerConnection(), timeout = 100, options: Omit<DirectWebRtcTransportOptions, "peerConnectionFactory" | "iceGatheringTimeoutMs"> = {}): {
  transport: DirectWebRtcTransport;
  connection: FakePeerConnection;
  passedConfiguration: RTCConfiguration | undefined;
} {
  let passedConfiguration: RTCConfiguration | undefined;
  const transport = new DirectWebRtcTransport({
    iceGatheringTimeoutMs: timeout,
    ...options,
    peerConnectionFactory: (configuration) => {
      passedConfiguration = configuration;
      return connection as unknown as RTCPeerConnection;
    },
  });
  return { transport, connection, passedConfiguration };
}

describe("direct WebRTC transport", () => {
  it("parses and serializes bounded versioned offer and answer signaling", () => {
    expect(parseWebRtcSignal(signal("offer"), "offer")).toEqual({
      version: WEBRTC_SIGNAL_VERSION,
      type: "offer",
      sdp: offerSdp,
    });
    expect(serializeWebRtcSignal({ version: 1, type: "answer", sdp: answerSdp })).toBe(signal("answer", answerSdp));
    expect(() => parseWebRtcSignal("x".repeat(MAX_SIGNALING_BYTES + 1))).toThrowError(WebRtcTransportError);
  });

  it("rejects unsupported shapes, versions, missing fields, and non-host candidates", () => {
    for (const input of [
      JSON.stringify({ version: 2, type: "offer", sdp: offerSdp }),
      JSON.stringify({ version: 1, type: "offer", sdp: offerSdp, extra: true }),
      JSON.stringify({ version: 1, type: "offer" }),
      signal("offer", offerSdp.replace("typ host", "typ relay")),
      signal("offer", offerSdp.replace("typ host", "typ srflx")),
      signal("offer", offerSdp.replaceAll(/^a=candidate:.*(?:\r?\n|$)/gm, "")),
    ]) {
      expect(() => parseWebRtcSignal(input)).toThrowError(WebRtcTransportError);
    }
  });

  it("uses no configured STUN/TURN servers, creates ordered channel, and exposes remote fingerprint", async () => {
    const { transport, connection, passedConfiguration } = makeTransport();
    const offer = await transport.createOffer();
    expect(passedConfiguration?.iceServers).toEqual([]);
    expect(connection.dataChannel?.ordered).toBe(true);
    const answerer = makeTransport();
    const answer = await answerer.transport.acceptOffer(offer);
    await transport.acceptAnswer(answer);
    expect(transport.peerFingerprint).toBe("sha-256 01:23:45:67:89:AB:CD:EF");
    expect(answerer.transport.peerFingerprint).toBe("sha-256 01:23:45:67:89:AB:CD:EF");
    transport.close();
    answerer.transport.close();
  });

  it("validates before applying remote signaling", async () => {
    const { transport, connection } = makeTransport();
    await expect(transport.acceptOffer(signal("offer", offerSdp.replace("typ host", "typ relay"))))
      .rejects.toMatchObject({ code: "invalid_signal" });
    expect(connection.setRemoteDescriptionCalls).toBe(0);
    expect(connection.closed).toBe(false);
    transport.close();
  });

  it("rejects a wrong signal type before applying it", async () => {
    const { transport, connection } = makeTransport();
    await expect(transport.acceptOffer(signal("answer"))).rejects.toMatchObject({ code: "wrong_signal_type" });
    expect(connection.setRemoteDescriptionCalls).toBe(0);
    transport.close();
  });

  it.each([
    [false, null, null],
    [true, 3, null],
    [true, null, 300],
  ])("rejects channels without reliable ordered delivery (%s, %s, %s)", (ordered, maxRetransmits, maxPacketLifeTime) => {
    const { transport, connection } = makeTransport();
    const channel = new FakeChannel();
    channel.ordered = ordered;
    channel.maxRetransmits = maxRetransmits;
    channel.maxPacketLifeTime = maxPacketLifeTime;
    connection.ondatachannel?.({ channel: channel as unknown as RTCDataChannel } as RTCDataChannelEvent);
    expect(channel.closed).toBe(true);
    expect(connection.closed).toBe(true);
    expect(transport.currentState).toBe("failed");
    expect(transport.dataChannel).toBeNull();
  });

  it("times out ICE gathering and closes resources", async () => {
    const connection = new FakePeerConnection();
    connection.failGathering = true;
    const { transport } = makeTransport(connection, 5);
    await expect(transport.createOffer()).rejects.toMatchObject({ code: "ice_timeout" });
    expect(connection.closed).toBe(true);
    expect(connection.dataChannel?.closed).toBe(true);
    expect(transport.currentState).toBe("closed");
  });

  it("cancels a pending ICE wait immediately when closed", async () => {
    const connection = new FakePeerConnection();
    connection.blockGathering = true;
    const { transport } = makeTransport(connection, 5_000);
    const pendingOffer = transport.createOffer();
    await Promise.resolve();
    await Promise.resolve();
    transport.close();
    await expect(pendingOffer).rejects.toMatchObject({ code: "closed" });
    expect(connection.closed).toBe(true);
  });

  it("closes idempotently and prevents further use", async () => {
    const { transport, connection } = makeTransport();
    await transport.createOffer();
    const channel = connection.dataChannel;
    transport.close();
    transport.close();
    expect(connection.closed).toBe(true);
    expect(channel?.closed).toBe(true);
    expect(() => transport.send("hello")).toThrowError(/closed/);
  });

  it("notifies closed once, then clears the state callback", () => {
    const { transport } = makeTransport();
    const onStateChange = vi.fn();
    transport.onStateChange = onStateChange;
    transport.close();
    transport.close();
    expect(transport.currentState).toBe("closed");
    expect(onStateChange).toHaveBeenCalledTimes(1);
    expect(onStateChange).toHaveBeenCalledWith("closed");
    expect(transport.onStateChange).toBeNull();
  });

  it("releases resources on terminal ICE failure and preserves failed state", () => {
    const { transport, connection } = makeTransport();
    const channel = new FakeChannel();
    connection.ondatachannel?.({ channel: channel as unknown as RTCDataChannel } as RTCDataChannelEvent);
    const onStateChange = vi.fn();
    const onError = vi.fn();
    transport.onStateChange = onStateChange;
    transport.onError = onError;
    connection.iceConnectionState = "failed";
    connection.oniceconnectionstatechange?.(new Event("iceconnectionstatechange"));
    expect(connection.closed).toBe(true);
    expect(channel.closed).toBe(true);
    expect(transport.currentState).toBe("failed");
    expect(onStateChange).toHaveBeenCalledWith("failed");
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: "connection_failed" }));
    connection.connectionState = "connected";
    connection.onconnectionstatechange?.(new Event("connectionstatechange"));
    expect(transport.currentState).toBe("failed");
    transport.close();
    expect(transport.currentState).toBe("failed");
    expect(transport.onStateChange).toBeNull();
  });

  it("releases resources on terminal channel failure and preserves failed state", () => {
    const { transport, connection } = makeTransport();
    const channel = new FakeChannel();
    connection.ondatachannel?.({ channel: channel as unknown as RTCDataChannel } as RTCDataChannelEvent);
    const onError = vi.fn();
    transport.onError = onError;
    channel.onerror?.(new Event("error"));
    expect(connection.closed).toBe(true);
    expect(channel.closed).toBe(true);
    expect(transport.currentState).toBe("failed");
    expect(transport.dataChannel).toBeNull();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: "connection_failed" }));
  });

  it("delivers the captured error callback when the failed-state callback closes transport", () => {
    const { transport, connection } = makeTransport();
    const channel = new FakeChannel();
    connection.ondatachannel?.({ channel: channel as unknown as RTCDataChannel } as RTCDataChannelEvent);
    const onError = vi.fn();
    transport.onMessage = vi.fn();
    transport.onError = onError;
    transport.onStateChange = (state) => {
      if (state === "failed") transport.close();
    };

    channel.onerror?.(new Event("error"));

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: "connection_failed" }));
    expect(transport.currentState).toBe("failed");
    expect(transport.onMessage).toBeNull();
    expect(transport.onError).toBeNull();
    expect(transport.onStateChange).toBeNull();
  });

  it("sends data only while the reliable channel is open and forwards messages", async () => {
    const { transport, connection } = makeTransport();
    await transport.createOffer();
    const channel = connection.dataChannel;
    expect(() => transport.send("x")).toThrowError(WebRtcTransportError);
    const onMessage = vi.fn();
    transport.onMessage = onMessage;
    if (!channel) throw new Error("expected test channel");
    channel.readyState = "open";
    transport.send("payload");
    channel.onmessage?.(new MessageEvent("message", { data: "incoming" }));
    expect(channel.sent).toEqual(["payload"]);
    expect(onMessage).toHaveBeenCalledWith("incoming");
    transport.close();
  });

  it("queues sends in FIFO order above the high watermark and resumes below low", async () => {
    const { transport, connection } = makeTransport(undefined, 100, {
      bufferedAmountHighWaterMark: 10,
      bufferedAmountLowWaterMark: 3,
    });
    await transport.createOffer();
    const channel = connection.dataChannel!;
    channel.readyState = "open";
    expect(channel.bufferedAmountLowThreshold).toBe(3);
    channel.bufferedAmount = 11;

    transport.send("first");
    transport.send("second");
    expect(channel.sent).toEqual([]);

    channel.drainTo(3);
    expect(channel.sent).toEqual(["first"]);
    channel.drainTo(3);
    expect(channel.sent).toEqual(["first", "second"]);
    expect(channel.maxBufferedAmount).toBeLessThanOrEqual(10);
    transport.close();
  });

  it("rejects an item that cannot fit below the configured high watermark", async () => {
    const { transport, connection } = makeTransport(undefined, 100, {
      bufferedAmountHighWaterMark: 4,
      bufferedAmountLowWaterMark: 1,
      maxQueuedBytes: 8,
      maxQueuedEntries: 2,
    });
    await transport.createOffer();
    const channel = connection.dataChannel!;
    channel.readyState = "open";
    expect(() => transport.send("12345")).toThrowError(expect.objectContaining({ code: "outbound_queue_full" }));
    expect(channel.sent).toEqual([]);
    transport.close();
  });

  it("arms a head-relative wakeup when the buffer is below low but the queued item does not fit", async () => {
    const { transport, connection } = makeTransport(undefined, 100, {
      bufferedAmountHighWaterMark: 256 * 1024,
      bufferedAmountLowWaterMark: 64 * 1024,
      maxQueuedBytes: 512 * 1024,
      maxQueuedEntries: 4,
    });
    await transport.createOffer();
    const channel = connection.dataChannel!;
    channel.readyState = "open";
    channel.bufferedAmount = 50 * 1024;
    const payload = "x".repeat(220 * 1024);

    transport.send(payload);
    expect(channel.sent).toEqual([]);
    expect(channel.bufferedAmountLowThreshold).toBe(36 * 1024);
    channel.drainTo(40 * 1024);
    expect(channel.sent).toEqual([]);
    channel.drainTo(36 * 1024);

    expect(channel.sent).toEqual([payload]);
    expect(channel.maxBufferedAmount).toBeLessThanOrEqual(256 * 1024);
    expect(channel.bufferedAmountLowThreshold).toBe(64 * 1024);
    transport.close();
  });

  it("rejects queued data when either the entry or byte cap is exceeded", async () => {
    const countLimited = makeTransport(undefined, 100, {
      bufferedAmountHighWaterMark: 4,
      bufferedAmountLowWaterMark: 1,
      maxQueuedBytes: 8,
      maxQueuedEntries: 2,
    });
    await countLimited.transport.createOffer();
    const countChannel = countLimited.connection.dataChannel!;
    countChannel.readyState = "open";
    countChannel.bufferedAmount = 5;
    countLimited.transport.send("one");
    countLimited.transport.send("two");
    expect(() => countLimited.transport.send("three")).toThrowError(expect.objectContaining({ code: "outbound_queue_full" }));
    countLimited.transport.close();

    const byteLimited = makeTransport(undefined, 100, {
      bufferedAmountHighWaterMark: 4,
      bufferedAmountLowWaterMark: 1,
      maxQueuedBytes: 4,
      maxQueuedEntries: 4,
    });
    await byteLimited.transport.createOffer();
    const byteChannel = byteLimited.connection.dataChannel!;
    byteChannel.readyState = "open";
    byteChannel.bufferedAmount = 5;
    byteLimited.transport.send("1234");
    expect(() => byteLimited.transport.send("x")).toThrowError(expect.objectContaining({ code: "outbound_queue_full" }));
    byteLimited.transport.close();
  });

  it("clears queued data and low-water callbacks on channel close and failure", async () => {
    const closed = makeTransport(undefined, 100, { bufferedAmountHighWaterMark: 16, bufferedAmountLowWaterMark: 4 });
    await closed.transport.createOffer();
    const closeChannel = closed.connection.dataChannel!;
    closeChannel.readyState = "open";
    closeChannel.bufferedAmount = 17;
    closed.transport.send("pending");
    expect(closeChannel.onbufferedamountlow).toBeTypeOf("function");
    closeChannel.readyState = "closed";
    closeChannel.onclose?.(new Event("close"));
    expect(closed.transport.currentState).toBe("disconnected");
    expect(closed.transport.dataChannel).toBeNull();
    expect(closeChannel.onbufferedamountlow).toBeNull();
    expect(closeChannel.sent).toEqual([]);

    const failed = makeTransport(undefined, 100, { bufferedAmountHighWaterMark: 16, bufferedAmountLowWaterMark: 4 });
    await failed.transport.createOffer();
    const failedChannel = failed.connection.dataChannel!;
    failedChannel.readyState = "open";
    failedChannel.bufferedAmount = 17;
    failed.transport.send("pending");
    failedChannel.onerror?.(new Event("error"));
    expect(failed.transport.currentState).toBe("failed");
    expect(failed.transport.dataChannel).toBeNull();
    expect(failedChannel.onbufferedamountlow).toBeNull();
    expect(failedChannel.sent).toEqual([]);
  });

  it("rejects invalid timeout configuration", () => {
    expect(() => makeTransport(new FakePeerConnection(), 0)).toThrowError(RangeError);
  });
});
