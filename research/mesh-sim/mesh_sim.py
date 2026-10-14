"""Deterministic epidemic store-and-forward model for research, not deployment."""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class Message:
    message_id: str
    source: str
    destination: str
    created_tick: int
    expires_tick: int
    max_hops: int
    size_bytes: int


@dataclass(frozen=True)
class Injection:
    tick: int
    message: Message


@dataclass(frozen=True)
class Scenario:
    name: str
    nodes: tuple[str, ...]
    ticks: int
    injections: tuple[Injection, ...]
    links_by_tick: dict[int, tuple[tuple[str, str], ...]]
    active_by_tick: dict[int, tuple[str, ...]] = field(default_factory=dict)
    node_capacity_bytes: int = 4096
    node_capacity_messages: int = 16
    max_seen_ids_per_node: int = 64
    description: str = ""


@dataclass
class NodeState:
    pending: dict[str, tuple[Message, int]] = field(default_factory=dict)
    seen_until: dict[str, int] = field(default_factory=dict)
    bytes_used: int = 0


@dataclass
class Metrics:
    generated: int = 0
    delivered_ids: set[str] = field(default_factory=set)
    delivery_ticks: dict[str, int] = field(default_factory=dict)
    duplicate_suppressions: int = 0
    storage_rejections: int = 0
    expired_copies: int = 0
    hop_limit_drops: int = 0
    invalid_injections: int = 0
    peak_stored_copies: int = 0
    peak_node_storage_bytes: int = 0
    peak_node_storage_messages: int = 0
    peak_node_seen_ids: int = 0
    tick_storage_bytes: list[int] = field(default_factory=list)
    tick_stored_copies: list[int] = field(default_factory=list)


class Simulation:
    """A synchronous, deterministic flooding model with bounded local state.

    A link snapshot is undirected. At each tick, active nodes stage copies to
    every active neighbor in the snapshot. Copies commit only after staging,
    so one tick represents at most one hop. Source copies are retained until
    expiry. Node outages preserve local state to model temporary disconnection.
    """

    def __init__(self, scenario: Scenario):
        self.scenario = scenario
        self.states = {node: NodeState() for node in scenario.nodes}
        self.metrics = Metrics()
        self.messages: dict[str, Message] = {}
        self._validate_scenario()

    def _validate_scenario(self) -> None:
        s = self.scenario
        if not s.nodes or len(set(s.nodes)) != len(s.nodes):
            raise ValueError("nodes must be nonempty and unique")
        if s.ticks < 1 or min(s.node_capacity_bytes, s.node_capacity_messages,
                              s.max_seen_ids_per_node) < 1:
            raise ValueError("tick and storage bounds must be positive")
        known = set(s.nodes)
        for tick, links in s.links_by_tick.items():
            if not 0 <= tick < s.ticks:
                raise ValueError("link schedule tick outside scenario")
            for a, b in links:
                if a == b or a not in known or b not in known:
                    raise ValueError("links must join two distinct known nodes")
        for tick, active in s.active_by_tick.items():
            if not 0 <= tick < s.ticks or not set(active) <= known:
                raise ValueError("active-node schedule is invalid")
        for injection in s.injections:
            m = injection.message
            if not 0 <= injection.tick < s.ticks or injection.tick != m.created_tick:
                raise ValueError("injection tick must equal a valid created tick")
            if m.source not in known or m.destination not in known:
                raise ValueError("message endpoints must be known nodes")
            if not m.message_id or m.size_bytes < 1 or m.max_hops < 0:
                raise ValueError("message id, size, or hop limit is invalid")
            if m.expires_tick <= m.created_tick:
                raise ValueError("message expiry must follow creation")

    def _active(self, tick: int) -> set[str]:
        return set(self.scenario.active_by_tick.get(tick, self.scenario.nodes))

    def _neighbors(self, tick: int) -> dict[str, tuple[str, ...]]:
        active = self._active(tick)
        result = {node: set() for node in active}
        for a, b in self.scenario.links_by_tick.get(tick, ()):
            if a in active and b in active:
                result[a].add(b)
                result[b].add(a)
        return {node: tuple(sorted(peers)) for node, peers in result.items()}

    def _purge(self, tick: int) -> None:
        for state in self.states.values():
            for message_id, until in list(state.seen_until.items()):
                if tick >= until:
                    state.seen_until.pop(message_id)
            for message_id, (message, _) in list(state.pending.items()):
                if tick >= message.expires_tick:
                    state.pending.pop(message_id)
                    state.bytes_used -= message.size_bytes
                    self.metrics.expired_copies += 1

    def _admit(self, node: str, message: Message, hops: int, tick: int) -> bool:
        state = self.states[node]
        if message.message_id in state.seen_until:
            self.metrics.duplicate_suppressions += 1
            return False
        if tick >= message.expires_tick:
            self.metrics.expired_copies += 1
            return False
        if len(state.seen_until) >= self.scenario.max_seen_ids_per_node:
            self.metrics.storage_rejections += 1
            return False
        if node != message.destination and (
                len(state.pending) >= self.scenario.node_capacity_messages or
                state.bytes_used + message.size_bytes > self.scenario.node_capacity_bytes):
            self.metrics.storage_rejections += 1
            return False
        state.seen_until[message.message_id] = message.expires_tick
        if node == message.destination:
            self.metrics.delivered_ids.add(message.message_id)
            self.metrics.delivery_ticks[message.message_id] = tick
            return True
        state.pending[message.message_id] = (message, hops)
        state.bytes_used += message.size_bytes
        return True

    def run(self) -> dict[str, object]:
        injections_by_tick: dict[int, list[Message]] = {}
        for injection in self.scenario.injections:
            injections_by_tick.setdefault(injection.tick, []).append(injection.message)

        for tick in range(self.scenario.ticks):
            self._purge(tick)
            for message in sorted(injections_by_tick.get(tick, ()), key=lambda m: m.message_id):
                self.metrics.generated += 1
                if message.message_id in self.messages:
                    self.metrics.invalid_injections += 1
                    continue
                self.messages[message.message_id] = message
                if message.source not in self._active(tick):
                    self.metrics.invalid_injections += 1
                    continue
                self._admit(message.source, message, 0, tick)

            copies = sum(len(state.pending) for state in self.states.values())
            bytes_total = sum(state.bytes_used for state in self.states.values())
            max_bytes = max((state.bytes_used for state in self.states.values()), default=0)
            max_messages = max((len(state.pending) for state in self.states.values()), default=0)
            max_seen = max((len(state.seen_until) for state in self.states.values()), default=0)
            self.metrics.peak_stored_copies = max(self.metrics.peak_stored_copies, copies)
            self.metrics.peak_node_storage_bytes = max(self.metrics.peak_node_storage_bytes, max_bytes)
            self.metrics.peak_node_storage_messages = max(self.metrics.peak_node_storage_messages, max_messages)
            self.metrics.peak_node_seen_ids = max(self.metrics.peak_node_seen_ids, max_seen)
            self.metrics.tick_storage_bytes.append(bytes_total)
            self.metrics.tick_stored_copies.append(copies)

            neighbors = self._neighbors(tick)
            staged: list[tuple[str, Message, int]] = []
            for node in sorted(neighbors):
                state = self.states[node]
                for message_id in sorted(state.pending):
                    message, hops = state.pending[message_id]
                    if tick >= message.expires_tick:
                        continue
                    if hops >= message.max_hops:
                        self.metrics.hop_limit_drops += 1
                        state.pending.pop(message_id)
                        state.bytes_used -= message.size_bytes
                        continue
                    for peer in neighbors[node]:
                        staged.append((peer, message, hops + 1))
            for peer, message, hops in staged:
                if tick + 1 < self.scenario.ticks:
                    self._admit(peer, message, hops, tick + 1)

        delivered = len(self.metrics.delivered_ids)
        latencies = [self.metrics.delivery_ticks[mid] - self.messages[mid].created_tick
                     for mid in self.metrics.delivered_ids]
        return {
            "scenario": self.scenario.name,
            "description": self.scenario.description,
            "evidence_class": "deterministic simulation only",
            "not_measured": [
                "radio propagation or interference",
                "real device interoperability",
                "battery use or background execution",
                "emergency delivery reliability",
            ],
            "security_limitations": [
                "no identity or peer authentication",
                "no message confidentiality or end-to-end encryption",
                "no adversarial behavior or malicious relay model",
                "message identifiers are assumed unique and honest",
            ],
            "ticks": self.scenario.ticks,
            "metrics": {
                "generated": self.metrics.generated,
                "delivered": delivered,
                "delivery_ratio": round(delivered / self.metrics.generated, 6)
                    if self.metrics.generated else 0.0,
                "mean_delivery_latency_ticks": round(sum(latencies) / len(latencies), 3)
                    if latencies else None,
                "delivery_ticks": dict(sorted(self.metrics.delivery_ticks.items())),
                "duplicate_suppressions": self.metrics.duplicate_suppressions,
                "storage_rejections": self.metrics.storage_rejections,
                "expired_copies": self.metrics.expired_copies,
                "hop_limit_drops": self.metrics.hop_limit_drops,
                "invalid_injections": self.metrics.invalid_injections,
                "peak_stored_copies": self.metrics.peak_stored_copies,
                "peak_node_storage_bytes": self.metrics.peak_node_storage_bytes,
                "peak_node_storage_messages": self.metrics.peak_node_storage_messages,
                "peak_node_seen_ids": self.metrics.peak_node_seen_ids,
                "tick_storage_bytes": self.metrics.tick_storage_bytes,
                "tick_stored_copies": self.metrics.tick_stored_copies,
            },
        }


def message(mid: str, src: str, dst: str, tick: int = 0, *, ttl: int = 10,
            hops: int = 8, size: int = 128) -> Message:
    return Message(mid, src, dst, tick, tick + ttl, hops, size)


def scenarios() -> dict[str, Scenario]:
    line = (("A", "B"), ("B", "C"), ("C", "D"))
    return {
        "connected_line": Scenario(
            name="connected_line", nodes=("A", "B", "C", "D"), ticks=8,
            injections=(Injection(0, message("m1", "A", "D")),),
            links_by_tick={tick: line for tick in range(8)},
            description="Static four-node line with one message and no outages.",
        ),
        "partition_reconnect": Scenario(
            name="partition_reconnect", nodes=("A", "B", "C", "D"), ticks=10,
            injections=(Injection(0, message("m1", "A", "D", ttl=9)),),
            links_by_tick={tick: (line if tick >= 3 else (("A", "B"), ("C", "D")))
                           for tick in range(10)},
            description="Middle link is partitioned for three ticks, then restored.",
        ),
        "node_churn": Scenario(
            name="node_churn", nodes=("A", "B", "C", "D"), ticks=9,
            injections=(Injection(0, message("m1", "A", "D")),),
            links_by_tick={tick: line for tick in range(9)},
            active_by_tick={1: ("A", "B", "D"), 2: ("A", "B", "D")},
            description="Relay C is temporarily offline, then rejoins with stored state.",
        ),
        "bounded_storage": Scenario(
            name="bounded_storage", nodes=("A", "B", "C"), ticks=5,
            injections=tuple(Injection(0, message(f"m{i}", "A", "C", size=100))
                            for i in range(1, 8)),
            links_by_tick={tick: (("A", "B"), ("B", "C")) for tick in range(5)},
            node_capacity_bytes=250, node_capacity_messages=2, max_seen_ids_per_node=4,
            description="Seven concurrent messages compete for small per-node limits.",
        ),
    }


def assert_invariants(scenario: Scenario, result: dict[str, object]) -> None:
    metrics = result["metrics"]
    assert isinstance(metrics, dict)
    assert metrics["delivered"] <= metrics["generated"]
    assert metrics["invalid_injections"] == 0
    assert metrics["peak_node_storage_bytes"] <= scenario.node_capacity_bytes
    assert metrics["peak_node_storage_messages"] <= scenario.node_capacity_messages
    assert metrics["peak_node_seen_ids"] <= scenario.max_seen_ids_per_node
    assert len(metrics["tick_storage_bytes"]) == scenario.ticks
    assert len(metrics["tick_stored_copies"]) == scenario.ticks
    assert all(value <= scenario.node_capacity_bytes * len(scenario.nodes)
               for value in metrics["tick_storage_bytes"])
