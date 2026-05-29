# Live Detection Regression

This document records the local regression workflow for live song detection.
Use it before accepting changes to live smoothing, live finalization, segment
filtering, or AED frame generation.

## Scope

The default suite covers:

- Primary multi-song samples: `video_013`, `video_014`, `video_015`.
- Extended multi-song samples: reviewed first-hour slices from
  `video_051` and `video_053-069`. `video_052` is skipped because the matching
  local audio file is not available.
- Quality-gate sampled A/B: 3 deterministic samples from
  `tools/samples/live/live_pcm_full_regression_samples.example.json` unless a
  fixed sample file is passed explicitly.
- Snapshot-unavailable simulation for the primary samples.
- Stop-checkpoint simulation for the primary samples.
- No-song / BGM hard-negative samples:
  `video_013_intro_no_song`, `video_014_intro_no_song`,
  `video_015_intro_no_song`, and `live_7B5UzrC_eJk_no_song_gated_stalls`.

The default A/B baseline is `pcm-no-filter`. The gated variants are:

- `pcm-current`
- `aed60-current`

This means the suite verifies that both live implementations remain better
than the no-filter baseline, and that AED60 stays aligned with PCM cache.

## Full Command

Run this when detection logic changes:

```powershell
node tools/live/run_live_regression_suite.mjs --out-dir .tmp_live_regression_suite --force --fail-on-regression
```

Expected output:

- `.tmp_live_regression_suite/live_regression_suite_summary.json`
- `passed=true`

The suite can take a long time because it runs PCM and AED60 simulation over
multiple one-hour samples.

## Reusing Existing Summaries

When only the suite logic changes, reuse existing A/B summaries:

```powershell
node tools/live/run_live_regression_suite.mjs `
  --out-dir .tmp_live_regression_suite_current `
  --normal-summary .tmp_live_pcm_ab_20260528/final_keep_threshold_main_ab/live_pcm_ab_summary.json `
  --extended-summary .tmp_live_pcm_ab_20260528/hard_neg_051_candidate_extended_ab/live_pcm_ab_summary.json `
  --snapshot-summary .tmp_live_pcm_ab_20260528/discontinuity_finalize_reset_snapshot_ab/live_pcm_ab_summary.json `
  --stop-summary .tmp_live_pcm_ab_20260528/stop_checkpoint_ab/live_pcm_ab_summary.json `
  --hard-negative-summary .tmp_live_regression_suite_current_filtered/no_song/live_pcm_ab_summary.json `
  --fail-on-regression
```

The runner validates that provided summaries contain the required variants,
baseline regression rows, no-song rows, and matching normal/snapshot sample
sets. It rejects mismatched summaries instead of producing meaningless gates.
The no-song gate also requires at least four expected-no-song samples and at
least 3000 seconds of expected-no-song coverage by default.
The stop-checkpoint gate requires at least three distinct stop sources per
gated variant by default.
Manual segments shorter than the active `minSegmentDurationSec` are excluded
from simulator metrics, because the runtime is intentionally configured not to
emit segments below that user setting.

## Candidate Model A/B

Use candidate variants only for experiments:

```powershell
node tools/live/run_live_pcm_ab_samples.mjs `
  --samples tools/samples/live/live_pcm_full_regression_samples.example.json `
  --out-dir .tmp_live_pcm_ab_candidate `
  --variants pcm-current,pcm-candidate-model,aed60-current,aed60-candidate-model,pcm-no-filter `
  --candidate-segment-filter-model-dir training_runs/<candidate-model-dir> `
  --baseline pcm-no-filter `
  --fail-on-regression
```

Do not replace `models/fireredvad/aed/*` unless the candidate passes both the
primary and extended sample groups without lowering the aggregate gates.

## Hard Negatives

Confirmed false positives belong in:

```text
tools/segment_filter_hard_negatives.csv
```

Candidate false positives can be exported with:

```powershell
python tools/export_segment_filter_hard_negative_candidates.py `
  training_runs/smoothing_eval_v8_jinbee/batch `
  .tmp_live_pcm_ab_20260528/final_keep_threshold_extended_pcm_ab `
  --out .tmp_segment_filter_hard_negative_candidates.csv
```

Review candidates manually before copying them into the hard-negative CSV.
If a predicted segment is song-like but intentionally omitted from the manual
annotation because it is incomplete or ambiguous, do not add it as a hard
negative. Add an `ignoreRanges` entry in the sample JSON instead, so A/B metrics
do not train the filter to remove real singing.

## Static Checks

Run these after editing the live regression tools:

```powershell
node --check tools/live/run_live_pcm_ab_samples.mjs
node --check tools/live/run_live_regression_suite.mjs
node --check tools/live/compare_live_ab_summaries.mjs
node --check tools/live/simulate_live_pcm_detection.mjs
```

## Notes

- These tools do not change user-facing settings such as `minSegmentDurationSec`.
- The no-song and stop-checkpoint gates both require multiple reviewed samples;
  single-case summaries are rejected by default.
- Keep intro no-song ranges tied to human annotations. Do not add arbitrary
  unannotated gaps unless they have been reviewed; intentionally omitted partial
  songs should be represented with `ignoreRanges`, not `expectedNoSong`.
- If a live session has playback discontinuities such as snapshot-unavailable
  gaps, finalization should not apply the segment filter to partial ranges.
  The filter uses context features that are only reliable for continuous
  analysis ranges. Stop-time global finalization may apply keep/drop with the
  merged AED cache, but edge trim must stay disabled for discontinuity sessions.
- A rejected discontinuity edge-trim experiment on the snapshot suite dropped
  mean F1 from `0.9636` to `0.9269`, so do not re-enable discontinuity edge trim
  without a new passing snapshot A/B.
- Model size should remain small. The current segment filter / edge advisor
  assets are small ONNX models and should not be replaced with large models in
  this workflow.
- Candidate live-profile models may carry `liveFinalKeepThreshold` and
  `disableLiveEdgeTrim` metadata. These guards are allowed for evaluation
  safety, but a candidate still must beat `pcm-current` / `aed60-current` before
  replacing shipped assets.
- `tools/live/run_live_pcm_ab_samples.mjs --fail-on-regression` automatically compares
  candidate variants against their matching current variants when both are
  present, in addition to the no-filter baseline.

## 2026-05-28 Speech-reset End Refinement

Note: `video_015` was later found to have annotation pollution. Song #3 was
corrected from `00:17:04-00:18:46` to `00:17:04-00:20:31` in both
`tools/data/manual/video_015_manual.txt` and `tools/annotations_example.csv`.
Older conclusions that treated `video_015` tail retention as a false positive
should be considered invalid and must be rerun before guiding new rules.

After correction:

- `training_runs/live_pcm_video015_annotation_fix_primary_ab`
  - `pcm-current meanF1=0.9755`
  - `pcm-current-no-speech-reset meanF1=0.9755`
  - `pcm-no-filter meanF1=0.9750`
  - `video_015 pcm-current F1=0.9684`; the remaining error is recall loss from
    edge trim ending Song #3 at about `00:19:50` instead of `00:20:31`.
- `training_runs/live_pcm_video015_annotation_fix_no_edge_full_ab`
  - Disabling live edge trim fixes `video_015` recall but fails the full
    current gate: candidate `meanF1=0.9784` vs current `meanF1=0.9819`.
- `training_runs/live_pcm30_annotation_fix_candidate_primary_ab`
  - Retraining a live-pcm30 candidate from corrected no-filter frames failed
    primary A/B: candidate `meanF1=0.9384` vs current `meanF1=0.9755`.
  - Do not install this candidate.
- `training_runs/live_pcm_end_trim_guard_primary_ab`
  - Enabling `enableLiveEndTrimEvidenceGuard` on the current edge advisor fixes
    the contaminated over-trim path without disabling edge trim globally.
  - Primary 3-video: candidate `meanF1=0.9789` vs current `0.9755`; the
    candidate passes both no-filter and current gates.
  - `video_015` Song #3 changes from `00:16:55-00:19:50` to
    `00:16:55-00:20:44`, matching the corrected `00:17:04-00:20:31` label
    much better.
- `training_runs/live_pcm_end_trim_guard_full_ab`
  - Full 6-video: candidate `meanF1=0.9833` vs current `0.9819`; the candidate
    passes no-filter and current gates.
  - Keep this guard enabled for live-profile edge advisor assets.
- `training_runs/live_pcm_end_trim_guard_no_song_ab`
  - No-song / BGM regression: guard-on, guard-off, and no-filter all produced
    `0.0000s` predicted song over `3360s` of reviewed no-song ranges.
  - The guard did not introduce new no-song false positives.
- `training_runs/live_aed60_end_trim_guard_primary_ab`
  - Realtime AED60 primary 3-video: guard-on current `meanF1=0.9789`,
    no-guard candidate `0.9756`, no-filter `0.9750`.
  - The no-guard candidate intentionally fails the candidate-vs-current gate,
    confirming that the guard helps the default realtime path too.
- `training_runs/live_pcm_profile_assets_primary_ab`
  - Added pinned profile assets for `live-pcm30` and `live-realtime-aed60`.
  - PCM primary 3-video: profile assets and default-only fallback both produced
    `meanF1=0.9789`; no-filter stayed at `0.9750`.
  - Summary params confirmed `segmentFilterAssetProfileUsed=live-pcm30` and
    `edgeTrimAdvisorAssetProfileUsed=live-pcm30` for all primary samples.
- `training_runs/live_pcm_profile_threshold_pin_primary_ab`
  - Added explicit `liveFinalKeepThreshold=0.9` to the live profile segment
    filter metadata to pin the verified finalization threshold.
  - PCM primary 3-video: profile assets and default-only fallback both remained
    at `meanF1=0.9789`; no-filter remained at `0.9750`; candidate-vs-current
    gate passed with `0.0000` drop.
- `training_runs/live_pcm_require_profile_assets_primary_ab`
  - Added `--require-profile-assets` to the live simulator and A/B runner so a
    requested live profile cannot silently fall back to default assets.
  - Negative smoke check against `training_runs/segment_filter_guard_default_only`
    correctly failed with `segment_filter used default, edge_trim_advisor used
    default`.
  - PCM primary 3-video with required profile assets:
    `pcm-current meanF1=0.9789`, `pcm-no-filter meanF1=0.9750`; the gate passed.
  - Summary rows confirmed `segmentFilterAssetProfileUsed=live-pcm30` and
    `edgeTrimAdvisorAssetProfileUsed=live-pcm30` for all current-filter samples.
- `training_runs/post_end_negative_guard_smoke`
  - Added a training-time guard for `manual.end + 0.5s ~ +14s` negative mining.
  - If the tail still has temporal song and singing evidence and does not look
    like a clear speech/low-energy reset, the negative sample is skipped.
  - Smoke run on `video_013` / `video_014` / `video_015` skipped 4 suspicious
    post-end negatives from `video_014` and did not reintroduce the corrected
    `video_015` pollution.
- `tools/validate_training_annotations.py`
  - Added a CSV/manual consistency check. Current run:
    `videos=65 errors=0 warnings=44`; warnings are missing manual files for
    samples that only exist in `annotations_example.csv`.
- `training_runs/segment_filter_live_pcm30_post_end_guard_candidate`
  - Retrained a `live-pcm30` candidate from the full live no-filter candidate
    set with the post-end negative guard enabled.
  - Training skipped 1 suspicious post-end negative from `video_051_first_hour`.
  - Primary 3-video A/B rejected the candidate:
    candidate `meanF1=0.9710`, current `0.9789`, no-filter `0.9750`.
  - Failure mode: extra false positives increased, especially on `video_013`.
- `training_runs/segment_filter_live_pcm30_post_end_guard_thr090_candidate`
  - Same candidate with `liveFinalKeepThreshold` pinned back to the verified
    `0.9` threshold.
  - Primary 3-video A/B also rejected it:
    candidate `meanF1=0.8847`, current `0.9789`, no-filter `0.9750`.
  - Failure mode: the candidate dropped the first two `video_015` songs, causing
    severe recall loss.
  - Conclusion: keep the current shipped live profile assets. The training-data
    guard is useful, but this retrained candidate is not.
- `training_runs/live_aed60_profile_asset_smoke_video015.json`
  - Smoke test confirmed the realtime path loads
    `segmentFilterAssetProfileUsed=live-realtime-aed60` and
    `edgeTrimAdvisorAssetProfileUsed=live-realtime-aed60`.

Accepted live PCM refinement:

- Adds a conservative finalization-only end trim for long tails that look like
  low-temporal / high-speech talk-over-BGM after a song.
- The rule only runs after segment filter finalization and does not change
  `minSegmentDurationSec`.
- Minimum trim is `25s`, so short uncertain endings are left to the existing
  model/heuristic path.

Validation:

```powershell
node tools/live/run_live_pcm_ab_samples.mjs `
  --samples tools/samples/live/live_pcm_ab_samples.example.json `
  --variants pcm-current,pcm-current-no-speech-reset,pcm-no-filter `
  --out-dir training_runs/live_pcm30_speech_reset_refine_min25_primary_ab `
  --jobs 3 `
  --force `
  --fail-on-regression

node tools/live/run_live_pcm_ab_samples.mjs `
  --samples tools/samples/live/live_pcm_full_regression_samples.example.json `
  --variants pcm-current,pcm-current-no-speech-reset,pcm-no-filter `
  --out-dir training_runs/live_pcm30_speech_reset_refine_min25_full_ab `
  --jobs 3 `
  --force `
  --fail-on-regression
```

Result:

- Primary 3-video mean F1 stayed unchanged at `0.9708`.
- Full 6-video mean F1 improved from `0.9739` to `0.9795`.
- `video_051_first_hour` improved from `F1=0.9474` to `F1=0.9810`.
- Other full-set samples stayed unchanged in F1.
- Toggle verification was rerun with
  `training_runs/live_pcm_speech_reset_toggle_primary_ab` and
  `training_runs/live_pcm_speech_reset_toggle_full_ab`:
  - Primary 3-video: `pcm-current` and `pcm-current-no-speech-reset` both
    stayed at `meanF1=0.9708`; both beat no-filter `meanF1=0.9570`.
  - Full 6-video: `pcm-current meanF1=0.9795`,
    `pcm-current-no-speech-reset meanF1=0.9739`, no-filter `meanF1=0.9473`.
  - The improvement is concentrated in `video_051_first_hour`, where false
    positives drop from `209` to `23` while F1 improves from `0.9474` to
    `0.9810`.

Rejected variants:

- Historical only: `minTrimSec=8` and the temporal P90 guard were rejected
  against the old polluted `video_015` annotation. Do not use those numbers as
  evidence after the `00:20:31` correction without rerunning the A/B suite.

