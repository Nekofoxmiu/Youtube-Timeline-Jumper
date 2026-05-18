import { clamp } from './common.js';

export const HEURISTIC_DETECTOR_VERSION = 'heuristic-v1';

function extractAudioFeatures(timeDomainBuffer, frequencyDomainBuffer, sampleRate) {
  let energySum = 0;
  let zeroCrossingCount = 0;
  let previousSign = 0;

  for (let i = 0; i < timeDomainBuffer.length; i += 1) {
    const sample = timeDomainBuffer[i];
    energySum += sample * sample;
    const currentSign = sample >= 0 ? 1 : -1;
    if (i > 0 && currentSign !== previousSign) zeroCrossingCount += 1;
    previousSign = currentSign;
  }

  const rms = Math.sqrt(energySum / Math.max(1, timeDomainBuffer.length));
  const zcr = zeroCrossingCount / Math.max(1, timeDomainBuffer.length);

  let weightedFrequency = 0;
  let magnitudeSum = 0;
  let logMagnitudeSum = 0;
  const binCount = frequencyDomainBuffer.length;

  for (let i = 0; i < binCount; i += 1) {
    const db = Number.isFinite(frequencyDomainBuffer[i]) ? frequencyDomainBuffer[i] : -120;
    const amplitude = Math.max(1e-8, 10 ** (db / 20));
    const frequency = (i * sampleRate) / Math.max(1, 2 * binCount);
    magnitudeSum += amplitude;
    weightedFrequency += frequency * amplitude;
    logMagnitudeSum += Math.log(amplitude);
  }

  const spectralCentroid = magnitudeSum > 0 ? (weightedFrequency / magnitudeSum) : 0;
  const geometricMean = Math.exp(logMagnitudeSum / Math.max(1, binCount));
  const arithmeticMean = magnitudeSum / Math.max(1, binCount);
  const spectralFlatness = arithmeticMean > 0 ? (geometricMean / arithmeticMean) : 1;

  return {
    rms,
    zcr,
    spectralCentroid,
    spectralFlatness,
  };
}

function averageFeatureFrames(frames) {
  if (!Array.isArray(frames) || frames.length === 0) return null;

  const sum = {
    rms: 0,
    zcr: 0,
    spectralCentroid: 0,
    spectralFlatness: 0,
  };

  for (const frame of frames) {
    sum.rms += frame.rms;
    sum.zcr += frame.zcr;
    sum.spectralCentroid += frame.spectralCentroid;
    sum.spectralFlatness += frame.spectralFlatness;
  }

  const count = frames.length;
  return {
    rms: sum.rms / count,
    zcr: sum.zcr / count,
    spectralCentroid: sum.spectralCentroid / count,
    spectralFlatness: sum.spectralFlatness / count,
  };
}

function estimateSongProbability(features) {
  if (!features) return 0;

  const energyScore = clamp((features.rms - 0.008) / 0.09, 0, 1);
  const zcrScore = 1 - clamp(Math.abs(features.zcr - 0.09) / 0.09, 0, 1);
  const centroidScore = clamp((features.spectralCentroid - 350) / 3200, 0, 1);
  const tonalScore = 1 - clamp((features.spectralFlatness - 0.38) / 0.52, 0, 1);
  const silencePenalty = features.rms < 0.006 ? 0.35 : 0;

  const probability = (energyScore * 0.38)
    + (zcrScore * 0.18)
    + (centroidScore * 0.24)
    + (tonalScore * 0.2)
    - silencePenalty;

  return clamp(probability, 0, 1);
}

export class HeuristicSongDetector {
  constructor({ fftSize = 4096 } = {}) {
    this.detectorVersion = HEURISTIC_DETECTOR_VERSION;
    this.fftSize = fftSize;
    this.featureFrames = [];
    this.analyser = null;
    this.timeDomainBuffer = null;
    this.frequencyDomainBuffer = null;
  }

  attachAnalyser(analyser) {
    this.analyser = analyser;
    this.analyser.fftSize = this.fftSize;
    this.analyser.smoothingTimeConstant = 0.2;
    this.timeDomainBuffer = new Float32Array(this.analyser.fftSize);
    this.frequencyDomainBuffer = new Float32Array(this.analyser.frequencyBinCount);
  }

  reset() {
    this.featureFrames = [];
  }

  analyze(sampleRate) {
    if (!this.analyser || !this.timeDomainBuffer || !this.frequencyDomainBuffer) {
      return { ready: false, songProbability: 0 };
    }

    this.analyser.getFloatTimeDomainData(this.timeDomainBuffer);
    this.analyser.getFloatFrequencyData(this.frequencyDomainBuffer);

    const frame = extractAudioFeatures(this.timeDomainBuffer, this.frequencyDomainBuffer, sampleRate);
    this.featureFrames.push(frame);
    if (this.featureFrames.length > 2) this.featureFrames.shift();

    const averaged = averageFeatureFrames(this.featureFrames);
    return {
      ready: true,
      songProbability: estimateSongProbability(averaged),
      features: averaged,
    };
  }
}
