"""Generate audio-level synthetic samples for segment/edge model training.

The generated files intentionally live under training_runs by default. They are
not meant to become canonical manual data; they create controlled boundary
scenarios that can be fed through the normal AED/smoothing pipeline.
"""

from __future__ import annotations

import argparse
import csv
import json
import random
import re
import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Sequence, Tuple


AUDIO_SUFFIX_PRIORITY = [".m4a", ".mp4", ".wav", ".mp3", ".webm", ".aac", ".flac", ".opus", ".ogg", ".mkv"]
VIDEO_RE = re.compile(r"video_(\d+)")
DEFAULT_PATTERNS = (
    "rehearsal-prefix",
    "post-end-tail",
    "speech-like-intro-outro-kept",
    "silence-reset",
    "bgm-leading-trailing",
    "close-songs",
)


@dataclass(frozen=True)
class Segment:
    start: float
    end: float
    title: str = ""

    @property
    def duration(self) -> float:
        return max(0.0, self.end - self.start)


@dataclass(frozen=True)
class SourceVideo:
    video_key: str
    audio_path: Path
    manual_path: Path
    duration_sec: float
    songs: Tuple[Segment, ...]
    gaps: Tuple[Segment, ...]


@dataclass
class Clip:
    kind: str
    source_audio: Optional[Path]
    source_start: float
    duration: float
    volume: float = 1.0
    title: str = ""
    source_video: str = ""
    source_pattern: str = ""


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate synthetic audio-level edge-training samples.")
    parser.add_argument("--out-dir", type=Path, required=True)
    parser.add_argument("--sample-count", type=int, default=36)
    parser.add_argument("--seed", type=int, default=20260601)
    parser.add_argument("--source-audio-dir", type=Path, default=Path("tools/data/audio"))
    parser.add_argument("--source-manual-dir", type=Path, default=Path("tools/data/manual"))
    parser.add_argument(
        "--exclude-source-video",
        nargs="*",
        default=["video_013", "video_015", "video_051", "video_070", "video_071", "video_072"],
    )
    parser.add_argument("--start-video-number", type=int, default=900001)
    parser.add_argument("--min-duration-sec", type=float, default=360.0)
    parser.add_argument("--max-duration-sec", type=float, default=720.0)
    parser.add_argument("--min-song-duration-sec", type=float, default=95.0)
    parser.add_argument("--max-song-duration-sec", type=float, default=135.0)
    parser.add_argument("--min-gap-duration-sec", type=float, default=4.0)
    parser.add_argument("--max-gap-duration-sec", type=float, default=35.0)
    parser.add_argument("--ffmpeg", default="ffmpeg")
    parser.add_argument("--ffprobe", default="ffprobe")
    parser.add_argument("--keep-temp", action="store_true")
    return parser.parse_args()


def normalize_video_key(value: object) -> Optional[str]:
    text = str(value or "").strip()
    if re.fullmatch(r"\d+", text):
        return f"video_{int(text):03d}"
    match = VIDEO_RE.search(text)
    if match:
        return f"video_{int(match.group(1)):03d}"
    return None


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


def format_time(sec: float) -> str:
    value = max(0.0, float(sec))
    hours = int(value // 3600)
    minutes = int((value % 3600) // 60)
    seconds = value - (hours * 3600) - (minutes * 60)
    if abs(seconds - round(seconds)) < 0.001:
        sec_text = f"{int(round(seconds)):02d}"
    else:
        sec_text = f"{seconds:06.3f}".rstrip("0").rstrip(".")
    return f"{hours:02d}:{minutes:02d}:{sec_text}"


def load_manual(path: Path) -> List[Segment]:
    segments: List[Segment] = []
    for raw_line in path.read_text(encoding="utf-8-sig").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split()
        if len(parts) < 2:
            continue
        start = parse_time_sec(parts[0])
        end = parse_time_sec(parts[1])
        if end > start:
            segments.append(Segment(start, end, " ".join(parts[2:])))
    return sorted(segments, key=lambda item: item.start)


def probe_duration(path: Path, ffprobe: str) -> float:
    cmd = [
        ffprobe,
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        str(path),
    ]
    completed = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if completed.returncode != 0:
        raise RuntimeError(f"ffprobe failed for {path}: {completed.stderr.strip()}")
    return max(0.0, float(completed.stdout.strip() or 0.0))


def find_audio(audio_dir: Path, video_key: str) -> Optional[Path]:
    candidates = [path for path in audio_dir.glob(f"{video_key}.*") if path.suffix.lower() in AUDIO_SUFFIX_PRIORITY]
    if not candidates:
        return None
    priority = {suffix: index for index, suffix in enumerate(AUDIO_SUFFIX_PRIORITY)}
    return sorted(candidates, key=lambda path: (priority.get(path.suffix.lower(), 999), str(path)))[0]


def build_gaps(songs: Sequence[Segment], duration_sec: float) -> List[Segment]:
    gaps: List[Segment] = []
    cursor = 0.0
    for song in sorted(songs, key=lambda item: item.start):
        if song.start - cursor >= 4.0:
            gaps.append(Segment(cursor, song.start, "non-song-gap"))
        cursor = max(cursor, song.end)
    if duration_sec - cursor >= 4.0:
        gaps.append(Segment(cursor, duration_sec, "non-song-gap"))
    return gaps


def load_sources(args: argparse.Namespace) -> List[SourceVideo]:
    excluded = {normalize_video_key(item) for item in args.exclude_source_video}
    sources: List[SourceVideo] = []
    for manual_path in sorted(args.source_manual_dir.glob("video_*_manual.txt")):
        video_key = normalize_video_key(manual_path.name)
        if not video_key or video_key in excluded:
            continue
        audio_path = find_audio(args.source_audio_dir, video_key)
        if audio_path is None:
            continue
        songs = tuple(item for item in load_manual(manual_path) if item.duration >= 20.0)
        if len(songs) < 2:
            continue
        duration = probe_duration(audio_path, args.ffprobe)
        gaps = tuple(item for item in build_gaps(songs, duration) if item.duration >= 4.0)
        sources.append(SourceVideo(video_key, audio_path, manual_path, duration, songs, gaps))
    if len(sources) < 2:
        raise RuntimeError(f"Not enough source videos under {args.source_audio_dir} / {args.source_manual_dir}")
    return sources


def choose_song_clip(rng: random.Random, source: SourceVideo, args: argparse.Namespace, pattern: str) -> Clip:
    song = rng.choice(source.songs)
    max_duration = min(args.max_song_duration_sec, song.duration)
    min_duration = min(args.min_song_duration_sec, max_duration)
    duration = rng.uniform(min_duration, max_duration) if max_duration > min_duration else max_duration
    if song.duration > duration:
        if pattern == "speech-like-intro-outro-kept":
            source_start = song.start
        else:
            source_start = rng.uniform(song.start, song.end - duration)
    else:
        source_start = song.start
    return Clip(
        kind="song",
        source_audio=source.audio_path,
        source_start=source_start,
        duration=max(4.0, duration),
        volume=rng.uniform(0.92, 1.08),
        title=song.title or "Synthetic Song",
        source_video=source.video_key,
        source_pattern=pattern,
    )


def choose_gap_clip(rng: random.Random, source: SourceVideo, args: argparse.Namespace, kind: str = "gap") -> Clip:
    if not source.gaps:
        return Clip(kind="silence", source_audio=None, source_start=0.0, duration=rng.uniform(2.0, 8.0), title="silence", source_video=source.video_key)
    gap = rng.choice(source.gaps)
    max_duration = min(args.max_gap_duration_sec, gap.duration)
    min_duration = min(args.min_gap_duration_sec, max_duration)
    duration = rng.uniform(min_duration, max_duration) if max_duration > min_duration else max_duration
    source_start = rng.uniform(gap.start, max(gap.start, gap.end - duration)) if gap.duration > duration else gap.start
    return Clip(
        kind=kind,
        source_audio=source.audio_path,
        source_start=source_start,
        duration=max(1.0, duration),
        volume=rng.uniform(0.75, 1.15),
        title=kind,
        source_video=source.video_key,
    )


def silence_clip(rng: random.Random, duration_min: float = 1.0, duration_max: float = 3.0) -> Clip:
    return Clip(kind="silence", source_audio=None, source_start=0.0, duration=rng.uniform(duration_min, duration_max), title="silence")


def build_sample_clips(
    rng: random.Random,
    sources: Sequence[SourceVideo],
    args: argparse.Namespace,
    video_key: str,
) -> Tuple[List[Clip], List[Segment], List[Dict[str, object]]]:
    target_duration = rng.uniform(args.min_duration_sec, args.max_duration_sec)
    clips: List[Clip] = []
    manual: List[Segment] = []
    hard_negatives: List[Dict[str, object]] = []
    cursor = 0.0
    song_index = 1

    def append_clip(clip: Clip, manual_song: bool = False, hard_negative: bool = False, reason: str = "") -> None:
        nonlocal cursor, song_index
        start = cursor
        end = cursor + clip.duration
        clips.append(clip)
        if manual_song:
            manual.append(Segment(start, end, f"Synthetic Song #{song_index} [{clip.source_pattern or clip.kind}]"))
            song_index += 1
        if hard_negative and end - start >= 2.0:
            hard_negatives.append({
                "video": video_key,
                "start_sec": round(start, 3),
                "end_sec": round(end, 3),
                "reason": reason or clip.kind,
            })
        cursor = end

    pattern_cycle = list(DEFAULT_PATTERNS)
    rng.shuffle(pattern_cycle)
    while cursor < target_duration or len(manual) < 2:
        pattern = pattern_cycle[len(manual) % len(pattern_cycle)]
        source = rng.choice(sources)
        song_clip = choose_song_clip(rng, source, args, pattern)

        if pattern == "rehearsal-prefix":
            append_clip(choose_gap_clip(rng, source, args, "speech-gap"))
            for _ in range(rng.randint(1, 3)):
                rehearsal_duration = min(song_clip.duration, rng.uniform(4.0, 12.0))
                append_clip(Clip(
                    kind="rehearsal-prefix",
                    source_audio=song_clip.source_audio,
                    source_start=song_clip.source_start,
                    duration=rehearsal_duration,
                    volume=rng.uniform(0.7, 1.0),
                    title="rehearsal-prefix",
                    source_video=song_clip.source_video,
                    source_pattern=pattern,
                ), hard_negative=True, reason="rehearsal-prefix")
                append_clip(choose_gap_clip(rng, source, args, "short-talk"))
            append_clip(song_clip, manual_song=True)

        elif pattern == "post-end-tail":
            append_clip(choose_gap_clip(rng, source, args, "speech-gap"))
            append_clip(song_clip, manual_song=True)
            append_clip(choose_gap_clip(rng, source, args, "post-end-tail"), hard_negative=True, reason="post-end-tail")

        elif pattern == "speech-like-intro-outro-kept":
            append_clip(choose_gap_clip(rng, source, args, "speech-gap"))
            append_clip(song_clip, manual_song=True)
            append_clip(choose_gap_clip(rng, source, args, "speech-gap"))

        elif pattern == "silence-reset":
            append_clip(silence_clip(rng), hard_negative=True, reason="silence-reset-before")
            append_clip(song_clip, manual_song=True)
            append_clip(silence_clip(rng), hard_negative=True, reason="silence-reset-after")

        elif pattern == "bgm-leading-trailing":
            append_clip(choose_gap_clip(rng, source, args, "bgm-leading"), hard_negative=True, reason="bgm-leading")
            append_clip(song_clip, manual_song=True)
            append_clip(choose_gap_clip(rng, source, args, "bgm-trailing"), hard_negative=True, reason="bgm-trailing")

        elif pattern == "close-songs":
            append_clip(song_clip, manual_song=True)
            append_clip(choose_gap_clip(rng, source, args, "close-song-gap"), hard_negative=True, reason="close-song-gap")
            second_source = rng.choice(sources)
            append_clip(choose_song_clip(rng, second_source, args, pattern), manual_song=True)

        else:
            append_clip(song_clip, manual_song=True)

        append_clip(choose_gap_clip(rng, source, args, "neutral-gap"))
        if cursor > args.max_duration_sec * 1.2 and len(manual) >= 2:
            break

    return clips, manual, hard_negatives


def run_ffmpeg(cmd: Sequence[str]) -> None:
    completed = subprocess.run(list(cmd), capture_output=True, text=True, encoding="utf-8", errors="replace")
    if completed.returncode != 0:
        raise RuntimeError(f"ffmpeg failed ({completed.returncode})\nCMD: {' '.join(cmd)}\n{completed.stderr[-4000:]}")


def render_clip(ffmpeg: str, clip: Clip, out_path: Path) -> None:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    if clip.source_audio is None or clip.kind == "silence":
        run_ffmpeg([
            ffmpeg,
            "-y",
            "-f",
            "lavfi",
            "-i",
            "anullsrc=channel_layout=mono:sample_rate=16000",
            "-t",
            f"{clip.duration:.3f}",
            "-ac",
            "1",
            "-ar",
            "16000",
            "-c:a",
            "pcm_s16le",
            str(out_path),
        ])
        return

    filters = [
        f"volume={clip.volume:.4f}",
        "afade=t=in:st=0:d=0.03",
    ]
    if clip.duration > 0.12:
        filters.append(f"afade=t=out:st={max(0.0, clip.duration - 0.05):.3f}:d=0.05")
    run_ffmpeg([
        ffmpeg,
        "-y",
        "-ss",
        f"{clip.source_start:.3f}",
        "-t",
        f"{clip.duration:.3f}",
        "-i",
        str(clip.source_audio),
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-af",
        ",".join(filters),
        "-c:a",
        "pcm_s16le",
        str(out_path),
    ])


def concat_clips(ffmpeg: str, clip_paths: Sequence[Path], out_path: Path, temp_dir: Path) -> None:
    list_path = temp_dir / "concat.txt"
    list_path.write_text(
        "\n".join(f"file '{path.resolve().as_posix()}'" for path in clip_paths) + "\n",
        encoding="utf-8",
    )
    run_ffmpeg([
        ffmpeg,
        "-y",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        str(list_path),
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-c:a",
        "aac",
        "-b:a",
        "128k",
        str(out_path),
    ])


def write_manual(path: Path, segments: Sequence[Segment]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        "\n".join(f"{format_time(segment.start)} {format_time(segment.end)} {segment.title}" for segment in segments) + "\n",
        encoding="utf-8",
    )


def write_annotations(path: Path, entries: Sequence[Tuple[str, Segment]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=["audio_path", "start_sec", "end_sec", "label"])
        writer.writeheader()
        for audio_rel, segment in entries:
            writer.writerow({
                "audio_path": audio_rel,
                "start_sec": f"{segment.start:.3f}",
                "end_sec": f"{segment.end:.3f}",
                "label": "song",
            })


def write_hard_negatives(path: Path, rows: Sequence[Dict[str, object]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=["video", "start_sec", "end_sec", "reason"])
        writer.writeheader()
        for row in rows:
            writer.writerow(row)


def main() -> None:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    args = parse_args()
    ffmpeg = shutil.which(args.ffmpeg) or args.ffmpeg
    ffprobe = shutil.which(args.ffprobe) or args.ffprobe
    rng = random.Random(args.seed)
    sources = load_sources(args)

    audio_dir = args.out_dir / "audio"
    manual_dir = args.out_dir / "manual"
    temp_root = args.out_dir / "tmp"
    args.out_dir.mkdir(parents=True, exist_ok=True)
    audio_dir.mkdir(parents=True, exist_ok=True)
    manual_dir.mkdir(parents=True, exist_ok=True)
    if temp_root.exists() and not args.keep_temp:
        shutil.rmtree(temp_root)
    temp_root.mkdir(parents=True, exist_ok=True)

    manifest: Dict[str, object] = {
        "version": "synthetic-edge-training-v1",
        "seed": args.seed,
        "sourceAudioDir": str(args.source_audio_dir),
        "sourceManualDir": str(args.source_manual_dir),
        "excludedSourceVideos": [str(item) for item in args.exclude_source_video],
        "sources": [source.video_key for source in sources],
        "samples": [],
    }
    annotations: List[Tuple[str, Segment]] = []
    hard_negatives: List[Dict[str, object]] = []

    for sample_index in range(max(1, args.sample_count)):
        video_key = f"video_{args.start_video_number + sample_index:06d}"
        clips, manual_segments, sample_hard_negatives = build_sample_clips(rng, sources, args, video_key)
        sample_temp = temp_root / video_key
        if sample_temp.exists():
            shutil.rmtree(sample_temp)
        sample_temp.mkdir(parents=True, exist_ok=True)

        clip_paths: List[Path] = []
        for clip_index, clip in enumerate(clips):
            clip_path = sample_temp / f"clip_{clip_index:04d}.wav"
            render_clip(ffmpeg, clip, clip_path)
            clip_paths.append(clip_path)

        audio_path = audio_dir / f"{video_key}.m4a"
        concat_clips(ffmpeg, clip_paths, audio_path, sample_temp)
        manual_path = manual_dir / f"{video_key}_manual.txt"
        write_manual(manual_path, manual_segments)
        annotations.extend([(f"audio/{audio_path.name}", segment) for segment in manual_segments])
        hard_negatives.extend(sample_hard_negatives)
        manifest_samples = manifest["samples"]
        assert isinstance(manifest_samples, list)
        manifest_samples.append({
            "video": video_key,
            "audioPath": str(audio_path),
            "manualPath": str(manual_path),
            "songCount": len(manual_segments),
            "durationSec": round(sum(clip.duration for clip in clips), 3),
            "clipCount": len(clips),
            "hardNegativeCount": len(sample_hard_negatives),
            "clips": [
                {
                    "kind": clip.kind,
                    "durationSec": round(clip.duration, 3),
                    "sourceVideo": clip.source_video,
                    "sourceStartSec": round(clip.source_start, 3),
                    "pattern": clip.source_pattern,
                }
                for clip in clips
            ],
        })
        print(f"[synthetic-edge] wrote {video_key} songs={len(manual_segments)} clips={len(clips)}", flush=True)
        if not args.keep_temp:
            shutil.rmtree(sample_temp, ignore_errors=True)

    write_annotations(args.out_dir / "annotations_synthetic.csv", annotations)
    write_hard_negatives(args.out_dir / "segment_filter_hard_negatives_synthetic.csv", hard_negatives)
    (args.out_dir / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    if not args.keep_temp:
        shutil.rmtree(temp_root, ignore_errors=True)
    print(f"[synthetic-edge] out={args.out_dir} samples={args.sample_count}", flush=True)


if __name__ == "__main__":
    main()
