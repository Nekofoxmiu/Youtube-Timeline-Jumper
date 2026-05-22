import {
  AUTO_SONG_TYPE,
  buildPlaylistMeta,
  exportPlaylistText,
  formatSeconds,
  isTimeToken,
  normalizePlaylist,
  normalizePlaylistItem,
  parsePlaylistText,
  serializePlaylist,
  toSeconds,
} from './playlistCore.js';
import { t } from './i18n.js';

function readVideoDurationSec() {
  const video = document.querySelector('video');
  if (!video || !Number.isFinite(video.duration)) return null;
  return Math.max(0, video.duration);
}

function clampSeconds(seconds) {
  const sec = toSeconds(seconds);
  const duration = readVideoDurationSec();
  if (duration === null) return sec;
  return Math.min(sec, duration);
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const CONTROLS_COLLAPSE_DELAY_MS = 500;
const DEFAULT_IMPORT_DURATION_SEC = 30;
const RUNNING_DETECTION_STATUSES = new Set(['Listening', 'Detecting', 'PostProcessing']);

function normalizeDetectionStatus(status) {
  const key = String(status || '').trim().toLowerCase();
  if (key === 'listening') return 'Listening';
  if (key === 'detecting') return 'Detecting';
  if (key === 'postprocessing' || key === 'post-processing' || key === 'post processing') return 'PostProcessing';
  if (key === 'stopped') return 'Stopped';
  if (key === 'error') return 'Error';
  return 'Idle';
}

export class PlaylistController {
  constructor(options = {}) {
    this.videoId = options.videoId || '';
    this.playlistContainer = options.playlistContainer;
    this.listElement = options.listElement;
    this.playButton = options.playButton;
    this.toggleSwitch = options.toggleSwitch;
    this.getCurrentTimeSeconds = options.getCurrentTimeSeconds || (() => 0);
    this.createPopupTextBox = options.createPopupTextBox;
    this.createImportPopupTextBox = options.createImportPopupTextBox;
    this.createEditPlaylistPopup = options.createEditPlaylistPopup;
    this.createExportPlaylistPopup = options.createExportPlaylistPopup;
    this.legacyState = options.legacyState || null;

    this.items = [];
    this.meta = {};
    this.detectionStatus = 'Idle';
    this.drag = null;
    this.edit = null;
    this.controlsCollapseTimer = null;
    this.expandedControlsItem = null;
    this.playback = {
      runId: 0,
      activeId: null,
      playing: false,
    };

    this.onListClick = this.onListClick.bind(this);
    this.onListFocusOut = this.onListFocusOut.bind(this);
    this.onListFocusIn = this.onListFocusIn.bind(this);
    this.onListKeyDown = this.onListKeyDown.bind(this);
    this.onEditKeyDown = this.onEditKeyDown.bind(this);
    this.stopEditKeyPropagation = this.stopEditKeyPropagation.bind(this);
    this.onListPointerOver = this.onListPointerOver.bind(this);
    this.onListPointerOut = this.onListPointerOut.bind(this);
    this.onPointerDown = this.onPointerDown.bind(this);
    this.onPointerMove = this.onPointerMove.bind(this);
    this.onPointerUp = this.onPointerUp.bind(this);
    this.onPlayButtonClick = this.onPlayButtonClick.bind(this);
  }

  get storageKey() {
    return `playlist_${this.videoId}`;
  }

  get metaKey() {
    return `playlist_meta_${this.videoId}`;
  }

  bind() {
    this.listElement?.addEventListener('click', this.onListClick);
    this.listElement?.addEventListener('focusin', this.onListFocusIn);
    this.listElement?.addEventListener('focusout', this.onListFocusOut);
    this.listElement?.addEventListener('keydown', this.onListKeyDown);
    this.listElement?.addEventListener('pointerover', this.onListPointerOver);
    this.listElement?.addEventListener('pointerout', this.onListPointerOut);
    this.listElement?.addEventListener('pointerdown', this.onPointerDown);
    this.playButton?.addEventListener('click', this.onPlayButtonClick);
  }

  destroy() {
    this.stopPlayback();
    this.listElement?.removeEventListener('click', this.onListClick);
    this.listElement?.removeEventListener('focusin', this.onListFocusIn);
    this.listElement?.removeEventListener('focusout', this.onListFocusOut);
    this.listElement?.removeEventListener('keydown', this.onListKeyDown);
    this.listElement?.removeEventListener('pointerover', this.onListPointerOver);
    this.listElement?.removeEventListener('pointerout', this.onListPointerOut);
    this.listElement?.removeEventListener('pointerdown', this.onPointerDown);
    this.playButton?.removeEventListener('click', this.onPlayButtonClick);
    document.removeEventListener('pointermove', this.onPointerMove);
    document.removeEventListener('pointerup', this.onPointerUp);
    this.drag?.ghost?.remove();
    this.clearControlsExpansion();
    this.drag = null;
  }

  async loadFromStorage() {
    if (!this.videoId) return;
    const result = await chrome.storage.local.get([this.storageKey, this.metaKey]);
    const rawItems = result[this.storageKey];
    const rawMeta = result[this.metaKey] || {};
    const { items, rebuilt } = normalizePlaylist(rawItems, rawMeta);

    this.items = items;
    this.meta = buildPlaylistMeta(items, rawMeta, rebuilt ? { rebuiltAt: new Date().toISOString() } : {});
    this.render({ incremental: true });
    this.syncLegacyState();

    if (rebuilt || rawMeta.schemaVersion !== 3) {
      await this.save({ rebuilt });
    }
  }

  async save({ rebuilt = false } = {}) {
    if (!this.videoId) return;
    this.syncLegacyState();

    if (!this.items.length) {
      await chrome.storage.local.remove([this.storageKey, this.metaKey]);
      return;
    }

    this.meta = buildPlaylistMeta(this.items, this.meta, rebuilt ? { rebuiltAt: new Date().toISOString() } : {});
    await chrome.storage.local.set({
      [this.storageKey]: serializePlaylist(this.items),
      [this.metaKey]: this.meta,
    });
  }

  syncLegacyState() {
    if (!this.legacyState) return;
    this.legacyState.state = serializePlaylist(this.items);
    this.legacyState.playlistItems = Array.from(this.listElement?.querySelectorAll('.ytj-playlist-item') || []);
  }

  setDetectionStatus(status) {
    const nextStatus = normalizeDetectionStatus(status);
    if (this.detectionStatus === nextStatus) return;
    this.detectionStatus = nextStatus;
    this.updateAutoSongLockState();
  }

  isDetectionActive() {
    return RUNNING_DETECTION_STATUSES.has(this.detectionStatus);
  }

  isAutoSongLocked(item) {
    return this.isDetectionActive() && item?.type === AUTO_SONG_TYPE;
  }

  updateAutoSongLockState() {
    if (!this.listElement) return;
    for (const li of this.listElement.querySelectorAll('.ytj-playlist-item')) {
      const item = this.findItem(li.dataset.itemId);
      if (item) this.syncItemElement(item, li, { preserveActiveTitle: true });
    }
  }

  render(options = {}) {
    if (!this.listElement) return;
    const { incremental = true } = options;

    if (!incremental || !this.listElement.children.length) {
      this.clearControlsExpansion();
      this.listElement.innerHTML = '';
      for (const item of this.items) {
        this.listElement.appendChild(this.createItemElement(item));
      }
    } else {
      const existingById = new Map(
        Array.from(this.listElement.querySelectorAll('.ytj-playlist-item'))
          .map(element => [element.dataset.itemId, element])
      );
      const seen = new Set();
      for (const item of this.items) {
        let element = existingById.get(item.id);
        if (!element) {
          element = this.createItemElement(item);
        } else {
          this.syncItemElement(item, element, { preserveActiveTitle: true });
        }
        seen.add(item.id);
        this.listElement.appendChild(element);
      }
      for (const [id, element] of existingById.entries()) {
        if (!seen.has(id)) element.remove();
      }
    }
    if (this.playlistContainer && this.listElement.parentNode !== this.playlistContainer) {
      this.playlistContainer.appendChild(this.listElement);
    }
    this.applyPlaybackUi();
    this.syncLegacyState();
  }

  createItemElement(item) {
    const li = document.createElement('li');
    li.className = 'ytj-playlist-item';
    li.dataset.itemId = item.id;
    li.dataset.itemType = item.type || 'manual';

    if (item.type === AUTO_SONG_TYPE) li.classList.add('ytj-auto-song-item');
    if (item.type === AUTO_SONG_TYPE && item.provisional) li.classList.add('ytj-auto-song-provisional');

    const dragHandle = document.createElement('div');
    dragHandle.className = 'ytj-drag-handle';
    dragHandle.title = t('ytj_drag');
    dragHandle.setAttribute('aria-label', t('ytj_drag_playlist_item'));

    const playingIndicator = document.createElement('button');
    playingIndicator.type = 'button';
    playingIndicator.className = 'ytj-playing-indicator';
    playingIndicator.tabIndex = -1;
    playingIndicator.title = t('ytj_currently_playing');
    playingIndicator.setAttribute('aria-hidden', 'true');

    const startFromHere = document.createElement('button');
    startFromHere.type = 'button';
    startFromHere.className = 'ytj-start-from-here';
    startFromHere.dataset.action = 'play-from-here';
    startFromHere.title = t('ytj_play_from_here');

    const startText = document.createElement('div');
    startText.className = 'ytj-playlist-item-text-start';
    startText.dataset.field = 'start';
    startText.setAttribute('timeat', String(item.startSec));
    startText.textContent = formatSeconds(item.startSec);

    const endText = document.createElement('div');
    endText.className = 'ytj-playlist-item-text-end';
    endText.dataset.field = 'end';
    endText.setAttribute('timeat', String(item.endSec));
    endText.textContent = formatSeconds(item.endSec);

    const titleInput = document.createElement('input');
    titleInput.type = 'text';
    titleInput.className = 'ytj-playlist-item-title editable';
    titleInput.dataset.field = 'title';
    titleInput.readOnly = true;
    titleInput.placeholder = t('ytj_title_placeholder');
    titleInput.value = item.title || '';

    const setStart = document.createElement('button');
    setStart.type = 'button';
    setStart.className = 'ytj-set-start-time';
    setStart.dataset.action = 'set-start';
    setStart.title = t('ytj_set_start_time');

    const setEnd = document.createElement('button');
    setEnd.type = 'button';
    setEnd.className = 'ytj-set-end-time';
    setEnd.dataset.action = 'set-end';
    setEnd.title = t('ytj_set_end_time');

    const deleteButton = document.createElement('button');
    deleteButton.type = 'button';
    deleteButton.className = 'ytj-delete-item';
    deleteButton.dataset.action = 'delete';
    deleteButton.title = t('ytj_delete');

    li.append(
      playingIndicator,
      dragHandle,
      startFromHere,
      startText,
      endText,
      titleInput,
      setStart,
      setEnd,
      deleteButton
    );
    this.syncItemElement(item, li, { preserveActiveTitle: false });
    return li;
  }

  findItem(id) {
    return this.items.find(item => item.id === id) || null;
  }

  findItemIndex(id) {
    return this.items.findIndex(item => item.id === id);
  }

  syncItemElement(item, li = null, options = {}) {
    const target = li || Array.from(this.listElement?.querySelectorAll('.ytj-playlist-item') || [])
      .find(element => element.dataset.itemId === item.id);
    if (!target || !item) return false;

    const isAutoSong = item.type === AUTO_SONG_TYPE;
    const isLocked = this.isAutoSongLocked(item);
    target.dataset.itemId = item.id;
    target.dataset.itemType = item.type || 'manual';
    target.dataset.locked = isLocked ? 'true' : 'false';
    target.classList.toggle('ytj-auto-song-item', isAutoSong);
    target.classList.toggle('ytj-auto-song-provisional', Boolean(isAutoSong && item.provisional));
    target.classList.toggle('ytj-auto-song-locked', Boolean(isLocked));

    const startText = target.querySelector('.ytj-playlist-item-text-start');
    if (startText) {
      startText.setAttribute('timeat', String(item.startSec));
      startText.textContent = formatSeconds(item.startSec);
      startText.setAttribute('aria-disabled', isLocked ? 'true' : 'false');
    }

    const endText = target.querySelector('.ytj-playlist-item-text-end');
    if (endText) {
      endText.setAttribute('timeat', String(item.endSec));
      endText.textContent = formatSeconds(item.endSec);
      endText.setAttribute('aria-disabled', isLocked ? 'true' : 'false');
    }

    const titleInput = target.querySelector('.ytj-playlist-item-title');
    const preserveActiveTitle = options.preserveActiveTitle !== false;
    const isEditingTitle = preserveActiveTitle && (
      titleInput === document.activeElement
      || (this.edit?.id === item.id && this.edit.field === 'title')
    );
    if (titleInput && !isEditingTitle && titleInput.value !== (item.title || '')) {
      titleInput.value = item.title || '';
    }

    const lockableControls = [
      target.querySelector('.ytj-drag-handle'),
      target.querySelector('.ytj-set-start-time'),
      target.querySelector('.ytj-set-end-time'),
      target.querySelector('.ytj-delete-item'),
    ].filter(Boolean);
    for (const control of lockableControls) {
      control.setAttribute('aria-disabled', isLocked ? 'true' : 'false');
      if ('disabled' in control && !control.classList.contains('ytj-drag-handle')) {
        control.disabled = isLocked;
      }
    }

    return true;
  }

  touchItem(item) {
    item.updatedAt = new Date().toISOString();
  }

  getManualCurrentTimeSeconds() {
    const current = clampSeconds(this.getCurrentTimeSeconds());
    const rounded = Math.round(current);
    const duration = readVideoDurationSec();
    if (duration !== null && rounded > duration) return Math.floor(duration);
    return Math.max(0, rounded);
  }

  async addAtCurrentTime() {
    const nowSec = this.getManualCurrentTimeSeconds();
    const now = new Date().toISOString();
    const item = normalizePlaylistItem({
      startSec: nowSec,
      endSec: nowSec,
      title: '',
      createdAt: now,
      updatedAt: now,
    }, this.items.length);
    this.items.push(item);
    this.render();
    await this.save();
  }

  async replaceFromText(text, options = {}) {
    this.items = parsePlaylistText(text, options);
    this.render();
    await this.save({ rebuilt: true });
  }

  async appendFromText(text, defaultDurationSec = 0, options = {}) {
    const imported = parsePlaylistText(text, { ...options, defaultDurationSec });
    this.items.push(...imported);
    this.render();
    await this.save({ rebuilt: true });
  }

  async replaceFromEditorItems(rawItems) {
    const now = new Date().toISOString();
    this.items = (Array.isArray(rawItems) ? rawItems : [])
      .map((raw, index) => {
        const existing = this.items[index] || {};
        return normalizePlaylistItem({
          ...existing,
          startSec: toSeconds(raw.start),
          endSec: Math.max(toSeconds(raw.start), toSeconds(raw.end)),
          title: raw.title || '',
          createdAt: existing.createdAt || now,
          updatedAt: now,
        }, index);
      })
      .filter(item => item.endSec >= item.startSec);
    this.render();
    await this.save({ rebuilt: true });
  }

  openImportDialog() {
    if (!this.createImportPopupTextBox) return;
    this.createImportPopupTextBox(t('ytj_import_playlist'), async (text, additionalSeconds, options = {}) => {
      const duration = Number.isFinite(Number(additionalSeconds)) && Number(additionalSeconds) >= 0
        ? Number(additionalSeconds)
        : DEFAULT_IMPORT_DURATION_SEC;
      await this.appendFromText(text, duration, options);
    });
  }

  openBulkEditDialog() {
    if (this.createEditPlaylistPopup) {
      this.createEditPlaylistPopup(t('ytj_edit_playlist'), {
        items: this.items.map(item => ({
          start: formatSeconds(item.startSec),
          end: formatSeconds(item.endSec),
          title: item.title || '',
        })),
        text: exportPlaylistText(this.items),
        onSaveText: async (text) => {
          await this.replaceFromText(text);
        },
        onSaveItems: async (items) => {
          await this.replaceFromEditorItems(items);
        },
      });
      return;
    }
    if (!this.createPopupTextBox) return;
    const overlay = this.createPopupTextBox(t('ytj_edit_playlist'), async (text) => {
      await this.replaceFromText(text);
    });
    const textarea = overlay?.querySelector('textarea');
    if (textarea) textarea.value = exportPlaylistText(this.items);
  }

  openExportDialog() {
    if (this.createExportPlaylistPopup) {
      this.createExportPlaylistPopup(t('ytj_export_playlist'), {
        renderText: options => exportPlaylistText(this.items, options),
      });
      return;
    }
    if (!this.createPopupTextBox) return;
    const overlay = this.createPopupTextBox(t('ytj_export_playlist'), () => {});
    const textarea = overlay?.querySelector('textarea');
    if (textarea) textarea.value = exportPlaylistText(this.items);
  }

  async setCurrentTime(id, field) {
    const item = this.findItem(id);
    if (!item) return;
    if (this.isAutoSongLocked(item)) return;
    const seconds = this.getManualCurrentTimeSeconds();
    if (field === 'start') {
      item.startSec = Math.min(seconds, item.endSec);
    } else {
      item.endSec = Math.max(item.startSec, seconds);
    }
    this.touchItem(item);
    this.render();
    await this.save();
  }

  async deleteItem(id) {
    const index = this.findItemIndex(id);
    if (index < 0) return;
    if (this.isAutoSongLocked(this.items[index])) return;
    this.items.splice(index, 1);
    this.render();
    await this.save();
  }

  expandControlsForItem(li) {
    if (!li || !this.listElement?.contains(li)) return;
    if (this.controlsCollapseTimer) {
      clearTimeout(this.controlsCollapseTimer);
      this.controlsCollapseTimer = null;
    }
    if (this.expandedControlsItem && this.expandedControlsItem !== li) {
      this.expandedControlsItem.classList.remove('ytj-controls-expanded');
    }
    this.expandedControlsItem = li;
    li.classList.add('ytj-controls-expanded');
  }

  scheduleControlsCollapse(li) {
    if (!li || this.expandedControlsItem !== li) return;
    if (this.controlsCollapseTimer) clearTimeout(this.controlsCollapseTimer);
    this.controlsCollapseTimer = setTimeout(() => {
      this.controlsCollapseTimer = null;
      if (this.expandedControlsItem !== li) return;
      if (li.matches(':hover') || li.contains(document.activeElement)) return;
      li.classList.remove('ytj-controls-expanded');
      this.expandedControlsItem = null;
    }, CONTROLS_COLLAPSE_DELAY_MS);
  }

  clearControlsExpansion() {
    if (this.controlsCollapseTimer) {
      clearTimeout(this.controlsCollapseTimer);
      this.controlsCollapseTimer = null;
    }
    this.expandedControlsItem?.classList.remove('ytj-controls-expanded');
    this.expandedControlsItem = null;
  }

  getEventPlaylistItem(event) {
    const li = event.target?.closest?.('.ytj-playlist-item');
    return li && this.listElement?.contains(li) ? li : null;
  }

  onListPointerOver(event) {
    const li = this.getEventPlaylistItem(event);
    if (!li) return;
    this.expandControlsForItem(li);
  }

  onListPointerOut(event) {
    const li = this.getEventPlaylistItem(event);
    if (!li || (event.relatedTarget instanceof Node && li.contains(event.relatedTarget))) return;
    this.scheduleControlsCollapse(li);
  }

  onListFocusIn(event) {
    const li = this.getEventPlaylistItem(event);
    if (li) this.expandControlsForItem(li);
  }

  onListClick(event) {
    const actionButton = event.target.closest('[data-action]');
    const li = event.target.closest('.ytj-playlist-item');
    const id = li?.dataset.itemId;

    if (actionButton && id) {
      const action = actionButton.dataset.action;
      const item = this.findItem(id);
      if (this.isAutoSongLocked(item) && ['set-start', 'set-end', 'delete'].includes(action)) {
        event.preventDefault();
        return;
      }
      if (action === 'set-start') this.setCurrentTime(id, 'start');
      if (action === 'set-end') this.setCurrentTime(id, 'end');
      if (action === 'delete') this.deleteItem(id);
      if (action === 'play-from-here') {
        const index = this.findItemIndex(id);
        const single = Boolean(event.ctrlKey || this.toggleSwitch?.getSwitchState?.());
        this.playRange(index, single ? index + 1 : this.items.length);
      }
      return;
    }

    const editable = event.target.closest('[data-field]');
    if (editable && id) {
      this.beginEdit(editable, id, editable.dataset.field);
    }
  }

  beginEdit(element, id, field) {
    const item = this.findItem(id);
    if (this.isAutoSongLocked(item) && field !== 'title') return;
    if (this.edit?.element === element) return;
    this.commitEdit(false);

    this.edit = {
      element,
      id,
      field,
      originalText: element.tagName === 'INPUT' ? element.value : element.textContent,
    };
    element.addEventListener('keydown', this.onEditKeyDown);
    element.addEventListener('keypress', this.stopEditKeyPropagation);
    element.addEventListener('keyup', this.stopEditKeyPropagation);

    if (element.tagName === 'INPUT') {
      element.readOnly = false;
      element.focus();
      element.select();
    } else {
      element.contentEditable = 'true';
      element.focus();
      document.getSelection()?.selectAllChildren(element);
    }
  }

  onListKeyDown(event) {
    if (!this.edit || event.target !== this.edit.element) return;
    this.onEditKeyDown(event);
  }

  onEditKeyDown(event) {
    if (!this.edit || event.target !== this.edit.element) return;
    event.stopPropagation();
    if (event.key === 'Enter') {
      event.preventDefault();
      this.commitEdit(true);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      this.cancelEdit();
    }
  }

  stopEditKeyPropagation(event) {
    if (!this.edit || event.target !== this.edit.element) return;
    event.stopPropagation();
  }

  onListFocusOut(event) {
    const li = this.getEventPlaylistItem(event);
    if (li && (!(event.relatedTarget instanceof Node) || !li.contains(event.relatedTarget))) {
      this.scheduleControlsCollapse(li);
    }
    if (!this.edit || event.target !== this.edit.element) return;
    this.commitEdit(true);
  }

  cancelEdit() {
    if (!this.edit) return;
    const { element, originalText } = this.edit;
    if (element.tagName === 'INPUT') {
      element.value = originalText;
      element.readOnly = true;
    } else {
      element.textContent = originalText;
      element.contentEditable = 'false';
    }
    element.removeEventListener('keydown', this.onEditKeyDown);
    element.removeEventListener('keypress', this.stopEditKeyPropagation);
    element.removeEventListener('keyup', this.stopEditKeyPropagation);
    this.edit = null;
  }

  async commitEdit(shouldSave) {
    if (!this.edit) return;
    const { element, id, field } = this.edit;
    const item = this.findItem(id);
    const li = element.closest('.ytj-playlist-item');
    this.edit = null;
    element.removeEventListener('keydown', this.onEditKeyDown);
    element.removeEventListener('keypress', this.stopEditKeyPropagation);
    element.removeEventListener('keyup', this.stopEditKeyPropagation);

    if (element.tagName === 'INPUT') {
      element.readOnly = true;
    } else {
      element.contentEditable = 'false';
    }

    if (!item || !shouldSave) return;
    if (this.isAutoSongLocked(item) && field !== 'title') {
      this.syncItemElement(item, li);
      return;
    }

    if (field === 'title') {
      item.title = element.value || '';
    } else {
      const rawTime = String(element.textContent || '').trim();
      if (!isTimeToken(rawTime)) {
        this.syncItemElement(item, li);
        return;
      }
      const seconds = clampSeconds(rawTime);
      if (field === 'start') item.startSec = Math.min(seconds, item.endSec);
      if (field === 'end') item.endSec = Math.max(item.startSec, seconds);
    }

    this.touchItem(item);
    if (!this.syncItemElement(item, li)) this.render();
    await this.save();
  }

  onPointerDown(event) {
    const handle = event.target.closest('.ytj-drag-handle');
    const li = event.target.closest('.ytj-playlist-item');
    if (!handle || !li || event.button !== 0) return;
    if (this.isAutoSongLocked(this.findItem(li.dataset.itemId))) return;

    event.preventDefault();
    const rect = li.getBoundingClientRect();
    const ghost = li.cloneNode(true);
    ghost.classList.add('ytj-display-dragging');
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
    li.classList.add('ytj-dragging');
    document.body.style.cursor = 'grabbing';

    this.drag = {
      id: li.dataset.itemId,
      itemElement: li,
      ghost,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
    };

    document.addEventListener('pointermove', this.onPointerMove);
    document.addEventListener('pointerup', this.onPointerUp, { once: true });
  }

  onPointerMove(event) {
    if (!this.drag) return;

    this.drag.ghost.style.left = `${event.clientX - this.drag.offsetX}px`;
    this.drag.ghost.style.top = `${event.clientY - this.drag.offsetY}px`;

    const afterElement = this.getDragAfterElement(event.clientY);
    if (afterElement) {
      this.listElement.insertBefore(this.drag.itemElement, afterElement);
    } else {
      this.listElement.appendChild(this.drag.itemElement);
    }
  }

  async onPointerUp() {
    if (!this.drag) return;

    const { itemElement, ghost } = this.drag;
    itemElement.classList.remove('ytj-dragging');
    ghost.remove();
    document.body.style.cursor = 'default';
    document.removeEventListener('pointermove', this.onPointerMove);

    const idOrder = Array.from(this.listElement.querySelectorAll('.ytj-playlist-item'))
      .map(item => item.dataset.itemId);
    const nextItems = idOrder
      .map(id => this.findItem(id))
      .filter(Boolean);

    if (nextItems.length === this.items.length) {
      this.items = nextItems;
      await this.save();
    } else {
      this.render();
    }

    this.drag = null;
  }

  getDragAfterElement(y) {
    const elements = [...this.listElement.querySelectorAll('.ytj-playlist-item:not(.ytj-dragging)')];
    return elements.reduce((closest, child) => {
      const box = child.getBoundingClientRect();
      const offset = y - box.top - (box.height / 2);
      if (offset < 0 && offset > closest.offset) {
        return { offset, element: child };
      }
      return closest;
    }, { offset: Number.NEGATIVE_INFINITY, element: null }).element;
  }

  async onPlayButtonClick() {
    if (this.playback.playing) {
      await this.stopPlayback();
      return;
    }
    await this.playRange(0, this.items.length);
  }

  async playRange(startIndex = 0, endIndex = this.items.length) {
    const video = document.querySelector('video');
    if (!video || !this.items.length) return;

    const start = Math.max(0, Math.min(this.items.length, Number(startIndex) || 0));
    const end = Math.max(start, Math.min(this.items.length, Number(endIndex) || this.items.length));
    if (start >= end) return;

    const runId = this.playback.runId + 1;
    this.playback = { runId, activeId: null, playing: true };
    this.applyPlaybackUi();

    try {
      for (let index = start; index < end; index += 1) {
        if (this.playback.runId !== runId) break;
        const item = this.items[index];
        if (!item) continue;

        this.playback.activeId = item.id;
        this.applyPlaybackUi();

        const startSec = clampSeconds(item.startSec);
        const endSec = Math.max(startSec + 0.5, clampSeconds(item.endSec));
        video.currentTime = startSec;
        await video.play();

        while (this.playback.runId === runId && !video.ended && video.currentTime < endSec) {
          await wait(100);
        }
      }
    } catch (error) {
      console.debug('Playlist playback failed:', error);
    } finally {
      if (this.playback.runId === runId) {
        await this.stopPlayback({ pauseVideo: true });
      }
    }
  }

  async stopPlayback({ pauseVideo = true } = {}) {
    this.playback.runId += 1;
    this.playback.activeId = null;
    this.playback.playing = false;

    if (pauseVideo) {
      const video = document.querySelector('video');
      if (video) video.pause();
    }

    this.applyPlaybackUi();
  }

  applyPlaybackUi() {
    if (this.playButton) {
      this.playButton.classList.toggle('playing', this.playback.playing);
    }

    const activeId = this.playback.activeId;
    this.listElement?.querySelectorAll('.ytj-playlist-item').forEach(item => {
      const isActive = activeId && item.dataset.itemId === activeId;
      item.classList.toggle('ytj-playing-item', Boolean(isActive));
      item.querySelector('.ytj-playing-indicator')?.classList.toggle('playing', Boolean(isActive));
      item.querySelector('.ytj-drag-handle')?.classList.remove('playing');
    });
  }
}
