"""Batch-evaluate FireRed post-processing on multi-song manual samples.

This intentionally does not run medley splitting. It is for tuning
globalSmoothing.js against manually edited multi-song livestream playlists.
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import re
import subprocess
import sys
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


@dataclass(frozen=True)
class Sample:
    video_key: str
    song_count: int
    manual_path: Optional[Path]
    audio_path: Optional[Path]
    stats_cache_path: Optional[Path]
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
    parser.add_argument("--rebuild-diagnostics", action="store_true")
    parser.add_argument("--segment-filter", action="store_true", help="Apply experimental segment_filter.onnx and report before/after metrics.")
    parser.add_argument("--segment-filter-model-dir", type=Path, default=Path("models/fireredvad/aed"))
    parser.add_argument("--segment-filter-threshold", type=float, default=None)
    parser.add_argument("--segment-filter-trim-threshold", type=float, default=None)
    parser.add_argument("--disable-edge-trim-advisor", action="store_true")
    parser.add_argument("--boundary-candidates", action="store_true", help="Emit debug-only intra-segment boundary candidates; never changes output segments.")
    parser.add_argument("--simulate-live", action="store_true")
    parser.add_argument("--live-lookahead-sec", nargs="*", type=float, default=[20.0, 30.0, 60.0, 90.0, 120.0])
    parser.add_argument("--live-step-sec", type=float, default=30.0)
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
        skip_reason = None
        if song_count < args.min_song_count:
            skip_reason = "single-song"
        elif manual_path is None:
            skip_reason = "missing-manual"
        elif audio_path is None:
            skip_reason = "missing-audio"
        elif stats_cache_path is None:
            skip_reason = "missing-stats-cache"
        samples.append(Sample(video_key, song_count, manual_path, audio_path, stats_cache_path, skip_reason))
    return samples


def run_command(command: List[str], cwd: Path) -> subprocess.CompletedProcess[str]:
    env = os.environ.copy()
    env["PYTHONIOENCODING"] = "utf-8"
    return subprocess.run(
        command,
        cwd=str(cwd),
        check=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        env=env,
    )


def tail_text(value: str, max_lines: int = 80) -> str:
    lines = value.splitlines()
    return "\n".join(lines[-max_lines:])


def load_json(path: Path) -> object:
    return json.loads(path.read_text(encoding="utf-8"))


def overlap_seconds(left: Dict[str, float], right: Dict[str, float]) -> float:
    return max(0.0, min(float(left["endSec"]), float(right["endSec"])) - max(float(left["startSec"]), float(right["startSec"])))


def classify_match_outlier(video_key: str, match: Dict[str, object]) -> List[Dict[str, object]]:
    outliers: List[Dict[str, object]] = []
    manual = match.get("manual") or {}
    best = match.get("best") or {}
    predicted = best.get("predicted") if isinstance(best, dict) else None
    title = manual.get("title", "")
    if not predicted or float(best.get("overlapSec") or 0) <= 0:
        outliers.append({"type": "missed-segment", "video": video_key, "manual": manual, "title": title})
        return outliers

    recall = float(best.get("recallRatio") or 0)
    start_delta = float(best.get("startDeltaSec") or 0)
    end_delta = float(best.get("endDeltaSec") or 0)
    if recall < 0.75:
        outliers.append({"type": "low-recall", "video": video_key, "recall": recall, "manual": manual, "predicted": predicted, "title": title})
    if start_delta < -30:
        outliers.append({"type": "early-start", "video": video_key, "deltaSec": start_delta, "manual": manual, "predicted": predicted, "title": title})
    elif start_delta > 30:
        outliers.append({"type": "late-start", "video": video_key, "deltaSec": start_delta, "manual": manual, "predicted": predicted, "title": title})
    if end_delta < -45:
        outliers.append({"type": "early-end", "video": video_key, "deltaSec": end_delta, "manual": manual, "predicted": predicted, "title": title})
    elif end_delta > 45:
        outliers.append({"type": "late-end", "video": video_key, "deltaSec": end_delta, "manual": manual, "predicted": predicted, "title": title})
    return outliers


def classify_prediction_outliers(video_key: str, summary: Dict[str, object]) -> List[Dict[str, object]]:
    outliers: List[Dict[str, object]] = []
    manual_segments = [match.get("manual") for match in summary.get("matches", []) if isinstance(match.get("manual"), dict)]
    for segment in summary.get("segments", []):
        if not isinstance(segment, dict):
            continue
        duration = float(segment.get("endSec") or 0) - float(segment.get("startSec") or 0)
        overlap = sum(overlap_seconds(segment, manual) for manual in manual_segments)
        extra = duration - overlap
        if extra > 60:
            outliers.append({
                "type": "false-positive-long",
                "video": video_key,
                "extraSec": extra,
                "segment": segment,
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
        keep_threshold: Optional[float] = None,
        trim_threshold: Optional[float] = None,
        enable_edge_trim: bool = True,
    ) -> None:
        try:
            import onnxruntime as ort
        except Exception as error:  # pragma: no cover - exercised in local tooling only.
            raise RuntimeError(f"onnxruntime is required for --segment-filter: {error}") from error
        self.model_path = model_dir / "segment_filter.onnx"
        self.meta_path = model_dir / "segment_filter.meta.json"
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
        self.edge_model_path = model_dir / "edge_trim_advisor.onnx"
        self.edge_meta_path = model_dir / "edge_trim_advisor.meta.json"
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


def severe_outliers_for_summary(video_key: str, summary: Dict[str, object]) -> List[Dict[str, object]]:
    severe_outliers: List[Dict[str, object]] = []
    metrics = summary.get("metrics") or {}
    if float(metrics.get("f1") or 0) < 0.94:
        severe_outliers.append({"type": "low-video-f1", "video": video_key, "metrics": metrics})
    for match in summary.get("matches", []):
        if isinstance(match, dict):
            severe_outliers.extend(classify_match_outlier(video_key, match))
    severe_outliers.extend(classify_prediction_outliers(video_key, summary))
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
) -> Dict[str, object]:
    frames = frames_payload.get("frames", []) if isinstance(frames_payload, dict) else []
    manual_segments = [match.get("manual") for match in summary.get("matches", []) if isinstance(match, dict) and isinstance(match.get("manual"), dict)]
    predictions = runtime.predict(summary.get("segments") or [], frames, summary)
    filtered_segments, adjustments = apply_segment_filter_predictions(
        summary.get("segments") or [],
        predictions,
        start_sec=0.0,
        end_sec=float(summary.get("endSec") or frames_payload.get("durationSec") or 0),
        keep_threshold=runtime.keep_threshold,
        trim_confidence_threshold=runtime.trim_threshold,
        trim_clamp_sec=runtime.trim_clamp_sec,
        trim_scale=runtime.trim_scale,
        min_segment_duration_sec=runtime.min_segment_duration_sec,
    )
    times = [float(frame.get("timeSec") or 0) for frame in frames]
    filtered_summary = {
        **summary,
        "method": f"{summary.get('method', 'unknown')}+segment-filter",
        "segments": filtered_segments,
        "metrics": frame_metrics(labels_from_segments(times, filtered_segments), labels_from_segments(times, manual_segments)),
        "matches": segment_matches(filtered_segments, manual_segments),
        "boundaryCandidates": boundary_candidates_for_segments(filtered_segments, frames) if args.boundary_candidates else [],
        "segmentFilter": {
            "enabled": True,
            "modelPath": str(runtime.model_path),
            "metaPath": str(runtime.meta_path),
            "edgeModelPath": str(runtime.edge_model_path) if runtime.edge_session is not None else None,
            "edgeMetaPath": str(runtime.edge_meta_path) if runtime.edge_session is not None else None,
            "keepThreshold": runtime.keep_threshold,
            "trimConfidenceThreshold": runtime.trim_threshold,
            "trimScale": runtime.trim_scale,
            "predictions": predictions,
            "adjustments": adjustments,
        },
    }
    filtered_summary["severeOutliers"] = severe_outliers_for_summary(sample.video_key, filtered_summary)
    filtered_summary["outlierReplay"] = build_outlier_replay(sample.video_key, filtered_summary, frames)
    out_path = args.out_dir / f"{sample.video_key}.segment_filter_summary.json"
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
        "tools/simulate_live_smoothing.mjs",
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
    ]
    result = run_command(cmd, repo_root)
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
            "--stats-cache",
            str(sample.stats_cache_path),
        ]
        if args.rebuild_diagnostics:
            diagnose_cmd.append("--rebuild")
        diagnose = run_command(diagnose_cmd, repo_root)
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
    ]
    if args.rebuild_diagnostics or not smoothing_path.exists():
        smoothing = run_command(smoothing_cmd, repo_root)
        if smoothing.returncode != 0:
            raise RuntimeError(f"smoothing failed for {sample.video_key}\n{tail_text(smoothing.stdout)}\n{tail_text(smoothing.stderr)}")

    summary = load_json(smoothing_path)
    baseline_metrics = summary.get("metrics") or {}
    baseline_severe_outliers = severe_outliers_for_summary(sample.video_key, summary)
    active_summary = summary
    segment_filter_summary_path = None
    segment_filter_metrics = None
    segment_filter_outliers = None
    if segment_filter_runtime is not None:
        frames_payload = load_json(frames_path)
        if not isinstance(frames_payload, dict):
            raise RuntimeError(f"invalid frames payload for {sample.video_key}: {frames_path}")
        active_summary = apply_segment_filter_to_summary(args, sample, summary, frames_payload, segment_filter_runtime)
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
        "smoothingVersion": summary.get("smoothingVersion"),
        "segmentCount": len(active_summary.get("segments") or []),
        "baselineSegmentCount": len(summary.get("segments") or []),
        "manualCount": len(summary.get("matches") or []),
        "liveSimulation": live_simulation,
        "severeOutliers": active_summary.get("severeOutliers") if segment_filter_runtime is not None else baseline_severe_outliers,
        "baselineSevereOutliers": baseline_severe_outliers,
        "segmentFilterSevereOutliers": segment_filter_outliers,
    }


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
                keep_threshold=args.segment_filter_threshold,
                trim_threshold=args.segment_filter_trim_threshold,
                enable_edge_trim=not args.disable_edge_trim_advisor,
            )
        except Exception as error:
            segment_filter_warning = str(error)
            print(f"[batch] segment filter unavailable; fallback to baseline heuristic: {error}", file=sys.stderr)

    samples = build_samples(args)
    skipped = [
        {
            "video": sample.video_key,
            "songCount": sample.song_count,
            "reason": sample.skip_reason,
            "manualPath": str(sample.manual_path) if sample.manual_path else None,
            "audioPath": str(sample.audio_path) if sample.audio_path else None,
            "statsCachePath": str(sample.stats_cache_path) if sample.stats_cache_path else None,
        }
        for sample in samples
        if sample.skip_reason
    ]

    evaluated = []
    failures = []
    runnable = [sample for sample in samples if not sample.skip_reason]
    print(f"[batch] samples={len(samples)} runnable={len(runnable)} skipped={len(skipped)} out={args.out_dir}")
    for index, sample in enumerate(runnable, 1):
        print(f"[batch] {index}/{len(runnable)} {sample.video_key} songs={sample.song_count}")
        try:
            result = evaluate_sample(args, sample, repo_root, segment_filter_runtime)
            evaluated.append(result)
            metrics = result["metrics"]
            print(
                f"[batch] {sample.video_key} f1={float(metrics.get('f1') or 0):.4f} "
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
