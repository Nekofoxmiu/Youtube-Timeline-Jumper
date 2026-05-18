class YtjAudioCaptureWorkletProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const requestedChunkSize = Number(options?.processorOptions?.chunkSize) || 2048;
    this.chunkSize = Math.max(256, requestedChunkSize);
    this.chunkBuffer = new Float32Array(this.chunkSize);
    this.chunkOffset = 0;
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];

    if (!input || input.length === 0 || input[0].length === 0) {
      if (output && output[0]) output[0].fill(0);
      return true;
    }

    const frameCount = input[0].length;
    const channelCount = input.length;
    const outputChannel = output && output[0] ? output[0] : null;

    for (let i = 0; i < frameCount; i += 1) {
      let mono = 0;
      for (let ch = 0; ch < channelCount; ch += 1) {
        mono += input[ch][i] || 0;
      }
      mono /= channelCount;

      if (outputChannel) outputChannel[i] = mono;

      this.chunkBuffer[this.chunkOffset] = mono;
      this.chunkOffset += 1;

      if (this.chunkOffset >= this.chunkSize) {
        const chunk = this.chunkBuffer.slice(0);
        this.port.postMessage({ type: 'audio', samples: chunk }, [chunk.buffer]);
        this.chunkOffset = 0;
      }
    }

    return true;
  }
}

registerProcessor('ytj-audio-capture-worklet', YtjAudioCaptureWorkletProcessor);
