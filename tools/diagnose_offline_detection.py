"""Generate FireRed offline detection frames for heuristic tuning.

This diagnostic script mirrors the extension's offline detector up to the
analysis-frame stage, then writes JSON that can be fed into globalSmoothing.js.
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Iterable, List, Sequence

import numpy as np
import onnxruntime as ort

from train_firered_song_head_from_csv import (
    HOP_SEC,
    SAMPLE_RATE,
    FRAME_LENGTH,
    FRAME_SHIFT,
    build_half_second_stats,
    infer_probabilities_for_audio,
    load_cmvn,
    run_onnx_session,
)
from train_firered_temporal_head import build_temporal_features

SPECTRAL_LOW_MAX_HZ = 250.0
SPECTRAL_MID_MAX_HZ = 4000.0
FFT_LENGTH = FRAME_LENGTH


@dataclass
class Segment:
    start: float
    end: float
    title: str


@dataclass
class AudioRecord:
    logical_path: str
    audio_path: Path
    duration_sec: float


def parse_time_token(value: str) -> float:
    parts = [float(part) for part in value.strip().split(":")]
    if len(parts) == 3:
      return (parts[0] * 3600) + (parts[1] * 60) + parts[2]
    if len(parts) == 2:
      return (parts[0] * 60) + parts[1]
    if len(parts) == 1:
      return parts[0]
    raise ValueError(f"Invalid time token: {value!r}")


def format_time(seconds: float) -> str:
    sec = max(0, int(round(seconds)))
    h = sec // 3600
    m = (sec % 3600) // 60
    s = sec % 60
    return f"{h:02d}:{m:02d}:{s:02d}"


def load_manual_segments(path: Path) -> List[Segment]:
    segments: List[Segment] = []
    for line_number, raw_line in enumerate(path.read_text(encoding="utf-8-sig").splitlines(), 1):
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        tokens = line.split()
        if len(tokens) < 3:
            raise ValueError(f"{path}:{line_number}: expected '<start> <end> <title>'")
        start = parse_time_token(tokens[0])
        end = parse_time_token(tokens[1])
        title = " ".join(tokens[2:]).strip()
        if end <= start:
            raise ValueError(f"{path}:{line_number}: end must be after start")
        segments.append(Segment(start, end, title))
    return sorted(segments, key=lambda item: item.start)


def probe_duration(path: Path, ffprobe: str) -> float:
    import subprocess

    proc = subprocess.run(
        [
            ffprobe,
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            str(path),
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    return max(0.0, float(proc.stdout.strip()))


def append_energy_windows(state: Dict[str, object], samples: np.ndarray) -> None:
    pending = state.get("pending")
    if not isinstance(pending, np.ndarray):
        pending = np.zeros(0, dtype=np.float32)
    merged = np.concatenate([pending, samples]) if pending.size else samples
    window_samples = int(round(SAMPLE_RATE * HOP_SEC))
    offset = 0
    while offset + window_samples <= len(merged):
        chunk = merged[offset:offset + window_samples]
        state["rms"].append(float(np.sqrt(np.mean(chunk * chunk))))
        state["peak"].append(float(np.max(np.abs(chunk))) if len(chunk) else 0.0)
        offset += window_samples
    state["pending"] = merged[offset:].copy()


def build_energy_stats(audio_path: Path, ffmpeg: str, chunk_sec: float) -> Dict[str, np.ndarray]:
    from train_firered_song_head_from_csv import iter_ffmpeg_pcm16

    state: Dict[str, object] = {"pending": np.zeros(0, dtype=np.float32), "rms": [], "peak": []}
    for chunk in iter_ffmpeg_pcm16(audio_path, ffmpeg, chunk_sec):
        append_energy_windows(state, chunk)
    return {
        "audio_rms": np.asarray(state["rms"], dtype=np.float32),
        "audio_peak": np.asarray(state["peak"], dtype=np.float32),
    }


def summarize_spectrum(samples: np.ndarray, previous: np.ndarray | None) -> Dict[str, object]:
    if samples.size == 0:
        return {
            "spectral_centroid": 0.0,
            "spectral_flatness": 0.0,
            "spectral_flux": 0.0,
            "low_energy_ratio": 0.0,
            "mid_energy_ratio": 0.0,
            "high_energy_ratio": 0.0,
            "normalized": None,
        }

    frame_count = max(1, min(8, (len(samples) - FFT_LENGTH) // max(1, FFT_LENGTH) + 1))
    frame_step = 0 if frame_count <= 1 else max(1, (len(samples) - FFT_LENGTH) // (frame_count - 1))
    window = np.hanning(FFT_LENGTH).astype(np.float32)
    power = np.zeros((FFT_LENGTH // 2) + 1, dtype=np.float64)
    for index in range(frame_count):
        offset = min(max(0, len(samples) - FFT_LENGTH), index * frame_step)
        frame = np.zeros(FFT_LENGTH, dtype=np.float32)
        available = min(FFT_LENGTH, len(samples) - offset)
        if available > 0:
            frame[:available] = samples[offset:offset + available]
        frame -= float(frame.mean())
        spec = np.fft.rfft(frame * window, n=FFT_LENGTH)
        power += ((spec.real * spec.real) + (spec.imag * spec.imag)) / frame_count

    freqs = np.fft.rfftfreq(FFT_LENGTH, 1.0 / SAMPLE_RATE)
    usable_power = np.maximum(power[1:], 1e-10)
    usable_freqs = freqs[1:]
    total = float(usable_power.sum())
    normalized = (power / max(1e-10, float(power.sum()))).astype(np.float32)
    flux = 0.0
    if previous is not None and len(previous) == len(normalized):
        flux = float(np.clip(np.maximum(0.0, normalized - previous).sum() * 2.0, 0.0, 1.0))

    low = float(usable_power[usable_freqs < SPECTRAL_LOW_MAX_HZ].sum())
    mid = float(usable_power[(usable_freqs >= SPECTRAL_LOW_MAX_HZ) & (usable_freqs < SPECTRAL_MID_MAX_HZ)].sum())
    high = float(usable_power[usable_freqs >= SPECTRAL_MID_MAX_HZ].sum())
    return {
        "spectral_centroid": float(np.clip((usable_power * usable_freqs).sum() / max(1e-10, total) / (SAMPLE_RATE / 2), 0, 1)),
        "spectral_flatness": float(np.clip(np.exp(np.log(usable_power).mean()) / max(1e-10, usable_power.mean()), 0, 1)),
        "spectral_flux": flux,
        "low_energy_ratio": float(np.clip(low / max(1e-10, total), 0, 1)),
        "mid_energy_ratio": float(np.clip(mid / max(1e-10, total), 0, 1)),
        "high_energy_ratio": float(np.clip(high / max(1e-10, total), 0, 1)),
        "normalized": normalized,
    }


def append_spectral_windows(state: Dict[str, object], samples: np.ndarray) -> None:
    pending = state.get("pending")
    if not isinstance(pending, np.ndarray):
        pending = np.zeros(0, dtype=np.float32)
    merged = np.concatenate([pending, samples]) if pending.size else samples
    window_samples = int(round(SAMPLE_RATE * HOP_SEC))
    offset = 0
    while offset + window_samples <= len(merged):
        chunk = merged[offset:offset + window_samples]
        summary = summarize_spectrum(chunk, state.get("previous"))
        state["centroid"].append(float(summary["spectral_centroid"]))
        state["flatness"].append(float(summary["spectral_flatness"]))
        state["flux"].append(float(summary["spectral_flux"]))
        state["low"].append(float(summary["low_energy_ratio"]))
        state["mid"].append(float(summary["mid_energy_ratio"]))
        state["high"].append(float(summary["high_energy_ratio"]))
        state["previous"] = summary["normalized"]
        offset += window_samples
    state["pending"] = merged[offset:].copy()


def build_spectral_stats(audio_path: Path, ffmpeg: str, chunk_sec: float) -> Dict[str, np.ndarray]:
    from train_firered_song_head_from_csv import iter_ffmpeg_pcm16

    state: Dict[str, object] = {
        "pending": np.zeros(0, dtype=np.float32),
        "previous": None,
        "centroid": [],
        "flatness": [],
        "flux": [],
        "low": [],
        "mid": [],
        "high": [],
    }
    for chunk in iter_ffmpeg_pcm16(audio_path, ffmpeg, chunk_sec):
        append_spectral_windows(state, chunk)
    return {
        "spectral_centroid": np.asarray(state["centroid"], dtype=np.float32),
        "spectral_flatness": np.asarray(state["flatness"], dtype=np.float32),
        "spectral_flux": np.asarray(state["flux"], dtype=np.float32),
        "low_energy_ratio": np.asarray(state["low"], dtype=np.float32),
        "mid_energy_ratio": np.asarray(state["mid"], dtype=np.float32),
        "high_energy_ratio": np.asarray(state["high"], dtype=np.float32),
    }


def attach_energy(stats: Dict[str, np.ndarray], energy: Dict[str, np.ndarray]) -> Dict[str, np.ndarray]:
    count = len(stats["time"])
    rms = np.zeros(count, dtype=np.float32)
    peak = np.zeros(count, dtype=np.float32)
    available = min(count, len(energy["audio_rms"]), len(energy["audio_peak"]))
    if available:
        rms[:available] = energy["audio_rms"][:available]
        peak[:available] = energy["audio_peak"][:available]
    stats["audio_rms"] = rms
    stats["audio_peak"] = peak
    return stats


def attach_spectral(stats: Dict[str, np.ndarray], spectral: Dict[str, np.ndarray]) -> Dict[str, np.ndarray]:
    count = len(stats["time"])
    for key in [
        "spectral_centroid",
        "spectral_flatness",
        "spectral_flux",
        "low_energy_ratio",
        "mid_energy_ratio",
        "high_energy_ratio",
    ]:
        values = np.zeros(count, dtype=np.float32)
        source = spectral.get(key, np.zeros(0, dtype=np.float32))
        available = min(count, len(source))
        if available:
            values[:available] = source[:available]
        stats[key] = values
    return stats


def load_npz_stats(path: Path) -> Dict[str, np.ndarray]:
    raw = np.load(path)
    return {key: raw[key] for key in raw.files}


def has_stats_keys(stats: Dict[str, np.ndarray], keys: Sequence[str]) -> bool:
    count = len(stats.get("time", []))
    return all(key in stats and len(stats[key]) >= count for key in keys)


def ensure_diagnostic_stats(
    stats: Dict[str, np.ndarray],
    audio_path: Path,
    ffmpeg: str,
    chunk_sec: float,
) -> Dict[str, np.ndarray]:
    if not has_stats_keys(stats, ["audio_rms", "audio_peak"]):
        print("[cache] adding energy stats")
        stats = attach_energy(stats, build_energy_stats(audio_path, ffmpeg, chunk_sec))
    if not has_stats_keys(stats, [
        "spectral_centroid",
        "spectral_flatness",
        "spectral_flux",
        "low_energy_ratio",
        "mid_energy_ratio",
        "high_energy_ratio",
    ]):
        print("[cache] adding spectral stats")
        stats = attach_spectral(stats, build_spectral_stats(audio_path, ffmpeg, chunk_sec))
    return stats


def run_temporal_head(stats: Dict[str, np.ndarray], model_dir: Path, batch_size: int = 4096) -> Dict[str, object]:
    meta = json.loads((model_dir / "firered_song_head.meta.json").read_text(encoding="utf-8"))
    features, feature_names = build_temporal_features(stats)
    input_dim = int(meta.get("inputDim") or features.shape[1])
    if features.shape[1] != input_dim:
        raise ValueError(f"Temporal head feature mismatch: expected {input_dim}, got {features.shape[1]}")

    session = ort.InferenceSession(str(model_dir / "firered_song_head.onnx"), providers=["CPUExecutionProvider"])
    input_name = str(meta.get("inputName") or session.get_inputs()[0].name)
    output_name = str(meta.get("outputName") or session.get_outputs()[0].name)
    chunks = []
    for start in range(0, len(features), batch_size):
        batch = features[start:start + batch_size].astype(np.float32, copy=False)
        chunks.append(session.run([output_name], {input_name: batch})[0])
    probs = np.concatenate(chunks, axis=0).astype(np.float32)
    if probs.ndim > 1:
        probs = probs.reshape(-1)

    return {
        "probabilities": probs,
        "threshold": float(meta.get("threshold", 0.75)),
        "detectorVersion": str(meta.get("detectorVersion", "firered-song-head-csv-v1")),
        "featureNames": feature_names,
    }


def compute_base_song_probability(stats: Dict[str, np.ndarray], index: int) -> float:
    singing_max = float(stats["singing_max"][index])
    singing_mean = float(stats["singing_mean"][index])
    singing_ratio = float(stats["singing_ratio"][index])
    music_mean = float(stats["music_mean"][index])
    speech_mean = float(stats["speech_mean"][index])
    speech_ratio = float(stats["speech_ratio"][index])
    speech_dominance = max(speech_mean, speech_ratio * 0.8)
    return float(np.clip(
        (singing_max * 0.42)
        + (singing_mean * 0.28)
        + (singing_ratio * 0.18)
        + (min(music_mean, singing_max) * 0.12)
        - (speech_dominance * 0.18),
        0,
        1,
    ))


def build_frames(stats: Dict[str, np.ndarray], temporal: Dict[str, object]) -> List[Dict[str, object]]:
    temporal_probs = temporal["probabilities"]
    threshold = float(temporal["threshold"])
    detector_version = str(temporal["detectorVersion"])
    frames: List[Dict[str, object]] = []
    count = min(len(stats["time"]), len(temporal_probs))
    for index in range(count):
        base = compute_base_song_probability(stats, index)
        temporal_prob = float(temporal_probs[index])
        frames.append({
            "ready": True,
            "timeSec": round(float(stats["time"][index]) + HOP_SEC, 3),
            "songProbability": temporal_prob,
            "baseSongProbability": base,
            "temporalHeadReady": True,
            "temporalHeadProbability": temporal_prob,
            "temporalHeadThreshold": threshold,
            "temporalHeadHistoryWindows": min(index + 1, int(round(120 / HOP_SEC))),
            "speechProbability": float(stats["speech_max"][index]),
            "singingProbability": float(stats["singing_max"][index]),
            "musicProbability": float(stats["music_max"][index]),
            "speechMean": float(stats["speech_mean"][index]),
            "singingMean": float(stats["singing_mean"][index]),
            "musicMean": float(stats["music_mean"][index]),
            "speechRatio": float(stats["speech_ratio"][index]),
            "singingRatio": float(stats["singing_ratio"][index]),
            "musicRatio": float(stats["music_ratio"][index]),
            "audioRms": float(stats["audio_rms"][index]),
            "audioPeak": float(stats["audio_peak"][index]),
            "spectralCentroid": float(stats.get("spectral_centroid", np.zeros(count))[index]),
            "spectralFlatness": float(stats.get("spectral_flatness", np.zeros(count))[index]),
            "spectralFlux": float(stats.get("spectral_flux", np.zeros(count))[index]),
            "lowEnergyRatio": float(stats.get("low_energy_ratio", np.zeros(count))[index]),
            "midEnergyRatio": float(stats.get("mid_energy_ratio", np.zeros(count))[index]),
            "highEnergyRatio": float(stats.get("high_energy_ratio", np.zeros(count))[index]),
            "analyzedAudioSec": round((index + 1) * HOP_SEC, 3),
            "detectorVersion": detector_version,
        })
    return frames


def labels_for_times(times: np.ndarray, segments: Sequence[Segment]) -> np.ndarray:
    labels = np.zeros(len(times), dtype=np.int8)
    for segment in segments:
        labels[(times >= segment.start) & (times < segment.end)] = 1
    return labels


def summarize_values(values: np.ndarray) -> Dict[str, float]:
    if values.size == 0:
        return {"count": 0}
    qs = np.quantile(values, [0.1, 0.25, 0.5, 0.75, 0.9])
    return {
        "count": int(values.size),
        "mean": float(values.mean()),
        "q10": float(qs[0]),
        "q25": float(qs[1]),
        "q50": float(qs[2]),
        "q75": float(qs[3]),
        "q90": float(qs[4]),
    }


def segment_model_summaries(frames: Sequence[Dict[str, object]], segments: Sequence[Segment], threshold: float) -> List[Dict[str, object]]:
    times = np.asarray([float(frame["timeSec"]) for frame in frames], dtype=np.float32)
    temporal = np.asarray([float(frame["temporalHeadProbability"]) for frame in frames], dtype=np.float32)
    singing = np.asarray([float(frame["singingProbability"]) for frame in frames], dtype=np.float32)
    music = np.asarray([float(frame["musicProbability"]) for frame in frames], dtype=np.float32)
    speech = np.asarray([float(frame["speechProbability"]) for frame in frames], dtype=np.float32)
    output = []
    for segment in segments:
        mask = (times >= segment.start) & (times < segment.end)
        probs = temporal[mask]
        below = probs < threshold
        longest_below = 0
        current = 0
        for flag in below:
            if flag:
                current += 1
                longest_below = max(longest_below, current)
            else:
                current = 0
        output.append({
            "title": segment.title,
            "startSec": segment.start,
            "endSec": segment.end,
            "time": f"{format_time(segment.start)}-{format_time(segment.end)}",
            "durationSec": segment.end - segment.start,
            "temporal": summarize_values(probs),
            "temporalAboveThresholdRatio": float((probs >= threshold).mean()) if probs.size else 0.0,
            "longestBelowThresholdSec": longest_below * HOP_SEC,
            "singing": summarize_values(singing[mask]),
            "music": summarize_values(music[mask]),
            "speech": summarize_values(speech[mask]),
        })
    return output


def main() -> None:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser()
    parser.add_argument("--audio", type=Path, required=True)
    parser.add_argument("--manual", type=Path, required=True)
    parser.add_argument("--model-dir", type=Path, default=Path("models/fireredvad/aed"))
    parser.add_argument("--out-dir", type=Path, default=Path("tmp_eval/offline_diagnostics"))
    parser.add_argument("--chunk-sec", type=float, default=120.0)
    parser.add_argument("--stats-cache", type=Path, default=None, help="Reuse AED stats npz, then add energy/spectral diagnostics if missing.")
    parser.add_argument("--rebuild", action="store_true")
    args = parser.parse_args()

    ffmpeg = shutil.which("ffmpeg")
    ffprobe = shutil.which("ffprobe")
    if not ffmpeg or not ffprobe:
        raise FileNotFoundError("ffmpeg and ffprobe are required on PATH")

    args.out_dir.mkdir(parents=True, exist_ok=True)
    stem = args.audio.stem
    stats_path = args.out_dir / f"{stem}.stats.npz"
    frames_path = args.out_dir / f"{stem}.frames.json"
    summary_path = args.out_dir / f"{stem}.model_summary.json"
    manual_segments = load_manual_segments(args.manual)

    duration = probe_duration(args.audio, ffprobe)
    if stats_path.exists() and not args.rebuild:
        stats = load_npz_stats(stats_path)
        print(f"[cache] loaded {stats_path}")
        needs_diagnostic_update = not has_stats_keys(stats, ["audio_rms", "audio_peak"]) or not has_stats_keys(stats, [
            "spectral_centroid",
            "spectral_flatness",
            "spectral_flux",
            "low_energy_ratio",
            "mid_energy_ratio",
            "high_energy_ratio",
        ])
        updated_stats = ensure_diagnostic_stats(stats, args.audio, ffmpeg, args.chunk_sec)
        if needs_diagnostic_update:
            np.savez_compressed(stats_path, **updated_stats)
            print(f"[cache] updated {stats_path} windows={len(updated_stats['time'])}")
        stats = updated_stats
    elif args.stats_cache:
        stats = load_npz_stats(args.stats_cache)
        print(f"[cache] loaded AED stats {args.stats_cache}")
        stats = ensure_diagnostic_stats(stats, args.audio, ffmpeg, args.chunk_sec)
        np.savez_compressed(stats_path, **stats)
        print(f"[cache] saved {stats_path} windows={len(stats['time'])}")
    else:
        record = AudioRecord(logical_path=args.audio.name, audio_path=args.audio, duration_sec=duration)
        cmvn = load_cmvn(args.model_dir / "cmvn.json")
        session = ort.InferenceSession(str(args.model_dir / "model.onnx"), providers=["CPUExecutionProvider"])
        input_name = session.get_inputs()[0].name
        output_name = session.get_outputs()[0].name
        probs = infer_probabilities_for_audio(
            record,
            ffmpeg,
            cmvn,
            session,
            input_name,
            output_name,
            args.chunk_sec,
            30000,
        )
        stats = build_half_second_stats(probs)
        stats = ensure_diagnostic_stats(stats, args.audio, ffmpeg, args.chunk_sec)
        np.savez_compressed(stats_path, **stats)
        print(f"[cache] saved {stats_path} windows={len(stats['time'])}")

    temporal = run_temporal_head(stats, args.model_dir)
    frames = build_frames(stats, temporal)
    payload = {
        "audioPath": str(args.audio),
        "durationSec": duration,
        "hopSec": HOP_SEC,
        "temporalHeadThreshold": temporal["threshold"],
        "detectorVersion": temporal["detectorVersion"],
        "frames": frames,
    }
    frames_path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    print(f"[frames] wrote {frames_path}")

    frame_times = np.asarray([float(frame["timeSec"]) for frame in frames], dtype=np.float32)
    labels = labels_for_times(frame_times, manual_segments)
    temporal_probs = np.asarray([float(frame["temporalHeadProbability"]) for frame in frames], dtype=np.float32)
    summary = {
        "audioPath": str(args.audio),
        "durationSec": duration,
        "manualSegments": [segment.__dict__ for segment in manual_segments],
        "manualPositiveSec": sum(segment.end - segment.start for segment in manual_segments),
        "threshold": temporal["threshold"],
        "overall": {
            "positiveTemporal": summarize_values(temporal_probs[labels == 1]),
            "negativeTemporal": summarize_values(temporal_probs[labels == 0]),
            "positiveAboveThresholdRatio": float((temporal_probs[labels == 1] >= temporal["threshold"]).mean()),
            "negativeAboveThresholdRatio": float((temporal_probs[labels == 0] >= temporal["threshold"]).mean()),
        },
        "segments": segment_model_summaries(frames, manual_segments, float(temporal["threshold"])),
    }
    summary_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[summary] wrote {summary_path}")
    print(json.dumps(summary["overall"], ensure_ascii=False, indent=2))
    for item in summary["segments"]:
        print(
            f"[manual] {item['time']} {item['title']} "
            f"above={item['temporalAboveThresholdRatio']:.3f} "
            f"median={item['temporal'].get('q50', 0):.3f} "
            f"longest_below={item['longestBelowThresholdSec']:.1f}s"
        )


if __name__ == "__main__":
    main()
