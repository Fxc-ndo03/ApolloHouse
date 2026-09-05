import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { buildGeminiSystemPrompt, chatWithGemini } from '@/voice/llm';

type CapturedFetchCall = {
  readonly url: string;
  readonly init: RequestInit;
};

type GeminiChatResponseFixture = {
  readonly candidates?: readonly {
    readonly content?: {
      readonly parts: readonly {
        readonly text?: string;
        readonly functionCall?: unknown;
      }[];
    };
  }[];
};

const capturedChatRequestBodySchema = z.object({
  model: z.string().optional(),
  contents: z.array(z.unknown()).optional(),
  tools: z
    .array(z.object({ functionDeclarations: z.array(z.object({ name: z.string() })) }))
    .optional(),
  systemInstruction: z.unknown().optional(),
});

function parseCapturedChatRequestBody(capturedCall: CapturedFetchCall) {
  return capturedChatRequestBodySchema.parse(JSON.parse(String(capturedCall.init.body)));
}

function createCapturingFetchMock(responseBody: GeminiChatResponseFixture, status = 200) {
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

function createStreamingFetchMock(serverSentEventBody: string) {
  const callList: CapturedFetchCall[] = [];
  const fetchHandler = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    callList.push({ url: String(input), init: init ?? {} });
    return new Response(serverSentEventBody, { status: 200 });
  };
  return {
    fetchImplementation: Object.assign(fetchHandler, {
      preconnect: () => {},
    }),
    callList,
  };
}

describe('buildGeminiSystemPrompt', () => {
  it('lists memories when present', () => {
    const prompt = buildGeminiSystemPrompt({
      soulSystemPrompt: 'Sos Apollo.',
      memoryContentList: ['toma mate', 'vive en Buenos Aires'],
      isFocusActive: false,
    });
    expect(prompt).toContain('toma mate');
    expect(prompt).toContain('vive en Buenos Aires');
    expect(prompt).toContain('Focus inactivo.');
  });

  it('notes the absence of memories and an active focus', () => {
    const prompt = buildGeminiSystemPrompt({
      soulSystemPrompt: 'Sos Apollo.',
      memoryContentList: [],
      isFocusActive: true,
    });
    expect(prompt).toContain('Sin memorias relevantes.');
    expect(prompt).toContain('Focus activo');
  });
});

describe('chatWithGemini', () => {
  it('sends the model and messages via Gemini, omitting tools when none are given', async () => {
    const { fetchImplementation, callList } = createCapturingFetchMock({
      candidates: [{ content: { parts: [{ text: 'hola' }] } }],
    });

    const result = await chatWithGemini({
      geminiApiKey: 'key-123',
      modelId: 'deepseek/deepseek-v4-flash-0731',
      messageList: [{ role: 'user', content: 'hola' }],
      fetchImplementation,
    });

    expect(result.text).toBe('hola');
    expect(result.toolCallList).toEqual([]);
    expect(callList).toHaveLength(1);
    expect(callList[0].url).toContain('generativelanguage.googleapis.com');
    expect(callList[0].url).toContain('gemini-3.6-flash');
    const requestBody = parseCapturedChatRequestBody(callList[0]);
    expect(requestBody.tools).toBeUndefined();
  });

  it('includes a tools payload when tool definitions are given', async () => {
    const { fetchImplementation, callList } = createCapturingFetchMock({
      candidates: [{ content: { parts: [{ text: 'listo' }] } }],
    });

    await chatWithGemini({
      geminiApiKey: 'key-123',
      modelId: 'model-x',
      messageList: [{ role: 'user', content: 'hacé algo' }],
      toolDefinitionList: [
        { name: 'weather_now', description: 'clima', parameters: { type: 'object' } },
      ],
      fetchImplementation,
    });

    const requestBody = parseCapturedChatRequestBody(callList[0]);
    expect(requestBody.tools?.[0]?.functionDeclarations?.[0]?.name).toBe('weather_now');
  });

  it('maps Gemini functionCall into toolCallList with parsed args', async () => {
    const { fetchImplementation } = createCapturingFetchMock({
      candidates: [
        {
          content: {
            parts: [
              {
                functionCall: { name: 'weather_now', args: { locationQuery: 'Rosario' } },
              },
            ],
          },
        },
      ],
    });

    const result = await chatWithGemini({
      geminiApiKey: 'key-123',
      modelId: 'model-x',
      messageList: [{ role: 'user', content: 'clima en Rosario' }],
      fetchImplementation,
    });

    expect(result.text).toBe('');
    expect(result.toolCallList).toEqual([
      { id: expect.any(String), name: 'weather_now', args: { locationQuery: 'Rosario' } },
    ]);
  });

  it('throws on a non-ok response', async () => {
    const { fetchImplementation } = createCapturingFetchMock({}, 500);
    await expect(
      chatWithGemini({
        geminiApiKey: 'key-123',
        modelId: 'model-x',
        messageList: [{ role: 'user', content: 'hola' }],
        fetchImplementation,
      }),
    ).rejects.toThrow('Gemini falló con status 500');
  });

  it('streams content deltas and reassembles the full text', async () => {
    const sseBody = [
      'data: {"candidates":[{"content":{"parts":[{"text":"Hola "}]}}]}',
      '',
      'data: {"candidates":[{"content":{"parts":[{"text":"mundo."}]}}]}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');
    const { fetchImplementation, callList } = createStreamingFetchMock(sseBody);

    const deltaList: string[] = [];
    const result = await chatWithGemini({
      geminiApiKey: 'key-123',
      modelId: 'model-x',
      messageList: [{ role: 'user', content: 'hola' }],
      onTextDelta: (deltaText) => {
        deltaList.push(deltaText);
      },
      fetchImplementation,
    });

    expect(callList[0].url).toContain('streamGenerateContent');
    expect(deltaList).toEqual(['Hola ', 'mundo.']);
    expect(result.text).toBe('Hola mundo.');
    expect(result.toolCallList).toEqual([]);
  });

  it('keeps the last event when the stream ends without a trailing newline', async () => {
    const sseBody = [
      'data: {"candidates":[{"content":{"parts":[{"text":"Hola "}]}}]}',
      '',
      'data: {"candidates":[{"content":{"parts":[{"text":"mundo."}]}}]}',
    ].join('\n');
    const { fetchImplementation } = createStreamingFetchMock(sseBody);

    const result = await chatWithGemini({
      geminiApiKey: 'key-123',
      modelId: 'model-x',
      messageList: [{ role: 'user', content: 'hola' }],
      onTextDelta: () => {},
      fetchImplementation,
    });

    expect(result.text).toBe('Hola mundo.');
  });

  it('accumulates streamed functionCall into parsed calls', async () => {
    const sseBody = [
      'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"weather_now","args":{"locationQuery":"Rosario"}}}]}}]}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');
    const { fetchImplementation } = createStreamingFetchMock(sseBody);

    const result = await chatWithGemini({
      geminiApiKey: 'key-123',
      modelId: 'model-x',
      messageList: [{ role: 'user', content: 'clima' }],
      onTextDelta: () => {},
      fetchImplementation,
    });

    expect(result.text).toBe('');
    expect(result.toolCallList[0].name).toBe('weather_now');
    expect(result.toolCallList[0].args).toEqual({ locationQuery: 'Rosario' });
  });

  it('throws when the response does not match the expected schema', async () => {
    const { fetchImplementation } = createCapturingFetchMock({
      candidates: [],
    } as unknown as GeminiChatResponseFixture);
    const result = await chatWithGemini({
      geminiApiKey: 'key-123',
      modelId: 'model-x',
      messageList: [{ role: 'user', content: 'hola' }],
      fetchImplementation,
    });
    expect(result.text).toBe('');
  });
});
