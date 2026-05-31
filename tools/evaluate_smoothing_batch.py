"""Batch-evaluate FireRed post-processing on multi-song manual samples.

This intentionally does not run medley splitting. It is for tuning
globalSmoothing.js against manually edited multi-song livestream playlists.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import csv
import json
import os
import re
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Sequence

import numpy as np

from segment_filter_features import (
    DEFAULT_FILTER_POLICY,
    apply_segment_filter_predictions,
    build_segment_filter_feature_matrix,
)


VIDEO_RE = re.compile(r"video_(\d+)")
SONG_LABELS = {"song", "auto-song", "1", "positive"}
AUDIO_SUFFIX_PRIORITY = [".m4a", ".mp4", ".wav", ".mp3", ".webm", ".aac", ".flac", ".opus", ".ogg", ".mkv"]
PROFILE_ASSET_SUFFIX = {
    "default": "",
    "offline-final": "offline_final",
    "live-pcm30": "live_pcm30",
    "live-realtime-aed60": "live_aed60",
}


@dataclass(frozen=True)
class Sample:
    video_key: str
    song_count: int
    manual_path: Optional[Path]
    audio_path: Optional[Path]
    stats_cache_path: Optional[Path]
    ignore_ranges: Sequence[Dict[str, object]]
    skip_reason: Optional[str] = None


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Evaluate smoothing on multi-song samples only.")
    parser.add_argument("--annotations", type=Path, default=Path("tools/annotations_example.csv"))
    parser.add_argument("--audio-dir", type=Path, default=Path("tools/data/audio"))
    parser.add_argument("--manual-dir", type=Path, default=Path("tools/data/manual"))
    parser.add_argument("--cache-dir", type=Path, default=Path("training_runs/firered_song_head_csv_v8_jinbee/cache"))
    parser.add_argument("--out-dir", type=Path, default=Path("training_runs/smoothing_eval_v8_jinbee/batch"))
    parser.add_argument("--model-dir", type=Path, default=Path("models/fireredvad/aed"))
    parser.add_argument("--chunk-sec", type=float, default=120.0)
    parser.add_argument("--min-song-count", type=int, default=2)
    parser.add_argument("--ids", nargs="*", default=None, help="Optional video numbers/keys to evaluate, e.g. 053 video_061.")
    parser.add_argument(
        "--ignore-ranges-samples",
        nargs="*",
        type=Path,
        default=[Path("tools/samples/live/live_pcm_full_regression_samples.example.json")],
        help="Optional sample JSON files to reuse ignoreRanges/evaluationIgnoreRanges in offline evaluation.",
    )
    parser.add_argument("--rebuild-diagnostics", action="store_true")
    parser.add_argument(
        "--rebuild-smoothing",
        action="store_true",
        help="Re-run global smoothing summaries from cached frames without rebuilding AED diagnostics.",
    )
    parser.add_argument(
        "--smoothing-profile",
        choices=sorted(PROFILE_ASSET_SUFFIX.keys()),
        default="offline-final",
        help="Mode-specific smoothing profile to pass to run_global_smoothing.mjs.",
    )
    parser.add_argument("--segment-filter", action="store_true", help="Apply experimental segment_filter.onnx and report before/after metrics.")
    parser.add_argument("--segment-filter-model-dir", type=Path, default=Path("models/fireredvad/aed"))
    parser.add_argument(
        "--segment-filter-profile",
        choices=sorted(PROFILE_ASSET_SUFFIX.keys()),
        default="offline-final",
        help="Profile-specific asset filenames to prefer before falling back to segment_filter.*.",
    )
    parser.add_argument("--segment-filter-threshold", type=float, default=None)
    parser.add_argument("--segment-filter-trim-threshold", type=float, default=None)
    parser.add_argument(
        "--require-profile-assets",
        action="store_true",
        help="Fail instead of falling back to default segment_filter/edge_trim_advisor assets when a profile is requested.",
    )
    parser.add_argument("--disable-edge-trim-advisor", action="store_true")
    parser.add_argument("--disable-start-edge-trim", action="store_true", help="Keep smoothing start times while still allowing end trim.")
    parser.add_argument("--boundary-candidates", action="store_true", help="Emit debug-only intra-segment boundary candidates; never changes output segments.")
    parser.add_argument("--simulate-live", action="store_true")
    parser.add_argument("--live-lookahead-sec", nargs="*", type=float, default=[20.0, 30.0, 60.0, 90.0, 120.0])
    parser.add_argument("--live-step-sec", type=float, default=30.0)
    parser.add_argument("--jobs", "--parallel", dest="jobs", type=int, default=1, help="Number of samples to evaluate concurrently.")
    parser.add_argument(
        "--command-timeout-sec",
        type=float,
        default=0.0,
        help="Optional timeout for each external diagnose/smoothing/live command. 0 disables timeout.",
    )
    parser.add_argument("--python", default=sys.executable)
    parser.add_argument("--node", default="node")
    return parser.parse_args()


def normalize_video_key(value: str) -> Optional[str]:
    text = str(value).strip()
    if re.fullmatch(r"\d+", text):
        return f"video_{int(text):03d}"
    match = VIDEO_RE.search(text)
    if not match:
        return None
    return f"video_{int(match.group(1)):03d}"


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


def normalize_ignore_range(raw: object) -> Optional[Dict[str, object]]:
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
        for separator in ("~", " to ", "-"):
            if separator in text:
                left, right = text.split(separator, 1)
                parts = [left, right]
                break
        if parts is None and text.count(":") == 1:
            left, right = text.split(":", 1)
            parts = [left, right]
        if not parts:
            return None
        start = parse_time_sec(parts[0])
        end = parse_time_sec(parts[1])
        reason = ""
    if end <= start:
        return None
    return {"startSec": start, "endSec": end, "reason": reason}


def dedupe_ignore_ranges(ranges: Iterable[Dict[str, object]]) -> List[Dict[str, object]]:
    output: List[Dict[str, object]] = []
    seen = set()
    for item in ranges:
        normalized = normalize_ignore_range(item)
        if not normalized:
            continue
        key = (round(float(normalized["startSec"]), 3), round(float(normalized["endSec"]), 3))
        if key in seen:
            continue
        seen.add(key)
        output.append(normalized)
    return sorted(output, key=lambda item: float(item.get("startSec", 0.0)))


def collect_ignore_ranges_from_payload(payload: Dict[str, object], extra: Optional[Sequence[Dict[str, object]]] = None) -> List[Dict[str, object]]:
    params = payload.get("params") if isinstance(payload.get("params"), dict) else {}
    raw_groups = [
        payload.get("ignoreRanges"),
        payload.get("ignore"),
        payload.get("evaluationIgnoreRanges"),
        params.get("ignoreRanges"),
        params.get("ignore"),
        params.get("evaluationIgnoreRanges"),
        extra,
    ]
    ranges: List[Dict[str, object]] = []
    for raw_group in raw_groups:
        if raw_group is None:
            continue
        ranges.extend(raw_group if isinstance(raw_group, list) else [raw_group])
    return dedupe_ignore_ranges(ranges)


def load_ignore_ranges_from_sample_files(paths: Sequence[Path]) -> Dict[str, List[Dict[str, object]]]:
    ranges_by_video: Dict[str, List[Dict[str, object]]] = {}
    for path in paths:
        if not path.exists():
            continue
        payload = load_json(path)
        if isinstance(payload, dict):
            raw_samples = payload.get("samples") or payload.get("items") or payload.get("videos") or []
        elif isinstance(payload, list):
            raw_samples = payload
        else:
            raw_samples = []
        for sample in raw_samples:
            if not isinstance(sample, dict):
                continue
            video_key = (
                normalize_video_key(str(sample.get("id") or ""))
                or normalize_video_key(str(sample.get("video") or ""))
                or normalize_video_key(str(sample.get("videoId") or ""))
                or normalize_video_key(str(sample.get("audio") or ""))
                or normalize_video_key(str(sample.get("manual") or ""))
            )
            if not video_key:
                continue
            ranges = collect_ignore_ranges_from_payload(sample)
            if not ranges:
                continue
            ranges_by_video[video_key] = dedupe_ignore_ranges([*ranges_by_video.get(video_key, []), *ranges])
    return ranges_by_video


def count_manual_segments(path: Path) -> int:
    count = 0
    for raw_line in path.read_text(encoding="utf-8-sig").splitlines():
        line = raw_line.strip()
        if line and not line.startswith("#"):
            count += 1
    return count


def annotation_song_counts(path: Path) -> Dict[str, int]:
    counts: Dict[str, int] = {}
    if not path.exists():
        return counts
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        for row in reader:
            audio_path = row.get("audio_path") or row.get("audio") or ""
            video_key = normalize_video_key(audio_path)
            if not video_key:
                continue
            label = str(row.get("label") or row.get("type") or "").strip().lower()
            if label and label not in SONG_LABELS:
                continue
            counts[video_key] = counts.get(video_key, 0) + 1
    return counts


def find_audio(audio_dir: Path, video_key: str) -> Optional[Path]:
    candidates = [path for path in audio_dir.glob(f"{video_key}.*") if path.suffix.lower() in AUDIO_SUFFIX_PRIORITY]
    if not candidates:
        return None
    priority = {suffix: index for index, suffix in enumerate(AUDIO_SUFFIX_PRIORITY)}
    exact = [path for path in candidates if path.stem == video_key]
    pool = exact or candidates
    return sorted(pool, key=lambda path: (priority.get(path.suffix.lower(), 999), str(path)))[0]


def find_stats_cache(cache_dir: Path, video_key: str, audio_path: Optional[Path]) -> Optional[Path]:
    if not cache_dir.exists():
        return None
    candidates = sorted(cache_dir.glob(f"*{video_key}*.stats.npz"))
    if not candidates:
        return None
    if audio_path:
        audio_name = audio_path.name
        for path in candidates:
            if audio_name in path.name:
                return path
    return candidates[0]


def build_samples(args: argparse.Namespace) -> List[Sample]:
    annotation_counts = annotation_song_counts(args.annotations)
    ignore_ranges_by_video = load_ignore_ranges_from_sample_files(args.ignore_ranges_samples)
    manual_counts: Dict[str, int] = {}
    manual_paths: Dict[str, Path] = {}
    if args.manual_dir.exists():
        for path in sorted(args.manual_dir.glob("video_*_manual.txt")):
            video_key = normalize_video_key(path.name)
            if not video_key:
                continue
            manual_paths[video_key] = path
            manual_counts[video_key] = count_manual_segments(path)

    requested = None
    if args.ids:
        requested = {normalize_video_key(token) for token in args.ids}
        requested.discard(None)

    keys = sorted(set(annotation_counts) | set(manual_counts))
    samples: List[Sample] = []
    for video_key in keys:
        if requested is not None and video_key not in requested:
            continue
        song_count = max(annotation_counts.get(video_key, 0), manual_counts.get(video_key, 0))
        manual_path = manual_paths.get(video_key)
        audio_path = find_audio(args.audio_dir, video_key)
        stats_cache_path = find_stats_cache(args.cache_dir, video_key, audio_path)
        if stats_cache_path is None and args.out_dir != args.cache_dir:
            # Reuse diagnostics generated by this evaluator before falling back
            # to a full rebuild. This keeps newly added samples from being
            # skipped when their cache was created in the evaluation out-dir.
            stats_cache_path = find_stats_cache(args.out_dir, video_key, audio_path)
        skip_reason = None
        if song_count < args.min_song_count:
            skip_reason = "single-song"
        elif manual_path is None:
            skip_reason = "missing-manual"
        elif audio_path is None:
            skip_reason = "missing-audio"
        elif stats_cache_path is None and not args.rebuild_diagnostics:
            skip_reason = "missing-stats-cache"
        samples.append(Sample(
            video_key=video_key,
            song_count=song_count,
            manual_path=manual_path,
            audio_path=audio_path,
            stats_cache_path=stats_cache_path,
            ignore_ranges=ignore_ranges_by_video.get(video_key, []),
            skip_reason=skip_reason,
        ))
    return samples


def run_command(command: List[str], cwd: Path, timeout_sec: float = 0.0) -> subprocess.CompletedProcess[str]:
    env = os.environ.copy()
    env["PYTHONIOENCODING"] = "utf-8"
    timeout = timeout_sec if timeout_sec and timeout_sec > 0 else None
    try:
        return subprocess.run(
            command,
            cwd=str(cwd),
            check=False,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            env=env,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired as error:
        stdout = error.stdout if isinstance(error.stdout, str) else (error.stdout or b"").decode("utf-8", errors="replace")
        stderr = error.stderr if isinstance(error.stderr, str) else (error.stderr or b"").decode("utf-8", errors="replace")
        timeout_message = f"\nCommand timed out after {timeout_sec:.1f}s: {' '.join(command)}"
        return subprocess.CompletedProcess(command, 124, stdout, f"{stderr}{timeout_message}")


def tail_text(value: str, max_lines: int = 80) -> str:
    lines = value.splitlines()
    return "\n".join(lines[-max_lines:])


def load_json(path: Path) -> object:
    return json.loads(path.read_text(encoding="utf-8"))


def profile_asset_name(stem: str, suffix: str, extension: str) -> str:
    return f"{stem}_{suffix}{extension}" if suffix else f"{stem}{extension}"


def resolve_profile_asset_pair(model_dir: Path, stem: str, profile: str) -> tuple[Path, Path, str]:
    suffix = PROFILE_ASSET_SUFFIX.get(profile, "")
    if suffix:
        profile_model = model_dir / profile_asset_name(stem, suffix, ".onnx")
        profile_meta = model_dir / profile_asset_name(stem, suffix, ".meta.json")
        if profile_model.exists() and profile_meta.exists():
            return profile_model, profile_meta, profile
    return model_dir / f"{stem}.onnx", model_dir / f"{stem}.meta.json", "default"


def assert_profile_asset_used(kind: str, requested_profile: str, used_profile: str) -> None:
    if requested_profile == "default" or used_profile == requested_profile:
        return
    raise RuntimeError(
        f"Required {kind} profile assets were not loaded for {requested_profile!r}; "
        f"resolved profile was {used_profile!r}. Check --segment-filter-model-dir or disable --require-profile-assets."
    )


def overlap_seconds(left: Dict[str, float], right: Dict[str, float]) -> float:
    return max(0.0, min(float(left["endSec"]), float(right["endSec"])) - max(float(left["startSec"]), float(right["startSec"])))


def overlap_with_ignore_ranges(segment: Dict[str, float], ignore_ranges: Sequence[Dict[str, object]]) -> float:
    overlap = 0.0
    for ignore_range in ignore_ranges:
        try:
            overlap += overlap_seconds(segment, ignore_range)  # type: ignore[arg-type]
        except (KeyError, TypeError, ValueError):
            continue
    duration = max(0.0, float(segment.get("endSec", 0.0)) - float(segment.get("startSec", 0.0)))
    return min(duration, overlap)


def estimate_music_repetition(frames: Sequence[Dict[str, object]], start_sec: float, end_sec: float) -> Dict[str, object]:
    window_sec = 8.0
    hop_sec = 4.0
    min_separation_sec = 24.0
    similarity_threshold = 0.9
    safe_frames = frames_between(frames, start_sec, end_sec)
    if not safe_frames or end_sec - start_sec < window_sec:
        return {
            "version": "music-repetition-feature-fingerprint-v1",
            "status": "insufficient-frames",
            "score": 0.0,
            "bestSimilarity": 0.0,
            "windowCount": 0,
            "musicOnlyWindowCount": 0,
            "matchedWindowCount": 0,
            "matchCount": 0,
            "repeatedWindowRatio": 0.0,
            "musicOnlyWindowRatio": 0.0,
            "vocalWindowRatio": 0.0,
        }

    def frame_value(frame: Dict[str, object], primary: str, secondary: str | None = None) -> float:
        value = frame.get(primary)
        if value is None and secondary:
            value = frame.get(secondary)
        return max(0.0, min(1.0, finite_float(value)))

    def window_summary(window_start: float) -> Dict[str, object] | None:
        window = [frame for frame in safe_frames if window_start <= finite_float(frame.get("timeSec")) < window_start + window_sec]
        if len(window) < int(window_sec):
            return None
        music = np.asarray([frame_value(frame, "musicProbability", "musicMean") for frame in window], dtype=np.float32)
        singing = np.asarray([frame_value(frame, "singingProbability", "singingMean") for frame in window], dtype=np.float32)
        speech = np.asarray([frame_value(frame, "speechProbability", "speechMean") for frame in window], dtype=np.float32)
        temporal = np.asarray([frame_value(frame, "temporalHeadProbability", "songProbability") for frame in window], dtype=np.float32)
        rms = np.asarray([
            min(1.0, np.log1p(max(0.0, finite_float(frame.get("audioRms"))) * 60.0) / np.log1p(60.0))
            for frame in window
        ], dtype=np.float32)
        flatness = np.asarray([frame_value(frame, "spectralFlatness") for frame in window], dtype=np.float32)
        flux = np.asarray([frame_value(frame, "spectralFlux") for frame in window], dtype=np.float32)
        centroid = np.asarray([frame_value(frame, "spectralCentroid") for frame in window], dtype=np.float32)
        mid = np.asarray([frame_value(frame, "midEnergyRatio") for frame in window], dtype=np.float32)
        high = np.asarray([frame_value(frame, "highEnergyRatio") for frame in window], dtype=np.float32)
        music_mean = float(music.mean())
        singing_mean = float(singing.mean())
        speech_mean = float(speech.mean())
        temporal_mean = float(temporal.mean())
        vector = np.asarray([
            music_mean,
            singing_mean,
            speech_mean,
            temporal_mean,
            float(rms.mean()),
            float(rms.std()),
            float(flatness.mean()),
            float(flux.mean()),
            float(centroid.mean()),
            float(mid.mean()),
            float(high.mean()),
        ], dtype=np.float32)
        return {
            "startSec": window_start,
            "vector": vector,
            "musicOnlyLike": music_mean >= 0.58 and singing_mean <= 0.28 and speech_mean <= 0.42 and temporal_mean <= 0.42,
            "vocalLike": singing_mean >= 0.4 or temporal_mean >= 0.55,
        }

    windows: List[Dict[str, object]] = []
    cursor = start_sec
    while cursor + window_sec <= end_sec + 0.001:
        summary = window_summary(cursor)
        if summary:
            windows.append(summary)
        cursor += hop_sec
    music_windows = [window for window in windows if bool(window.get("musicOnlyLike"))]
    weights = np.asarray([0.9, 1.15, 0.7, 1.05, 1.0, 0.65, 1.0, 0.8, 1.0, 1.0, 0.75], dtype=np.float32)
    weight_total = float(weights.sum())
    matched_indexes: set[int] = set()
    match_count = 0
    best_similarity = 0.0
    for left_index, left in enumerate(music_windows):
        for right_index in range(left_index + 1, len(music_windows)):
            right = music_windows[right_index]
            if finite_float(right.get("startSec")) - finite_float(left.get("startSec")) < min_separation_sec:
                continue
            distance = float(np.abs(np.asarray(left["vector"]) - np.asarray(right["vector"])).dot(weights))
            similarity = max(0.0, min(1.0, 1.0 - (distance / max(0.001, weight_total * 0.42))))
            best_similarity = max(best_similarity, similarity)
            if similarity >= similarity_threshold:
                matched_indexes.add(left_index)
                matched_indexes.add(right_index)
                match_count += 1
    repeated_ratio = len(matched_indexes) / max(1, len(music_windows))
    music_only_ratio = len(music_windows) / max(1, len(windows))
    vocal_ratio = len([window for window in windows if bool(window.get("vocalLike"))]) / max(1, len(windows))
    support_enough = len(music_windows) >= 4 and len(matched_indexes) >= 3
    raw_score = (
        ((max(0.0, best_similarity - 0.82) / 0.18) * 0.38)
        + (repeated_ratio * 0.44)
        + (music_only_ratio * 0.18)
    ) if support_enough else 0.0
    score = max(0.0, min(1.0, raw_score - (max(0.0, vocal_ratio - 0.18) * 0.75)))
    return {
        "version": "music-repetition-feature-fingerprint-v1",
        "status": "feature-fingerprint-v1",
        "score": round(score, 4),
        "bestSimilarity": round(best_similarity, 4),
        "windowCount": len(windows),
        "musicOnlyWindowCount": len(music_windows),
        "matchedWindowCount": len(matched_indexes),
        "matchCount": match_count,
        "repeatedWindowRatio": round(repeated_ratio, 4),
        "musicOnlyWindowRatio": round(music_only_ratio, 4),
        "vocalWindowRatio": round(vocal_ratio, 4),
    }


def diagnostic_features(frames: Sequence[Dict[str, object]], start_sec: float, end_sec: float) -> Dict[str, object]:
    window = frames_between(frames, start_sec, end_sec)
    stats = basic_frame_stats(window)
    singing = stats["singingMean"]
    music = stats["musicMean"]
    speech = stats["speechMean"]
    temporal = stats["temporalMean"]
    duration = max(0.0, end_sec - start_sec)
    music_only_score = max(0.0, min(1.0, (music - (singing * 1.7) - (speech * 1.15) + (0.12 if duration >= 180 else 0.0)) / 0.75))
    vocal_dominance = max(-1.0, min(1.0, singing - max(speech, music_only_score * 0.5)))
    tail_speech_with_music = max(0.0, min(1.0, music * speech * (1.0 - min(1.0, singing))))
    acapella_candidate = singing >= 0.55 and music <= 0.45 and speech <= 0.35 and temporal >= 0.45
    repetition = estimate_music_repetition(frames, start_sec, end_sec)
    return {
        **stats,
        "durationSec": duration,
        "vocalDominance": vocal_dominance,
        "musicOnlyScore": music_only_score,
        "tailSpeechWithMusic": tail_speech_with_music,
        "acapellaCandidate": acapella_candidate,
        "repetitionScore": repetition["score"],
        "repetitionScoreStatus": repetition["status"],
        "repetition": repetition,
    }


def classify_match_outlier(
    video_key: str,
    match: Dict[str, object],
    frames: Sequence[Dict[str, object]] = (),
    manual_segments: Sequence[Dict[str, object]] = (),
) -> List[Dict[str, object]]:
    outliers: List[Dict[str, object]] = []
    manual = match.get("manual") or {}
    best = match.get("best") or {}
    predicted = best.get("predicted") if isinstance(best, dict) else None
    title = manual.get("title", "")
    manual_features = diagnostic_features(frames, finite_float(manual.get("startSec")), finite_float(manual.get("endSec")))
    if not predicted or float(best.get("overlapSec") or 0) <= 0:
        outliers.append({
            "type": "acapella-risk" if manual_features["acapellaCandidate"] else "missed-segment",
            "video": video_key,
            "manual": manual,
            "title": title,
            "manualFeatures": manual_features,
        })
        return outliers

    recall = float(best.get("recallRatio") or 0)
    precision = float(best.get("predictedPrecisionRatio") or 0)
    start_delta = float(best.get("startDeltaSec") or 0)
    end_delta = float(best.get("endDeltaSec") or 0)
    predicted_features = diagnostic_features(frames, finite_float(predicted.get("startSec")), finite_float(predicted.get("endSec")))
    base = {
        "video": video_key,
        "manual": manual,
        "predicted": predicted,
        "title": title,
        "recall": recall,
        "precision": precision,
        "manualFeatures": manual_features,
        "predictedFeatures": predicted_features,
    }
    if recall < 0.75:
        outliers.append({**base, "type": "acapella-risk" if manual_features["acapellaCandidate"] else "low-recall"})
    if precision < 0.85:
        overlap_count = sum(1 for item in manual_segments if overlap_seconds(predicted, item) > 0)
        if overlap_count >= 2:
            outliers.append({**base, "type": "merged-close-songs", "overlapCount": overlap_count})
    if start_delta < -30:
        extension = diagnostic_features(frames, finite_float(predicted.get("startSec")), finite_float(manual.get("startSec")))
        outliers.append({
            **base,
            "type": "early-start-rehearsal" if extension["musicOnlyScore"] >= 0.35 else "early-start",
            "deltaSec": start_delta,
            "extensionFeatures": extension,
        })
    elif start_delta > 30:
        outliers.append({**base, "type": "late-start", "deltaSec": start_delta})
    if end_delta < -45:
        missing_tail = diagnostic_features(frames, finite_float(predicted.get("endSec")), finite_float(manual.get("endSec")))
        outliers.append({
            **base,
            "type": "early-end-speech-like" if missing_tail["tailSpeechWithMusic"] >= 0.12 else "early-end",
            "deltaSec": end_delta,
            "missingTailFeatures": missing_tail,
        })
    elif end_delta > 45:
        extension = diagnostic_features(frames, finite_float(manual.get("endSec")), finite_float(predicted.get("endSec")))
        outliers.append({
            **base,
            "type": "late-end-bgm" if extension["musicOnlyScore"] >= 0.35 or extension["tailSpeechWithMusic"] >= 0.12 else "late-end",
            "deltaSec": end_delta,
            "extensionFeatures": extension,
        })
    return outliers


def classify_prediction_outliers(video_key: str, summary: Dict[str, object], frames: Sequence[Dict[str, object]] = ()) -> List[Dict[str, object]]:
    outliers: List[Dict[str, object]] = []
    manual_segments = [match.get("manual") for match in summary.get("matches", []) if isinstance(match.get("manual"), dict)]
    ignore_ranges = collect_ignore_ranges_from_payload(summary)
    for segment in summary.get("segments", []):
        if not isinstance(segment, dict):
            continue
        duration = float(segment.get("endSec") or 0) - float(segment.get("startSec") or 0)
        manual_overlap = sum(overlap_seconds(segment, manual) for manual in manual_segments)
        ignored_overlap = overlap_with_ignore_ranges(segment, ignore_ranges)
        extra = duration - manual_overlap - ignored_overlap
        if extra > 60:
            segment_features = diagnostic_features(frames, finite_float(segment.get("startSec")), finite_float(segment.get("endSec")))
            outlier_type = "false-positive-repetitive-bgm" if float(segment_features["repetitionScore"] or 0.0) >= 0.66 else (
                "false-positive-bgm" if segment_features["musicOnlyScore"] >= 0.35 else "false-positive-long"
            )
            outliers.append({
                "type": outlier_type,
                "video": video_key,
                "extraSec": extra,
                "ignoredOverlapSec": ignored_overlap,
                "segment": segment,
                "segmentFeatures": segment_features,
            })
    return outliers


def aggregate_metrics(video_summaries: Iterable[Dict[str, object]]) -> Dict[str, float]:
    totals = {"tp": 0, "fp": 0, "fn": 0, "tn": 0}
    f1_values: List[float] = []
    for item in video_summaries:
        metrics = item.get("metrics") or {}
        for key in totals:
            totals[key] += int(metrics.get(key) or 0)
        if "f1" in metrics:
            f1_values.append(float(metrics["f1"]))
    precision = totals["tp"] / max(1, totals["tp"] + totals["fp"])
    recall = totals["tp"] / max(1, totals["tp"] + totals["fn"])
    f1 = (2 * precision * recall) / max(1e-9, precision + recall)
    f05 = (1.25 * precision * recall) / max(1e-9, (0.25 * precision) + recall)
    return {
        **totals,
        "precision": precision,
        "recall": recall,
        "f1": f1,
        "f0_5": f05,
        "meanF1": sum(f1_values) / max(1, len(f1_values)),
    }


def aggregate_live_metrics(video_summaries: Iterable[Dict[str, object]]) -> Dict[str, Dict[str, float]]:
    grouped: Dict[str, Dict[str, float]] = {}
    for item in video_summaries:
        live = item.get("liveSimulation") or {}
        for result in live.get("results", []) if isinstance(live, dict) else []:
            metrics = result.get("metrics") or {}
            key = str(result.get("lookaheadSec"))
            totals = grouped.setdefault(key, {"tp": 0, "fp": 0, "fn": 0, "tn": 0})
            for name in ["tp", "fp", "fn", "tn"]:
                totals[name] += int(metrics.get(name) or 0)
    for totals in grouped.values():
        precision = totals["tp"] / max(1, totals["tp"] + totals["fp"])
        recall = totals["tp"] / max(1, totals["tp"] + totals["fn"])
        totals["precision"] = precision
        totals["recall"] = recall
        totals["f1"] = (2 * precision * recall) / max(1e-9, precision + recall)
    return grouped


def labels_from_segments(times: Sequence[float], segments: Sequence[Dict[str, object]]) -> List[int]:
    labels: List[int] = []
    for time_sec in times:
        labels.append(1 if any(float(segment.get("startSec") or 0) <= time_sec < float(segment.get("endSec") or 0) for segment in segments) else 0)
    return labels


def frame_metrics(pred: Sequence[int], actual: Sequence[int]) -> Dict[str, float]:
    tp = fp = fn = tn = 0
    for predicted, target in zip(pred, actual):
        if predicted and target:
            tp += 1
        elif predicted and not target:
            fp += 1
        elif not predicted and target:
            fn += 1
        else:
            tn += 1
    precision = tp / max(1, tp + fp)
    recall = tp / max(1, tp + fn)
    f1 = (2 * precision * recall) / max(1e-9, precision + recall)
    f05 = (1.25 * precision * recall) / max(1e-9, (0.25 * precision) + recall)
    return {"precision": precision, "recall": recall, "f1": f1, "f0_5": f05, "tp": tp, "fp": fp, "fn": fn, "tn": tn}


def segment_matches(predicted: Sequence[Dict[str, object]], manual: Sequence[Dict[str, object]]) -> List[Dict[str, object]]:
    matches: List[Dict[str, object]] = []
    for target in manual:
        best = None
        for segment in predicted:
            overlap = overlap_seconds(segment, target)
            if best is None or overlap > float(best["overlapSec"]):
                best = {
                    "overlapSec": overlap,
                    "predicted": segment,
                    "recallRatio": overlap / max(1.0, float(target.get("endSec") or 0) - float(target.get("startSec") or 0)),
                    "predictedPrecisionRatio": overlap / max(1.0, float(segment.get("endSec") or 0) - float(segment.get("startSec") or 0)),
                    "startDeltaSec": float(segment.get("startSec") or 0) - float(target.get("startSec") or 0),
                    "endDeltaSec": float(segment.get("endSec") or 0) - float(target.get("endSec") or 0),
                }
        matches.append({"manual": target, "best": best})
    return matches


class SegmentFilterRuntime:
    def __init__(
        self,
        model_dir: Path,
        asset_profile: str = "offline-final",
        keep_threshold: Optional[float] = None,
        trim_threshold: Optional[float] = None,
        enable_edge_trim: bool = True,
        require_profile_assets: bool = False,
    ) -> None:
        try:
            import onnxruntime as ort
        except Exception as error:  # pragma: no cover - exercised in local tooling only.
            raise RuntimeError(f"onnxruntime is required for --segment-filter: {error}") from error
        self.model_path, self.meta_path, self.asset_profile_used = resolve_profile_asset_pair(
            model_dir,
            "segment_filter",
            asset_profile,
        )
        if require_profile_assets:
            assert_profile_asset_used("segment_filter", asset_profile, self.asset_profile_used)
        if not self.model_path.exists() or not self.meta_path.exists():
            raise RuntimeError(f"segment filter assets not found in {model_dir}")
        self.meta = load_json(self.meta_path)
        self.session = ort.InferenceSession(str(self.model_path), providers=["CPUExecutionProvider"])
        self.input_name = str(self.meta.get("inputName") or self.session.get_inputs()[0].name)
        self.output_name = str(self.meta.get("outputName") or self.session.get_outputs()[0].name)
        self.keep_threshold = float(keep_threshold if keep_threshold is not None else self.meta.get("keepThreshold", DEFAULT_FILTER_POLICY["keep_threshold"]))
        self.trim_clamp_sec = float(self.meta.get("trimClampSec", DEFAULT_FILTER_POLICY["trim_clamp_sec"]))
        self.trim_scale = float(self.meta.get("trimScale", DEFAULT_FILTER_POLICY["trim_scale"]))
        self.min_segment_duration_sec = float(self.meta.get("minSegmentDurationSec", DEFAULT_FILTER_POLICY["min_segment_duration_sec"]))
        self.edge_model_path, self.edge_meta_path, self.edge_asset_profile_used = resolve_profile_asset_pair(
            model_dir,
            "edge_trim_advisor",
            asset_profile,
        )
        if enable_edge_trim and require_profile_assets:
            assert_profile_asset_used("edge_trim_advisor", asset_profile, self.edge_asset_profile_used)
        self.edge_meta = None
        self.edge_session = None
        self.edge_input_name = None
        self.edge_output_name = None
        if enable_edge_trim and self.edge_model_path.exists() and self.edge_meta_path.exists():
            self.edge_meta = load_json(self.edge_meta_path)
            self.edge_session = ort.InferenceSession(str(self.edge_model_path), providers=["CPUExecutionProvider"])
            self.edge_input_name = str(self.edge_meta.get("inputName") or self.edge_session.get_inputs()[0].name)
            self.edge_output_name = str(self.edge_meta.get("outputName") or self.edge_session.get_outputs()[0].name)
            self.trim_threshold = float(trim_threshold if trim_threshold is not None else self.edge_meta.get("trimConfidenceThreshold", DEFAULT_FILTER_POLICY["trim_confidence_threshold"]))
            self.trim_clamp_sec = float(self.edge_meta.get("trimClampSec", self.trim_clamp_sec))
            self.trim_scale = float(self.edge_meta.get("trimScale", self.trim_scale))
            self.min_segment_duration_sec = float(self.edge_meta.get("minSegmentDurationSec", self.min_segment_duration_sec))
        else:
            self.trim_threshold = float(trim_threshold if trim_threshold is not None else DEFAULT_FILTER_POLICY["trim_confidence_threshold"])

    def predict(self, segments: Sequence[Dict[str, object]], frames: Sequence[Dict[str, object]], summary: Dict[str, object]) -> List[Dict[str, float]]:
        if not segments:
            return []
        context = {
            "endSec": float(summary.get("endSec") or 0),
            "trackerSegments": summary.get("trackerSegments") or [],
            "modelRunSegments": summary.get("modelRunSegments") or [],
            "fallbackSegments": summary.get("fallbackSegments") or [],
            "selectedModelFallbackSegments": summary.get("selectedModelFallbackSegments") or [],
        }
        matrix = np.asarray(build_segment_filter_feature_matrix(segments, frames, context), dtype=np.float32)
        keep_output = np.asarray(self.session.run([self.output_name], {self.input_name: matrix})[0], dtype=np.float32).reshape((len(segments), -1))
        edge_output = None
        if self.edge_session is not None and self.edge_input_name and self.edge_output_name:
            edge_output = np.asarray(self.edge_session.run([self.edge_output_name], {self.edge_input_name: matrix})[0], dtype=np.float32).reshape((len(segments), -1))
        predictions = []
        for index, row in enumerate(keep_output):
            edge_row = edge_output[index] if edge_output is not None else None
            predictions.append({
                "keepProbability": float(np.clip(row[0], 0.0, 1.0)),
                "startTrimDeltaSec": float(np.clip(edge_row[0], -self.trim_clamp_sec, self.trim_clamp_sec)) if edge_row is not None and len(edge_row) >= 2 else 0.0,
                "endTrimDeltaSec": float(np.clip(edge_row[1], -self.trim_clamp_sec, self.trim_clamp_sec)) if edge_row is not None and len(edge_row) >= 2 else 0.0,
            })
        return predictions


def severe_outliers_for_summary(video_key: str, summary: Dict[str, object], frames: Sequence[Dict[str, object]] = ()) -> List[Dict[str, object]]:
    severe_outliers: List[Dict[str, object]] = []
    metrics = summary.get("metrics") or {}
    manual_segments = [match.get("manual") for match in summary.get("matches", []) if isinstance(match.get("manual"), dict)]
    if float(metrics.get("f1") or 0) < 0.94:
        severe_outliers.append({"type": "low-video-f1", "video": video_key, "metrics": metrics})
    for match in summary.get("matches", []):
        if isinstance(match, dict):
            severe_outliers.extend(classify_match_outlier(video_key, match, frames, manual_segments))
    severe_outliers.extend(classify_prediction_outliers(video_key, summary, frames))
    return severe_outliers


def finite_float(value: object, fallback: float = 0.0) -> float:
    try:
        num = float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return fallback
    return num if np.isfinite(num) else fallback


def frames_between(frames: Sequence[Dict[str, object]], start_sec: float, end_sec: float) -> List[Dict[str, object]]:
    return [frame for frame in frames if start_sec <= finite_float(frame.get("timeSec")) <= end_sec]


def basic_frame_stats(frames: Sequence[Dict[str, object]]) -> Dict[str, float]:
    if not frames:
        return {
            "frameCount": 0,
            "temporalMean": 0.0,
            "singingMean": 0.0,
            "musicMean": 0.0,
            "speechMean": 0.0,
            "audioRmsMean": 0.0,
            "lowEnergyRatio": 0.0,
            "spectralFlatnessMean": 0.0,
            "spectralFluxMean": 0.0,
        }
    temporal = np.asarray([finite_float(frame.get("temporalHeadProbability", frame.get("songProbability"))) for frame in frames], dtype=np.float32)
    singing = np.asarray([finite_float(frame.get("singingProbability", frame.get("singingMean"))) for frame in frames], dtype=np.float32)
    music = np.asarray([finite_float(frame.get("musicProbability", frame.get("musicMean"))) for frame in frames], dtype=np.float32)
    speech = np.asarray([finite_float(frame.get("speechProbability", frame.get("speechMean"))) for frame in frames], dtype=np.float32)
    rms = np.asarray([finite_float(frame.get("audioRms")) for frame in frames], dtype=np.float32)
    peak = np.asarray([finite_float(frame.get("audioPeak")) for frame in frames], dtype=np.float32)
    low = np.asarray([finite_float(frame.get("lowEnergyRatio")) for frame in frames], dtype=np.float32)
    flatness = np.asarray([finite_float(frame.get("spectralFlatness")) for frame in frames], dtype=np.float32)
    flux = np.asarray([finite_float(frame.get("spectralFlux")) for frame in frames], dtype=np.float32)
    low_energy = np.logical_or.reduce((rms <= 0.006, peak <= 0.025, low >= 0.72))
    return {
        "frameCount": int(len(frames)),
        "temporalMean": float(temporal.mean()),
        "singingMean": float(singing.mean()),
        "musicMean": float(music.mean()),
        "speechMean": float(speech.mean()),
        "audioRmsMean": float(rms.mean()),
        "lowEnergyRatio": float(low_energy.mean()),
        "spectralFlatnessMean": float(flatness.mean()),
        "spectralFluxMean": float(flux.mean()),
    }


def boundary_candidates_for_segments(segments: Sequence[Dict[str, object]], frames: Sequence[Dict[str, object]]) -> List[Dict[str, object]]:
    candidates: List[Dict[str, object]] = []
    for segment_index, segment in enumerate(segments):
        start = finite_float(segment.get("startSec"))
        end = finite_float(segment.get("endSec"))
        if end - start < 180:
            continue
        cursor = start + 45
        segment_candidates: List[Dict[str, object]] = []
        while cursor <= end - 45:
            center = frames_between(frames, cursor - 2.0, cursor + 2.0)
            before = basic_frame_stats(frames_between(frames, cursor - 20.0, cursor - 4.0))
            after = basic_frame_stats(frames_between(frames, cursor + 4.0, cursor + 20.0))
            center_stats = basic_frame_stats(center)
            structure_change = (
                abs(after["singingMean"] - before["singingMean"])
                + abs(after["speechMean"] - before["speechMean"])
                + abs(after["musicMean"] - before["musicMean"])
                + min(1.0, abs(after["audioRmsMean"] - before["audioRmsMean"]) * 20.0)
            ) / 4.0
            reasons = []
            if center_stats["lowEnergyRatio"] >= 0.45:
                reasons.append("energy-valley")
            if center_stats["speechMean"] >= 0.45 and center_stats["singingMean"] <= 0.35:
                reasons.append("speech-reset")
            if structure_change >= 0.18:
                reasons.append("structure-change")
            if reasons:
                score = min(1.0, (center_stats["lowEnergyRatio"] * 0.45) + (structure_change * 0.45) + (0.2 if "speech-reset" in reasons else 0.0))
                segment_candidates.append({
                    "segmentIndex": segment_index,
                    "timeSec": round(cursor, 3),
                    "score": round(score, 4),
                    "reasons": reasons,
                    "centerStats": center_stats,
                    "beforeStats": before,
                    "afterStats": after,
                })
            cursor += 5.0
        candidates.extend(sorted(segment_candidates, key=lambda item: item["score"], reverse=True)[:5])
    return sorted(candidates, key=lambda item: (item["segmentIndex"], item["timeSec"]))


def build_outlier_replay(video_key: str, summary: Dict[str, object], frames: Sequence[Dict[str, object]]) -> List[Dict[str, object]]:
    replay = []
    adjustments = summary.get("segmentFilter", {}).get("adjustments", []) if isinstance(summary.get("segmentFilter"), dict) else []
    for outlier in summary.get("severeOutliers", []):
        if not isinstance(outlier, dict):
            continue
        segment = outlier.get("segment") or outlier.get("predicted") or {}
        manual = outlier.get("manual") or {}
        if isinstance(outlier.get("best"), dict):
            segment = outlier["best"].get("predicted") or segment
        start = finite_float(segment.get("startSec", manual.get("startSec", 0.0)))
        end = finite_float(segment.get("endSec", manual.get("endSec", start)))
        center = (start + end) / 2.0
        nearby_adjustments = []
        for adjustment in adjustments:
            original = adjustment.get("original", {}) if isinstance(adjustment, dict) else {}
            if abs(finite_float(original.get("startSec")) - start) <= 2.0 or abs(finite_float(original.get("endSec")) - end) <= 2.0:
                nearby_adjustments.append(adjustment)
        replay.append({
            "video": video_key,
            "type": outlier.get("type"),
            "centerSec": round(center, 3),
            "manual": manual,
            "predicted": segment,
            "outlier": outlier,
            "windowStats": basic_frame_stats(frames_between(frames, center - 90.0, center + 90.0)),
            "beforeStats": basic_frame_stats(frames_between(frames, max(0.0, start - 90.0), start)),
            "insideStats": basic_frame_stats(frames_between(frames, start, end)),
            "afterStats": basic_frame_stats(frames_between(frames, end, end + 90.0)),
            "segmentFilterAdjustments": nearby_adjustments,
        })
    return replay


def apply_segment_filter_to_summary(
    args: argparse.Namespace,
    sample: Sample,
    summary: Dict[str, object],
    frames_payload: Dict[str, object],
    runtime: SegmentFilterRuntime,
    repo_root: Path,
) -> Dict[str, object]:
    frames = frames_payload.get("frames", []) if isinstance(frames_payload, dict) else []
    predictions = runtime.predict(summary.get("segments") or [], frames, summary)
    predictions_path = args.out_dir / f"{sample.video_key}.segment_filter_predictions.json"
    out_path = args.out_dir / f"{sample.video_key}.segment_filter_summary.json"
    predictions_path.write_text(json.dumps({"predictions": predictions}, ensure_ascii=False, indent=2), encoding="utf-8")
    cmd = [
        args.node,
        "tools/run_global_smoothing.mjs",
        "--frames",
        str(args.out_dir / f"{sample.video_key}.frames.json"),
        "--manual",
        str(sample.manual_path),
        "--out",
        str(out_path),
        "--smoothing-profile",
        args.smoothing_profile,
        "--segment-filter-predictions",
        str(predictions_path),
        "--segment-filter-profile",
        args.segment_filter_profile,
        "--segment-filter-meta",
        str(runtime.meta_path),
        "--min-segment-duration-sec",
        str(runtime.min_segment_duration_sec),
    ]
    if runtime.edge_meta_path and runtime.edge_session is not None:
        cmd.extend(["--edge-trim-meta", str(runtime.edge_meta_path)])
    if args.disable_start_edge_trim:
        cmd.append("--disable-start-edge-trim")
    if sample.ignore_ranges:
        cmd.extend([
            "--ignore-ranges",
            ",".join(f"{float(item['startSec']):.3f}:{float(item['endSec']):.3f}" for item in sample.ignore_ranges),
        ])
    result = run_command(cmd, repo_root, args.command_timeout_sec)
    if result.returncode != 0:
        raise RuntimeError(f"segment filter smoothing failed for {sample.video_key}\n{tail_text(result.stdout)}\n{tail_text(result.stderr)}")

    filtered_summary = load_json(out_path)
    segment_filter = filtered_summary.get("segmentFilter") if isinstance(filtered_summary.get("segmentFilter"), dict) else {}
    segment_filter.update({
        "enabled": True,
        "modelPath": str(runtime.model_path),
        "metaPath": str(runtime.meta_path),
        "edgeModelPath": str(runtime.edge_model_path) if runtime.edge_session is not None else None,
        "edgeMetaPath": str(runtime.edge_meta_path) if runtime.edge_session is not None else None,
        "keepThreshold": runtime.keep_threshold,
        "trimConfidenceThreshold": runtime.trim_threshold,
        "startEdgeTrimEnabled": not args.disable_start_edge_trim,
        "trimScale": runtime.trim_scale,
        "predictionsPath": str(predictions_path),
    })
    filtered_summary["segmentFilter"] = segment_filter
    filtered_summary["boundaryCandidates"] = boundary_candidates_for_segments(filtered_summary.get("segments") or [], frames) if args.boundary_candidates else []
    filtered_summary["severeOutliers"] = severe_outliers_for_summary(sample.video_key, filtered_summary, frames)
    filtered_summary["outlierReplay"] = build_outlier_replay(sample.video_key, filtered_summary, frames)
    replay_path = args.out_dir / f"{sample.video_key}.outlier_replay.json"
    out_path.write_text(json.dumps(filtered_summary, ensure_ascii=False, indent=2), encoding="utf-8")
    replay_path.write_text(json.dumps(filtered_summary["outlierReplay"], ensure_ascii=False, indent=2), encoding="utf-8")
    return filtered_summary


def run_live_simulation(args: argparse.Namespace, sample: Sample, frames_path: Path, repo_root: Path) -> Optional[Dict[str, object]]:
    if not args.simulate_live:
        return None
    live_path = args.out_dir / f"{sample.video_key}.live_simulation.json"
    cmd = [
        args.node,
        "tools/live/simulate_live_smoothing.mjs",
        "--frames",
        str(frames_path),
        "--manual",
        str(sample.manual_path),
        "--out",
        str(live_path),
        "--lookahead-sec",
        *[str(value) for value in args.live_lookahead_sec],
        "--step-sec",
        str(args.live_step_sec),
        "--smoothing-profile",
        args.smoothing_profile,
    ]
    if sample.ignore_ranges:
        cmd.extend([
            "--ignore-ranges",
            ",".join(f"{float(item['startSec']):.3f}:{float(item['endSec']):.3f}" for item in sample.ignore_ranges),
        ])
    result = run_command(cmd, repo_root, args.command_timeout_sec)
    if result.returncode != 0:
        raise RuntimeError(f"live simulation failed for {sample.video_key}\n{tail_text(result.stdout)}\n{tail_text(result.stderr)}")
    payload = load_json(live_path)
    return {
        "path": str(live_path),
        "results": payload.get("results", []) if isinstance(payload, dict) else [],
    }


def evaluate_sample(args: argparse.Namespace, sample: Sample, repo_root: Path, segment_filter_runtime: Optional[SegmentFilterRuntime] = None) -> Dict[str, object]:
    frames_path = args.out_dir / f"{sample.video_key}.frames.json"
    smoothing_path = args.out_dir / f"{sample.video_key}.smoothing_summary.json"

    if args.rebuild_diagnostics or not frames_path.exists():
        diagnose_cmd = [
            args.python,
            "-u",
            "tools/diagnose_offline_detection.py",
            "--audio",
            str(sample.audio_path),
            "--manual",
            str(sample.manual_path),
            "--model-dir",
            str(args.model_dir),
            "--out-dir",
            str(args.out_dir),
            "--chunk-sec",
            str(args.chunk_sec),
        ]
        if sample.stats_cache_path is not None:
            diagnose_cmd.extend(["--stats-cache", str(sample.stats_cache_path)])
        if args.rebuild_diagnostics:
            diagnose_cmd.append("--rebuild")
        diagnose = run_command(diagnose_cmd, repo_root, args.command_timeout_sec)
        if diagnose.returncode != 0:
            raise RuntimeError(f"diagnose failed for {sample.video_key}\n{tail_text(diagnose.stdout)}\n{tail_text(diagnose.stderr)}")

    smoothing_cmd = [
        args.node,
        "tools/run_global_smoothing.mjs",
        "--frames",
        str(frames_path),
        "--manual",
        str(sample.manual_path),
        "--out",
        str(smoothing_path),
        "--smoothing-profile",
        args.smoothing_profile,
    ]
    if sample.ignore_ranges:
        smoothing_cmd.extend([
            "--ignore-ranges",
            ",".join(f"{float(item['startSec']):.3f}:{float(item['endSec']):.3f}" for item in sample.ignore_ranges),
        ])
    if args.rebuild_diagnostics or args.rebuild_smoothing or not smoothing_path.exists() or sample.ignore_ranges:
        smoothing = run_command(smoothing_cmd, repo_root, args.command_timeout_sec)
        if smoothing.returncode != 0:
            raise RuntimeError(f"smoothing failed for {sample.video_key}\n{tail_text(smoothing.stdout)}\n{tail_text(smoothing.stderr)}")

    summary = load_json(smoothing_path)
    frames_payload_for_outliers = load_json(frames_path)
    frames_for_outliers = frames_payload_for_outliers.get("frames", []) if isinstance(frames_payload_for_outliers, dict) else []
    baseline_metrics = summary.get("metrics") or {}
    baseline_severe_outliers = severe_outliers_for_summary(sample.video_key, summary, frames_for_outliers)
    active_summary = summary
    segment_filter_summary_path = None
    segment_filter_metrics = None
    segment_filter_outliers = None
    if segment_filter_runtime is not None:
        frames_payload = frames_payload_for_outliers
        if not isinstance(frames_payload, dict):
            raise RuntimeError(f"invalid frames payload for {sample.video_key}: {frames_path}")
        active_summary = apply_segment_filter_to_summary(args, sample, summary, frames_payload, segment_filter_runtime, repo_root)
        segment_filter_summary_path = str(args.out_dir / f"{sample.video_key}.segment_filter_summary.json")
        segment_filter_metrics = active_summary.get("metrics") or {}
        segment_filter_outliers = active_summary.get("severeOutliers") or []
    live_simulation = run_live_simulation(args, sample, frames_path, repo_root)

    return {
        "video": sample.video_key,
        "songCount": sample.song_count,
        "audioPath": str(sample.audio_path),
        "manualPath": str(sample.manual_path),
        "statsCachePath": str(sample.stats_cache_path),
        "ignoreRanges": list(sample.ignore_ranges),
        "evaluationIgnoredSec": active_summary.get("evaluationIgnoredSec") or summary.get("evaluationIgnoredSec") or 0,
        "framesPath": str(frames_path),
        "summaryPath": str(smoothing_path),
        "segmentFilterSummaryPath": segment_filter_summary_path,
        "outlierReplayPath": str(args.out_dir / f"{sample.video_key}.outlier_replay.json") if segment_filter_runtime is not None else None,
        "metrics": active_summary.get("metrics") or {},
        "baselineMetrics": baseline_metrics,
        "segmentFilterMetrics": segment_filter_metrics,
        "rawModelMetrics": summary.get("rawModelMetrics") or {},
        "method": active_summary.get("method"),
        "baselineMethod": summary.get("method"),
        "smoothingProfile": active_summary.get("smoothingProfile") or summary.get("smoothingProfile"),
        "smoothingVersion": summary.get("smoothingVersion"),
        "segmentCount": len(active_summary.get("segments") or []),
        "baselineSegmentCount": len(summary.get("segments") or []),
        "manualCount": len(summary.get("matches") or []),
        "liveSimulation": live_simulation,
        "severeOutliers": active_summary.get("severeOutliers") if segment_filter_runtime is not None else baseline_severe_outliers,
        "baselineSevereOutliers": baseline_severe_outliers,
        "segmentFilterSevereOutliers": segment_filter_outliers,
    }


_WORKER_ARGS: Optional[argparse.Namespace] = None
_WORKER_REPO_ROOT: Optional[Path] = None
_WORKER_SEGMENT_FILTER_RUNTIME: Optional[SegmentFilterRuntime] = None


def initialize_evaluate_worker(args: argparse.Namespace, repo_root: str) -> None:
    global _WORKER_ARGS, _WORKER_REPO_ROOT, _WORKER_SEGMENT_FILTER_RUNTIME
    _WORKER_ARGS = args
    _WORKER_REPO_ROOT = Path(repo_root)
    _WORKER_SEGMENT_FILTER_RUNTIME = None
    if getattr(args, "_segment_filter_available", False):
        _WORKER_SEGMENT_FILTER_RUNTIME = SegmentFilterRuntime(
            args.segment_filter_model_dir,
            asset_profile=args.segment_filter_profile,
            keep_threshold=args.segment_filter_threshold,
            trim_threshold=args.segment_filter_trim_threshold,
            enable_edge_trim=not args.disable_edge_trim_advisor,
            require_profile_assets=args.require_profile_assets,
        )


def evaluate_sample_worker(sample: Sample) -> Dict[str, object]:
    if _WORKER_ARGS is None or _WORKER_REPO_ROOT is None:
        raise RuntimeError("parallel worker was not initialized")
    return evaluate_sample(_WORKER_ARGS, sample, _WORKER_REPO_ROOT, _WORKER_SEGMENT_FILTER_RUNTIME)


def evaluate_samples_parallel(
    args: argparse.Namespace,
    runnable: Sequence[Sample],
    repo_root: Path,
    segment_filter_runtime: Optional[SegmentFilterRuntime],
) -> tuple[List[Dict[str, object]], List[Dict[str, object]]]:
    args._segment_filter_available = segment_filter_runtime is not None
    jobs = max(1, min(int(args.jobs or 1), len(runnable)))
    evaluated_by_video: Dict[str, Dict[str, object]] = {}
    failures_by_video: Dict[str, Dict[str, object]] = {}
    print(f"[batch] parallel jobs={jobs}", flush=True)
    with concurrent.futures.ProcessPoolExecutor(
        max_workers=jobs,
        initializer=initialize_evaluate_worker,
        initargs=(args, str(repo_root)),
    ) as executor:
        future_map = {}
        started_at = {}
        for index, sample in enumerate(runnable, 1):
            print(f"[batch] queued {index}/{len(runnable)} {sample.video_key} songs={sample.song_count}", flush=True)
            future = executor.submit(evaluate_sample_worker, sample)
            future_map[future] = (index, sample)
            started_at[future] = time.time()
        for future in concurrent.futures.as_completed(future_map):
            index, sample = future_map[future]
            elapsed_sec = time.time() - started_at[future]
            try:
                result = future.result()
                evaluated_by_video[sample.video_key] = result
                metrics = result["metrics"]
                print(
                    f"[batch] done {index}/{len(runnable)} {sample.video_key} "
                    f"elapsed={elapsed_sec:.1f}s "
                    f"f1={float(metrics.get('f1') or 0):.4f} "
                    f"p={float(metrics.get('precision') or 0):.4f} "
                    f"r={float(metrics.get('recall') or 0):.4f} "
                    f"outliers={len(result['severeOutliers'])}",
                    flush=True,
                )
            except Exception as error:
                failures_by_video[sample.video_key] = {"video": sample.video_key, "error": str(error)}
                print(
                    f"[batch] failed {index}/{len(runnable)} {sample.video_key} "
                    f"elapsed={elapsed_sec:.1f}s: {error}",
                    file=sys.stderr,
                    flush=True,
                )
    evaluated = [evaluated_by_video[sample.video_key] for sample in runnable if sample.video_key in evaluated_by_video]
    failures = [failures_by_video[sample.video_key] for sample in runnable if sample.video_key in failures_by_video]
    return evaluated, failures


def main() -> None:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    args = parse_args()
    repo_root = Path.cwd()
    args.out_dir.mkdir(parents=True, exist_ok=True)
    segment_filter_runtime = None
    segment_filter_warning = None
    if args.segment_filter:
        try:
            segment_filter_runtime = SegmentFilterRuntime(
                args.segment_filter_model_dir,
                asset_profile=args.segment_filter_profile,
                keep_threshold=args.segment_filter_threshold,
                trim_threshold=args.segment_filter_trim_threshold,
                enable_edge_trim=not args.disable_edge_trim_advisor,
                require_profile_assets=args.require_profile_assets,
            )
        except Exception as error:
            segment_filter_warning = str(error)
            print(f"[batch] segment filter unavailable; fallback to baseline heuristic: {error}", file=sys.stderr)
            if args.require_profile_assets:
                raise SystemExit(1) from error

    samples = build_samples(args)
    skipped = [
        {
            "video": sample.video_key,
            "songCount": sample.song_count,
            "reason": sample.skip_reason,
            "manualPath": str(sample.manual_path) if sample.manual_path else None,
            "audioPath": str(sample.audio_path) if sample.audio_path else None,
            "statsCachePath": str(sample.stats_cache_path) if sample.stats_cache_path else None,
            "ignoreRanges": list(sample.ignore_ranges),
        }
        for sample in samples
        if sample.skip_reason
    ]

    runnable = [sample for sample in samples if not sample.skip_reason]
    args.jobs = max(1, int(args.jobs or 1))
    args.command_timeout_sec = max(0.0, float(args.command_timeout_sec or 0.0))
    print(
        f"[batch] samples={len(samples)} runnable={len(runnable)} skipped={len(skipped)} "
        f"jobs={min(args.jobs, max(1, len(runnable)))} out={args.out_dir}"
    )
    if args.jobs > 1 and len(runnable) > 1:
        evaluated, failures = evaluate_samples_parallel(args, runnable, repo_root, segment_filter_runtime)
    else:
        evaluated = []
        failures = []
        for index, sample in enumerate(runnable, 1):
            print(f"[batch] {index}/{len(runnable)} {sample.video_key} songs={sample.song_count}")
            started_at = time.time()
            try:
                result = evaluate_sample(args, sample, repo_root, segment_filter_runtime)
                evaluated.append(result)
                metrics = result["metrics"]
                print(
                    f"[batch] {sample.video_key} elapsed={time.time() - started_at:.1f}s "
                    f"f1={float(metrics.get('f1') or 0):.4f} "
                    f"p={float(metrics.get('precision') or 0):.4f} r={float(metrics.get('recall') or 0):.4f} "
                    f"outliers={len(result['severeOutliers'])}"
                )
            except Exception as error:
                failures.append({"video": sample.video_key, "error": str(error)})
                print(f"[batch] {sample.video_key} failed: {error}", file=sys.stderr)

    severe_outliers = []
    for item in evaluated:
        severe_outliers.extend(item["severeOutliers"])

    payload = {
        "outDir": str(args.out_dir),
        "segmentFilterEnabled": bool(segment_filter_runtime),
        "segmentFilterWarning": segment_filter_warning,
        "segmentFilterModelDir": str(args.segment_filter_model_dir),
        "smoothingProfile": args.smoothing_profile,
        "segmentFilterRequestedProfile": args.segment_filter_profile,
        "segmentFilterAssetProfileUsed": segment_filter_runtime.asset_profile_used if segment_filter_runtime else None,
        "edgeTrimAdvisorAssetProfileUsed": segment_filter_runtime.edge_asset_profile_used if segment_filter_runtime else None,
        "jobs": min(args.jobs, max(1, len(runnable))),
        "commandTimeoutSec": args.command_timeout_sec,
        "evaluatedCount": len(evaluated),
        "skippedCount": len(skipped),
        "failureCount": len(failures),
        "aggregateMetrics": aggregate_metrics(evaluated),
        "baselineAggregateMetrics": aggregate_metrics([{**item, "metrics": item.get("baselineMetrics") or {}} for item in evaluated]) if segment_filter_runtime else None,
        "segmentFilterAggregateMetrics": aggregate_metrics([{**item, "metrics": item.get("segmentFilterMetrics") or {}} for item in evaluated]) if segment_filter_runtime else None,
        "liveAggregateMetrics": aggregate_live_metrics(evaluated) if args.simulate_live else None,
        "videos": evaluated,
        "skipped": skipped,
        "failures": failures,
        "severeOutliers": severe_outliers,
    }
    summary_path = args.out_dir / "batch_summary.json"
    outliers_path = args.out_dir / "severe_outliers.json"
    summary_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    outliers_path.write_text(json.dumps(severe_outliers, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[batch] wrote {summary_path}")
    print(f"[batch] wrote {outliers_path}")
    print(json.dumps(payload["aggregateMetrics"], ensure_ascii=False, indent=2))
    if failures:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
