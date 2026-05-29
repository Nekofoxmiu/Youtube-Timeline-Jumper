import { roundNumber } from './common.js';

export const STREAMING_TARGET_SAMPLE_RATE = 16000;
export const DEFAULT_STREAMING_CHUNK_SEC = 30 * 60;
export const DEFAULT_STREAMING_OVERLAP_SEC = 120;

function concatFloat32(left, right) {
  if (!left || !left.length) return right ? right.slice() : new Float32Array(0);
  if (!right || !right.length) return left.slice();
  const output = new Float32Array(left.length + right.length);
  output.set(left, 0);
  output.set(right, left.length);
  return output;
}

function clampSampleToInt16(value) {
  const sample = Math.max(-1, Math.min(1, Number(value) || 0));
  return sample < 0 ? Math.round(sample * 32768) : Math.round(sample * 32767);
}

class Int16RangeBuffer {
  constructor() {
    this.parts = [];
    this.startIndex = 0;
    this.length = 0;
  }

  get endIndex() {
    return this.startIndex + this.length;
  }

  append(samples) {
    if (!samples || !samples.length) return;
    this.parts.push(samples);
    this.length += samples.length;
    if (this.parts.length > 2048) this.compact();
  }

  compact() {
    if (this.parts.length <= 1) return;
    const merged = new Int16Array(this.length);
    let offset = 0;
    for (const part of this.parts) {
      merged.set(part, offset);
      offset += part.length;
    }
    this.parts = [merged];
  }

  sliceRange(absStart, absEnd) {
    const start = Math.max(this.startIndex, Math.floor(absStart));
    const end = Math.min(this.endIndex, Math.ceil(absEnd));
    const count = Math.max(0, end - start);
    const output = new Int16Array(count);
    if (!count) return output;

    let writeOffset = 0;
    let partStart = this.startIndex;
    for (const part of this.parts) {
      const partEnd = partStart + part.length;
      const copyStart = Math.max(start, partStart);
      const copyEnd = Math.min(end, partEnd);
      if (copyEnd > copyStart) {
        output.set(
          part.subarray(copyStart - partStart, copyEnd - partStart),
          writeOffset
        );
        writeOffset += copyEnd - copyStart;
      }
      partStart = partEnd;
      if (partStart >= end) break;
    }
    return output;
  }

  dropBefore(absIndex) {
    const nextStart = Math.max(this.startIndex, Math.min(this.endIndex, Math.floor(absIndex)));
    let dropCount = nextStart - this.startIndex;
    if (dropCount <= 0) return;

    while (this.parts.length && dropCount >= this.parts[0].length) {
      dropCount -= this.parts[0].length;
      this.length -= this.parts[0].length;
      this.startIndex += this.parts[0].length;
      this.parts.shift();
    }

    if (dropCount > 0 && this.parts.length) {
      this.parts[0] = this.parts[0].subarray(dropCount);
      this.length -= dropCount;
      this.startIndex += dropCount;
    }
  }

  clear() {
    this.parts = [];
    this.startIndex = 0;
    this.length = 0;
  }
}

export class StreamingFrameBuilder {
  constructor({
    sourceSampleRate,
    targetSampleRate = STREAMING_TARGET_SAMPLE_RATE,
    chunkSec = DEFAULT_STREAMING_CHUNK_SEC,
    overlapSec = DEFAULT_STREAMING_OVERLAP_SEC,
    timeOffsetSec = 0,
    timeScale = 1,
    analyzeInt16Chunk,
  } = {}) {
    this.sourceSampleRate = Math.max(8000, Number(sourceSampleRate) || 48000);
    this.targetSampleRate = Math.max(8000, Number(targetSampleRate) || STREAMING_TARGET_SAMPLE_RATE);
    this.chunkSamples = Math.max(this.targetSampleRate, Math.round((Number(chunkSec) || DEFAULT_STREAMING_CHUNK_SEC) * this.targetSampleRate));
    this.overlapSamples = Math.max(0, Math.round((Number(overlapSec) || DEFAULT_STREAMING_OVERLAP_SEC) * this.targetSampleRate));
    this.timeOffsetSec = Number.isFinite(Number(timeOffsetSec)) ? Number(timeOffsetSec) : 0;
    this.timeScale = this.#normalizeTimeScale(timeScale);
    this.timeScalePoints = [{ targetIndex: 0, timelineSec: this.timeOffsetSec, timeScale: this.timeScale }];
    this.analyzeInt16Chunk = analyzeInt16Chunk;

    this.sourceBuffer = new Float32Array(0);
    this.sourceStartIndex = 0;
    this.nextTargetIndex = 0;
    this.pcm = new Int16RangeBuffer();
    this.nextFlushEndIndex = this.chunkSamples;
    this.lastProcessedEndIndex = 0;
    this.lastEmittedFrameTimeSec = null;
    this.processing = false;
  }

  reset({ timeOffsetSec = this.timeOffsetSec } = {}) {
    this.timeOffsetSec = Number.isFinite(Number(timeOffsetSec)) ? Number(timeOffsetSec) : 0;
    this.timeScalePoints = [{ targetIndex: 0, timelineSec: this.timeOffsetSec, timeScale: this.timeScale }];
    this.sourceBuffer = new Float32Array(0);
    this.sourceStartIndex = 0;
    this.nextTargetIndex = 0;
    this.pcm.clear();
    this.nextFlushEndIndex = this.chunkSamples;
    this.lastProcessedEndIndex = 0;
    this.lastEmittedFrameTimeSec = null;
    this.processing = false;
  }

  getBufferedPcmSec() {
    return this.pcm.length / this.targetSampleRate;
  }

  getBufferedPcmBytes() {
    return this.pcm.length * 2;
  }

  getProgressSummary() {
    const retainedSec = this.getBufferedPcmSec();
    const totalCapturedSec = this.pcm.endIndex / this.targetSampleRate;
    const totalAnalyzedSec = this.lastProcessedEndIndex / this.targetSampleRate;
    const chunkProgressStartIndex = this.lastProcessedEndIndex;
    const chunkProgressEndIndex = Math.min(this.nextFlushEndIndex, this.pcm.endIndex);
    const chunkProgressSec = Math.max(0, Math.min(
      this.chunkSamples / this.targetSampleRate,
      (this.pcm.endIndex - chunkProgressStartIndex) / this.targetSampleRate
    ));
    const chunkRemainingSec = Math.max(0, (this.nextFlushEndIndex - this.pcm.endIndex) / this.targetSampleRate);
    const videoChunkProgressSec = Math.max(0, this.#targetIndexToTimelineSec(chunkProgressEndIndex) - this.#targetIndexToTimelineSec(chunkProgressStartIndex));
    const videoTotalCapturedSec = Math.max(0, this.#targetIndexToTimelineSec(this.pcm.endIndex) - this.timeOffsetSec);
    const videoTotalAnalyzedSec = Math.max(0, this.#targetIndexToTimelineSec(this.lastProcessedEndIndex) - this.timeOffsetSec);
    return {
      bufferedSec: retainedSec,
      retainedSec,
      chunkProgressSec,
      chunkRemainingSec,
      totalCapturedSec,
      totalAnalyzedSec,
      bufferedBytes: this.getBufferedPcmBytes(),
      chunkSec: this.chunkSamples / this.targetSampleRate,
      overlapSec: this.overlapSamples / this.targetSampleRate,
      playbackRate: this.timeScale,
      videoChunkProgressSec,
      videoTotalCapturedSec,
      videoTotalAnalyzedSec,
    };
  }

  setTimeOffsetSec(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) return;
    const delta = num - this.timeOffsetSec;
    this.timeOffsetSec = num;
    if (!this.timeScalePoints.length) {
      this.timeScalePoints = [{ targetIndex: 0, timelineSec: this.timeOffsetSec, timeScale: this.timeScale }];
      return;
    }
    for (const point of this.timeScalePoints) {
      point.timelineSec += delta;
    }
  }

  setTimeScale(value) {
    const nextTimeScale = this.#normalizeTimeScale(value);
    if (Math.abs(nextTimeScale - this.timeScale) <= 0.0001) return;

    const anchorIndex = this.#normalizeTargetIndex(this.pcm?.endIndex ?? this.nextTargetIndex);
    const anchorTimelineSec = this.#targetIndexToTimelineSec(anchorIndex);
    this.timeScale = nextTimeScale;

    const lastPoint = this.timeScalePoints[this.timeScalePoints.length - 1];
    if (lastPoint && Math.abs(lastPoint.targetIndex - anchorIndex) <= 1) {
      lastPoint.targetIndex = anchorIndex;
      lastPoint.timelineSec = anchorTimelineSec;
      lastPoint.timeScale = nextTimeScale;
      return;
    }
    this.timeScalePoints.push({
      targetIndex: anchorIndex,
      timelineSec: anchorTimelineSec,
      timeScale: nextTimeScale,
    });
  }

  #normalizeTimeScale(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) return 1;
    return Math.max(0.25, Math.min(4, num));
  }

  #normalizeTargetIndex(value) {
    const num = Number(value);
    return Number.isFinite(num) ? Math.max(0, Math.floor(num)) : 0;
  }

  #targetIndexToTimelineSec(targetIndex) {
    const index = this.#normalizeTargetIndex(targetIndex);
    if (!this.timeScalePoints.length) {
      return this.timeOffsetSec + (index / this.targetSampleRate) * this.timeScale;
    }

    let point = this.timeScalePoints[0];
    for (const candidate of this.timeScalePoints) {
      if (candidate.targetIndex <= index) {
        point = candidate;
      } else {
        break;
      }
    }
    return point.timelineSec + ((index - point.targetIndex) / this.targetSampleRate) * point.timeScale;
  }

  #pruneTimeScalePoints() {
    if (this.timeScalePoints.length <= 2) return;
    const retainedStartIndex = this.pcm.startIndex;
    let keepFrom = 0;
    for (let i = 0; i < this.timeScalePoints.length; i += 1) {
      if (this.timeScalePoints[i].targetIndex <= retainedStartIndex) {
        keepFrom = i;
      } else {
        break;
      }
    }
    if (keepFrom > 0) this.timeScalePoints.splice(0, keepFrom);
  }

  pushFloat32(samples) {
    if (!samples || !samples.length) return;
    this.sourceBuffer = concatFloat32(this.sourceBuffer, samples);
    this.#produceTargetSamples();
  }

  async flushReadyChunks({ force = false, onProgress = null } = {}) {
    if (this.processing) return [];
    if (typeof this.analyzeInt16Chunk !== 'function') {
      throw new Error('StreamingFrameBuilder requires analyzeInt16Chunk callback.');
    }

    this.processing = true;
    try {
      const output = [];
      while (this.pcm.endIndex >= this.nextFlushEndIndex) {
        const frames = await this.#processRange(
          Math.max(0, this.nextFlushEndIndex - this.chunkSamples - (this.lastProcessedEndIndex > 0 ? this.overlapSamples : 0)),
          this.nextFlushEndIndex,
          { onProgress }
        );
        output.push(...frames);
        this.lastProcessedEndIndex = this.nextFlushEndIndex;
        this.pcm.dropBefore(Math.max(0, this.nextFlushEndIndex - this.overlapSamples));
        this.#pruneTimeScalePoints();
        this.nextFlushEndIndex += this.chunkSamples;
      }

      if (force && this.pcm.endIndex > this.lastProcessedEndIndex) {
        const processStart = Math.max(0, this.lastProcessedEndIndex - this.overlapSamples);
        const frames = await this.#processRange(processStart, this.pcm.endIndex, { onProgress });
        output.push(...frames);
        this.lastProcessedEndIndex = this.pcm.endIndex;
        this.pcm.dropBefore(this.pcm.endIndex);
        this.#pruneTimeScalePoints();
      }

      return output;
    } finally {
      this.processing = false;
    }
  }

  #produceTargetSamples() {
    const sourceEndIndex = this.sourceStartIndex + this.sourceBuffer.length;
    const produced = [];

    while (true) {
      const sourcePos = (this.nextTargetIndex * this.sourceSampleRate) / this.targetSampleRate;
      if (sourcePos + 1 >= sourceEndIndex) break;
      if (sourcePos < this.sourceStartIndex) {
        this.nextTargetIndex += 1;
        continue;
      }

      const localPos = sourcePos - this.sourceStartIndex;
      const left = Math.floor(localPos);
      const right = Math.min(this.sourceBuffer.length - 1, left + 1);
      const alpha = localPos - left;
      const sample = (this.sourceBuffer[left] * (1 - alpha)) + (this.sourceBuffer[right] * alpha);
      produced.push(clampSampleToInt16(sample));
      this.nextTargetIndex += 1;
    }

    if (produced.length) {
      this.pcm.append(Int16Array.from(produced));
    }

    const keepFromSourceIndex = Math.max(
      this.sourceStartIndex,
      Math.floor((this.nextTargetIndex * this.sourceSampleRate) / this.targetSampleRate) - 1
    );
    const drop = keepFromSourceIndex - this.sourceStartIndex;
    if (drop > 0) {
      this.sourceBuffer = this.sourceBuffer.subarray(drop);
      this.sourceStartIndex += drop;
    }
  }

  async #processRange(absStart, absEnd, { onProgress = null } = {}) {
    const boundedStart = Math.max(this.pcm.startIndex, Math.floor(absStart));
    const boundedEnd = Math.min(this.pcm.endIndex, Math.ceil(absEnd));
    if (boundedEnd <= boundedStart) return [];

    const pcm16 = this.pcm.sliceRange(boundedStart, boundedEnd);
    const timeOffsetSec = this.timeOffsetSec + (boundedStart / this.targetSampleRate);
    const frames = await this.analyzeInt16Chunk(pcm16, {
      timeOffsetSec,
      onProgress,
      sampleRate: this.targetSampleRate,
      sourceRangeId: `${boundedStart}:${boundedEnd}`,
    });
    const deduped = [];
    for (const frame of Array.isArray(frames) ? frames : []) {
      const rawTimeSec = Number(frame?.timeSec);
      if (!Number.isFinite(rawTimeSec)) continue;
      const frameTargetIndex = boundedStart + ((rawTimeSec - timeOffsetSec) * this.targetSampleRate);
      const timeSec = this.#targetIndexToTimelineSec(frameTargetIndex);
      if (this.lastEmittedFrameTimeSec !== null && timeSec <= this.lastEmittedFrameTimeSec + 0.001) {
        continue;
      }
      this.lastEmittedFrameTimeSec = timeSec;
      deduped.push({ ...frame, timeSec: roundNumber(timeSec, 3) });
    }
    return deduped;
  }
}
