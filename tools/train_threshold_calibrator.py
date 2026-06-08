"""Train a tiny profile-specific threshold calibrator.

The calibrator adjusts finalization thresholds from whole-video AED frame
statistics. It does not replace FireRed AED/head models and should only be
installed after profile-specific gates pass.
"""

from __future__ import annotations

import argparse
import json
import math
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Sequence, Tuple

import numpy as np
import torch
from torch import nn


FEATURE_NAMES = [
    "duration_sec",
    "frame_count",
    "temporal_mean",
    "temporal_p10",
    "temporal_p50",
    "temporal_p90",
    "temporal_std",
    "temporal_above_threshold_ratio",
    "singing_mean",
    "singing_p50",
    "singing_p90",
    "singing_ratio_mean",
    "singing_ratio_p90",
    "music_mean",
    "music_p50",
    "music_p90",
    "music_ratio_mean",
    "music_ratio_p90",
    "speech_mean",
    "speech_p50",
    "speech_p90",
    "speech_ratio_mean",
    "speech_ratio_p90",
    "audio_rms_mean",
    "audio_rms_p50",
    "audio_rms_p90",
    "audio_peak_mean",
    "audio_peak_p90",
    "spectral_flatness_mean",
    "spectral_flatness_p90",
    "spectral_flux_mean",
    "spectral_flux_p90",
    "low_energy_ratio_mean",
    "mid_energy_ratio_mean",
    "high_energy_ratio_mean",
    "strict_silence_ratio",
    "low_energy_frame_ratio",
    "discontinuity_ratio",
    "music_only_like_ratio",
    "vocal_like_ratio",
    "speech_like_ratio",
    "music_minus_singing",
    "music_minus_speech",
    "temporal_minus_baseline",
    "singing_minus_baseline",
    "music_minus_baseline",
    "speech_minus_baseline",
    "rms_minus_baseline",
    "repetition_score",
    "repetition_music_only_window_ratio",
    "repetition_vocal_window_ratio",
    "source_offline_final",
    "source_live_pcm30",
    "source_live_aed60",
]

PROFILE_STEMS = {
    "offline-final": "threshold_calibrator_offline_final",
    "live-pcm30": "threshold_calibrator_live_pcm30",
    "live-realtime-aed60": "threshold_calibrator_live_aed60",
}

BOUNDS = {
    "temporalHeadThresholdDelta": {"min": -0.10, "max": 0.12},
    "segmentKeepThresholdDelta": {"min": -0.12, "max": 0.18},
    "trimConfidenceThresholdDelta": {"min": -0.10, "max": 0.12},
}

TEMPORAL_GRID = [-0.10, -0.075, -0.05, -0.025, 0.0, 0.025, 0.05, 0.075, 0.10, 0.12]
KEEP_GRID = [-0.12, -0.09, -0.06, -0.03, 0.0, 0.03, 0.06, 0.09, 0.12, 0.15, 0.18]
TRIM_GRID = [-0.10, -0.075, -0.05, -0.025, 0.0, 0.025, 0.05, 0.075, 0.10, 0.12]


@dataclass
class Example:
    video: str
    frames_path: str
    feature: List[float]
    target: List[float]
    confidence: float
    weight: float
    reason_codes: List[str]
    metrics: Dict[str, float]
    outlier_type_counts: Dict[str, int]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Train profile-specific threshold_calibrator ONNX candidates.")
    parser.add_argument("--batch-summary", nargs="*", type=Path, default=None)
    parser.add_argument("--batch-dir", type=Path, default=Path("training_runs/smoothing_eval_v8_jinbee/batch"))
    parser.add_argument("--out-dir", type=Path, default=Path("training_runs/threshold_calibrator_v1"))
    parser.add_argument("--install-dir", type=Path, default=None, help="Optional install destination, e.g. models/fireredvad/aed.")
    parser.add_argument("--profile", choices=sorted(PROFILE_STEMS), default="offline-final")
    parser.add_argument("--exclude-video", nargs="*", default=["video_009", "video_052"])
    parser.add_argument("--single-song-min-duration-sec", type=float, default=1800.0)
    parser.add_argument("--epochs", type=int, default=450)
    parser.add_argument("--learning-rate", type=float, default=1e-3)
    parser.add_argument("--weight-decay", type=float, default=1e-4)
    parser.add_argument("--seed", type=int, default=20260601)
    parser.add_argument("--min-confidence", type=float, default=0.35)
    parser.add_argument(
        "--target-scale",
        type=float,
        default=1.65,
        help="Scale non-zero outlier-guided deltas before clamping so the small model does not collapse to no-op.",
    )
    parser.add_argument(
        "--outlier-weight",
        type=float,
        default=4.0,
        help="Training weight multiplier for samples that still have severe outliers.",
    )
    parser.add_argument(
        "--no-op-weight",
        type=float,
        default=0.35,
        help="Training weight for no-op samples; keeps safe behavior without letting them dominate the tiny dataset.",
    )
    parser.add_argument("--device", choices=["auto", "cpu", "cuda"], default="auto")
    return parser.parse_args()


def load_json(path: Path) -> object:
    return json.loads(path.read_text(encoding="utf-8"))


def finite(value: object, fallback: float = 0.0) -> float:
    try:
        num = float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return fallback
    return num if math.isfinite(num) else fallback


def prob(value: object, fallback: float = 0.0) -> float:
    return max(0.0, min(1.0, finite(value, fallback)))


def quantile(values: Sequence[float], ratio: float) -> float:
    if not values:
        return 0.0
    return float(np.quantile(np.asarray(values, dtype=np.float32), ratio))


def mean(values: Sequence[float]) -> float:
    return float(np.mean(np.asarray(values, dtype=np.float32))) if values else 0.0


def std(values: Sequence[float]) -> float:
    return float(np.std(np.asarray(values, dtype=np.float32))) if len(values) >= 2 else 0.0


def profile_source_flags(profile: str) -> Tuple[float, float, float]:
    return (
        1.0 if profile == "offline-final" else 0.0,
        1.0 if profile == "live-pcm30" else 0.0,
        1.0 if profile == "live-realtime-aed60" else 0.0,
    )


def frame_value(frame: Dict[str, object], primary: str, secondary: Optional[str] = None) -> float:
    value = frame.get(primary)
    if value is None and secondary:
        value = frame.get(secondary)
    return prob(value)


def summarize(frames: Sequence[Dict[str, object]]) -> Dict[str, float]:
    if not frames:
        return {
            "frame_count": 0.0,
            "temporal_mean": 0.0,
            "temporal_p10": 0.0,
            "temporal_p50": 0.0,
            "temporal_p90": 0.0,
            "temporal_std": 0.0,
            "temporal_above_threshold_ratio": 0.0,
            "singing_mean": 0.0,
            "singing_p50": 0.0,
            "singing_p90": 0.0,
            "singing_ratio_mean": 0.0,
            "singing_ratio_p90": 0.0,
            "music_mean": 0.0,
            "music_p50": 0.0,
            "music_p90": 0.0,
            "music_ratio_mean": 0.0,
            "music_ratio_p90": 0.0,
            "speech_mean": 0.0,
            "speech_p50": 0.0,
            "speech_p90": 0.0,
            "speech_ratio_mean": 0.0,
            "speech_ratio_p90": 0.0,
            "audio_rms_mean": 0.0,
            "audio_rms_p50": 0.0,
            "audio_rms_p90": 0.0,
            "audio_peak_mean": 0.0,
            "audio_peak_p90": 0.0,
            "spectral_flatness_mean": 0.0,
            "spectral_flatness_p90": 0.0,
            "spectral_flux_mean": 0.0,
            "spectral_flux_p90": 0.0,
            "low_energy_ratio_mean": 0.0,
            "mid_energy_ratio_mean": 0.0,
            "high_energy_ratio_mean": 0.0,
            "strict_silence_ratio": 0.0,
            "low_energy_frame_ratio": 0.0,
            "discontinuity_ratio": 0.0,
            "music_only_like_ratio": 0.0,
            "vocal_like_ratio": 0.0,
            "speech_like_ratio": 0.0,
        }
    temporal = [prob(frame.get("temporalHeadProbability", frame.get("songProbability"))) for frame in frames]
    thresholds = [prob(frame.get("temporalHeadThreshold"), 0.75) for frame in frames]
    threshold_mean = mean(thresholds) or 0.75
    singing = [frame_value(frame, "singingProbability", "singingMean") for frame in frames]
    music = [frame_value(frame, "musicProbability", "musicMean") for frame in frames]
    speech = [frame_value(frame, "speechProbability", "speechMean") for frame in frames]
    singing_ratio = [frame_value(frame, "singingRatio") for frame in frames]
    music_ratio = [frame_value(frame, "musicRatio") for frame in frames]
    speech_ratio = [frame_value(frame, "speechRatio") for frame in frames]
    rms = [max(0.0, finite(frame.get("audioRms"))) for frame in frames]
    peak = [max(0.0, finite(frame.get("audioPeak"))) for frame in frames]
    flatness = [frame_value(frame, "spectralFlatness") for frame in frames]
    flux = [frame_value(frame, "spectralFlux") for frame in frames]
    low = [frame_value(frame, "lowEnergyRatio") for frame in frames]
    mid = [frame_value(frame, "midEnergyRatio") for frame in frames]
    high = [frame_value(frame, "highEnergyRatio") for frame in frames]
    count = max(1, len(frames))
    return {
        "frame_count": float(len(frames)),
        "temporal_mean": mean(temporal),
        "temporal_p10": quantile(temporal, 0.1),
        "temporal_p50": quantile(temporal, 0.5),
        "temporal_p90": quantile(temporal, 0.9),
        "temporal_std": std(temporal),
        "temporal_above_threshold_ratio": sum(1 for value in temporal if value >= threshold_mean) / count,
        "singing_mean": mean(singing),
        "singing_p50": quantile(singing, 0.5),
        "singing_p90": quantile(singing, 0.9),
        "singing_ratio_mean": mean(singing_ratio),
        "singing_ratio_p90": quantile(singing_ratio, 0.9),
        "music_mean": mean(music),
        "music_p50": quantile(music, 0.5),
        "music_p90": quantile(music, 0.9),
        "music_ratio_mean": mean(music_ratio),
        "music_ratio_p90": quantile(music_ratio, 0.9),
        "speech_mean": mean(speech),
        "speech_p50": quantile(speech, 0.5),
        "speech_p90": quantile(speech, 0.9),
        "speech_ratio_mean": mean(speech_ratio),
        "speech_ratio_p90": quantile(speech_ratio, 0.9),
        "audio_rms_mean": mean(rms),
        "audio_rms_p50": quantile(rms, 0.5),
        "audio_rms_p90": quantile(rms, 0.9),
        "audio_peak_mean": mean(peak),
        "audio_peak_p90": quantile(peak, 0.9),
        "spectral_flatness_mean": mean(flatness),
        "spectral_flatness_p90": quantile(flatness, 0.9),
        "spectral_flux_mean": mean(flux),
        "spectral_flux_p90": quantile(flux, 0.9),
        "low_energy_ratio_mean": mean(low),
        "mid_energy_ratio_mean": mean(mid),
        "high_energy_ratio_mean": mean(high),
        "strict_silence_ratio": sum(1 for r, p in zip(rms, peak) if r <= 0.0045 and p <= 0.018) / count,
        "low_energy_frame_ratio": sum(1 for r, p, l in zip(rms, peak, low) if r <= 0.006 or p <= 0.025 or l >= 0.72) / count,
        "discontinuity_ratio": sum(1 for frame in frames if frame.get("discontinuityBefore") or frame.get("discontinuityAfter")) / count,
        "music_only_like_ratio": sum(1 for m, s, sp, t in zip(music, singing, speech, temporal) if m >= 0.58 and s <= 0.28 and sp <= 0.42 and t <= 0.42) / count,
        "vocal_like_ratio": sum(1 for s, t in zip(singing, temporal) if s >= 0.4 or t >= 0.55) / count,
        "speech_like_ratio": sum(1 for sp, s in zip(speech, singing) if sp >= 0.58 and s <= 0.38) / count,
    }


def middle_baseline(frames: Sequence[Dict[str, object]]) -> Sequence[Dict[str, object]]:
    if not frames:
        return []
    first = finite(frames[0].get("timeSec"))
    last = finite(frames[-1].get("timeSec"), first)
    duration = max(0.0, last - first)
    if duration < 900:
        return frames
    center = first + (duration * 0.5)
    half = min(300.0, max(150.0, duration * 0.08))
    return [frame for frame in frames if center - half <= finite(frame.get("timeSec")) <= center + half]


def build_feature_vector(frames: Sequence[Dict[str, object]], profile: str) -> List[float]:
    safe_frames = [frame for frame in frames if isinstance(frame, dict)]
    first = finite(safe_frames[0].get("timeSec")) if safe_frames else 0.0
    last = finite(safe_frames[-1].get("timeSec"), first) if safe_frames else first
    stats = summarize(safe_frames)
    baseline = summarize(middle_baseline(safe_frames))
    source_flags = profile_source_flags(profile)
    repetition = {"score": 0.0, "musicOnlyWindowRatio": 0.0, "vocalWindowRatio": 0.0}
    return [
        max(0.0, last - first),
        stats["frame_count"],
        stats["temporal_mean"],
        stats["temporal_p10"],
        stats["temporal_p50"],
        stats["temporal_p90"],
        stats["temporal_std"],
        stats["temporal_above_threshold_ratio"],
        stats["singing_mean"],
        stats["singing_p50"],
        stats["singing_p90"],
        stats["singing_ratio_mean"],
        stats["singing_ratio_p90"],
        stats["music_mean"],
        stats["music_p50"],
        stats["music_p90"],
        stats["music_ratio_mean"],
        stats["music_ratio_p90"],
        stats["speech_mean"],
        stats["speech_p50"],
        stats["speech_p90"],
        stats["speech_ratio_mean"],
        stats["speech_ratio_p90"],
        stats["audio_rms_mean"],
        stats["audio_rms_p50"],
        stats["audio_rms_p90"],
        stats["audio_peak_mean"],
        stats["audio_peak_p90"],
        stats["spectral_flatness_mean"],
        stats["spectral_flatness_p90"],
        stats["spectral_flux_mean"],
        stats["spectral_flux_p90"],
        stats["low_energy_ratio_mean"],
        stats["mid_energy_ratio_mean"],
        stats["high_energy_ratio_mean"],
        stats["strict_silence_ratio"],
        stats["low_energy_frame_ratio"],
        stats["discontinuity_ratio"],
        stats["music_only_like_ratio"],
        stats["vocal_like_ratio"],
        stats["speech_like_ratio"],
        stats["music_mean"] - stats["singing_mean"],
        stats["music_mean"] - stats["speech_mean"],
        stats["temporal_mean"] - baseline["temporal_mean"],
        stats["singing_mean"] - baseline["singing_mean"],
        stats["music_mean"] - baseline["music_mean"],
        stats["speech_mean"] - baseline["speech_mean"],
        stats["audio_rms_mean"] - baseline["audio_rms_mean"],
        repetition["score"],
        repetition["musicOnlyWindowRatio"],
        repetition["vocalWindowRatio"],
        *source_flags,
    ]


def outlier_type_counts(outliers: Iterable[Dict[str, object]]) -> Dict[str, int]:
    counts: Dict[str, int] = {}
    for outlier in outliers:
        key = str(outlier.get("type") or "unknown")
        counts[key] = counts.get(key, 0) + 1
    return counts


def clamp(value: float, name: str) -> float:
    bounds = BOUNDS[name]
    return max(float(bounds["min"]), min(float(bounds["max"]), value))


def infer_target(outliers: Sequence[Dict[str, object]], metrics: Dict[str, float], target_scale: float = 1.0) -> Tuple[List[float], float, List[str]]:
    counts = outlier_type_counts(outliers)
    temporal = keep = trim = 0.0
    reasons: List[str] = []
    conservative_types = {
        "early-start",
        "false-positive-repetitive-bgm",
        "false-positive-bgm",
        "false-positive-long",
        "late-end-bgm",
        "early-start-rehearsal",
        "merged-close-songs",
        "low-video-f1",
    }
    recall_types = {
        "missed-segment",
        "low-recall",
        "late-start",
        "early-end",
        "early-end-speech-like",
        "acapella-risk",
    }
    conservative = sum(count for key, count in counts.items() if key in conservative_types)
    recall = sum(count for key, count in counts.items() if key in recall_types)
    if conservative:
        temporal += min(0.09, 0.025 * conservative)
        keep += min(0.15, 0.035 * conservative)
        trim += min(0.08, 0.02 * conservative)
        reasons.append("conservative-outliers")
    if recall:
        temporal -= min(0.08, 0.025 * recall)
        keep -= min(0.09, 0.025 * recall)
        trim -= min(0.08, 0.02 * recall)
        reasons.append("recall-outliers")
    if finite(metrics.get("precision"), 1.0) < 0.96 and finite(metrics.get("recall"), 1.0) >= 0.98:
        keep += 0.03
        reasons.append("low-precision")
    if finite(metrics.get("recall"), 1.0) < 0.96 and finite(metrics.get("precision"), 1.0) >= 0.98:
        temporal -= 0.03
        reasons.append("low-recall-metric")
    if reasons:
        scale = max(0.1, float(target_scale))
        temporal *= scale
        keep *= scale
        trim *= scale
    target = [
        clamp(temporal, "temporalHeadThresholdDelta"),
        clamp(keep, "segmentKeepThresholdDelta"),
        clamp(trim, "trimConfidenceThresholdDelta"),
    ]
    confidence = 0.7 if reasons else 0.45
    return target, confidence, reasons or ["no-op-target"]


def collect_batch_summaries(args: argparse.Namespace) -> List[Path]:
    if args.batch_summary:
        return [path for path in args.batch_summary if path.exists()]
    default_path = args.batch_dir / "batch_summary.json"
    return [default_path] if default_path.exists() else []


def video_duration_from_frames(frames: Sequence[Dict[str, object]]) -> float:
    if not frames:
        return 0.0
    return max(0.0, finite(frames[-1].get("timeSec")) - finite(frames[0].get("timeSec")))


def build_examples(args: argparse.Namespace) -> List[Example]:
    examples: List[Example] = []
    excluded = {str(item) for item in args.exclude_video}
    for summary_path in collect_batch_summaries(args):
        payload = load_json(summary_path)
        if not isinstance(payload, dict):
            continue
        videos = payload.get("videos") or []
        if not isinstance(videos, list):
            continue
        for item in videos:
            if not isinstance(item, dict):
                continue
            video = str(item.get("video") or "")
            if not video or video in excluded:
                continue
            frames_path = Path(str(item.get("framesPath") or ""))
            if not frames_path.exists():
                continue
            frames_payload = load_json(frames_path)
            frames = frames_payload.get("frames", []) if isinstance(frames_payload, dict) else []
            if not isinstance(frames, list):
                continue
            duration = video_duration_from_frames(frames)
            manual_count = int(item.get("manualCount") or item.get("songCount") or 0)
            if manual_count <= 1 and duration < args.single_song_min_duration_sec:
                continue
            outliers = item.get("severeOutliers") or []
            if not isinstance(outliers, list):
                outliers = []
            metrics = item.get("metrics") or {}
            if not isinstance(metrics, dict):
                metrics = {}
            target, confidence, reason_codes = infer_target(outliers, metrics, args.target_scale)
            outlier_count = sum(outlier_type_counts(outliers).values())
            weight = args.no_op_weight if outlier_count <= 0 else args.outlier_weight * (1.0 + min(4.0, outlier_count) * 0.25)
            examples.append(Example(
                video=video,
                frames_path=str(frames_path),
                feature=build_feature_vector(frames, args.profile),
                target=target,
                confidence=confidence,
                weight=weight,
                reason_codes=reason_codes,
                metrics={key: finite(value) for key, value in metrics.items()},
                outlier_type_counts=outlier_type_counts(outliers),
            ))
    return examples


class ThresholdCalibratorNet(nn.Module):
    def __init__(self, input_dim: int, feature_mean: np.ndarray, feature_std: np.ndarray) -> None:
        super().__init__()
        self.register_buffer("feature_mean", torch.tensor(feature_mean.tolist(), dtype=torch.float32))
        self.register_buffer("feature_std", torch.tensor(feature_std.tolist(), dtype=torch.float32))
        mins = np.asarray([
            BOUNDS["temporalHeadThresholdDelta"]["min"],
            BOUNDS["segmentKeepThresholdDelta"]["min"],
            BOUNDS["trimConfidenceThresholdDelta"]["min"],
        ], dtype=np.float32)
        maxs = np.asarray([
            BOUNDS["temporalHeadThresholdDelta"]["max"],
            BOUNDS["segmentKeepThresholdDelta"]["max"],
            BOUNDS["trimConfidenceThresholdDelta"]["max"],
        ], dtype=np.float32)
        self.register_buffer("delta_center", torch.tensor(((mins + maxs) / 2.0).tolist(), dtype=torch.float32))
        self.register_buffer("delta_half_range", torch.tensor(((maxs - mins) / 2.0).tolist(), dtype=torch.float32))
        self.net = nn.Sequential(
            nn.Linear(input_dim, 48),
            nn.ReLU(),
            nn.Dropout(0.05),
            nn.Linear(48, 24),
            nn.ReLU(),
        )
        self.delta_head = nn.Linear(24, 3)
        self.confidence_head = nn.Linear(24, 1)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        z = (x - self.feature_mean) / self.feature_std.clamp_min(1e-6)
        hidden = self.net(z)
        deltas = self.delta_center + (torch.tanh(self.delta_head(hidden)) * self.delta_half_range)
        confidence = torch.sigmoid(self.confidence_head(hidden))
        return torch.cat([deltas, confidence], dim=1)


def choose_device(name: str) -> torch.device:
    if name == "cuda":
        if not torch.cuda.is_available():
            raise RuntimeError("CUDA requested but unavailable.")
        return torch.device("cuda")
    if name == "auto" and torch.cuda.is_available():
        return torch.device("cuda")
    return torch.device("cpu")


def split_indices(examples: Sequence[Example], seed: int) -> Tuple[List[int], List[int]]:
    videos = sorted({example.video for example in examples})
    rng = np.random.default_rng(seed)
    rng.shuffle(videos)
    val_count = max(1, int(round(len(videos) * 0.25))) if len(videos) >= 4 else max(0, len(videos) - 2)
    val_videos = set(videos[:val_count])
    train = [index for index, example in enumerate(examples) if example.video not in val_videos]
    val = [index for index, example in enumerate(examples) if example.video in val_videos]
    if not train or not val:
        indices = list(range(len(examples)))
        return indices, indices
    return train, val


def evaluate(model: ThresholdCalibratorNet, x: torch.Tensor, y: torch.Tensor, indices: Sequence[int]) -> Dict[str, float]:
    if not indices:
        return {"mse": 0.0, "deltaMae": 0.0, "confidenceMae": 0.0}
    with torch.no_grad():
        idx = torch.as_tensor(indices, dtype=torch.long, device=x.device)
        pred = model(x[idx])
        target = y[idx]
        diff = torch.abs(pred - target)
        return {
            "mse": float(torch.mean((pred - target) ** 2).item()),
            "deltaMae": float(torch.mean(diff[:, :3]).item()),
            "confidenceMae": float(torch.mean(diff[:, 3]).item()),
        }


def train(args: argparse.Namespace, examples: Sequence[Example]) -> Tuple[ThresholdCalibratorNet, Dict[str, object]]:
    if not examples:
        raise RuntimeError("No threshold calibrator examples were built.")
    torch.manual_seed(args.seed)
    np.random.seed(args.seed)
    x_np = np.asarray([example.feature for example in examples], dtype=np.float32)
    y_np = np.asarray([example.target + [example.confidence] for example in examples], dtype=np.float32)
    weights_np = np.asarray([max(0.01, float(example.weight)) for example in examples], dtype=np.float32)
    train_indices, val_indices = split_indices(examples, args.seed)
    feature_mean = x_np[train_indices].mean(axis=0)
    feature_std = np.maximum(x_np[train_indices].std(axis=0), 1e-6)
    device = choose_device(args.device)
    x = torch.tensor(x_np.tolist(), dtype=torch.float32, device=device)
    y = torch.tensor(y_np.tolist(), dtype=torch.float32, device=device)
    weights = torch.tensor(weights_np.tolist(), dtype=torch.float32, device=device)
    model = ThresholdCalibratorNet(x.shape[1], feature_mean, feature_std).to(device)
    optimizer = torch.optim.AdamW(model.parameters(), lr=args.learning_rate, weight_decay=args.weight_decay)
    train_tensor = torch.as_tensor(train_indices, dtype=torch.long, device=device)
    best_state = None
    best_val = float("inf")
    for epoch in range(max(1, int(args.epochs))):
        model.train()
        optimizer.zero_grad(set_to_none=True)
        pred = model(x[train_tensor])
        target = y[train_tensor]
        sample_weights = weights[train_tensor]
        sample_weights = sample_weights / sample_weights.mean().clamp_min(1e-6)
        delta_loss = torch.mean(torch.mean((pred[:, :3] - target[:, :3]) ** 2, dim=1) * sample_weights)
        confidence_loss = torch.mean(((pred[:, 3] - target[:, 3]) ** 2) * sample_weights)
        loss = delta_loss + (0.2 * confidence_loss)
        loss.backward()
        optimizer.step()
        if epoch % 10 == 0 or epoch == args.epochs - 1:
            model.eval()
            val = evaluate(model, x, y, val_indices)
            if val["mse"] < best_val:
                best_val = val["mse"]
                best_state = {key: value.detach().cpu().clone() for key, value in model.state_dict().items()}
    if best_state is not None:
        model.load_state_dict(best_state)
    model.eval()
    return model.cpu(), {
        "train": evaluate(model, x, y, train_indices),
        "validation": evaluate(model, x, y, val_indices),
        "trainVideos": sorted({examples[index].video for index in train_indices}),
        "validationVideos": sorted({examples[index].video for index in val_indices}),
    }


def export_model(args: argparse.Namespace, model: ThresholdCalibratorNet, examples: Sequence[Example], metrics: Dict[str, object]) -> None:
    args.out_dir.mkdir(parents=True, exist_ok=True)
    stem = PROFILE_STEMS[args.profile]
    onnx_path = args.out_dir / f"{stem}.onnx"
    pt_path = args.out_dir / f"{stem}.pt"
    meta_path = args.out_dir / f"{stem}.meta.json"
    metadata = {
        "version": "threshold-calibrator-v1",
        "assetProfile": args.profile,
        "profile": args.profile,
        "inputName": "threshold_features",
        "outputName": "threshold_deltas",
        "inputDim": len(FEATURE_NAMES),
        "featureNames": FEATURE_NAMES,
        "bounds": BOUNDS,
        "minConfidence": args.min_confidence,
        "oracleGrid": {
            "temporal": TEMPORAL_GRID,
            "keep": KEEP_GRID,
            "trimConfidence": TRIM_GRID,
            "selection": "outlier-guided-v2; weighted outlier targets with clamped delta scaling",
        },
        "trainingSummary": {
            "exampleCount": len(examples),
            "videos": sorted({example.video for example in examples}),
            "reasonCodeCounts": reason_code_counts(examples),
            "outlierTypeCounts": combined_outlier_type_counts(examples),
            "weighting": {
                "targetScale": args.target_scale,
                "outlierWeight": args.outlier_weight,
                "noOpWeight": args.no_op_weight,
            },
            "metrics": metrics,
        },
    }
    torch.save({"state_dict": model.state_dict(), "metadata": metadata}, pt_path)
    dummy = torch.zeros(1, len(FEATURE_NAMES), dtype=torch.float32)
    torch.onnx.export(
        model,
        dummy,
        onnx_path,
        input_names=["threshold_features"],
        output_names=["threshold_deltas"],
        dynamic_axes={"threshold_features": {0: "batch"}, "threshold_deltas": {0: "batch"}},
        opset_version=17,
    )
    meta_path.write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8")
    if args.install_dir:
        args.install_dir.mkdir(parents=True, exist_ok=True)
        shutil.copy2(onnx_path, args.install_dir / onnx_path.name)
        shutil.copy2(meta_path, args.install_dir / meta_path.name)
    (args.out_dir / "training_examples.json").write_text(
        json.dumps([example.__dict__ for example in examples], ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(f"[threshold-calibrator] wrote {onnx_path}")
    print(f"[threshold-calibrator] wrote {meta_path}")
    if args.install_dir:
        print(f"[threshold-calibrator] installed candidate assets to {args.install_dir}")


def reason_code_counts(examples: Sequence[Example]) -> Dict[str, int]:
    counts: Dict[str, int] = {}
    for example in examples:
        for code in example.reason_codes:
            counts[code] = counts.get(code, 0) + 1
    return counts


def combined_outlier_type_counts(examples: Sequence[Example]) -> Dict[str, int]:
    counts: Dict[str, int] = {}
    for example in examples:
        for key, value in example.outlier_type_counts.items():
            counts[key] = counts.get(key, 0) + int(value)
    return counts


def main() -> None:
    args = parse_args()
    examples = build_examples(args)
    model, metrics = train(args, examples)
    export_model(args, model, examples, metrics)


if __name__ == "__main__":
    main()
