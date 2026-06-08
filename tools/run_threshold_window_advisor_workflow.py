"""Train, evaluate, gate, and optionally install threshold_window_advisor.

This script keeps the threshold model workflow reproducible:

1. Build or reuse a baseline smoothing batch summary.
2. Train a candidate window-level threshold advisor.
3. Run A/B evaluation against a true no-threshold baseline.
4. Apply conservative acceptance gates before optional installation.

The train script only creates candidates; this workflow decides whether a
candidate is safe enough to promote.
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Dict, List, Optional, Sequence


PROFILE_STEMS = {
    "offline-final": "threshold_window_advisor_offline_final",
    "live-pcm30": "threshold_window_advisor_live_pcm30",
    "live-realtime-aed60": "threshold_window_advisor_live_aed60",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run threshold window advisor train/eval/promotion workflow.")
    parser.add_argument("--profile", choices=sorted(PROFILE_STEMS), default="offline-final")
    parser.add_argument("--out-dir", type=Path, default=Path("training_runs/threshold_window_advisor_workflow"))
    parser.add_argument("--run-name", default=None, help="Defaults to timestamped threshold-window-<profile>-<time>.")
    parser.add_argument("--baseline-summary", nargs="*", type=Path, default=None, help="Existing batch_summary.json file(s) to train from.")
    parser.add_argument("--candidate-dir", type=Path, default=None, help="Existing candidate dir. Defaults to <run>/candidate.")
    parser.add_argument("--skip-train", action="store_true", help="Use --candidate-dir without retraining.")
    parser.add_argument("--eval-summary", type=Path, default=None, help="Existing A/B batch_summary.json to gate without rerunning evaluation.")
    parser.add_argument("--cache-dir", type=Path, default=Path("training_runs/firered_song_head_csv_v8_jinbee/cache"))
    parser.add_argument("--model-dir", type=Path, default=Path("models/fireredvad/aed"))
    parser.add_argument("--jobs", type=int, default=11)
    parser.add_argument("--command-timeout-sec", type=float, default=300.0)
    parser.add_argument("--epochs", type=int, default=220)
    parser.add_argument("--device", choices=["auto", "cpu", "cuda"], default="cpu")
    parser.add_argument("--ids", nargs="*", default=None, help="Optional sample IDs to pass to evaluate_smoothing_batch.py.")
    parser.add_argument("--install", action="store_true", help="Install candidate to --install-dir only if gates pass.")
    parser.add_argument("--install-dir", type=Path, default=Path("models/fireredvad/aed"))
    parser.add_argument("--allow-f1-drop", type=float, default=0.001)
    parser.add_argument("--allow-mean-f1-drop", type=float, default=0.001)
    parser.add_argument("--allow-precision-drop", type=float, default=0.001)
    parser.add_argument("--allow-equal-outliers", action="store_true", help="Accept equal outlier count instead of requiring improvement.")
    parser.add_argument("--allow-outlier-type-increase", action="store_true")
    parser.add_argument("--python", default=sys.executable)
    return parser.parse_args()


def load_json(path: Path) -> Dict[str, object]:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def timestamp() -> str:
    return time.strftime("%Y%m%d-%H%M%S")


def run_command(cmd: Sequence[str], cwd: Path) -> None:
    print("[threshold-workflow] $ " + " ".join(str(item) for item in cmd), flush=True)
    completed = subprocess.run(list(cmd), cwd=str(cwd), text=True)
    if completed.returncode != 0:
        raise RuntimeError(f"command failed with exit code {completed.returncode}: {' '.join(str(item) for item in cmd)}")


def metric(payload: Dict[str, object], section: str, name: str) -> float:
    values = payload.get(section)
    if not isinstance(values, dict):
        return 0.0
    try:
        return float(values.get(name) or 0.0)
    except (TypeError, ValueError):
        return 0.0


def int_value(payload: Dict[str, object], name: str) -> int:
    try:
        return int(payload.get(name) or 0)
    except (TypeError, ValueError):
        return 0


def count_delta(payload: Dict[str, object]) -> Dict[str, int]:
    raw = payload.get("outlierTypeCountDelta")
    if not isinstance(raw, dict):
        return {}
    output: Dict[str, int] = {}
    for key, value in raw.items():
        try:
            output[str(key)] = int(value or 0)
        except (TypeError, ValueError):
            output[str(key)] = 0
    return output


def build_eval_cmd(args: argparse.Namespace, out_dir: Path, with_candidate: bool, candidate_dir: Optional[Path] = None) -> List[str]:
    cmd = [
        args.python,
        "tools/evaluate_smoothing_batch.py",
        "--out-dir",
        str(out_dir),
        "--cache-dir",
        str(args.cache_dir),
        "--model-dir",
        str(args.model_dir),
        "--segment-filter",
        "--segment-filter-profile",
        args.profile,
        "--segment-filter-model-dir",
        str(args.model_dir),
        "--require-profile-assets",
        "--smoothing-profile",
        args.profile,
        "--jobs",
        str(max(1, int(args.jobs or 1))),
        "--command-timeout-sec",
        str(max(0.0, float(args.command_timeout_sec or 0.0))),
    ]
    if args.ids:
        cmd.extend(["--ids", *[str(item) for item in args.ids]])
    if with_candidate:
        if candidate_dir is None:
            raise ValueError("candidate_dir is required when with_candidate=True")
        cmd.extend([
            "--threshold-window-advisor",
            "model",
            "--threshold-window-advisor-profile",
            args.profile,
            "--threshold-window-advisor-model-dir",
            str(candidate_dir),
            "--require-threshold-window-advisor-assets",
        ])
    return cmd


def build_train_cmd(args: argparse.Namespace, baseline_summaries: Sequence[Path], candidate_dir: Path) -> List[str]:
    return [
        args.python,
        "tools/train_threshold_window_advisor.py",
        "--batch-summary",
        *[str(path) for path in baseline_summaries],
        "--out-dir",
        str(candidate_dir),
        "--profile",
        args.profile,
        "--epochs",
        str(max(1, int(args.epochs or 1))),
        "--device",
        args.device,
    ]


def evaluate_gates(args: argparse.Namespace, summary: Dict[str, object]) -> Dict[str, object]:
    gates: List[Dict[str, object]] = []

    def add_gate(name: str, passed: bool, detail: Dict[str, object]) -> None:
        gates.append({"name": name, "passed": bool(passed), **detail})

    active_f1 = metric(summary, "aggregateMetrics", "f1")
    baseline_f1 = metric(summary, "baselineAggregateMetrics", "f1")
    active_mean_f1 = metric(summary, "aggregateMetrics", "meanF1")
    baseline_mean_f1 = metric(summary, "baselineAggregateMetrics", "meanF1")
    active_precision = metric(summary, "aggregateMetrics", "precision")
    baseline_precision = metric(summary, "baselineAggregateMetrics", "precision")
    active_outliers = int_value(summary, "activeSevereOutlierCount")
    baseline_outliers = int_value(summary, "baselineSevereOutlierCount")
    failures = int_value(summary, "failureCount")
    deltas = count_delta(summary)
    increased_types = {key: value for key, value in deltas.items() if value > 0}

    add_gate("no_eval_failures", failures == 0, {"failureCount": failures})
    add_gate(
        "aggregate_f1_not_regressed",
        active_f1 + args.allow_f1_drop >= baseline_f1,
        {"active": active_f1, "baseline": baseline_f1, "allowedDrop": args.allow_f1_drop},
    )
    add_gate(
        "mean_f1_not_regressed",
        active_mean_f1 + args.allow_mean_f1_drop >= baseline_mean_f1,
        {"active": active_mean_f1, "baseline": baseline_mean_f1, "allowedDrop": args.allow_mean_f1_drop},
    )
    add_gate(
        "precision_not_regressed",
        active_precision + args.allow_precision_drop >= baseline_precision,
        {"active": active_precision, "baseline": baseline_precision, "allowedDrop": args.allow_precision_drop},
    )
    add_gate(
        "outlier_count_improved" if not args.allow_equal_outliers else "outlier_count_not_increased",
        active_outliers < baseline_outliers if not args.allow_equal_outliers else active_outliers <= baseline_outliers,
        {"active": active_outliers, "baseline": baseline_outliers, "delta": active_outliers - baseline_outliers},
    )
    add_gate(
        "outlier_types_not_increased",
        args.allow_outlier_type_increase or not increased_types,
        {"increasedTypes": increased_types, "typeDelta": deltas},
    )

    return {
        "passed": all(item["passed"] for item in gates),
        "gates": gates,
        "metrics": {
            "active": summary.get("aggregateMetrics"),
            "baseline": summary.get("baselineAggregateMetrics"),
            "activeSevereOutlierCount": active_outliers,
            "baselineSevereOutlierCount": baseline_outliers,
            "outlierCountDelta": active_outliers - baseline_outliers,
            "outlierTypeCountDelta": deltas,
        },
    }


def install_candidate(args: argparse.Namespace, run_dir: Path, candidate_dir: Path) -> List[Dict[str, str]]:
    stem = PROFILE_STEMS[args.profile]
    assets = [candidate_dir / f"{stem}.onnx", candidate_dir / f"{stem}.meta.json"]
    missing = [str(path) for path in assets if not path.exists()]
    if missing:
        raise RuntimeError(f"candidate asset(s) missing: {missing}")

    backup_dir = run_dir / "installed_asset_backup"
    backup_dir.mkdir(parents=True, exist_ok=True)
    args.install_dir.mkdir(parents=True, exist_ok=True)
    installed: List[Dict[str, str]] = []
    for src in assets:
        dst = args.install_dir / src.name
        if dst.exists():
            shutil.copy2(dst, backup_dir / dst.name)
        shutil.copy2(src, dst)
        installed.append({"source": str(src), "destination": str(dst), "backupDir": str(backup_dir)})
    return installed


def main() -> None:
    args = parse_args()
    repo_root = Path.cwd()
    run_name = args.run_name or f"threshold-window-{args.profile}-{timestamp()}"
    run_dir = args.out_dir / run_name
    baseline_dir = run_dir / "baseline"
    candidate_dir = args.candidate_dir or (run_dir / "candidate")
    eval_dir = run_dir / "eval_ab"
    run_dir.mkdir(parents=True, exist_ok=True)

    if args.eval_summary:
        baseline_summaries: List[Path] = [path for path in (args.baseline_summary or []) if path.exists()]
    elif args.baseline_summary:
        baseline_summaries = [path for path in args.baseline_summary if path.exists()]
        if len(baseline_summaries) != len(args.baseline_summary):
            missing = [str(path) for path in args.baseline_summary if not path.exists()]
            raise RuntimeError(f"baseline summary missing: {missing}")
    else:
        run_command(build_eval_cmd(args, baseline_dir, with_candidate=False), repo_root)
        baseline_summaries = [baseline_dir / "batch_summary.json"]

    if args.skip_train:
        stem = PROFILE_STEMS[args.profile]
        missing = [
            str(path)
            for path in [candidate_dir / f"{stem}.onnx", candidate_dir / f"{stem}.meta.json"]
            if not path.exists()
        ]
        if missing:
            raise RuntimeError(f"--skip-train requested but candidate asset(s) are missing: {missing}")
    else:
        if not baseline_summaries:
            raise RuntimeError("training requires --baseline-summary or a generated baseline summary")
        run_command(build_train_cmd(args, baseline_summaries, candidate_dir), repo_root)

    if args.eval_summary:
        eval_summary_path = args.eval_summary
        if not eval_summary_path.exists():
            raise RuntimeError(f"--eval-summary does not exist: {eval_summary_path}")
    else:
        run_command(build_eval_cmd(args, eval_dir, with_candidate=True, candidate_dir=candidate_dir), repo_root)
        eval_summary_path = eval_dir / "batch_summary.json"
    eval_summary = load_json(eval_summary_path)
    gate_result = evaluate_gates(args, eval_summary)
    installed_assets: List[Dict[str, str]] = []
    if gate_result["passed"] and args.install:
        installed_assets = install_candidate(args, run_dir, candidate_dir)

    workflow_summary = {
        "version": "threshold-window-advisor-workflow-v1",
        "profile": args.profile,
        "runDir": str(run_dir),
        "baselineSummaries": [str(path) for path in baseline_summaries],
        "candidateDir": str(candidate_dir),
        "evalSummary": str(eval_summary_path),
        "installRequested": bool(args.install),
        "installedAssets": installed_assets,
        **gate_result,
    }
    summary_path = run_dir / "workflow_summary.json"
    write_json(summary_path, workflow_summary)
    print(json.dumps(workflow_summary, ensure_ascii=False, indent=2), flush=True)
    print(f"[threshold-workflow] wrote {summary_path}", flush=True)
    if not gate_result["passed"]:
        raise SystemExit(2)


if __name__ == "__main__":
    main()
