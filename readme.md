# YouTube Playlist Manager Chrome Extension
  \
Youtube auto jumper tutorial  
https://youtu.be/2zfVeA279d0  
  
![image](https://github.com/Nekofoxmiu/Youtube-Timeline-Jumper/assets/76677660/189c5d99-d79b-495e-ba7b-5a84c56a949f)
![image](https://github.com/Nekofoxmiu/Youtube-Timeline-Jumper/assets/76677660/a22945b0-f9c0-4d61-82a5-372b6d64a76e)

  \
From: [【歌回】響到什麼唱什麼｜響Hibiki](https://www.youtube.com/watch?v=2ciq2BUuuUI)  
Owner: [@HibikiVtuber](https://www.youtube.com/@HibikiVtuber)  
# YouTube Playlist Management Extension

## Overview
This project is a Chrome extension designed to enhance YouTube's playlist management capabilities. The extension provides functionalities such as creating, editing, importing, exporting, and playing custom playlists directly within the YouTube interface.

## Features
- **Dark Theme Detection**: Automatically apply the correct CSS theme based on YouTube's dark or light theme.
- **Playlist Management**: Add, edit, and delete items in your custom playlists.
- **Playlist Import**: Importing playlists now appends timelines to existing ones instead of overwriting them.
- **Video Info Retrieval**: Get the current video ID and playtime.
- **State Management**: Synchronize and update the playlist state with the background script.
- **User Interaction**: Enable editable text fields and handle drag-and-drop for playlist items.
### 1.2.2
- move sync to local
- **Single Playback**: Now you can play song separately and this also benefit you to edit playlist. (By the toggle switch or ctrl + left click)
### 1.2.3
- You can set the default add time now. (If the end time doesn't exist.)


## Installation
### 1. check extention store
[Chrome store link](https://chromewebstore.google.com/detail/youtube-auto-jump/afnhppglcmibpbelgjbphhfcjndnmhhb)  
[Firefox store link](https://addons.mozilla.org/zh-TW/firefox/addon/youtube-auto-jump)
### 2. Install manually
1. Clone the repository.
2. Navigate to `chrome://extensions/` in your Chrome browser.
3. Enable "Developer mode".
4. Click "Load unpacked" and select the cloned repository folder.

## Usage
1. Navigate to a YouTube video.
2. Use the playlist management buttons to create and manage your playlists.
3. Drag and drop items to rearrange them.
4. Import or export playlists using the provided buttons to share your playlists with others.

## File Descriptions

### runtimeHandler.js
Handles runtime messages and manages the state of the extension (on/off) and playlist initialization. It also handles messages to start playing the playlist.
- **Functions**:
  - `handleRuntimeMessage(request, sender, sendResponse, context)`: Main function to process incoming messages and take appropriate actions.

### sendPlaylistStateToBackground.js
Sends the current playlist state to the background script for persistence.
- **Functions**:
  - `sendPlaylistStateToBackground(nowPlaylistState, meta)`: Sends the current playlist state to `background.js` with optional metadata.

### getVideoInfo.js
Provides functions to retrieve information about the current YouTube video.
- **Functions**:
  - `getCurrentVideoId()`: Retrieves the current video ID from the URL.
  - `getCurrentVideoTime()`: Retrieves the current playback time of the video and converts it to a `TimeSlot` object.

### editModule.js
Enables editing mode for playlist items and handles save and cancel actions.
- **Functions**:
  - `enableEditMode(editableElement, playlistState, playlistTimeManager)`: Enables editing mode for a given element.
  - `handleBlur(editableElement, originalAttr, playlistState, playlistTimeManager)`: Handles actions when an editable element loses focus.
  - `handleKeydown(event, editableElement, originalText)`: Handles keydown events to save or cancel edits.

### theme.js
Applies the appropriate CSS theme based on YouTube's current theme.
- **Functions**:
  - `isYouTubeDarkTheme()`: Checks if YouTube is in dark mode.
  - `applyTheme()`: Applies the dark or light theme CSS classes to the document body.

### dataclass.js
Contains data classes to manage playlist items and states.
- **Classes**:
  - `TimeSlot`: Represents a time slot with hours, minutes, and seconds.
  - `PlaylistItem`: Represents a playlist item with start time, end time, and title.
  - `PlaylistState`: Manages the state of the playlist.

### mouseEventHandler.js
Handles drag-and-drop operations for playlist items.
- **Classes**:
  - `MouseEventHandler`: Manages the drag-and-drop events and updates the playlist state. Accepts a `PlaylistStateManager` to persist changes.

### playlistTool.js
Provides utility functions and classes for managing playlists and time slots.
- **Classes**:
  - `PlaylistTimeManager`: Manages playlist time slots and ensures start times do not exceed end times. Requires a `PlaylistStateManager` to sync state.
- **Functions**:
  - `equalsCheck(a, b)`: Checks if two objects are equal.
  - `getandUpdatePlaylistState(sharedState)`: Retrieves and updates the current playlist state.

### stateManager.js
Manages persistent playlist state separately from the DOM.
- **Classes**:
  - `PlaylistStateManager`: Loads and saves playlist data for a specific video.

### ui.js
Creates and manages UI components for the extension.
- **Functions**:
  - `createPlaylistContainer(videoId)`: Creates a container for the playlist.
  - `createButtonContainer()`: Creates a container for action buttons.
  - `createImportExportContainer()`: Creates a container for import/export buttons.
  - `createPlaylistItemsContainer()`: Creates a container for playlist items.
  - `createTimeTextElements(startTime, endTime)`: Creates start and end time text elements.
  - `createAddToPlaylistButton()`: Creates an "Add to Playlist" button.
  - `createImportPlaylistButton(importPlaylistFromText)`: Creates an "Import Playlist" button.
  - `createExportPlaylistButton(exportPlaylist)`: Creates an "Export Playlist" button.
  - `createPlayButton()`: Creates a "Play Playlist" button.
  - `createPopupTextBox(title, onSave)`: Creates a popup text box for user input.

### playPlaylist.js
Controls the playback of the custom playlist.
- **Functions**:
  - `playPlaylist(startIndex, sendResponse, tabId)`: Plays the playlist starting from the specified index.
  - `stopCurrentPlayback()`: Stops the current video playback.
  - `updateStyles(item, add)`: Updates the styles of the current playing item.

### background.js
Manages the background operations of the extension, including communication with content scripts and handling state changes.
- **Listeners**:
  - `chrome.runtime.onInstalled.addListener`: Initializes the extension state upon installation.
  - `chrome.action.onClicked.addListener`: Toggles the extension on/off state.
  - `chrome.runtime.onMessage.addListener`: Handles messages for updating playlist state and controlling playback.
  - `chrome.tabs.onUpdated.addListener`: Initializes the playlist when a YouTube tab is updated.
  - `chrome.tabs.onRemoved.addListener`: Cleans up state when a tab is closed.

### content.js
Handles the content script operations, including injecting UI components, handling user interactions, and communicating with the background script.
- **Modules Loaded**:
  - `dataclass.js`, `playlistTool.js`, `mouseEventHandler.js`, `ui.js`, `theme.js`, `runtimeHandler.js`, `editModule.js`, `getVideoInfo.js`
- **Functions**:
  - `appstart()`: Starts the application by initializing UI components.
  - `initializePlaylist(sidebarElm)`: Initializes the playlist in the YouTube sidebar.
  - `addToPlaylist()`: Adds a new item to the playlist.
  - `createPlaylistItem(startTime, endTime, title)`: Creates a new playlist item element.
  - `playPlaylist(startIndex)`: Sends a message to start playing the playlist from a specified index.
  - `importPlaylistFromText()`: Imports a playlist from a text input.
  - `exportPlaylist()`: Exports the playlist to a text output.

## Contribution
Contributions are welcome! Please open an issue or submit a pull request with your changes.

## License
This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.
