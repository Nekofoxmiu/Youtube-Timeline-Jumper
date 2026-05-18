import { clamp, roundNumber, toSeconds } from './common.js';

export const SEGMENT_DEFAULTS = {
  hopSeconds: 0.5,
  startRequiredWindows: 3,
  endRequiredWindows: 3,
  startProbabilityThreshold: 0.6,
  endProbabilityThreshold: 0.42,
  minSegmentDurationSec: 8,
  mergeGapSec: 4,
  provisionalMinDurationSec: 2,
};

function normalizeSegment(segment, provisional = false) {
  const startSec = toSeconds(segment.startSec);
  const endSec = Math.max(startSec, toSeconds(segment.endSec));
  return {
    startSec: roundNumber(startSec, 3),
    endSec: roundNumber(endSec, 3),
    confidence: roundNumber(clamp(Number(segment.confidence) || 0, 0, 1), 3),
    provisional: Boolean(provisional),
  };
}

function mergeSegments(segments, { maxGapSec, minSegmentDurationSec }) {
  if (!Array.isArray(segments) || segments.length === 0) return [];

  const sorted = [...segments]
    .map((segment) => normalizeSegment(segment, false))
    .sort((a, b) => a.startSec - b.startSec);

  const merged = [];
  for (const segment of sorted) {
    if (!merged.length) {
      merged.push({ ...segment });
      continue;
    }

    const previous = merged[merged.length - 1];
    const gap = segment.startSec - previous.endSec;
    if (gap <= maxGapSec) {
      const previousDuration = Math.max(0.001, previous.endSec - previous.startSec);
      const currentDuration = Math.max(0.001, segment.endSec - segment.startSec);
      const combinedDuration = previousDuration + currentDuration;

      previous.endSec = Math.max(previous.endSec, segment.endSec);
      previous.confidence = roundNumber(
        ((previous.confidence * previousDuration) + (segment.confidence * currentDuration)) / combinedDuration,
        3
      );
      continue;
    }

    merged.push({ ...segment });
  }

  return merged.filter((segment) => (segment.endSec - segment.startSec) >= minSegmentDurationSec);
}

export class SongSegmentTracker {
  constructor(config = {}) {
    this.config = {
      ...SEGMENT_DEFAULTS,
      ...config,
    };
    this.reset();
  }

  reset() {
    this.isSong = false;
    this.highCount = 0;
    this.lowCount = 0;
    this.activeStartSec = null;
    this.activeConfidenceTotal = 0;
    this.activeConfidenceCount = 0;
    this.rawFinalSegments = [];
    this.lastTimeSec = 0;
  }

  finalizeAt(endSec) {
    return this.#finalizeActiveSegment(endSec);
  }

  update(currentTimeSec, songProbability, options = {}) {
    const probability = clamp(Number(songProbability) || 0, 0, 1);
    const now = toSeconds(currentTimeSec);
    this.lastTimeSec = now;

    if (probability >= this.config.startProbabilityThreshold) {
      this.highCount += 1;
    } else {
      this.highCount = 0;
    }

    if (probability <= this.config.endProbabilityThreshold) {
      this.lowCount += 1;
    } else {
      this.lowCount = 0;
    }

    let hasTransition = false;

    if (!this.isSong) {
      if (this.highCount >= this.config.startRequiredWindows) {
        const requestedStartSec = Number(options.startSecOverride);
        const computedStartSec = Math.max(
          0,
          now - ((this.config.startRequiredWindows - 1) * this.config.hopSeconds)
        );
        this.isSong = true;
        this.activeStartSec = Number.isFinite(requestedStartSec)
          ? Math.min(computedStartSec, Math.max(0, requestedStartSec))
          : computedStartSec;
        this.activeConfidenceTotal = probability;
        this.activeConfidenceCount = 1;
        this.lowCount = 0;
        hasTransition = true;
      }
      return hasTransition;
    }

    this.activeConfidenceTotal += probability;
    this.activeConfidenceCount += 1;

    if (this.lowCount >= this.config.endRequiredWindows) {
      const segmentEnd = Math.max(
        toSeconds(this.activeStartSec),
        now - ((this.config.endRequiredWindows - 1) * this.config.hopSeconds)
      );
      hasTransition = this.#finalizeActiveSegment(segmentEnd) || hasTransition;
    }

    return hasTransition;
  }

  getFinalSegments() {
    return mergeSegments(this.rawFinalSegments, {
      maxGapSec: this.config.mergeGapSec,
      minSegmentDurationSec: this.config.minSegmentDurationSec,
    });
  }

  getProvisionalSegments(currentTimeSec) {
    if (!this.isSong || this.activeStartSec === null) return [];

    const provisionalSegment = normalizeSegment(
      {
        startSec: this.activeStartSec,
        endSec: Math.max(this.activeStartSec, toSeconds(currentTimeSec)),
        confidence: this.activeConfidenceCount > 0
          ? this.activeConfidenceTotal / this.activeConfidenceCount
          : 0.5,
      },
      true
    );

    const duration = provisionalSegment.endSec - provisionalSegment.startSec;
    if (duration < this.config.provisionalMinDurationSec) return [];
    return [provisionalSegment];
  }

  #finalizeActiveSegment(endSec) {
    if (!this.isSong || this.activeStartSec === null) return false;

    const startSec = toSeconds(this.activeStartSec);
    const boundedEnd = Math.max(startSec, toSeconds(endSec));
    const duration = boundedEnd - startSec;

    if (duration >= this.config.minSegmentDurationSec) {
      const confidence = this.activeConfidenceCount > 0
        ? this.activeConfidenceTotal / this.activeConfidenceCount
        : 0.5;
      this.rawFinalSegments.push({
        startSec,
        endSec: boundedEnd,
        confidence,
      });
    }

    this.isSong = false;
    this.highCount = 0;
    this.lowCount = 0;
    this.activeStartSec = null;
    this.activeConfidenceTotal = 0;
    this.activeConfidenceCount = 0;
    return true;
  }
}
