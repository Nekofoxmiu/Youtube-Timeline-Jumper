import { getRoundedCurrentVideoTime } from "./getVideoInfo.js";
import { t } from "./i18n.js";
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
    const defaultTime = startTime && endTime ? null : getRoundedCurrentVideoTime();
    let startObj = startTime ?? defaultTime;
    let endObj = endTime ?? defaultTime;

    if (!startObj || !endObj) {
        console.error('No video element found.');
        return null;
    }

    const timeObj = PlaylistTimeManager.checkStartAndEnd(startObj, endObj);
    startObj = timeObj.start;
    endObj = timeObj.end;

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
    button.innerText = t('ytj_import_playlist');
    button.addEventListener('click', importPlaylistFromText);
    return button;
}

export function createEditPlaylistButton(editPlaylistFromText) {
    const button = document.createElement('button');
    button.id = 'ytj-edit-playlist-text';
    button.className = 'ytj-edit-playlist-text';
    button.innerText = t('ytj_edit_playlist');
    button.addEventListener('click', editPlaylistFromText);
    return button;
}

export function createExportPlaylistButton(exportPlaylist) {
    const button = document.createElement('button');
    button.id = 'ytj-export-playlist';
    button.className = 'ytj-export-playlist';
    button.innerText = t('ytj_export_playlist');
    button.addEventListener('click', exportPlaylist);
    return button;
}

export function createPlayButton() {
    const button = document.createElement('button');
    button.id = 'ytj-play-playlist';
    button.className = 'ytj-play-playlist';
    return button;
}

function createPopupShell(title, modifierClass = '') {
    const overlay = document.createElement('div');
    overlay.className = 'ytj-overlay';

    const popup = document.createElement('div');
    popup.className = `ytj-popup ${modifierClass}`.trim();
    ['keydown', 'keypress', 'keyup'].forEach(type => {
        popup.addEventListener(type, event => event.stopPropagation(), true);
    });

    const popupTitle = document.createElement('h2');
    popupTitle.innerText = title;

    popup.appendChild(popupTitle);
    overlay.appendChild(popup);
    document.body.appendChild(overlay);

    return { overlay, popup };
}

function closeOverlay(overlay) {
    if (overlay?.parentNode) overlay.parentNode.removeChild(overlay);
}

function createPopupActions(overlay, primaryText, onPrimary) {
    const buttonContainer = document.createElement('div');
    buttonContainer.className = 'ytj-popup-button-container';

    const saveButton = document.createElement('button');
    saveButton.className = 'ytj-popup-primary-button';
    saveButton.innerText = primaryText;
    saveButton.addEventListener('click', async () => {
        await onPrimary();
        closeOverlay(overlay);
    });

    const cancelButton = document.createElement('button');
    cancelButton.innerText = t('ytj_cancel');
    cancelButton.addEventListener('click', () => closeOverlay(overlay));

    buttonContainer.appendChild(saveButton);
    buttonContainer.appendChild(cancelButton);
    return buttonContainer;
}

function createField(labelText, input) {
    const label = document.createElement('label');
    label.className = 'ytj-popup-field';
    const span = document.createElement('span');
    span.textContent = labelText;
    label.appendChild(span);
    label.appendChild(input);
    return label;
}

function createDelimiterControls({ includeAuto = true, label = t('ytj_delimiter'), extraOptions = [] } = {}) {
    const select = document.createElement('select');
    select.className = 'ytj-popup-select';
    const options = [
        [' ', t('ytj_delimiter_space')],
        [' - ', '-'],
        [' | ', '|'],
        [', ', ','],
        ...extraOptions,
        ['custom', t('ytj_custom')],
    ];
    if (includeAuto) options.unshift(['auto', t('ytj_auto_detect')]);
    options.forEach(([value, label]) => {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = label;
        select.appendChild(option);
    });

    const customInput = document.createElement('input');
    customInput.className = 'ytj-popup-input ytj-popup-custom-delimiter';
    customInput.type = 'text';
    customInput.placeholder = t('ytj_custom_delimiter');
    customInput.disabled = true;

    select.addEventListener('change', () => {
        customInput.disabled = select.value !== 'custom';
        if (!customInput.disabled) customInput.focus();
    });

    return {
        element: (() => {
            const group = document.createElement('div');
            group.className = 'ytj-popup-inline-fields';
            group.appendChild(createField(label, select));
            group.appendChild(createField(t('ytj_custom'), customInput));
            return group;
        })(),
        getValue: () => (select.value === 'custom' ? customInput.value : select.value),
    };
}

function createNumberingControl() {
    const select = document.createElement('select');
    select.className = 'ytj-popup-select';
    [
        ['none', t('ytj_numbering_none')],
        ['dot', '1. 2.'],
        ['dash', '1- 2-'],
        ['colon', '1: 2:'],
        ['paren', '(1) (2)'],
    ].forEach(([value, label]) => {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = label;
        select.appendChild(option);
    });
    return select;
}

function createNumberingPaddingControls() {
    const padSelect = document.createElement('select');
    padSelect.className = 'ytj-popup-select';
    [
        ['none', t('ytj_padding_none')],
        ['zero', t('ytj_padding_zero')],
        ['space', t('ytj_padding_space')],
    ].forEach(([value, label]) => {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = label;
        padSelect.appendChild(option);
    });

    const widthInput = document.createElement('input');
    widthInput.className = 'ytj-popup-input ytj-popup-number-width';
    widthInput.type = 'text';
    widthInput.inputMode = 'numeric';
    widthInput.value = '2';
    widthInput.placeholder = '2';

    return {
        element: (() => {
            const group = document.createElement('div');
            group.className = 'ytj-popup-inline-fields';
            group.appendChild(createField(t('ytj_numbering_padding'), padSelect));
            group.appendChild(createField(t('ytj_padding_width'), widthInput));
            return group;
        })(),
        getValue: () => ({
            numberingPad: padSelect.value,
            numberingWidth: widthInput.value,
        }),
    };
}

function createCheckboxControl(labelText, checked = false) {
    const label = document.createElement('label');
    label.className = 'ytj-popup-checkbox-field';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = checked;

    const span = document.createElement('span');
    span.textContent = labelText;

    label.append(checkbox, span);
    return { element: label, checkbox };
}

/**
 * 建立彈出文本框的函數
 * @param {string} title - 彈出框的標題
 * @param {function} onSave - 當保存按鈕被點擊時的回調函數
 * @returns {HTMLElement} 彈出文本框元素
 */
export function createPopupTextBox(title, onSave) {
    const { overlay, popup } = createPopupShell(title);

    const textArea = document.createElement('textarea');
    textArea.className = 'ytj-popup-textarea';

    const buttonContainer = createPopupActions(overlay, t('ytj_save'), () => onSave(textArea.value));

    popup.appendChild(textArea);
    popup.appendChild(buttonContainer);

    return overlay;
}

/**
 * 建立彈出文本框的函數
 * @param {string} title - 彈出框的標題
 * @param {function} onSave - 當保存按鈕被點擊時的回調函數
 * @returns {HTMLElement} 彈出文本框元素
 */
export function createImportPopupTextBox(title, onSave) {
    const { overlay, popup } = createPopupShell(title, 'ytj-playlist-text-popup');

    const textArea = document.createElement('textarea');
    textArea.className = 'ytj-popup-textarea';
    textArea.placeholder = t('ytj_import_placeholder');

    const hint = document.createElement('p');
    hint.className = 'ytj-popup-hint';
    hint.textContent = t('ytj_import_flexible_hint');

    const additionalSecondsInput = document.createElement('input');
    additionalSecondsInput.className = 'ytj-popup-input';
    additionalSecondsInput.type = 'text';
    additionalSecondsInput.inputMode = 'decimal';
    additionalSecondsInput.placeholder = t('ytj_duration_placeholder');

    const delimiterControls = createDelimiterControls();
    const toolbar = document.createElement('div');
    toolbar.className = 'ytj-popup-toolbar';
    toolbar.appendChild(createField(t('ytj_default_duration'), additionalSecondsInput));
    toolbar.appendChild(delimiterControls.element);

    const buttonContainer = createPopupActions(overlay, t('ytj_import'), () => {
        const additionalSeconds = parseFloat(additionalSecondsInput.value);
        return onSave(textArea.value, additionalSeconds, { delimiter: delimiterControls.getValue() });
    });

    popup.appendChild(toolbar);
    popup.appendChild(hint);
    popup.appendChild(textArea);
    popup.appendChild(buttonContainer);

    return overlay;
}

export function createEditPlaylistPopup(title, { items = [], text = '', onSaveText, onSaveItems } = {}) {
    const { overlay, popup } = createPopupShell(title, 'ytj-playlist-edit-popup');

    const tabs = document.createElement('div');
    tabs.className = 'ytj-popup-tabs';
    const visualTab = document.createElement('button');
    visualTab.type = 'button';
    visualTab.textContent = t('ytj_simple_editor');
    visualTab.className = 'active';
    const textTab = document.createElement('button');
    textTab.type = 'button';
    textTab.textContent = t('ytj_text_mode');
    tabs.append(visualTab, textTab);

    const visualPane = document.createElement('div');
    visualPane.className = 'ytj-edit-pane';
    const textPane = document.createElement('div');
    textPane.className = 'ytj-edit-pane hidden';

    const rowList = document.createElement('div');
    rowList.className = 'ytj-edit-row-list';
    let rowDrag = null;

    const getDragAfterRow = (y) => {
        const rows = [...rowList.querySelectorAll('.ytj-edit-row:not(.ytj-edit-row-dragging)')];
        return rows.reduce((closest, row) => {
            const box = row.getBoundingClientRect();
            const offset = y - box.top - (box.height / 2);
            if (offset < 0 && offset > closest.offset) {
                return { offset, row };
            }
            return closest;
        }, { offset: Number.NEGATIVE_INFINITY, row: null }).row;
    };

    const stopRowDrag = () => {
        if (!rowDrag) return;
        rowDrag.row.classList.remove('ytj-edit-row-dragging');
        rowDrag.ghost?.remove();
        rowDrag = null;
        document.body.style.cursor = 'default';
        updateIndexes();
    };

    const onRowDragMove = (event) => {
        if (!rowDrag) return;
        event.preventDefault();
        rowDrag.ghost.style.left = `${event.clientX - rowDrag.offsetX}px`;
        rowDrag.ghost.style.top = `${event.clientY - rowDrag.offsetY}px`;

        const afterRow = getDragAfterRow(event.clientY);
        if (afterRow) {
            rowList.insertBefore(rowDrag.row, afterRow);
        } else {
            rowList.appendChild(rowDrag.row);
        }
    };

    const onRowDragEnd = () => {
        document.removeEventListener('pointermove', onRowDragMove);
        document.removeEventListener('pointerup', onRowDragEnd);
        stopRowDrag();
    };

    const createRow = (item = {}) => {
        const row = document.createElement('div');
        row.className = 'ytj-edit-row';

        const handle = document.createElement('button');
        handle.type = 'button';
        handle.className = 'ytj-edit-row-handle';
        handle.title = t('ytj_drag_to_reorder');
        handle.setAttribute('aria-label', t('ytj_drag_to_reorder'));
        handle.addEventListener('pointerdown', (event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            const rect = row.getBoundingClientRect();
            const ghost = row.cloneNode(true);
            ghost.classList.add('ytj-edit-row-display-dragging');
            Object.assign(ghost.style, {
                position: 'fixed',
                width: `${rect.width}px`,
                left: `${rect.left}px`,
                top: `${rect.top}px`,
                pointerEvents: 'none',
                zIndex: '2147483647',
                opacity: '0.92',
            });

            document.body.appendChild(ghost);
            row.classList.add('ytj-edit-row-dragging');
            document.body.style.cursor = 'grabbing';
            rowDrag = {
                row,
                ghost,
                offsetX: event.clientX - rect.left,
                offsetY: event.clientY - rect.top,
            };
            handle.setPointerCapture?.(event.pointerId);
            document.addEventListener('pointermove', onRowDragMove);
            document.addEventListener('pointerup', onRowDragEnd, { once: true });
        });

        const index = document.createElement('span');
        index.className = 'ytj-edit-row-index';

        const start = document.createElement('input');
        start.className = 'ytj-popup-input ytj-edit-time';
        start.value = item.start || '';
        start.placeholder = t('ytj_time_placeholder');

        const end = document.createElement('input');
        end.className = 'ytj-popup-input ytj-edit-time';
        end.value = item.end || '';
        end.placeholder = t('ytj_time_placeholder');

        const titleInput = document.createElement('input');
        titleInput.className = 'ytj-popup-input ytj-edit-title';
        titleInput.value = item.title || '';
        titleInput.placeholder = t('ytj_title_placeholder');

        const del = document.createElement('button');
        del.type = 'button';
        del.textContent = t('ytj_delete');

        del.addEventListener('click', () => {
            row.remove();
            updateIndexes();
        });

        row.append(handle, index, start, end, titleInput, del);
        return row;
    };

    const updateIndexes = () => {
        rowList.querySelectorAll('.ytj-edit-row').forEach((row, index) => {
            const label = row.querySelector('.ytj-edit-row-index');
            if (label) label.textContent = String(index + 1);
        });
    };

    items.forEach(item => rowList.appendChild(createRow(item)));
    updateIndexes();

    const addRowButton = document.createElement('button');
    addRowButton.type = 'button';
    addRowButton.className = 'ytj-popup-secondary-button';
    addRowButton.textContent = t('ytj_add_row');
    addRowButton.addEventListener('click', () => {
        rowList.appendChild(createRow());
        updateIndexes();
    });

    const textarea = document.createElement('textarea');
    textarea.className = 'ytj-popup-textarea';
    textarea.value = text;

    visualPane.append(rowList, addRowButton);
    textPane.appendChild(textarea);

    let activeMode = 'visual';
    const activate = (mode) => {
        activeMode = mode;
        visualTab.classList.toggle('active', mode === 'visual');
        textTab.classList.toggle('active', mode === 'text');
        visualPane.classList.toggle('hidden', mode !== 'visual');
        textPane.classList.toggle('hidden', mode !== 'text');
    };
    visualTab.addEventListener('click', () => activate('visual'));
    textTab.addEventListener('click', () => activate('text'));

    const buttonContainer = createPopupActions(overlay, t('ytj_save'), async () => {
        if (activeMode === 'text') {
            await onSaveText?.(textarea.value);
            return;
        }
        const nextItems = Array.from(rowList.querySelectorAll('.ytj-edit-row')).map(row => {
            const inputs = row.querySelectorAll('input');
            return {
                start: inputs[0]?.value || '',
                end: inputs[1]?.value || '',
                title: inputs[2]?.value || '',
            };
        });
        await onSaveItems?.(nextItems);
    });

    popup.append(tabs, visualPane, textPane, buttonContainer);
    return overlay;
}

export function createExportPlaylistPopup(title, { renderText } = {}) {
    const { overlay, popup } = createPopupShell(title, 'ytj-playlist-text-popup');
    const timeDelimiterControls = createDelimiterControls({
        includeAuto: false,
        label: t('ytj_time_delimiter'),
        extraOptions: [[' ~ ', '~']],
    });
    const titleDelimiterControls = createDelimiterControls({
        includeAuto: false,
        label: t('ytj_title_delimiter'),
        extraOptions: [[': ', ':']],
    });
    const numberingSelect = createNumberingControl();
    const numberingPaddingControls = createNumberingPaddingControls();
    const roundSecondsControl = createCheckboxControl(t('ytj_round_export_seconds'));
    const textarea = document.createElement('textarea');
    textarea.className = 'ytj-popup-textarea';
    textarea.readOnly = true;

    const toolbar = document.createElement('div');
    toolbar.className = 'ytj-popup-toolbar';
    toolbar.appendChild(timeDelimiterControls.element);
    toolbar.appendChild(titleDelimiterControls.element);
    toolbar.appendChild(createField(t('ytj_numbering'), numberingSelect));
    toolbar.appendChild(numberingPaddingControls.element);
    toolbar.appendChild(roundSecondsControl.element);

    const updateText = () => {
        const timeDelimiter = timeDelimiterControls.getValue();
        const titleDelimiter = titleDelimiterControls.getValue();
        const padding = numberingPaddingControls.getValue();
        textarea.value = renderText?.({
            timeDelimiter: timeDelimiter || ' ',
            titleDelimiter: titleDelimiter || ' ',
            numbering: numberingSelect.value,
            numberingPad: padding.numberingPad,
            numberingWidth: padding.numberingWidth,
            roundToWholeSeconds: roundSecondsControl.checkbox.checked,
        }) || '';
    };
    toolbar.addEventListener('input', updateText);
    toolbar.addEventListener('change', updateText);
    updateText();

    const buttonContainer = document.createElement('div');
    buttonContainer.className = 'ytj-popup-button-container';
    const copyButton = document.createElement('button');
    copyButton.className = 'ytj-popup-primary-button';
    copyButton.textContent = t('ytj_copy');
    copyButton.addEventListener('click', async () => {
        try {
            await navigator.clipboard.writeText(textarea.value);
        } catch (error) {
            textarea.select();
            document.execCommand('copy');
        }
    });
    const closeButton = document.createElement('button');
    closeButton.textContent = t('ytj_close');
    closeButton.addEventListener('click', () => closeOverlay(overlay));
    buttonContainer.append(copyButton, closeButton);

    popup.append(toolbar, textarea, buttonContainer);
    return overlay;
}

/**
 * Creates a toggle switch UI element.
 * @param {string} label - The description text to display next to the toggle switch.
 * @returns {Object} An object containing the toggle switch element and related functions.
 */
export function createToggleSwitch(label = t('ytj_single_playback')) {

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

    div {
        display: inline-flex;
        align-items: center;
    }
    
    label {
        cursor: pointer;
        width: 40px;
        height: 20px;
        background: grey;
        display: block;
        border-radius: 10px;
        position: relative;
        margin: 0;
        box-sizing: border-box;
    }
    
    label:after {
        content: '';
        position: absolute;
        left: 3px;
        top: 50%;
        width: 16px;
        height: 16px;
        background: #fff;
        border-radius: 50%;
        transform: translateY(-50%);
        transition: transform 0.2s ease-in-out, background-color 0.2s ease-in-out;
        will-change: transform;
    }
    
    input:checked + label {
        background: #0462a1;
    }
    
    label:active:after {
        width: 16px;
    }
    
    input:checked + label:after {
        transform: translate(18px, -50%);
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
    description.style.marginTop = '2px';

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
