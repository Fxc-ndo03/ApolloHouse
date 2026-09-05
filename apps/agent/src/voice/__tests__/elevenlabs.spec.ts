import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { synthesizeWithGemini } from '@/voice/elevenlabs';

type CapturedFetchCall = {
  readonly url: string;
  readonly init: RequestInit;
};

const capturedSynthesisRequestBodySchema = z
  .object({
    contents: z.array(
      z.object({
        role: z.string(),
        parts: z.array(z.object({ text: z.string() })),
      }),
    ),
    generationConfig: z.object({
      responseModalities: z.array(z.string()),
      speechConfig: z.object({
        voiceConfig: z.object({
          prebuiltVoiceConfig: z.object({ voiceName: z.string() }),
        }),
      }),
    }),
  })
  .passthrough();

function parseCapturedSynthesisRequestBody(capturedCall: CapturedFetchCall) {
  return capturedSynthesisRequestBodySchema.parse(
    JSON.parse(String(capturedCall.init.body)),
  );
}

function createCapturingFetchMock(audioArrayBuffer: ArrayBuffer, status = 200) {
  const callList: CapturedFetchCall[] = [];
  const base64Audio = btoa(String.fromCharCode(...new Uint8Array(audioArrayBuffer)));
  const successResponseBody = JSON.stringify({
    candidates: [
      {
        content: {
          parts: [{ inlineData: { mimeType: 'audio/pcm', data: base64Audio } }],
        },
      },
    ],
  });
  const errorResponseBody = JSON.stringify({
    error: { message: 'Internal Server Error', code: 500 },
  });
  const fetchHandler = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    callList.push({ url: String(input), init: init ?? {} });
    const body = status === 200 ? successResponseBody : errorResponseBody;
    return new Response(body, {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return {
    fetchImplementation: Object.assign(fetchHandler, {
      preconnect: () => {},
    }),
    callList,
  };
}

function buildArrayBuffer(byteList: readonly number[]): ArrayBuffer {
  const arrayBuffer = new ArrayBuffer(byteList.length);
  new Uint8Array(arrayBuffer).set(byteList);
  return arrayBuffer;
}

describe('synthesizeWithGemini', () => {
  it('posts text and model to the voice endpoint, defaulting to pcm_24000', async () => {
    const { fetchImplementation, callList } = createCapturingFetchMock(
      buildArrayBuffer([1, 2, 3]),
    );

    const audioBuffer = await synthesizeWithGemini({
      text: 'hola mundo',
      geminiApiKey: 'key-123',
      modelId: 'models/gemini-3.6-flash-preview-tts',
      fetchImplementation,
    });

    expect(new Uint8Array(audioBuffer)).toEqual(new Uint8Array([1, 2, 3]));
    expect(callList[0].url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/models%2Fgemini-3.6-flash-preview-tts:generateContent?key=key-123',
    );
    const requestBody = parseCapturedSynthesisRequestBody(callList[0]);
    expect(requestBody).toEqual({
      contents: [{ role: 'user', parts: [{ text: 'hola mundo' }] }],
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Puck' } } },
      },
    });
  });

  it('honors an explicit model', async () => {
    const { fetchImplementation, callList } = createCapturingFetchMock(
      buildArrayBuffer([]),
    );

    await synthesizeWithGemini({
      text: 'hola',
      geminiApiKey: 'key-123',
      modelId: 'models/gemini-3.6-flash-preview-tts',
      fetchImplementation,
    });

    expect(callList[0].url).toContain('models%2Fgemini-3.6-flash-preview-tts');
  });

  it('throws on a non-ok response', async () => {
    const { fetchImplementation } = createCapturingFetchMock(buildArrayBuffer([]), 500);
    await expect(
      synthesizeWithGemini({
        text: 'hola',
        geminiApiKey: 'key-123',
        modelId: 'models/gemini-3.6-flash-preview-tts',
        fetchImplementation,
      }),
    ).rejects.toThrow('Gemini TTS falló 500');
  });
});
