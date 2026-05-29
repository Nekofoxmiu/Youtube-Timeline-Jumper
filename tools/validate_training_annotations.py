"""Validate training CSV song annotations against manual segment files.

The validator is intentionally conservative: it fails on invalid or mismatched
segments when both CSV and manual data exist, but missing manual files are
warnings unless --require-manual is passed.
"""

from __future__ import annotations

import argparse
import csv
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Iterable, List, Sequence

VIDEO_RE = re.compile(r"video_(\d+)")


@dataclass(frozen=True)
class Segment:
    start_sec: float
    end_sec: float
    source: str


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Validate training annotations against manual files.")
    parser.add_argument("--annotations", type=Path, default=Path("tools/annotations_example.csv"))
    parser.add_argument("--manual-dir", type=Path, default=Path("tools/data/manual"))
    parser.add_argument("--tolerance-sec", type=float, default=0.51)
    parser.add_argument("--require-manual", action="store_true")
    return parser.parse_args()


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
        raise ValueError(f"Invalid time value: {value!r}") from None


def video_key_from_path(value: object) -> str:
    text = str(value or "").replace("\\", "/")
    match = VIDEO_RE.search(text)
    return f"video_{int(match.group(1)):03d}" if match else ""


def load_csv_segments(path: Path) -> Dict[str, List[Segment]]:
    groups: Dict[str, List[Segment]] = {}
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        for row_number, row in enumerate(reader, 2):
            if str(row.get("label") or "").strip().lower() != "song":
                continue
            video = video_key_from_path(row.get("audio_path"))
            if not video:
                raise ValueError(f"{path}:{row_number}: cannot infer video_* from audio_path")
            start = parse_time_sec(row.get("start_sec"))
            end = parse_time_sec(row.get("end_sec"))
            if end <= start:
                raise ValueError(f"{path}:{row_number}: end_sec must be after start_sec")
            groups.setdefault(video, []).append(Segment(start, end, f"{path}:{row_number}"))
    for segments in groups.values():
        segments.sort(key=lambda item: (item.start_sec, item.end_sec))
    return groups


def load_manual_file(path: Path) -> List[Segment]:
    segments: List[Segment] = []
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
            raise ValueError(f"{path}:{line_number}: end time must be after start time")
        segments.append(Segment(start, end, f"{path}:{line_number}"))
    return sorted(segments, key=lambda item: (item.start_sec, item.end_sec))


def overlap_sec(a: Segment, b: Segment) -> float:
    return max(0.0, min(a.end_sec, b.end_sec) - max(a.start_sec, b.start_sec))


def has_internal_overlap(segments: Sequence[Segment], tolerance_sec: float) -> List[str]:
    errors: List[str] = []
    for previous, current in zip(segments, segments[1:]):
        if current.start_sec < previous.end_sec - tolerance_sec:
            errors.append(
                f"overlap {previous.source} ({previous.start_sec:.3f}-{previous.end_sec:.3f}) "
                f"with {current.source} ({current.start_sec:.3f}-{current.end_sec:.3f})"
            )
    return errors


def compare_segments(video: str, csv_segments: Sequence[Segment], manual_segments: Sequence[Segment], tolerance_sec: float) -> List[str]:
    errors: List[str] = []
    if len(csv_segments) != len(manual_segments):
        errors.append(f"{video}: count mismatch csv={len(csv_segments)} manual={len(manual_segments)}")

    matched_manual = set()
    for csv_segment in csv_segments:
        best_index = -1
        best_overlap = 0.0
        for index, manual_segment in enumerate(manual_segments):
            if index in matched_manual:
                continue
            current_overlap = overlap_sec(csv_segment, manual_segment)
            if current_overlap > best_overlap:
                best_overlap = current_overlap
                best_index = index
        if best_index < 0:
            errors.append(f"{video}: csv segment has no manual match {csv_segment.source}")
            continue
        manual_segment = manual_segments[best_index]
        start_delta = abs(csv_segment.start_sec - manual_segment.start_sec)
        end_delta = abs(csv_segment.end_sec - manual_segment.end_sec)
        if start_delta > tolerance_sec or end_delta > tolerance_sec:
            errors.append(
                f"{video}: mismatch csv {csv_segment.start_sec:.3f}-{csv_segment.end_sec:.3f} "
                f"vs manual {manual_segment.start_sec:.3f}-{manual_segment.end_sec:.3f} "
                f"(delta start={start_delta:.3f}, end={end_delta:.3f})"
            )
        matched_manual.add(best_index)
    return errors


def print_items(prefix: str, items: Iterable[str]) -> None:
    for item in items:
        print(f"{prefix}{item}")


def main() -> int:
    args = parse_args()
    csv_groups = load_csv_segments(args.annotations)
    errors: List[str] = []
    warnings: List[str] = []

    for video, csv_segments in sorted(csv_groups.items()):
        manual_path = args.manual_dir / f"{video}_manual.txt"
        errors.extend(f"{video}: csv {error}" for error in has_internal_overlap(csv_segments, args.tolerance_sec))
        if not manual_path.exists():
            message = f"{video}: missing manual file {manual_path}"
            if args.require_manual:
                errors.append(message)
            else:
                warnings.append(message)
            continue
        manual_segments = load_manual_file(manual_path)
        errors.extend(f"{video}: manual {error}" for error in has_internal_overlap(manual_segments, args.tolerance_sec))
        errors.extend(compare_segments(video, csv_segments, manual_segments, args.tolerance_sec))

    print(f"[validate-training-annotations] videos={len(csv_groups)} errors={len(errors)} warnings={len(warnings)}")
    print_items("[warning] ", warnings[:20])
    if len(warnings) > 20:
        print(f"[warning] ... {len(warnings) - 20} more")
    print_items("[error] ", errors[:50])
    if len(errors) > 50:
        print(f"[error] ... {len(errors) - 50} more")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
