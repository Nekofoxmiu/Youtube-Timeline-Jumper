# AGENTS.md

## Project Overview

This repository is a Chrome Extension for YouTube timeline management and jumping.
The current architecture is based on Manifest V3 and already includes:

- `manifest.json`
- `background.js` as the background service worker
- `content.js` for YouTube page integration
- `popup.html` / `popup.js`
- `styles.css`

The extension already supports storage-backed playlist/timeline data keyed by video ID.
New work must preserve existing functionality unless a change is explicitly required.

---

## Primary Goal

Extend the project with **automatic song segment detection** for YouTube videos and live streams.

The feature should:

- detect **song / non-song** segments from the currently playing YouTube tab
- work during playback, without waiting for the full stream/video to finish
- avoid external desktop apps, local daemons, WebSocket bridges, or remote servers
- integrate detected segments into the existing timeline / playlist system
- remain compatible with existing manual playlist editing and playback behavior

This should be implemented as an **incremental extension** of the current architecture, not as a rewrite.

---

## Product Scope

### In Scope

- Chrome Extension internal audio capture for the active YouTube tab
- local audio analysis within the extension
- generation of provisional/final song segments
- integration into existing playlist/timeline UI
- start/stop controls for auto detection
- storage and persistence of auto-generated segments
- architecture that can later support lightweight model-based inference

### Out of Scope

Do **not** implement these unless explicitly requested:

- song title recognition
- lyric transcription
- ASR / Whisper-based pipelines
- CM / sponsor / ad detection
- remote APIs
- cloud sync
- non-YouTube site support
- a full redesign of the extension UI
- replacing the current playlist architecture

---

## Required Technical Direction

### Chrome Extension Architecture

Prefer the following architecture:

- `background.js` remains the coordinator
- audio capture should use `chrome.tabCapture`
- heavy audio processing should run in an `offscreen document`
- `content.js` should remain focused on YouTube page integration and UI
- communication should use `chrome.runtime.sendMessage` or equivalent extension messaging
- persistence should remain in `chrome.storage.local`

Do not move major audio analysis logic into `content.js` unless there is a strong reason.

### Feature Strategy

Implement the feature in stages:

1. **Phase 1: plumbing**
   - manifest updates
   - offscreen document creation
   - tab audio capture
   - message routing
   - storage sync
   - UI controls

2. **Phase 2: basic heuristic detection**
   - simple audio features
   - song probability estimation
   - segment state machine
   - smoothing / merging

3. **Phase 3: extensibility**
   - isolate analysis code so it can later be replaced with ONNX Runtime Web or another lightweight local model

Do not jump directly to heavyweight ML inference in the first iteration.

---

## Repository Expectations

### Existing Functionality Must Be Preserved

Before making changes, assume that these are important and should continue to work:

- existing playlist storage
- timeline jumping
- popup controls
- YouTube page UI injection
- current migration and versioning logic
- storage schema compatibility where possible

If a schema change is required:

- keep it minimal
- prefer additive changes over breaking changes
- preserve old data where feasible
- document the migration clearly

### Naming and Structure

Keep naming consistent with the current codebase.

Prefer small modules with clear responsibility boundaries. For new code, separate concerns such as:

- capture
- feature extraction
- detection state
- segment smoothing
- storage synchronization
- UI integration

Avoid adding large monolithic blocks into existing files if a helper module is more appropriate.

---

## Implementation Rules

### General Rules

- Make the **smallest viable change** that satisfies the goal.
- Preserve current user-facing behavior unless the task explicitly changes it.
- Prefer incremental refactors over broad rewrites.
- Do not introduce unnecessary dependencies.
- Do not add a backend.
- Do not require a companion native application.
- Do not rely on WebSocket or localhost services.

### Audio Detection Rules

For the first working version:

- implement **song vs non-song**
- use simple local analysis
- use fixed-size windows and overlap
- include smoothing to reduce fragmentation
- produce timeline segments, not frame-by-frame UI spam

Good first-pass ingredients include:

- RMS energy
- zero-crossing rate
- spectral centroid
- spectral flatness
- voiced/pitch confidence if practical

The exact heuristic can be simple.
Accuracy can be improved later.

### Segment Rules

The detector should not emit highly fragmented output.

Use a state machine and post-processing such as:

- consecutive high-confidence windows to start a segment
- consecutive low-confidence windows to end a segment
- minimum segment duration
- merging short gaps
- marking segments as provisional before final stabilization if needed

### UI Rules

Integrate with existing UI instead of creating a separate app-like panel.

At minimum, support:

- start auto detect
- stop auto detect
- detection status display
- showing auto-generated segments in the existing timeline/playlist area

Auto-generated items should be visually distinguishable from manual items.

---

## Storage Rules

Prefer to reuse the existing storage model.

If adding auto-detected timeline items, use additive fields such as:

- `type: "auto-song"`
- `confidence`
- `provisional`
- `detectorVersion`

Keep manual and automatic entries distinguishable.

If extra metadata is needed, use a minimal extension of the current schema rather than inventing a parallel storage system without good reason.

---

## Editing Policy

When modifying files:

- keep diffs focused
- avoid style-only churn
- avoid unrelated cleanup
- do not rename files unless necessary
- do not reformat large files unnecessarily
- preserve comments unless they are incorrect or obsolete

When creating new files, use descriptive names and keep them close to the existing project structure.

---

## Testing Expectations

Any implementation should be testable manually with a local extension load.

At minimum, verify:

1. extension loads without manifest errors
2. existing YouTube functionality still works
3. auto detect can be started and stopped
4. audio capture begins only after explicit user action
5. playback audio still works while analysis is running
6. song-like segments appear during playback
7. generated segments persist correctly
8. refreshing the page does not catastrophically break state
9. switching videos or tabs behaves predictably

When reporting results, include:

- what changed
- what files changed
- what was tested
- known limitations
- next recommended step

---

## Preferred Deliverable Style

When completing a task, provide:

1. a concise summary of what was implemented
2. a list of changed files
3. key architectural decisions
4. any schema or migration implications
5. manual test instructions
6. known limitations
7. clear next steps

Do not bury important design decisions inside long prose.

---

## Safe Refactor Guidance

Refactor only when it directly supports the requested feature or clearly improves maintainability around the touched area.

Good refactors:

- extracting message handling helpers
- isolating storage helpers
- separating detection logic from UI logic
- splitting audio analysis into a new module

Avoid:

- broad project-wide rewrites
- framework migrations
- changing architectural style for its own sake
- replacing existing workflow without strong justification

---

## Future-Friendly Design

Design the first version so that the detection core can later be replaced or upgraded.

The long-term path should allow:

- heuristic detector now
- lightweight local classifier later
- ONNX Runtime Web or similar local inference later
- optional provisional/final segment distinction
- user correction of auto-generated segments in the future

Do not prematurely implement all future features now.
Just leave clean extension points.

---

## If You Are Unsure

If implementation details are ambiguous, prefer:

- preserving existing behavior
- minimal additive changes
- modular design
- a working MVP over a speculative complex solution

If you must choose between a clever design and a robust simple design, choose the robust simple design.