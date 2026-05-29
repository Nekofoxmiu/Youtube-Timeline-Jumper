"""Shared feature extraction for the experimental segment filter model."""

from __future__ import annotations

import math
from typing import Dict, Iterable, List, Optional, Sequence, Tuple

SEGMENT_FILTER_VERSION = "segment-filter-v2"

SEGMENT_FILTER_FEATURE_NAMES: List[str] = [
    "duration_sec",
    "confidence",
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
    "spectral_flatness_p50",
    "spectral_flatness_p90",
    "spectral_flux_mean",
    "spectral_flux_p50",
    "spectral_flux_p90",
    "mid_energy_ratio_mean",
    "mid_energy_ratio_p50",
    "mid_energy_ratio_p90",
    "low_energy_ratio_mean",
    "low_energy_ratio_p90",
    "start_reset_ratio",
    "start_speech_reset_ratio",
    "start_low_energy_ratio",
    "start_music_mean",
    "start_singing_mean",
    "start_speech_mean",
    "end_reset_ratio",
    "end_speech_reset_ratio",
    "end_low_energy_ratio",
    "end_music_mean",
    "end_singing_mean",
    "end_speech_mean",
    "model_only_fallback",
    "tracker_segment",
    "fallback_segment",
    "selected_model_fallback_segment",
    "music_only_extra_score",
    "frame_count",
    "relative_start",
    "relative_end",
    "baseline_frame_count",
    "baseline_temporal_mean",
    "baseline_temporal_p90",
    "baseline_singing_mean",
    "baseline_singing_p90",
    "baseline_music_mean",
    "baseline_music_p90",
    "baseline_speech_mean",
    "baseline_speech_p90",
    "baseline_audio_rms_mean",
    "baseline_audio_rms_p90",
    "baseline_spectral_flatness_mean",
    "baseline_spectral_flux_mean",
    "segment_temporal_vs_baseline",
    "segment_singing_vs_baseline",
    "segment_music_vs_baseline",
    "segment_speech_vs_baseline",
    "segment_rms_vs_baseline",
]

DEFAULT_FEATURE_OPTIONS = {
    "edge_window_sec": 20.0,
    "low_energy_rms_threshold": 0.006,
    "low_energy_peak_threshold": 0.025,
    "low_energy_ratio_threshold": 0.72,
    "speech_reset_threshold": 0.58,
    "speech_reset_singing_ceiling": 0.38,
    "speech_reset_music_ceiling": 0.72,
    "hard_trim_min_silence_sec": 1.0,
    "hard_trim_speech_mean_threshold": 0.58,
    "hard_trim_speech_p90_threshold": 0.72,
    "hard_trim_speech_singing_ceiling": 0.38,
    "hard_trim_music_change_threshold": 0.28,
    "hard_trim_music_change_min_song_mean": 0.55,
    "hard_trim_music_change_max_edge_song_mean": 0.48,
    "baseline_min_duration_sec": 600.0,
    "baseline_short_window_sec": 300.0,
    "baseline_long_window_sec": 600.0,
    "baseline_min_frames": 120.0,
}

DEFAULT_FILTER_POLICY = {
    "keep_threshold": 0.35,
    "trim_confidence_threshold": 0.55,
    "trim_clamp_sec": 60.0,
    "trim_scale": 0.75,
    "min_segment_duration_sec": 90.0,
}

DEFAULT_BASELINE_STATS = {
    "frameCount": 0.0,
    "temporalMean": 0.5,
    "temporalP90": 0.5,
    "singingMean": 0.2,
    "singingP90": 0.2,
    "musicMean": 0.5,
    "musicP90": 0.5,
    "speechMean": 0.2,
    "speechP90": 0.2,
    "audioRmsMean": 0.02,
    "audioRmsP90": 0.04,
    "spectralFlatnessMean": 0.08,
    "spectralFluxMean": 0.35,
}


def clamp(value: object, lo: float, hi: float) -> float:
    try:
        num = float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return lo
    if not math.isfinite(num):
        return lo
    return min(hi, max(lo, num))


def finite(value: object, fallback: float = 0.0) -> float:
    try:
        num = float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return fallback
    return num if math.isfinite(num) else fallback


def quantile(values: Sequence[float], q: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(float(v) for v in values)
    pos = (len(ordered) - 1) * q
    base = int(math.floor(pos))
    rest = pos - base
    if base + 1 >= len(ordered):
        return ordered[base]
    return ordered[base] + rest * (ordered[base + 1] - ordered[base])


def mean(values: Sequence[float]) -> float:
    return sum(values) / len(values) if values else 0.0


def std(values: Sequence[float]) -> float:
    if len(values) <= 1:
        return 0.0
    avg = mean(values)
    return math.sqrt(max(0.0, mean([(value - avg) ** 2 for value in values])))


def ratio(items: Sequence[Dict[str, float]], predicate) -> float:
    if not items:
        return 0.0
    return sum(1 for item in items if predicate(item)) / len(items)


def normalize_frame(frame: Dict[str, object]) -> Optional[Dict[str, float]]:
    time_sec = finite(frame.get("timeSec"), float("nan"))
    if not math.isfinite(time_sec):
        return None
    return {
        "timeSec": time_sec,
        "songProbability": clamp(frame.get("temporalHeadProbability", frame.get("songProbability", 0.0)), 0.0, 1.0),
        "temporalHeadThreshold": clamp(frame.get("temporalHeadThreshold", 0.75), 0.05, 0.95),
        "singingProbability": clamp(frame.get("singingProbability", frame.get("singingMean", 0.0)), 0.0, 1.0),
        "musicProbability": clamp(frame.get("musicProbability", frame.get("musicMean", 0.0)), 0.0, 1.0),
        "speechProbability": clamp(frame.get("speechProbability", frame.get("speechMean", 0.0)), 0.0, 1.0),
        "singingRatio": clamp(frame.get("singingRatio", 0.0), 0.0, 1.0),
        "musicRatio": clamp(frame.get("musicRatio", 0.0), 0.0, 1.0),
        "speechRatio": clamp(frame.get("speechRatio", 0.0), 0.0, 1.0),
        "audioRms": max(0.0, finite(frame.get("audioRms"), 0.0)),
        "audioPeak": max(0.0, finite(frame.get("audioPeak"), 0.0)),
        "spectralFlatness": clamp(frame.get("spectralFlatness", 0.0), 0.0, 1.0),
        "spectralFlux": clamp(frame.get("spectralFlux", 0.0), 0.0, 1.0),
        "midEnergyRatio": clamp(frame.get("midEnergyRatio", 0.0), 0.0, 1.0),
        "lowEnergyRatio": clamp(frame.get("lowEnergyRatio", 0.0), 0.0, 1.0),
    }


def normalize_frames(frames: Sequence[Dict[str, object]]) -> List[Dict[str, float]]:
    normalized = [item for item in (normalize_frame(frame) for frame in frames) if item is not None]
    return sorted(normalized, key=lambda frame: frame["timeSec"])


def frames_in_range(frames: Sequence[Dict[str, float]], start_sec: float, end_sec: float) -> List[Dict[str, float]]:
    return [frame for frame in frames if start_sec <= frame["timeSec"] <= end_sec]


def values(frames: Sequence[Dict[str, float]], key: str) -> List[float]:
    return [finite(frame.get(key), 0.0) for frame in frames]


def low_energy(frame: Dict[str, float], options: Dict[str, float]) -> bool:
    return (
        frame["audioRms"] <= options["low_energy_rms_threshold"]
        or frame["audioPeak"] <= options["low_energy_peak_threshold"]
        or frame["lowEnergyRatio"] >= options["low_energy_ratio_threshold"]
    )


def strict_silent(frame: Dict[str, float], options: Dict[str, float]) -> bool:
    return (
        frame["audioRms"] <= options["low_energy_rms_threshold"]
        and frame["audioPeak"] <= options["low_energy_peak_threshold"]
    )


def speech_reset(frame: Dict[str, float], options: Dict[str, float]) -> bool:
    return (
        frame["speechProbability"] >= options["speech_reset_threshold"]
        and frame["singingProbability"] <= options["speech_reset_singing_ceiling"]
        and frame["musicProbability"] <= options["speech_reset_music_ceiling"]
    )


def edge_stats(frames: Sequence[Dict[str, float]], edge_sec: float, options: Dict[str, float]) -> Dict[str, float]:
    edge_frames = frames_in_range(frames, edge_sec - options["edge_window_sec"], edge_sec + options["edge_window_sec"])
    return {
        "resetRatio": ratio(edge_frames, lambda frame: low_energy(frame, options) or speech_reset(frame, options)),
        "speechResetRatio": ratio(edge_frames, lambda frame: speech_reset(frame, options)),
        "lowEnergyRatio": ratio(edge_frames, lambda frame: low_energy(frame, options)),
        "musicMean": mean(values(edge_frames, "musicProbability")),
        "singingMean": mean(values(edge_frames, "singingProbability")),
        "speechMean": mean(values(edge_frames, "speechProbability")),
    }


def max_run_duration_sec(frames: Sequence[Dict[str, float]], predicate, hop_sec: float = 0.5) -> float:
    current = 0.0
    best = 0.0
    for frame in frames:
        if predicate(frame):
            current += hop_sec
            best = max(best, current)
        else:
            current = 0.0
    return best


def hard_trim_evidence(
    edge_frames: Sequence[Dict[str, float]],
    song_side_frames: Sequence[Dict[str, float]],
    options: Dict[str, float],
) -> Dict[str, object]:
    speech_mean = mean(values(edge_frames, "speechProbability"))
    speech_p90 = quantile(values(edge_frames, "speechProbability"), 0.9)
    singing_mean = mean(values(edge_frames, "singingProbability"))
    music_mean = mean(values(edge_frames, "musicProbability"))
    temporal_mean = mean(values(edge_frames, "songProbability"))
    silence_run_sec = max_run_duration_sec(edge_frames, lambda frame: strict_silent(frame, options))
    clear_speech = (
        (speech_mean >= options["hard_trim_speech_mean_threshold"] or speech_p90 >= options["hard_trim_speech_p90_threshold"])
        and singing_mean <= options["hard_trim_speech_singing_ceiling"]
    )
    sustained_silence = silence_run_sec >= options["hard_trim_min_silence_sec"]
    song_music_mean = mean(values(song_side_frames, "musicProbability"))
    song_temporal_mean = mean(values(song_side_frames, "songProbability"))
    song_singing_mean = mean(values(song_side_frames, "singingProbability"))
    song_rms_mean = mean(values(song_side_frames, "audioRms"))
    edge_rms_mean = mean(values(edge_frames, "audioRms"))
    song_flux_mean = mean(values(song_side_frames, "spectralFlux"))
    edge_flux_mean = mean(values(edge_frames, "spectralFlux"))
    song_flatness_mean = mean(values(song_side_frames, "spectralFlatness"))
    edge_flatness_mean = mean(values(edge_frames, "spectralFlatness"))
    song_side_strong = (
        song_music_mean >= options["hard_trim_music_change_min_song_mean"]
        or song_temporal_mean >= options["hard_trim_music_change_min_song_mean"]
        or song_singing_mean >= options["hard_trim_music_change_min_song_mean"]
    )
    probability_change = max(
        abs(song_music_mean - music_mean),
        abs(song_temporal_mean - temporal_mean),
        abs(song_singing_mean - singing_mean),
    )
    spectral_change = max(abs(song_flux_mean - edge_flux_mean), abs(song_flatness_mean - edge_flatness_mean))
    energy_change = abs(song_rms_mean - edge_rms_mean) / max(0.01, song_rms_mean, edge_rms_mean)
    edge_looks_weak = (
        music_mean <= options["hard_trim_music_change_max_edge_song_mean"]
        and temporal_mean <= options["hard_trim_music_change_max_edge_song_mean"]
    )
    music_change = (
        song_side_strong
        and edge_looks_weak
        and max(probability_change, spectral_change, energy_change * 0.5) >= options["hard_trim_music_change_threshold"]
    )
    reason = "ambiguous-edge"
    if clear_speech:
        reason = "clear-speech"
    elif sustained_silence:
        reason = "sustained-silence"
    elif music_change:
        reason = "music-property-change"
    return {
        "pass": bool(clear_speech or sustained_silence or music_change),
        "reason": reason,
        "clearSpeech": bool(clear_speech),
        "sustainedSilence": bool(sustained_silence),
        "musicChange": bool(music_change),
        "silenceRunSec": round(silence_run_sec, 3),
        "probabilityChange": round(probability_change, 4),
        "spectralChange": round(spectral_change, 4),
        "energyChange": round(energy_change, 4),
    }


def middle_baseline_stats(frames: Sequence[Dict[str, float]], end_sec: float, options: Dict[str, float]) -> Dict[str, float]:
    if end_sec < options["baseline_min_duration_sec"]:
        return dict(DEFAULT_BASELINE_STATS)
    window_sec = options["baseline_long_window_sec"] if end_sec >= options["baseline_long_window_sec"] * 2.0 else options["baseline_short_window_sec"]
    midpoint = end_sec / 2.0
    start_sec = max(0.0, midpoint - (window_sec / 2.0))
    stop_sec = min(end_sec, start_sec + window_sec)
    baseline_frames = frames_in_range(frames, start_sec, stop_sec)
    if len(baseline_frames) < int(options["baseline_min_frames"]):
        return dict(DEFAULT_BASELINE_STATS)
    temporal = values(baseline_frames, "songProbability")
    singing = values(baseline_frames, "singingProbability")
    music = values(baseline_frames, "musicProbability")
    speech = values(baseline_frames, "speechProbability")
    rms = values(baseline_frames, "audioRms")
    flatness = values(baseline_frames, "spectralFlatness")
    flux = values(baseline_frames, "spectralFlux")
    return {
        "frameCount": float(len(baseline_frames)),
        "temporalMean": mean(temporal),
        "temporalP90": quantile(temporal, 0.9),
        "singingMean": mean(singing),
        "singingP90": quantile(singing, 0.9),
        "musicMean": mean(music),
        "musicP90": quantile(music, 0.9),
        "speechMean": mean(speech),
        "speechP90": quantile(speech, 0.9),
        "audioRmsMean": mean(rms),
        "audioRmsP90": quantile(rms, 0.9),
        "spectralFlatnessMean": mean(flatness),
        "spectralFluxMean": mean(flux),
    }


def overlap_seconds(left: Dict[str, object], right: Dict[str, object]) -> float:
    return max(0.0, min(finite(left.get("endSec")), finite(right.get("endSec"))) - max(finite(left.get("startSec")), finite(right.get("startSec"))))


def best_overlap_ratio(segment: Dict[str, object], candidates: Optional[Sequence[Dict[str, object]]]) -> float:
    duration = max(0.001, finite(segment.get("endSec")) - finite(segment.get("startSec")))
    best = 0.0
    for candidate in candidates or []:
        best = max(best, overlap_seconds(segment, candidate) / duration)
    return best


def context_flags(segment: Dict[str, object], context: Dict[str, object]) -> Dict[str, float]:
    tracker_ratio = best_overlap_ratio(segment, context.get("trackerSegments") if isinstance(context.get("trackerSegments"), list) else [])
    selected_ratio = best_overlap_ratio(segment, context.get("selectedModelFallbackSegments") if isinstance(context.get("selectedModelFallbackSegments"), list) else [])
    fallback_ratio = best_overlap_ratio(segment, context.get("fallbackSegments") if isinstance(context.get("fallbackSegments"), list) else [])
    model_ratio = best_overlap_ratio(segment, context.get("modelRunSegments") if isinstance(context.get("modelRunSegments"), list) else [])
    return {
        "trackerSegment": 1.0 if tracker_ratio >= 0.2 else 0.0,
        "selectedModelFallbackSegment": 1.0 if selected_ratio >= 0.2 else 0.0,
        "fallbackSegment": 1.0 if fallback_ratio >= 0.2 else 0.0,
        "modelOnlyFallback": 1.0 if selected_ratio >= 0.2 or (model_ratio >= 0.45 and tracker_ratio < 0.15) else 0.0,
    }


def build_segment_filter_feature_vector(
    segment: Dict[str, object],
    frames: Sequence[Dict[str, object]],
    context: Optional[Dict[str, object]] = None,
    options: Optional[Dict[str, float]] = None,
) -> List[float]:
    opts = {**DEFAULT_FEATURE_OPTIONS, **(options or {})}
    ctx = context or {}
    normalized_frames = normalize_frames(frames)
    start_sec = max(0.0, finite(segment.get("startSec"), 0.0))
    end_sec = max(start_sec, finite(segment.get("endSec"), start_sec))
    duration_sec = max(0.0, end_sec - start_sec)
    segment_frames = frames_in_range(normalized_frames, start_sec, end_sec)
    safe_frames = segment_frames or frames_in_range(normalized_frames, start_sec - 1.0, end_sec + 1.0)

    temporal = values(safe_frames, "songProbability")
    singing = values(safe_frames, "singingProbability")
    music = values(safe_frames, "musicProbability")
    speech = values(safe_frames, "speechProbability")
    singing_ratio = values(safe_frames, "singingRatio")
    music_ratio = values(safe_frames, "musicRatio")
    speech_ratio = values(safe_frames, "speechRatio")
    audio_rms = values(safe_frames, "audioRms")
    audio_peak = values(safe_frames, "audioPeak")
    spectral_flatness = values(safe_frames, "spectralFlatness")
    spectral_flux = values(safe_frames, "spectralFlux")
    mid_energy = values(safe_frames, "midEnergyRatio")
    low_energy_values = values(safe_frames, "lowEnergyRatio")
    threshold = mean(values(safe_frames, "temporalHeadThreshold")) or finite(ctx.get("temporalHeadThreshold"), 0.75)
    start_edge = edge_stats(normalized_frames, start_sec, opts)
    end_edge = edge_stats(normalized_frames, end_sec, opts)
    flags = context_flags(segment, ctx)
    last_frame_time = normalized_frames[-1]["timeSec"] if normalized_frames else end_sec
    end_boundary = max(end_sec, finite(ctx.get("endSec"), last_frame_time))
    baseline = middle_baseline_stats(normalized_frames, end_boundary, opts)
    music_mean = mean(music)
    singing_mean = mean(singing)
    speech_mean = mean(speech)
    temporal_mean = mean(temporal)
    rms_mean = mean(audio_rms)
    music_only_extra_score = clamp((music_mean - (singing_mean * 1.7) - (speech_mean * 1.15) + (0.12 if duration_sec >= 180.0 else 0.0)) / 0.75, 0.0, 1.0)

    return [
        duration_sec,
        clamp(segment.get("confidence", 0.0), 0.0, 1.0),
        temporal_mean,
        quantile(temporal, 0.1),
        quantile(temporal, 0.5),
        quantile(temporal, 0.9),
        std(temporal),
        ratio(safe_frames, lambda frame: frame["songProbability"] >= threshold),
        singing_mean,
        quantile(singing, 0.5),
        quantile(singing, 0.9),
        mean(singing_ratio),
        quantile(singing_ratio, 0.9),
        music_mean,
        quantile(music, 0.5),
        quantile(music, 0.9),
        mean(music_ratio),
        quantile(music_ratio, 0.9),
        speech_mean,
        quantile(speech, 0.5),
        quantile(speech, 0.9),
        mean(speech_ratio),
        quantile(speech_ratio, 0.9),
        rms_mean,
        quantile(audio_rms, 0.5),
        quantile(audio_rms, 0.9),
        mean(audio_peak),
        quantile(audio_peak, 0.9),
        mean(spectral_flatness),
        quantile(spectral_flatness, 0.5),
        quantile(spectral_flatness, 0.9),
        mean(spectral_flux),
        quantile(spectral_flux, 0.5),
        quantile(spectral_flux, 0.9),
        mean(mid_energy),
        quantile(mid_energy, 0.5),
        quantile(mid_energy, 0.9),
        mean(low_energy_values),
        quantile(low_energy_values, 0.9),
        start_edge["resetRatio"],
        start_edge["speechResetRatio"],
        start_edge["lowEnergyRatio"],
        start_edge["musicMean"],
        start_edge["singingMean"],
        start_edge["speechMean"],
        end_edge["resetRatio"],
        end_edge["speechResetRatio"],
        end_edge["lowEnergyRatio"],
        end_edge["musicMean"],
        end_edge["singingMean"],
        end_edge["speechMean"],
        flags["modelOnlyFallback"],
        flags["trackerSegment"],
        flags["fallbackSegment"],
        flags["selectedModelFallbackSegment"],
        music_only_extra_score,
        float(len(safe_frames)),
        start_sec / end_boundary if end_boundary > 0 else 0.0,
        end_sec / end_boundary if end_boundary > 0 else 0.0,
        baseline["frameCount"],
        baseline["temporalMean"],
        baseline["temporalP90"],
        baseline["singingMean"],
        baseline["singingP90"],
        baseline["musicMean"],
        baseline["musicP90"],
        baseline["speechMean"],
        baseline["speechP90"],
        baseline["audioRmsMean"],
        baseline["audioRmsP90"],
        baseline["spectralFlatnessMean"],
        baseline["spectralFluxMean"],
        temporal_mean - baseline["temporalMean"],
        singing_mean - baseline["singingMean"],
        music_mean - baseline["musicMean"],
        speech_mean - baseline["speechMean"],
        rms_mean - baseline["audioRmsMean"],
    ]


def build_segment_filter_feature_matrix(
    segments: Sequence[Dict[str, object]],
    frames: Sequence[Dict[str, object]],
    context: Optional[Dict[str, object]] = None,
    options: Optional[Dict[str, float]] = None,
) -> List[List[float]]:
    return [build_segment_filter_feature_vector(segment, frames, context, options) for segment in segments]


def apply_segment_filter_predictions(
    segments: Sequence[Dict[str, object]],
    predictions: Sequence[Dict[str, float]],
    *,
    frames: Optional[Sequence[Dict[str, object]]] = None,
    start_sec: float = 0.0,
    end_sec: Optional[float] = None,
    keep_threshold: float = DEFAULT_FILTER_POLICY["keep_threshold"],
    trim_confidence_threshold: float = DEFAULT_FILTER_POLICY["trim_confidence_threshold"],
    trim_clamp_sec: float = DEFAULT_FILTER_POLICY["trim_clamp_sec"],
    trim_scale: float = DEFAULT_FILTER_POLICY["trim_scale"],
    min_segment_duration_sec: float = DEFAULT_FILTER_POLICY["min_segment_duration_sec"],
    allow_start_trim: bool = True,
    allow_end_trim: bool = True,
) -> Tuple[List[Dict[str, object]], List[Dict[str, object]]]:
    normalized_frames = normalize_frames(frames or [])
    feature_options = dict(DEFAULT_FEATURE_OPTIONS)
    sorted_items = sorted(
        [(index, dict(segment), predictions[index] if index < len(predictions) else {}) for index, segment in enumerate(segments)],
        key=lambda item: finite(item[1].get("startSec")),
    )
    kept: List[Dict[str, object]] = []
    adjustments: List[Dict[str, object]] = []
    effective_end = end_sec if end_sec is not None else (finite(sorted_items[-1][1].get("endSec")) if sorted_items else start_sec)

    for sorted_index, (original_index, segment, prediction) in enumerate(sorted_items):
        original = {
            **segment,
            "startSec": round(max(0.0, finite(segment.get("startSec"))), 3),
            "endSec": round(max(finite(segment.get("startSec")), finite(segment.get("endSec"))), 3),
            "confidence": round(clamp(segment.get("confidence", 0.0), 0.0, 1.0), 3),
            "provisional": False,
        }
        keep_probability = clamp(prediction.get("keepProbability", prediction.get("keep_probability", prediction.get("keep", 1.0))), 0.0, 1.0)
        start_delta = clamp(prediction.get("startTrimDeltaSec", prediction.get("start_delta_sec", 0.0)), -trim_clamp_sec, trim_clamp_sec) * trim_scale
        end_delta = clamp(prediction.get("endTrimDeltaSec", prediction.get("end_delta_sec", 0.0)), -trim_clamp_sec, trim_clamp_sec) * trim_scale
        start_trim_evidence = None
        end_trim_evidence = None
        if normalized_frames and end_delta < 0:
            proposed_end = original["endSec"] + end_delta
            edge_frames = frames_in_range(normalized_frames, proposed_end, original["endSec"])
            if len(edge_frames) >= 4:
                song_side_window = max(feature_options["edge_window_sec"], original["endSec"] - proposed_end)
                song_side_frames = frames_in_range(normalized_frames, proposed_end - song_side_window, proposed_end)
                end_trim_evidence = hard_trim_evidence(edge_frames, song_side_frames, feature_options)
                music = values(edge_frames, "musicProbability")
                singing = values(edge_frames, "singingProbability")
                speech = values(edge_frames, "speechProbability")
                temporal = values(edge_frames, "songProbability")
                low_energy_values = values(edge_frames, "lowEnergyRatio")
                trim_duration_sec = max(0.0, original["endSec"] - proposed_end)
                music_mean = mean(music)
                music_p90 = quantile(music, 0.9)
                singing_mean = mean(singing)
                singing_p90 = quantile(singing, 0.9)
                speech_mean = mean(speech)
                temporal_mean = mean(temporal)
                temporal_p90 = quantile(temporal, 0.9)
                low_energy_mean = mean(low_energy_values)
                strong_song_tail = (
                    temporal_mean >= 0.5
                    or temporal_p90 >= 0.72
                    or singing_mean >= 0.35
                    or singing_p90 >= 0.75
                )
                music_backed_vocal_tail = music_mean >= 0.88 and (singing_mean >= 0.24 or singing_p90 >= 0.6)
                protected_song_tail = strong_song_tail or music_backed_vocal_tail
                clear_speech_tail = (
                    (speech_mean >= 0.5 or bool(end_trim_evidence.get("clearSpeech")))
                    and not music_backed_vocal_tail
                )
                sustained_silence_tail = bool(end_trim_evidence.get("sustainedSilence")) or (low_energy_mean >= 0.7 and temporal_p90 <= 0.5)
                weak_non_song_tail = music_mean <= 0.35 and temporal_mean <= 0.35 and singing_p90 <= 0.58
                low_confidence_speech_reset = speech_mean >= 0.38 and singing_mean <= 0.32 and music_p90 <= 0.58
                long_ambiguous_music_change_trim = (
                    trim_duration_sec > 25.0
                    and bool(end_trim_evidence.get("musicChange"))
                    and not clear_speech_tail
                    and not sustained_silence_tail
                    and not low_confidence_speech_reset
                )
                clear_non_song_tail = (
                    clear_speech_tail
                    or sustained_silence_tail
                    or (
                        weak_non_song_tail
                        and not long_ambiguous_music_change_trim
                        and (bool(end_trim_evidence.get("musicChange")) or low_confidence_speech_reset or low_energy_mean >= 0.45)
                    )
                )
                end_trim_pass = (
                    (not protected_song_tail)
                    or clear_speech_tail
                    or low_confidence_speech_reset
                    or (clear_non_song_tail and temporal_p90 <= 0.55 and singing_p90 <= 0.62)
                )
                end_trim_evidence.update({
                    "pass": bool(end_trim_pass),
                    "clearNonSongTail": bool(clear_non_song_tail),
                    "lowConfidenceSpeechReset": bool(low_confidence_speech_reset),
                    "weakNonSongTail": bool(weak_non_song_tail),
                    "strongSongTail": bool(strong_song_tail),
                    "musicBackedVocalTail": bool(music_backed_vocal_tail),
                    "longAmbiguousMusicChangeTrim": bool(long_ambiguous_music_change_trim),
                    "musicMean": round(music_mean, 4),
                    "musicP90": round(music_p90, 4),
                    "singingMean": round(singing_mean, 4),
                    "singingP90": round(singing_p90, 4),
                    "speechMean": round(speech_mean, 4),
                    "temporalMean": round(temporal_mean, 4),
                    "temporalP90": round(temporal_p90, 4),
                    "lowEnergyMean": round(low_energy_mean, 4),
                    "trimDurationSec": round(trim_duration_sec, 3),
                })
                if not end_trim_pass:
                    end_delta = 0.0
        if keep_probability < keep_threshold:
            adjustments.append({"index": original_index, "action": "drop", "keepProbability": round(keep_probability, 4), "original": original})
            continue

        next_segment = dict(original)
        if keep_probability >= trim_confidence_threshold:
            previous_end = finite(kept[-1].get("endSec"), start_sec) if kept else start_sec
            next_start = finite(sorted_items[sorted_index + 1][1].get("startSec"), effective_end) if sorted_index + 1 < len(sorted_items) else effective_end
            proposed_start = original["startSec"] + start_delta if allow_start_trim else original["startSec"]
            proposed_end = original["endSec"] + end_delta if allow_end_trim else original["endSec"]
            proposed_start = clamp(proposed_start, previous_end, max(previous_end, next_start - min_segment_duration_sec))
            proposed_end = clamp(proposed_end, proposed_start + min_segment_duration_sec, next_start)
            if proposed_end - proposed_start >= min_segment_duration_sec:
                next_segment["startSec"] = round(proposed_start, 3)
                next_segment["endSec"] = round(proposed_end, 3)
        kept.append(next_segment)
        adjustments.append({
            "index": original_index,
            "action": "trim" if next_segment["startSec"] != original["startSec"] or next_segment["endSec"] != original["endSec"] else "keep",
            "keepProbability": round(keep_probability, 4),
            "startTrimDeltaSec": round(start_delta, 3),
            "endTrimDeltaSec": round(end_delta, 3),
            "startTrimApplied": allow_start_trim,
            "endTrimApplied": allow_end_trim,
            "startTrimEvidence": start_trim_evidence,
            "endTrimEvidence": end_trim_evidence,
            "original": original,
            "segment": next_segment,
        })
    return kept, adjustments
