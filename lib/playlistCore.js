export const PLAYLIST_SCHEMA_VERSION = 3;
export const AUTO_SONG_TYPE = 'auto-song';
const TIME_DECIMAL_PLACES = 3;
const TIME_EPSILON = 1e-6;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function roundTime(value, digits = TIME_DECIMAL_PLACES) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  const factor = 10 ** digits;
  return Math.round(Math.max(0, num) * factor) / factor;
}

function formatSecondToken(seconds) {
  const sec = roundTime(seconds);
  const whole = Math.floor(sec);
  const fraction = sec - whole;
  if (fraction <= TIME_EPSILON) return String(whole).padStart(2, '0');

  const fractionText = fraction
    .toFixed(TIME_DECIMAL_PLACES)
    .slice(1)
    .replace(/0+$/, '');
  return `${String(whole).padStart(2, '0')}${fractionText}`;
}

function stableHash(input) {
  const text = String(input || '');
  let hash = 5381;
  for (let i = 0; i < text.length; i += 1) {
    hash = ((hash << 5) + hash) ^ text.charCodeAt(i);
  }
  return (hash >>> 0).toString(36);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeLineDelimiter(delimiter) {
  const value = String(delimiter || '').replace(/\\t/g, '\t').replace(/\\n/g, '\n');
  return value && value !== 'auto' ? value : '';
}

function isLikelySeparator(text, customDelimiter = '') {
  let rest = String(text || '').trim();
  if (!rest) return true;

  if (customDelimiter) {
    rest = rest.replace(new RegExp(escapeRegExp(customDelimiter), 'g'), '').trim();
    if (!rest) return true;
  }

  return rest.replace(/[\s\-–—~～|,;，；:：/\\()[\]{}<>]+/g, '') === '';
}

function cleanImportedTitle(text, customDelimiter = '') {
  let title = String(text || '');
  if (customDelimiter) {
    title = title.replace(new RegExp(`^(?:\\s*${escapeRegExp(customDelimiter)}\\s*)+`), '');
  }
  return title
    .replace(/^[\s\-–—~～|,;，；:：/\\()[\]{}<>]+/, '')
    .trim();
}

function normalizeTimeTokenText(token) {
  return String(token || '').trim().replace(/\s*[:：]\s*/g, ':');
}

function getTimeSeparatorStyle(timeText) {
  const text = String(timeText || '');
  const styles = [];

  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== ':' && text[index] !== '：') continue;
    const hasSpaceBefore = index > 0 && /\s/.test(text[index - 1]);
    const hasSpaceAfter = index < text.length - 1 && /\s/.test(text[index + 1]);

    if (hasSpaceBefore && hasSpaceAfter) styles.push('spaced');
    else if (!hasSpaceBefore && !hasSpaceAfter) styles.push('tight');
    else styles.push('loose');
  }

  if (!styles.length) return 'none';
  if (styles.every(style => style === 'tight')) return 'tight';
  if (styles.every(style => style === 'spaced')) return 'spaced';
  return 'loose';
}

function isAmbiguousLooseThreePartTime(rawTime, parts, separatorStyle) {
  if (separatorStyle !== 'loose' || parts.length !== 3) return false;

  const minutePart = parts[1] || '';
  const secondPart = (parts[2] || '').split('.')[0];
  return minutePart.length < 2 || secondPart.length < 2;
}

function canUseAsEndTime(startMatch, endMatch, between, customDelimiter = '') {
  if (!isLikelySeparator(between, customDelimiter)) return false;
  if (endMatch.separatorStyle !== startMatch.separatorStyle) return false;
  return true;
}

function findTimeMatches(line) {
  const source = String(line || '');
  const strictMatches = [];
  const looseMatches = [];
  const collectMatches = (regex, target) => {
    let match;
    while ((match = regex.exec(source)) !== null) {
      const rawTime = match[2];
      const normalizedTime = normalizeTimeTokenText(rawTime);
      const parts = normalizedTime.split(':');
      const separatorStyle = getTimeSeparatorStyle(rawTime);
      if (isAmbiguousLooseThreePartTime(rawTime, parts, separatorStyle)) continue;
      target.push({
        text: normalizedTime,
        separatorStyle,
        index: match.index + match[1].length,
        end: match.index + match[0].length,
      });
    }
  };

  collectMatches(/(^|[^\p{L}\p{N}:：.])(\d{1,3}[:：]\d{1,2}(?:[:：]\d{1,2})?(?:\.\d+)?)(?![\p{L}\p{N}]|[:：]\S)/gu, strictMatches);
  collectMatches(/(^|[^\p{L}\p{N}:：.])(\d{1,3}\s*[:：]\s*\d{1,2}(?:\s*[:：]\s*\d{1,2})?(?:\.\d+)?)(?![\p{L}\p{N}]|[:：]\S)/gu, looseMatches);

  const matches = [...strictMatches];
  for (const loose of looseMatches) {
    const containsStrict = strictMatches.some(strict => (
      strict.index >= loose.index
      && strict.end <= loose.end
      && (strict.index !== loose.index || strict.end !== loose.end)
    ));
    const duplicatesStrict = strictMatches.some(strict => strict.index === loose.index && strict.end === loose.end);
    if (!containsStrict && !duplicatesStrict) matches.push(loose);
  }

  return matches.sort((a, b) => a.index - b.index || a.end - b.end);
}

export function toSeconds(value) {
  if (value && typeof value.getTotalseconds === 'function') {
    return roundTime(value.getTotalseconds());
  }

  if (typeof value === 'number') {
    return roundTime(value);
  }

  if (typeof value === 'string') {
    return parseTimeToken(value);
  }

  if (value && typeof value === 'object') {
    const h = Number(value.hours) || 0;
    const m = Number(value.minutes) || 0;
    const s = Number(value.seconds) || 0;
    return roundTime((h * 3600) + (m * 60) + s);
  }

  return 0;
}

export function secondsToTimeObject(seconds) {
  const sec = toSeconds(seconds);
  const h = Math.floor(sec / 3600);
  const remainderAfterHours = sec - (h * 3600);
  const m = Math.floor(remainderAfterHours / 60);
  const s = roundTime(remainderAfterHours - (m * 60));
  return {
    hours: h,
    minutes: m,
    seconds: s,
  };
}

export function formatSeconds(seconds) {
  const sec = toSeconds(seconds);
  const h = Math.floor(sec / 3600);
  const remainderAfterHours = sec - (h * 3600);
  const m = Math.floor(remainderAfterHours / 60);
  const s = remainderAfterHours - (m * 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${formatSecondToken(s)}`;
}

export function parseTimeToken(token) {
  const text = normalizeTimeTokenText(token);
  if (/^\d+(?:\.\d+)?$/.test(text)) return roundTime(text);

  const parts = text.split(':');
  const secondPattern = /^\d+(?:\.\d+)?$/;
  if (
    parts.length < 2
    || parts.length > 3
    || parts.some((part, index) => (index === parts.length - 1 ? !secondPattern.test(part) : !/^\d+$/.test(part)))
  ) {
    return 0;
  }

  const nums = parts.map((part, index) => (index === parts.length - 1 ? parseFloat(part) : Number(part)));
  if (nums.length === 2) {
    return roundTime((nums[0] * 60) + nums[1]);
  }
  return roundTime((nums[0] * 3600) + (nums[1] * 60) + nums[2]);
}

export function isTimeToken(token) {
  const parts = normalizeTimeTokenText(token).split(':');
  const secondPattern = /^\d+(?:\.\d+)?$/;
  return parts.length >= 2
    && parts.length <= 3
    && parts.every((part, index) => (index === parts.length - 1 ? secondPattern.test(part) : /^\d+$/.test(part)));
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

export function parsePlaylistText(text, { defaultDurationSec = 0, delimiter = 'auto' } = {}) {
  const items = [];
  const lines = String(text || '').split(/\r?\n/);
  const now = new Date().toISOString();
  const customDelimiter = normalizeLineDelimiter(delimiter);

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    const timeMatches = findTimeMatches(line);
    if (!timeMatches.length) continue;

    const startMatch = timeMatches[0];
    const startSec = parseTimeToken(startMatch.text);
    let endSec = startSec + Math.max(0, Number(defaultDurationSec) || 0);
    let titleStart = startMatch.end;

    for (let index = 1; index < timeMatches.length; index += 1) {
      const endMatch = timeMatches[index];
      const between = line.slice(startMatch.end, endMatch.index);
      if (!canUseAsEndTime(startMatch, endMatch, between, customDelimiter)) {
        if (!isLikelySeparator(between, customDelimiter)) break;
        continue;
      }
      endSec = parseTimeToken(endMatch.text);
      titleStart = endMatch.end;
      break;
    }

    items.push(normalizePlaylistItem({
      startSec,
      endSec: Math.max(startSec, endSec),
      title: cleanImportedTitle(line.slice(titleStart), customDelimiter),
      createdAt: now,
      updatedAt: now,
    }, items.length));
  }

  return items;
}

export function exportPlaylistText(items, {
  delimiter = ' ',
  timeDelimiter = null,
  titleDelimiter = null,
  numbering = 'none',
  numberingPad = 'none',
  numberingWidth = 2,
  roundToWholeSeconds = false,
} = {}) {
  const timeSeparator = String(timeDelimiter ?? delimiter ?? ' ');
  const titleSeparator = String(titleDelimiter ?? delimiter ?? ' ');
  const normalizedWidth = Math.max(1, Math.min(6, Math.floor(Number(numberingWidth) || 1)));
  const formatExportSeconds = (seconds) => formatSeconds(roundToWholeSeconds ? Math.round(toSeconds(seconds)) : seconds);
  const padNumber = (number) => {
    if (numberingPad === 'zero') return String(number).padStart(normalizedWidth, '0');
    if (numberingPad === 'space') return String(number).padStart(normalizedWidth, ' ');
    return String(number);
  };
  const formatPrefix = (index) => {
    const number = padNumber(index + 1);
    if (numbering === 'dot') return `${number}. `;
    if (numbering === 'dash') return `${number}- `;
    if (numbering === 'colon') return `${number}: `;
    if (numbering === 'paren') return `(${number}) `;
    return '';
  };

  return (Array.isArray(items) ? items : [])
    .map((item, index) => `${formatPrefix(index)}${formatExportSeconds(item.startSec)}${timeSeparator}${formatExportSeconds(item.endSec)}${titleSeparator}${item.title || ''}`.trimEnd())
    .join('\n');
}
