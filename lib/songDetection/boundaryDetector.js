import { clamp, roundNumber } from './common.js';

export const BOUNDARY_DETECTOR_VERSION = 'boundary-detector-v1';

export const BOUNDARY_DETECTOR_DEFAULTS = Object.freeze({
  minParentDurationSec: 240,
  minChildDurationSec: 95,
  minBoundaryGapSec: 90,
  edgeGuardSec: 25,
  compareWindowSec: 16,
  valleyWindowSec: 6,
  candidateStepSec: 1,
  minEvidenceCount: 3,
  minScore: 0.72,
  maxBoundariesPerSegment: 8,
  energyValleyRatio: 0.34,
  vocalDipRatio: 0.42,
  speechResetThreshold: 0.48,
  aedChangeThreshold: 0.26,
  structureChangeThreshold: 0.42,
  requireBoundaryEvidence: true,
  boundaryEvidenceReasons: ['energy-valley', 'vocal-dip', 'speech-reset'],
});

function toFiniteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function mean(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values) {
  const sorted = values
    .map(Number)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function normalizeFrame(frame) {
  const timeSec = Number(frame?.timeSec);
  if (!Number.isFinite(timeSec)) return null;
  return {
    timeSec,
    songProbability: clamp(toFiniteNumber(frame?.temporalHeadProbability ?? frame?.songProbability, 0), 0, 1),
    singing: clamp(toFiniteNumber(frame?.singingProbability ?? frame?.singingMean, 0), 0, 1),
    music: clamp(toFiniteNumber(frame?.musicProbability ?? frame?.musicMean, 0), 0, 1),
    speech: clamp(toFiniteNumber(frame?.speechProbability ?? frame?.speechMean, 0), 0, 1),
    audioRms: Math.max(0, toFiniteNumber(frame?.audioRms, 0)),
    audioPeak: Math.max(0, toFiniteNumber(frame?.audioPeak, 0)),
  };
}

function normalizeFrames(frames) {
  return (Array.isArray(frames) ? frames : [])
    .map(normalizeFrame)
    .filter(Boolean)
    .sort((a, b) => a.timeSec - b.timeSec);
}

function framesInRange(frames, startSec, endSec) {
  return frames.filter((frame) => frame.timeSec >= startSec && frame.timeSec <= endSec);
}

function summarizeFrames(frames) {
  return {
    count: frames.length,
    song: mean(frames.map((frame) => frame.songProbability)),
    singing: mean(frames.map((frame) => frame.singing)),
    music: mean(frames.map((frame) => frame.music)),
    speech: mean(frames.map((frame) => frame.speech)),
    rms: mean(frames.map((frame) => frame.audioRms)),
    peak: mean(frames.map((frame) => frame.audioPeak)),
  };
}

function featureDistance(left, right) {
  const diffs = [
    Math.abs(left.song - right.song),
    Math.abs(left.singing - right.singing),
    Math.abs(left.music - right.music),
    Math.abs(left.speech - right.speech),
    Math.abs(left.rms - right.rms) * 8,
    Math.abs(left.peak - right.peak) * 4,
  ];
  return clamp(mean(diffs), 0, 1);
}

function localMinimum(values, selector) {
  const nums = values.map(selector).filter(Number.isFinite);
  return nums.length ? Math.min(...nums) : 0;
}

function scoreBoundaryCandidate(frames, segment, timeSec, config) {
  const left = framesInRange(frames, timeSec - config.compareWindowSec, timeSec);
  const right = framesInRange(frames, timeSec, timeSec + config.compareWindowSec);
  const valley = framesInRange(frames, timeSec - (config.valleyWindowSec / 2), timeSec + (config.valleyWindowSec / 2));
  const segmentFrames = framesInRange(frames, segment.startSec, segment.endSec);

  if (left.length < 4 || right.length < 4 || valley.length < 2 || segmentFrames.length < 8) return null;

  const leftStats = summarizeFrames(left);
  const rightStats = summarizeFrames(right);
  const valleyStats = summarizeFrames(valley);
  const segmentEnergyRef = Math.max(0.0001, median(segmentFrames.map((frame) => frame.audioRms).filter((value) => value > 0)));
  const segmentSingingRef = Math.max(0.0001, median(segmentFrames.map((frame) => frame.singing).filter((value) => value > 0)));
  const valleyRms = localMinimum(valley, (frame) => frame.audioRms);
  const valleySinging = localMinimum(valley, (frame) => frame.singing);
  const distance = featureDistance(leftStats, rightStats);
  const aedChange = (
    Math.abs(leftStats.singing - rightStats.singing)
    + Math.abs(leftStats.music - rightStats.music)
    + Math.abs(leftStats.speech - rightStats.speech)
    + Math.abs(leftStats.song - rightStats.song)
  ) / 4;

  const reasons = [];
  let score = 0;

  if (valleyRms <= segmentEnergyRef * config.energyValleyRatio || valleyStats.rms <= segmentEnergyRef * (config.energyValleyRatio * 1.15)) {
    reasons.push('energy-valley');
    score += 0.3;
  }

  if (valleySinging <= segmentSingingRef * config.vocalDipRatio || valleyStats.singing <= segmentSingingRef * (config.vocalDipRatio * 1.1)) {
    reasons.push('vocal-dip');
    score += 0.22;
  }

  if (aedChange >= config.aedChangeThreshold) {
    reasons.push('aed-change');
    score += clamp(aedChange, 0, 0.38);
  }

  if (distance >= config.structureChangeThreshold) {
    reasons.push('structure-change');
    score += clamp(distance * 0.9, 0, 0.38);
  }

  if (
    valleyStats.speech >= config.speechResetThreshold
    || (Math.max(leftStats.speech, rightStats.speech) >= config.speechResetThreshold && valleyStats.singing < segmentSingingRef * 0.7)
  ) {
    reasons.push('speech-reset');
    score += 0.18;
  }

  return {
    timeSec: roundNumber(timeSec, 3),
    confidence: roundNumber(clamp(score, 0, 1), 3),
    reasons,
    evidenceCount: reasons.length,
    metrics: {
      valleyRms: roundNumber(valleyRms, 6),
      energyRef: roundNumber(segmentEnergyRef, 6),
      valleySinging: roundNumber(valleySinging, 4),
      singingRef: roundNumber(segmentSingingRef, 4),
      aedChange: roundNumber(aedChange, 4),
      structureChange: roundNumber(distance, 4),
      speechMean: roundNumber(valleyStats.speech, 4),
    },
  };
}

function findBoundaryCandidates(segment, frames, config) {
  const start = segment.startSec + Math.max(config.edgeGuardSec, config.minChildDurationSec);
  const end = segment.endSec - Math.max(config.edgeGuardSec, config.minChildDurationSec);
  if (end <= start) return [];

  const candidates = [];
  for (let timeSec = start; timeSec <= end; timeSec += config.candidateStepSec) {
    const candidate = scoreBoundaryCandidate(frames, segment, timeSec, config);
    if (!candidate) continue;
    if (candidate.evidenceCount < config.minEvidenceCount || candidate.confidence < config.minScore) continue;
    if (
      config.requireBoundaryEvidence
      && !config.boundaryEvidenceReasons.some((reason) => candidate.reasons.includes(reason))
    ) {
      continue;
    }
    candidates.push(candidate);
  }

  return candidates.sort((a, b) => b.confidence - a.confidence);
}

function pickBoundaries(candidates, segment, config) {
  const selected = [];
  for (const candidate of candidates) {
    if (selected.length >= config.maxBoundariesPerSegment) break;
    const tooCloseToSelected = selected.some((boundary) => Math.abs(boundary.timeSec - candidate.timeSec) < config.minBoundaryGapSec);
    if (tooCloseToSelected) continue;

    const proposed = [...selected, candidate].sort((a, b) => a.timeSec - b.timeSec);
    const points = [segment.startSec, ...proposed.map((boundary) => boundary.timeSec), segment.endSec];
    const allPartsValid = points.every((point, index) => index === 0 || (point - points[index - 1]) >= config.minChildDurationSec);
    if (!allPartsValid) continue;

    selected.push(candidate);
  }

  return selected.sort((a, b) => a.timeSec - b.timeSec);
}

function splitSegment(segment, boundaries, parentIndex) {
  if (!boundaries.length) {
    return [{ ...segment }];
  }

  const points = [segment.startSec, ...boundaries.map((boundary) => boundary.timeSec), segment.endSec];
  const parts = [];
  for (let index = 0; index < points.length - 1; index += 1) {
    const startSec = points[index];
    const endSec = points[index + 1];
    const boundary = index > 0 ? boundaries[index - 1] : boundaries[0];
    parts.push({
      ...segment,
      startSec: roundNumber(startSec, 3),
      endSec: roundNumber(endSec, 3),
      confidence: roundNumber(segment.confidence ?? boundary?.confidence ?? 0.5, 3),
      title: `Offline Auto Song #${parentIndex + 1}-${index + 1}`,
      splitBy: BOUNDARY_DETECTOR_VERSION,
      sourceSegmentId: `offline-auto-song-${parentIndex + 1}`,
      splitSourceSegmentIndex: parentIndex,
      splitPartIndex: index + 1,
      splitPartCount: points.length - 1,
      boundaryConfidence: boundary ? boundary.confidence : null,
      boundaryReasons: boundary ? boundary.reasons : [],
      medleySplit: true,
    });
  }
  return parts;
}

export function splitSongSegmentsByBoundaries(segments, analyses, options = {}) {
  const config = { ...BOUNDARY_DETECTOR_DEFAULTS, ...options };
  const frames = normalizeFrames(analyses);
  const outputSegments = [];
  const boundaries = [];

  for (let index = 0; index < (Array.isArray(segments) ? segments.length : 0); index += 1) {
    const segment = segments[index];
    const startSec = toFiniteNumber(segment?.startSec, 0);
    const endSec = Math.max(startSec, toFiniteNumber(segment?.endSec, startSec));
    const normalizedSegment = { ...segment, startSec, endSec };

    if ((endSec - startSec) < config.minParentDurationSec) {
      outputSegments.push(...splitSegment(normalizedSegment, [], index));
      continue;
    }

    const segmentFrames = framesInRange(frames, startSec, endSec);
    if (segmentFrames.length < 20) {
      outputSegments.push(...splitSegment(normalizedSegment, [], index));
      continue;
    }

    const candidates = findBoundaryCandidates(normalizedSegment, segmentFrames, config);
    const selected = pickBoundaries(candidates, normalizedSegment, config);
    boundaries.push(...selected.map((boundary) => ({
      ...boundary,
      sourceSegmentIndex: index,
      sourceStartSec: roundNumber(startSec, 3),
      sourceEndSec: roundNumber(endSec, 3),
    })));
    outputSegments.push(...splitSegment(normalizedSegment, selected, index));
  }

  return {
    segments: outputSegments.map((segment) => ({
      ...segment,
      startSec: roundNumber(segment.startSec, 3),
      endSec: roundNumber(segment.endSec, 3),
    })),
    boundaries,
    changed: outputSegments.length !== (Array.isArray(segments) ? segments.length : 0),
    detectorVersion: BOUNDARY_DETECTOR_VERSION,
    config,
  };
}
