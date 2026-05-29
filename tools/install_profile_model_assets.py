"""Install profile-specific segment filter assets after a passed gate.

This tool intentionally does not train or evaluate models. It only installs a
candidate that has already passed the matching replacement gate and strict
metadata validation.
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List


PROFILE_SUFFIX = {
    "offline-final": "offline_final",
    "live-pcm30": "live_pcm30",
    "live-realtime-aed60": "live_aed60",
}

ASSET_STEMS = ("segment_filter", "edge_trim_advisor")
ASSET_EXTS = (".onnx", ".meta.json")

LIVE_CANDIDATE_VARIANT = {
    "live-pcm30": "pcm-candidate-model",
    "live-realtime-aed60": "aed60-candidate-model",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Safely install profile-specific FireRed AED head assets.")
    parser.add_argument("--profile", choices=sorted(PROFILE_SUFFIX), required=True)
    parser.add_argument("--candidate-dir", type=Path, required=True)
    parser.add_argument("--gate-summary", type=Path, required=True)
    parser.add_argument("--install-dir", type=Path, default=Path("models/fireredvad/aed"))
    parser.add_argument("--backup-dir", type=Path, default=Path("training_runs/model_backups"))
    parser.add_argument("--python", default=sys.executable or "python")
    parser.add_argument("--dry-run", action="store_true")
    return parser.parse_args()


def load_json(path: Path) -> Dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def profile_asset_names(profile: str) -> List[str]:
    suffix = PROFILE_SUFFIX[profile]
    return [
        f"{stem}_{suffix}{ext}"
        for stem in ASSET_STEMS
        for ext in ASSET_EXTS
    ]


def require_mapping(value: Any, label: str) -> Dict[str, Any]:
    if not isinstance(value, dict):
        raise RuntimeError(f"Gate summary missing object: {label}")
    return value


def require_passed(value: Any, label: str) -> None:
    if value is not True:
        raise RuntimeError(f"Gate summary did not pass required gate: {label}")


def require_regression_rows_passed(rows: Any, label: str, candidate_variant: str | None = None) -> None:
    if not isinstance(rows, list) or not rows:
        raise RuntimeError(f"Gate summary missing regression rows: {label}")
    selected = [
        row for row in rows
        if isinstance(row, dict)
        and (
            candidate_variant is None
            or row.get("candidate") == candidate_variant
            or row.get("variant") == candidate_variant
        )
    ]
    if not selected:
        raise RuntimeError(f"Gate summary missing candidate regression row: {label} candidate={candidate_variant}")
    failed = [row for row in selected if row.get("passed") is not True]
    if failed:
        raise RuntimeError(f"Gate summary has failed regression rows: {label}")


def validate_live_gate_payload(profile: str, payload: Dict[str, Any]) -> None:
    candidate_variant = LIVE_CANDIDATE_VARIANT[profile]
    sampled_gate = require_mapping(payload.get("sampledGate"), "sampledGate")
    suite_gate = require_mapping(payload.get("suiteGate"), "suiteGate")

    require_regression_rows_passed(sampled_gate.get("regression"), "sampledGate.regression")
    require_regression_rows_passed(
        sampled_gate.get("candidateCurrentRegression"),
        "sampledGate.candidateCurrentRegression",
        candidate_variant,
    )

    require_passed(suite_gate.get("passed"), "suiteGate")
    if suite_gate.get("requireProfileAssets") is not True:
        raise RuntimeError("Live suiteGate was not run with requireProfileAssets.")
    for key in ("normalGate", "extendedGate", "stopGate", "hardNegativeGate"):
        gate = require_mapping(suite_gate.get(key), f"suiteGate.{key}")
        require_passed(gate.get("passed"), f"suiteGate.{key}")
    snapshot_gates = suite_gate.get("snapshotGates")
    if snapshot_gates is not None:
        gate = require_mapping(snapshot_gates, "suiteGate.snapshotGates")
        if "passed" in gate:
            require_passed(gate.get("passed"), "suiteGate.snapshotGates")
        else:
            require_regression_rows_passed(
                suite_gate.get("snapshotRegression"),
                "suiteGate.snapshotRegression",
                candidate_variant,
            )


def validate_offline_gate_payload(profile: str, payload: Dict[str, Any]) -> None:
    if profile != "offline-final":
        raise RuntimeError(f"Offline gate payload cannot install profile {profile!r}")
    current = require_mapping(payload.get("current"), "current")
    candidate = require_mapping(payload.get("candidate"), "candidate")
    for label, section in (("current", current), ("candidate", candidate)):
        if int(section.get("failureCount") or 0) != 0:
            raise RuntimeError(f"Offline {label} evaluation has failures.")
        if section.get("segmentFilterAssetProfileUsed") != "offline-final":
            raise RuntimeError(f"Offline {label} segment filter did not use offline-final asset.")
        if section.get("edgeTrimAdvisorAssetProfileUsed") != "offline-final":
            raise RuntimeError(f"Offline {label} edge advisor did not use offline-final asset.")
    if float(payload.get("f1Drop") or 0.0) > float(payload.get("maxF1Drop") or 0.0):
        raise RuntimeError("Offline candidate aggregate F1 regressed.")
    if float(payload.get("meanF1Drop") or 0.0) > float(payload.get("maxMeanF1Drop") or 0.0):
        raise RuntimeError("Offline candidate mean F1 regressed.")
    if int(payload.get("severeOutlierIncrease") or 0) > int(payload.get("maxSevereOutlierIncrease") or 0):
        raise RuntimeError("Offline candidate severe outlier count increased.")


def validate_gate_summary(profile: str, candidate_dir: Path, gate_summary: Path) -> Dict[str, Any]:
    payload = load_json(gate_summary)
    if payload.get("passed") is not True:
        raise RuntimeError(f"Gate summary did not pass: {gate_summary}")

    summary_profile = payload.get("profile")
    if summary_profile and summary_profile != profile:
        raise RuntimeError(f"Gate summary profile={summary_profile!r}, expected {profile!r}")

    summary_candidate = payload.get("candidateDir") or payload.get("candidateModelDir")
    if summary_candidate:
        expected = candidate_dir.resolve()
        actual = Path(str(summary_candidate)).resolve()
        if actual != expected:
            raise RuntimeError(f"Gate summary candidateDir={actual}, expected {expected}")

    if profile.startswith("live-"):
        validate_live_gate_payload(profile, payload)
    else:
        validate_offline_gate_payload(profile, payload)
    return payload


def run_profile_validation(args: argparse.Namespace) -> None:
    command = [
        args.python,
        "tools/validate_profile_assets.py",
        "--models-dir",
        str(args.candidate_dir),
        "--profile",
        args.profile,
        "--require-post-end-guard-metadata",
    ]
    print(f"[install-profile-assets] {' '.join(str(item) for item in command)}", flush=True)
    subprocess.run(command, check=True)


def validate_files_exist(candidate_dir: Path, install_dir: Path, profile: str) -> List[str]:
    names = profile_asset_names(profile)
    missing = [name for name in names if not (candidate_dir / name).exists()]
    if missing:
        raise RuntimeError(f"Candidate asset(s) missing: {', '.join(missing)}")
    missing_current = [name for name in names if not (install_dir / name).exists()]
    if missing_current:
        raise RuntimeError(f"Current installed asset(s) missing, cannot backup safely: {', '.join(missing_current)}")
    return names


def backup_current_assets(args: argparse.Namespace, names: List[str]) -> Path:
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    backup_path = args.backup_dir / f"{args.profile}_{timestamp}"
    print(f"[install-profile-assets] backup {args.install_dir} -> {backup_path}", flush=True)
    if args.dry_run:
        return backup_path

    backup_path.mkdir(parents=True, exist_ok=False)
    for name in names:
        shutil.copy2(args.install_dir / name, backup_path / name)
    manifest = {
        "profile": args.profile,
        "installedFrom": str(args.candidate_dir),
        "gateSummary": str(args.gate_summary),
        "installDir": str(args.install_dir),
        "assets": names,
        "createdAt": timestamp,
    }
    (backup_path / "backup_manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return backup_path


def install_assets(args: argparse.Namespace, names: List[str]) -> None:
    print(f"[install-profile-assets] install profile={args.profile} assets={len(names)}", flush=True)
    if args.dry_run:
        for name in names:
            print(f"[install-profile-assets] would copy {args.candidate_dir / name} -> {args.install_dir / name}")
        return

    for name in names:
        shutil.copy2(args.candidate_dir / name, args.install_dir / name)


def main() -> int:
    args = parse_args()
    validate_gate_summary(args.profile, args.candidate_dir, args.gate_summary)
    run_profile_validation(args)
    names = validate_files_exist(args.candidate_dir, args.install_dir, args.profile)
    backup_path = backup_current_assets(args, names)
    install_assets(args, names)
    print(
        json.dumps(
            {
                "profile": args.profile,
                "candidateDir": str(args.candidate_dir),
                "gateSummary": str(args.gate_summary),
                "installDir": str(args.install_dir),
                "backupPath": str(backup_path),
                "assets": names,
                "dryRun": args.dry_run,
            },
            ensure_ascii=False,
            indent=2,
        ),
        flush=True,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
