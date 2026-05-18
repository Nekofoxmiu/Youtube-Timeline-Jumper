"""Evaluate and tune FireRed AED song-segment rules against a local annotated sample."""

from __future__ import annotations

import argparse
import importlib.util
import json
import math
import sys
import types
import wave
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Iterable, List, Sequence, Tuple

import numpy as np
import onnxruntime as ort

SAMPLE_RATE = 16000
FRAME_LENGTH = 400
FRAME_SHIFT = 160
FFT_LENGTH = 512
FEATURE_DIM = 80
HOP_SEC = 0.5
LABELS = ["speech", "singing", "music"]


@dataclass
class Segment:
    start: float
    end: float
    title: str = ""


def time_to_seconds(value: object) -> float:
    if isinstance(value, (int, float)):
        return max(0.0, float(value))
    if isinstance(value, dict):
        return max(
            0.0,
            float(value.get("hours", 0) or 0) * 3600
            + float(value.get("minutes", 0) or 0) * 60
            + float(value.get("seconds", 0) or 0),
        )
    if isinstance(value, str):
        parts = [float(x) for x in value.split(":")]
        if len(parts) == 3:
            return parts[0] * 3600 + parts[1] * 60 + parts[2]
        if len(parts) == 2:
            return parts[0] * 60 + parts[1]
    return 0.0


def load_annotations(path: Path) -> List[Segment]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(data, dict):
        playlist = next((v for k, v in data.items() if k.startswith("playlist_") and isinstance(v, list)), [])
    elif isinstance(data, list):
        playlist = data
    else:
        playlist = []
    segments = []
    for item in playlist:
        start = time_to_seconds(item.get("start"))
        end = time_to_seconds(item.get("end"))
        if end > start:
            segments.append(Segment(start, end, str(item.get("title", ""))))
    return sorted(segments, key=lambda s: s.start)


def read_wav_mono(path: Path) -> np.ndarray:
    with wave.open(str(path), "rb") as wf:
        if wf.getframerate() != SAMPLE_RATE or wf.getnchannels() != 1 or wf.getsampwidth() != 2:
            raise ValueError("Expected 16kHz mono PCM16 wav. Use ffmpeg conversion first.")
        raw = wf.readframes(wf.getnframes())
    return np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0


def hz_to_mel(hz: float) -> float:
    return 1127.0 * math.log(1.0 + hz / 700.0)


def mel_to_hz(mel: float) -> float:
    return 700.0 * (math.exp(mel / 1127.0) - 1.0)


def build_povey_window(length: int) -> np.ndarray:
    n = np.arange(length, dtype=np.float32)
    hann = 0.5 - 0.5 * np.cos((2.0 * np.pi * n) / (length - 1))
    return np.power(hann, 0.85).astype(np.float32)


def build_mel_filterbank(mel_bins: int = FEATURE_DIM, min_hz: float = 20.0, max_hz: float = 7600.0) -> np.ndarray:
    bin_count = FFT_LENGTH // 2 + 1
    min_mel = hz_to_mel(min_hz)
    max_mel = hz_to_mel(max_hz)
    mel_points = np.linspace(min_mel, max_mel, mel_bins + 2)
    fb = np.zeros((mel_bins, bin_count), dtype=np.float32)
    bin_mels = np.array([hz_to_mel(i * SAMPLE_RATE / FFT_LENGTH) for i in range(bin_count)], dtype=np.float32)
    for m in range(mel_bins):
        left, center, right = mel_points[m], mel_points[m + 1], mel_points[m + 2]
        left_mask = (bin_mels > left) & (bin_mels <= center)
        right_mask = (bin_mels > center) & (bin_mels < right)
        fb[m, left_mask] = (bin_mels[left_mask] - left) / max(1e-6, center - left)
        fb[m, right_mask] = (right - bin_mels[right_mask]) / max(1e-6, right - center)
    return fb


def load_cmvn(path: Path) -> Tuple[np.ndarray, np.ndarray]:
    data = json.loads(path.read_text(encoding="utf-8"))
    return np.asarray(data["means"], dtype=np.float32), np.asarray(data["inverseStdVariances"], dtype=np.float32)


def waveform_to_features(wav: np.ndarray, means: np.ndarray, inv_std: np.ndarray) -> np.ndarray:
    frame_count = (len(wav) - FRAME_LENGTH) // FRAME_SHIFT + 1
    window = build_povey_window(FRAME_LENGTH)
    fb = build_mel_filterbank()
    out = np.empty((frame_count, FEATURE_DIM), dtype=np.float32)
    for i in range(frame_count):
        start = i * FRAME_SHIFT
        frame = wav[start:start + FRAME_LENGTH] * 32768.0
        frame = frame - np.mean(frame)
        pre = np.empty_like(frame)
        pre[0] = frame[0]
        pre[1:] = frame[1:] - 0.97 * frame[:-1]
        spec = np.fft.rfft(pre * window, n=FFT_LENGTH)
        power = (spec.real * spec.real + spec.imag * spec.imag).astype(np.float32)
        mel = np.maximum(np.dot(fb, power), 1e-10)
        out[i] = (np.log(mel) - means) * inv_std
    return out


def load_module_from_path(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Failed to load module {name} from {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def load_official_audio_features(wav_path: Path, firered_src: Path, cmvn_dir: Path) -> np.ndarray:
    root = firered_src.resolve()
    core_dir = root / "fireredasr2s" / "fireredvad" / "core"
    if not (core_dir / "audio_feat.py").exists():
        raise FileNotFoundError(core_dir / "audio_feat.py")

    pkg = types.ModuleType("fireredasr2s")
    pkg.__path__ = [str(root / "fireredasr2s")]
    sys.modules["fireredasr2s"] = pkg

    vad_pkg = types.ModuleType("fireredasr2s.fireredvad")
    vad_pkg.__path__ = [str(root / "fireredasr2s" / "fireredvad")]
    sys.modules["fireredasr2s.fireredvad"] = vad_pkg

    core_pkg = types.ModuleType("fireredasr2s.fireredvad.core")
    core_pkg.__path__ = [str(core_dir)]
    sys.modules["fireredasr2s.fireredvad.core"] = core_pkg

    audio_feat_mod = load_module_from_path(
        "fireredasr2s.fireredvad.core.audio_feat",
        core_dir / "audio_feat.py",
    )
    extractor = audio_feat_mod.AudioFeat(str(cmvn_dir / "cmvn.ark"))
    with wave.open(str(wav_path), "rb") as wf:
        if wf.getframerate() != SAMPLE_RATE or wf.getnchannels() != 1 or wf.getsampwidth() != 2:
            raise ValueError("Expected 16kHz mono PCM16 wav for official feature extraction.")
        wav_np = np.frombuffer(wf.readframes(wf.getnframes()), dtype="<i2")
        duration = wf.getnframes() / wf.getframerate()
    fbank = extractor.fbank((SAMPLE_RATE, wav_np))
    if extractor.cmvn is not None:
        fbank = extractor.cmvn(fbank)
    print(f"[official_features] {tuple(fbank.shape)} dur={duration:.3f}")
    return np.asarray(fbank, dtype=np.float32)


def run_onnx(features: np.ndarray, model_path: Path, chunk_frames: int = 30000) -> np.ndarray:
    session = ort.InferenceSession(str(model_path), providers=["CPUExecutionProvider"])
    input_name = session.get_inputs()[0].name
    output_name = session.get_outputs()[0].name
    chunks = []
    for start in range(0, len(features), chunk_frames):
        chunk = features[start:start + chunk_frames][None, :, :].astype(np.float32, copy=False)
        chunks.append(session.run([output_name], {input_name: chunk})[0][0])
        print(f"[infer] frames {start}-{start + len(chunk[0])}/{len(features)}")
    return np.concatenate(chunks, axis=0).astype(np.float32)


def build_half_second_stats(probs: np.ndarray) -> Dict[str, np.ndarray]:
    frames_per_hop = int(round(HOP_SEC / 0.01))
    n = len(probs) // frames_per_hop
    trimmed = probs[:n * frames_per_hop].reshape(n, frames_per_hop, probs.shape[1])
    speech = trimmed[:, :, 0]
    singing = trimmed[:, :, 1]
    music = trimmed[:, :, 2]
    return {
        "time": np.arange(n, dtype=np.float32) * HOP_SEC,
        "speech_max": speech.max(axis=1),
        "singing_max": singing.max(axis=1),
        "music_max": music.max(axis=1),
        "speech_mean": speech.mean(axis=1),
        "singing_mean": singing.mean(axis=1),
        "music_mean": music.mean(axis=1),
        "speech_ratio": (speech >= 0.55).mean(axis=1),
        "singing_ratio": (singing >= 0.5).mean(axis=1),
        "music_ratio": (music >= 0.45).mean(axis=1),
    }


def build_labels(times: np.ndarray, annotations: Sequence[Segment]) -> np.ndarray:
    labels = np.zeros(len(times), dtype=np.int8)
    for seg in annotations:
        labels[(times >= seg.start) & (times < seg.end)] = 1
    return labels


def smooth_mean(values: np.ndarray, window_sec: float) -> np.ndarray:
    width = max(1, int(round(window_sec / HOP_SEC)))
    kernel = np.ones(width, dtype=np.float32) / width
    return np.convolve(values, kernel, mode="same").astype(np.float32)


def segments_from_binary(binary: np.ndarray, times: np.ndarray) -> List[Segment]:
    segs = []
    start = None
    for i, flag in enumerate(binary):
        if flag and start is None:
            start = float(times[i])
        elif not flag and start is not None:
            segs.append(Segment(start, float(times[i])))
            start = None
    if start is not None:
        segs.append(Segment(start, float(times[-1] + HOP_SEC)))
    return segs


def merge_filter_segments(segs: List[Segment], min_dur: float, merge_gap: float) -> List[Segment]:
    out: List[Segment] = []
    for seg in segs:
        if seg.end - seg.start < min_dur:
            continue
        if out and seg.start - out[-1].end <= merge_gap:
            out[-1].end = max(out[-1].end, seg.end)
        else:
            out.append(Segment(seg.start, seg.end))
    return [seg for seg in out if seg.end - seg.start >= min_dur]


def labels_from_segments(times: np.ndarray, segs: Sequence[Segment]) -> np.ndarray:
    labels = np.zeros(len(times), dtype=np.int8)
    for seg in segs:
        labels[(times >= seg.start) & (times < seg.end)] = 1
    return labels


def metrics(pred: np.ndarray, labels: np.ndarray) -> Dict[str, float]:
    tp = int(((pred == 1) & (labels == 1)).sum())
    fp = int(((pred == 1) & (labels == 0)).sum())
    fn = int(((pred == 0) & (labels == 1)).sum())
    tn = int(((pred == 0) & (labels == 0)).sum())
    precision = tp / max(1, tp + fp)
    recall = tp / max(1, tp + fn)
    f1 = 2 * precision * recall / max(1e-9, precision + recall)
    f05 = (1 + 0.5**2) * precision * recall / max(1e-9, 0.5**2 * precision + recall)
    return {"precision": precision, "recall": recall, "f1": f1, "f0_5": f05, "tp": tp, "fp": fp, "fn": fn, "tn": tn}


def evaluate_rule(stats: Dict[str, np.ndarray], labels: np.ndarray, cfg: Dict[str, float]) -> Tuple[Dict[str, float], List[Segment]]:
    times = stats["time"]
    singing_mean_4 = smooth_mean(stats["singing_max"], 4)
    singing_mean_10 = smooth_mean(stats["singing_max"], 10)
    music_mean_10 = smooth_mean(stats["music_max"], 10)
    speech_mean_6 = smooth_mean(stats["speech_max"], 6)

    anchor = (
        (stats["singing_max"] >= cfg["singing_max"])
        | (singing_mean_4 >= cfg["singing_mean4"])
        | (singing_mean_10 >= cfg["singing_mean10"])
    )
    music = (stats["music_max"] >= cfg["music_max"]) | (music_mean_10 >= cfg["music_mean10"])
    speech_dominant = (speech_mean_6 >= cfg["speech_mean6"]) & (singing_mean_4 < cfg["speech_singing_ceiling"])

    active = np.zeros(len(times), dtype=np.int8)
    in_song = False
    high = 0
    low = 0
    start_idx = 0
    last_anchor_idx = -10**9
    raw_segments: List[Segment] = []

    for i in range(len(times)):
        if anchor[i]:
            last_anchor_idx = i

        recent_anchor = (i - last_anchor_idx) * HOP_SEC <= cfg["anchor_grace"]
        start_signal = anchor[i] and not speech_dominant[i]
        sustain_signal = anchor[i] or (in_song and recent_anchor and music[i] and not speech_dominant[i])

        if not in_song:
            high = high + 1 if start_signal else 0
            if high >= cfg["start_windows"]:
                in_song = True
                back = int(round(cfg["intro_lookback"] / HOP_SEC))
                j = max(0, i - back)
                while j < i and not (music[j] or anchor[j]):
                    j += 1
                start_idx = j
                low = 0
        else:
            if sustain_signal:
                low = 0
            else:
                low += 1
            if low >= cfg["end_windows"]:
                end_idx = max(start_idx + 1, i - int(cfg["end_windows"]) + 1)
                raw_segments.append(Segment(float(times[start_idx]), float(times[end_idx] + HOP_SEC)))
                in_song = False
                high = 0
                low = 0

    if in_song:
        raw_segments.append(Segment(float(times[start_idx]), float(times[-1] + HOP_SEC)))

    segs = merge_filter_segments(raw_segments, cfg["min_dur"], cfg["merge_gap"])
    pred = labels_from_segments(times, segs)
    return metrics(pred, labels), segs


def grid_search(stats: Dict[str, np.ndarray], labels: np.ndarray) -> Tuple[Dict[str, float], Dict[str, float], List[Segment]]:
    best_score = -1.0
    best_cfg: Dict[str, float] = {}
    best_metrics: Dict[str, float] = {}
    best_segs: List[Segment] = []
    for singing_max in [0.78, 0.84, 0.90, 0.94]:
        for singing_mean4 in [0.42, 0.50, 0.58, 0.66]:
            for singing_mean10 in [0.28, 0.36, 0.44, 0.52]:
                for speech_mean6 in [0.45, 0.55, 0.65]:
                    for anchor_grace in [8.0, 12.0, 16.0, 20.0]:
                        for end_windows in [8.0, 12.0, 16.0]:
                            for min_dur in [60.0, 90.0, 120.0]:
                                cfg = {
                                    "singing_max": singing_max,
                                    "singing_mean4": singing_mean4,
                                    "singing_mean10": singing_mean10,
                                    "music_max": 0.65,
                                    "music_mean10": 0.55,
                                    "speech_mean6": speech_mean6,
                                    "speech_singing_ceiling": 0.35,
                                    "anchor_grace": anchor_grace,
                                    "intro_lookback": 10.0,
                                    "start_windows": 2,
                                    "end_windows": end_windows,
                                    "min_dur": min_dur,
                                    "merge_gap": 8.0,
                                }
                                m, segs = evaluate_rule(stats, labels, cfg)
                                if m["recall"] < 0.45:
                                    continue
                                score = m["f0_5"] - max(0, len(segs) - 13) * 0.015
                                if score > best_score:
                                    best_score = score
                                    best_cfg = cfg
                                    best_metrics = m
                                    best_segs = segs
    return best_cfg, best_metrics, best_segs


def print_distribution(stats: Dict[str, np.ndarray], labels: np.ndarray) -> None:
    for key in ["speech_max", "singing_max", "music_max", "speech_mean", "singing_mean", "music_mean"]:
        pos = stats[key][labels == 1]
        neg = stats[key][labels == 0]
        print(f"[dist] {key}")
        for name, values in [("pos", pos), ("neg", neg)]:
            qs = np.quantile(values, [0.1, 0.25, 0.5, 0.75, 0.9]) if len(values) else np.zeros(5)
            print(f"  {name}: mean={values.mean():.4f} q10/25/50/75/90=" + ",".join(f"{x:.4f}" for x in qs))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--wav", type=Path, required=True)
    parser.add_argument("--annotations", type=Path, required=True)
    parser.add_argument("--model-dir", type=Path, default=Path("models/fireredvad/aed"))
    parser.add_argument("--cache", type=Path, default=Path("tmp_eval/firered_probs.npz"))
    parser.add_argument("--out", type=Path, default=Path("tmp_eval/firered_eval_summary.json"))
    parser.add_argument("--fireredasr2s-src", type=Path, default=None)
    parser.add_argument("--official-cmvn-dir", type=Path, default=None)
    parser.add_argument("--official-features", action="store_true")
    args = parser.parse_args()

    annotations = load_annotations(args.annotations)
    print(f"[annotations] {len(annotations)} segments, positive_sec={sum(s.end-s.start for s in annotations):.1f}")

    if args.cache.exists():
        probs = np.load(args.cache)["probs"]
        print(f"[cache] loaded {args.cache} shape={probs.shape}")
    else:
        if args.official_features:
            if args.fireredasr2s_src is None:
                raise ValueError("--official-features requires --fireredasr2s-src")
            features = load_official_audio_features(
                args.wav,
                args.fireredasr2s_src,
                args.official_cmvn_dir or args.model_dir,
            )
        else:
            wav = read_wav_mono(args.wav)
            means, inv_std = load_cmvn(args.model_dir / "cmvn.json")
            features = waveform_to_features(wav, means, inv_std)
        print(f"[features] {features.shape}")
        probs = run_onnx(features, args.model_dir / "model.onnx")
        args.cache.parent.mkdir(parents=True, exist_ok=True)
        np.savez_compressed(args.cache, probs=probs)
        print(f"[cache] saved {args.cache}")

    stats = build_half_second_stats(probs)
    labels = build_labels(stats["time"], annotations)
    print_distribution(stats, labels)
    cfg, m, segs = grid_search(stats, labels)
    print("[best_cfg]", json.dumps(cfg, ensure_ascii=False, indent=2))
    print("[best_metrics]", json.dumps(m, ensure_ascii=False, indent=2))
    print("[segments]")
    for seg in segs:
        print(f"  {seg.start:.1f}-{seg.end:.1f} dur={seg.end-seg.start:.1f}")

    payload = {
        "bestConfig": cfg,
        "metrics": m,
        "segments": [{"startSec": s.start, "endSec": s.end, "durationSec": s.end - s.start} for s in segs],
        "annotations": [{"startSec": s.start, "endSec": s.end, "title": s.title} for s in annotations],
    }
    args.out.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[done] wrote {args.out}")


if __name__ == "__main__":
    main()
