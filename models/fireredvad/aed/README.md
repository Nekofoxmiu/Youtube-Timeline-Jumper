# FireRed AED runtime assets

Place exported FireRed AED ONNX assets here:

- `model.onnx`
- `cmvn.json`
- `model.meta.json`
- `firered_song_head.onnx`
- `firered_song_head.meta.json`
- `segment_filter.onnx`
- `segment_filter.meta.json`
- `edge_trim_advisor.onnx`
- `edge_trim_advisor.meta.json`
- `segment_filter_offline_final.onnx`
- `segment_filter_offline_final.meta.json`
- `edge_trim_advisor_offline_final.onnx`
- `edge_trim_advisor_offline_final.meta.json`

Offline and Live finalization can use profile-specific segment filter assets.
Keep these in sync with `tools/package_extension.ps1` so packaged builds do not
silently use another mode's assets. Extension runtime requires the active
profile asset; if it is missing, finalization falls back to heuristic smoothing
instead of loading the legacy default model.
Each profile metadata file must declare both `assetProfile` and
`trainingProfile` so runtime loading and model provenance can be audited.

- `segment_filter_offline_final.onnx`
- `segment_filter_offline_final.meta.json`
- `edge_trim_advisor_offline_final.onnx`
- `edge_trim_advisor_offline_final.meta.json`
- `segment_filter_live_pcm30.onnx`
- `segment_filter_live_pcm30.meta.json`
- `edge_trim_advisor_live_pcm30.onnx`
- `edge_trim_advisor_live_pcm30.meta.json`
- `segment_filter_live_aed60.onnx`
- `segment_filter_live_aed60.meta.json`
- `edge_trim_advisor_live_aed60.onnx`
- `edge_trim_advisor_live_aed60.meta.json`

Generate them with:

```powershell
python tools/export_firered_aed_to_onnx.py `
  --fireredasr2s-src C:\path\to\FireRedASR2S `
  --model-dir C:\path\to\FireRedVAD\AED `
  --out-dir models\fireredvad\aed
```

The Chrome extension runs these files locally inside the MV3 offscreen document through ONNX Runtime Web WASM.

Validate shipped profile assets with:

```powershell
python tools\validate_profile_assets.py
```

Use `--require-post-end-guard-metadata` before accepting newly retrained profile
assets.

Current accepted `live-pcm30` profile:

- Installed from `training_runs/segment_filter_live_pcm30_full_v2_guard_thr050_candidate`.
- Previous assets backed up under `training_runs/model_backups/live-pcm30_20260528T161402Z`.
- `segment_filter_live_pcm30.meta.json` uses `liveFinalKeepThreshold=0.5`.
- Replacement gate: `training_runs/live_pcm30_full_v2_guard_thr050_replacement_gate` passed sampled, primary, extended, no-song, stop-checkpoint, and snapshot-unavailable suites.

Current accepted `live-realtime-aed60` profile:

- Installed from `training_runs/segment_filter_live_aed60_full_v2_guard_thr050_candidate`.
- Previous assets backed up under `training_runs/model_backups/live-realtime-aed60_20260528T175042Z`.
- `segment_filter_live_aed60.meta.json` uses `liveFinalKeepThreshold=0.5`.
- Replacement gate: `training_runs/live_aed60_full_v2_guard_thr050_replacement_gate` passed sampled, primary, extended, no-song, stop-checkpoint, and snapshot-unavailable suites.

Current `offline-final` profile:

- The shipped profile remains the pre-guard model because the guarded v2
  candidate did not pass the offline replacement gate.
- Rejected candidate: `training_runs/segment_filter_offline_final_full_v2_guard_candidate`.
- Gate result: `training_runs/offline_final_full_v2_guard_replacement_gate`
  reported current `meanF1=0.9872`, severe outliers `6`; candidate
  `meanF1=0.9710`, severe outliers `20`.
- Metadata warnings about missing `postEndNegativeSongEvidenceSkip` are expected
  for this profile until a future offline candidate passes the gate.
