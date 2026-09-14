"""CPU-only integration smoke using an official, explicitly synthetic cell-eval2 fixture.

No provider calls, trained prediction model, biological dataset, or leaderboard submission.
Upstream fixture copyright (c) 2026 Arc Research Institute, MIT licensed; retain its LICENSE
beside the separately downloaded conftest.py. Only the hash-pinned reviewed fixture body runs.
"""
from __future__ import annotations

import argparse
import ast
import contextlib
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import signal
import sys
import time
import traceback
from dataclasses import asdict, replace

PACKAGE_VERSION = "0.16.0"
UPSTREAM_COMMIT = "5e64833518a6603a0301cbe28185d49c30f4a986"
FIXTURE_SHA256 = "44b6f710239028944889a94712a26c28e0d66906cf0ec03e0bba776e8442f9ab"
FIXTURE_URL = f"https://github.com/ArcInstitute/cell-eval2/blob/{UPSTREAM_COMMIT}/tests/conftest.py"
SCORED_METRICS = {
    "pds_cosine", "expr_mse_unbiased_capped_norm", "de_wilcoxon_lfc_nmae",
    "de_wilcoxon_direction_fidelity_yield_raw", "de_wilcoxon_direction_reach_raw",
    "de_wilcoxon_sig_jaccard",
}


def fixture_ast(source: bytes) -> tuple[ast.Module, tuple]:
    """Reject drift before evaluating anything; omit unrelated conftest code and pytest."""
    if hashlib.sha256(source).hexdigest() != FIXTURE_SHA256:
        raise ValueError("Official synthetic fixture source hash mismatch")
    module = ast.parse(source)
    constants = [n for n in module.body if isinstance(n, ast.Assign)
                 and any(isinstance(t, ast.Name) and t.id == "_GRADED_EFFECTS" for t in n.targets)]
    functions = [n for n in module.body if isinstance(n, ast.FunctionDef) and n.name == "graded_counts_real"]
    if len(constants) != 1 or len(functions) != 1:
        raise ValueError("Expected exactly the reviewed fixture and effects constant")
    effects = ast.literal_eval(constants[0].value)
    function = functions[0]
    function.decorator_list = []  # Remove pytest registration, not fixture behavior.
    return ast.fix_missing_locations(ast.Module(body=[function], type_ignores=[])), effects


def check_metric_table(rows: list[dict], *, required_metrics=None, value_field="value") -> dict:
    """Inspect raw tidy metrics; do not invent a reference-scaled leaderboard aggregate."""
    import math
    present = {row.get("metric") for row in rows}
    missing = sorted((SCORED_METRICS if required_metrics is None else required_metrics) - present)
    nonfinite = [{"metric": row.get("metric"), "perturbation": row.get("perturbation")}
                 for row in rows if isinstance(row.get(value_field), bool) or not isinstance(row.get(value_field), (float, int))
                 or not math.isfinite(row[value_field])]
    return {"rows": len(rows), "metrics": sorted(present), "missingScoredMetrics": missing,
            "nonfiniteRows": nonfinite, "completeAndFinite": bool(rows) and not missing and not nonfinite}


def execute(fixture_path: Path, out: Path) -> dict:
    import numpy as np
    import pandas as pd
    import anndata as ad
    from cell_eval2 import EvalConfig, compute_metrics, aggregate_metrics
    from cell_eval2.run import metric_output_names

    if importlib.metadata.version("cell-eval2") != PACKAGE_VERSION:
        raise ValueError("Installed scorer version differs from pinned smoke protocol")
    module, effects = fixture_ast(fixture_path.read_bytes())
    namespace = {"np": np, "pd": pd, "ad": ad, "_GRADED_EFFECTS": effects}
    exec(compile(module, str(fixture_path), "exec"), namespace)
    reference = namespace["graded_counts_real"]()
    repeat = namespace["graded_counts_real"]()
    assert reference.shape == (1000, 120)
    assert np.array_equal(reference.X, repeat.X)
    assert np.isfinite(reference.X).all() and (reference.X >= 0).all()
    assert np.equal(reference.X, np.floor(reference.X)).all()
    assert reference.obs["target"].value_counts().to_dict() == {
        "non-targeting": 200, "GENE1": 200, "GENE2": 200, "GENE3": 200, "GENE4": 200,
    }
    reference.write_h5ad(out / "synthetic-reference.h5ad")
    mask = (reference.obs["target"] != "non-targeting").to_numpy()
    # compute_metrics' paired API requires matching groups including control. This is
    # a library integration fixture, NOT a .vcc submission (which must exclude control).
    identity = reference.copy()  # Oracle identity sanity check, NEVER a model prediction.
    controls = np.asarray(reference.X[~mask])
    no_effect = identity.copy()
    rng = np.random.default_rng(1)
    no_effect.X[mask] = controls[rng.integers(0, len(controls), size=int(mask.sum()))]
    base = EvalConfig.from_preset("vcc2026")
    cfg = replace(base, device="cpu", num_threads=2, de=replace(base.de, backend="scanpy"))
    assert cfg.cache_strict and cfg.input_type == "counts" and cfg.validate_input
    assert cfg.discrimination.exclude_target_gene and not cfg.allow_fractional_counts
    (out / "effective-config.json").write_text(json.dumps(asdict(cfg), indent=2) + "\n")
    summaries = {}
    for name, prediction in [("identity_oracle_diagnostic", identity), ("control_resample_diagnostic", no_effect)]:
        prediction.write_h5ad(out / f"synthetic-{name}.h5ad")
        started = time.monotonic()
        frame = compute_metrics(prediction, reference, config=cfg)
        frame.write_csv(out / f"{name}-raw-metrics.csv")
        rows = frame.to_dicts()
        (out / f"{name}-raw-metrics.json").write_text(json.dumps(rows, indent=2, allow_nan=False) + "\n")
        # The expression ratio-of-sums exists only at upstream aggregation, never
        # as a mean of fabricated per-perturbation ratios. Use its official API.
        aggregate = aggregate_metrics(frame, metrics=metric_output_names(cfg))
        aggregate.write_csv(out / f"{name}-aggregate-metrics.csv")
        aggregate_rows = aggregate.to_dicts()
        (out / f"{name}-aggregate-metrics.json").write_text(json.dumps(aggregate_rows, indent=2, allow_nan=False) + "\n")
        raw_check = check_metric_table(rows, required_metrics=SCORED_METRICS - {"expr_mse_unbiased_capped_norm"})
        aggregate_check = check_metric_table(aggregate_rows, value_field="mean")
        summaries[name] = {"raw": raw_check, "aggregate": aggregate_check, "wallSeconds": time.monotonic() - started}
        if not raw_check["completeAndFinite"] or not aggregate_check["completeAndFinite"]:
            raise ValueError(f"Incomplete/nonfinite upstream metric output: {name}: {summaries[name]}")
        if name == "identity_oracle_diagnostic":
            assert all(abs(row["value"] - 1) < 1e-8 for row in rows if row["metric"] == "pds_cosine")
            assert all(abs(row["value"] - 1) < 1e-8 for row in rows if row["metric"] == "de_wilcoxon_sig_jaccard")
            assert all(abs(row["value"]) < 1e-8 for row in rows if row["metric"] == "de_wilcoxon_lfc_nmae")
    return {"status": "pass", "syntheticFixture": True, "biologicalPerformanceMeasured": False,
            "officialLeaderboardScore": None, "dataShape": list(reference.shape),
            "fixtureMatrixSha256": hashlib.sha256(reference.X.tobytes(order="C")).hexdigest(),
            "cases": summaries, "metricInterpretation": "Raw per-perturbation and upstream aggregate metrics; no reference-anchor scaling or leaderboard score",
            "backend": "scanpy", "device": "cpu", "preset": "vcc2026"}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fixture", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=False)
    (args.out / "executed-vcc-smoke.py").write_bytes(Path(__file__).read_bytes())
    os.environ["MPLCONFIGDIR"] = str(args.out / "matplotlib-cache")
    os.environ["NUMBA_CACHE_DIR"] = str(args.out / "numba-cache")
    os.environ["OMP_NUM_THREADS"] = "2"
    os.environ["OPENBLAS_NUM_THREADS"] = "2"
    os.environ["NUMBA_NUM_THREADS"] = "2"
    started = time.monotonic()
    report = {"upstreamCommit": UPSTREAM_COMMIT, "packageVersion": PACKAGE_VERSION,
              "fixtureUrl": FIXTURE_URL, "fixtureSourceSha256": FIXTURE_SHA256,
              "fixtureLicense": "MIT", "fixtureCopyright": "2026 Arc Research Institute",
              "command": [sys.executable, *sys.argv], "providersCalled": 0,
              "scriptSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest()}
    def timeout(_signum, _frame):
        raise TimeoutError("CPU metric smoke exceeded its 300-second wall limit")
    signal.signal(signal.SIGALRM, timeout)
    signal.alarm(300)
    with (args.out / "stdout.log").open("w") as stdout, (args.out / "stderr.log").open("w") as stderr:
        try:
            with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                report.update(execute(args.fixture, args.out))
        except Exception as error:
            report.update(status="failed", error=f"{type(error).__name__}: {error}",
                          syntheticFixture=True, biologicalPerformanceMeasured=False, officialLeaderboardScore=None)
            traceback.print_exc(file=stderr)
        finally:
            signal.alarm(0)
    report["wallSeconds"] = time.monotonic() - started
    report["dependencies"] = dict(sorted((dist.metadata["Name"], dist.version) for dist in importlib.metadata.distributions()))
    (args.out / "result.json").write_text(json.dumps(report, indent=2, allow_nan=False) + "\n")
    print(json.dumps({"status": report["status"], "result": str(args.out / "result.json"), "wallSeconds": report["wallSeconds"], "providersCalled": 0}))
    return 0 if report["status"] == "pass" else 1


if __name__ == "__main__":
    raise SystemExit(main())
