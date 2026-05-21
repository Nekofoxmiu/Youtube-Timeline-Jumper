"""Train the experimental segment-level keep/drop and trim advisor.

The model is intentionally small and only operates after global smoothing. It
uses predicted segments plus cached AED/stat frames to decide whether each
segment should be kept and how much its start/end should move.
"""

from __future__ import annotations

import argparse
import json
import math
import shutil
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Optional, Sequence, Tuple

import numpy as np
import torch
from torch import nn

from segment_filter_features import (
    DEFAULT_FILTER_POLICY,
    SEGMENT_FILTER_FEATURE_NAMES,
    SEGMENT_FILTER_VERSION,
    apply_segment_filter_predictions,
    build_segment_filter_feature_vector,
    overlap_seconds,
)


@dataclass
class Example:
    video: str
    segment_index: int
    features: List[float]
    keep: float
    start_delta: float
    end_delta: float
    overlap_sec: float
    recall_ratio: float
    precision_ratio: float
    extra_sec: float


class SegmentFilterNet(nn.Module):
    def __init__(self, input_dim: int, feature_mean: np.ndarray, feature_std: np.ndarray, trim_clamp_sec: float) -> None:
        super().__init__()
        self.register_buffer("feature_mean", torch.as_tensor(feature_mean, dtype=torch.float32))
        self.register_buffer("feature_std", torch.as_tensor(feature_std, dtype=torch.float32))
        self.trim_clamp_sec = float(trim_clamp_sec)
        self.encoder = nn.Sequential(
            nn.Linear(input_dim, 48),
            nn.ReLU(),
            nn.Dropout(0.08),
            nn.Linear(48, 24),
            nn.ReLU(),
        )
        self.keep_head = nn.Linear(24, 1)
        self.delta_head = nn.Linear(24, 2)

    def _encoded(self, x: torch.Tensor) -> torch.Tensor:
        z = (x - self.feature_mean) / self.feature_std.clamp_min(1e-6)
        return self.encoder(z)

    def raw_outputs(self, x: torch.Tensor) -> Tuple[torch.Tensor, torch.Tensor]:
        h = self._encoded(x)
        keep_logit = self.keep_head(h).squeeze(-1)
        deltas = torch.tanh(self.delta_head(h)) * self.trim_clamp_sec
        return keep_logit, deltas

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        keep_logit, deltas = self.raw_outputs(x)
        keep_prob = torch.sigmoid(keep_logit).unsqueeze(-1)
        return torch.cat([keep_prob, deltas], dim=1)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Train segment filter / trim advisor from smoothing batch outputs.")
    parser.add_argument("--batch-dir", type=Path, default=Path("training_runs/smoothing_eval_v8_jinbee/batch"))
    parser.add_argument("--out-dir", type=Path, default=Path("training_runs/segment_filter_v1"))
    parser.add_argument("--install-dir", type=Path, default=None, help="Optional model asset destination, e.g. models/fireredvad/aed.")
    parser.add_argument("--val-videos", nargs="*", default=["video_013", "video_015", "video_051"])
    parser.add_argument("--epochs", type=int, default=900)
    parser.add_argument("--learning-rate", type=float, default=2e-3)
    parser.add_argument("--seed", type=int, default=17)
    parser.add_argument("--trim-clamp-sec", type=float, default=60.0)
    parser.add_argument("--min-overlap-sec", type=float, default=20.0)
    parser.add_argument("--min-recall", type=float, default=0.28)
    parser.add_argument("--min-precision", type=float, default=0.18)
    parser.add_argument("--max-extra-sec", type=float, default=240.0)
    parser.add_argument("--max-extra-ratio", type=float, default=0.78)
    return parser.parse_args()


def normalize_video_key(value: str) -> str:
    text = str(value).strip()
    if text.startswith("video_"):
        return text
    if text.isdigit():
        return f"video_{int(text):03d}"
    return text


def load_json(path: Path) -> object:
    return json.loads(path.read_text(encoding="utf-8"))


def summary_paths(batch_dir: Path) -> List[Path]:
    return sorted(path for path in batch_dir.glob("video_*.smoothing_summary.json") if ".segment_filter" not in path.name)


def best_manual_match(segment: Dict[str, object], manual_segments: Sequence[Dict[str, object]]) -> Tuple[Optional[Dict[str, object]], float, float, float, float]:
    best_manual: Optional[Dict[str, object]] = None
    best_overlap = 0.0
    best_recall = 0.0
    best_precision = 0.0
    duration = max(1.0, float(segment.get("endSec", 0.0)) - float(segment.get("startSec", 0.0)))
    for manual in manual_segments:
        overlap = overlap_seconds(segment, manual)
        manual_duration = max(1.0, float(manual.get("endSec", 0.0)) - float(manual.get("startSec", 0.0)))
        recall = overlap / manual_duration
        precision = overlap / duration
        if overlap > best_overlap:
            best_manual = manual
            best_overlap = overlap
            best_recall = recall
            best_precision = precision
    extra_sec = max(0.0, duration - best_overlap)
    return best_manual, best_overlap, best_recall, best_precision, extra_sec


def collect_examples(args: argparse.Namespace) -> List[Example]:
    examples: List[Example] = []
    for summary_path in summary_paths(args.batch_dir):
        video = summary_path.name.split(".smoothing_summary.json")[0]
        summary = load_json(summary_path)
        frames_path = Path(str(summary.get("frames") or args.batch_dir / f"{video}.frames.json"))
        if not frames_path.is_absolute():
            frames_path = Path.cwd() / frames_path
        if not frames_path.exists():
            frames_path = args.batch_dir / f"{video}.frames.json"
        frames_payload = load_json(frames_path)
        frames = frames_payload.get("frames", []) if isinstance(frames_payload, dict) else []
        manual_segments = [match.get("manual") for match in summary.get("matches", []) if isinstance(match, dict) and isinstance(match.get("manual"), dict)]
        context = {
            "endSec": float(summary.get("endSec") or frames_payload.get("durationSec") or 0.0),
            "trackerSegments": summary.get("trackerSegments") or [],
            "modelRunSegments": summary.get("modelRunSegments") or [],
            "fallbackSegments": summary.get("fallbackSegments") or [],
            "selectedModelFallbackSegments": summary.get("selectedModelFallbackSegments") or [],
        }

        candidate_segments: List[Dict[str, object]] = []
        seen = set()

        def add_candidates(source: str, segments: Sequence[Dict[str, object]]) -> None:
            for segment in segments:
                if not isinstance(segment, dict):
                    continue
                start = round(float(segment.get("startSec", 0.0)), 1)
                end = round(float(segment.get("endSec", 0.0)), 1)
                key = (start, end)
                if key in seen:
                    continue
                seen.add(key)
                candidate_segments.append({**segment, "_segmentFilterSource": source})

        add_candidates("final", summary.get("segments") or [])
        add_candidates("dropped-tracker", summary.get("droppedTrackerSegments") or [])
        add_candidates("dropped-music-only", summary.get("droppedMusicOnlySegments") or [])
        add_candidates("model-run", summary.get("modelRunSegments") or [])

        for index, segment in enumerate(candidate_segments):
            if not isinstance(segment, dict):
                continue
            best_manual, overlap, recall, precision, extra_sec = best_manual_match(segment, manual_segments)
            duration = max(1.0, float(segment.get("endSec", 0.0)) - float(segment.get("startSec", 0.0)))
            extra_ratio = extra_sec / duration
            keep = 1.0 if (
                best_manual is not None
                and overlap >= args.min_overlap_sec
                and recall >= args.min_recall
                and precision >= args.min_precision
                and extra_sec <= args.max_extra_sec
                and extra_ratio <= args.max_extra_ratio
            ) else 0.0
            if keep and best_manual:
                start_delta = float(best_manual.get("startSec", 0.0)) - float(segment.get("startSec", 0.0))
                end_delta = float(best_manual.get("endSec", 0.0)) - float(segment.get("endSec", 0.0))
                start_delta = max(-args.trim_clamp_sec, min(args.trim_clamp_sec, start_delta))
                end_delta = max(-args.trim_clamp_sec, min(args.trim_clamp_sec, end_delta))
            else:
                start_delta = 0.0
                end_delta = 0.0
            examples.append(Example(
                video=video,
                segment_index=index,
                features=build_segment_filter_feature_vector(segment, frames, context),
                keep=keep,
                start_delta=start_delta,
                end_delta=end_delta,
                overlap_sec=overlap,
                recall_ratio=recall,
                precision_ratio=precision,
                extra_sec=extra_sec,
            ))
    return examples


def split_examples(examples: Sequence[Example], val_videos: Sequence[str]) -> Tuple[List[int], List[int], List[str]]:
    groups = sorted({example.video for example in examples})
    requested = {normalize_video_key(video) for video in val_videos}
    val_groups = sorted(group for group in groups if group in requested)
    if not val_groups and len(groups) >= 2:
        val_groups = [groups[-1]]
    train_indices = [index for index, example in enumerate(examples) if example.video not in val_groups]
    val_indices = [index for index, example in enumerate(examples) if example.video in val_groups]
    if not train_indices or not val_indices:
        raise RuntimeError(f"Train/validation split produced an empty partition. groups={groups} val={val_groups}")
    return train_indices, val_indices, val_groups


def segment_metrics(probs: Sequence[float], labels: Sequence[float], threshold: float) -> Dict[str, float]:
    tp = fp = fn = tn = 0
    for prob, label in zip(probs, labels):
        pred = float(prob) >= threshold
        actual = float(label) >= 0.5
        if pred and actual:
            tp += 1
        elif pred and not actual:
            fp += 1
        elif not pred and actual:
            fn += 1
        else:
            tn += 1
    precision = tp / max(1, tp + fp)
    recall = tp / max(1, tp + fn)
    f1 = (2 * precision * recall) / max(1e-9, precision + recall)
    return {"precision": precision, "recall": recall, "f1": f1, "tp": tp, "fp": fp, "fn": fn, "tn": tn}


def evaluate_model(model: SegmentFilterNet, x: torch.Tensor, y_keep: torch.Tensor, y_delta: torch.Tensor, indices: Sequence[int]) -> Dict[str, object]:
    model.eval()
    with torch.no_grad():
        output = model(x[list(indices)]).detach().cpu().tolist()
    probs = [float(row[0]) for row in output]
    deltas = [[float(row[1]), float(row[2])] for row in output]
    labels = [float(value) for value in y_keep[list(indices)].detach().cpu().tolist()]
    targets = [[float(row[0]), float(row[1])] for row in y_delta[list(indices)].detach().cpu().tolist()]
    best_threshold = 0.35
    best = None
    for threshold in np.linspace(0.2, 0.75, 23):
        metrics = segment_metrics(probs, labels, float(threshold))
        if best is None or metrics["f1"] > best["metrics"]["f1"] or (math.isclose(metrics["f1"], best["metrics"]["f1"]) and metrics["precision"] > best["metrics"]["precision"]):
            best = {"threshold": float(threshold), "metrics": metrics}
    keep_indexes = [index for index, label in enumerate(labels) if label >= 0.5]
    if keep_indexes:
        start_mae = sum(abs(deltas[index][0] - targets[index][0]) for index in keep_indexes) / len(keep_indexes)
        end_mae = sum(abs(deltas[index][1] - targets[index][1]) for index in keep_indexes) / len(keep_indexes)
        delta_mae = [start_mae, end_mae]
    else:
        delta_mae = [0.0, 0.0]
    assert best is not None
    return {"bestThreshold": best["threshold"], "metrics": best["metrics"], "deltaMae": {"start": delta_mae[0], "end": delta_mae[1]}}


def train_model(args: argparse.Namespace, examples: Sequence[Example]) -> Tuple[SegmentFilterNet, Dict[str, object]]:
    torch.manual_seed(args.seed)
    np.random.seed(args.seed)
    train_indices, val_indices, val_groups = split_examples(examples, args.val_videos)
    x_np = np.asarray([example.features for example in examples], dtype=np.float32)
    keep_np = np.asarray([example.keep for example in examples], dtype=np.float32)
    delta_np = np.asarray([[example.start_delta, example.end_delta] for example in examples], dtype=np.float32)
    feature_mean = x_np[train_indices].mean(axis=0)
    feature_std = x_np[train_indices].std(axis=0)
    feature_std = np.where(feature_std < 1e-6, 1.0, feature_std)

    x = torch.tensor(x_np.tolist(), dtype=torch.float32)
    y_keep = torch.tensor(keep_np.tolist(), dtype=torch.float32)
    y_delta = torch.tensor(delta_np.tolist(), dtype=torch.float32)
    train_tensor = torch.as_tensor(train_indices, dtype=torch.long)
    model = SegmentFilterNet(x.shape[1], feature_mean, feature_std, args.trim_clamp_sec)
    optimizer = torch.optim.AdamW(model.parameters(), lr=args.learning_rate, weight_decay=1e-4)
    positive = float(keep_np[train_indices].sum())
    negative = float(len(train_indices) - positive)
    pos_weight = torch.tensor([max(1.0, min(8.0, negative / max(1.0, positive)))], dtype=torch.float32)
    bce = nn.BCEWithLogitsLoss(pos_weight=pos_weight)
    huber = nn.SmoothL1Loss(reduction="none", beta=6.0)

    best_state = None
    best_score = -1.0
    best_epoch = 0
    for epoch in range(1, args.epochs + 1):
        model.train()
        optimizer.zero_grad(set_to_none=True)
        keep_logit, deltas = model.raw_outputs(x[train_tensor])
        keep_target = y_keep[train_tensor]
        delta_target = y_delta[train_tensor]
        keep_loss = bce(keep_logit, keep_target)
        keep_mask = keep_target >= 0.5
        if keep_mask.any():
            delta_loss = (huber(deltas[keep_mask], delta_target[keep_mask]) / max(1.0, args.trim_clamp_sec)).mean()
        else:
            delta_loss = torch.zeros((), dtype=torch.float32)
        loss = keep_loss + (0.65 * delta_loss)
        loss.backward()
        optimizer.step()

        if epoch % 25 == 0 or epoch == args.epochs:
            val = evaluate_model(model, x, y_keep, y_delta, val_indices)
            score = float(val["metrics"]["f1"])
            if score > best_score:
                best_score = score
                best_epoch = epoch
                best_state = {name: tensor.detach().cpu().clone() for name, tensor in model.state_dict().items()}
    if best_state is not None:
        model.load_state_dict(best_state)

    train_eval = evaluate_model(model, x, y_keep, y_delta, train_indices)
    val_eval = evaluate_model(model, x, y_keep, y_delta, val_indices)
    threshold = float(val_eval["bestThreshold"])
    metadata = {
        "modelType": "firered-segment-filter",
        "segmentFilterVersion": SEGMENT_FILTER_VERSION,
        "inputName": "segment_features",
        "outputName": "segment_filter_output",
        "inputDim": len(SEGMENT_FILTER_FEATURE_NAMES),
        "featureNames": SEGMENT_FILTER_FEATURE_NAMES,
        "keepThreshold": threshold,
        "trimConfidenceThreshold": max(threshold, DEFAULT_FILTER_POLICY["trim_confidence_threshold"]),
        "trimClampSec": args.trim_clamp_sec,
        "minSegmentDurationSec": DEFAULT_FILTER_POLICY["min_segment_duration_sec"],
        "split": "by-video",
        "valGroups": val_groups,
        "bestEpoch": best_epoch,
        "exampleCount": len(examples),
        "positiveCount": int(keep_np.sum()),
        "negativeCount": int(len(keep_np) - keep_np.sum()),
        "trainMetrics": train_eval,
        "validationMetrics": val_eval,
        "labelPolicy": {
            "keep": "Predicted segment overlaps manual song segment enough to preserve and optionally trim.",
            "drop": "False positive, low overlap, or long extra non-song/BGM-only candidate.",
            "trimTargets": "manual_best_start/end minus predicted start/end, clamped to trimClampSec.",
        },
    }
    return model, metadata


def export_model(model: SegmentFilterNet, out_dir: Path, metadata: Dict[str, object]) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    pt_path = out_dir / "segment_filter.pt"
    onnx_path = out_dir / "segment_filter.onnx"
    meta_path = out_dir / "segment_filter.meta.json"
    torch.save({"state_dict": model.state_dict(), "metadata": metadata}, pt_path)
    dummy = torch.zeros(1, int(metadata["inputDim"]), dtype=torch.float32)
    torch.onnx.export(
        model,
        dummy,
        onnx_path,
        input_names=[str(metadata["inputName"])],
        output_names=[str(metadata["outputName"])],
        dynamic_axes={str(metadata["inputName"]): {0: "batch"}, str(metadata["outputName"]): {0: "batch"}},
        opset_version=17,
    )
    meta_path.write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8")


def write_examples(out_dir: Path, examples: Sequence[Example]) -> None:
    path = out_dir / "training_examples.jsonl"
    with path.open("w", encoding="utf-8") as handle:
        for example in examples:
            handle.write(json.dumps(example.__dict__, ensure_ascii=False) + "\n")


def install_assets(out_dir: Path, install_dir: Path) -> None:
    install_dir.mkdir(parents=True, exist_ok=True)
    for name in ["segment_filter.onnx", "segment_filter.meta.json"]:
        shutil.copy2(out_dir / name, install_dir / name)


def main() -> None:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    args = parse_args()
    examples = collect_examples(args)
    if len(examples) < 4:
        raise RuntimeError(f"Not enough segment examples for training: {len(examples)}")
    model, metadata = train_model(args, examples)
    export_model(model, args.out_dir, metadata)
    write_examples(args.out_dir, examples)
    if args.install_dir:
        install_assets(args.out_dir, args.install_dir)
    print(f"[segment-filter] examples={len(examples)} positives={metadata['positiveCount']} negatives={metadata['negativeCount']}")
    print(f"[segment-filter] val={json.dumps(metadata['validationMetrics'], ensure_ascii=False)}")
    print(f"[segment-filter] wrote {args.out_dir / 'segment_filter.onnx'}")
    if args.install_dir:
        print(f"[segment-filter] installed to {args.install_dir}")


if __name__ == "__main__":
    main()
