"""Train a small window-level temporal threshold advisor.

The model predicts a local temporalHeadThreshold delta for rolling windows.
It is intentionally separate from the video-level threshold calibrator because
remaining errors are local boundary/BGM issues rather than whole-video drift.
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
    "window_duration_sec",
    "window_frame_count",
    "relative_center",
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
    "music_only_like_ratio",
    "vocal_like_ratio",
    "speech_like_ratio",
    "music_minus_singing",
    "music_minus_speech",
    "temporal_minus_context",
    "singing_minus_context",
    "music_minus_context",
    "speech_minus_context",
    "rms_minus_context",
    "prev_temporal_mean",
    "next_temporal_mean",
    "prev_singing_mean",
    "next_singing_mean",
    "prev_music_only_like_ratio",
    "next_music_only_like_ratio",
    "source_offline_final",
    "source_live_pcm30",
    "source_live_aed60",
]

PROFILE_STEMS = {
    "offline-final": "threshold_window_advisor_offline_final",
    "live-pcm30": "threshold_window_advisor_live_pcm30",
    "live-realtime-aed60": "threshold_window_advisor_live_aed60",
}


@dataclass
class Example:
    video: str
    center_sec: float
    feature: List[float]
    target_delta: float
    confidence: float
    weight: float
    reason: str


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Train threshold_window_advisor ONNX candidates.")
    parser.add_argument("--batch-summary", nargs="*", type=Path, required=True)
    parser.add_argument("--out-dir", type=Path, default=Path("training_runs/threshold_window_advisor_offline_candidate"))
    parser.add_argument("--install-dir", type=Path, default=None)
    parser.add_argument("--profile", choices=sorted(PROFILE_STEMS), default="offline-final")
    parser.add_argument("--window-sec", type=float, default=30.0)
    parser.add_argument("--window-hop-sec", type=float, default=5.0)
    parser.add_argument("--stable-hop-sec", type=float, default=15.0)
    parser.add_argument("--neutral-hop-sec", type=float, default=60.0)
    parser.add_argument("--issue-padding-sec", type=float, default=60.0)
    parser.add_argument("--context-sec", type=float, default=120.0)
    parser.add_argument("--delta-min", type=float, default=-0.08)
    parser.add_argument("--delta-max", type=float, default=0.10)
    parser.add_argument("--min-confidence", type=float, default=0.35)
    parser.add_argument("--neutral-weight", type=float, default=0.15)
    parser.add_argument("--stable-weight", type=float, default=0.6)
    parser.add_argument("--issue-weight", type=float, default=6.0)
    parser.add_argument("--min-train-manual-duration-sec", type=float, default=90.0)
    parser.add_argument("--epochs", type=int, default=180)
    parser.add_argument("--learning-rate", type=float, default=1e-3)
    parser.add_argument("--weight-decay", type=float, default=1e-4)
    parser.add_argument("--seed", type=int, default=20260601)
    parser.add_argument("--device", choices=["auto", "cpu", "cuda"], default="auto")
    return parser.parse_args()


def finite(value: object, fallback: float = 0.0) -> float:
    try:
        num = float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return fallback
    return num if math.isfinite(num) else fallback


def probability(value: object, fallback: float = 0.0) -> float:
    return min(1.0, max(0.0, finite(value, fallback)))


def mean(values: Sequence[float]) -> float:
    return float(sum(values) / len(values)) if values else 0.0


def std(values: Sequence[float]) -> float:
    if len(values) < 2:
        return 0.0
    avg = mean(values)
    return math.sqrt(mean([(value - avg) ** 2 for value in values]))


def quantile(values: Sequence[float], ratio: float) -> float:
    if not values:
        return 0.0
    arr = sorted(float(value) for value in values)
    pos = (len(arr) - 1) * min(1.0, max(0.0, ratio))
    base = int(math.floor(pos))
    rest = pos - base
    if base + 1 >= len(arr):
        return arr[base]
    return arr[base] + ((arr[base + 1] - arr[base]) * rest)


def ratio(items: Sequence[Dict[str, object]], predicate) -> float:
    if not items:
        return 0.0
    return sum(1 for item in items if predicate(item)) / len(items)


def normalize_frames(frames: Sequence[Dict[str, object]]) -> List[Dict[str, object]]:
    output = []
    for frame in frames:
        time_sec = finite(frame.get("timeSec"), float("nan"))
        if not math.isfinite(time_sec):
            continue
        output.append({**frame, "timeSec": time_sec})
    return sorted(output, key=lambda item: float(item["timeSec"]))


def frame_value(frame: Dict[str, object], primary: str, fallback: str = "") -> float:
    return probability(frame.get(primary, frame.get(fallback) if fallback else 0.0))


def frame_threshold(frame: Dict[str, object]) -> float:
    return probability(frame.get("temporalHeadThreshold"), 0.75)


def frames_in_range(frames: Sequence[Dict[str, object]], start_sec: float, end_sec: float) -> List[Dict[str, object]]:
    return [frame for frame in frames if start_sec <= finite(frame.get("timeSec")) < end_sec]


def summarize_frames(frames: Sequence[Dict[str, object]]) -> Dict[str, float]:
    temporal = [probability(frame.get("temporalHeadProbability", frame.get("songProbability"))) for frame in frames]
    thresholds = [frame_threshold(frame) for frame in frames]
    singing = [frame_value(frame, "singingProbability", "singingMean") for frame in frames]
    music = [frame_value(frame, "musicProbability", "musicMean") for frame in frames]
    speech = [frame_value(frame, "speechProbability", "speechMean") for frame in frames]
    singing_ratio = [probability(frame.get("singingRatio")) for frame in frames]
    music_ratio = [probability(frame.get("musicRatio")) for frame in frames]
    speech_ratio = [probability(frame.get("speechRatio")) for frame in frames]
    rms = [max(0.0, finite(frame.get("audioRms"))) for frame in frames]
    peak = [max(0.0, finite(frame.get("audioPeak"))) for frame in frames]
    flatness = [probability(frame.get("spectralFlatness")) for frame in frames]
    flux = [probability(frame.get("spectralFlux")) for frame in frames]
    low_energy = [probability(frame.get("lowEnergyRatio")) for frame in frames]
    mid_energy = [probability(frame.get("midEnergyRatio")) for frame in frames]
    high_energy = [probability(frame.get("highEnergyRatio")) for frame in frames]
    threshold_mean = mean(thresholds) or 0.75
    return {
        "frameCount": float(len(frames)),
        "temporalMean": mean(temporal),
        "temporalP10": quantile(temporal, 0.1),
        "temporalP50": quantile(temporal, 0.5),
        "temporalP90": quantile(temporal, 0.9),
        "temporalStd": std(temporal),
        "temporalAboveThresholdRatio": ratio(frames, lambda frame: probability(frame.get("temporalHeadProbability", frame.get("songProbability"))) >= threshold_mean),
        "singingMean": mean(singing),
        "singingP50": quantile(singing, 0.5),
        "singingP90": quantile(singing, 0.9),
        "singingRatioMean": mean(singing_ratio),
        "singingRatioP90": quantile(singing_ratio, 0.9),
        "musicMean": mean(music),
        "musicP50": quantile(music, 0.5),
        "musicP90": quantile(music, 0.9),
        "musicRatioMean": mean(music_ratio),
        "musicRatioP90": quantile(music_ratio, 0.9),
        "speechMean": mean(speech),
        "speechP50": quantile(speech, 0.5),
        "speechP90": quantile(speech, 0.9),
        "speechRatioMean": mean(speech_ratio),
        "speechRatioP90": quantile(speech_ratio, 0.9),
        "audioRmsMean": mean(rms),
        "audioRmsP90": quantile(rms, 0.9),
        "audioPeakMean": mean(peak),
        "audioPeakP90": quantile(peak, 0.9),
        "spectralFlatnessMean": mean(flatness),
        "spectralFlatnessP90": quantile(flatness, 0.9),
        "spectralFluxMean": mean(flux),
        "spectralFluxP90": quantile(flux, 0.9),
        "lowEnergyRatioMean": mean(low_energy),
        "midEnergyRatioMean": mean(mid_energy),
        "highEnergyRatioMean": mean(high_energy),
        "strictSilenceRatio": ratio(frames, lambda frame: finite(frame.get("audioRms"), 1.0) <= 0.0045 and finite(frame.get("audioPeak"), 1.0) <= 0.018),
        "lowEnergyFrameRatio": ratio(frames, lambda frame: finite(frame.get("audioRms"), 1.0) <= 0.006 or finite(frame.get("audioPeak"), 1.0) <= 0.025 or probability(frame.get("lowEnergyRatio")) >= 0.72),
        "musicOnlyLikeRatio": ratio(frames, lambda frame: (
            frame_value(frame, "musicProbability", "musicMean") >= 0.58
            and frame_value(frame, "singingProbability", "singingMean") <= 0.28
            and frame_value(frame, "speechProbability", "speechMean") <= 0.42
            and probability(frame.get("temporalHeadProbability", frame.get("songProbability"))) <= 0.52
        )),
        "vocalLikeRatio": ratio(frames, lambda frame: (
            frame_value(frame, "singingProbability", "singingMean") >= 0.4
            or probability(frame.get("temporalHeadProbability", frame.get("songProbability"))) >= 0.55
        )),
        "speechLikeRatio": ratio(frames, lambda frame: (
            frame_value(frame, "speechProbability", "speechMean") >= 0.58
            and frame_value(frame, "singingProbability", "singingMean") <= 0.38
        )),
    }


def build_feature_vector(frames: Sequence[Dict[str, object]], center_sec: float, args: argparse.Namespace) -> List[float]:
    half_window = args.window_sec / 2.0
    half_context = args.context_sec / 2.0
    first_sec = finite(frames[0].get("timeSec")) if frames else 0.0
    last_sec = finite(frames[-1].get("timeSec"), first_sec) if frames else first_sec
    duration = max(0.001, last_sec - first_sec)
    start_sec = center_sec - half_window
    end_sec = center_sec + half_window
    window = summarize_frames(frames_in_range(frames, start_sec, end_sec))
    context_frames = frames_in_range(frames, center_sec - half_context, center_sec + half_context)
    context = summarize_frames(context_frames or frames_in_range(frames, start_sec, end_sec))
    prev_stats = summarize_frames(frames_in_range(frames, center_sec - args.context_sec, start_sec))
    next_stats = summarize_frames(frames_in_range(frames, end_sec, center_sec + args.context_sec))
    profile = args.profile
    return [
        args.window_sec,
        window["frameCount"],
        min(1.0, max(0.0, (center_sec - first_sec) / duration)),
        window["temporalMean"],
        window["temporalP10"],
        window["temporalP50"],
        window["temporalP90"],
        window["temporalStd"],
        window["temporalAboveThresholdRatio"],
        window["singingMean"],
        window["singingP50"],
        window["singingP90"],
        window["singingRatioMean"],
        window["singingRatioP90"],
        window["musicMean"],
        window["musicP50"],
        window["musicP90"],
        window["musicRatioMean"],
        window["musicRatioP90"],
        window["speechMean"],
        window["speechP50"],
        window["speechP90"],
        window["speechRatioMean"],
        window["speechRatioP90"],
        window["audioRmsMean"],
        window["audioRmsP90"],
        window["audioPeakMean"],
        window["audioPeakP90"],
        window["spectralFlatnessMean"],
        window["spectralFlatnessP90"],
        window["spectralFluxMean"],
        window["spectralFluxP90"],
        window["lowEnergyRatioMean"],
        window["midEnergyRatioMean"],
        window["highEnergyRatioMean"],
        window["strictSilenceRatio"],
        window["lowEnergyFrameRatio"],
        window["musicOnlyLikeRatio"],
        window["vocalLikeRatio"],
        window["speechLikeRatio"],
        window["musicMean"] - window["singingMean"],
        window["musicMean"] - window["speechMean"],
        window["temporalMean"] - context["temporalMean"],
        window["singingMean"] - context["singingMean"],
        window["musicMean"] - context["musicMean"],
        window["speechMean"] - context["speechMean"],
        window["audioRmsMean"] - context["audioRmsMean"],
        prev_stats["temporalMean"],
        next_stats["temporalMean"],
        prev_stats["singingMean"],
        next_stats["singingMean"],
        prev_stats["musicOnlyLikeRatio"],
        next_stats["musicOnlyLikeRatio"],
        1.0 if profile == "offline-final" else 0.0,
        1.0 if profile == "live-pcm30" else 0.0,
        1.0 if profile == "live-realtime-aed60" else 0.0,
    ]


def parse_time_sec(value: object) -> float:
    text = str(value or "").strip()
    if not text:
        return 0.0
    parts = [part.strip() for part in text.split(":")]
    try:
        if len(parts) == 3:
            return max(0.0, (float(parts[0]) * 3600.0) + (float(parts[1]) * 60.0) + float(parts[2]))
        if len(parts) == 2:
            return max(0.0, (float(parts[0]) * 60.0) + float(parts[1]))
        return max(0.0, float(text))
    except ValueError:
        return 0.0


def load_manual(path: Path) -> List[Dict[str, object]]:
    output = []
    if not path.exists():
        return output
    for line in path.read_text(encoding="utf-8").splitlines():
        text = line.strip()
        if not text or text.startswith("#"):
            continue
        parts = text.split()
        if len(parts) < 2:
            continue
        start = parse_time_sec(parts[0])
        end = parse_time_sec(parts[1])
        if end > start:
            output.append({"startSec": start, "endSec": end, "title": " ".join(parts[2:])})
    return sorted(output, key=lambda item: float(item["startSec"]))


def overlap_seconds(start_a: float, end_a: float, start_b: float, end_b: float) -> float:
    return max(0.0, min(end_a, end_b) - max(start_a, start_b))


def range_ratio(start_sec: float, end_sec: float, segments: Sequence[Dict[str, object]]) -> float:
    duration = max(0.001, end_sec - start_sec)
    overlap = 0.0
    for segment in segments:
        overlap += overlap_seconds(start_sec, end_sec, finite(segment.get("startSec")), finite(segment.get("endSec")))
    return min(1.0, overlap / duration)


def raw_positive_ratio(frames: Sequence[Dict[str, object]]) -> float:
    if not frames:
        return 0.0
    positives = 0
    for frame in frames:
        threshold = frame_threshold(frame)
        if probability(frame.get("temporalHeadProbability", frame.get("songProbability"))) >= threshold:
            positives += 1
    return positives / len(frames)


def long_manual_segments(manual: Sequence[Dict[str, object]], min_duration: float) -> List[Dict[str, object]]:
    return [
        segment
        for segment in manual
        if finite(segment.get("endSec")) - finite(segment.get("startSec")) >= min_duration
    ]


def add_signal(signals: List[Tuple[float, float, str]], delta: float, weight: float, reason: str) -> None:
    signals.append((delta, weight, reason))


def outlier_signal_for_window(center_sec: float, outliers: Sequence[Dict[str, object]], args: argparse.Namespace) -> Optional[Tuple[float, float, str]]:
    best: Optional[Tuple[float, float, str]] = None
    for outlier in outliers:
        if not isinstance(outlier, dict):
            continue
        kind = str(outlier.get("type") or "")
        manual = outlier.get("manual") if isinstance(outlier.get("manual"), dict) else {}
        predicted = outlier.get("predicted") if isinstance(outlier.get("predicted"), dict) else {}
        manual_start = finite(manual.get("startSec"))
        manual_end = finite(manual.get("endSec"))
        pred_start = finite(predicted.get("startSec"), manual_start)
        pred_end = finite(predicted.get("endSec"), manual_end)
        manual_duration = manual_end - manual_start
        if 0 < manual_duration < args.min_train_manual_duration_sec:
            continue

        signal: Optional[Tuple[float, float, str]] = None
        if kind in {"early-start", "early-start-rehearsal"} and pred_start <= center_sec <= manual_start:
            signal = (0.08, args.issue_weight, kind)
        elif kind in {"late-end", "late-end-bgm"} and manual_end <= center_sec <= pred_end:
            signal = (0.08, args.issue_weight, kind)
        elif kind in {"late-start", "low-recall"} and manual_start <= center_sec <= min(manual_end, pred_start + 45.0):
            signal = (-0.08, args.issue_weight, kind)
        elif kind in {"early-end", "early-end-speech-like"} and max(manual_start, pred_end - 10.0) <= center_sec <= manual_end:
            signal = (-0.08, args.issue_weight, kind)
        elif kind in {"missed-segment", "acapella-risk"} and manual_start <= center_sec <= manual_end:
            signal = (-0.08, args.issue_weight, kind)
        elif kind in {"merged-close-songs"}:
            if pred_start <= center_sec <= pred_end and not (manual_start <= center_sec <= manual_end):
                signal = (0.10, args.issue_weight * 1.4, kind)

        if signal is not None and (best is None or signal[1] > best[1]):
            best = signal
    return best


def build_examples_from_video(item: Dict[str, object], args: argparse.Namespace) -> List[Example]:
    frames_path = Path(str(item.get("framesPath") or ""))
    if not frames_path.exists():
        return []
    frames_payload = json.loads(frames_path.read_text(encoding="utf-8"))
    frames = normalize_frames(frames_payload.get("frames", []) if isinstance(frames_payload, dict) else [])
    if len(frames) < 20:
        return []
    manual_path = Path(str(item.get("manualPath") or ""))
    manual = long_manual_segments(load_manual(manual_path), args.min_train_manual_duration_sec)
    if not manual:
        return []
    summary_path = Path(str(item.get("segmentFilterSummaryPath") or item.get("summaryPath") or ""))
    summary = json.loads(summary_path.read_text(encoding="utf-8")) if summary_path.exists() else {}
    predicted = summary.get("segments") if isinstance(summary.get("segments"), list) else []
    outliers = item.get("severeOutliers") if isinstance(item.get("severeOutliers"), list) else []
    first_sec = finite(frames[0].get("timeSec"))
    last_sec = finite(frames[-1].get("timeSec"), first_sec)
    examples: List[Example] = []
    centers = set()

    def add_center_range(start_sec: float, end_sec: float, step_sec: float) -> None:
        start_sec = max(first_sec, start_sec)
        end_sec = min(last_sec, end_sec)
        if end_sec < start_sec:
            return
        cursor = start_sec
        while cursor <= end_sec + 0.001:
            centers.add(round(cursor / args.window_hop_sec) * args.window_hop_sec)
            cursor += max(0.5, step_sec)

    # Dense samples around known problem regions, moderate samples inside songs,
    # and sparse neutral samples elsewhere keep training fast without losing
    # local outlier supervision.
    for outlier in outliers:
        if not isinstance(outlier, dict):
            continue
        manual_obj = outlier.get("manual") if isinstance(outlier.get("manual"), dict) else {}
        predicted_obj = outlier.get("predicted") if isinstance(outlier.get("predicted"), dict) else {}
        start = min(finite(manual_obj.get("startSec"), last_sec), finite(predicted_obj.get("startSec"), last_sec))
        end = max(finite(manual_obj.get("endSec"), first_sec), finite(predicted_obj.get("endSec"), first_sec))
        add_center_range(start - args.issue_padding_sec, end + args.issue_padding_sec, args.window_hop_sec)

    for segment in manual:
        add_center_range(finite(segment.get("startSec")), finite(segment.get("endSec")), args.stable_hop_sec)

    add_center_range(first_sec, last_sec, args.neutral_hop_sec)

    for center in sorted(value for value in centers if first_sec <= value <= last_sec):
        start = center - (args.window_sec / 2.0)
        end = center + (args.window_sec / 2.0)
        window_frames = frames_in_range(frames, start, end)
        if len(window_frames) < 4:
            continue
        manual_ratio = range_ratio(start, end, manual)
        predicted_ratio = range_ratio(start, end, predicted)
        raw_ratio = raw_positive_ratio(window_frames)
        stats = summarize_frames(window_frames)
        signals: List[Tuple[float, float, str]] = []
        outlier_signal = outlier_signal_for_window(center, outliers, args)
        if outlier_signal is not None:
            add_signal(signals, *outlier_signal)
        elif manual_ratio >= 0.55:
            if predicted_ratio < 0.45 or raw_ratio < 0.42:
                add_signal(signals, -0.055, args.stable_weight * 2.0, "manual-song-low-model")
            elif stats["vocalLikeRatio"] >= 0.45 and stats["temporalAboveThresholdRatio"] < 0.45:
                add_signal(signals, -0.035, args.stable_weight, "vocal-low-threshold")
        elif manual_ratio <= 0.15:
            if predicted_ratio > 0.35 or raw_ratio > 0.55:
                delta = 0.075 if stats["musicOnlyLikeRatio"] >= 0.25 or stats["speechLikeRatio"] >= 0.25 else 0.045
                add_signal(signals, delta, args.stable_weight * 2.0, "non-song-positive")
            elif stats["musicOnlyLikeRatio"] >= 0.35:
                add_signal(signals, 0.04, args.stable_weight, "music-only-context")

        if signals:
            total_weight = sum(weight for _, weight, _ in signals)
            target = sum(delta * weight for delta, weight, _ in signals) / max(1e-6, total_weight)
            weight = max(weight for _, weight, _ in signals)
            reason = "|".join(sorted({reason for _, _, reason in signals}))
            confidence = 0.82
        else:
            target = 0.0
            weight = args.neutral_weight
            reason = "neutral"
            confidence = 0.22
        target = min(args.delta_max, max(args.delta_min, target))
        examples.append(Example(
            video=str(item.get("video") or ""),
            center_sec=center,
            feature=build_feature_vector(frames, center, args),
            target_delta=target,
            confidence=confidence,
            weight=weight,
            reason=reason,
        ))
    return examples


class ThresholdWindowAdvisorNet(nn.Module):
    def __init__(self, input_dim: int, feature_mean: np.ndarray, feature_std: np.ndarray, delta_min: float, delta_max: float) -> None:
        super().__init__()
        self.register_buffer("feature_mean", torch.tensor(feature_mean.tolist(), dtype=torch.float32))
        self.register_buffer("feature_std", torch.tensor(feature_std.tolist(), dtype=torch.float32))
        self.register_buffer("delta_center", torch.tensor([(delta_min + delta_max) / 2.0], dtype=torch.float32))
        self.register_buffer("delta_half_range", torch.tensor([(delta_max - delta_min) / 2.0], dtype=torch.float32))
        self.net = nn.Sequential(
            nn.Linear(input_dim, 64),
            nn.ReLU(),
            nn.Dropout(0.06),
            nn.Linear(64, 32),
            nn.ReLU(),
        )
        self.delta_head = nn.Linear(32, 1)
        self.confidence_head = nn.Linear(32, 1)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        z = (x - self.feature_mean) / self.feature_std.clamp_min(1e-6)
        hidden = self.net(z)
        delta = self.delta_center + (torch.tanh(self.delta_head(hidden)) * self.delta_half_range)
        confidence = torch.sigmoid(self.confidence_head(hidden))
        return torch.cat([delta, confidence], dim=1)


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
        all_indices = list(range(len(examples)))
        return all_indices, all_indices
    return train, val


def evaluate(model: ThresholdWindowAdvisorNet, x: torch.Tensor, y: torch.Tensor, indices: Sequence[int]) -> Dict[str, float]:
    if not indices:
        return {"mse": 0.0, "deltaMae": 0.0, "confidenceMae": 0.0}
    with torch.no_grad():
        idx = torch.as_tensor(indices, dtype=torch.long, device=x.device)
        pred = model(x[idx])
        target = y[idx]
        diff = torch.abs(pred - target)
        return {
            "mse": float(torch.mean((pred - target) ** 2).item()),
            "deltaMae": float(torch.mean(diff[:, 0]).item()),
            "confidenceMae": float(torch.mean(diff[:, 1]).item()),
        }


def train(args: argparse.Namespace, examples: Sequence[Example]) -> Tuple[ThresholdWindowAdvisorNet, Dict[str, object]]:
    if not examples:
        raise RuntimeError("No threshold window advisor examples were built.")
    torch.manual_seed(args.seed)
    np.random.seed(args.seed)
    x_np = np.asarray([example.feature for example in examples], dtype=np.float32)
    y_np = np.asarray([[example.target_delta, example.confidence] for example in examples], dtype=np.float32)
    weights_np = np.asarray([max(0.01, example.weight) for example in examples], dtype=np.float32)
    train_indices, val_indices = split_indices(examples, args.seed)
    feature_mean = x_np[train_indices].mean(axis=0)
    feature_std = np.maximum(x_np[train_indices].std(axis=0), 1e-6)
    device = choose_device(args.device)
    x = torch.tensor(x_np.tolist(), dtype=torch.float32, device=device)
    y = torch.tensor(y_np.tolist(), dtype=torch.float32, device=device)
    weights = torch.tensor(weights_np.tolist(), dtype=torch.float32, device=device)
    model = ThresholdWindowAdvisorNet(x.shape[1], feature_mean, feature_std, args.delta_min, args.delta_max).to(device)
    optimizer = torch.optim.AdamW(model.parameters(), lr=args.learning_rate, weight_decay=args.weight_decay)
    train_tensor = torch.as_tensor(train_indices, dtype=torch.long, device=device)
    best_state = None
    best_val = float("inf")
    for epoch in range(max(1, args.epochs)):
        model.train()
        optimizer.zero_grad(set_to_none=True)
        pred = model(x[train_tensor])
        target = y[train_tensor]
        sample_weights = weights[train_tensor]
        sample_weights = sample_weights / sample_weights.mean().clamp_min(1e-6)
        delta_loss = torch.mean(((pred[:, 0] - target[:, 0]) ** 2) * sample_weights)
        confidence_loss = torch.mean(((pred[:, 1] - target[:, 1]) ** 2) * sample_weights)
        loss = delta_loss + (0.15 * confidence_loss)
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


def reason_counts(examples: Sequence[Example]) -> Dict[str, int]:
    counts: Dict[str, int] = {}
    for example in examples:
        for reason in example.reason.split("|"):
            counts[reason] = counts.get(reason, 0) + 1
    return dict(sorted(counts.items()))


def export_model(args: argparse.Namespace, model: ThresholdWindowAdvisorNet, examples: Sequence[Example], metrics: Dict[str, object]) -> None:
    args.out_dir.mkdir(parents=True, exist_ok=True)
    stem = PROFILE_STEMS[args.profile]
    onnx_path = args.out_dir / f"{stem}.onnx"
    meta_path = args.out_dir / f"{stem}.meta.json"
    pt_path = args.out_dir / f"{stem}.pt"
    metadata = {
        "version": "threshold-window-advisor-v1",
        "assetProfile": args.profile,
        "profile": args.profile,
        "inputName": "threshold_window_features",
        "outputName": "threshold_window_outputs",
        "inputDim": len(FEATURE_NAMES),
        "featureNames": FEATURE_NAMES,
        "windowSec": args.window_sec,
        "windowHopSec": args.window_hop_sec,
        "contextSec": args.context_sec,
        "deltaMin": args.delta_min,
        "deltaMax": args.delta_max,
        "minConfidence": args.min_confidence,
        "smoothingPasses": 2,
        "trainingSummary": {
            "exampleCount": len(examples),
            "videos": sorted({example.video for example in examples}),
            "reasonCounts": reason_counts(examples),
            "metrics": metrics,
        },
    }
    torch.save({"state_dict": model.state_dict(), "metadata": metadata}, pt_path)
    dummy = torch.zeros(1, len(FEATURE_NAMES), dtype=torch.float32)
    torch.onnx.export(
        model,
        dummy,
        onnx_path,
        input_names=["threshold_window_features"],
        output_names=["threshold_window_outputs"],
        dynamic_axes={"threshold_window_features": {0: "batch"}, "threshold_window_outputs": {0: "batch"}},
        opset_version=17,
    )
    meta_path.write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8")
    (args.out_dir / "training_examples.json").write_text(
        json.dumps([example.__dict__ for example in examples], ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    if args.install_dir:
        args.install_dir.mkdir(parents=True, exist_ok=True)
        shutil.copy2(onnx_path, args.install_dir / onnx_path.name)
        shutil.copy2(meta_path, args.install_dir / meta_path.name)
    print(f"[threshold-window-advisor] wrote {onnx_path}")
    print(f"[threshold-window-advisor] wrote {meta_path}")


def main() -> None:
    args = parse_args()
    examples: List[Example] = []
    for summary_path in args.batch_summary:
        payload = json.loads(summary_path.read_text(encoding="utf-8"))
        for item in payload.get("videos", []):
            if isinstance(item, dict):
                examples.extend(build_examples_from_video(item, args))
    model, metrics = train(args, examples)
    export_model(args, model, examples, metrics)


if __name__ == "__main__":
    main()
