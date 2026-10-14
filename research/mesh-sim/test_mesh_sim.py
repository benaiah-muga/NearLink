"""Deterministic invariants for the mesh routing research model."""

import unittest
import ast
from pathlib import Path

from mesh_sim import Injection, Scenario, Simulation, assert_invariants, message, scenarios


class MeshSimulationTests(unittest.TestCase):
    def test_fixed_scenarios_respect_resource_bounds(self) -> None:
        for scenario in scenarios().values():
            with self.subTest(scenario=scenario.name):
                result = Simulation(scenario).run()
                assert_invariants(scenario, result)

    def test_scenarios_are_byte_deterministic_json(self) -> None:
        import json

        for scenario in scenarios().values():
            with self.subTest(scenario=scenario.name):
                first = json.dumps(Simulation(scenario).run(), sort_keys=True,
                                   separators=(",", ":"))
                second = json.dumps(Simulation(scenario).run(), sort_keys=True,
                                    separators=(",", ":"))
                self.assertEqual(first, second)

    def test_connected_line_delivers_with_hop_latency(self) -> None:
        result = Simulation(scenarios()["connected_line"]).run()
        metrics = result["metrics"]
        self.assertEqual(metrics["delivery_ticks"], {"m1": 3})
        self.assertEqual(metrics["mean_delivery_latency_ticks"], 3)
        self.assertEqual(metrics["tick_storage_bytes"][:4], [128, 256, 384, 384])
        self.assertGreater(metrics["duplicate_suppressions"], 0)

    def test_partition_and_temporary_node_churn_delay_delivery(self) -> None:
        partition = Simulation(scenarios()["partition_reconnect"]).run()["metrics"]
        churn = Simulation(scenarios()["node_churn"]).run()["metrics"]
        self.assertEqual(partition["delivery_ticks"], {"m1": 5})
        self.assertEqual(churn["delivery_ticks"], {"m1": 5})

    def test_storage_is_bounded_and_rejections_are_visible(self) -> None:
        scenario = scenarios()["bounded_storage"]
        metrics = Simulation(scenario).run()["metrics"]
        self.assertGreater(metrics["storage_rejections"], 0)
        self.assertLessEqual(metrics["peak_node_storage_bytes"], scenario.node_capacity_bytes)
        self.assertLessEqual(metrics["peak_node_storage_messages"], scenario.node_capacity_messages)
        self.assertLessEqual(metrics["peak_node_seen_ids"], scenario.max_seen_ids_per_node)

    def test_expiry_and_hop_limit_drop_copies(self) -> None:
        links = {tick: (("A", "B"), ("B", "C")) for tick in range(5)}
        expiring = Scenario(
            name="expiry", nodes=("A", "B", "C"), ticks=5,
            injections=(Injection(0, message("expire", "A", "C", ttl=2)),),
            links_by_tick=links,
        )
        expired_metrics = Simulation(expiring).run()["metrics"]
        self.assertEqual(expired_metrics["delivered"], 0)
        self.assertGreater(expired_metrics["expired_copies"], 0)

        hop_limited = Scenario(
            name="hop_limit", nodes=("A", "B", "C"), ticks=5,
            injections=(Injection(0, message("short", "A", "C", hops=1)),),
            links_by_tick=links,
        )
        hop_metrics = Simulation(hop_limited).run()["metrics"]
        self.assertEqual(hop_metrics["delivered"], 0)
        self.assertEqual(hop_metrics["hop_limit_drops"], 1)

    def test_scenario_validation_rejects_unknown_nodes(self) -> None:
        invalid = Scenario(
            name="invalid", nodes=("A",), ticks=1, injections=(),
            links_by_tick={0: (("A", "missing"),)},
        )
        with self.assertRaises(ValueError):
            Simulation(invalid)

    def test_output_labels_security_and_evidence_limits(self) -> None:
        result = Simulation(scenarios()["connected_line"]).run()
        self.assertEqual(result["evidence_class"], "deterministic simulation only")
        self.assertIn("no message confidentiality or end-to-end encryption",
                      result["security_limitations"])
        self.assertIn("radio propagation or interference", result["not_measured"])
        self.assertIn("emergency delivery reliability", result["not_measured"])

    def test_model_and_cli_have_no_network_or_crypto_imports(self) -> None:
        forbidden_roots = {"cryptography", "http", "nacl", "requests", "socket", "ssl", "urllib"}
        folder = Path(__file__).parent
        for module in ("mesh_sim.py", "simulate.py"):
            tree = ast.parse((folder / module).read_text(encoding="utf-8"))
            imports = []
            for node in ast.walk(tree):
                if isinstance(node, ast.Import):
                    imports.extend(alias.name.split(".", 1)[0] for alias in node.names)
                elif isinstance(node, ast.ImportFrom) and node.module:
                    imports.append(node.module.split(".", 1)[0])
            self.assertFalse(forbidden_roots.intersection(imports), module)

    def test_local_delivery_still_obeys_seen_id_limit(self) -> None:
        local = Scenario(
            name="local_delivery", nodes=("A",), ticks=1,
            injections=(Injection(0, message("local", "A", "A")),),
            links_by_tick={}, max_seen_ids_per_node=1,
        )
        result = Simulation(local).run()
        self.assertEqual(result["metrics"]["delivered"], 1)
        self.assertEqual(result["metrics"]["peak_node_seen_ids"], 1)

    def test_destination_delivery_does_not_need_pending_relay_capacity(self) -> None:
        scenario = Scenario(
            name="full_destination",
            nodes=("A", "B", "D", "S", "Z"),
            ticks=4,
            injections=(
                Injection(0, message("to_d", "A", "D", size=64)),
                Injection(0, message("held", "S", "Z", size=64)),
            ),
            links_by_tick={
                0: (("A", "B"), ("S", "D")),
                1: (("B", "D"),),
                2: (),
                3: (),
            },
            node_capacity_bytes=64,
            node_capacity_messages=1,
        )

        simulation = Simulation(scenario)
        result = simulation.run()
        metrics = result["metrics"]
        self.assertEqual(metrics["delivery_ticks"], {"to_d": 2})
        self.assertIn("held", simulation.states["D"].pending)
        self.assertNotIn("to_d", simulation.states["D"].pending)

    def test_shortest_path_uses_deterministic_tie_break_and_fewer_transmissions(self) -> None:
        links = {tick: (("A", "B"), ("B", "D"), ("A", "C"), ("C", "D"))
                 for tick in range(5)}
        scenario = Scenario(
            name="shortest_diamond", nodes=("A", "B", "C", "D"), ticks=5,
            injections=(Injection(0, message("route", "A", "D")),),
            links_by_tick=links, forwarding_policy="shortest_path",
        )
        simulation = Simulation(scenario)
        first = simulation.run()
        second = Simulation(scenario).run()
        self.assertEqual(first, second)
        self.assertEqual(first["metrics"]["delivery_ticks"], {"route": 2})
        self.assertEqual(first["metrics"]["transmissions"], 2)
        self.assertIn("route", simulation.states["B"].seen_until)
        self.assertNotIn("route", simulation.states["C"].seen_until)

    def test_boundary_admission_retains_copy_while_receiver_is_inactive(self) -> None:
        scenario = Scenario(
            name="inactive_boundary_receiver", nodes=("A", "B", "D"), ticks=5,
            injections=(Injection(0, message("held", "A", "D")),),
            links_by_tick={
                0: (("A", "B"),),
                1: (("A", "B"), ("B", "D")),
                2: (("B", "D"),),
                3: (),
                4: (),
            },
            active_by_tick={1: ("A", "D")},
        )
        simulation = Simulation(scenario)
        metrics = simulation.run()["metrics"]
        self.assertEqual(metrics["delivery_ticks"], {"held": 3})
        self.assertEqual(metrics["transmissions"], 2)
        self.assertIn("held", simulation.states["B"].pending)

    def test_shortest_path_recomputes_after_route_becomes_available(self) -> None:
        scenario = Scenario(
            name="route_restore", nodes=("A", "B", "C", "D"), ticks=5,
            injections=(Injection(0, message("restore", "A", "D", ttl=4)),),
            links_by_tick={
                0: (("A", "B"),),
                1: (("A", "C"), ("C", "D")),
                2: (("A", "C"), ("C", "D")),
                3: (), 4: (),
            },
            forwarding_policy="shortest_path",
        )
        metrics = Simulation(scenario).run()["metrics"]
        self.assertEqual(metrics["delivery_ticks"], {"restore": 3})
        self.assertEqual(metrics["transmissions"], 2)

    def test_per_node_tick_budget_prioritizes_queued_messages(self) -> None:
        scenario = Scenario(
            name="priority_budget", nodes=("A", "B", "C"), ticks=3,
            injections=(
                Injection(0, message("low", "A", "B", priority=0)),
                Injection(0, message("high", "A", "C", priority=9)),
            ),
            links_by_tick={0: (("A", "B"), ("A", "C")), 1: (), 2: ()},
            forwarding_policy="shortest_path",
            node_transmission_budgets={"A": 1},
        )
        metrics = Simulation(scenario).run()["metrics"]
        self.assertEqual(metrics["delivery_ticks"], {"high": 1})
        self.assertEqual(metrics["transmissions"], 1)
        self.assertEqual(metrics["budget_suppressions"], 1)

    def test_blackhole_retains_received_copy_and_does_not_forward(self) -> None:
        scenario = Scenario(
            name="blackhole", nodes=("A", "B", "D"), ticks=5,
            injections=(Injection(0, message("blocked", "A", "D")),),
            links_by_tick={tick: (("A", "B"), ("B", "D")) for tick in range(5)},
            forwarding_policy="shortest_path", blackhole_relays=("B",),
        )
        simulation = Simulation(scenario)
        metrics = simulation.run()["metrics"]
        self.assertEqual(metrics["delivered"], 0)
        self.assertEqual(metrics["malicious_relay_drops"], 1)
        self.assertEqual(metrics["transmissions"], 1)
        self.assertIn("blocked", simulation.states["B"].pending)

    def test_policy_budget_and_blackhole_scenario_validation(self) -> None:
        for overrides in (
            {"forwarding_policy": "random"},
            {"node_transmission_budgets": {"missing": 1}},
            {"node_transmission_budgets": {"A": 0}},
            {"blackhole_relays": ("missing",)},
        ):
            scenario = Scenario(
                name="invalid_policy", nodes=("A",), ticks=1,
                injections=(), links_by_tick={}, **overrides,
            )
            with self.subTest(overrides=overrides), self.assertRaises(ValueError):
                Simulation(scenario)


if __name__ == "__main__":
    unittest.main()
