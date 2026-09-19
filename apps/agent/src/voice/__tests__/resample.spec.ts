import { describe, expect, it } from 'bun:test';

import { resampleToMonoS16Pcm } from '@/voice/resample';

function readS16Samples(audio: ArrayBuffer): number[] {
  const view = new DataView(audio);
  const sampleList: number[] = [];
  for (let offset = 0; offset < audio.byteLength; offset += 2) {
    sampleList.push(view.getInt16(offset, true));
  }
  return sampleList;
}

describe('resampleToMonoS16Pcm', () => {
  it('passes mono audio through at the same rate', () => {
    const audio = resampleToMonoS16Pcm({
      channelDataList: [new Float32Array([0, 0.5, -0.5, 1.0])],
      sourceSampleRateHz: 24000,
    });
    expect(readS16Samples(audio)).toEqual([0, 16384, -16383, 32767]);
  });

  it('averages stereo channels into mono', () => {
    const audio = resampleToMonoS16Pcm({
      channelDataList: [new Float32Array([1, 1]), new Float32Array([-1, -1])],
      sourceSampleRateHz: 24000,
    });
    expect(readS16Samples(audio)).toEqual([0, 0]);
  });

  it('downsamples by dropping frames proportionally', () => {
    const audio = resampleToMonoS16Pcm({
      channelDataList: [new Float32Array([0, 1])],
      sourceSampleRateHz: 48000,
      targetSampleRateHz: 24000,
    });
    expect(readS16Samples(audio)).toEqual([0]);
  });

  it('upsamples with linear interpolation', () => {
    const audio = resampleToMonoS16Pcm({
      channelDataList: [new Float32Array([0, 1])],
      sourceSampleRateHz: 24000,
      targetSampleRateHz: 48000,
    });
    const sampleList = readS16Samples(audio);
    expect(sampleList).toHaveLength(4);
    expect(sampleList[0]).toBe(0);
    expect(sampleList[3]).toBe(32767);
    expect(sampleList[1]).toBeGreaterThan(0);
    expect(sampleList[1]).toBeLessThan(sampleList[2]);
  });

  it('clamps out-of-range samples', () => {
    const audio = resampleToMonoS16Pcm({
      channelDataList: [new Float32Array([2.0, -2.0])],
      sourceSampleRateHz: 24000,
    });
    expect(readS16Samples(audio)).toEqual([32767, -32767]);
  });

  it('returns empty audio without channels', () => {
    const audio = resampleToMonoS16Pcm({
      channelDataList: [],
      sourceSampleRateHz: 24000,
    });
    expect(audio.byteLength).toBe(0);
  });
});
