#!/usr/bin/env python3
"""Run one deterministic mesh simulation scenario and print JSON metrics."""

import argparse
import json

from mesh_sim import Simulation, assert_invariants, scenarios


def main() -> int:
    choices = scenarios()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--scenario", choices=sorted(choices), default="connected_line")
    args = parser.parse_args()
    scenario = choices[args.scenario]
    result = Simulation(scenario).run()
    assert_invariants(scenario, result)
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
