"""Export review candidates for segment-filter hard negatives.

This tool does not modify training data. It scans smoothing/live summary JSON
files and emits long predicted segments that have little or no overlap with
manual song annotations. Review the CSV manually, then copy confirmed rows to
tools/segment_filter_hard_negatives.csv before retraining.
"""

from __future__ import annotations

import argparse
import csv
import glob
import json
import re
from pathlib import Path
from typing import Dict, Iterable, List, Sequence, Tuple


VIDEO_RE = re.compile(r"video_\d+")
SUMMARY_FILE_PATTERNS = (
    "*.smoothing_summary.json",
    "*.segment_filter_summary.json",
    "*_pcm_filter_on.json",
    "*_aed60_overlap60.json",
    "*_aed60_filter_on.json",
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Export segment-filter hard-negative review candidates.")
    parser.add_argument("inputs", nargs="+", help="Summary JSON files, directories, or glob patterns.")
    parser.add_argument("--out", type=Path, default=Path("tools/segment_filter_hard_negative_candidates.csv"))
    parser.add_argument("--min-duration-sec", type=float, default=60.0)
    parser.add_argument("--min-extra-sec", type=float, default=60.0)
    parser.add_argument("--max-overlap-ratio", type=float, default=0.2)
    parser.add_argument("--min-confidence", type=float, default=0.0)
    return parser.parse_args()


def load_json(path: Path) -> object:
    return json.loads(path.read_text(encoding="utf-8"))


def normalize_video_key(path: Path, payload: Dict[str, object]) -> str:
    for value in [
        payload.get("video"),
        payload.get("videoKey"),
        payload.get("videoId"),
        payload.get("audio"),
        path.name,
    ]:
        text = str(value or "").replace("\\", "/")
        match = VIDEO_RE.search(text)
        if match:
            return match.group(0)
    return path.stem.split(".")[0]


def iter_input_paths(inputs: Sequence[str]) -> List[Path]:
    paths: List[Path] = []
    for item in inputs:
        expanded = [Path(match) for match in glob.glob(item)]
        candidates = expanded or [Path(item)]
        for candidate in candidates:
            if candidate.is_dir():
                for pattern in SUMMARY_FILE_PATTERNS:
                    paths.extend(sorted(candidate.glob(pattern)))
            elif candidate.exists() and candidate.suffix.lower() == ".json":
                paths.append(candidate)
    return sorted(dict.fromkeys(path.resolve() for path in paths))


def finite(value: object, fallback: float = 0.0) -> float:
    try:
        number = float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return fallback
    return number if number == number else fallback


def overlap_seconds(left: Dict[str, object], right: Dict[str, object]) -> float:
    return max(
        0.0,
        min(finite(left.get("endSec")), finite(right.get("endSec")))
        - max(finite(left.get("startSec")), finite(right.get("startSec"))),
    )


def format_time(seconds: float) -> str:
    total = max(0.0, float(seconds))
    whole = int(total)
    frac = total - whole
    hours = whole // 3600
    minutes = (whole % 3600) // 60
    secs = whole % 60
    if frac >= 0.001:
        return f"{hours:02d}:{minutes:02d}:{secs + frac:06.3f}"
    return f"{hours:02d}:{minutes:02d}:{secs:02d}"


def get_segments(payload: Dict[str, object]) -> List[Dict[str, object]]:
    for key in ["segments", "finalSegments"]:
        value = payload.get(key)
        if isinstance(value, list):
            return [item for item in value if isinstance(item, dict)]
    return []


def get_manual_segments(payload: Dict[str, object]) -> List[Dict[str, object]]:
    manual: List[Dict[str, object]] = []
    for match in payload.get("matches", []) if isinstance(payload.get("matches"), list) else []:
        if isinstance(match, dict) and isinstance(match.get("manual"), dict):
            manual.append(match["manual"])  # type: ignore[arg-type]
    return manual


def candidate_rows(path: Path, payload: Dict[str, object], args: argparse.Namespace) -> List[Dict[str, object]]:
    video = normalize_video_key(path, payload)
    manual_segments = get_manual_segments(payload)
    if not manual_segments:
        return []

    rows: List[Dict[str, object]] = []
    for segment in get_segments(payload):
        start = finite(segment.get("startSec"))
        end = finite(segment.get("endSec"))
        duration = max(0.0, end - start)
        confidence = finite(segment.get("confidence"))
        if duration < args.min_duration_sec or confidence < args.min_confidence:
            continue

        overlap = sum(overlap_seconds(segment, manual) for manual in manual_segments)
        extra_sec = max(0.0, duration - overlap)
        overlap_ratio = overlap / max(1.0, duration)
        if extra_sec < args.min_extra_sec or overlap_ratio > args.max_overlap_ratio:
            continue

        rows.append({
            "video": video,
            "start_sec": format_time(start),
            "end_sec": format_time(end),
            "_startSec": start,
            "_endSec": end,
            "reason": "review false-positive candidate",
            "duration_sec": round(duration, 3),
            "confidence": round(confidence, 4),
            "overlap_sec": round(overlap, 3),
            "extra_sec": round(extra_sec, 3),
            "overlap_ratio": round(overlap_ratio, 4),
            "source_summary": str(path),
        })
    return rows


def dedupe_rows(rows: Iterable[Dict[str, object]]) -> List[Dict[str, object]]:
    output: List[Dict[str, object]] = []
    for row in rows:
        video = str(row["video"])
        start = finite(row.get("_startSec"))
        end = finite(row.get("_endSec"))
        duration = max(1.0, end - start)
        duplicate_index = None
        for index, existing in enumerate(output):
            if str(existing["video"]) != video:
                continue
            existing_start = finite(existing.get("_startSec"))
            existing_end = finite(existing.get("_endSec"))
            overlap = max(0.0, min(end, existing_end) - max(start, existing_start))
            existing_duration = max(1.0, existing_end - existing_start)
            if overlap / min(duration, existing_duration) >= 0.9:
                duplicate_index = index
                break
        if duplicate_index is not None:
            existing = output[duplicate_index]
            row_score = (finite(row.get("extra_sec")), finite(row.get("confidence")))
            existing_score = (finite(existing.get("extra_sec")), finite(existing.get("confidence")))
            if row_score > existing_score:
                output[duplicate_index] = row
            continue
        output.append(row)
    return sorted(output, key=lambda item: (str(item["video"]), str(item["start_sec"]), str(item["end_sec"])))


def main() -> None:
    args = parse_args()
    rows: List[Dict[str, object]] = []
    for path in iter_input_paths(args.inputs):
        try:
            payload = load_json(path)
        except Exception as error:  # pragma: no cover - CLI diagnostics.
            print(f"[hard-negative-candidates] skipped {path}: {error}")
            continue
        if not isinstance(payload, dict):
            continue
        rows.extend(candidate_rows(path, payload, args))

    output_rows = dedupe_rows(rows)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    fieldnames = [
        "video",
        "start_sec",
        "end_sec",
        "reason",
        "duration_sec",
        "confidence",
        "overlap_sec",
        "extra_sec",
        "overlap_ratio",
        "source_summary",
    ]
    with args.out.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(output_rows)
    print(f"[hard-negative-candidates] wrote {args.out} rows={len(output_rows)}")


if __name__ == "__main__":
    main()
