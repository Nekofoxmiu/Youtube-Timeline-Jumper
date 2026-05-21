"""Import manually edited playlist JSON as FireRed song-head training data.

The script matches playlist IDs from a Chrome storage export against local
YouTube archive files, stream-copies the first audio track with ffmpeg, and
adds the matched song segments to tools/annotations_example.csv.
"""

from __future__ import annotations

import argparse
import csv
import json
import re
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Iterable, List, Sequence

YOUTUBE_ID_RE = re.compile(r"(?<![A-Za-z0-9_])([A-Za-z0-9_-]{11})(?![A-Za-z0-9_])")
VIDEO_RE = re.compile(r"video_(\d+)")
TRAINING_AUDIO_SUFFIXES = {".aac", ".flac", ".m4a", ".mkv", ".mp3", ".mp4", ".ogg", ".opus", ".wav", ".webm"}


@dataclass(frozen=True)
class Segment:
    start_sec: float
    end_sec: float
    title: str


@dataclass(frozen=True)
class MatchedVideo:
    video_id: str
    source_path: Path
    target_index: int
    target_audio_path: Path
    target_manual_path: Path
    segments: Sequence[Segment]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Import playlist JSON segments into training data.")
    parser.add_argument("--json", type=Path, required=True, help="Chrome storage playlist export JSON.")
    parser.add_argument("--video-root", type=Path, required=True, help="Directory containing local YouTube video files.")
    parser.add_argument("--annotations", type=Path, default=Path("tools/annotations_example.csv"))
    parser.add_argument("--audio-dir", type=Path, default=Path("tools/data/audio"))
    parser.add_argument("--manual-dir", type=Path, default=Path("tools/data/manual"))
    parser.add_argument("--map-out", type=Path, default=Path("tools/data/manual/playlist_training_import_map.json"))
    parser.add_argument("--start-index", type=int, default=None, help="First video_N index to assign. Defaults to next unused.")
    parser.add_argument("--dry-run", action="store_true", help="Plan only; do not write files or run ffmpeg.")
    parser.add_argument("--overwrite-audio", action="store_true", help="Recreate audio files that already exist.")
    parser.add_argument("--ffmpeg", default="ffmpeg")
    parser.add_argument("--ffprobe", default="ffprobe")
    return parser.parse_args()


def require_tool(name: str) -> str:
    resolved = shutil.which(name) or name
    try:
        subprocess.run([resolved, "-version"], check=True, capture_output=True, text=True)
    except Exception as error:
        raise FileNotFoundError(f"Required tool not available: {name}") from error
    return resolved


def seconds_from_time(value: object) -> float:
    if isinstance(value, (int, float)):
        return max(0.0, float(value))
    if isinstance(value, dict):
        hours = float(value.get("hours") or 0)
        minutes = float(value.get("minutes") or 0)
        seconds = float(value.get("seconds") or 0)
        return max(0.0, (hours * 3600) + (minutes * 60) + seconds)
    text = str(value or "").strip()
    if not text:
        return 0.0
    if re.fullmatch(r"\d+(?:\.\d+)?", text):
        return max(0.0, float(text))
    parts = text.split(":")
    try:
        nums = [float(part) for part in parts]
    except ValueError:
        return 0.0
    if len(nums) == 2:
        return max(0.0, (nums[0] * 60) + nums[1])
    if len(nums) == 3:
        return max(0.0, (nums[0] * 3600) + (nums[1] * 60) + nums[2])
    return 0.0


def format_time(seconds: float) -> str:
    rounded = max(0, int(round(seconds)))
    hours = rounded // 3600
    minutes = (rounded % 3600) // 60
    secs = rounded % 60
    return f"{hours:02d}:{minutes:02d}:{secs:02d}"


def extract_segments(raw_items: object) -> List[Segment]:
    segments: List[Segment] = []
    for item in raw_items if isinstance(raw_items, list) else []:
        start = seconds_from_time(item.get("startSec", item.get("start", item.get("time"))))
        end = seconds_from_time(item.get("endSec", item.get("end", item.get("start", item.get("time")))))
        if end <= start:
            continue
        title = str(item.get("title") or "").strip()
        segments.append(Segment(start, end, title))
    return sorted(segments, key=lambda segment: (segment.start_sec, segment.end_sec))


def load_playlist_segments(path: Path) -> Dict[str, List[Segment]]:
    data = json.loads(path.read_text(encoding="utf-8-sig"))
    output: Dict[str, List[Segment]] = {}
    for key, value in data.items():
        if not key.startswith("playlist_") or key.startswith("playlist_meta_"):
            continue
        video_id = key.removeprefix("playlist_")
        segments = extract_segments(value)
        if segments:
            output[video_id] = segments
    return output


def find_video_files(root: Path) -> Dict[str, Path]:
    files: Dict[str, Path] = {}
    for path in root.rglob("*"):
        if not path.is_file() or path.suffix.lower() not in TRAINING_AUDIO_SUFFIXES:
            continue
        matches = YOUTUBE_ID_RE.findall(path.stem)
        for video_id in reversed(matches):
            files.setdefault(video_id, path)
    return files


def existing_video_numbers(paths: Iterable[Path], annotations: Path) -> List[int]:
    numbers: List[int] = []
    for root in paths:
        if root.exists():
            for path in root.rglob("*"):
                match = VIDEO_RE.search(path.name)
                if match:
                    numbers.append(int(match.group(1)))
    if annotations.exists():
        for match in VIDEO_RE.finditer(annotations.read_text(encoding="utf-8-sig")):
            numbers.append(int(match.group(1)))
    return numbers


def load_existing_import_map(path: Path) -> Dict[str, int]:
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8-sig"))
    except json.JSONDecodeError:
        return {}
    output: Dict[str, int] = {}
    for item in data.get("matchedVideos", []):
        video_id = str(item.get("videoId") or "")
        index = item.get("targetIndex")
        if video_id and isinstance(index, int):
            output[video_id] = index
    return output


def next_free_index(used: set[int], start: int) -> int:
    index = max(1, start)
    while index in used:
        index += 1
    used.add(index)
    return index


def audio_extension_for_codec(source_path: Path, ffprobe: str) -> str:
    try:
        proc = subprocess.run(
            [
                ffprobe,
                "-v",
                "error",
                "-select_streams",
                "a:0",
                "-show_entries",
                "stream=codec_name",
                "-of",
                "default=noprint_wrappers=1:nokey=1",
                str(source_path),
            ],
            check=True,
            capture_output=True,
            text=True,
        )
        codec = proc.stdout.strip().splitlines()[0].lower()
    except Exception:
        codec = ""
    if codec in {"aac", "alac", "mp3"}:
        return ".m4a"
    if codec == "opus":
        return ".webm"
    return ".mp4"


def plan_matches(args: argparse.Namespace, ffprobe: str) -> List[MatchedVideo]:
    playlists = load_playlist_segments(args.json)
    local_files = find_video_files(args.video_root)
    existing_map = load_existing_import_map(args.map_out)
    used_numbers = set(existing_video_numbers([args.audio_dir, args.manual_dir], args.annotations))
    used_numbers.update(existing_map.values())
    next_index = args.start_index or (max(used_numbers, default=51) + 1)

    matches: List[MatchedVideo] = []
    for video_id in sorted(playlists):
        source_path = local_files.get(video_id)
        if not source_path:
            continue
        target_index = existing_map.get(video_id)
        if target_index is None:
            target_index = next_free_index(used_numbers, next_index)
            next_index = target_index + 1
        else:
            used_numbers.add(target_index)
        suffix = audio_extension_for_codec(source_path, ffprobe)
        matches.append(MatchedVideo(
            video_id=video_id,
            source_path=source_path,
            target_index=target_index,
            target_audio_path=args.audio_dir / f"video_{target_index:03d}{suffix}",
            target_manual_path=args.manual_dir / f"video_{target_index:03d}_manual.txt",
            segments=playlists[video_id],
        ))
    return matches


def copy_audio_stream(match: MatchedVideo, ffmpeg: str, overwrite: bool) -> None:
    if match.target_audio_path.exists() and not overwrite:
        print(f"[audio] exists {match.target_audio_path}")
        return
    match.target_audio_path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = match.target_audio_path.with_name(f"{match.target_audio_path.stem}.tmp{match.target_audio_path.suffix}")
    if temp_path.exists():
        temp_path.unlink()
    cmd = [
        ffmpeg,
        "-hide_banner",
        "-y",
        "-i",
        str(match.source_path),
        "-map",
        "0:a:0",
        "-vn",
        "-c:a",
        "copy",
        str(temp_path),
    ]
    print(f"[audio] copy {match.video_id} -> {match.target_audio_path.name}")
    proc = subprocess.run(cmd, capture_output=True)
    if proc.returncode != 0:
        stderr = proc.stderr.decode("utf-8", errors="replace") if proc.stderr else ""
        raise RuntimeError(f"ffmpeg failed for {match.source_path}\n{stderr}")
    temp_path.replace(match.target_audio_path)


def write_manual_file(match: MatchedVideo) -> None:
    match.target_manual_path.parent.mkdir(parents=True, exist_ok=True)
    lines = [
        f"{format_time(segment.start_sec)} {format_time(segment.end_sec)} {segment.title or f'Song #{index + 1}'}"
        for index, segment in enumerate(match.segments)
    ]
    match.target_manual_path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def read_annotation_rows(path: Path) -> List[dict]:
    if not path.exists():
        return []
    with path.open("r", newline="", encoding="utf-8-sig") as fh:
        return list(csv.DictReader(fh))


def write_annotations(path: Path, matches: Sequence[MatchedVideo]) -> None:
    fieldnames = ["audio_path", "start_sec", "end_sec", "label"]
    target_paths = {f"data/audio/{match.target_audio_path.name}" for match in matches}
    rows = [row for row in read_annotation_rows(path) if row.get("audio_path") not in target_paths]
    for match in matches:
        logical_path = f"data/audio/{match.target_audio_path.name}"
        for segment in match.segments:
            rows.append({
                "audio_path": logical_path,
                "start_sec": f"{segment.start_sec:.3f}".rstrip("0").rstrip("."),
                "end_sec": f"{segment.end_sec:.3f}".rstrip("0").rstrip("."),
                "label": "song",
            })
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


def write_import_map(path: Path, matches: Sequence[MatchedVideo]) -> None:
    payload = {
        "sourceJson": None,
        "matchedVideos": [
            {
                "videoId": match.video_id,
                "targetIndex": match.target_index,
                "sourcePath": str(match.source_path),
                "audioPath": str(match.target_audio_path),
                "manualPath": str(match.target_manual_path),
                "segmentCount": len(match.segments),
                "songSec": round(sum(segment.end_sec - segment.start_sec for segment in match.segments), 3),
            }
            for match in matches
        ],
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def main() -> None:
    args = parse_args()
    ffmpeg = require_tool(args.ffmpeg)
    ffprobe = require_tool(args.ffprobe)
    matches = plan_matches(args, ffprobe)
    print(f"[plan] matched={len(matches)}")
    for match in matches:
        print(
            f"  video_{match.target_index:03d} {match.video_id} "
            f"segments={len(match.segments)} -> {match.target_audio_path.name}"
        )

    if args.dry_run:
        return

    for match in matches:
        copy_audio_stream(match, ffmpeg, args.overwrite_audio)
        write_manual_file(match)
    write_annotations(args.annotations, matches)
    write_import_map(args.map_out, matches)
    print(f"[done] annotations={args.annotations}")
    print(f"[done] map={args.map_out}")


if __name__ == "__main__":
    main()
