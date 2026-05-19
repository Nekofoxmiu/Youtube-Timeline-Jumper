# YouTube Timeline Jumper

YouTube Timeline Jumper is a Chrome Extension for managing timestamped playlists directly on YouTube.

It lets you save moments or songs with start/end times, jump between them, reorder entries, import/export playlist data, and manage cross-video playback queues. Version 3.x also adds local song-segment detection and Playlist Studio for offline analysis and database editing.

Chrome Web Store: https://chromewebstore.google.com/detail/youtube-auto-jump/afnhppglcmibpbelgjbphhfcjndnmhhb

Tutorial video: https://youtu.be/2zfVeA279d0

![Screenshot 1](https://github.com/Nekofoxmiu/Youtube-Timeline-Jumper/assets/76677660/189c5d99-d79b-495e-ba7b-5a84c56a949f)
![Screenshot 2](https://github.com/Nekofoxmiu/Youtube-Timeline-Jumper/assets/76677660/a22945b0-f9c0-4d61-82a5-372b6d64a76e)

Image and tutorial video source:
From: [【歌回】響到什麼唱什麼｜響Hibiki](https://www.youtube.com/watch?v=2ciq2BUuuUI)
Owner: [@HibikiVtuber](https://www.youtube.com/@HibikiVtuber)

## Features

- **In-page YouTube timeline manager**: Add, edit, remove, and reorder timestamped entries inside YouTube.
- **Timestamped playlists**: Save start and end times for songs, highlights, chapters, or any important moments.
- **Single-entry playback**: Play individual entries with the built-in toggle or Ctrl + Left Click.
- **Playlist import/export**: Back up, restore, and share playlist data with JSON files.
- **Popup playlist overview**: View saved playlists, search them, sort them, and inspect timeline entries from the extension popup.
- **Playlist Studio**: Manage recorded songs, cross-video playback queues, offline detection results, and the playlist database in a dedicated extension page.
- **Cross-video playback queue**: Build playlists across multiple YouTube videos or livestreams, with previous/next, play/pause, shuffle, save, and load controls.
- **Database editor**: Edit stored playlist records, rename songs, change times, reorder entries, add segments, or delete records.
- **Offline local audio analysis**: Analyze downloaded audio files locally and save detected `auto-song` segments back to a selected video ID.
- **Live song detection**: Use Chrome tab audio capture to detect song segments while a YouTube video or livestream is playing.
- **Optional medley splitting**: Split long detected song segments into smaller candidates with rule-based boundary detection.
- **Local persistence**: Data is stored through `chrome.storage.local`.
- **Localization**: Supports English and Chinese UI text.

## Privacy And Security

This project is fully open source. The complete source code is available in this repository:

https://github.com/Nekofoxmiu/Youtube-Timeline-Jumper

The extension stores playlist data locally through Chrome extension storage. Song detection and offline audio analysis run locally inside the extension environment.

Captured or imported audio is not uploaded to external servers.

The extension does not modify Chrome source code, browser binaries, or internal browser files. It runs within the standard Chrome Extension permission system.

## Why `tabCapture` And `offscreen` Are Used

`tabCapture` is required for the live song detection feature. Chrome extensions cannot directly access the audio stream of a YouTube tab, so the extension uses Chrome's official tab audio capture API after user action.

`offscreen` is required because this project uses Manifest V3. A Manifest V3 background script runs as a service worker and is not suitable for long-running Web Audio processing. The offscreen document receives the captured tab audio stream, runs local analysis, and sends the detection result back to the extension.

These permissions are used for local song-segment detection only.

## Installation

### Chrome Web Store

Install from the Chrome Web Store:

https://chromewebstore.google.com/detail/youtube-auto-jump/afnhppglcmibpbelgjbphhfcjndnmhhb

### Load Unpacked For Development

1. Clone this repository.
2. Open `chrome://extensions/` in Chrome.
3. Enable **Developer mode**.
4. Click **Load unpacked**.
5. Select the repository folder.

## Usage

### YouTube Timeline

1. Click the extension icon and enable the extension.
2. Open a YouTube video or livestream.
3. Use the in-page timeline controls to add a song, highlight, or moment.
4. Edit the title and start/end times as needed.
5. Drag entries to reorder them.
6. Use playback controls to play the full playlist or a single entry.

### Popup

The popup can be used to:

- Enable or disable the extension.
- Start or stop live song detection.
- Configure minimum detected segment duration.
- Search saved playlists.
- Choose whether search includes song titles or only video titles.
- Sort playlists.
- Import or export playlist JSON data.
- Open Playlist Studio.

### Playlist Studio

Playlist Studio includes:

- **Global Playlist**: Browse songs across videos and livestreams, then drag them into a cross-video queue.
- **Playback Queue**: Reorder, shuffle, save, load, and play cross-video queues.
- **Database Editor**: Edit stored playlist data, including titles, times, order, and deletion.
- **Offline Analysis**: Analyze local audio files and save detected song segments into the playlist database.
- **Settings**: Configure language, minimum segment duration, medley splitting default, and cross-video preload default.

## Local Song Detection

The current detection stack uses a local FireRed AED-based runtime with additional smoothing and post-processing rules.

Supported modes:

- **Live detection**: Captures audio from the active YouTube tab after explicit user action.
- **Offline detection**: Reads a local audio file and analyzes it without playing the YouTube page.

Generated segments are stored as playlist entries with `type: "auto-song"`. Manual entries and automatic entries can coexist.

Known limitations:

- Detection is song/non-song oriented, not song title recognition.
- The detector does not transcribe lyrics.
- Medley splitting is heuristic and may require manual correction.
- Live detection depends on Chrome tab capture behavior and can differ from offline analysis.

## Import And Export

Playlist data can be exported as JSON from the popup. Importing playlist data appends incoming entries to existing playlists instead of replacing them.

This is recommended before major upgrades or manual testing.

## Packaging

A Chrome Web Store package can be generated with:

```powershell
powershell.exe -ExecutionPolicy Bypass -File tools\package_extension.ps1
```

Useful options:

```powershell
# Keep staging directory for Load unpacked testing
powershell.exe -ExecutionPolicy Bypass -File tools\package_extension.ps1 -KeepStaging

# Create staging only, without ZIP
powershell.exe -ExecutionPolicy Bypass -File tools\package_extension.ps1 -NoZip -KeepStaging
```

The packaging script includes only runtime files required by the extension and excludes training data, evaluation artifacts, backups, and temporary files.

## Project Structure

- `manifest.json`: Chrome Manifest V3 configuration.
- `background.js`: Background service worker, migrations, storage coordination, tab messaging, detection orchestration.
- `content.js`: YouTube page integration and in-page playlist UI.
- `popup.html` / `popup.js`: Extension popup UI.
- `workbench.html` / `workbench.css` / `workbench.js`: Playlist Studio, offline analysis, queue playback, and database editor.
- `offscreen.html` / `offscreen.js`: Offscreen document for tab audio capture and live audio analysis.
- `styles.css`: YouTube page UI styling.
- `lib/playlistCore.js`: Playlist normalization, serialization, and shared data helpers.
- `lib/playlistController.js`: Playlist storage/controller logic.
- `lib/songDetection/`: Audio detection, smoothing, boundary detection, and offline worker modules.
- `lib/audio/`: Browser audio decoding helpers.
- `lib/vendor/onnxruntime/`: ONNX Runtime Web runtime assets.
- `models/fireredvad/aed/`: Runtime model assets used by local detection.
- `tools/`: Training, diagnostics, conversion, smoothing, and packaging utilities.

## Release Notes

### v3.0.2

Critical fix for live tab audio capture startup.

- Fixed a race where the tabCapture stream ID could expire before the offscreen document consumed it.
- Live detection now resolves the current YouTube video before requesting the tabCapture stream ID.
- Start Detect now only targets the currently active YouTube tab that invoked the extension, avoiding Chrome activeTab authorization failures on unrelated YouTube tabs.
- Improved user guidance when the active tab is not a capturable YouTube page.

### v3.0.1

Patch update for Playlist Studio playback behavior and preload configuration.

- Playback queue now opens YouTube playback tabs in the same Chrome window as Playlist Studio instead of creating separate popup windows.
- Cross-video preload now opens background tabs in the same window.
- Cross-video preload lookahead default changed from 10 seconds to 20 seconds.
- Added a settings field for cross-video preload lookahead seconds.
- Preload lookahead can be configured from 5 to 120 seconds.
- Updated preload wording from "window" to "tab" where applicable.

### v3.0.0

Major update with significant changes across detection, playlist management, editing, and packaging.

- Added Playlist Studio.
- Added cross-video playback queues.
- Added local offline audio analysis for song segment detection.
- Added FireRed AED-based song detection runtime.
- Added database editor for playlist/timeline records.
- Added optional medley splitting for long detected song segments.
- Added localized UI support for Chinese and English.
- Added user settings page for detection and playback defaults.
- Improved popup layout, playlist search, and custom sort controls.
- Added Chrome Web Store packaging script.
- Updated extension version to `3.0.0`.

### v2.0.0

Major update focused on playlist management, import/export, popup controls, localization, and storage reliability.

- Added extension popup.
- Added enable / disable toggle.
- Added playlist import and export.
- Added all-playlists overview page.
- Added expandable playlist details.
- Added playlist sorting.
- Added English / Chinese localization.
- Improved playlist storage migration and metadata handling.
- Import now appends playlist entries instead of overwriting existing data.
- Fixed several playback, timestamp, and state persistence bugs.

### v1.2.4 And v1.2.5

- Bug fixes.

### v1.2.3

- Added default timestamp option when no end time is provided.

### v1.2.2

- Moved sync to local storage.
- Added single playback for individual playlist entries.

## Contribution

Contributions are welcome. Please open an issue or submit a pull request with a clear description of the change.

For security or misinformation concerns, please refer to the source code directly and provide specific, verifiable details when reporting an issue.

## License

This project is licensed under the MIT License. See [LICENSE](LICENSE) for details.
