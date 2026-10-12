import { describe, expect, it } from 'bun:test';

import { chatWithGemini, needsThoughtSignatureRetry } from '@/voice/gemini';

function createSequenceFetchMock(statusList: readonly number[], body: unknown) {
  let callIndex = 0;
  const fetchHandler = async (
    _input: string | URL | Request,
    _init?: RequestInit,
  ): Promise<Response> => {
    const status = statusList[Math.min(callIndex, statusList.length - 1)] ?? 200;
    callIndex += 1;
    return new Response(JSON.stringify(body), { status });
  };
  return {
    fetchImplementation: Object.assign(fetchHandler, { preconnect: () => {} }),
  };
}

const okChatBody = {
  candidates: [{ content: { parts: [{ text: 'hola' }] } }],
};

describe('needsThoughtSignatureRetry', () => {
  it('is false without tool calls', () => {
    expect(needsThoughtSignatureRetry({ toolCallList: [] })).toBe(false);
  });

  it('is true when every call lacks a signature', () => {
    expect(
      needsThoughtSignatureRetry({
        toolCallList: [{ id: 'a', name: 'open_pc_app', args: {} }],
      }),
    ).toBe(true);
  });

  it('is false when the first call carries a signature', () => {
    expect(
      needsThoughtSignatureRetry({
        toolCallList: [
          { id: 'a', name: 'open_pc_app', args: {}, thoughtSignature: 'firma' },
          { id: 'b', name: 'dollar_rate', args: {} },
        ],
      }),
    ).toBe(false);
  });
});

describe('chatWithGemini hadAvailabilityRetry', () => {
  it('is false when the first attempt succeeds', async () => {
    const { fetchImplementation } = createSequenceFetchMock([200], okChatBody);
    const result = await chatWithGemini({
      geminiApiKey: 'key-123',
      modelId: 'model-x',
      messageList: [{ role: 'user', content: 'hola' }],
      fetchImplementation,
    });
    expect(result.hadAvailabilityRetry).toBe(false);
  });

  it('is true after a 429 retry succeeds', async () => {
    const { fetchImplementation } = createSequenceFetchMock([429, 200], okChatBody);
    const result = await chatWithGemini({
      geminiApiKey: 'key-123',
      modelId: 'model-x',
      messageList: [{ role: 'user', content: 'hola' }],
      fetchImplementation,
    });
    expect(result.text).toBe('hola');
    expect(result.hadAvailabilityRetry).toBe(true);
  });
});
