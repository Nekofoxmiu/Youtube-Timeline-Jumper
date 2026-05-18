export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function toSeconds(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  return Math.max(0, num);
}

export function roundNumber(value, digits = 3) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  const factor = 10 ** digits;
  return Math.round(num * factor) / factor;
}

export function normalizeDetectionStatus(status) {
  const key = String(status || '').trim().toLowerCase();
  if (key === 'listening') return 'Listening';
  if (key === 'detecting') return 'Detecting';
  if (key === 'stopped') return 'Stopped';
  if (key === 'error') return 'Error';
  return 'Idle';
}

export const DETECTOR_MODES = {
  FIRERED_AED: 'firered-aed',
  HEURISTIC: 'heuristic',
};

export function normalizeDetectorMode(mode, fallback = DETECTOR_MODES.FIRERED_AED) {
  const key = String(mode || '').trim().toLowerCase();
  if (key === DETECTOR_MODES.FIRERED_AED) return DETECTOR_MODES.FIRERED_AED;
  if (key === DETECTOR_MODES.HEURISTIC) return DETECTOR_MODES.HEURISTIC;
  return fallback;
}
