# Mesh routing simulation

## Purpose and status

This is a deterministic, finite research model for comparing simple store-and-forward behaviors. It is modeling evidence only. It does not test radio hardware, RF conditions, real device interoperability, battery use, operating-system background limits, or emergency delivery reliability. The scenarios do not establish that a field mesh is feasible or safe to depend on.

The model is not part of NearLink's production communication path. It uses only Python's standard library and performs no network I/O.

## Run it

From the repository root:

```sh
python3 research/mesh-sim/simulate.py --scenario connected_line
python3 research/mesh-sim/simulate.py --scenario partition_reconnect
python3 research/mesh-sim/simulate.py --scenario node_churn
python3 research/mesh-sim/simulate.py --scenario bounded_storage
python3 research/mesh-sim/simulate.py --scenario shortest_path_restore
python3 research/mesh-sim/simulate.py --scenario priority_budget
python3 research/mesh-sim/simulate.py --scenario blackhole_relay
python3 -m unittest discover -s research/mesh-sim -p 'test_*.py' -v
```

The CLI emits JSON with fixed scenario inputs, evidence labels, and outcome metrics. Runs with the same source and Python behavior are deterministic.

## Model

- The network is a finite set of named nodes and undirected links. A scenario supplies a link and active-node snapshot for each tick.
- Messages are injected at fixed ticks. Each has a byte size, expiration tick, and maximum hop count.
- By default, active nodes flood a stored message to each active direct neighbor. The optional `shortest_path` policy recomputes unweighted routes from the active graph snapshot on every tick, chooses the lexicographically first next hop among equal-length shortest routes, and pauses forwarding when no route is available. Transmissions are staged and commit together, so a copy advances at most one hop per tick. A sender retains its copy until expiry.
- A transmission staged over a link active at tick `t` is admitted at the tick `t+1` boundary, before tick `t+1` applies its active-node snapshot. As a result, a receiver that becomes inactive at `t+1` can retain a copy admitted at that boundary, but does not forward it during the inactive tick. A node that is temporarily inactive preserves its local state and may relay again when active.
- A node suppresses a message ID it has already admitted. Seen IDs expire with their message. IDs are assumed globally unique and honest.
- The first admitted copy determines that node's hop count for the message. Later copies do not update the stored copy or seek a better route.
- Each node has a maximum number of pending messages, pending bytes, and remembered IDs. Rejected admissions increment a visible counter. The model does not evict an older message to make room.
- At the destination, first admission records delivery. Latency is destination admission tick minus source creation tick.
- A destination admission uses a seen-ID slot but does not consume pending relay-message or relay-byte capacity because delivered payloads are not retained in this model.
- Optional per-node transmission budgets limit outgoing neighbor transmissions per tick. When a budget is set, queued messages are considered by descending integer priority, then creation tick and message ID. The default priority is zero and no budget is applied unless configured. Flooding order and outcomes remain unchanged for existing scenarios.
- A configured blackhole relay retains an admitted copy but does not forward it. The `malicious_relay_drops` counter increases once for each copy admitted at a configured relay, including an injected copy if its source is designated. The model does not attempt to identify a malicious node or infer attacker intent.

Flooding is intentionally simple and can create many copies and duplicate attempts. The optional shortest-path policy is an idealized graph calculation, not route learning or a protocol implementation. Budgets and static priorities provide a small deterministic queue experiment, not congestion control, adaptive retry, relay reputation, custody acknowledgement, or fairness. A blackhole scenario shows only what this model does when a named relay silently stops forwarding. It does not establish resilience against malicious peers. Link snapshots are idealized availability inputs, not a radio model.

## Metrics

The output reports generated and delivered messages, delivery ratio, mean delivery latency in ticks, per-message delivery tick, duplicate suppressions, storage rejections, expired copies, hop-limit drops, invalid injections, transmission attempts, budget-suppressed transmissions, blackhole relay copy drops, peak stored copies, peak per-node pending storage and seen-ID count, and per-tick aggregate stored copies and bytes. A transmission is one scheduled sender-to-neighbor copy attempt, including attempts that the receiver later suppresses as a duplicate or rejects for capacity. A tick's storage sample is taken after that tick's expiry cleanup and message injections, before that tick forwards messages to the next tick.

These metrics describe only the supplied finite graph and schedule. They do not estimate real-world delivery probability. In particular, tick duration is unspecified, so latency is not a wall-clock estimate. Counts of stored copies do not include Python object overhead or operating-system storage.

## Security and reliability limits

The simulator does not implement identity, authentication, confidentiality, end-to-end encryption, key management, authorization, or realistic adversarial relay behavior. It assumes unique message IDs and honest inputs aside from the explicit static blackhole switch. The blackhole test does not model collusion, selective forwarding, spoofed identity, or defenses, and does not establish resilience against malicious peers. Duplicate suppression is a routing behavior, not replay protection or a security property. Its output repeats these limitations and lists the physical properties that were not measured.

No result from this model supports an emergency use claim. Before any field experiment, a separate design and review would need to define threat assumptions, consent and privacy rules, device and radio targets, user-visible delivery semantics, resource budgets, and failure handling. Physical measurements and an independent security review remain separate work.
