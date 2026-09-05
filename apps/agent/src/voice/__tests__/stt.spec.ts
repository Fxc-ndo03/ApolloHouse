import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { transcribeAudioWithGemini } from '@/voice/stt';

type CapturedFetchCall = {
  readonly url: string;
  readonly init: RequestInit;
};

type GeminiTranscriptionFixture = {
  readonly candidates?: readonly {
    readonly content?: {
      readonly parts: readonly { readonly text?: string }[];
    };
  }[];
};

const capturedGeminiRequestBodySchema = z.object({
  contents: z.array(
    z.object({
      role: z.string(),
      parts: z.array(z.unknown()),
    }),
  ),
});

function parseCapturedGeminiRequestBody(capturedCall: CapturedFetchCall) {
  return capturedGeminiRequestBodySchema.parse(
    JSON.parse(String(capturedCall.init.body)),
  );
}

function createCapturingFetchMock(
  responseBody: GeminiTranscriptionFixture,
  status = 200,
) {
  const callList: CapturedFetchCall[] = [];
  const fetchHandler = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    callList.push({ url: String(input), init: init ?? {} });
    return new Response(JSON.stringify(responseBody), { status });
  };
  return {
    fetchImplementation: Object.assign(fetchHandler, {
      preconnect: () => {},
    }),
    callList,
  };
}

describe('transcribeAudioWithGemini', () => {
  it('transcribes via Gemini and trims response', async () => {
    const { fetchImplementation, callList } = createCapturingFetchMock({
      candidates: [{ content: { parts: [{ text: '  hola apolo  ' }] } }],
    });

    const transcript = await transcribeAudioWithGemini({
      audioBuffer: new Uint8Array([1, 2, 3]).buffer,
      geminiApiKey: 'key-123',
      modelId: 'models/gemini-2.0-flash',
      fetchImplementation,
    });

    expect(transcript).toBe('hola apolo');
    expect(callList[0].url).toContain('generativelanguage.googleapis.com');
    expect(callList[0].url).toContain('gemini-2.0-flash');
    const requestBody = parseCapturedGeminiRequestBody(callList[0]);
    expect(requestBody.contents.length).toBeGreaterThan(0);
  });

  it('delegates to Gemini model', async () => {
    const { fetchImplementation, callList } = createCapturingFetchMock({
      candidates: [{ content: { parts: [{ text: 'hi' }] } }],
    });

    const transcript = await transcribeAudioWithGemini({
      audioBuffer: new Uint8Array([9]).buffer,
      geminiApiKey: 'key-123',
      modelId: 'models/gemini-2.0-flash',
      fetchImplementation,
    });

    expect(transcript).toBe('hi');
    expect(callList[0].url).toContain('generativelanguage.googleapis.com');
  });

  it('throws on a non-ok response', async () => {
    const { fetchImplementation } = createCapturingFetchMock({}, 500);
    await expect(
      transcribeAudioWithGemini({
        audioBuffer: new ArrayBuffer(0),
        geminiApiKey: 'key-123',
        modelId: 'openai/whisper-large-v3',
        fetchImplementation,
      }),
    ).rejects.toThrow('Gemini STT falló');
  });

  it('throws when the transcript is empty', async () => {
    const { fetchImplementation } = createCapturingFetchMock({
      candidates: [{ content: { parts: [{ text: '   ' }] } }],
    });
    await expect(
      transcribeAudioWithGemini({
        audioBuffer: new ArrayBuffer(0),
        geminiApiKey: 'key-123',
        modelId: 'openai/whisper-large-v3',
        fetchImplementation,
      }),
    ).rejects.toThrow('Gemini STT vacío');
  });

  it('throws when GEMINI key is missing', async () => {
    await expect(
      transcribeAudioWithGemini({
        audioBuffer: new ArrayBuffer(0),
        geminiApiKey: '',
        modelId: 'models/gemini-2.0-flash',
      }),
    ).rejects.toThrow('GEMINI_API_KEY no configurado');
  });
});
