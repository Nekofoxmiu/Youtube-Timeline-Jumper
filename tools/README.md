# Tools Layout

This directory contains local development and model-evaluation utilities. These
scripts are not loaded by the Chrome extension at runtime unless explicitly
called from a development command.

## Stable Entrypoints

- `package_extension.ps1`: build a release ZIP.
  Pass `-RequirePostEndGuardMetadata` for a strict release candidate package
  check after retraining profile assets with post-end song-evidence guard
  metadata.
- `audit_detection_pipeline_contracts.mjs`: verify the shared detection
  contracts, profile assets, live/offline pipeline invariants, and live
  regression sample pools.
- `convert_audio_for_workbench.py`: convert unsupported local audio into a
  Workbench-friendly WAV.
- `validate_training_annotations.py`: verify `annotations_example.csv` against
  available `tools/data/manual/video_*_manual.txt` files before retraining.
- `validate_profile_assets.py`: verify shipped FireRed profile ONNX/metadata
  files before packaging or replacing profile-specific heads.

## Training And Offline Evaluation

- `train_firered_song_head_from_csv.py`: train the historical song head from CSV
  annotations.
- `train_firered_temporal_head.py`: train the FireRed temporal head.
- `train_segment_filter.py`: train segment keep/drop and edge-trim advisors.
- `segment_filter_features.py`: shared feature extraction for Python segment
  filter tooling.
- `evaluate_smoothing_batch.py`: batch offline smoothing evaluation.
- `run_offline_profile_replacement_gate.py`: compare a candidate
  `offline-final` profile model against current shipped assets before
  replacement.
- `install_profile_model_assets.py`: install profile-specific model assets only
  after a passed replacement gate, with backup.
- `diagnose_offline_detection.py`: per-file offline diagnostics.
- `run_global_smoothing.mjs`: Node wrapper for global smoothing from cached
  frames.
- Runtime frame normalization is centralized in
  `lib/songDetection/analysisFrame.js`; Offline, Live AED60, and Live PCM30
  should feed smoothing/filtering through that contract.

## Live Evaluation

Live simulation, regression, and diagnostics live under `tools/live/`.

- `tools/live/simulate_live_pcm_detection.mjs`
- `tools/live/run_live_pcm_ab_samples.mjs`
- `tools/live/run_live_quality_gate.mjs`
- `tools/live/run_live_profile_replacement_gate.mjs`
- `tools/live/run_live_regression_suite.mjs`
- `tools/live/simulate_live_smoothing.mjs`
- `tools/live/compare_live_ab_summaries.mjs`
- `tools/live/compare_live_pcm_diagnostics.mjs`
- `tools/live/summarize_live_diagnostics.mjs`

Sample sets for live A/B and regression live under `tools/samples/live/`.

For ordinary Live changes, run:

```powershell
node tools/live/run_live_quality_gate.mjs
```

By default, the quality gate validates profile assets and annotations, runs
static checks for runtime and live scripts, verifies packaging, then samples 3
entries from
`tools/samples/live/live_pcm_full_regression_samples.example.json` using a
deterministic seed. It writes the selected sample JSON into the output directory
so the A/B result is reproducible. The full pool is intentionally limited to
multi-song samples that have both local audio and manual annotations; `video_052`
is currently excluded because the matching audio file is missing.

To inspect the deterministic sample plan without running static checks or A/B:

```powershell
node tools/live/run_live_quality_gate.mjs --sample-plan-only
```

To force the historical fixed primary set, pass:

```powershell
node tools/live/run_live_quality_gate.mjs `
  --samples tools/samples/live/live_pcm_ab_samples.example.json
```

For candidate model assets, add:

```powershell
node tools/live/run_live_quality_gate.mjs `
  --candidate-segment-filter-model-dir training_runs/<candidate-dir>
```

Before replacing any shipped Live profile asset, use the stricter replacement
gate instead. It runs the sampled 3-video quality gate plus primary,
stop-checkpoint, snapshot-unavailable, and no-song suites with
`--require-profile-assets`:

```powershell
node tools/live/run_live_profile_replacement_gate.mjs `
  --profile live-pcm30 `
  --candidate-segment-filter-model-dir training_runs/<candidate-dir> `
  --jobs 3
```

The replacement gate validates candidate metadata with
`--require-post-end-guard-metadata` before running A/B, so candidates trained
without the post-end song-evidence guard cannot be installed by accident.

After a replacement gate passes, install the profile-specific assets with:

```powershell
python tools/install_profile_model_assets.py `
  --profile live-pcm30 `
  --candidate-dir training_runs/<candidate-dir> `
  --gate-summary training_runs/<gate-dir>/live_profile_replacement_gate_summary.json
```

The installer backs up the existing profile files under
`training_runs/model_backups/` and does not copy legacy `segment_filter.*`
fallback filenames. It rejects minimal or hand-written `passed: true` summaries;
Live summaries must include sampled and suite gates, and Offline summaries must
include current/candidate metric comparisons.

Compatibility wrappers remain at:

- `tools/simulate_live_pcm_detection.mjs`
- `tools/simulate_live_smoothing.mjs`

Prefer the `tools/live/` paths for new commands.

## Experiment Notes

Long-running experiment notes live under `tools/docs/`.

- `tools/docs/live_detection_regression.md`
- `tools/docs/mode_specific_detection_training.md`

## Local Data And Generated Outputs

The following paths are intentionally ignored by git and should not be treated
as source layout:

- `tools/data/`: local audio/manual training material.
- `tools/external/`: downloaded external model repos or conversion material.
- `training_runs/`: generated training/evaluation outputs.
- `.tmp*`: scratch outputs from regression and packaging experiments.

Release packaging is controlled by `tools/package_extension.ps1`. It copies only
manifest/runtime assets, locales, images, `lib/`, and the explicitly listed
FireRed AED model assets. `tools/`, `training_runs/`, and `.tmp*` are not shipped.
Offline, Live PCM30, and Live AED60 profile assets are listed explicitly so one
profile cannot silently fall back to another in packaged builds.

Before replacing any profile model, run:

```powershell
python tools/validate_profile_assets.py `
  --profile live-pcm30 `
  --require-post-end-guard-metadata
```

For the current legacy profile assets, omit the strict flag to allow older
negative-mining metadata while still checking profile, model type, and feature
shape consistency.
