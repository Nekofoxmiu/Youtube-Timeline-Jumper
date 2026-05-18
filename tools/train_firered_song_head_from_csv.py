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


@dataclass(frozen=True)
class AudioRecord:
    logical_path: str
    audio_path: Path
    duration_sec: float
    song_segments: Tuple[Segment, ...]
    non_song_segments: Tuple[Segment, ...]


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
    parser.add_argument("--dry-run", action="store_true", help="Parse annotations and resolve audio files without training.")
    return parser.parse_args()


def safe_cache_name(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]+", "_", value).strip("_") or "audio"


def require_tool(name: str) -> str:
    resolved = shutil.which(name)
    if not resolved:
        raise FileNotFoundError(f"Required tool not found on PATH: {name}")
    return resolved


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
            if label == "ignore":
                continue
            start = max(0.0, float(row["start_sec"]))
            end = max(0.0, float(row["end_sec"]))
            if end <= start:
                continue
            target = song_rows if label == "song" else non_song_rows
            target.setdefault(logical_path, []).append(Segment(start, end))

    keys = sorted(set(song_rows) | set(non_song_rows))
    return {
        key: AnnotationGroup(
            song_segments=tuple(sorted(song_rows.get(key, []), key=lambda segment: segment.start)),
            non_song_segments=tuple(sorted(non_song_rows.get(key, []), key=lambda segment: segment.start)),
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
        all_segments = [*group.song_segments, *group.non_song_segments]
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
            )
        )

    return records


def iter_ffmpeg_pcm16(path: Path, ffmpeg: str, chunk_sec: float) -> Iterable[np.ndarray]:
    chunk_samples = max(SAMPLE_RATE, int(round(SAMPLE_RATE * chunk_sec)))
    read_bytes = chunk_samples * 2
    proc = subprocess.Popen(
        [
            ffmpeg,
            "-nostdin",
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
        stderr=subprocess.PIPE,
    )
    assert proc.stdout is not None
    assert proc.stderr is not None

    try:
        while True:
            raw = proc.stdout.read(read_bytes)
            if not raw:
                break
            if len(raw) % 2:
                raw = raw[:-1]
            if raw:
                yield np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0

        stderr = proc.stderr.read().decode("utf-8", errors="replace").strip()
        return_code = proc.wait()
        if return_code:
            raise RuntimeError(f"ffmpeg failed for {path} with code {return_code}: {stderr}")
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
) -> np.ndarray:
    means, inv_std = cmvn
    pending = np.zeros(0, dtype=np.float32)
    prob_chunks: List[np.ndarray] = []
    processed_samples = 0
    next_progress_sec = 0.0

    for chunk in iter_ffmpeg_pcm16(record.audio_path, ffmpeg, chunk_sec):
        processed_samples += len(chunk)
        wav = np.concatenate([pending, chunk]) if pending.size else chunk
        frame_count = (len(wav) - FRAME_LENGTH) // FRAME_SHIFT + 1
        if frame_count > 0:
            usable_samples = (frame_count - 1) * FRAME_SHIFT + FRAME_LENGTH
            features = waveform_to_features_vectorized(wav[:usable_samples], means, inv_std)
            probs = run_onnx_session(session, input_name, output_name, features, onnx_chunk_frames)
            prob_chunks.append(probs)
            pending = wav[frame_count * FRAME_SHIFT:].copy()
        else:
            pending = wav

        current_sec = processed_samples / SAMPLE_RATE
        if current_sec >= next_progress_sec:
            print(f"[infer] {record.audio_path.name} {current_sec:.0f}/{record.duration_sec:.0f}s")
            next_progress_sec = current_sec + max(60.0, chunk_sec)

    if prob_chunks:
        return np.concatenate(prob_chunks, axis=0).astype(np.float32)
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
    )
    if probs.size == 0:
        raise RuntimeError(f"No FireRed probabilities generated for {record.audio_path}")

    stats = build_half_second_stats(probs)
    np.savez_compressed(cache_path, **stats)
    print(f"[cache] saved {cache_path} windows={len(stats['time'])}")
    return stats


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
    records = resolve_audio_records(annotations, args.annotations, args.audio_dir, ffprobe)

    print(f"[annotations] logical_files={len(records)}")
    for record in records:
        positive_sec = sum(segment.end - segment.start for segment in record.song_segments)
        explicit_negative_sec = sum(segment.end - segment.start for segment in record.non_song_segments)
        print(
            f"  {record.logical_path} -> {record.audio_path.name} "
            f"duration={record.duration_sec:.1f}s song_sec={positive_sec:.1f} "
            f"explicit_non_song_sec={explicit_negative_sec:.1f}"
        )

    if args.dry_run:
        print("[dry-run] annotation parsing and audio resolution completed; training skipped.")
        return

    cmvn = load_cmvn(args.model_dir / "cmvn.json")
    session = ort.InferenceSession(str(args.model_dir / "model.onnx"), providers=["CPUExecutionProvider"])
    input_name = session.get_inputs()[0].name
    output_name = session.get_outputs()[0].name

    feature_parts = []
    label_parts = []
    group_parts = []
    time_parts = []
    record_summaries = []

    for record in records:
        stats = build_or_load_stats(record, args, ffmpeg, cmvn, session, input_name, output_name)
        labels = labels_for_record(stats["time"], record)
        features, feature_names = build_temporal_features(stats)
        feature_parts.append(features)
        label_parts.append(labels)
        group_parts.append(np.full(len(labels), record.logical_path, dtype=object))
        time_parts.append(np.asarray(stats["time"], dtype=np.float32))
        record_summaries.append(
            {
                "logicalPath": record.logical_path,
                "audioPath": str(record.audio_path),
                "durationSec": record.duration_sec,
                "songSegments": len(record.song_segments),
                "explicitNonSongSegments": len(record.non_song_segments),
                "songSegmentSec": sum(segment.end - segment.start for segment in record.song_segments),
                "explicitNonSongSec": sum(segment.end - segment.start for segment in record.non_song_segments),
                "positiveWindows": int(labels.sum()),
                "totalWindows": int(len(labels)),
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
        "labelPolicy": {
            "positive": "label=song marks the complete song segment, including intro, interlude, instrumental, and tail.",
            "negative": "label=non-song and unannotated windows are treated as non-song.",
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
