"""Run the offline-final profile replacement gate.

This script does not install models. It compares a candidate offline-final
segment filter / edge advisor directory against the currently shipped
models/fireredvad/aed assets on the same multi-song offline batch.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path
from typing import Any, Dict, List, Sequence


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Gate offline-final profile model replacement.")
    parser.add_argument("--candidate-segment-filter-model-dir", type=Path, required=True)
    parser.add_argument("--current-segment-filter-model-dir", type=Path, default=Path("models/fireredvad/aed"))
    parser.add_argument("--out-dir", type=Path, default=Path("training_runs/offline_final_replacement_gate"))
    parser.add_argument("--ids", nargs="*", default=None, help="Optional video IDs for smoke checks, e.g. 013 014 015.")
    parser.add_argument("--jobs", type=int, default=3)
    parser.add_argument("--command-timeout-sec", type=float, default=0.0)
    parser.add_argument("--max-f1-drop", type=float, default=0.0)
    parser.add_argument("--max-mean-f1-drop", type=float, default=0.0)
    parser.add_argument("--max-severe-outlier-increase", type=int, default=0)
    parser.add_argument("--python", default=sys.executable or "python")
    parser.add_argument("--dry-run", action="store_true")
    return parser.parse_args()


def run_command(command: Sequence[str], cwd: Path, dry_run: bool) -> None:
    print(f"[offline-profile-gate] {' '.join(str(item) for item in command)}", flush=True)
    if dry_run:
        return
    subprocess.run(command, cwd=cwd, check=True)


def evaluate_command(
    *,
    python: str,
    out_dir: Path,
    model_dir: Path,
    jobs: int,
    command_timeout_sec: float,
    ids: Sequence[str] | None,
) -> List[str]:
    command = [
        python,
        "tools/evaluate_smoothing_batch.py",
        "--out-dir",
        str(out_dir),
        "--smoothing-profile",
        "offline-final",
        "--segment-filter",
        "--segment-filter-model-dir",
        str(model_dir),
        "--segment-filter-profile",
        "offline-final",
        "--require-profile-assets",
        "--jobs",
        str(max(1, jobs)),
    ]
    if command_timeout_sec > 0:
        command.extend(["--command-timeout-sec", str(command_timeout_sec)])
    if ids:
        command.append("--ids")
        command.extend(str(item) for item in ids)
    return command


def load_summary(path: Path) -> Dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def metric(summary: Dict[str, Any], key: str) -> float:
    metrics = summary.get("aggregateMetrics")
    if not isinstance(metrics, dict):
        return 0.0
    try:
        return float(metrics.get(key) or 0.0)
    except (TypeError, ValueError):
        return 0.0


def severe_outlier_count(summary: Dict[str, Any]) -> int:
    items = summary.get("severeOutliers")
    return len(items) if isinstance(items, list) else 0


def build_comparison(current: Dict[str, Any], candidate: Dict[str, Any], args: argparse.Namespace) -> Dict[str, Any]:
    current_f1 = metric(current, "f1")
    candidate_f1 = metric(candidate, "f1")
    current_mean_f1 = metric(current, "meanF1")
    candidate_mean_f1 = metric(candidate, "meanF1")
    current_outliers = severe_outlier_count(current)
    candidate_outliers = severe_outlier_count(candidate)
    f1_drop = current_f1 - candidate_f1
    mean_f1_drop = current_mean_f1 - candidate_mean_f1
    severe_outlier_increase = candidate_outliers - current_outliers
    return {
        "profile": "offline-final",
        "currentModelDir": str(args.current_segment_filter_model_dir),
        "candidateModelDir": str(args.candidate_segment_filter_model_dir),
        "current": {
            "aggregateMetrics": current.get("aggregateMetrics"),
            "evaluatedCount": current.get("evaluatedCount"),
            "failureCount": current.get("failureCount"),
            "severeOutlierCount": current_outliers,
            "segmentFilterAssetProfileUsed": current.get("segmentFilterAssetProfileUsed"),
            "edgeTrimAdvisorAssetProfileUsed": current.get("edgeTrimAdvisorAssetProfileUsed"),
        },
        "candidate": {
            "aggregateMetrics": candidate.get("aggregateMetrics"),
            "evaluatedCount": candidate.get("evaluatedCount"),
            "failureCount": candidate.get("failureCount"),
            "severeOutlierCount": candidate_outliers,
            "segmentFilterAssetProfileUsed": candidate.get("segmentFilterAssetProfileUsed"),
            "edgeTrimAdvisorAssetProfileUsed": candidate.get("edgeTrimAdvisorAssetProfileUsed"),
        },
        "f1Drop": f1_drop,
        "meanF1Drop": mean_f1_drop,
        "severeOutlierIncrease": severe_outlier_increase,
        "maxF1Drop": args.max_f1_drop,
        "maxMeanF1Drop": args.max_mean_f1_drop,
        "maxSevereOutlierIncrease": args.max_severe_outlier_increase,
        "passed": (
            f1_drop <= args.max_f1_drop
            and mean_f1_drop <= args.max_mean_f1_drop
            and severe_outlier_increase <= args.max_severe_outlier_increase
            and int(current.get("failureCount") or 0) == 0
            and int(candidate.get("failureCount") or 0) == 0
            and current.get("segmentFilterAssetProfileUsed") == "offline-final"
            and current.get("edgeTrimAdvisorAssetProfileUsed") == "offline-final"
            and candidate.get("segmentFilterAssetProfileUsed") == "offline-final"
            and candidate.get("edgeTrimAdvisorAssetProfileUsed") == "offline-final"
        ),
    }


def main() -> int:
    args = parse_args()
    repo_root = Path.cwd()
    current_out = args.out_dir / "current"
    candidate_out = args.out_dir / "candidate"
    args.out_dir.mkdir(parents=True, exist_ok=True)

    candidate_validation_cmd = [
        args.python,
        "tools/validate_profile_assets.py",
        "--models-dir",
        str(args.candidate_segment_filter_model_dir),
        "--profile",
        "offline-final",
        "--require-post-end-guard-metadata",
    ]

    current_cmd = evaluate_command(
        python=args.python,
        out_dir=current_out,
        model_dir=args.current_segment_filter_model_dir,
        jobs=args.jobs,
        command_timeout_sec=args.command_timeout_sec,
        ids=args.ids,
    )
    candidate_cmd = evaluate_command(
        python=args.python,
        out_dir=candidate_out,
        model_dir=args.candidate_segment_filter_model_dir,
        jobs=args.jobs,
        command_timeout_sec=args.command_timeout_sec,
        ids=args.ids,
    )
    plan = {
        "candidateValidationCommand": candidate_validation_cmd,
        "currentCommand": current_cmd,
        "candidateCommand": candidate_cmd,
        "currentModelDir": str(args.current_segment_filter_model_dir),
        "candidateModelDir": str(args.candidate_segment_filter_model_dir),
        "ids": args.ids,
    }
    (args.out_dir / "offline_profile_replacement_gate_plan.json").write_text(
        json.dumps(plan, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )

    run_command(candidate_validation_cmd, repo_root, args.dry_run)
    run_command(current_cmd, repo_root, args.dry_run)
    run_command(candidate_cmd, repo_root, args.dry_run)
    if args.dry_run:
        print("[offline-profile-gate] dry-run complete")
        return 0

    current = load_summary(current_out / "batch_summary.json")
    candidate = load_summary(candidate_out / "batch_summary.json")
    comparison = build_comparison(current, candidate, args)
    (args.out_dir / "offline_profile_replacement_gate_summary.json").write_text(
        json.dumps(comparison, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(comparison, ensure_ascii=False, indent=2), flush=True)
    return 0 if comparison["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
