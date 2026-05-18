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

function readVideoDurationSec() {
  const video = document.querySelector('video');
  if (!video || !Number.isFinite(video.duration)) return null;
  return Math.max(0, Math.floor(video.duration));
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
    this.legacyState = options.legacyState || null;

    this.items = [];
    this.meta = {};
    this.drag = null;
    this.edit = null;
    this.playback = {
      runId: 0,
      activeId: null,
      playing: false,
    };

    this.onListClick = this.onListClick.bind(this);
    this.onListFocusOut = this.onListFocusOut.bind(this);
    this.onListKeyDown = this.onListKeyDown.bind(this);
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
    this.listElement?.addEventListener('focusout', this.onListFocusOut);
    this.listElement?.addEventListener('keydown', this.onListKeyDown);
    this.listElement?.addEventListener('pointerdown', this.onPointerDown);
    this.playButton?.addEventListener('click', this.onPlayButtonClick);
  }

  destroy() {
    this.stopPlayback();
    this.listElement?.removeEventListener('click', this.onListClick);
    this.listElement?.removeEventListener('focusout', this.onListFocusOut);
    this.listElement?.removeEventListener('keydown', this.onListKeyDown);
    this.listElement?.removeEventListener('pointerdown', this.onPointerDown);
    this.playButton?.removeEventListener('click', this.onPlayButtonClick);
    document.removeEventListener('pointermove', this.onPointerMove);
    document.removeEventListener('pointerup', this.onPointerUp);
    this.drag?.ghost?.remove();
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
    this.render();
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

  render() {
    if (!this.listElement) return;
    this.listElement.innerHTML = '';
    for (const item of this.items) {
      this.listElement.appendChild(this.createItemElement(item));
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
    dragHandle.title = 'Drag';
    dragHandle.setAttribute('aria-label', 'Drag playlist item');

    const startFromHere = document.createElement('button');
    startFromHere.type = 'button';
    startFromHere.className = 'ytj-start-from-here';
    startFromHere.dataset.action = 'play-from-here';
    startFromHere.title = 'Play from here';

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
    titleInput.placeholder = 'Title';
    titleInput.value = item.title || '';

    const setStart = document.createElement('button');
    setStart.type = 'button';
    setStart.className = 'ytj-set-start-time';
    setStart.dataset.action = 'set-start';
    setStart.title = 'Set start time';

    const setEnd = document.createElement('button');
    setEnd.type = 'button';
    setEnd.className = 'ytj-set-end-time';
    setEnd.dataset.action = 'set-end';
    setEnd.title = 'Set end time';

    const deleteButton = document.createElement('button');
    deleteButton.type = 'button';
    deleteButton.className = 'ytj-delete-item';
    deleteButton.dataset.action = 'delete';
    deleteButton.title = 'Delete';

    li.append(
      dragHandle,
      startFromHere,
      startText,
      endText,
      titleInput,
      setStart,
      setEnd,
      deleteButton
    );
    return li;
  }

  findItem(id) {
    return this.items.find(item => item.id === id) || null;
  }

  findItemIndex(id) {
    return this.items.findIndex(item => item.id === id);
  }

  touchItem(item) {
    item.updatedAt = new Date().toISOString();
  }

  async addAtCurrentTime() {
    const nowSec = clampSeconds(this.getCurrentTimeSeconds());
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

  async replaceFromText(text) {
    this.items = parsePlaylistText(text);
    this.render();
    await this.save({ rebuilt: true });
  }

  async appendFromText(text, defaultDurationSec = 0) {
    const imported = parsePlaylistText(text, { defaultDurationSec });
    this.items.push(...imported);
    this.render();
    await this.save({ rebuilt: true });
  }

  openImportDialog() {
    if (!this.createImportPopupTextBox) return;
    this.createImportPopupTextBox('Import Playlist', async (text, additionalSeconds) => {
      const duration = Number.isFinite(Number(additionalSeconds)) && Number(additionalSeconds) > 0
        ? Number(additionalSeconds)
        : 0;
      await this.appendFromText(text, duration);
    });
  }

  openBulkEditDialog() {
    if (!this.createPopupTextBox) return;
    const overlay = this.createPopupTextBox('Edit Playlist', async (text) => {
      await this.replaceFromText(text);
    });
    const textarea = overlay?.querySelector('textarea');
    if (textarea) textarea.value = exportPlaylistText(this.items);
  }

  openExportDialog() {
    if (!this.createPopupTextBox) return;
    const overlay = this.createPopupTextBox('Export Playlist', () => {});
    const textarea = overlay?.querySelector('textarea');
    if (textarea) textarea.value = exportPlaylistText(this.items);
  }

  async setCurrentTime(id, field) {
    const item = this.findItem(id);
    if (!item) return;
    const seconds = clampSeconds(this.getCurrentTimeSeconds());
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
    this.items.splice(index, 1);
    this.render();
    await this.save();
  }

  onListClick(event) {
    const actionButton = event.target.closest('[data-action]');
    const li = event.target.closest('.ytj-playlist-item');
    const id = li?.dataset.itemId;

    if (actionButton && id) {
      const action = actionButton.dataset.action;
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
    if (this.edit?.element === element) return;
    this.commitEdit(false);

    this.edit = {
      element,
      id,
      field,
      originalText: element.tagName === 'INPUT' ? element.value : element.textContent,
    };

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
    if (event.key === 'Enter') {
      event.preventDefault();
      this.commitEdit(true);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      this.cancelEdit();
    }
  }

  onListFocusOut(event) {
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
    this.edit = null;
  }

  async commitEdit(shouldSave) {
    if (!this.edit) return;
    const { element, id, field } = this.edit;
    const item = this.findItem(id);
    this.edit = null;

    if (element.tagName === 'INPUT') {
      element.readOnly = true;
    } else {
      element.contentEditable = 'false';
    }

    if (!item || !shouldSave) return;

    if (field === 'title') {
      item.title = element.value || '';
    } else {
      const rawTime = String(element.textContent || '').trim();
      if (!isTimeToken(rawTime)) {
        this.render();
        return;
      }
      const seconds = clampSeconds(rawTime);
      if (field === 'start') item.startSec = Math.min(seconds, item.endSec);
      if (field === 'end') item.endSec = Math.max(item.startSec, seconds);
    }

    this.touchItem(item);
    this.render();
    await this.save();
  }

  onPointerDown(event) {
    const handle = event.target.closest('.ytj-drag-handle');
    const li = event.target.closest('.ytj-playlist-item');
    if (!handle || !li || event.button !== 0) return;

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
      item.querySelector('.ytj-drag-handle')?.classList.toggle('playing', Boolean(isActive));
    });
  }
}
