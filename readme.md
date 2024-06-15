#YouTube Playlist Manager Chrome Extension

## Introduction
This project is a Chrome extension designed to enhance the YouTube experience by providing playlist management capabilities. The extension allows users to create, edit, import, and export playlists directly within the YouTube interface.

## Features
- **Dark Theme Detection**: Automatically applies a dark or light theme based on YouTube's current theme.
- **Playlist Management**: Create and manage playlists, including adding, editing, and removing items.
- **Drag-and-Drop Interface**: Rearrange playlist items using an intuitive drag-and-drop interface.
- **Import/Export Playlists**: Import playlists from text or export current playlists to share with others.


## Files Overview

### `content.js`
This file is the main entry point for the extension's content script. It initializes the playlist manager, sets up the UI elements, and handles interactions between the user and the YouTube page.

### `background.js`
Handles the background processes, including managing the extension's state, listening for messages from the content script, and performing tasks such as initializing the extension and updating the playlist state.

### `theme.js`
Contains functions for detecting YouTube's theme (dark or light) and applying the corresponding styles to the extension's elements.

### `sendPlaylistStateToBackground.js`
Handles sending the current playlist state to the background script for storage and updates.

### `runtimeHandler.js`
Manages runtime messages and performs actions such as switching the extension's state, initializing playlists, and starting playlist playback.

### `ui.js`
Provides functions for creating various UI components, such as playlist containers, buttons, and pop-up text boxes.

### `mouseEventHandler.js`
Implements the drag-and-drop functionality for rearranging playlist items within the UI.

### `playlistTool.js`
Contains the core logic for managing playlists, including creating new items, updating time texts, and checking the validity of start and end times.

### `dataclass.js`
Defines data structures used throughout the extension, such as `TimeSlot`, `PlaylistItem`, and `PlaylistState`.

## Installation
1. Clone or download the repository to your local machine.
2. Open Chrome and navigate to `chrome://extensions/`.
3. Enable "Developer mode" using the toggle in the upper right corner.
4. Click "Load unpacked" and select the directory containing the extension files.

## Usage
1. Navigate to a YouTube video.
2. Use the playlist management buttons to create and manage your playlists.
3. Drag and drop items to rearrange them.
4. Import or export playlists using the provided buttons to share your playlists with others.

## Development
### Prerequisites
- Chrome browser

### Run
Load the extension in Chrome as described in the Installation section.

### Testing
- Use the Chrome Developer Tools to inspect and debug the extension.
- Test the extension on different YouTube pages to ensure compatibility and functionality.

## Contribution
Contributions are welcome! Please open an issue or submit a pull request with your changes.

## License
This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.