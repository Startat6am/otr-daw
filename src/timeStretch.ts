/** Lightweight granular overlap-add time stretcher. Changes duration while keeping grain pitch. */
export function timeStretchBuffer(source: AudioBuffer, ratio: number, context: BaseAudioContext): AudioBuffer {
  const safeRatio = Math.max(0.25, Math.min(4, ratio));
  if (Math.abs(safeRatio - 1) < 0.002) return source;
  const grainSize = Math.min(2048, Math.max(512, 2 ** Math.floor(Math.log2(Math.max(512, source.sampleRate * 0.046)))));
  const synthesisHop = Math.floor(grainSize / 4);
  const outputLength = Math.max(1, Math.round(source.length * safeRatio));
  const output = context.createBuffer(source.numberOfChannels, outputLength, source.sampleRate);
  const window = new Float32Array(grainSize);
  for (let i = 0; i < grainSize; i++) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (grainSize - 1));
  const weight = new Float32Array(outputLength);
  for (let outStart = -grainSize + synthesisHop; outStart < outputLength; outStart += synthesisHop) {
    const sourceStart = Math.round(outStart / safeRatio);
    const begin = Math.max(0, -outStart, -sourceStart);
    const end = Math.min(grainSize, outputLength - outStart, source.length - sourceStart);
    if (end <= begin) continue;
    for (let i = begin; i < end; i++) weight[outStart + i] += window[i];
    for (let channel = 0; channel < source.numberOfChannels; channel++) {
      const input = source.getChannelData(channel);
      const dest = output.getChannelData(channel);
      for (let i = begin; i < end; i++) dest[outStart + i] += input[sourceStart + i] * window[i];
    }
  }
  for (let channel = 0; channel < output.numberOfChannels; channel++) {
    const data = output.getChannelData(channel);
    for (let i = 0; i < outputLength; i++) data[i] = weight[i] > 1e-5 ? data[i] / weight[i] : 0;
  }
  return output;
}
