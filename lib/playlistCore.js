export const PLAYLIST_SCHEMA_VERSION = 3;
export const AUTO_SONG_TYPE = 'auto-song';

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function stableHash(input) {
  const text = String(input || '');
  let hash = 5381;
  for (let i = 0; i < text.length; i += 1) {
    hash = ((hash << 5) + hash) ^ text.charCodeAt(i);
  }
  return (hash >>> 0).toString(36);
}

export function toSeconds(value) {
  if (value && typeof value.getTotalseconds === 'function') {
    return Math.max(0, Math.floor(value.getTotalseconds()));
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
  }

  if (typeof value === 'string') {
    return parseTimeToken(value);
  }

  if (value && typeof value === 'object') {
    const h = Number(value.hours) || 0;
    const m = Number(value.minutes) || 0;
    const s = Number(value.seconds) || 0;
    return Math.max(0, Math.floor((h * 3600) + (m * 60) + s));
  }

  return 0;
}

export function secondsToTimeObject(seconds) {
  const sec = toSeconds(seconds);
  return {
    hours: Math.floor(sec / 3600),
    minutes: Math.floor((sec % 3600) / 60),
    seconds: sec % 60,
  };
}

export function formatSeconds(seconds) {
  const sec = toSeconds(seconds);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function parseTimeToken(token) {
  const parts = String(token || '').trim().split(':');
  if (parts.length < 2 || parts.length > 3 || parts.some(part => !/^\d+$/.test(part))) {
    return 0;
  }

  const nums = parts.map(Number);
  if (nums.length === 2) {
    return Math.max(0, Math.floor((nums[0] * 60) + nums[1]));
  }
  return Math.max(0, Math.floor((nums[0] * 3600) + (nums[1] * 60) + nums[2]));
}

export function isTimeToken(token) {
  const parts = String(token || '').trim().split(':');
  return parts.length >= 2 && parts.length <= 3 && parts.every(part => /^\d+$/.test(part));
}

export function normalizePlaylistItem(rawItem, index = 0, meta = {}) {
  const raw = rawItem && typeof rawItem === 'object' ? rawItem : {};
  const now = new Date().toISOString();

  let startSec = Number.isFinite(Number(raw.startSec))
    ? Number(raw.startSec)
    : toSeconds(raw.start ?? raw.startTime ?? raw.time);
  let endSec = Number.isFinite(Number(raw.endSec))
    ? Number(raw.endSec)
    : toSeconds(raw.end ?? raw.endTime ?? raw.start ?? raw.time);

  startSec = toSeconds(startSec);
  endSec = Math.max(startSec, toSeconds(endSec));

  const type = raw.type === AUTO_SONG_TYPE ? AUTO_SONG_TYPE : 'manual';
  const title = String(
    raw.title
    || (type === AUTO_SONG_TYPE ? (raw.provisional ? 'Auto Song (Provisional)' : 'Auto Song') : '')
  );
  const id = raw.id || `ytj-${startSec}-${endSec}-${index}-${stableHash(`${title}|${type}`)}`;
  const confidence = Number(raw.confidence);

  const item = {
    id,
    startSec,
    endSec,
    title,
    type,
    createdAt: raw.createdAt || raw.lastModified || meta.lastModified || now,
    updatedAt: raw.updatedAt || raw.lastModified || meta.lastModified || now,
  };

  if (type === AUTO_SONG_TYPE) {
    item.provisional = Boolean(raw.provisional);
    if (Number.isFinite(confidence)) item.confidence = clamp(confidence, 0, 1);
    if (raw.detectorVersion) item.detectorVersion = String(raw.detectorVersion);
    if (raw.source) item.source = String(raw.source);
    if (raw.sourceSegmentId) item.sourceSegmentId = String(raw.sourceSegmentId);
    if (raw.splitBy) item.splitBy = String(raw.splitBy);
    if (raw.medleySplit !== undefined) item.medleySplit = Boolean(raw.medleySplit);
    if (Number.isFinite(Number(raw.splitSourceSegmentIndex))) item.splitSourceSegmentIndex = Number(raw.splitSourceSegmentIndex);
    if (Number.isFinite(Number(raw.splitPartIndex))) item.splitPartIndex = Number(raw.splitPartIndex);
    if (Number.isFinite(Number(raw.splitPartCount))) item.splitPartCount = Number(raw.splitPartCount);
    if (Number.isFinite(Number(raw.boundaryConfidence))) item.boundaryConfidence = clamp(Number(raw.boundaryConfidence), 0, 1);
    if (Array.isArray(raw.boundaryReasons)) item.boundaryReasons = raw.boundaryReasons.map(String).filter(Boolean);
  }

  return item;
}

export function serializePlaylistItem(item) {
  const normalized = normalizePlaylistItem(item);
  const output = {
    id: normalized.id,
    start: secondsToTimeObject(normalized.startSec),
    end: secondsToTimeObject(normalized.endSec),
    title: normalized.title,
    schemaVersion: PLAYLIST_SCHEMA_VERSION,
    createdAt: normalized.createdAt,
    updatedAt: normalized.updatedAt,
  };

  if (normalized.type === AUTO_SONG_TYPE) {
    output.type = AUTO_SONG_TYPE;
    output.provisional = Boolean(normalized.provisional);
    if (Number.isFinite(normalized.confidence)) output.confidence = normalized.confidence;
    if (normalized.detectorVersion) output.detectorVersion = normalized.detectorVersion;
    if (normalized.source) output.source = normalized.source;
    if (normalized.sourceSegmentId) output.sourceSegmentId = normalized.sourceSegmentId;
    if (normalized.splitBy) output.splitBy = normalized.splitBy;
    if (normalized.medleySplit !== undefined) output.medleySplit = Boolean(normalized.medleySplit);
    if (Number.isFinite(normalized.splitSourceSegmentIndex)) output.splitSourceSegmentIndex = normalized.splitSourceSegmentIndex;
    if (Number.isFinite(normalized.splitPartIndex)) output.splitPartIndex = normalized.splitPartIndex;
    if (Number.isFinite(normalized.splitPartCount)) output.splitPartCount = normalized.splitPartCount;
    if (Number.isFinite(normalized.boundaryConfidence)) output.boundaryConfidence = normalized.boundaryConfidence;
    if (Array.isArray(normalized.boundaryReasons) && normalized.boundaryReasons.length) output.boundaryReasons = normalized.boundaryReasons;
  }

  return output;
}

export function normalizePlaylist(rawItems, meta = {}) {
  const source = Array.isArray(rawItems) ? rawItems : [];
  const ids = new Set();
  let rebuilt = !Array.isArray(rawItems);

  const items = source
    .map((rawItem, index) => {
      const item = normalizePlaylistItem(rawItem, index, meta);
      if (ids.has(item.id)) {
        item.id = `${item.id}-${index}`;
        rebuilt = true;
      }
      ids.add(item.id);

      const serialized = serializePlaylistItem(item);
      const oldSerialized = rawItem && typeof rawItem === 'object' ? rawItem : {};
      if (
        oldSerialized.schemaVersion !== PLAYLIST_SCHEMA_VERSION
        || !oldSerialized.id
        || oldSerialized.startSec !== undefined
        || oldSerialized.endSec !== undefined
        || oldSerialized.lastModified
        || oldSerialized.uploadTime
      ) {
        rebuilt = true;
      }
      if (JSON.stringify(serializeComparable(oldSerialized)) !== JSON.stringify(serializeComparable(serialized))) {
        rebuilt = true;
      }
      return item;
    })
    .filter(item => item.endSec >= item.startSec);

  return { items, rebuilt };
}

function serializeComparable(item) {
  if (!item || typeof item !== 'object') return {};
  const copy = { ...item };
  delete copy.lastModified;
  delete copy.uploadTime;
  return copy;
}

export function serializePlaylist(items) {
  return (Array.isArray(items) ? items : []).map(serializePlaylistItem);
}

export function buildPlaylistMeta(items, existingMeta = {}, patch = {}) {
  const now = new Date().toISOString();
  const existing = existingMeta && typeof existingMeta === 'object' ? existingMeta : {};
  const updatedAtList = (Array.isArray(items) ? items : [])
    .map(item => item.updatedAt)
    .filter(Boolean)
    .sort();

  return {
    ...existing,
    ...patch,
    schemaVersion: PLAYLIST_SCHEMA_VERSION,
    lastModified: patch.lastModified || updatedAtList.slice(-1)[0] || existing.lastModified || now,
    uploadTime: patch.uploadTime || existing.uploadTime || now,
    rebuiltAt: patch.rebuiltAt || existing.rebuiltAt || null,
  };
}

export function parsePlaylistText(text, { defaultDurationSec = 0 } = {}) {
  const items = [];
  const lines = String(text || '').split(/\r?\n/);
  const now = new Date().toISOString();

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    const tokens = line.split(/\s+/);
    if (!tokens.length || !isTimeToken(tokens[0])) continue;

    const startSec = parseTimeToken(tokens[0]);
    let endSec = startSec + Math.max(0, Number(defaultDurationSec) || 0);
    let titleStartIndex = 1;

    if (tokens[1] && isTimeToken(tokens[1])) {
      endSec = parseTimeToken(tokens[1]);
      titleStartIndex = 2;
    }

    items.push(normalizePlaylistItem({
      startSec,
      endSec: Math.max(startSec, endSec),
      title: tokens.slice(titleStartIndex).join(' '),
      createdAt: now,
      updatedAt: now,
    }, items.length));
  }

  return items;
}

export function exportPlaylistText(items) {
  return (Array.isArray(items) ? items : [])
    .map(item => `${formatSeconds(item.startSec)} ${formatSeconds(item.endSec)} ${item.title || ''}`.trim())
    .join('\n');
}
