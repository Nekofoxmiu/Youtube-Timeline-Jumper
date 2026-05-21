"""Train a FireRed AED temporal song head from labeled CSV annotations.

This is intentionally separate from older YAMNet experiments. It uses the
FireRed AED ONNX asset already exported for the extension, converts local audio
to FireRed event probabilities, then trains a small causal temporal head.
"""

from __future__ import annotations

import argparse
import csv
import json
import re
import shutil
import subprocess
import sys
import time
import wave
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Iterable, List, Sequence, Tuple

import numpy as np
import onnxruntime as ort
import torch
from torch import nn

from evaluate_firered_aed_sample import (
    FEATURE_DIM,
    FRAME_LENGTH,
    FRAME_SHIFT,
    HOP_SEC,
    SAMPLE_RATE,
    build_half_second_stats,
    build_mel_filterbank,
    build_povey_window,
    load_cmvn,
    metrics,
)
from train_firered_temporal_head import build_temporal_features


@dataclass(frozen=True)
class Segment:
    start: float
    end: float


@dataclass(frozen=True)
class AnnotationGroup:
    song_segments: Tuple[Segment, ...]
    non_song_segments: Tuple[Segment, ...]
    ignore_segments: Tuple[Segment, ...]


@dataclass(frozen=True)
class AudioRecord:
    logical_path: str
    audio_path: Path
    duration_sec: float
    song_segments: Tuple[Segment, ...]
    non_song_segments: Tuple[Segment, ...]
    ignore_segments: Tuple[Segment, ...]


class TemporalHead(nn.Module):
    def __init__(self, input_dim: int, hidden_dim: int = 32) -> None:
        super().__init__()
        self.net = nn.Sequential(
            nn.Linear(input_dim, hidden_dim),
            nn.ReLU(),
            nn.Dropout(0.1),
            nn.Linear(hidden_dim, 1),
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return torch.sigmoid(self.net(x)).squeeze(-1)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Train a FireRed AED temporal song head from labeled CSV annotations."
    )
    parser.add_argument(
        "--annotations",
        type=Path,
        default=Path("tools/annotations_example.csv"),
        help="CSV with audio_path,start_sec,end_sec,label. label=song is positive; label=non-song is negative.",
    )
    parser.add_argument(
        "--audio-dir",
        type=Path,
        default=Path("tools/data/audio"),
        help="Directory containing local audio files.",
    )
    parser.add_argument(
        "--model-dir",
        type=Path,
        default=Path("models/fireredvad/aed"),
        help="Directory containing FireRed AED model.onnx and cmvn.json.",
    )
    parser.add_argument(
        "--out-dir",
        type=Path,
        default=Path("training_runs/firered_song_head_csv"),
    )
    parser.add_argument("--epochs", type=int, default=300)
    parser.add_argument("--eval-every", type=int, default=20)
    parser.add_argument("--hidden-dim", type=int, default=32)
    parser.add_argument("--lr", type=float, default=1e-3)
    parser.add_argument("--weight-decay", type=float, default=1e-4)
    parser.add_argument("--val-fraction", type=float, default=0.2)
    parser.add_argument(
        "--split",
        choices=["stratified-window", "by-audio", "by-audio-window"],
        default="by-audio",
        help="Validation split strategy.",
    )
    parser.add_argument(
        "--val-window-sec",
        type=float,
        default=1800.0,
        help="Validation window length for by-audio-window split.",
    )
    parser.add_argument(
        "--val-guard-sec",
        type=float,
        default=60.0,
        help="Discard train windows within this distance of a by-audio-window validation slice.",
    )
    parser.add_argument("--seed", type=int, default=1337)
    parser.add_argument("--beta", type=float, default=0.5, help="F-beta beta; 0.5 emphasizes precision.")
    parser.add_argument("--chunk-sec", type=float, default=300.0, help="Audio decode/inference chunk size.")
    parser.add_argument("--onnx-chunk-frames", type=int, default=30000)
    parser.add_argument("--rebuild-cache", action="store_true")
    parser.add_argument("--device", choices=["auto", "cpu", "cuda"], default="auto")
    parser.add_argument(
        "--cache-workers",
        type=int,
        default=1,
        help="Parallel workers for FireRed AED stats cache generation. Use 2-4 for long audio if memory allows.",
    )
    parser.add_argument(
        "--ort-intra-op-threads",
        type=int,
        default=0,
        help="ONNX Runtime intra-op threads per AED session. 0 keeps ORT default; use 1 with multiple cache workers.",
    )
    parser.add_argument(
        "--auto-ignore-unlabeled-songlike-sec",
        type=float,
        default=0.0,
        help="If >0, current deployed song head predictions longer than this and outside manual songs are ignored.",
    )
    parser.add_argument(
        "--cache-record-logical-path",
        default="",
        help=argparse.SUPPRESS,
    )
    parser.add_argument(
        "--trace-chunks",
        action="store_true",
        help="Print per-chunk decode/feature/ONNX/cache progress for debugging slow cache generation.",
    )
    parser.add_argument("--dry-run", action="store_true", help="Parse annotations and resolve audio files without training.")
    return parser.parse_args()


def safe_cache_name(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]+", "_", value).strip("_") or "audio"


def require_tool(name: str) -> str:
    resolved = shutil.which(name)
    if not resolved:
        raise FileNotFoundError(f"Required tool not found on PATH: {name}")
    return resolved


def create_aed_session(model_dir: Path, intra_op_threads: int = 0) -> ort.InferenceSession:
    session_options = ort.SessionOptions()
    if int(intra_op_threads or 0) > 0:
        session_options.intra_op_num_threads = int(intra_op_threads)
    return ort.InferenceSession(
        str(model_dir / "model.onnx"),
        sess_options=session_options,
        providers=["CPUExecutionProvider"],
    )


def probe_wav_duration(path: Path) -> float | None:
    if path.suffix.lower() != ".wav":
        return None
    try:
        with wave.open(str(path), "rb") as wf:
            return wf.getnframes() / float(wf.getframerate())
    except wave.Error:
        return None


def probe_duration(path: Path, ffprobe: str) -> float:
    wav_duration = probe_wav_duration(path)
    if wav_duration is not None:
        return wav_duration

    result = subprocess.run(
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
    return float(result.stdout.strip())


def normalize_label(raw: object) -> str:
    value = str(raw if raw is not None else "song").strip().lower()
    if value in {"", "song", "positive", "pos", "1", "true"}:
        return "song"
    if value in {"non-song", "nonsong", "non_song", "negative", "neg", "0", "false", "speech", "bgm"}:
        return "non-song"
    if value in {"ignore", "ignored", "uncertain", "unknown", "skip"}:
        return "ignore"
    raise ValueError(f"Unsupported annotation label: {raw!r}")


def load_annotation_csv(path: Path) -> Dict[str, AnnotationGroup]:
    song_rows: Dict[str, List[Segment]] = {}
    non_song_rows: Dict[str, List[Segment]] = {}
    ignore_rows: Dict[str, List[Segment]] = {}
    with path.open("r", newline="", encoding="utf-8-sig") as fh:
        reader = csv.DictReader(fh)
        required = {"audio_path", "start_sec", "end_sec"}
        missing = required - set(reader.fieldnames or [])
        if missing:
            raise ValueError(f"{path} missing CSV columns: {', '.join(sorted(missing))}")

        for row in reader:
            logical_path = str(row["audio_path"]).replace("\\", "/").strip()
            if not logical_path:
                continue
            label = normalize_label(row.get("label", "song"))
            start = max(0.0, float(row["start_sec"]))
            end = max(0.0, float(row["end_sec"]))
            if end <= start:
                continue
            if label == "ignore":
                target = ignore_rows
            else:
                target = song_rows if label == "song" else non_song_rows
            target.setdefault(logical_path, []).append(Segment(start, end))

    keys = sorted(set(song_rows) | set(non_song_rows) | set(ignore_rows))
    return {
        key: AnnotationGroup(
            song_segments=tuple(sorted(song_rows.get(key, []), key=lambda segment: segment.start)),
            non_song_segments=tuple(sorted(non_song_rows.get(key, []), key=lambda segment: segment.start)),
            ignore_segments=tuple(sorted(ignore_rows.get(key, []), key=lambda segment: segment.start)),
        )
        for key in keys
    }


def list_audio_candidates(audio_dir: Path) -> List[Path]:
    suffixes = {".wav", ".m4a", ".mp3", ".aac", ".flac", ".ogg"}
    return sorted(path for path in audio_dir.iterdir() if path.is_file() and path.suffix.lower() in suffixes)


def resolve_audio_records(
    annotations: Dict[str, AnnotationGroup],
    annotations_path: Path,
    audio_dir: Path,
    ffprobe: str,
) -> List[AudioRecord]:
    candidates = list_audio_candidates(audio_dir)
    if not candidates:
        raise FileNotFoundError(f"No audio files found in {audio_dir}")

    duration_cache = {path: probe_duration(path, ffprobe) for path in candidates}
    used: set[Path] = set()
    records: List[AudioRecord] = []

    for logical_path, group in annotations.items():
        all_segments = [*group.song_segments, *group.non_song_segments, *group.ignore_segments]
        if not all_segments:
            continue
        max_end = max(segment.end for segment in all_segments)
        expected_paths = [
            (annotations_path.parent / logical_path).resolve(),
            (audio_dir / Path(logical_path).name).resolve(),
        ]

        selected: Path | None = None
        for expected in expected_paths:
            if expected.exists():
                duration = probe_duration(expected, ffprobe)
                if duration + 0.25 >= max_end:
                    selected = expected
                    duration_cache.setdefault(selected, duration)
                    break

        if selected is None:
            compatible = [
                (duration - max_end, path)
                for path, duration in duration_cache.items()
                if path not in used and duration + 0.25 >= max_end
            ]
            if not compatible:
                raise FileNotFoundError(
                    f"No compatible audio file for {logical_path}; max annotation end is {max_end:.3f}s."
                )
            compatible.sort(key=lambda item: (item[0], item[1].name))
            selected = compatible[0][1]

        used.add(selected)
        records.append(
            AudioRecord(
                logical_path=logical_path,
                audio_path=selected,
                duration_sec=duration_cache[selected],
                song_segments=group.song_segments,
                non_song_segments=group.non_song_segments,
                ignore_segments=group.ignore_segments,
            )
        )

    return records


def resolve_single_cache_record(
    annotations: Dict[str, AnnotationGroup],
    annotations_path: Path,
    audio_dir: Path,
    logical_path: str,
    ffprobe: str,
) -> AudioRecord:
    if logical_path not in annotations:
        raise KeyError(f"Cache worker target is not present in annotations: {logical_path}")

    group = annotations[logical_path]
    all_segments = [*group.song_segments, *group.non_song_segments, *group.ignore_segments]
    max_end = max((segment.end for segment in all_segments), default=0.0)
    expected_paths = [
        (annotations_path.parent / logical_path).resolve(),
        (audio_dir / Path(logical_path).name).resolve(),
    ]
    for expected in expected_paths:
        if expected.exists():
            duration = probe_duration(expected, ffprobe)
            if duration + 0.25 < max_end:
                raise ValueError(
                    f"{expected} is shorter than annotations for {logical_path}: "
                    f"duration={duration:.3f}s max_end={max_end:.3f}s"
                )
            return AudioRecord(
                logical_path=logical_path,
                audio_path=expected,
                duration_sec=duration,
                song_segments=group.song_segments,
                non_song_segments=group.non_song_segments,
                ignore_segments=group.ignore_segments,
            )

    raise FileNotFoundError(f"No audio file found for cache worker target: {logical_path}")


def iter_ffmpeg_pcm16(path: Path, ffmpeg: str, chunk_sec: float) -> Iterable[np.ndarray]:
    chunk_samples = max(SAMPLE_RATE, int(round(SAMPLE_RATE * chunk_sec)))
    read_bytes = chunk_samples * 2
    proc = subprocess.Popen(
        [
            ffmpeg,
            "-nostdin",
            "-nostats",
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            str(path),
            "-f",
            "s16le",
            "-acodec",
            "pcm_s16le",
            "-ac",
            "1",
            "-ar",
            str(SAMPLE_RATE),
            "-",
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
    )
    assert proc.stdout is not None

    try:
        while True:
            raw = proc.stdout.read(read_bytes)
            if not raw:
                break
            if len(raw) % 2:
                raw = raw[:-1]
            if raw:
                yield np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0

        return_code = proc.wait()
        if return_code:
            raise RuntimeError(f"ffmpeg failed for {path} with code {return_code}.")
        print(f"[infer] ffmpeg stream finished for {path.name}", flush=True)
    finally:
        if proc.poll() is None:
            proc.kill()


def run_onnx_session(
    session: ort.InferenceSession,
    input_name: str,
    output_name: str,
    features: np.ndarray,
    chunk_frames: int,
) -> np.ndarray:
    chunks = []
    for start in range(0, len(features), chunk_frames):
        chunk = features[start:start + chunk_frames][None, :, :].astype(np.float32, copy=False)
        chunks.append(session.run([output_name], {input_name: chunk})[0][0])
    return np.concatenate(chunks, axis=0).astype(np.float32)


def run_current_temporal_head_for_ignore(
    model_dir: Path,
    stats: Dict[str, np.ndarray],
    batch_size: int = 4096,
) -> Tuple[np.ndarray, float] | None:
    meta_path = model_dir / "firered_song_head.meta.json"
    model_path = model_dir / "firered_song_head.onnx"
    if not meta_path.exists() or not model_path.exists():
        return None

    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    features, _ = build_temporal_features(stats)
    input_dim = int(meta.get("inputDim") or features.shape[1])
    if input_dim != features.shape[1]:
        return None

    session = ort.InferenceSession(str(model_path), providers=["CPUExecutionProvider"])
    input_name = str(meta.get("inputName") or session.get_inputs()[0].name)
    output_name = str(meta.get("outputName") or session.get_outputs()[0].name)
    chunks = []
    for start in range(0, len(features), batch_size):
        batch = features[start:start + batch_size].astype(np.float32, copy=False)
        output = session.run([output_name], {input_name: batch})[0]
        chunks.append(np.asarray(output, dtype=np.float32).reshape(-1))
    probabilities = np.concatenate(chunks, axis=0).astype(np.float32) if chunks else np.zeros(0, dtype=np.float32)
    threshold = float(meta.get("threshold", 0.75))
    return probabilities, threshold


def overlap_seconds(left: Segment, right: Segment) -> float:
    return max(0.0, min(left.end, right.end) - max(left.start, right.start))


def has_meaningful_song_overlap(candidate: Segment, song_segments: Sequence[Segment]) -> bool:
    duration = max(1.0, candidate.end - candidate.start)
    overlap = sum(overlap_seconds(candidate, song) for song in song_segments)
    return overlap >= 8.0 or overlap / duration >= 0.15


def find_unlabeled_songlike_ignore_segments(
    stats: Dict[str, np.ndarray],
    record: AudioRecord,
    model_dir: Path,
    min_duration_sec: float,
) -> Tuple[Segment, ...]:
    min_duration_sec = max(0.0, float(min_duration_sec))
    if min_duration_sec <= 0:
        return tuple()

    current = run_current_temporal_head_for_ignore(model_dir, stats)
    if current is None:
        return tuple()
    probabilities, threshold = current
    times = np.asarray(stats["time"], dtype=np.float32)
    count = min(len(times), len(probabilities))
    if count == 0:
        return tuple()

    runs: List[Segment] = []
    active_start: float | None = None
    last_positive: float | None = None
    gap_sec = 0.0
    max_gap_sec = 4.0
    hop = HOP_SEC

    for index in range(count):
        time = float(times[index])
        is_positive = float(probabilities[index]) >= threshold
        if is_positive:
            if active_start is None:
                active_start = time
            last_positive = time + hop
            gap_sec = 0.0
            continue

        if active_start is None:
            continue
        gap_sec += hop
        if gap_sec > max_gap_sec:
            end = max(active_start, float(last_positive or time))
            runs.append(Segment(active_start, end))
            active_start = None
            last_positive = None
            gap_sec = 0.0

    if active_start is not None:
        runs.append(Segment(active_start, max(active_start, float(last_positive or times[count - 1]))))

    ignore_segments = []
    for run in runs:
        if run.end - run.start < min_duration_sec:
            continue
        if has_meaningful_song_overlap(run, record.song_segments):
            continue
        ignore_segments.append(run)
    return tuple(ignore_segments)


def waveform_to_features_vectorized(wav: np.ndarray, means: np.ndarray, inv_std: np.ndarray) -> np.ndarray:
    frame_count = (len(wav) - FRAME_LENGTH) // FRAME_SHIFT + 1
    if frame_count <= 0:
        return np.zeros((0, FEATURE_DIM), dtype=np.float32)

    shape = (frame_count, FRAME_LENGTH)
    strides = (wav.strides[0] * FRAME_SHIFT, wav.strides[0])
    frames = np.lib.stride_tricks.as_strided(wav, shape=shape, strides=strides)
    frames = frames.astype(np.float32, copy=True) * 32768.0
    frames -= frames.mean(axis=1, keepdims=True)

    pre = np.empty_like(frames)
    pre[:, 0] = frames[:, 0]
    pre[:, 1:] = frames[:, 1:] - (0.97 * frames[:, :-1])
    pre *= build_povey_window(FRAME_LENGTH)[None, :]

    spec = np.fft.rfft(pre, n=512, axis=1)
    power = ((spec.real * spec.real) + (spec.imag * spec.imag)).astype(np.float32)
    mel = np.maximum(power @ build_mel_filterbank().T, 1e-10)
    return ((np.log(mel) - means) * inv_std).astype(np.float32)


def infer_probabilities_for_audio(
    record: AudioRecord,
    ffmpeg: str,
    cmvn: Tuple[np.ndarray, np.ndarray],
    session: ort.InferenceSession,
    input_name: str,
    output_name: str,
    chunk_sec: float,
    onnx_chunk_frames: int,
    trace_chunks: bool = False,
) -> np.ndarray:
    means, inv_std = cmvn
    pending = np.zeros(0, dtype=np.float32)
    prob_chunks: List[np.ndarray] = []
    processed_samples = 0
    next_progress_sec = 0.0
    chunk_index = 0

    for chunk in iter_ffmpeg_pcm16(record.audio_path, ffmpeg, chunk_sec):
        chunk_index += 1
        processed_samples += len(chunk)
        wav = np.concatenate([pending, chunk]) if pending.size else chunk
        frame_count = (len(wav) - FRAME_LENGTH) // FRAME_SHIFT + 1
        if trace_chunks:
            print(
                f"[trace] {record.audio_path.name} chunk={chunk_index} "
                f"read_samples={len(chunk)} pending_samples={len(pending)} "
                f"processed_sec={processed_samples / SAMPLE_RATE:.1f} frames={max(0, frame_count)}",
                flush=True,
            )
        if frame_count > 0:
            usable_samples = (frame_count - 1) * FRAME_SHIFT + FRAME_LENGTH
            if trace_chunks:
                print(
                    f"[trace] {record.audio_path.name} chunk={chunk_index} feature-start "
                    f"usable_samples={usable_samples}",
                    flush=True,
                )
            features = waveform_to_features_vectorized(wav[:usable_samples], means, inv_std)
            if trace_chunks:
                print(
                    f"[trace] {record.audio_path.name} chunk={chunk_index} onnx-start "
                    f"features={features.shape[0]}x{features.shape[1]}",
                    flush=True,
                )
            probs = run_onnx_session(session, input_name, output_name, features, onnx_chunk_frames)
            if trace_chunks:
                print(
                    f"[trace] {record.audio_path.name} chunk={chunk_index} onnx-done "
                    f"probs={probs.shape[0]}x{probs.shape[1]}",
                    flush=True,
                )
            prob_chunks.append(probs)
            pending = wav[frame_count * FRAME_SHIFT:].copy()
        else:
            pending = wav

        current_sec = processed_samples / SAMPLE_RATE
        if current_sec >= next_progress_sec:
            print(f"[infer] {record.audio_path.name} {current_sec:.0f}/{record.duration_sec:.0f}s")
            next_progress_sec = current_sec + max(60.0, chunk_sec)

    if prob_chunks:
        total_frames = sum(len(chunk) for chunk in prob_chunks)
        print(f"[infer] concat-start {record.audio_path.name} chunks={len(prob_chunks)} frames={total_frames}", flush=True)
        result = np.concatenate(prob_chunks, axis=0).astype(np.float32)
        print(f"[infer] concat-done {record.audio_path.name} shape={result.shape[0]}x{result.shape[1]}", flush=True)
        return result
    return np.zeros((0, 3), dtype=np.float32)


def stats_cache_path(cache_dir: Path, record: AudioRecord) -> Path:
    name = f"{safe_cache_name(record.logical_path)}__{record.audio_path.stem}.stats.npz"
    return cache_dir / name


def load_cached_stats(path: Path) -> Dict[str, np.ndarray]:
    raw = np.load(path)
    return {key: raw[key] for key in raw.files}


def build_or_load_stats(
    record: AudioRecord,
    args: argparse.Namespace,
    ffmpeg: str,
    cmvn: Tuple[np.ndarray, np.ndarray],
    session: ort.InferenceSession,
    input_name: str,
    output_name: str,
) -> Dict[str, np.ndarray]:
    cache_dir = args.out_dir / "cache"
    cache_dir.mkdir(parents=True, exist_ok=True)
    cache_path = stats_cache_path(cache_dir, record)

    if cache_path.exists() and not args.rebuild_cache:
        print(f"[cache] loaded {cache_path}")
        return load_cached_stats(cache_path)

    print(f"[infer] building FireRed AED stats for {record.logical_path} -> {record.audio_path.name}")
    probs = infer_probabilities_for_audio(
        record,
        ffmpeg,
        cmvn,
        session,
        input_name,
        output_name,
        args.chunk_sec,
        args.onnx_chunk_frames,
        bool(getattr(args, "trace_chunks", False)),
    )
    if probs.size == 0:
        raise RuntimeError(f"No FireRed probabilities generated for {record.audio_path}")

    print(f"[cache] stats-start {record.logical_path}", flush=True)
    stats = build_half_second_stats(probs)
    print(f"[cache] save-start {cache_path}", flush=True)
    np.savez_compressed(cache_path, **stats)
    print(f"[cache] saved {cache_path} windows={len(stats['time'])}", flush=True)
    return stats


def build_or_load_stats_parallel_worker(payload: Tuple[AudioRecord, Dict[str, object]]) -> Tuple[str, Dict[str, np.ndarray]]:
    record, config = payload
    out_dir = Path(str(config["out_dir"]))
    model_dir = Path(str(config["model_dir"]))
    ffmpeg = str(config["ffmpeg"])
    rebuild_cache = bool(config["rebuild_cache"])
    chunk_sec = float(config["chunk_sec"])
    onnx_chunk_frames = int(config["onnx_chunk_frames"])
    ort_intra_op_threads = int(config.get("ort_intra_op_threads") or 0)

    cache_dir = out_dir / "cache"
    cache_dir.mkdir(parents=True, exist_ok=True)
    cache_path = stats_cache_path(cache_dir, record)
    if cache_path.exists() and not rebuild_cache:
        print(f"[cache] loaded {cache_path}")
        return record.logical_path, load_cached_stats(cache_path)

    cmvn = load_cmvn(model_dir / "cmvn.json")
    session = create_aed_session(model_dir, ort_intra_op_threads)
    input_name = session.get_inputs()[0].name
    output_name = session.get_outputs()[0].name
    worker_args = argparse.Namespace(
        out_dir=out_dir,
        rebuild_cache=rebuild_cache,
        chunk_sec=chunk_sec,
        onnx_chunk_frames=onnx_chunk_frames,
        trace_chunks=bool(config.get("trace_chunks")),
    )
    stats = build_or_load_stats(record, worker_args, ffmpeg, cmvn, session, input_name, output_name)
    return record.logical_path, stats


def text_tail(path: Path, max_chars: int = 4000) -> str:
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except FileNotFoundError:
        return ""
    return text[-max_chars:]


def cache_worker_command(record: AudioRecord, args: argparse.Namespace) -> List[str]:
    command = [
        sys.executable,
        "-u",
        str(Path(__file__).resolve()),
        "--annotations",
        str(args.annotations),
        "--audio-dir",
        str(args.audio_dir),
        "--model-dir",
        str(args.model_dir),
        "--out-dir",
        str(args.out_dir),
        "--chunk-sec",
        str(args.chunk_sec),
        "--onnx-chunk-frames",
        str(args.onnx_chunk_frames),
        "--ort-intra-op-threads",
        str(args.ort_intra_op_threads or 0),
        "--cache-record-logical-path",
        record.logical_path,
    ]
    if args.rebuild_cache:
        command.append("--rebuild-cache")
    if args.trace_chunks:
        command.append("--trace-chunks")
    return command


def build_all_stats_with_subprocesses(
    records: Sequence[AudioRecord],
    args: argparse.Namespace,
    worker_count: int,
) -> Dict[str, Dict[str, np.ndarray]]:
    cache_dir = args.out_dir / "cache"
    cache_dir.mkdir(parents=True, exist_ok=True)
    log_dir = args.out_dir / "cache_logs"
    log_dir.mkdir(parents=True, exist_ok=True)

    stats_by_logical: Dict[str, Dict[str, np.ndarray]] = {}
    pending: List[AudioRecord] = []
    for record in records:
        cache_path = stats_cache_path(cache_dir, record)
        if cache_path.exists() and not args.rebuild_cache:
            stats_by_logical[record.logical_path] = load_cached_stats(cache_path)
        else:
            pending.append(record)

    print(
        f"[parallel-cache] workers={worker_count} pending={len(pending)} "
        f"cached={len(stats_by_logical)} ort_intra_op_threads={args.ort_intra_op_threads or 'default'}"
    )
    if not pending:
        return stats_by_logical

    active: List[Dict[str, object]] = []
    failures: List[str] = []
    next_index = 0
    repo_dir = Path.cwd()

    while next_index < len(pending) or active:
        while next_index < len(pending) and len(active) < worker_count:
            record = pending[next_index]
            next_index += 1
            log_name = safe_cache_name(record.logical_path)
            stdout_path = log_dir / f"{log_name}.stdout.log"
            stderr_path = log_dir / f"{log_name}.stderr.log"
            stdout_handle = stdout_path.open("w", encoding="utf-8", errors="replace")
            stderr_handle = stderr_path.open("w", encoding="utf-8", errors="replace")
            process = subprocess.Popen(
                cache_worker_command(record, args),
                cwd=repo_dir,
                stdout=stdout_handle,
                stderr=stderr_handle,
                text=True,
            )
            active.append(
                {
                    "process": process,
                    "record": record,
                    "stdout_path": stdout_path,
                    "stderr_path": stderr_path,
                    "stdout_handle": stdout_handle,
                    "stderr_handle": stderr_handle,
                }
            )
            print(f"[parallel-cache] started {record.logical_path} pid={process.pid}")

        time.sleep(1.0)
        still_active: List[Dict[str, object]] = []
        for item in active:
            process = item["process"]
            if not isinstance(process, subprocess.Popen):
                continue
            code = process.poll()
            if code is None:
                still_active.append(item)
                continue

            stdout_handle = item["stdout_handle"]
            stderr_handle = item["stderr_handle"]
            if hasattr(stdout_handle, "close"):
                stdout_handle.close()
            if hasattr(stderr_handle, "close"):
                stderr_handle.close()

            record = item["record"]
            if not isinstance(record, AudioRecord):
                continue
            stdout_path = item["stdout_path"]
            stderr_path = item["stderr_path"]
            cache_path = stats_cache_path(cache_dir, record)
            if code != 0 or not cache_path.exists():
                detail = (
                    f"{record.logical_path} failed exit={code} cache_exists={cache_path.exists()}\n"
                    f"stdout tail:\n{text_tail(stdout_path if isinstance(stdout_path, Path) else Path(str(stdout_path)))}\n"
                    f"stderr tail:\n{text_tail(stderr_path if isinstance(stderr_path, Path) else Path(str(stderr_path)))}"
                )
                failures.append(detail)
                print(f"[parallel-cache] failed {record.logical_path} exit={code}")
                continue

            stats = load_cached_stats(cache_path)
            stats_by_logical[record.logical_path] = stats
            print(f"[parallel-cache] done {record.logical_path} windows={len(stats.get('time', []))}")

        active = still_active

    if failures:
        raise RuntimeError("One or more cache workers failed:\n\n" + "\n\n".join(failures))

    missing = [record.logical_path for record in records if record.logical_path not in stats_by_logical]
    if missing:
        raise RuntimeError(f"Cache generation finished but records are missing: {', '.join(missing)}")

    return stats_by_logical


def build_all_stats(
    records: Sequence[AudioRecord],
    args: argparse.Namespace,
    ffmpeg: str,
    cmvn: Tuple[np.ndarray, np.ndarray] | None,
    session: ort.InferenceSession | None,
    input_name: str | None,
    output_name: str | None,
) -> Dict[str, Dict[str, np.ndarray]]:
    worker_count = max(1, int(args.cache_workers or 1))
    if worker_count <= 1:
        if cmvn is None or session is None or input_name is None or output_name is None:
            raise RuntimeError("Sequential cache generation requires an initialized AED session.")
        return {
            record.logical_path: build_or_load_stats(record, args, ffmpeg, cmvn, session, input_name, output_name)
            for record in records
        }

    return build_all_stats_with_subprocesses(records, args, worker_count)


def labels_for_record(times: np.ndarray, record: AudioRecord) -> np.ndarray:
    # The target is "inside a song segment", not "currently singing".
    # Intro, interlude, instrumental solo, and tail are positive when they are
    # inside a song annotation.
    labels = np.zeros(len(times), dtype=np.int8)
    for segment in record.song_segments:
        labels[(times >= segment.start) & (times < segment.end)] = 1

    conflicts = 0
    for segment in record.non_song_segments:
        mask = (times >= segment.start) & (times < segment.end)
        conflicts += int((labels[mask] == 1).sum())

    if conflicts:
        raise ValueError(
            f"{record.logical_path} has {conflicts} half-second windows labeled as both song and non-song."
        )

    for segment in record.ignore_segments:
        labels[(times >= segment.start) & (times < segment.end)] = -1

    return labels


def tensor_from_numpy(array: np.ndarray, shape: Tuple[int, ...] | None = None) -> torch.Tensor:
    contiguous = np.ascontiguousarray(array)
    tensor = torch.frombuffer(contiguous.tobytes(), dtype=torch.float32).clone()
    return tensor.reshape(shape or contiguous.shape)


def split_indices(
    labels: np.ndarray,
    group_ids: np.ndarray,
    time_secs: np.ndarray,
    val_fraction: float,
    split: str,
    seed: int,
    val_window_sec: float = 1800.0,
    val_guard_sec: float = 60.0,
) -> Tuple[np.ndarray, np.ndarray, List[str]]:
    rng = np.random.default_rng(seed)
    val_fraction = min(0.8, max(0.05, float(val_fraction)))

    if split == "by-audio-window":
        groups = np.asarray(sorted(set(str(item) for item in group_ids.tolist())), dtype=object)
        val_parts = []
        train_parts = []
        val_descriptions: List[str] = []
        window_sec = max(60.0, float(val_window_sec))
        guard_sec = max(0.0, float(val_guard_sec))

        for group in groups:
            group_idx = np.flatnonzero(group_ids == group)
            if not len(group_idx):
                continue

            group_times = time_secs[group_idx]
            min_time = float(np.nanmin(group_times))
            max_time = float(np.nanmax(group_times))
            duration = max_time - min_time

            if duration >= window_sec:
                max_start = max(min_time, max_time - window_sec)
                start = float(rng.uniform(min_time, max_start)) if max_start > min_time else min_time
                end = start + window_sec
                val_mask = (group_times >= start) & (group_times < end)
                guard_mask = (group_times >= start - guard_sec) & (group_times < end + guard_sec)
                group_val_idx = group_idx[val_mask]
                group_train_idx = group_idx[~guard_mask]
                if len(group_val_idx) and len(group_train_idx):
                    val_parts.append(group_val_idx)
                    train_parts.append(group_train_idx)
                    val_descriptions.append(f"{group}@{start:.1f}-{end:.1f}")
                    continue

            # Short files keep by-audio behavior inside the mixed split.
            train_parts.append(group_idx)

        short_groups = []
        for group in groups:
            if any(desc.startswith(f"{group}@") for desc in val_descriptions):
                continue
            group_idx = np.flatnonzero(group_ids == group)
            if len(group_idx):
                short_groups.append(str(group))

        if short_groups:
            rng.shuffle(short_groups)
            val_count = max(1, round(len(groups) * val_fraction)) - len(val_descriptions)
            if val_count > 0:
                selected_short = set(short_groups[:val_count])
                next_train_parts = []
                for part in train_parts:
                    part_groups = set(str(item) for item in group_ids[part].tolist())
                    if len(part_groups) == 1 and next(iter(part_groups)) in selected_short:
                        val_parts.append(part)
                    else:
                        next_train_parts.append(part)
                train_parts = next_train_parts
                val_descriptions.extend(sorted(selected_short))

        if val_parts and train_parts:
            train_idx = np.concatenate(train_parts)
            val_idx = np.concatenate(val_parts)
            train_idx = np.unique(train_idx)
            val_idx = np.unique(val_idx)
            overlap = np.intersect1d(train_idx, val_idx)
            if len(overlap):
                train_idx = np.setdiff1d(train_idx, overlap)
            rng.shuffle(train_idx)
            rng.shuffle(val_idx)
            return train_idx, val_idx, sorted(val_descriptions)

        # Fall back to by-audio if all window candidates were invalid.
        split = "by-audio"

    if split == "by-audio":
        groups = np.asarray(sorted(set(str(item) for item in group_ids.tolist())), dtype=object)
        val_count = max(1, round(len(groups) * val_fraction))
        mixed_groups = []
        positive_only_groups = []
        negative_only_groups = []

        for group in groups:
            group_label_values = labels[group_ids == group]
            has_positive = bool((group_label_values == 1).any())
            has_negative = bool((group_label_values == 0).any())
            if has_positive and has_negative:
                mixed_groups.append(str(group))
            elif has_positive:
                positive_only_groups.append(str(group))
            elif has_negative:
                negative_only_groups.append(str(group))

        for bucket in [mixed_groups, positive_only_groups, negative_only_groups]:
            rng.shuffle(bucket)

        selected_groups: List[str] = []
        if mixed_groups:
            selected_groups.append(mixed_groups.pop(0))
        else:
            if positive_only_groups:
                selected_groups.append(positive_only_groups.pop(0))
            if negative_only_groups and len(selected_groups) < val_count:
                selected_groups.append(negative_only_groups.pop(0))

        remaining_groups = [*mixed_groups, *positive_only_groups, *negative_only_groups]
        rng.shuffle(remaining_groups)
        selected_groups.extend(remaining_groups[:max(0, val_count - len(selected_groups))])

        val_groups = set(selected_groups[:val_count])
        val_idx = np.flatnonzero(np.isin(group_ids, list(val_groups)))
        train_idx = np.flatnonzero(~np.isin(group_ids, list(val_groups)))
        return train_idx, val_idx, sorted(val_groups)

    train_parts = []
    val_parts = []
    for cls in [0, 1]:
        idx = np.flatnonzero(labels == cls)
        rng.shuffle(idx)
        val_count = max(1, int(round(len(idx) * val_fraction)))
        val_parts.append(idx[:val_count])
        train_parts.append(idx[val_count:])

    train_idx = np.concatenate(train_parts)
    val_idx = np.concatenate(val_parts)
    rng.shuffle(train_idx)
    rng.shuffle(val_idx)
    return train_idx, val_idx, ["stratified-window"]


def find_best_threshold(probs: np.ndarray, labels: np.ndarray, beta: float) -> Tuple[float, Dict[str, float]]:
    beta2 = beta * beta
    best_threshold = 0.5
    best_score = -1.0
    best_metrics: Dict[str, float] = {}
    for threshold in np.linspace(0.05, 0.95, 181):
        pred = (probs >= threshold).astype(np.int8)
        current = metrics(pred, labels)
        score = (
            (1 + beta2)
            * current["precision"]
            * current["recall"]
            / max(1e-9, (beta2 * current["precision"]) + current["recall"])
        )
        if score > best_score:
            best_score = score
            best_threshold = float(threshold)
            best_metrics = current
    return best_threshold, best_metrics


def choose_device(requested: str) -> torch.device:
    if requested == "cuda":
        if not torch.cuda.is_available():
            raise RuntimeError("CUDA requested but torch.cuda.is_available() is false.")
        return torch.device("cuda")
    if requested == "auto" and torch.cuda.is_available():
        return torch.device("cuda")
    return torch.device("cpu")


def train_head(
    x: np.ndarray,
    labels: np.ndarray,
    group_ids: np.ndarray,
    time_secs: np.ndarray,
    args: argparse.Namespace,
    feature_names: Sequence[str],
) -> Dict[str, object]:
    train_idx, val_idx, val_groups = split_indices(
        labels,
        group_ids,
        time_secs,
        args.val_fraction,
        args.split,
        args.seed,
        args.val_window_sec,
        args.val_guard_sec,
    )
    if len(train_idx) == 0 or len(val_idx) == 0:
        raise RuntimeError("Train/validation split produced an empty partition.")

    device = choose_device(args.device)
    x_train = tensor_from_numpy(x[train_idx]).to(device)
    y_train = tensor_from_numpy(labels[train_idx].astype(np.float32)).to(device)
    x_val = tensor_from_numpy(x[val_idx]).to(device)
    y_val_np = labels[val_idx].astype(np.int8)

    model = TemporalHead(x.shape[1], args.hidden_dim).to(device)
    pos = float((labels[train_idx] == 1).sum())
    neg = float((labels[train_idx] == 0).sum())
    pos_weight = torch.tensor([neg / max(1.0, pos)], dtype=torch.float32, device=device)
    loss_fn = nn.BCELoss(reduction="none")
    optimizer = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=args.weight_decay)

    best_state: Dict[str, torch.Tensor] | None = None
    best_score = -1.0
    best_threshold = 0.5
    best_metrics: Dict[str, float] = {}
    history = []

    for epoch in range(1, args.epochs + 1):
        model.train()
        optimizer.zero_grad(set_to_none=True)
        pred = model(x_train)
        weights = torch.where(y_train > 0.5, pos_weight, torch.ones_like(y_train))
        loss = (loss_fn(pred, y_train) * weights).mean()
        loss.backward()
        optimizer.step()

        if epoch % args.eval_every == 0 or epoch == 1 or epoch == args.epochs:
            model.eval()
            with torch.no_grad():
                val_probs = np.asarray(model(x_val).detach().cpu().tolist(), dtype=np.float32)
            threshold, current_metrics = find_best_threshold(val_probs, y_val_np, args.beta)
            score = current_metrics.get("f0_5", current_metrics.get("f1", 0.0))
            if score > best_score:
                best_score = score
                best_threshold = threshold
                best_metrics = current_metrics
                best_state = {key: value.detach().cpu().clone() for key, value in model.state_dict().items()}
            row = {
                "epoch": epoch,
                "loss": float(loss.detach().cpu().item()),
                "threshold": threshold,
                "metrics": current_metrics,
            }
            history.append(row)
            print(
                f"epoch={epoch:04d} loss={row['loss']:.5f} thr={threshold:.3f} "
                f"precision={current_metrics['precision']:.4f} "
                f"recall={current_metrics['recall']:.4f} f1={current_metrics['f1']:.4f}"
            )

    if best_state is not None:
        model.load_state_dict(best_state)

    args.out_dir.mkdir(parents=True, exist_ok=True)
    pt_path = args.out_dir / "firered_song_head.pt"
    torch.save(model.cpu().state_dict(), pt_path)

    onnx_path = args.out_dir / "firered_song_head.onnx"
    onnx_error = None
    try:
        model.eval()
        dummy = torch.zeros(1, x.shape[1], dtype=torch.float32)
        torch.onnx.export(
            model,
            dummy,
            str(onnx_path),
            input_names=["temporal_features"],
            output_names=["song_probability"],
            dynamic_axes={"temporal_features": {0: "batch"}, "song_probability": {0: "batch"}},
            opset_version=17,
            do_constant_folding=True,
        )
    except Exception as error:  # pragma: no cover - depends on local torch/onnx install
        onnx_error = str(error)
        onnx_path = None

    meta = {
        "modelType": "firered-song-temporal-head",
        "detectorVersion": "firered-song-head-csv-v1",
        "inputName": "temporal_features",
        "outputName": "song_probability",
        "inputDim": len(feature_names),
        "featureNames": list(feature_names),
        "threshold": best_threshold,
        "bestValMetrics": best_metrics,
        "hopSec": HOP_SEC,
        "split": args.split,
        "valWindowSec": args.val_window_sec,
        "valGuardSec": args.val_guard_sec,
        "valGroups": val_groups,
        "labelPolicy": {
            "positive": "label=song means the full song segment, including intro, interlude, instrumental, and tail.",
            "negative": "label=non-song and unannotated windows are treated as non-song.",
            "ignore": "label=ignore windows are removed from both training and validation.",
            "target": "song-segment classification, not vocal-only/singing-only classification.",
        },
        "notes": "Labeled CSV training. The target is full song segments, not only frames where FireRed AED emits singing.",
    }
    (args.out_dir / "firered_song_head.meta.json").write_text(
        json.dumps(meta, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    return {
        "ptPath": str(pt_path),
        "onnxPath": str(onnx_path) if onnx_path else None,
        "onnxError": onnx_error,
        "threshold": best_threshold,
        "metrics": best_metrics,
        "history": history,
        "device": str(device),
        "trainWindows": int(len(train_idx)),
        "valWindows": int(len(val_idx)),
        "valGroups": val_groups,
    }


def main() -> None:
    args = parse_args()
    args.out_dir.mkdir(parents=True, exist_ok=True)

    ffmpeg = require_tool("ffmpeg")
    ffprobe = require_tool("ffprobe")
    annotations = load_annotation_csv(args.annotations)

    if args.cache_record_logical_path:
        record = resolve_single_cache_record(
            annotations,
            args.annotations,
            args.audio_dir,
            args.cache_record_logical_path,
            ffprobe,
        )
        print(f"[cache-worker] target={record.logical_path} audio={record.audio_path}")
        cmvn = load_cmvn(args.model_dir / "cmvn.json")
        session = create_aed_session(args.model_dir, args.ort_intra_op_threads)
        input_name = session.get_inputs()[0].name
        output_name = session.get_outputs()[0].name
        build_or_load_stats(record, args, ffmpeg, cmvn, session, input_name, output_name)
        return

    records = resolve_audio_records(annotations, args.annotations, args.audio_dir, ffprobe)

    print(f"[annotations] logical_files={len(records)}")
    for record in records:
        positive_sec = sum(segment.end - segment.start for segment in record.song_segments)
        explicit_negative_sec = sum(segment.end - segment.start for segment in record.non_song_segments)
        print(
            f"  {record.logical_path} -> {record.audio_path.name} "
            f"duration={record.duration_sec:.1f}s song_sec={positive_sec:.1f} "
            f"explicit_non_song_sec={explicit_negative_sec:.1f} "
            f"ignore_sec={sum(segment.end - segment.start for segment in record.ignore_segments):.1f}"
        )

    if args.dry_run:
        print("[dry-run] annotation parsing and audio resolution completed; training skipped.")
        return

    worker_count = max(1, int(args.cache_workers or 1))
    cmvn = None
    session = None
    input_name = None
    output_name = None
    if worker_count <= 1:
        cmvn = load_cmvn(args.model_dir / "cmvn.json")
        session = create_aed_session(args.model_dir, args.ort_intra_op_threads)
        input_name = session.get_inputs()[0].name
        output_name = session.get_outputs()[0].name

    feature_parts = []
    label_parts = []
    group_parts = []
    time_parts = []
    record_summaries = []

    stats_by_logical = build_all_stats(records, args, ffmpeg, cmvn, session, input_name, output_name)

    for record in records:
        stats = stats_by_logical[record.logical_path]
        auto_ignore_segments = find_unlabeled_songlike_ignore_segments(
            stats,
            record,
            args.model_dir,
            args.auto_ignore_unlabeled_songlike_sec,
        )
        effective_record = AudioRecord(
            logical_path=record.logical_path,
            audio_path=record.audio_path,
            duration_sec=record.duration_sec,
            song_segments=record.song_segments,
            non_song_segments=record.non_song_segments,
            ignore_segments=tuple([*record.ignore_segments, *auto_ignore_segments]),
        )
        if auto_ignore_segments:
            print(
                f"[ignore] {record.logical_path} generated={len(auto_ignore_segments)} "
                f"sec={sum(segment.end - segment.start for segment in auto_ignore_segments):.1f}"
            )
        labels = labels_for_record(stats["time"], effective_record)
        features, feature_names = build_temporal_features(stats)
        valid_mask = labels >= 0
        feature_parts.append(features[valid_mask])
        label_parts.append(labels[valid_mask])
        group_parts.append(np.full(int(valid_mask.sum()), record.logical_path, dtype=object))
        time_parts.append(np.asarray(stats["time"], dtype=np.float32)[valid_mask])
        record_summaries.append(
            {
                "logicalPath": record.logical_path,
                "audioPath": str(record.audio_path),
                "durationSec": record.duration_sec,
                "songSegments": len(record.song_segments),
                "explicitNonSongSegments": len(record.non_song_segments),
                "ignoreSegments": len(record.ignore_segments),
                "autoIgnoreSegments": len(auto_ignore_segments),
                "songSegmentSec": sum(segment.end - segment.start for segment in record.song_segments),
                "explicitNonSongSec": sum(segment.end - segment.start for segment in record.non_song_segments),
                "ignoreSec": sum(segment.end - segment.start for segment in record.ignore_segments),
                "autoIgnoreSec": sum(segment.end - segment.start for segment in auto_ignore_segments),
                "autoIgnoreSpans": [
                    {"startSec": segment.start, "endSec": segment.end}
                    for segment in auto_ignore_segments
                ],
                "ignoredWindows": int((labels < 0).sum()),
                "positiveWindows": int(labels[valid_mask].sum()),
                "negativeWindows": int((labels[valid_mask] == 0).sum()),
                "totalWindows": int(len(labels)),
                "trainingWindows": int(valid_mask.sum()),
            }
        )

    x = np.concatenate(feature_parts, axis=0).astype(np.float32)
    labels = np.concatenate(label_parts, axis=0).astype(np.int8)
    group_ids = np.concatenate(group_parts, axis=0)
    time_secs = np.concatenate(time_parts, axis=0).astype(np.float32)

    print(
        f"[dataset] windows={len(labels)} positives={int(labels.sum())} "
        f"negatives={int((labels == 0).sum())} features={x.shape[1]}"
    )

    training = train_head(x, labels, group_ids, time_secs, args, feature_names)
    summary = {
        "annotations": str(args.annotations.resolve()),
        "audioDir": str(args.audio_dir.resolve()),
        "modelDir": str(args.model_dir.resolve()),
        "records": record_summaries,
        "numWindowsTotal": int(len(labels)),
        "positiveWindows": int(labels.sum()),
        "negativeWindows": int((labels == 0).sum()),
        "epochs": args.epochs,
        "split": args.split,
        "valWindowSec": args.val_window_sec,
        "valGuardSec": args.val_guard_sec,
        "autoIgnoreUnlabeledSonglikeSec": args.auto_ignore_unlabeled_songlike_sec,
        "cacheWorkers": worker_count,
        "ortIntraOpThreads": args.ort_intra_op_threads,
        "labelPolicy": {
            "positive": "label=song marks the complete song segment, including intro, interlude, instrumental, and tail.",
            "negative": "label=non-song and unannotated windows are treated as non-song.",
            "ignore": "label=ignore windows are removed from both training and validation.",
            "target": "song-segment classification, not vocal-only/singing-only classification.",
        },
        "training": training,
    }
    summary_path = args.out_dir / "training_summary.json"
    summary_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[done] wrote {summary_path}")
    print(json.dumps(training, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
