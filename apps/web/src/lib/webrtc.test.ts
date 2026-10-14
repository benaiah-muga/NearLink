import { describe, expect, it, vi } from "vitest";
import {
  DirectWebRtcTransport,
  MAX_SIGNALING_BYTES,
  WebRtcTransportError,
  parseWebRtcSignal,
  serializeWebRtcSignal,
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
  sent: unknown[] = [];
  closed = false;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onopen: ((event: Event) => void) | null = null;
  onclose: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  send(data: string | ArrayBuffer | Blob | ArrayBufferView): void {
    this.sent.push(data);
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

function makeTransport(connection = new FakePeerConnection(), timeout = 100): {
  transport: DirectWebRtcTransport;
  connection: FakePeerConnection;
  passedConfiguration: RTCConfiguration | undefined;
} {
  let passedConfiguration: RTCConfiguration | undefined;
  const transport = new DirectWebRtcTransport({
    iceGatheringTimeoutMs: timeout,
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

  it("rejects invalid timeout configuration", () => {
    expect(() => makeTransport(new FakePeerConnection(), 0)).toThrowError(RangeError);
  });
});
