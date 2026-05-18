#!/usr/bin/env python3
"""Convert audio into a Chrome Web Audio friendly WAV file for Workbench.

Some YouTube m4a files are fragmented MP4/DASH containers. They may be valid
audio files but still fail in Chrome's AudioContext.decodeAudioData().
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Convert m4a/mp3/etc. to 16 kHz mono WAV for the extension workbench."
    )
    parser.add_argument("--input", "-i", required=True, type=Path, help="Input audio file.")
    parser.add_argument(
        "--output",
        "-o",
        type=Path,
        default=None,
        help="Output WAV path. Defaults to <input>.workbench.wav.",
    )
    parser.add_argument("--sample-rate", type=int, default=16000, help="Output sample rate.")
    parser.add_argument("--channels", type=int, default=1, help="Output channel count.")
    parser.add_argument("--ffmpeg", default="ffmpeg", help="ffmpeg executable path.")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    input_path = args.input.expanduser().resolve()
    if not input_path.exists():
        raise FileNotFoundError(f"Input file not found: {input_path}")

    ffmpeg_path = shutil.which(args.ffmpeg) or args.ffmpeg
    output_path = args.output or input_path.with_suffix(".workbench.wav")
    output_path = output_path.expanduser().resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)

    command = [
        ffmpeg_path,
        "-hide_banner",
        "-y",
        "-i",
        str(input_path),
        "-vn",
        "-ac",
        str(args.channels),
        "-ar",
        str(args.sample_rate),
        "-c:a",
        "pcm_s16le",
        str(output_path),
    ]
    completed = subprocess.run(
        command,
        text=True,
        encoding="utf-8",
        errors="replace",
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    if completed.returncode != 0:
        raise RuntimeError(f"ffmpeg failed with code {completed.returncode}\n{completed.stderr}")

    print(output_path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
