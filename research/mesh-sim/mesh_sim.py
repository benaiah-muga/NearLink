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
    priority: int = 0


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
    forwarding_policy: str = "flood"
    node_transmission_budgets: dict[str, int] = field(default_factory=dict)
    blackhole_relays: tuple[str, ...] = ()


@dataclass
class NodeState:
    pending: dict[str, tuple[Message, int]] = field(default_factory=dict)
    seen_until: dict[str, int] = field(default_factory=dict)
    bytes_used: int = 0
    shortest_forwarded_to: dict[str, set[str]] = field(default_factory=dict)


@dataclass
class Metrics:
    generated: int = 0
    delivered_ids: set[str] = field(default_factory=set)
    delivery_ticks: dict[str, int] = field(default_factory=dict)
    duplicate_suppressions: int = 0
    storage_rejections: int = 0
    expired_copies: int = 0
    hop_limit_drops: int = 0
    transmissions: int = 0
    budget_suppressions: int = 0
    malicious_relay_drops: int = 0
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
        if s.forwarding_policy not in {"flood", "shortest_path"}:
            raise ValueError("forwarding policy must be flood or shortest_path")
        known = set(s.nodes)
        if not set(s.node_transmission_budgets) <= known or any(
                budget < 1 for budget in s.node_transmission_budgets.values()):
            raise ValueError("transmission budgets must be positive and use known nodes")
        if not set(s.blackhole_relays) <= known:
            raise ValueError("blackhole relays must be known nodes")
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

    @staticmethod
    def _distances_to(destination: str,
                      neighbors: dict[str, tuple[str, ...]]) -> dict[str, int]:
        """Return unweighted distances in this tick's active graph snapshot."""
        distances = {destination: 0} if destination in neighbors else {}
        frontier = [destination] if destination in neighbors else []
        while frontier:
            node = frontier.pop(0)
            for peer in neighbors[node]:
                if peer not in distances:
                    distances[peer] = distances[node] + 1
                    frontier.append(peer)
        return distances

    def _purge(self, tick: int) -> None:
        for state in self.states.values():
            for message_id, until in list(state.seen_until.items()):
                if tick >= until:
                    state.seen_until.pop(message_id)
            for message_id, (message, _) in list(state.pending.items()):
                if tick >= message.expires_tick:
                    state.pending.pop(message_id)
                    state.shortest_forwarded_to.pop(message_id, None)
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
        if node in self.scenario.blackhole_relays:
            self.metrics.malicious_relay_drops += 1
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
                # A blackhole retains each admitted copy but never forwards it.
                if node in self.scenario.blackhole_relays:
                    continue
                budget = self.scenario.node_transmission_budgets.get(node)
                if budget is None:
                    # Preserve the legacy flood iteration order when no budget
                    # is configured for this node.
                    queued = [state.pending[message_id]
                              for message_id in sorted(state.pending)]
                else:
                    queued = sorted(
                        state.pending.values(),
                        key=lambda item: (-item[0].priority, item[0].created_tick,
                                          item[0].message_id),
                    )
                used = 0
                distance_cache: dict[str, dict[str, int]] = {}
                for message, hops in queued:
                    if tick >= message.expires_tick:
                        continue
                    if hops >= message.max_hops:
                        self.metrics.hop_limit_drops += 1
                        state.pending.pop(message.message_id)
                        state.shortest_forwarded_to.pop(message.message_id, None)
                        state.bytes_used -= message.size_bytes
                        continue
                    if self.scenario.forwarding_policy == "shortest_path":
                        if message.destination not in distance_cache:
                            distance_cache[message.destination] = self._distances_to(
                                message.destination, neighbors)
                        distances = distance_cache[message.destination]
                        current_distance = distances.get(node)
                        next_hops = [
                            peer for peer in neighbors[node]
                            if current_distance is not None and
                            distances.get(peer) == current_distance - 1
                        ]
                        # Sorted neighbors make equal-length route choice stable.
                        next_hops = next_hops[:1]
                        previously_forwarded = state.shortest_forwarded_to.get(
                            message.message_id, set())
                        next_hops = [peer for peer in next_hops
                                     if peer not in previously_forwarded]
                    else:
                        next_hops = list(neighbors[node])
                    for peer in next_hops:
                        if budget is not None and used >= budget:
                            self.metrics.budget_suppressions += 1
                            continue
                        used += 1
                        self.metrics.transmissions += 1
                        if self.scenario.forwarding_policy == "shortest_path":
                            state.shortest_forwarded_to.setdefault(
                                message.message_id, set()).add(peer)
                        staged.append((peer, message, hops + 1))
            # The tick-t transmissions are admitted at the tick-(t+1)
            # boundary before that next tick checks which nodes are active.
            # An inactive receiver retains the copy but cannot forward during
            # the next tick's node-processing phase.
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
                "only a static blackhole relay switch is modeled, without defenses",
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
                "transmissions": self.metrics.transmissions,
                "budget_suppressions": self.metrics.budget_suppressions,
                "malicious_relay_drops": self.metrics.malicious_relay_drops,
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
            hops: int = 8, size: int = 128, priority: int = 0) -> Message:
    return Message(mid, src, dst, tick, tick + ttl, hops, size, priority)


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
        "shortest_path_restore": Scenario(
            name="shortest_path_restore", nodes=("A", "B", "C", "D"), ticks=6,
            injections=(Injection(0, message("m1", "A", "D", ttl=5)),),
            links_by_tick={
                0: (("A", "B"),),
                1: (("A", "C"), ("C", "D")),
                2: (("A", "C"), ("C", "D")),
                3: (("A", "C"), ("C", "D")),
                4: (), 5: (),
            },
            forwarding_policy="shortest_path",
            description=("No route exists at injection. A deterministic shortest route "
                         "appears at tick one."),
        ),
        "priority_budget": Scenario(
            name="priority_budget", nodes=("A", "B", "C"), ticks=3,
            injections=(
                Injection(0, message("low", "A", "B", priority=0)),
                Injection(0, message("high", "A", "C", priority=9)),
            ),
            links_by_tick={0: (("A", "B"), ("A", "C")), 1: (), 2: ()},
            forwarding_policy="shortest_path",
            node_transmission_budgets={"A": 1},
            description="A one-transmission source budget favors the higher priority message.",
        ),
        "blackhole_relay": Scenario(
            name="blackhole_relay", nodes=("A", "B", "D"), ticks=5,
            injections=(Injection(0, message("m1", "A", "D")),),
            links_by_tick={tick: (("A", "B"), ("B", "D")) for tick in range(5)},
            forwarding_policy="shortest_path", blackhole_relays=("B",),
            description=("A designated relay retains an admitted copy and does not "
                         "forward it."),
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
    transmission_bound = (scenario.ticks * len(scenario.nodes) *
                          max(0, len(scenario.nodes) - 1) * metrics["generated"])
    assert 0 <= metrics["transmissions"] <= transmission_bound
    assert 0 <= metrics["budget_suppressions"] <= transmission_bound
    assert 0 <= metrics["malicious_relay_drops"] <= (
        len(scenario.nodes) * metrics["generated"])
