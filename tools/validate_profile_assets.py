"""Validate shipped FireRed profile model assets.

This is a packaging/audit guard, not a quality metric. It verifies that each
runtime profile has the expected ONNX and metadata files and that metadata
matches the profile that will load it.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Dict, List, Sequence


PROFILES = (
    ("offline-final", "offline_final"),
    ("live-pcm30", "live_pcm30"),
    ("live-realtime-aed60", "live_aed60"),
)

ASSET_KINDS = (
    {
        "stem": "segment_filter",
        "model_type": "firered-segment-filter",
        "output_name": "keep_probability",
    },
    {
        "stem": "edge_trim_advisor",
        "model_type": "firered-edge-trim-advisor",
        "output_name": "edge_trim_delta_sec",
    },
)

POST_END_NEGATIVE_WINDOW_SEC = (0.5, 14.0)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Validate FireRed profile ONNX assets and metadata.")
    parser.add_argument("--models-dir", type=Path, default=Path("models/fireredvad/aed"))
    parser.add_argument(
        "--profile",
        action="append",
        choices=[profile for profile, _suffix in PROFILES],
        help="Profile to validate. May be repeated. Defaults to all profiles.",
    )
    parser.add_argument(
        "--require-post-end-guard-metadata",
        action="store_true",
        help="Fail when an asset lacks explicit post-end song-evidence guard metadata.",
    )
    return parser.parse_args()


def load_json(path: Path, errors: List[str]) -> Dict[str, Any]:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:  # pragma: no cover - diagnostic path
        errors.append(f"{path}: failed to parse JSON: {exc}")
        return {}


def number_pair(value: Any) -> tuple[float, float] | None:
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes)) or len(value) != 2:
        return None
    try:
        return (float(value[0]), float(value[1]))
    except (TypeError, ValueError):
        return None


def check_equal(errors: List[str], path: Path, key: str, actual: Any, expected: Any) -> None:
    if actual != expected:
        errors.append(f"{path}: {key}={actual!r}, expected {expected!r}")


def validate_asset(
    models_dir: Path,
    profile: str,
    suffix: str,
    kind: Dict[str, str],
    errors: List[str],
    warnings: List[str],
    require_post_end_guard_metadata: bool,
) -> None:
    stem = kind["stem"]
    base = models_dir / f"{stem}_{suffix}"
    onnx_path = base.with_suffix(".onnx")
    meta_path = base.with_suffix(".meta.json")

    if not onnx_path.exists():
        errors.append(f"{onnx_path}: missing ONNX model")
    if not meta_path.exists():
        errors.append(f"{meta_path}: missing metadata")
        return

    meta = load_json(meta_path, errors)
    if not meta:
        return

    check_equal(errors, meta_path, "assetProfile", meta.get("assetProfile"), profile)
    check_equal(errors, meta_path, "trainingProfile", meta.get("trainingProfile"), profile)
    check_equal(errors, meta_path, "modelType", meta.get("modelType"), kind["model_type"])
    check_equal(errors, meta_path, "inputName", meta.get("inputName"), "segment_features")
    check_equal(errors, meta_path, "outputName", meta.get("outputName"), kind["output_name"])

    input_dim = meta.get("inputDim")
    feature_names = meta.get("featureNames")
    if not isinstance(input_dim, int) or input_dim <= 0:
        errors.append(f"{meta_path}: inputDim must be a positive integer")
    if not isinstance(feature_names, list):
        errors.append(f"{meta_path}: featureNames must be an array")
    elif isinstance(input_dim, int) and len(feature_names) != input_dim:
        errors.append(f"{meta_path}: featureNames length {len(feature_names)} != inputDim {input_dim}")

    negative_mining = meta.get("negativeMining")
    if not isinstance(negative_mining, dict):
        errors.append(f"{meta_path}: negativeMining must be present")
        return

    post_end_window = number_pair(negative_mining.get("manualPostEndWindowSec"))
    if post_end_window != POST_END_NEGATIVE_WINDOW_SEC:
        errors.append(
            f"{meta_path}: negativeMining.manualPostEndWindowSec={post_end_window!r}, "
            f"expected {POST_END_NEGATIVE_WINDOW_SEC!r}"
        )

    guard = negative_mining.get("postEndNegativeSongEvidenceSkip")
    if guard is None:
        message = f"{meta_path}: postEndNegativeSongEvidenceSkip metadata missing; retrain before replacing this asset"
        if require_post_end_guard_metadata:
            errors.append(message)
        else:
            warnings.append(message)
    elif isinstance(guard, dict) and guard.get("enabled") is False:
        errors.append(f"{meta_path}: postEndNegativeSongEvidenceSkip is disabled")


def main() -> int:
    args = parse_args()
    models_dir = args.models_dir
    errors: List[str] = []
    warnings: List[str] = []
    selected_profiles = set(args.profile or [])
    profiles = [
        (profile, suffix)
        for profile, suffix in PROFILES
        if not selected_profiles or profile in selected_profiles
    ]

    for profile, suffix in profiles:
        for kind in ASSET_KINDS:
            validate_asset(
                models_dir=models_dir,
                profile=profile,
                suffix=suffix,
                kind=kind,
                errors=errors,
                warnings=warnings,
                require_post_end_guard_metadata=args.require_post_end_guard_metadata,
            )

    for warning in warnings:
        print(f"WARNING: {warning}")

    if errors:
        for error in errors:
            print(f"ERROR: {error}", file=sys.stderr)
        return 1

    print(f"FireRed profile asset validation passed: profiles={len(profiles)} assets={len(profiles) * len(ASSET_KINDS)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
