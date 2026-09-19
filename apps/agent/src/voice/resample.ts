export const TTS_OUTPUT_SAMPLE_RATE_HZ = 24000;

function mixChannelsToMono(channelDataList: readonly Float32Array[]): Float32Array {
  if (channelDataList.length === 0) {
    return new Float32Array(0);
  }
  const firstChannel = channelDataList[0];
  if (channelDataList.length === 1) {
    return firstChannel.slice();
  }
  const frameCount = Math.min(...channelDataList.map((channel) => channel.length));
  const mono = new Float32Array(frameCount);
  for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
    let sampleSum = 0;
    for (const channel of channelDataList) {
      sampleSum += channel[frameIndex] ?? 0;
    }
    mono[frameIndex] = sampleSum / channelDataList.length;
  }
  return mono;
}

function resampleMonoFrames(
  monoFrames: Float32Array,
  sourceSampleRateHz: number,
  targetSampleRateHz: number,
): Float32Array {
  if (
    sourceSampleRateHz <= 0 ||
    targetSampleRateHz <= 0 ||
    monoFrames.length === 0
  ) {
    return new Float32Array(0);
  }
  if (sourceSampleRateHz === targetSampleRateHz) {
    return monoFrames.slice();
  }
  const targetFrameCount = Math.max(
    1,
    Math.round((monoFrames.length * targetSampleRateHz) / sourceSampleRateHz),
  );
  const resampled = new Float32Array(targetFrameCount);
  const positionRatio = (monoFrames.length - 1) / Math.max(1, targetFrameCount - 1);
  for (let targetIndex = 0; targetIndex < targetFrameCount; targetIndex += 1) {
    const sourcePosition = targetIndex * positionRatio;
    const lowerIndex = Math.floor(sourcePosition);
    const upperIndex = Math.min(lowerIndex + 1, monoFrames.length - 1);
    const fraction = sourcePosition - lowerIndex;
    const lowerSample = monoFrames[lowerIndex] ?? 0;
    const upperSample = monoFrames[upperIndex] ?? 0;
    resampled[targetIndex] = lowerSample + (upperSample - lowerSample) * fraction;
  }
  return resampled;
}

export function resampleToMonoS16Pcm(input: {
  readonly channelDataList: readonly Float32Array[];
  readonly sourceSampleRateHz: number;
  readonly targetSampleRateHz?: number;
}): ArrayBuffer {
  const targetSampleRateHz = input.targetSampleRateHz ?? TTS_OUTPUT_SAMPLE_RATE_HZ;
  const monoFrames = mixChannelsToMono(input.channelDataList);
  const resampledFrames = resampleMonoFrames(
    monoFrames,
    input.sourceSampleRateHz,
    targetSampleRateHz,
  );
  const pcmBytes = new Uint8Array(resampledFrames.length * 2);
  const view = new DataView(pcmBytes.buffer);
  for (let frameIndex = 0; frameIndex < resampledFrames.length; frameIndex += 1) {
    const clampedSample = Math.max(-1, Math.min(1, resampledFrames[frameIndex] ?? 0));
    view.setInt16(frameIndex * 2, Math.round(clampedSample * 32767), true);
  }
  return pcmBytes.buffer;
}
