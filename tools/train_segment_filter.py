"""Train the experimental segment-level keep/drop and trim advisor.

The model is intentionally small and only operates after global smoothing. It
uses predicted segments plus cached AED/stat frames to decide whether each
segment should be kept and how much its start/end should move.
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import re
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
    build_segment_filter_feature_vector,
    frames_in_range,
    mean,
    normalize_frames,
    overlap_seconds,
    quantile,
    values,
)

TRAINING_PROFILES = {
    "offline-final": {
        "defaultSummaryGlobs": ["video_*.smoothing_summary.json"],
        "intendedRuntime": "Offline Workbench final smoothing with full-audio context.",
        "evaluation": "Use evaluate_smoothing_batch.py on multi-song offline samples.",
    },
    "live-pcm30": {
        "defaultSummaryGlobs": ["*_pcm_filter_off.json"],
        "intendedRuntime": "Live 30-minute PCM rollover finalization candidates.",
        "evaluation": "Use tools/live/run_live_pcm_ab_samples.mjs with pcm-current and pcm-candidate-model.",
    },
    "live-realtime-aed60": {
        "defaultSummaryGlobs": ["*_aed60_filter_off.json"],
        "intendedRuntime": "Realtime 60-second AED cache finalization candidates.",
        "evaluation": "Use tools/live/run_live_pcm_ab_samples.mjs with aed60-current and aed60-candidate-model.",
    },
}

PROFILE_ASSET_SUFFIX = {
    "default": "",
    "offline-final": "offline_final",
    "live-pcm30": "live_pcm30",
    "live-realtime-aed60": "live_aed60",
}


@dataclass
class Example:
    video: str
    segment_index: int
    source: str
    features: List[float]
    keep: float
    start_delta: float
    end_delta: float
    overlap_sec: float
    recall_ratio: float
    precision_ratio: float
    extra_sec: float


class NormalizedMlp(nn.Module):
    def __init__(self, input_dim: int, feature_mean: np.ndarray, feature_std: np.ndarray) -> None:
        super().__init__()
        self.register_buffer("feature_mean", torch.tensor(feature_mean.tolist(), dtype=torch.float32))
        self.register_buffer("feature_std", torch.tensor(feature_std.tolist(), dtype=torch.float32))
        self.encoder = nn.Sequential(
            nn.Linear(input_dim, 48),
            nn.ReLU(),
            nn.Dropout(0.08),
            nn.Linear(48, 24),
            nn.ReLU(),
        )

    def _encoded(self, x: torch.Tensor) -> torch.Tensor:
        z = (x - self.feature_mean) / self.feature_std.clamp_min(1e-6)
        return self.encoder(z)


class SegmentKeepNet(NormalizedMlp):
    def __init__(self, input_dim: int, feature_mean: np.ndarray, feature_std: np.ndarray) -> None:
        super().__init__(input_dim, feature_mean, feature_std)
        self.keep_head = nn.Linear(24, 1)

    def raw_outputs(self, x: torch.Tensor) -> torch.Tensor:
        h = self._encoded(x)
        return self.keep_head(h).squeeze(-1)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return torch.sigmoid(self.raw_outputs(x)).unsqueeze(-1)


class EdgeTrimAdvisorNet(NormalizedMlp):
    def __init__(self, input_dim: int, feature_mean: np.ndarray, feature_std: np.ndarray, trim_clamp_sec: float) -> None:
        super().__init__(input_dim, feature_mean, feature_std)
        self.trim_clamp_sec = float(trim_clamp_sec)
        self.delta_head = nn.Linear(24, 2)

    def raw_outputs(self, x: torch.Tensor) -> torch.Tensor:
        return torch.tanh(self.delta_head(self._encoded(x))) * self.trim_clamp_sec

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.raw_outputs(x)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Train segment filter / trim advisor from smoothing batch outputs.")
    parser.add_argument("--batch-dir", type=Path, default=Path("training_runs/smoothing_eval_v8_jinbee/batch"))
    parser.add_argument("--out-dir", type=Path, default=Path("training_runs/segment_filter_v1"))
    parser.add_argument("--install-dir", type=Path, default=None, help="Optional model asset destination, e.g. models/fireredvad/aed.")
    parser.add_argument(
        "--install-mode",
        choices=["default", "profile", "both"],
        default="default",
        help=(
            "How --install-dir writes assets. default preserves existing segment_filter.* names; "
            "profile writes profile-specific names such as segment_filter_live_pcm30.*; both writes both."
        ),
    )
    parser.add_argument(
        "--write-profile-assets",
        action="store_true",
        help="Also copy exported models in --out-dir to profile-specific filenames for manual inspection.",
    )
    parser.add_argument(
        "--training-profile",
        choices=sorted(TRAINING_PROFILES.keys()),
        default="offline-final",
        help="Records the intended runtime/evaluation profile and selects a default summary glob.",
    )
    parser.add_argument(
        "--summary-glob",
        nargs="*",
        default=None,
        help="Summary file glob(s) under --batch-dir. Defaults depend on --training-profile.",
    )
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
    parser.add_argument("--post-end-negative-start-sec", type=float, default=0.5)
    parser.add_argument("--post-end-negative-end-sec", type=float, default=14.0)
    parser.add_argument("--post-end-negative-min-duration-sec", type=float, default=2.0)
    parser.add_argument(
        "--disable-post-end-negative-song-evidence-skip",
        action="store_true",
        help=(
            "Disable the conservative guard that skips manual post-end negatives "
            "when the sampled tail still contains strong song/singing evidence."
        ),
    )
    parser.add_argument(
        "--hard-negative-annotations",
        type=Path,
        default=Path("tools/segment_filter_hard_negatives.csv"),
        help=(
            "Optional CSV with confirmed non-song segment candidates for the segment filter. "
            "Columns: video,start_sec,end_sec,reason. Missing file is ignored."
        ),
    )
    parser.add_argument("--hard-negative-min-duration-sec", type=float, default=5.0)
    parser.add_argument("--hard-negative-overlap-skip-sec", type=float, default=0.5)
    parser.add_argument("--hard-negative-subwindow-sec", type=float, default=60.0)
    parser.add_argument("--hard-negative-subwindow-hop-sec", type=float, default=30.0)
    parser.add_argument(
        "--ignore-range-overlap-skip-sec",
        type=float,
        default=0.5,
        help=(
            "Skip candidate training examples that overlap summary/sample ignoreRanges by at least this many seconds. "
            "Use this for intentionally omitted partial songs so they are not treated as negatives."
        ),
    )
    parser.add_argument(
        "--disable-ambiguous-unmatched-skip",
        action="store_true",
        help=(
            "Disable skipping unmatched auto candidates that are strongly song-like. "
            "Keep this enabled when manual labels may intentionally omit incomplete songs."
        ),
    )
    parser.add_argument("--ambiguous-unmatched-min-duration-sec", type=float, default=45.0)
    parser.add_argument("--ambiguous-unmatched-temporal-mean", type=float, default=0.78)
    parser.add_argument("--ambiguous-unmatched-music-mean", type=float, default=0.82)
    parser.add_argument("--ambiguous-unmatched-singing-mean", type=float, default=0.45)
    parser.add_argument("--ambiguous-unmatched-singing-p90", type=float, default=0.88)
    parser.add_argument("--ambiguous-unmatched-speech-mean-max", type=float, default=0.30)
    parser.add_argument(
        "--disable-live-tail-song-target-guard",
        action="store_true",
        help=(
            "Disable live-profile end-trim target protection. By default, live profiles avoid "
            "training large negative end trims through tails that still look strongly song-like."
        ),
    )
    parser.add_argument("--tail-song-guard-min-trim-sec", type=float, default=8.0)
    parser.add_argument("--tail-song-guard-max-protected-trim-sec", type=float, default=12.0)
    parser.add_argument("--tail-song-guard-temporal-mean", type=float, default=0.50)
    parser.add_argument("--tail-song-guard-temporal-p90", type=float, default=0.72)
    parser.add_argument("--tail-song-guard-singing-mean", type=float, default=0.30)
    parser.add_argument("--tail-song-guard-singing-p90", type=float, default=0.70)
    parser.add_argument("--tail-song-guard-speech-mean", type=float, default=0.58)
    parser.add_argument("--tail-song-guard-low-energy-mean", type=float, default=0.72)
    parser.add_argument(
        "--live-edge-trim-scale",
        type=float,
        default=None,
        help=(
            "Optional trimScale metadata for live-profile edge advisor candidates. "
            "This does not change model weights; it controls runtime trim magnitude."
        ),
    )
    parser.add_argument(
        "--live-final-keep-threshold",
        type=float,
        default=None,
        help=(
            "Optional live finalization keep threshold metadata. If omitted, live "
            "profiles record the validation bestThreshold and must still pass live A/B."
        ),
    )
    parser.add_argument(
        "--edge-end-overtrim-weight",
        type=float,
        default=1.0,
        help=(
            "Loss multiplier when the edge advisor predicts an end trim earlier than the target. "
            "Values above 1 bias the model against cutting song endings too early."
        ),
    )
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


def infer_video_key_from_summary_path(path: Path) -> str:
    name = path.name
    for marker in (
        "_pcm_filter_off",
        "_pcm_filter_on",
        "_pcm_candidate_model",
        "_aed60_filter_off",
        "_aed60_overlap60",
        "_aed60_candidate_model",
        ".smoothing_summary.json",
    ):
        if marker in name:
            return name.split(marker)[0]
    match = re.search(r"(video_\d+(?:_[A-Za-z0-9]+)*)", name)
    if match:
        return match.group(1)
    return name.split(".")[0]


def resolved_summary_globs(args: argparse.Namespace) -> List[str]:
    globs = args.summary_glob
    if globs is None or not globs:
        globs = TRAINING_PROFILES[args.training_profile]["defaultSummaryGlobs"]
    return [str(item) for item in globs if str(item).strip()]


def summary_paths(args: argparse.Namespace) -> List[Path]:
    seen = set()
    output: List[Path] = []
    for pattern in resolved_summary_globs(args):
        for path in sorted(args.batch_dir.glob(pattern)):
            if ".segment_filter" in path.name:
                continue
            resolved = path.resolve()
            if resolved in seen:
                continue
            seen.add(resolved)
            output.append(path)
    return output


def resolve_existing_path(raw: object, summary_path: Path) -> Optional[Path]:
    if raw is None:
        return None
    path = Path(str(raw))
    candidates = [path]
    if not path.is_absolute():
        candidates = [Path.cwd() / path, summary_path.parent / path]
    for candidate in candidates:
        if candidate.exists():
            return candidate
    return None


def load_frames_for_summary(args: argparse.Namespace, summary: Dict[str, object], summary_path: Path, video: str) -> Tuple[List[Dict[str, object]], Dict[str, object]]:
    embedded = summary.get("frames")
    if isinstance(embedded, list):
        return embedded, {"durationSec": summary.get("analyzedEndSec") or summary.get("endSec") or 0.0, "framesEmbedded": True}

    frame_ref = (
        summary.get("framesPath")
        or summary.get("frames_path")
        or summary.get("framePath")
        or (embedded if isinstance(embedded, str) else None)
    )
    frames_path = resolve_existing_path(frame_ref, summary_path)
    if frames_path is None:
        frames_path = args.batch_dir / f"{video}.frames.json"
    if not frames_path.exists():
        raise FileNotFoundError(
            f"{summary_path}: frame data not found. "
            "For live-profile training, run tools/live/run_live_pcm_ab_samples.mjs with --include-frames."
        )
    frames_payload = load_json(frames_path)
    if isinstance(frames_payload, dict):
        frames = frames_payload.get("frames", [])
    else:
        frames = frames_payload
        frames_payload = {"frames": frames}
    return frames if isinstance(frames, list) else [], frames_payload if isinstance(frames_payload, dict) else {}


def normalize_range(raw: object) -> Optional[Dict[str, object]]:
    if isinstance(raw, dict):
        start = parse_time_sec(
            raw.get("startSec")
            or raw.get("start_sec")
            or raw.get("start")
            or raw.get("from")
        )
        end = parse_time_sec(
            raw.get("endSec")
            or raw.get("end_sec")
            or raw.get("end")
            or raw.get("to")
        )
        reason = str(raw.get("reason") or raw.get("title") or raw.get("label") or "").strip()
    elif isinstance(raw, (list, tuple)) and len(raw) >= 2:
        start = parse_time_sec(raw[0])
        end = parse_time_sec(raw[1])
        reason = str(raw[2] if len(raw) >= 3 else "").strip()
    else:
        text = str(raw or "").strip()
        if not text:
            return None
        parts = None
        for separator in ("~", "-", ",", " to "):
            if separator in text:
                left, right = text.split(separator, 1)
                parts = [left, right]
                break
        if parts is None and text.count(":") == 1:
            left, right = text.split(":", 1)
            parts = [left, right]
        if not parts or len(parts) < 2:
            return None
        start = parse_time_sec(parts[0])
        end = parse_time_sec(parts[1])
        reason = ""
    if end <= start:
        return None
    return {
        "startSec": start,
        "endSec": end,
        "reason": reason,
    }


def collect_ignore_ranges(summary: Dict[str, object], frames_payload: Dict[str, object]) -> List[Dict[str, object]]:
    params = summary.get("params") if isinstance(summary.get("params"), dict) else {}
    frame_params = frames_payload.get("params") if isinstance(frames_payload.get("params"), dict) else {}
    raw_groups = [
        summary.get("ignoreRanges"),
        summary.get("ignore"),
        summary.get("evaluationIgnoreRanges"),
        params.get("ignoreRanges"),
        params.get("ignore"),
        params.get("evaluationIgnoreRanges"),
        frames_payload.get("ignoreRanges"),
        frames_payload.get("ignore"),
        frames_payload.get("evaluationIgnoreRanges"),
        frame_params.get("ignoreRanges"),
        frame_params.get("ignore"),
        frame_params.get("evaluationIgnoreRanges"),
    ]
    ranges: List[Dict[str, object]] = []
    seen = set()
    for raw_group in raw_groups:
        if raw_group is None:
            continue
        items = raw_group if isinstance(raw_group, list) else [raw_group]
        for item in items:
            normalized = normalize_range(item)
            if not normalized:
                continue
            key = (round(float(normalized["startSec"]), 3), round(float(normalized["endSec"]), 3))
            if key in seen:
                continue
            seen.add(key)
            ranges.append(normalized)
    return sorted(ranges, key=lambda item: float(item.get("startSec", 0.0)))


def load_manual_file(path: Path) -> List[Dict[str, object]]:
    segments: List[Dict[str, object]] = []
    for line_number, raw_line in enumerate(path.read_text(encoding="utf-8-sig").splitlines(), 1):
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        tokens = line.split()
        if len(tokens) < 2:
            raise ValueError(f"{path}:{line_number}: expected '<start> <end> [title]'")
        start = parse_time_sec(tokens[0])
        end = parse_time_sec(tokens[1])
        if end <= start:
            raise ValueError(f"{path}:{line_number}: end must be after start")
        segments.append({
            "startSec": start,
            "endSec": end,
            "title": " ".join(tokens[2:]).strip() if len(tokens) > 2 else "",
        })
    return sorted(segments, key=lambda item: float(item.get("startSec", 0.0)))


def load_manual_segments_for_summary(summary: Dict[str, object], summary_path: Path) -> List[Dict[str, object]]:
    manual_ref = summary.get("manualPath") or summary.get("manual")
    manual_path = resolve_existing_path(manual_ref, summary_path)
    if manual_path is not None:
        return load_manual_file(manual_path)
    manual_segments = [
        match.get("manual")
        for match in summary.get("matches", [])
        if isinstance(match, dict) and isinstance(match.get("manual"), dict)
    ]
    return sorted(manual_segments, key=lambda item: float(item.get("startSec", 0.0)))


def normalize_hard_negative_video_key(value: object) -> str:
    text = str(value or "").strip().replace("\\", "/")
    for token in reversed(text.split("/")):
        if token.startswith("video_"):
            return token.split(".")[0]
    return normalize_video_key(text)


def load_hard_negative_annotations(path: Path) -> Dict[str, List[Dict[str, object]]]:
    if not path or not path.exists():
        return {}
    groups: Dict[str, List[Dict[str, object]]] = {}
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        for row in reader:
            video = normalize_hard_negative_video_key(
                row.get("video") or row.get("video_key") or row.get("audio_path") or row.get("file")
            )
            start = parse_time_sec(row.get("start_sec") or row.get("start") or row.get("startSec"))
            end = parse_time_sec(row.get("end_sec") or row.get("end") or row.get("endSec"))
            if not video or end <= start:
                continue
            groups.setdefault(video, []).append({
                "startSec": start,
                "endSec": end,
                "confidence": 0.0,
                "provisional": False,
                "reason": str(row.get("reason") or row.get("title") or "").strip(),
                "_segmentFilterSource": "explicit-hard-negative",
                "_forceKeep": 0.0,
            })
    for segments in groups.values():
        segments.sort(key=lambda segment: float(segment.get("startSec", 0.0)))
    return groups


def hard_negative_lookup_keys(video: str) -> List[str]:
    keys = [video]
    match = re.match(r"^(video_\d+)(?:_.+)?$", video)
    if match and match.group(1) not in keys:
        keys.append(match.group(1))
    return keys


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


def ignore_range_overlap(segment: Dict[str, object], ignore_ranges: Sequence[Dict[str, object]]) -> Tuple[float, Optional[Dict[str, object]]]:
    best_overlap = 0.0
    best_range = None
    for ignore_range in ignore_ranges:
        overlap = overlap_seconds(segment, ignore_range)
        if overlap > best_overlap:
            best_overlap = overlap
            best_range = ignore_range
    return best_overlap, best_range


def ambiguous_unmatched_stats(segment: Dict[str, object], frames: Sequence[Dict[str, float]]) -> Dict[str, float]:
    start = float(segment.get("startSec", 0.0))
    end = float(segment.get("endSec", start))
    segment_frames = frames_in_range(frames, start, end)
    return {
        "durationSec": max(0.0, end - start),
        "frameCount": float(len(segment_frames)),
        "temporalMean": mean(values(segment_frames, "songProbability")),
        "musicMean": mean(values(segment_frames, "musicProbability")),
        "singingMean": mean(values(segment_frames, "singingProbability")),
        "singingP90": quantile(values(segment_frames, "singingProbability"), 0.9),
        "speechMean": mean(values(segment_frames, "speechProbability")),
    }


def should_skip_ambiguous_unmatched(
    args: argparse.Namespace,
    segment: Dict[str, object],
    frames: Sequence[Dict[str, float]],
    keep: float,
    overlap: float,
) -> Tuple[bool, Dict[str, float]]:
    if args.disable_ambiguous_unmatched_skip:
        return False, {}
    if keep >= 0.5 or overlap >= args.min_overlap_sec:
        return False, {}

    source = str(segment.get("_segmentFilterSource") or "")
    if source in {"manual-post-end-negative", "explicit-hard-negative", "dropped-music-only"}:
        return False, {}

    stats = ambiguous_unmatched_stats(segment, frames)
    if stats["durationSec"] < args.ambiguous_unmatched_min_duration_sec:
        return False, stats
    if stats["frameCount"] < 20:
        return False, stats

    has_song_context = (
        stats["temporalMean"] >= args.ambiguous_unmatched_temporal_mean
        and stats["musicMean"] >= args.ambiguous_unmatched_music_mean
        and (
            stats["singingMean"] >= args.ambiguous_unmatched_singing_mean
            or stats["singingP90"] >= args.ambiguous_unmatched_singing_p90
        )
        and stats["speechMean"] <= args.ambiguous_unmatched_speech_mean_max
    )
    return has_song_context, stats


def live_tail_song_target_guard_enabled(args: argparse.Namespace) -> bool:
    return args.training_profile.startswith("live-") and not args.disable_live_tail_song_target_guard


def post_end_negative_song_evidence_skip_enabled(args: argparse.Namespace) -> bool:
    return not args.disable_post_end_negative_song_evidence_skip


def summarize_tail_song_guard(
    args: argparse.Namespace,
    frames: Sequence[Dict[str, float]],
    proposed_end: float,
    original_end: float,
) -> Dict[str, object]:
    tail_frames = frames_in_range(frames, proposed_end, original_end)
    temporal_mean = mean(values(tail_frames, "songProbability"))
    temporal_p90 = quantile(values(tail_frames, "songProbability"), 0.9)
    singing_mean = mean(values(tail_frames, "singingProbability"))
    singing_p90 = quantile(values(tail_frames, "singingProbability"), 0.9)
    speech_mean = mean(values(tail_frames, "speechProbability"))
    low_energy_mean = mean(values(tail_frames, "lowEnergyRatio"))
    strong_song_tail = (
        temporal_mean >= args.tail_song_guard_temporal_mean
        or temporal_p90 >= args.tail_song_guard_temporal_p90
        or singing_mean >= args.tail_song_guard_singing_mean
        or singing_p90 >= args.tail_song_guard_singing_p90
    )
    clear_non_song_tail = (
        speech_mean >= args.tail_song_guard_speech_mean
        or low_energy_mean >= args.tail_song_guard_low_energy_mean
    )
    return {
        "frameCount": len(tail_frames),
        "strongSongTail": strong_song_tail,
        "clearNonSongTail": clear_non_song_tail,
        "temporalMean": temporal_mean,
        "temporalP90": temporal_p90,
        "singingMean": singing_mean,
        "singingP90": singing_p90,
        "speechMean": speech_mean,
        "lowEnergyMean": low_energy_mean,
    }


def adjust_end_delta_for_tail_song_guard(
    args: argparse.Namespace,
    segment: Dict[str, object],
    frames: Sequence[Dict[str, float]],
    end_delta: float,
) -> Tuple[float, Optional[Dict[str, object]]]:
    if not live_tail_song_target_guard_enabled(args):
        return end_delta, None
    if end_delta >= -args.tail_song_guard_min_trim_sec:
        return end_delta, None

    original_end = float(segment.get("endSec", 0.0))
    proposed_end = max(float(segment.get("startSec", 0.0)), original_end + end_delta)
    stats = summarize_tail_song_guard(args, frames, proposed_end, original_end)
    if int(stats["frameCount"]) < 4:
        return end_delta, stats
    if not stats["strongSongTail"] or stats["clearNonSongTail"]:
        return end_delta, stats

    adjusted = max(end_delta, -args.tail_song_guard_max_protected_trim_sec)
    stats["adjusted"] = adjusted != end_delta
    stats["originalEndDeltaSec"] = end_delta
    stats["adjustedEndDeltaSec"] = adjusted
    return adjusted, stats


def should_skip_manual_post_end_negative(
    args: argparse.Namespace,
    frames: Sequence[Dict[str, float]],
    start_sec: float,
    end_sec: float,
) -> Tuple[bool, Dict[str, object]]:
    stats = summarize_tail_song_guard(args, frames, start_sec, end_sec)
    if not post_end_negative_song_evidence_skip_enabled(args):
        return False, stats
    if int(stats["frameCount"]) < 4:
        return False, stats

    has_temporal_song = (
        float(stats["temporalMean"]) >= args.tail_song_guard_temporal_mean
        or float(stats["temporalP90"]) >= args.tail_song_guard_temporal_p90
    )
    has_singing = (
        float(stats["singingMean"]) >= args.tail_song_guard_singing_mean
        or float(stats["singingP90"]) >= args.tail_song_guard_singing_p90
    )
    clear_non_song_tail = bool(stats["clearNonSongTail"])
    skip = has_temporal_song and has_singing and not clear_non_song_tail
    stats["postEndNegativeSkipped"] = skip
    stats["postEndNegativeSkipReason"] = (
        "tail-still-looks-song-like"
        if skip
        else "accepted-as-negative"
    )
    return skip, stats


def collect_examples(args: argparse.Namespace) -> List[Example]:
    examples: List[Example] = []
    hard_negative_groups = load_hard_negative_annotations(args.hard_negative_annotations)
    ambiguous_skip_summary: Dict[str, object] = {
        "total": 0,
        "byVideo": {},
        "bySource": {},
        "policy": {
            "enabled": not args.disable_ambiguous_unmatched_skip,
            "minDurationSec": args.ambiguous_unmatched_min_duration_sec,
            "temporalMean": args.ambiguous_unmatched_temporal_mean,
            "musicMean": args.ambiguous_unmatched_music_mean,
            "singingMean": args.ambiguous_unmatched_singing_mean,
            "singingP90": args.ambiguous_unmatched_singing_p90,
            "speechMeanMax": args.ambiguous_unmatched_speech_mean_max,
        },
    }
    tail_guard_summary: Dict[str, object] = {
        "enabled": live_tail_song_target_guard_enabled(args),
        "total": 0,
        "adjusted": 0,
        "byVideo": {},
        "policy": {
            "minTrimSec": args.tail_song_guard_min_trim_sec,
            "maxProtectedTrimSec": args.tail_song_guard_max_protected_trim_sec,
            "temporalMean": args.tail_song_guard_temporal_mean,
            "temporalP90": args.tail_song_guard_temporal_p90,
            "singingMean": args.tail_song_guard_singing_mean,
            "singingP90": args.tail_song_guard_singing_p90,
            "speechMean": args.tail_song_guard_speech_mean,
            "lowEnergyMean": args.tail_song_guard_low_energy_mean,
        },
    }
    post_end_negative_skip_summary: Dict[str, object] = {
        "enabled": post_end_negative_song_evidence_skip_enabled(args),
        "total": 0,
        "byVideo": {},
        "examples": [],
        "policy": {
            "requiresTemporalSongEvidence": True,
            "requiresSingingEvidence": True,
            "rejectsClearNonSongTail": True,
            "temporalMean": args.tail_song_guard_temporal_mean,
            "temporalP90": args.tail_song_guard_temporal_p90,
            "singingMean": args.tail_song_guard_singing_mean,
            "singingP90": args.tail_song_guard_singing_p90,
            "speechMean": args.tail_song_guard_speech_mean,
            "lowEnergyMean": args.tail_song_guard_low_energy_mean,
        },
    }
    ignore_range_skip_summary: Dict[str, object] = {
        "total": 0,
        "byVideo": {},
        "bySource": {},
        "rangesByVideo": {},
        "examples": [],
        "policy": {
            "overlapSkipSec": args.ignore_range_overlap_skip_sec,
        },
    }
    for summary_path in summary_paths(args):
        video = infer_video_key_from_summary_path(summary_path)
        summary = load_json(summary_path)
        frames, frames_payload = load_frames_for_summary(args, summary, summary_path, video)
        normalized_frames = normalize_frames(frames)
        manual_segments = load_manual_segments_for_summary(summary, summary_path)
        ignore_ranges = collect_ignore_ranges(summary, frames_payload)
        if ignore_ranges:
            ranges_by_video = ignore_range_skip_summary["rangesByVideo"]
            if isinstance(ranges_by_video, dict):
                ranges_by_video[video] = [
                    {
                        "startSec": round(float(item.get("startSec", 0.0)), 3),
                        "endSec": round(float(item.get("endSec", 0.0)), 3),
                        "reason": str(item.get("reason") or ""),
                    }
                    for item in ignore_ranges
                ]
        params = summary.get("params") if isinstance(summary.get("params"), dict) else {}
        last_frame_sec = max((float(frame.get("timeSec", 0.0)) for frame in normalized_frames), default=0.0)
        context = {
            "endSec": float(
                summary.get("endSec")
                or summary.get("analyzedEndSec")
                or frames_payload.get("durationSec")
                or params.get("endSec")
                or params.get("sourceEndSec")
                or last_frame_sec
                or 0.0
            ),
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

        def add_manual_post_end_negatives() -> None:
            ordered_manual = sorted(manual_segments, key=lambda item: float(item.get("startSec", 0.0)))
            media_end_sec = float(context["endSec"])
            for manual_index, manual in enumerate(ordered_manual):
                start = float(manual.get("endSec", 0.0)) + args.post_end_negative_start_sec
                end = float(manual.get("endSec", 0.0)) + args.post_end_negative_end_sec
                if manual_index + 1 < len(ordered_manual):
                    end = min(end, float(ordered_manual[manual_index + 1].get("startSec", end)))
                end = min(end, media_end_sec)
                if end - start < args.post_end_negative_min_duration_sec:
                    continue
                skip_negative, skip_stats = should_skip_manual_post_end_negative(
                    args,
                    normalized_frames,
                    start,
                    end,
                )
                if skip_negative:
                    post_end_negative_skip_summary["total"] = int(post_end_negative_skip_summary["total"]) + 1
                    by_video = post_end_negative_skip_summary["byVideo"]
                    if isinstance(by_video, dict):
                        by_video[video] = int(by_video.get(video, 0)) + 1
                    examples = post_end_negative_skip_summary["examples"]
                    if isinstance(examples, list) and len(examples) < 20:
                        examples.append({
                            "video": video,
                            "manualIndex": manual_index,
                            "startSec": round(start, 3),
                            "endSec": round(end, 3),
                            "stats": skip_stats,
                        })
                    continue
                key = (round(start, 1), round(end, 1))
                if key in seen:
                    continue
                seen.add(key)
                candidate_segments.append({
                    "startSec": start,
                    "endSec": end,
                    "confidence": 0.0,
                    "provisional": False,
                    "_segmentFilterSource": "manual-post-end-negative",
                })

        def add_explicit_hard_negatives() -> None:
            media_end_sec = float(context["endSec"])
            negatives = [
                negative
                for key in hard_negative_lookup_keys(video)
                for negative in hard_negative_groups.get(key, [])
            ]
            for negative in negatives:
                start = max(0.0, float(negative.get("startSec", 0.0)))
                end = min(media_end_sec, float(negative.get("endSec", start)))
                if end - start < args.hard_negative_min_duration_sec:
                    continue
                candidates = [{**negative, "startSec": start, "endSec": end}]
                window_sec = max(0.0, float(args.hard_negative_subwindow_sec))
                hop_sec = max(0.1, float(args.hard_negative_subwindow_hop_sec))
                if window_sec >= args.hard_negative_min_duration_sec and end - start > window_sec:
                    cursor = start
                    while cursor + args.hard_negative_min_duration_sec <= end:
                        sub_end = min(end, cursor + window_sec)
                        if sub_end - cursor >= args.hard_negative_min_duration_sec:
                            candidates.append({
                                **negative,
                                "startSec": cursor,
                                "endSec": sub_end,
                                "_segmentFilterSource": "explicit-hard-negative-window",
                            })
                        if sub_end >= end:
                            break
                        cursor += hop_sec
                for segment in candidates:
                    manual_overlap = max((overlap_seconds(segment, manual) for manual in manual_segments), default=0.0)
                    if manual_overlap > args.hard_negative_overlap_skip_sec:
                        continue
                    segment_start = float(segment.get("startSec", 0.0))
                    segment_end = float(segment.get("endSec", segment_start))
                    key = (round(segment_start, 1), round(segment_end, 1))
                    if key in seen:
                        continue
                    seen.add(key)
                    candidate_segments.append(segment)

        add_candidates("final", summary.get("segments") or summary.get("finalSegments") or [])
        add_candidates("tracker", summary.get("trackerSegments") or [])
        add_candidates("selected-model-fallback", summary.get("selectedModelFallbackSegments") or [])
        add_candidates("fallback", summary.get("fallbackSegments") or [])
        add_candidates("dropped-tracker", summary.get("droppedTrackerSegments") or [])
        add_candidates("dropped-music-only", summary.get("droppedMusicOnlySegments") or [])
        add_candidates("model-run", summary.get("modelRunSegments") or [])
        add_manual_post_end_negatives()
        add_explicit_hard_negatives()

        for index, segment in enumerate(candidate_segments):
            if not isinstance(segment, dict):
                continue
            ignored_overlap, ignored_range = ignore_range_overlap(segment, ignore_ranges)
            if ignored_overlap >= args.ignore_range_overlap_skip_sec:
                source = str(segment.get("_segmentFilterSource") or "unknown")
                ignore_range_skip_summary["total"] = int(ignore_range_skip_summary["total"]) + 1
                by_video = ignore_range_skip_summary["byVideo"]
                by_source = ignore_range_skip_summary["bySource"]
                if isinstance(by_video, dict):
                    by_video[video] = int(by_video.get(video, 0)) + 1
                if isinstance(by_source, dict):
                    by_source[source] = int(by_source.get(source, 0)) + 1
                examples_for_summary = ignore_range_skip_summary["examples"]
                if isinstance(examples_for_summary, list) and len(examples_for_summary) < 20:
                    examples_for_summary.append({
                        "video": video,
                        "source": source,
                        "segmentStartSec": round(float(segment.get("startSec", 0.0)), 3),
                        "segmentEndSec": round(float(segment.get("endSec", 0.0)), 3),
                        "ignoredOverlapSec": round(ignored_overlap, 3),
                        "ignoreRange": {
                            "startSec": round(float(ignored_range.get("startSec", 0.0)), 3) if ignored_range else None,
                            "endSec": round(float(ignored_range.get("endSec", 0.0)), 3) if ignored_range else None,
                            "reason": str(ignored_range.get("reason") or "") if ignored_range else "",
                        },
                    })
                continue
            best_manual, overlap, recall, precision, extra_sec = best_manual_match(segment, manual_segments)
            duration = max(1.0, float(segment.get("endSec", 0.0)) - float(segment.get("startSec", 0.0)))
            extra_ratio = extra_sec / duration
            if "_forceKeep" in segment:
                keep = float(segment.get("_forceKeep") or 0.0)
            else:
                keep = 1.0 if (
                    best_manual is not None
                    and overlap >= args.min_overlap_sec
                    and recall >= args.min_recall
                    and precision >= args.min_precision
                    and extra_sec <= args.max_extra_sec
                    and extra_ratio <= args.max_extra_ratio
                ) else 0.0
            skip_ambiguous, _ambiguous_stats = should_skip_ambiguous_unmatched(
                args,
                segment,
                normalized_frames,
                keep,
                overlap,
            )
            if skip_ambiguous:
                source = str(segment.get("_segmentFilterSource") or "unknown")
                ambiguous_skip_summary["total"] = int(ambiguous_skip_summary["total"]) + 1
                by_video = ambiguous_skip_summary["byVideo"]
                by_source = ambiguous_skip_summary["bySource"]
                if isinstance(by_video, dict):
                    by_video[video] = int(by_video.get(video, 0)) + 1
                if isinstance(by_source, dict):
                    by_source[source] = int(by_source.get(source, 0)) + 1
                continue
            if keep and best_manual:
                start_delta = float(best_manual.get("startSec", 0.0)) - float(segment.get("startSec", 0.0))
                end_delta = float(best_manual.get("endSec", 0.0)) - float(segment.get("endSec", 0.0))
                start_delta = max(-args.trim_clamp_sec, min(args.trim_clamp_sec, start_delta))
                end_delta = max(-args.trim_clamp_sec, min(args.trim_clamp_sec, end_delta))
                guarded_end_delta, tail_guard_stats = adjust_end_delta_for_tail_song_guard(
                    args,
                    segment,
                    normalized_frames,
                    end_delta,
                )
                if tail_guard_stats is not None:
                    tail_guard_summary["total"] = int(tail_guard_summary["total"]) + 1
                    if tail_guard_stats.get("adjusted"):
                        tail_guard_summary["adjusted"] = int(tail_guard_summary["adjusted"]) + 1
                        by_video = tail_guard_summary["byVideo"]
                        if isinstance(by_video, dict):
                            by_video[video] = int(by_video.get(video, 0)) + 1
                    end_delta = guarded_end_delta
            else:
                start_delta = 0.0
                end_delta = 0.0
            examples.append(Example(
                video=video,
                segment_index=index,
                source=str(segment.get("_segmentFilterSource") or "unknown"),
                features=build_segment_filter_feature_vector(segment, frames, context),
                keep=keep,
                start_delta=start_delta,
                end_delta=end_delta,
                overlap_sec=overlap,
                recall_ratio=recall,
                precision_ratio=precision,
                extra_sec=extra_sec,
            ))
    setattr(args, "_ambiguous_skip_summary", ambiguous_skip_summary)
    setattr(args, "_tail_guard_summary", tail_guard_summary)
    setattr(args, "_post_end_negative_skip_summary", post_end_negative_skip_summary)
    setattr(args, "_ignore_range_skip_summary", ignore_range_skip_summary)
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


def evaluate_keep_model(model: SegmentKeepNet, x: torch.Tensor, y_keep: torch.Tensor, indices: Sequence[int]) -> Dict[str, object]:
    model.eval()
    with torch.no_grad():
        output = model(x[list(indices)]).detach().cpu().tolist()
    probs = [float(row[0]) for row in output]
    labels = [float(value) for value in y_keep[list(indices)].detach().cpu().tolist()]
    best = None
    for threshold in np.linspace(0.2, 0.75, 23):
        metrics = segment_metrics(probs, labels, float(threshold))
        if best is None or metrics["f1"] > best["metrics"]["f1"] or (math.isclose(metrics["f1"], best["metrics"]["f1"]) and metrics["precision"] > best["metrics"]["precision"]):
            best = {"threshold": float(threshold), "metrics": metrics}
    assert best is not None
    return {"bestThreshold": best["threshold"], "metrics": best["metrics"]}


def evaluate_edge_model(model: EdgeTrimAdvisorNet, x: torch.Tensor, y_delta: torch.Tensor, indices: Sequence[int]) -> Dict[str, object]:
    if not indices:
        return {"deltaMae": {"start": 0.0, "end": 0.0}}
    model.eval()
    with torch.no_grad():
        deltas = model(x[list(indices)]).detach().cpu().tolist()
    targets = [[float(row[0]), float(row[1])] for row in y_delta[list(indices)].detach().cpu().tolist()]
    start_mae = sum(abs(float(deltas[index][0]) - targets[index][0]) for index in range(len(indices))) / len(indices)
    end_mae = sum(abs(float(deltas[index][1]) - targets[index][1]) for index in range(len(indices))) / len(indices)
    return {"deltaMae": {"start": start_mae, "end": end_mae}}


def prepare_tensors(examples: Sequence[Example], train_indices: Sequence[int]) -> Tuple[torch.Tensor, torch.Tensor, torch.Tensor, np.ndarray, np.ndarray]:
    x_np = np.asarray([example.features for example in examples], dtype=np.float32)
    keep_np = np.asarray([example.keep for example in examples], dtype=np.float32)
    delta_np = np.asarray([[example.start_delta, example.end_delta] for example in examples], dtype=np.float32)
    feature_mean = x_np[list(train_indices)].mean(axis=0)
    feature_std = x_np[list(train_indices)].std(axis=0)
    feature_std = np.where(feature_std < 1e-6, 1.0, feature_std)
    return (
        torch.tensor(x_np.tolist(), dtype=torch.float32),
        torch.tensor(keep_np.tolist(), dtype=torch.float32),
        torch.tensor(delta_np.tolist(), dtype=torch.float32),
        feature_mean,
        feature_std,
    )


def train_keep_model(
    args: argparse.Namespace,
    examples: Sequence[Example],
    x: torch.Tensor,
    y_keep: torch.Tensor,
    train_indices: Sequence[int],
    val_indices: Sequence[int],
    feature_mean: np.ndarray,
    feature_std: np.ndarray,
) -> Tuple[SegmentKeepNet, Dict[str, object]]:
    train_tensor = torch.as_tensor(train_indices, dtype=torch.long)
    model = SegmentKeepNet(x.shape[1], feature_mean, feature_std)
    optimizer = torch.optim.AdamW(model.parameters(), lr=args.learning_rate, weight_decay=1e-4)
    labels = [examples[index].keep for index in train_indices]
    positive = float(sum(labels))
    negative = float(len(labels) - positive)
    pos_weight = torch.tensor([max(1.0, min(12.0, negative / max(1.0, positive)))], dtype=torch.float32)
    loss_fn = nn.BCEWithLogitsLoss(pos_weight=pos_weight)
    best_state = None
    best_score = -1.0
    best_epoch = 0
    for epoch in range(1, args.epochs + 1):
        model.train()
        optimizer.zero_grad(set_to_none=True)
        loss = loss_fn(model.raw_outputs(x[train_tensor]), y_keep[train_tensor])
        loss.backward()
        optimizer.step()
        if epoch % 25 == 0 or epoch == args.epochs:
            val = evaluate_keep_model(model, x, y_keep, val_indices)
            score = float(val["metrics"]["f1"])
            if score > best_score:
                best_score = score
                best_epoch = epoch
                best_state = {name: tensor.detach().cpu().clone() for name, tensor in model.state_dict().items()}
    if best_state is not None:
        model.load_state_dict(best_state)
    return model, {
        "bestEpoch": best_epoch,
        "trainMetrics": evaluate_keep_model(model, x, y_keep, train_indices),
        "validationMetrics": evaluate_keep_model(model, x, y_keep, val_indices),
    }


def train_edge_model(
    args: argparse.Namespace,
    x: torch.Tensor,
    y_keep: torch.Tensor,
    y_delta: torch.Tensor,
    train_indices: Sequence[int],
    val_indices: Sequence[int],
    feature_mean: np.ndarray,
    feature_std: np.ndarray,
) -> Tuple[EdgeTrimAdvisorNet, Dict[str, object]]:
    train_keep_indices = [index for index in train_indices if float(y_keep[index]) >= 0.5]
    val_keep_indices = [index for index in val_indices if float(y_keep[index]) >= 0.5]
    if not train_keep_indices:
        raise RuntimeError("No positive segments available for edge trim advisor training.")
    train_tensor = torch.as_tensor(train_keep_indices, dtype=torch.long)
    model = EdgeTrimAdvisorNet(x.shape[1], feature_mean, feature_std, args.trim_clamp_sec)
    optimizer = torch.optim.AdamW(model.parameters(), lr=args.learning_rate, weight_decay=1e-4)
    loss_fn = nn.SmoothL1Loss(beta=6.0, reduction="none")
    end_overtrim_weight = max(1.0, float(args.edge_end_overtrim_weight))
    best_state = None
    best_score = float("inf")
    best_epoch = 0
    for epoch in range(1, args.epochs + 1):
        model.train()
        optimizer.zero_grad(set_to_none=True)
        outputs = model.raw_outputs(x[train_tensor])
        targets = y_delta[train_tensor]
        loss_items = loss_fn(outputs, targets)
        if end_overtrim_weight > 1.0:
            # End delta that is too negative cuts the song before the manual end.
            end_overtrim = outputs[:, 1] < targets[:, 1]
            loss_items[:, 1] = torch.where(
                end_overtrim,
                loss_items[:, 1] * end_overtrim_weight,
                loss_items[:, 1],
            )
        loss = loss_items.mean()
        loss.backward()
        optimizer.step()
        if epoch % 25 == 0 or epoch == args.epochs:
            val = evaluate_edge_model(model, x, y_delta, val_keep_indices)
            score = float(val["deltaMae"]["start"]) + float(val["deltaMae"]["end"])
            if score < best_score:
                best_score = score
                best_epoch = epoch
                best_state = {name: tensor.detach().cpu().clone() for name, tensor in model.state_dict().items()}
    if best_state is not None:
        model.load_state_dict(best_state)
    return model, {
        "bestEpoch": best_epoch,
        "trainMetrics": evaluate_edge_model(model, x, y_delta, train_keep_indices),
        "validationMetrics": evaluate_edge_model(model, x, y_delta, val_keep_indices),
    }


def train_models(args: argparse.Namespace, examples: Sequence[Example]) -> Tuple[SegmentKeepNet, EdgeTrimAdvisorNet, Dict[str, object], Dict[str, object]]:
    torch.manual_seed(args.seed)
    np.random.seed(args.seed)
    train_indices, val_indices, val_groups = split_examples(examples, args.val_videos)
    x, y_keep, y_delta, feature_mean, feature_std = prepare_tensors(examples, train_indices)
    keep_model, keep_stats = train_keep_model(args, examples, x, y_keep, train_indices, val_indices, feature_mean, feature_std)
    edge_model, edge_stats = train_edge_model(args, x, y_keep, y_delta, train_indices, val_indices, feature_mean, feature_std)
    source_counts: Dict[str, Dict[str, int]] = {}
    for example in examples:
        entry = source_counts.setdefault(example.source, {"total": 0, "positive": 0, "negative": 0})
        entry["total"] += 1
        entry["positive" if example.keep >= 0.5 else "negative"] += 1
    keep_threshold = float(keep_stats["validationMetrics"]["bestThreshold"])
    profile = TRAINING_PROFILES[args.training_profile]
    edge_trim_scale = DEFAULT_FILTER_POLICY["trim_scale"]
    if args.training_profile.startswith("live-") and args.live_edge_trim_scale is not None:
        edge_trim_scale = max(0.0, min(1.0, float(args.live_edge_trim_scale)))
    common = {
        "segmentFilterVersion": SEGMENT_FILTER_VERSION,
        "trainingProfile": args.training_profile,
        "assetProfile": args.training_profile,
        "assetProfileSuffix": PROFILE_ASSET_SUFFIX.get(args.training_profile, ""),
        "intendedRuntime": profile["intendedRuntime"],
        "recommendedEvaluation": profile["evaluation"],
        "summaryGlobs": resolved_summary_globs(args),
        "inputName": "segment_features",
        "inputDim": len(SEGMENT_FILTER_FEATURE_NAMES),
        "featureNames": SEGMENT_FILTER_FEATURE_NAMES,
        "split": "by-video",
        "valGroups": val_groups,
        "exampleCount": len(examples),
        "positiveCount": int(sum(example.keep for example in examples)),
        "negativeCount": int(len(examples) - sum(example.keep for example in examples)),
        "sourceCounts": source_counts,
        "negativeMining": {
            "manualPostEndWindowSec": [args.post_end_negative_start_sec, args.post_end_negative_end_sec],
            "manualPostEndMinDurationSec": args.post_end_negative_min_duration_sec,
            "hardNegativeAnnotations": str(args.hard_negative_annotations),
            "hardNegativeMinDurationSec": args.hard_negative_min_duration_sec,
            "hardNegativeOverlapSkipSec": args.hard_negative_overlap_skip_sec,
            "hardNegativeSubwindowSec": args.hard_negative_subwindow_sec,
            "hardNegativeSubwindowHopSec": args.hard_negative_subwindow_hop_sec,
            "ambiguousUnmatchedSkip": getattr(args, "_ambiguous_skip_summary", None),
            "tailSongTargetGuard": getattr(args, "_tail_guard_summary", None),
            "postEndNegativeSongEvidenceSkip": getattr(args, "_post_end_negative_skip_summary", None),
            "ignoreRangeSkip": getattr(args, "_ignore_range_skip_summary", None),
        },
    }
    keep_metadata = {
        **common,
        "modelType": "firered-segment-filter",
        "outputName": "keep_probability",
        "keepThreshold": keep_threshold,
        "minSegmentDurationSec": DEFAULT_FILTER_POLICY["min_segment_duration_sec"],
        "bestEpoch": keep_stats["bestEpoch"],
        "trainMetrics": keep_stats["trainMetrics"],
        "validationMetrics": keep_stats["validationMetrics"],
        "labelPolicy": {
            "keep": "Predicted segment overlaps manual song segment enough to preserve and optionally trim.",
            "drop": "False positive, low overlap, long extra non-song/BGM-only candidate, manual post-end negative, or explicit hard negative.",
        },
    }
    if args.training_profile.startswith("live-"):
        live_final_keep_threshold = (
            keep_threshold
            if args.live_final_keep_threshold is None
            else float(args.live_final_keep_threshold)
        )
        keep_metadata["liveFinalKeepThreshold"] = max(0.01, min(0.99, live_final_keep_threshold))
        keep_metadata["runtimePolicy"] = {
            "liveFinalKeepThreshold": (
                "Use this threshold for live finalization candidates generated by the same profile. "
                "If this was overridden during training, A/B must compare it against current live assets."
            ),
            "liveFinalKeepThresholdSource": (
                "validation-bestThreshold"
                if args.live_final_keep_threshold is None
                else "--live-final-keep-threshold"
            ),
        }
    edge_metadata = {
        **common,
        "modelType": "firered-edge-trim-advisor",
        "outputName": "edge_trim_delta_sec",
        "trimConfidenceThreshold": max(keep_threshold, DEFAULT_FILTER_POLICY["trim_confidence_threshold"]),
        "trimClampSec": args.trim_clamp_sec,
        "trimScale": edge_trim_scale,
        "minSegmentDurationSec": DEFAULT_FILTER_POLICY["min_segment_duration_sec"],
        "bestEpoch": edge_stats["bestEpoch"],
        "trainMetrics": edge_stats["trainMetrics"],
        "validationMetrics": edge_stats["validationMetrics"],
        "lossPolicy": {
            "edgeEndOvertrimWeight": max(1.0, float(args.edge_end_overtrim_weight)),
            "edgeEndOvertrimDefinition": "prediction end_delta_sec is more negative than the target, cutting the segment before the manual end.",
        },
        "labelPolicy": {
            "trimTargets": "manual_best_start/end minus predicted start/end, clamped to trimClampSec. Trained on keep=1 examples only.",
        },
    }
    if args.training_profile.startswith("live-") and args.live_edge_trim_scale is not None:
        edge_metadata["liveEdgeTrimScaleOverride"] = edge_trim_scale
        edge_metadata["liveEdgeTrimScaleReason"] = (
            "Live-profile candidate uses conservative trim magnitude to reduce over-trimming during finalization."
        )
    if args.training_profile.startswith("live-"):
        edge_metadata["enableLiveEndTrimEvidenceGuard"] = True
        edge_metadata["enableLiveEndTrimEvidenceGuardReason"] = (
            "Live finalization must reject edge trims when the trimmed tail still has strong song evidence. "
            "This reduces damage from noisy or annotation-polluted end-trim targets."
        )
        validation_delta = edge_stats.get("validationMetrics", {}).get("deltaMae", {})
        validation_mae_max = max(
            float(validation_delta.get("start", 0.0) or 0.0),
            float(validation_delta.get("end", 0.0) or 0.0),
        )
        edge_metadata["liveEdgeTrimValidationMaxMaeSec"] = validation_mae_max
        if validation_mae_max > 30.0:
            edge_metadata["disableLiveEdgeTrim"] = True
            edge_metadata["disableLiveEdgeTrimReason"] = (
                "Validation edge MAE is too high for live finalization. "
                "Keep/drop can still be evaluated, but edge trim should stay disabled."
            )
    return keep_model, edge_model, keep_metadata, edge_metadata


def export_model(model: nn.Module, out_dir: Path, metadata: Dict[str, object], stem: str) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    pt_path = out_dir / f"{stem}.pt"
    onnx_path = out_dir / f"{stem}.onnx"
    meta_path = out_dir / f"{stem}.meta.json"
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
    for name in [
        "segment_filter.onnx",
        "segment_filter.meta.json",
        "edge_trim_advisor.onnx",
        "edge_trim_advisor.meta.json",
    ]:
        shutil.copy2(out_dir / name, install_dir / name)


def profile_asset_name(name: str, profile: str) -> str:
    suffix = PROFILE_ASSET_SUFFIX.get(profile, "")
    if not suffix:
        return name
    if name.endswith(".meta.json"):
        stem = name[:-10]
        return f"{stem}_{suffix}.meta.json"
    path = Path(name)
    return f"{path.stem}_{suffix}{path.suffix}"


def copy_profile_assets(out_dir: Path, target_dir: Path, profile: str) -> None:
    target_dir.mkdir(parents=True, exist_ok=True)
    for name in [
        "segment_filter.onnx",
        "segment_filter.meta.json",
        "edge_trim_advisor.onnx",
        "edge_trim_advisor.meta.json",
    ]:
        shutil.copy2(out_dir / name, target_dir / profile_asset_name(name, profile))


def install_assets_for_mode(out_dir: Path, install_dir: Path, profile: str, mode: str) -> None:
    if mode in {"default", "both"}:
        install_assets(out_dir, install_dir)
    if mode in {"profile", "both"}:
        copy_profile_assets(out_dir, install_dir, profile)


def main() -> None:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    args = parse_args()
    examples = collect_examples(args)
    if len(examples) < 4:
        raise RuntimeError(f"Not enough segment examples for training: {len(examples)}")
    keep_model, edge_model, keep_metadata, edge_metadata = train_models(args, examples)
    export_model(keep_model, args.out_dir, keep_metadata, "segment_filter")
    export_model(edge_model, args.out_dir, edge_metadata, "edge_trim_advisor")
    if args.write_profile_assets:
        copy_profile_assets(args.out_dir, args.out_dir, args.training_profile)
    write_examples(args.out_dir, examples)
    if args.install_dir:
        install_assets_for_mode(args.out_dir, args.install_dir, args.training_profile, args.install_mode)
    print(f"[segment-filter] examples={len(examples)} positives={keep_metadata['positiveCount']} negatives={keep_metadata['negativeCount']}")
    print(f"[segment-filter] sources={json.dumps(keep_metadata['sourceCounts'], ensure_ascii=False)}")
    print(f"[segment-filter] keep_val={json.dumps(keep_metadata['validationMetrics'], ensure_ascii=False)}")
    print(f"[segment-filter] edge_val={json.dumps(edge_metadata['validationMetrics'], ensure_ascii=False)}")
    print(f"[segment-filter] wrote {args.out_dir / 'segment_filter.onnx'}")
    print(f"[segment-filter] wrote {args.out_dir / 'edge_trim_advisor.onnx'}")
    if args.install_dir:
        print(f"[segment-filter] installed to {args.install_dir} mode={args.install_mode}")


if __name__ == "__main__":
    main()
