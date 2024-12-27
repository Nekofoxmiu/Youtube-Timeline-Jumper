import { getCurrentVideoTime } from "./getVideoInfo.js";
import { PlaylistTimeManager } from "./playlistTool.js";
import { isYouTubeDarkTheme } from "./theme.js";

export function createPlaylistContainer(videoId) {
    const container = document.createElement('div');
    container.id = 'ytj-playlist-container';
    container.className = 'ytj-playlist-container';
    container.setAttribute('youtubeID', videoId);
    return container;
}

export function createButtonContainer() {
    const container = document.createElement('div');
    container.id = 'ytj-button-container';
    container.className = 'ytj-button-container';
    return container;
}

export function createImportExportContainer() {
    const container = document.createElement('div');
    container.id = 'ytj-importexport-container';
    container.className = 'ytj-importexport-container';
    return container;
}

export function createPlaylistItemsContainer() {
    const ul = document.createElement('ul');
    ul.id = 'ytj-playlist-items';
    return ul;
}

export function createTimeTextElements(startTime = null, endTime = null) {
    let startObj, endObj;

    if (startTime !== null) {
        const startAndEndTimeObj = PlaylistTimeManager.checkStartAndEnd(startTime, endTime);
        startObj = startAndEndTimeObj['start'];
        endObj = startAndEndTimeObj['end'];
    } else {
        startObj = getCurrentVideoTime();
        endObj = getCurrentVideoTime();
    }

    if (!startObj || !endObj) {
        console.error('No video element found.');
        return null;
    }

    const startItemText = document.createElement('div');
    startItemText.classList.add('ytj-playlist-item-text-start');
    startItemText.innerText = startObj.toformatString();
    startItemText.setAttribute('timeat', startObj.getTotalseconds().toString());
    startItemText.contentEditable = false;

    const endItemText = document.createElement('div');
    endItemText.classList.add('ytj-playlist-item-text-end');
    endItemText.innerText = endObj.toformatString();
    endItemText.setAttribute('timeat', endObj.getTotalseconds().toString());
    endItemText.contentEditable = false;

    return {
        startElement: startItemText,
        endElement: endItemText
    };
}



export function createAddToPlaylistButton() {
    const button = document.createElement('button');
    button.id = 'ytj-add-to-playlist';
    button.className = 'ytj-add-to-playlist';
    return button;
}

export function createImportPlaylistButton(importPlaylistFromText) {
    const button = document.createElement('button');
    button.id = 'ytj-import-playlist-text';
    button.className = 'ytj-import-playlist-text';
    button.innerText = 'Import Playlist';
    button.addEventListener('click', importPlaylistFromText);
    return button;
}

export function createEditPlaylistButton(editPlaylistFromText) {
    const button = document.createElement('button');
    button.id = 'ytj-edit-playlist-text';
    button.className = 'ytj-edit-playlist-text';
    button.innerText = 'Edit Playlist';
    button.addEventListener('click', editPlaylistFromText);
    return button;
}

export function createExportPlaylistButton(exportPlaylist) {
    const button = document.createElement('button');
    button.id = 'ytj-export-playlist';
    button.className = 'ytj-export-playlist';
    button.innerText = 'Export Playlist';
    button.addEventListener('click', exportPlaylist);
    return button;
}

export function createPlayButton() {
    const button = document.createElement('button');
    button.id = 'ytj-play-playlist';
    button.className = 'ytj-play-playlist';
    return button;
}


/**
 * 建立彈出文本框的函數
 * @param {string} title - 彈出框的標題
 * @param {function} onSave - 當保存按鈕被點擊時的回調函數
 * @returns {HTMLElement} 彈出文本框元素
 */
export function createPopupTextBox(title, onSave) {
    const overlay = document.createElement('div');
    overlay.className = 'ytj-overlay';

    const popup = document.createElement('div');
    popup.className = 'ytj-popup';

    const popupTitle = document.createElement('h2');
    popupTitle.innerText = title;

    const textArea = document.createElement('textarea');
    textArea.className = 'ytj-popup-textarea';

    const buttonContainer = document.createElement('div');
    buttonContainer.className = 'ytj-popup-button-container';

    const saveButton = document.createElement('button');
    saveButton.innerText = 'Save';
    saveButton.addEventListener('click', () => {
        onSave(textArea.value);
        document.body.removeChild(overlay);
    });

    const cancelButton = document.createElement('button');
    cancelButton.innerText = 'Cancel';
    cancelButton.addEventListener('click', () => {
        document.body.removeChild(overlay);
    });

    buttonContainer.appendChild(saveButton);
    buttonContainer.appendChild(cancelButton);
    popup.appendChild(popupTitle);
    popup.appendChild(textArea);
    popup.appendChild(buttonContainer);
    overlay.appendChild(popup);
    document.body.appendChild(overlay);

    return overlay;
}

/**
 * 建立彈出文本框的函數
 * @param {string} title - 彈出框的標題
 * @param {function} onSave - 當保存按鈕被點擊時的回調函數
 * @returns {HTMLElement} 彈出文本框元素
 */
export function createImportPopupTextBox(title, onSave) {
    const overlay = document.createElement('div');
    overlay.className = 'ytj-overlay';

    const popup = document.createElement('div');
    popup.className = 'ytj-popup';

    const popupTitle = document.createElement('h2');
    popupTitle.innerText = title;

    const textArea = document.createElement('textarea');
    textArea.className = 'ytj-popup-textarea';

    const additionalSecondsLabel = document.createElement('label');
    additionalSecondsLabel.innerText = 'Default add Seconds: ';
    const additionalSecondsInput = document.createElement('input');
    additionalSecondsInput.type = 'number';
    additionalSecondsInput.placeholder = 'e.g., 30';

    const buttonContainer = document.createElement('div');
    buttonContainer.className = 'ytj-popup-button-container';

    const saveButton = document.createElement('button');
    saveButton.innerText = 'Save';
    saveButton.addEventListener('click', () => {
        const additionalSeconds = parseInt(additionalSecondsInput.value, 10);
        onSave(textArea.value, additionalSeconds);
        document.body.removeChild(overlay);
    });

    const cancelButton = document.createElement('button');
    cancelButton.innerText = 'Cancel';
    cancelButton.addEventListener('click', () => {
        document.body.removeChild(overlay);
    });

    buttonContainer.appendChild(saveButton);
    buttonContainer.appendChild(cancelButton);
    popup.appendChild(popupTitle);
    popup.appendChild(textArea);
    popup.appendChild(additionalSecondsLabel);
    popup.appendChild(additionalSecondsInput);
    popup.appendChild(buttonContainer);
    overlay.appendChild(popup);
    document.body.appendChild(overlay);

    return overlay;
}

/**
 * Creates a toggle switch UI element.
 * @param {string} label - The description text to display next to the toggle switch.
 * @returns {Object} An object containing the toggle switch element and related functions.
 */
export function createToggleSwitch(label = 'Single Playback') {

    // Create container
    const container = document.createElement('div');
    container.style.display = 'flex';
    container.style.alignItems = 'center';

    // Create shadow root
    const shadow = container.attachShadow({ mode: 'open' });

    // Create styles
    const style = document.createElement('style');
    //https://www.tpisoftware.com/tpu/articleDetails/2744
    style.textContent = `
    input[type=checkbox]{
        height: 0;
        width: 0;
        visibility: hidden;
    }
    
    label {
        cursor: pointer;
        width: 40px;
        height: 20px;
        background: grey;
        display: block;
        border-radius: 10px;
        position: relative;
        margin-bottom: 10px;
        margin-left: 10px;
    }
    
    label:after {
        content: '';
        position: absolute;
        top: 2px;
        left: 2px;
        width: 16px;
        height: 16px;
        background: #fff;
        border-radius: 50%;
        transition: 0.3s ease-in-out, background-color 0.3s ease-in-out;
        will-change: left;
    }
    
    input:checked + label {
        background: #0462a1;
    }
    
    label:active:after {
        width: 16px;
    }
    
    input:checked + label:after {
        left: calc(100% - 2px);
        transform: translateX(-100%);
    }
    `;
    shadow.appendChild(style);

    // Create toggle switch HTML structure
    const template = document.createElement('div');
    template.innerHTML = `
        <input type="checkbox" id="toggle-switch"/>
        <label for="toggle-switch" class="switch-button"></label>
    `;
    shadow.appendChild(template);

    // Set up state change listener
    const checkbox = shadow.getElementById('toggle-switch');
    checkbox.addEventListener('change', () => {
        console.log(`Switch is ${checkbox.checked ? 'ON' : 'OFF'}`);
    });

    // Create description text
    const description = document.createElement('span');
    description.className = 'ytj-toggle-description';
    description.textContent = label;
    description.style.fontFamily = 'Roboto, Arial, sans-serif';
    description.style.marginLeft = '10px';
    description.style.fontSize = '12px';

    function applyTextTheme() {
        if (isYouTubeDarkTheme()) {
            description.style.color = 'white';
        } else {
            description.style.color = 'black';
        }
    }
    
    // 監聽主題變更
    const observer = new MutationObserver(() => {
        applyTextTheme();
    });
    
    const ytdApp = document.querySelector('ytd-app');
    if (ytdApp) {
        observer.observe(ytdApp, { attributes: true, attributeFilter: ['style'] });
    }

    // 初始化時應用主題
    applyTextTheme();

    // Append description to container
    shadow.appendChild(description);

    // Return container and related functions
    return {
        element: container,
        /**
         * Get the current state of the toggle switch.
         * @returns {boolean} The state of the toggle switch (true for ON, false for OFF).
         */
        getSwitchState: () => checkbox.checked,
        /**
         * Set the state of the toggle switch.
         * @param {boolean} state - The state to set (true for ON, false for OFF).
         */
        setSwitchState: (state) => {
            checkbox.checked = state;
            checkbox.dispatchEvent(new Event('change'));
        }
    };
}
