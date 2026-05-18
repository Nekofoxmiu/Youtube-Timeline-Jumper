import { clamp, roundNumber, toSeconds } from './common.js';

export const EVENT_SEGMENT_STATES = Object.freeze({
  IDLE: 'idle',
  CANDIDATE: 'candidate',
  SONG: 'song',
  TAIL: 'tail',
});

export const EVENT_SEGMENT_DEFAULTS = Object.freeze({
  hopSeconds: 0.5,
  candidateMinDurationSec: 18,
  candidateMaxDurationSec: 75,
  minCandidateAnchors: 5,
  minCandidateAnchorSpanSec: 4,
  candidateGapSec: 8,
  tailStartRequiredWindows: 4,
  tailEndRequiredWindows: 4,
  tailMaxDurationSec: 24,
  tailSpeechGraceSec: 0,
  tailPaddingSec: 20,
  minSegmentDurationSec: 90,
  mergeGapSec: 8,
  provisionalMinDurationSec: 12,
});

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

export class EventSegmentTracker {
  constructor(config = {}) {
    this.config = {
      ...EVENT_SEGMENT_DEFAULTS,
      ...config,
    };
    this.reset();
  }

  reset() {
    this.rawFinalSegments = [];
    this.#resetActiveState();
  }

  #resetActiveState({ preserveLastTimeSec = false } = {}) {
    const previousLastTimeSec = this.lastTimeSec;
    this.state = EVENT_SEGMENT_STATES.IDLE;
    this.lastTimeSec = 0;
    this.activeStartSec = null;
    this.candidateStartSec = null;
    this.firstAnchorSec = null;
    this.lastAnchorSec = null;
    this.lastEvidenceSec = null;
    this.anchorCount = 0;
    this.tailStartSec = null;
    this.lowCount = 0;
    this.confidenceTotal = 0;
    this.confidenceCount = 0;
    this.lastDecision = 'idle';
    if (preserveLastTimeSec) {
      this.lastTimeSec = previousLastTimeSec;
    }
  }

  get isSong() {
    return this.state === EVENT_SEGMENT_STATES.SONG || this.state === EVENT_SEGMENT_STATES.TAIL;
  }

  finalizeAt(endSec) {
    if (this.state === EVENT_SEGMENT_STATES.SONG || this.state === EVENT_SEGMENT_STATES.TAIL) {
      return this.#finalizeActiveSegment(endSec, 'forced-finalize');
    }
    if (this.state === EVENT_SEGMENT_STATES.CANDIDATE) {
      if (this.#mergeCandidateIntoPrevious(endSec, 'forced-merge-candidate')) {
        return true;
      }
      this.#resetCandidate('forced-reset');
    }
    return false;
  }

  update(currentTimeSec, evidence = {}) {
    const now = toSeconds(currentTimeSec);
    this.lastTimeSec = now;

    const hasAnchor = Boolean(evidence.hasSingingAnchor);
    const hasRecentAnchor = Boolean(evidence.hasRecentAnchor);
    const hasMusicSustain = Boolean(evidence.hasMusicSustain);
    const speechDominant = Boolean(evidence.speechDominant);
    const confidence = clamp(Number(evidence.songProbability ?? evidence.confidence) || 0, 0, 1);
    const sustain = hasAnchor || (hasRecentAnchor && hasMusicSustain && !speechDominant);

    if (hasAnchor) {
      this.lastAnchorSec = now;
      if (this.firstAnchorSec === null) this.firstAnchorSec = now;
    }
    if (hasAnchor || hasMusicSustain) {
      this.lastEvidenceSec = now;
    }

    let transitioned = false;
    let decision = 'idle';

    if (this.state === EVENT_SEGMENT_STATES.IDLE) {
      if (hasAnchor) {
        this.#startCandidate(now, evidence.startSecOverride, confidence);
        decision = 'candidate-start';
        transitioned = true;
      }
    } else if (this.state === EVENT_SEGMENT_STATES.CANDIDATE) {
      if (hasAnchor) {
        this.anchorCount += 1;
        this.confidenceTotal += confidence;
        this.confidenceCount += 1;
      }

      const candidateDuration = now - toSeconds(this.candidateStartSec);
      const anchorSpan = this.firstAnchorSec !== null && this.lastAnchorSec !== null
        ? this.lastAnchorSec - this.firstAnchorSec
        : 0;
      const stale = this.lastEvidenceSec !== null
        && (now - this.lastEvidenceSec) > this.config.candidateGapSec;

      if (speechDominant && !hasAnchor) {
        this.#resetCandidate('candidate-reject-speech');
        decision = 'candidate-reject-speech';
        transitioned = true;
      } else if (stale || candidateDuration > this.config.candidateMaxDurationSec) {
        this.#resetCandidate(stale ? 'candidate-reject-stale' : 'candidate-reject-timeout');
        decision = stale ? 'candidate-reject-stale' : 'candidate-reject-timeout';
        transitioned = true;
      } else if (
        candidateDuration >= this.config.candidateMinDurationSec
        && this.anchorCount >= this.config.minCandidateAnchors
        && anchorSpan >= this.config.minCandidateAnchorSpanSec
      ) {
        this.#promoteCandidate();
        decision = 'song-start';
        transitioned = true;
      } else {
        decision = 'candidate-hold';
      }
    } else if (this.state === EVENT_SEGMENT_STATES.SONG) {
      this.#accumulateConfidence(confidence);

      if (hasAnchor || sustain) {
        this.lowCount = 0;
        decision = hasAnchor ? 'song-anchor' : 'song-sustain';
      } else {
        this.lowCount += 1;
        decision = 'song-low';
        if (this.lowCount >= this.config.tailStartRequiredWindows) {
          this.state = EVENT_SEGMENT_STATES.TAIL;
          this.tailStartSec = now;
          this.lowCount = 0;
          decision = 'tail-start';
          transitioned = true;
        }
      }
    } else if (this.state === EVENT_SEGMENT_STATES.TAIL) {
      this.#accumulateConfidence(confidence * 0.5);

      if (hasAnchor) {
        this.state = EVENT_SEGMENT_STATES.SONG;
        this.tailStartSec = null;
        this.lowCount = 0;
        decision = 'tail-return-song';
        transitioned = true;
      } else {
        const tailDuration = this.tailStartSec === null ? 0 : now - this.tailStartSec;
        const speechWithinGrace = speechDominant
          && tailDuration < this.config.tailSpeechGraceSec
          && hasRecentAnchor
          && hasMusicSustain;
        const canExtend = hasRecentAnchor && hasMusicSustain && !speechDominant
          && tailDuration < this.config.tailMaxDurationSec;
        if (canExtend || speechWithinGrace) {
          this.lowCount = 0;
          decision = speechWithinGrace ? 'tail-speech-grace' : 'tail-hold';
        } else {
          this.lowCount += 1;
          decision = speechDominant ? 'tail-speech' : 'tail-low';
          if (tailDuration >= this.config.tailMaxDurationSec || this.lowCount >= this.config.tailEndRequiredWindows) {
            const anchorEnd = this.lastAnchorSec !== null
              ? this.lastAnchorSec + this.config.tailPaddingSec
              : now;
            const endSec = Math.min(now, anchorEnd);
            transitioned = this.#finalizeActiveSegment(endSec, 'song-finalize') || transitioned;
            decision = 'song-finalize';
          }
        }
      }
    }

    this.lastDecision = decision;
    return {
      transitioned,
      decision,
      state: this.state,
    };
  }

  getFinalSegments() {
    return mergeSegments(this.rawFinalSegments, {
      maxGapSec: this.config.mergeGapSec,
      minSegmentDurationSec: this.config.minSegmentDurationSec,
    });
  }

  getProvisionalSegments(currentTimeSec) {
    if (this.state !== EVENT_SEGMENT_STATES.SONG && this.state !== EVENT_SEGMENT_STATES.TAIL) return [];
    if (this.activeStartSec === null) return [];

    const provisional = normalizeSegment(
      {
        startSec: this.activeStartSec,
        endSec: Math.max(this.activeStartSec, toSeconds(currentTimeSec)),
        confidence: this.confidenceCount > 0 ? this.confidenceTotal / this.confidenceCount : 0.5,
      },
      true
    );
    if ((provisional.endSec - provisional.startSec) < this.config.provisionalMinDurationSec) return [];
    return [provisional];
  }

  getDebugState() {
    return {
      state: this.state,
      isSong: this.isSong,
      activeStartSec: this.activeStartSec === null ? null : roundNumber(this.activeStartSec, 3),
      candidateStartSec: this.candidateStartSec === null ? null : roundNumber(this.candidateStartSec, 3),
      firstAnchorSec: this.firstAnchorSec === null ? null : roundNumber(this.firstAnchorSec, 3),
      lastAnchorSec: this.lastAnchorSec === null ? null : roundNumber(this.lastAnchorSec, 3),
      anchorCount: this.anchorCount,
      lowCount: this.lowCount,
      tailStartSec: this.tailStartSec === null ? null : roundNumber(this.tailStartSec, 3),
      lastDecision: this.lastDecision,
    };
  }

  #startCandidate(now, startSecOverride, confidence) {
    const requestedStartSec = Number(startSecOverride);
    const startSec = Number.isFinite(requestedStartSec)
      ? Math.min(now, Math.max(0, requestedStartSec))
      : now;
    this.state = EVENT_SEGMENT_STATES.CANDIDATE;
    this.candidateStartSec = startSec;
    this.firstAnchorSec = now;
    this.lastAnchorSec = now;
    this.lastEvidenceSec = now;
    this.anchorCount = 1;
    this.lowCount = 0;
    this.confidenceTotal = confidence;
    this.confidenceCount = 1;
  }

  #promoteCandidate() {
    this.state = EVENT_SEGMENT_STATES.SONG;
    this.activeStartSec = this.candidateStartSec;
    this.tailStartSec = null;
    this.lowCount = 0;
  }

  #resetCandidate(decision) {
    this.state = EVENT_SEGMENT_STATES.IDLE;
    this.candidateStartSec = null;
    this.firstAnchorSec = null;
    this.lastAnchorSec = null;
    this.lastEvidenceSec = null;
    this.anchorCount = 0;
    this.lowCount = 0;
    this.confidenceTotal = 0;
    this.confidenceCount = 0;
    this.lastDecision = decision;
  }

  #accumulateConfidence(confidence) {
    this.confidenceTotal += clamp(Number(confidence) || 0, 0, 1);
    this.confidenceCount += 1;
  }

  #finalizeActiveSegment(endSec, decision) {
    if (this.activeStartSec === null) {
      this.#resetActiveState({ preserveLastTimeSec: true });
      this.lastDecision = decision;
      return false;
    }

    const startSec = toSeconds(this.activeStartSec);
    const boundedEnd = Math.max(startSec, toSeconds(endSec));
    const duration = boundedEnd - startSec;
    let emitted = false;

    if (duration >= this.config.minSegmentDurationSec) {
      this.rawFinalSegments.push({
        startSec,
        endSec: boundedEnd,
        confidence: this.confidenceCount > 0 ? this.confidenceTotal / this.confidenceCount : 0.5,
      });
      emitted = true;
    }

    this.#resetActiveState({ preserveLastTimeSec: true });
    this.lastDecision = decision;
    return emitted;
  }

  #mergeCandidateIntoPrevious(endSec, decision) {
    if (!this.rawFinalSegments.length || this.candidateStartSec === null) return false;

    const previous = this.rawFinalSegments[this.rawFinalSegments.length - 1];
    const candidateStart = toSeconds(this.candidateStartSec);
    const boundedEnd = Math.max(candidateStart, toSeconds(endSec));
    const candidateDuration = boundedEnd - candidateStart;
    const gap = candidateStart - toSeconds(previous.endSec);
    const anchorSpan = this.firstAnchorSec !== null && this.lastAnchorSec !== null
      ? this.lastAnchorSec - this.firstAnchorSec
      : 0;

    const canMerge = gap >= 0
      && gap <= this.config.mergeGapSec
      && candidateDuration >= this.config.provisionalMinDurationSec
      && this.anchorCount >= this.config.minCandidateAnchors
      && anchorSpan >= this.config.minCandidateAnchorSpanSec;
    if (!canMerge) return false;

    const previousDuration = Math.max(0.001, toSeconds(previous.endSec) - toSeconds(previous.startSec));
    const candidateConfidence = this.confidenceCount > 0
      ? this.confidenceTotal / this.confidenceCount
      : previous.confidence;
    const combinedDuration = previousDuration + candidateDuration;
    previous.endSec = Math.max(previous.endSec, boundedEnd);
    previous.confidence = roundNumber(
      ((previous.confidence * previousDuration) + (candidateConfidence * candidateDuration)) / combinedDuration,
      3
    );

    this.#resetActiveState({ preserveLastTimeSec: true });
    this.lastDecision = decision;
    return true;
  }
}
