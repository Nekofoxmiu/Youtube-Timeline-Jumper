"""End-to-end workflow for synthetic edge/segment filter training.

This workflow generates audio-level synthetic samples, evaluates them through
the normal FireRed smoothing pipeline, trains profile-specific segment/edge
candidate assets with reduced synthetic weight, then runs the real offline gate.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from pathlib import Path
from typing import Dict, Iterable, List, Sequence


PROFILE_CHOICES = ("offline-final",)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run synthetic edge/segment-filter training workflow.")
    parser.add_argument("--profile", choices=PROFILE_CHOICES, default="offline-final")
    parser.add_argument("--out-dir", type=Path, default=Path("training_runs/synthetic_edge_training"))
    parser.add_argument("--run-name", default=None)
    parser.add_argument("--synthetic-count", type=int, default=36)
    parser.add_argument("--synthetic-weight", type=float, default=0.45)
    parser.add_argument("--seed", type=int, default=20260601)
    parser.add_argument("--source-audio-dir", type=Path, default=Path("tools/data/audio"))
    parser.add_argument("--source-manual-dir", type=Path, default=Path("tools/data/manual"))
    parser.add_argument("--exclude-source-video", nargs="*", default=["video_013", "video_015", "video_051", "video_070", "video_071", "video_072"])
    parser.add_argument("--synthetic-dir", type=Path, default=None, help="Reuse existing synthetic data directory instead of generating.")
    parser.add_argument("--real-baseline-summary", type=Path, default=None, help="Existing real batch_summary.json. If omitted, one is generated.")
    parser.add_argument("--cache-dir", type=Path, default=Path("training_runs/firered_head_retrain_eval_current"))
    parser.add_argument("--model-dir", type=Path, default=Path("models/fireredvad/aed"))
    parser.add_argument("--candidate-dir", type=Path, default=None)
    parser.add_argument("--jobs", type=int, default=11)
    parser.add_argument("--command-timeout-sec", type=float, default=300.0)
    parser.add_argument("--epochs", type=int, default=900)
    parser.add_argument("--manual-jitter-candidates", type=int, default=4)
    parser.add_argument("--install", action="store_true")
    parser.add_argument("--skip-real-gate", action="store_true", help="Development smoke option; never install when this is set.")
    parser.add_argument("--ffmpeg", default="ffmpeg")
    parser.add_argument("--ffprobe", default="ffprobe")
    parser.add_argument("--python", default=sys.executable)
    parser.add_argument("--dry-run", action="store_true")
    return parser.parse_args()


def timestamp() -> str:
    return time.strftime("%Y%m%d-%H%M%S")


def run_command(cmd: Sequence[str], cwd: Path, dry_run: bool = False) -> None:
    print("[synthetic-edge-workflow] $ " + " ".join(str(item) for item in cmd), flush=True)
    if dry_run:
        return
    completed = subprocess.run(list(cmd), cwd=str(cwd), text=True)
    if completed.returncode != 0:
        raise RuntimeError(f"command failed ({completed.returncode}): {' '.join(str(item) for item in cmd)}")


def load_json(path: Path) -> Dict[str, object]:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def collect_summary_paths(batch_summary: Path) -> List[Path]:
    payload = load_json(batch_summary)
    paths: List[Path] = []
    for item in payload.get("videos", []) if isinstance(payload.get("videos"), list) else []:
        if not isinstance(item, dict):
            continue
        raw = item.get("summaryPath") or item.get("baselineSummaryPath")
        if not raw:
            continue
        path = Path(str(raw))
        if not path.is_absolute():
            path = Path.cwd() / path
        if path.exists() and ".segment_filter" not in path.name:
            paths.append(path)
    return sorted(dict.fromkeys(paths))


def build_synthetic_weights(manifest_path: Path, weight: float, out_path: Path) -> Path:
    payload = load_json(manifest_path)
    weights: Dict[str, float] = {}
    for item in payload.get("samples", []) if isinstance(payload.get("samples"), list) else []:
        if isinstance(item, dict) and item.get("video"):
            weights[str(item["video"])] = float(weight)
    write_json(out_path, weights)
    return out_path


def evaluate_batch_cmd(
    args: argparse.Namespace,
    out_dir: Path,
    *,
    annotations: Path,
    audio_dir: Path,
    manual_dir: Path,
    cache_dir: Path,
    rebuild_diagnostics: bool,
    segment_filter: bool = True,
) -> List[str]:
    cmd = [
        args.python,
        "tools/evaluate_smoothing_batch.py",
        "--annotations",
        str(annotations),
        "--audio-dir",
        str(audio_dir),
        "--manual-dir",
        str(manual_dir),
        "--cache-dir",
        str(cache_dir),
        "--out-dir",
        str(out_dir),
        "--model-dir",
        str(args.model_dir),
        "--smoothing-profile",
        args.profile,
        "--jobs",
        str(max(1, int(args.jobs or 1))),
        "--command-timeout-sec",
        str(max(0.0, float(args.command_timeout_sec or 0.0))),
    ]
    if segment_filter:
        cmd.extend([
            "--segment-filter",
            "--segment-filter-model-dir",
            str(args.model_dir),
            "--segment-filter-profile",
            args.profile,
            "--require-profile-assets",
        ])
    if rebuild_diagnostics:
        cmd.append("--rebuild-diagnostics")
    return cmd


def train_cmd(
    args: argparse.Namespace,
    candidate_dir: Path,
    summary_paths: Sequence[Path],
    weight_json: Path,
    hard_negative_csv: Path,
) -> List[str]:
    return [
        args.python,
        "tools/train_segment_filter.py",
        "--out-dir",
        str(candidate_dir),
        "--training-profile",
        args.profile,
        "--write-profile-assets",
        "--summary-file",
        *[str(path) for path in summary_paths],
        "--summary-weight-json",
        str(weight_json),
        "--hard-negative-annotations",
        str(hard_negative_csv),
        "--manual-jitter-candidates",
        str(max(0, int(args.manual_jitter_candidates or 0))),
        "--epochs",
        str(max(1, int(args.epochs or 1))),
    ]


def main() -> None:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    args = parse_args()
    repo_root = Path.cwd()
    run_name = args.run_name or f"synthetic-edge-{args.profile}-{timestamp()}"
    run_dir = args.out_dir / run_name
    synthetic_dir = args.synthetic_dir or (run_dir / "synthetic_data")
    synthetic_eval_dir = run_dir / "synthetic_eval"
    real_eval_dir = run_dir / "real_eval"
    candidate_dir = args.candidate_dir or (run_dir / "candidate")
    gate_dir = run_dir / "real_gate"
    run_dir.mkdir(parents=True, exist_ok=True)

    if args.synthetic_dir is None:
        run_command([
            args.python,
            "tools/generate_synthetic_edge_training_data.py",
            "--out-dir",
            str(synthetic_dir),
            "--sample-count",
            str(max(1, int(args.synthetic_count or 1))),
            "--seed",
            str(int(args.seed)),
            "--source-audio-dir",
            str(args.source_audio_dir),
            "--source-manual-dir",
            str(args.source_manual_dir),
            "--ffmpeg",
            args.ffmpeg,
            "--ffprobe",
            args.ffprobe,
            "--exclude-source-video",
            *[str(item) for item in args.exclude_source_video],
        ], repo_root, args.dry_run)

    synthetic_summary = synthetic_eval_dir / "batch_summary.json"
    run_command(evaluate_batch_cmd(
        args,
        synthetic_eval_dir,
        annotations=synthetic_dir / "annotations_synthetic.csv",
        audio_dir=synthetic_dir / "audio",
        manual_dir=synthetic_dir / "manual",
        cache_dir=synthetic_eval_dir,
        rebuild_diagnostics=True,
    ), repo_root, args.dry_run)

    if args.real_baseline_summary:
        real_summary = args.real_baseline_summary
    else:
        real_summary = real_eval_dir / "batch_summary.json"
        run_command(evaluate_batch_cmd(
            args,
            real_eval_dir,
            annotations=Path("tools/annotations_example.csv"),
            audio_dir=Path("tools/data/audio"),
            manual_dir=Path("tools/data/manual"),
            cache_dir=args.cache_dir,
            rebuild_diagnostics=False,
        ), repo_root, args.dry_run)

    if args.dry_run:
        print(f"[synthetic-edge-workflow] dry-run runDir={run_dir}")
        return

    real_summary_paths = collect_summary_paths(real_summary)
    synthetic_summary_paths = collect_summary_paths(synthetic_summary)
    if not real_summary_paths:
        raise RuntimeError(f"No real per-video summary paths found in {real_summary}")
    if not synthetic_summary_paths:
        raise RuntimeError(f"No synthetic per-video summary paths found in {synthetic_summary}")
    weight_json = build_synthetic_weights(
        synthetic_dir / "manifest.json",
        args.synthetic_weight,
        run_dir / "summary_weights.json",
    )

    run_command(train_cmd(
        args,
        candidate_dir,
        [*real_summary_paths, *synthetic_summary_paths],
        weight_json,
        synthetic_dir / "segment_filter_hard_negatives_synthetic.csv",
    ), repo_root)

    run_command([
        args.python,
        "tools/validate_profile_assets.py",
        "--models-dir",
        str(candidate_dir),
        "--profile",
        args.profile,
        "--require-post-end-guard-metadata",
    ], repo_root)

    if not args.skip_real_gate:
        run_command([
            args.python,
            "tools/run_offline_profile_replacement_gate.py",
            "--candidate-segment-filter-model-dir",
            str(candidate_dir),
            "--current-segment-filter-model-dir",
            str(args.model_dir),
            "--out-dir",
            str(gate_dir),
            "--cache-dir",
            str(args.cache_dir),
            "--jobs",
            str(max(1, int(args.jobs or 1))),
            "--command-timeout-sec",
            str(max(0.0, float(args.command_timeout_sec or 0.0))),
            "--max-f1-drop",
            "0.001",
            "--max-mean-f1-drop",
            "0.001",
            "--max-severe-outlier-increase",
            "0",
        ], repo_root)

    gate_summary = gate_dir / "offline_profile_replacement_gate_summary.json"
    installed = False
    if args.install and args.skip_real_gate:
        raise RuntimeError("--install cannot be used with --skip-real-gate")
    if args.install:
        run_command([
            args.python,
            "tools/install_profile_model_assets.py",
            "--profile",
            args.profile,
            "--candidate-dir",
            str(candidate_dir),
            "--gate-summary",
            str(gate_summary),
            "--install-dir",
            str(args.model_dir),
        ], repo_root)
        installed = True

    workflow_summary = {
        "version": "synthetic-edge-training-workflow-v1",
        "profile": args.profile,
        "runDir": str(run_dir),
        "syntheticDir": str(synthetic_dir),
        "syntheticSummary": str(synthetic_summary),
        "realSummary": str(real_summary),
        "candidateDir": str(candidate_dir),
        "gateSummary": str(gate_summary),
        "syntheticWeight": args.synthetic_weight,
        "realSummaryCount": len(real_summary_paths),
        "syntheticSummaryCount": len(synthetic_summary_paths),
        "installed": installed,
    }
    write_json(run_dir / "workflow_summary.json", workflow_summary)
    print(json.dumps(workflow_summary, ensure_ascii=False, indent=2), flush=True)


if __name__ == "__main__":
    main()
