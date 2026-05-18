"""Export FireRedVAD AED PyTorch weights to Chrome-extension ONNX assets.

Expected input:
  - FireRedASR2S source checkout, used for DetectModel definition
  - FireRedVAD/AED model directory containing model.pth.tar and cmvn.ark

Example:
  python tools/export_firered_aed_to_onnx.py ^
    --fireredasr2s-src C:\src\FireRedASR2S ^
    --model-dir C:\models\FireRedVAD\AED ^
    --out-dir models\fireredvad\aed
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import struct
from pathlib import Path
from typing import Any, Dict

import numpy as np
import torch


DEFAULT_LABELS = ["speech", "singing", "music"]


class FireRedAedOnnxWrapper(torch.nn.Module):
    def __init__(self, model: torch.nn.Module) -> None:
        super().__init__()
        self.model = model

    def forward(self, features: torch.Tensor) -> torch.Tensor:
        probs, _ = self.model(features)
        return probs


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Export FireRedVAD AED to ONNX assets for the extension.")
    parser.add_argument(
        "--fireredasr2s-src",
        type=Path,
        required=True,
        help="Path to a FireRedASR2S source checkout containing fireredasr2s/fireredvad/core/detect_model.py.",
    )
    parser.add_argument(
        "--model-dir",
        type=Path,
        required=True,
        help="Path to FireRedVAD/AED directory containing model.pth.tar and cmvn.ark.",
    )
    parser.add_argument(
        "--out-dir",
        type=Path,
        default=Path("models/fireredvad/aed"),
        help="Output directory for model.onnx, cmvn.json and model.meta.json.",
    )
    parser.add_argument("--opset", type=int, default=17, help="ONNX opset version.")
    parser.add_argument("--dummy-frames", type=int, default=1200, help="Dummy time frames for export tracing.")
    parser.add_argument("--feature-dim", type=int, default=80, help="FireRed AED fbank feature dimension.")
    parser.add_argument("--song-threshold", type=float, default=0.56, help="Initial segment start threshold.")
    parser.add_argument("--analysis-window-sec", type=float, default=12.0, help="Browser-side audio window used per inference.")
    parser.add_argument("--evidence-window-sec", type=float, default=4.0, help="Tail window summarized into event evidence.")
    parser.add_argument("--sample-scale", type=float, default=32768.0, help="Scale browser float audio before fbank extraction.")
    parser.add_argument("--validate", action="store_true", help="Run a quick onnxruntime validation after export.")
    return parser.parse_args()


def resolve_detect_model_path(src: Path) -> Path:
    src = src.resolve()
    detect_model_path = src / "fireredasr2s" / "fireredvad" / "core" / "detect_model.py"
    if not detect_model_path.exists():
        raise FileNotFoundError(f"Invalid FireRedASR2S source path: {src}")
    return detect_model_path


def load_detect_model_class(src: Path):
    detect_model_path = resolve_detect_model_path(src)
    spec = importlib.util.spec_from_file_location("firered_detect_model_export", detect_model_path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Failed to load FireRed detect_model.py from {detect_model_path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.DetectModel


def read_kaldi_binary_matrix(path: Path) -> np.ndarray:
    data = path.read_bytes()
    if len(data) < 16 or data[0] != 0 or data[1:2] != b"B":
        raise ValueError(f"Unsupported Kaldi matrix header: {path}")

    token_end = data.index(b" ", 2)
    token = data[2:token_end].decode("ascii")
    offset = token_end + 1

    def read_size(current: int) -> tuple[int, int]:
        if data[current] != 4:
            raise ValueError(f"Unsupported Kaldi int size marker at offset {current}: {data[current]}")
        return struct.unpack_from("<i", data, current + 1)[0], current + 5

    rows, offset = read_size(offset)
    cols, offset = read_size(offset)
    if rows <= 0 or cols <= 0:
        raise ValueError(f"Invalid Kaldi matrix shape: {rows}x{cols}")

    if token == "DM":
        dtype = np.dtype("<f8")
    elif token == "FM":
        dtype = np.dtype("<f4")
    else:
        raise ValueError(f"Unsupported Kaldi matrix token: {token}")

    count = rows * cols
    expected_bytes = count * dtype.itemsize
    if len(data) - offset < expected_bytes:
        raise ValueError(f"Truncated Kaldi matrix: expected {expected_bytes} bytes, got {len(data) - offset}")

    return np.frombuffer(data, dtype=dtype, count=count, offset=offset).reshape(rows, cols)


def load_cmvn(cmvn_path: Path) -> Dict[str, Any]:
    try:
        import kaldiio  # type: ignore

        stats = kaldiio.load_mat(str(cmvn_path))
    except ImportError:
        stats = read_kaldi_binary_matrix(cmvn_path)

    if stats.shape[0] != 2:
        raise ValueError(f"Unexpected CMVN shape: {stats.shape}")

    dim = stats.shape[-1] - 1
    count = float(stats[0, dim])
    if count < 1:
        raise ValueError("Invalid CMVN stats: count < 1")

    means = []
    inverse_std_variances = []
    floor = 1e-20
    for idx in range(dim):
        mean = float(stats[0, idx] / count)
        variance = float((stats[1, idx] / count) - (mean * mean))
        variance = max(floor, variance)
        means.append(mean)
        inverse_std_variances.append(1.0 / float(np.sqrt(variance)))

    return {
        "dim": dim,
        "means": means,
        "inverseStdVariances": inverse_std_variances,
        "source": str(cmvn_path.resolve()),
    }


def export_onnx(args: argparse.Namespace) -> Path:
    DetectModel = load_detect_model_class(args.fireredasr2s_src)

    model_dir = args.model_dir.resolve()
    model_path = model_dir / "model.pth.tar"
    cmvn_path = model_dir / "cmvn.ark"
    if not model_path.exists():
        raise FileNotFoundError(model_path)
    if not cmvn_path.exists():
        raise FileNotFoundError(cmvn_path)

    args.out_dir.mkdir(parents=True, exist_ok=True)

    model = DetectModel.from_pretrained(str(model_dir))
    model.cpu().eval()
    wrapper = FireRedAedOnnxWrapper(model).cpu().eval()

    dummy = torch.randn(1, args.dummy_frames, args.feature_dim, dtype=torch.float32)
    out_path = args.out_dir / "model.onnx"

    torch.onnx.export(
        wrapper,
        dummy,
        str(out_path),
        input_names=["features"],
        output_names=["event_probs"],
        dynamic_axes={
            "features": {0: "batch", 1: "frames"},
            "event_probs": {0: "batch", 1: "frames"},
        },
        opset_version=args.opset,
        do_constant_folding=True,
    )

    cmvn = load_cmvn(cmvn_path)
    cmvn_out = args.out_dir / "cmvn.json"
    cmvn_out.write_text(json.dumps(cmvn, ensure_ascii=False, indent=2), encoding="utf-8")

    meta = {
        "modelType": "firered-vad-aed",
        "detectorVersion": "firered-aed-onnx-v1",
        "inputName": "features",
        "outputName": "event_probs",
        "labels": DEFAULT_LABELS,
        "sampleRate": 16000,
        "frameLengthMs": 25,
        "frameShiftMs": 10,
        "featureDim": args.feature_dim,
        "songThreshold": float(args.song_threshold),
        "analysisWindowSec": float(args.analysis_window_sec),
        "evidenceWindowSec": float(args.evidence_window_sec),
        "minAudioSec": 1.2,
        "sampleScale": float(args.sample_scale),
        "preemphasis": 0.97,
        "melMinHz": 20,
        "melMaxHz": 7600,
        "sourceModelDir": str(model_dir),
        "notes": "Browser runtime expects local 16 kHz mono fbank features with CMVN from cmvn.json.",
    }
    (args.out_dir / "model.meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")

    readme_src = args.out_dir / "README.md"
    if not readme_src.exists():
        readme_src.write_text(
            "# FireRed AED runtime assets\n\nGenerated by tools/export_firered_aed_to_onnx.py.\n",
            encoding="utf-8",
        )

    return out_path


def validate_onnx(out_path: Path, frames: int, feature_dim: int) -> None:
    import onnxruntime as ort  # type: ignore

    session = ort.InferenceSession(str(out_path), providers=["CPUExecutionProvider"])
    input_name = session.get_inputs()[0].name
    output_name = session.get_outputs()[0].name
    x = np.random.randn(1, frames, feature_dim).astype(np.float32)
    y = session.run([output_name], {input_name: x})[0]
    if y.ndim != 3 or y.shape[0] != 1 or y.shape[1] != frames or y.shape[2] != len(DEFAULT_LABELS):
        raise RuntimeError(f"Unexpected ONNX output shape: {y.shape}")
    print(f"[validate] {input_name} -> {output_name}, output shape={y.shape}")


def main() -> None:
    args = parse_args()
    out_path = export_onnx(args)
    if args.validate:
        validate_onnx(out_path, min(args.dummy_frames, 300), args.feature_dim)
    print(f"[done] exported FireRed AED assets to {args.out_dir.resolve()}")
    print("[next] reload the unpacked Chrome extension and select FireRed AED in the popup.")


if __name__ == "__main__":
    main()
