import { describe, expect, it } from 'bun:test';

import { buildTtsCacheObjectKey, synthesizeSpeechThroughCache } from '@/voice/ttscache';
import type { StorageBucket } from '@/storage/local';

function buildArrayBuffer(byteList: readonly number[]): ArrayBuffer {
  const arrayBuffer = new ArrayBuffer(byteList.length);
  new Uint8Array(arrayBuffer).set(byteList);
  return arrayBuffer;
}

function createFakeStorageBucket(): StorageBucket {
  const store = new Map<string, ArrayBuffer>();
  const bucket: StorageBucket = {
    async get(objectKey: string) {
      const stored = store.get(objectKey);
      if (stored === undefined) {
        return null;
      }
      return {
        size: stored.byteLength,
        httpMetadata: { contentType: 'audio/pcm' },
        async arrayBuffer() {
          return stored;
        },
      };
    },
    async put(
      objectKey: string,
      audioBody: ReadableStream | ArrayBuffer | ArrayBufferView | string,
      _options?: { httpMetadata?: { contentType?: string } },
    ) {
      let arrayBuffer: ArrayBuffer;
      if (audioBody instanceof ReadableStream) {
        const chunks: Uint8Array[] = [];
        const reader = audioBody.getReader();
        while (true) {
          const { done, value: chunk } = await reader.read();
          if (done) break;
          chunks.push(chunk as Uint8Array);
        }
        const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
        const combined = new Uint8Array(totalLength);
        let offset = 0;
        for (const chunk of chunks) {
          combined.set(chunk, offset);
          offset += chunk.length;
        }
        arrayBuffer = combined.buffer as ArrayBuffer;
      } else if (audioBody instanceof ArrayBuffer) {
        arrayBuffer = audioBody;
      } else if (
        audioBody !== null &&
        typeof audioBody === 'object' &&
        'buffer' in audioBody &&
        'byteOffset' in audioBody &&
        'byteLength' in audioBody
      ) {
        const view = audioBody as ArrayBufferView;
        arrayBuffer = view.buffer.slice(
          view.byteOffset,
          view.byteOffset + view.byteLength,
        ) as ArrayBuffer;
      } else {
        arrayBuffer = new TextEncoder().encode(audioBody as string).buffer as ArrayBuffer;
      }
      store.set(objectKey, arrayBuffer);
    },
    async delete() {},
    async list() {
      return { objects: [], truncated: false };
    },
  };
  return bucket;
}

describe('synthesizeSpeechThroughCache', () => {
  it('synthesizes and stores on a miss, then serves the hit without synthesizing', async () => {
    const bucket = createFakeStorageBucket();
    let synthesizeCallCount = 0;
    const synthesize = async (): Promise<ArrayBuffer> => {
      synthesizeCallCount += 1;
      return buildArrayBuffer([1, 2, 3]);
    };

    const firstAudio = await synthesizeSpeechThroughCache({
      mediaBucket: bucket,
      text: 'Hola, ¿cómo va?',
      voiceId: 'voz-1',
      modelId: 'modelo-1',
      synthesize,
    });
    const secondAudio = await synthesizeSpeechThroughCache({
      mediaBucket: bucket,
      text: 'Hola, ¿cómo va?',
      voiceId: 'voz-1',
      modelId: 'modelo-1',
      synthesize,
    });

    expect(synthesizeCallCount).toBe(1);
    expect(new Uint8Array(firstAudio)).toEqual(new Uint8Array([1, 2, 3]));
    expect(new Uint8Array(secondAudio)).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('keys by voice and model so a change never plays stale audio', async () => {
    const baseInput = { text: 'hola', voiceId: 'voz-1', modelId: 'modelo-1' };
    const sameKey = await buildTtsCacheObjectKey(baseInput);
    expect(await buildTtsCacheObjectKey({ ...baseInput })).toBe(sameKey);
    expect(await buildTtsCacheObjectKey({ ...baseInput, voiceId: 'voz-2' })).not.toBe(
      sameKey,
    );
    expect(await buildTtsCacheObjectKey({ ...baseInput, modelId: 'modelo-2' })).not.toBe(
      sameKey,
    );
    expect(await buildTtsCacheObjectKey({ ...baseInput, text: 'chau' })).not.toBe(
      sameKey,
    );
  });

  it('degrades to direct synthesis when the cache read fails', async () => {
    // SAFETY: synthesizeSpeechThroughCache only calls get and put on the
    // StorageBucket binding; both members carry the real binding's signatures.
    const bucket: StorageBucket = {
      get: async () => {
        throw new Error('cache read failed');
      },
      put: async () => {
        throw new Error('cache write failed');
      },
      delete: async () => {},
      list: async () => ({ objects: [], truncated: false }),
    };

    const audioBuffer = await synthesizeSpeechThroughCache({
      mediaBucket: bucket,
      text: 'hola',
      voiceId: 'voz-1',
      modelId: 'modelo-1',
      synthesize: async () => buildArrayBuffer([9]),
    });

    expect(new Uint8Array(audioBuffer)).toEqual(new Uint8Array([9]));
  });

  it('still returns audio when only the cache write fails', async () => {
    // SAFETY: synthesizeSpeechThroughCache only calls get and put on the
    // StorageBucket binding; both members carry the real binding's signatures.
    const bucket: StorageBucket = {
      get: async () => null,
      put: async () => {
        throw new Error('cache write failed');
      },
      delete: async () => {},
      list: async () => ({ objects: [], truncated: false }),
    };

    const audioBuffer = await synthesizeSpeechThroughCache({
      mediaBucket: bucket,
      text: 'hola',
      voiceId: 'voz-1',
      modelId: 'modelo-1',
      synthesize: async () => buildArrayBuffer([7, 8]),
    });

    expect(new Uint8Array(audioBuffer)).toEqual(new Uint8Array([7, 8]));
  });
});
