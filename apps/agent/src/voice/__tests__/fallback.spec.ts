import { describe, expect, it } from 'bun:test';

import { createFakeApolloEnvironment } from '@/configuration/testing';
import {
  isWorkersAiTtsAvailable,
  MELOTTS_LANGUAGE,
  MELOTTS_MODEL_ID,
  synthesizeWithWorkersAi,
  type Mp3DecodeResult,
} from '@/voice/fallback';

type RecordedModelCall = {
  readonly modelName: string;
  readonly inputs: Record<string, string | number>;
};

function buildStreamFromChunkList(chunkList: readonly Uint8Array[]) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunkList) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
}

function createModelBinding(handleCall: (call: RecordedModelCall) => Promise<unknown>) {
  const callList: RecordedModelCall[] = [];
  return {
    callList,
    binding: {
      run: async (modelName: string, inputs: Record<string, string | number>) => {
        const call = { modelName, inputs };
        callList.push(call);
        return handleCall(call);
      },
    },
  };
}

function createStereoDecoder(sampleRate: number) {
  return async (mp3Bytes: Uint8Array): Promise<Mp3DecodeResult> => {
    if (mp3Bytes.byteLength === 0) {
      return { channelData: [], sampleRate };
    }
    return {
      channelData: [new Float32Array([0, 0.5, -0.5, 1.0])],
      sampleRate,
    };
  };
}

describe('isWorkersAiTtsAvailable', () => {
  it('is false without the AI binding', () => {
    expect(isWorkersAiTtsAvailable(createFakeApolloEnvironment())).toBe(false);
  });

  it('is true with the AI binding', () => {
    const { binding } = createModelBinding(async () => buildStreamFromChunkList([]));
    const environment = createFakeApolloEnvironment({ AI: binding });
    expect(isWorkersAiTtsAvailable(environment)).toBe(true);
  });
});

describe('synthesizeWithWorkersAi', () => {
  it('tries MeloTTS in Spanish and returns resampled PCM', async () => {
    const { binding, callList } = createModelBinding(async (call) => {
      if (call.modelName !== MELOTTS_MODEL_ID) {
        throw new Error('solo melotts en este test');
      }
      return buildStreamFromChunkList([new Uint8Array([1, 2, 3])]);
    });
    const environment = createFakeApolloEnvironment({ AI: binding });

    const audio = await synthesizeWithWorkersAi({
      text: 'hola',
      environment,
      decodeMp3Implementation: createStereoDecoder(24000),
    });

    expect(callList[0].modelName).toBe(MELOTTS_MODEL_ID);
    expect(callList[0].inputs).toMatchObject({ prompt: 'hola', lang: MELOTTS_LANGUAGE });
    const view = new DataView(audio);
    expect(audio.byteLength).toBe(8);
    expect(view.getInt16(0, true)).toBe(0);
    expect(view.getInt16(2, true)).toBe(16384);
    expect(view.getInt16(4, true)).toBe(-16383);
    expect(view.getInt16(6, true)).toBe(32767);
  });

  it('throws when MeloTTS fails', async () => {
    const { binding } = createModelBinding(async () => {
      throw new Error('caído');
    });
    const environment = createFakeApolloEnvironment({ AI: binding });

    await expect(
      synthesizeWithWorkersAi({
        text: 'hola',
        environment,
        decodeMp3Implementation: createStereoDecoder(24000),
      }),
    ).rejects.toThrow('sin motores disponibles');
  });

  it('throws without the AI binding', async () => {
    await expect(
      synthesizeWithWorkersAi({
        text: 'hola',
        environment: createFakeApolloEnvironment(),
      }),
    ).rejects.toThrow('Workers AI binding no disponible');
  });

  it('throws on empty text', async () => {
    const { binding } = createModelBinding(async () => buildStreamFromChunkList([]));
    const environment = createFakeApolloEnvironment({ AI: binding });
    await expect(synthesizeWithWorkersAi({ text: '   ', environment })).rejects.toThrow(
      'texto vacío',
    );
  });

  it('throws on empty audio from MeloTTS', async () => {
    const { binding } = createModelBinding(async () => buildStreamFromChunkList([]));
    const environment = createFakeApolloEnvironment({ AI: binding });
    await expect(
      synthesizeWithWorkersAi({
        text: 'hola',
        environment,
        decodeMp3Implementation: createStereoDecoder(24000),
      }),
    ).rejects.toThrow('sin motores disponibles');
  });
});
