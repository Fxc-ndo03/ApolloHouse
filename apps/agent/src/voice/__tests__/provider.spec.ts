import { describe, expect, it } from 'bun:test';

import { createFakeApolloEnvironment } from '@/configuration/testing';
import type { MemorySqlExecutor } from '@/memory/store';
import {
  chatWithGemini,
  isGeminiQuotaExceededError,
  isGeminiSttQuotaExceededError,
  transcribeAudioWithGemini,
} from '@/voice/gemini';
import {
  chatWithFallbackLlm,
  clearLiveSetupFailure,
  clearLlmQuotaFailure,
  isLiveSkipActive,
  isLlmFallbackConfigured,
  isLlmQuotaCooldownActive,
  LIVE_SKIP_CONSECUTIVE_FAILURES,
  LLM_QUOTA_DEFAULT_COOLDOWN_MILLISECONDS,
  recordLiveSetupFailure,
  recordLlmQuotaFailure,
  resolveLiveSkipCooldownMilliseconds,
  resolveLlmQuotaCooldownMilliseconds,
  transcribeWithFallbackStt,
} from '@/voice/provider';

function createLiveHealthSqlExecutor() {
  let consecutiveFailures = 0;
  let failedAt = 0;
  let hasRow = false;
  const fakeExecutor = {
    execute(query: string, ...bindValues: unknown[]) {
      if (query.startsWith('CREATE TABLE')) {
        return [];
      }
      if (query.startsWith('SELECT consecutive_failures')) {
        return hasRow
          ? [{ consecutive_failures: consecutiveFailures, failed_at: failedAt }]
          : [];
      }
      if (query.startsWith('INSERT INTO live_health')) {
        consecutiveFailures = Number(bindValues[0]);
        failedAt = Number(bindValues[1]);
        hasRow = true;
        return [];
      }
      if (query.startsWith('DELETE FROM live_health')) {
        hasRow = false;
        consecutiveFailures = 0;
        return [];
      }
      throw new Error(`Unexpected query: ${query}`);
    },
  };
  return fakeExecutor as MemorySqlExecutor;
}

function createQuotaSqlExecutor(): MemorySqlExecutor {
  let failedAt: number | null = null;
  const fakeExecutor = {
    execute(query: string, ...bindValues: unknown[]) {
      if (query.startsWith('CREATE TABLE')) {
        return [];
      }
      if (query.startsWith('SELECT failed_at')) {
        return failedAt === null ? [] : [{ failed_at: failedAt }];
      }
      if (query.startsWith('INSERT INTO llm_quota_state')) {
        failedAt = Number(bindValues[0]);
        return [];
      }
      if (query.startsWith('DELETE FROM llm_quota_state')) {
        failedAt = null;
        return [];
      }
      throw new Error(`Unexpected query: ${query}`);
    },
  };
  return fakeExecutor as MemorySqlExecutor;
}

function createJsonFetchMock(status: number, responseBody: unknown) {
  const callList: { url: string; init: RequestInit }[] = [];
  const fetchHandler = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    callList.push({ url: String(input), init: init ?? {} });
    return new Response(JSON.stringify(responseBody), { status });
  };
  return {
    fetchImplementation: Object.assign(fetchHandler, { preconnect: () => {} }),
    callList,
  };
}

describe('isLlmFallbackConfigured', () => {
  it('is false without fallback secrets', () => {
    expect(isLlmFallbackConfigured(createFakeApolloEnvironment())).toBe(false);
  });

  it('is true with all fallback secrets', () => {
    const environment = createFakeApolloEnvironment({
      LLM_FALLBACK_API_KEY: 'fallback-key',
      LLM_FALLBACK_BASE_URL: 'https://api.groq.com/openai/v1',
      LLM_FALLBACK_MODEL: 'llama-3.3-70b-versatile',
    });
    expect(isLlmFallbackConfigured(environment)).toBe(true);
  });
});

describe('chatWithGemini quota error', () => {
  it('throws a quota error after repeated 429s', async () => {
    const { fetchImplementation } = createJsonFetchMock(429, { error: 'quota' });
    const thrown = await chatWithGemini({
      geminiApiKey: 'key-123',
      modelId: 'model-x',
      messageList: [{ role: 'user', content: 'hola' }],
      fetchImplementation,
    }).catch((error: unknown) => error);
    expect(isGeminiQuotaExceededError(thrown)).toBe(true);
  }, 15000);
});

describe('chatWithFallbackLlm', () => {
  it('returns text from an OpenAI-compatible endpoint', async () => {
    const { fetchImplementation, callList } = createJsonFetchMock(200, {
      choices: [{ message: { content: 'hola desde fallback' } }],
    });
    const environment = createFakeApolloEnvironment({
      LLM_FALLBACK_API_KEY: 'fallback-key',
      LLM_FALLBACK_BASE_URL: 'https://api.groq.com/openai/v1',
      LLM_FALLBACK_MODEL: 'llama-3.3-70b-versatile',
    });

    const result = await chatWithFallbackLlm({
      environment,
      messageList: [{ role: 'user', content: 'hola' }],
      fetchImplementation,
    });

    expect(result.text).toBe('hola desde fallback');
    expect(result.toolCallList).toEqual([]);
    expect(callList[0].url).toContain('/chat/completions');
  });

  it('maps fallback tool calls', async () => {
    const { fetchImplementation } = createJsonFetchMock(200, {
      choices: [
        {
          message: {
            content: '',
            tool_calls: [
              {
                id: 'call-1',
                function: {
                  name: 'weather_now',
                  arguments: '{"locationQuery":"Rosario"}',
                },
              },
            ],
          },
        },
      ],
    });
    const environment = createFakeApolloEnvironment({
      LLM_FALLBACK_API_KEY: 'fallback-key',
      LLM_FALLBACK_BASE_URL: 'https://api.groq.com/openai/v1',
      LLM_FALLBACK_MODEL: 'llama-3.3-70b-versatile',
    });

    const result = await chatWithFallbackLlm({
      environment,
      messageList: [{ role: 'user', content: 'clima' }],
      toolDefinitionList: [
        { name: 'weather_now', description: 'clima', parameters: { type: 'object' } },
      ],
      fetchImplementation,
    });

    expect(result.toolCallList[0].name).toBe('weather_now');
  });

  it('drops explicit nulls for optional params', async () => {
    const { fetchImplementation } = createJsonFetchMock(200, {
      choices: [
        {
          message: {
            content: '',
            tool_calls: [
              {
                id: 'call-1',
                function: { name: 'dollar_rate', arguments: '{"type":null}' },
              },
            ],
          },
        },
      ],
    });

    const result = await chatWithFallbackLlm({
      environment: createFallbackEnvironment(),
      messageList: [{ role: 'user', content: 'dólar' }],
      toolDefinitionList: [
        {
          name: 'dollar_rate',
          description: 'cotización',
          parameters: {
            type: 'object',
            properties: { type: { type: 'string' } },
          },
        },
      ],
      fetchImplementation,
    });

    expect(result.toolCallList[0].args).toEqual({});
  });

  it('keeps nulls for required params so validation still catches them', async () => {
    const { fetchImplementation } = createJsonFetchMock(200, {
      choices: [
        {
          message: {
            content: '',
            tool_calls: [
              {
                id: 'call-1',
                function: { name: 'weather_now', arguments: '{"locationQuery":null}' },
              },
            ],
          },
        },
      ],
    });

    const result = await chatWithFallbackLlm({
      environment: createFallbackEnvironment(),
      messageList: [{ role: 'user', content: 'clima' }],
      toolDefinitionList: [
        {
          name: 'weather_now',
          description: 'clima',
          parameters: {
            type: 'object',
            properties: { locationQuery: { type: 'string' } },
            required: ['locationQuery'],
          },
        },
      ],
      fetchImplementation,
    });

    expect(result.toolCallList[0].args).toEqual({ locationQuery: null });
  });

  it('throws when fallback is not configured', async () => {
    const { fetchImplementation } = createJsonFetchMock(200, {
      choices: [{ message: { content: 'hola' } }],
    });
    await expect(
      chatWithFallbackLlm({
        environment: createFakeApolloEnvironment(),
        messageList: [{ role: 'user', content: 'hola' }],
        fetchImplementation,
      }),
    ).rejects.toThrow('LLM_FALLBACK no configurado');
  });
});

describe('resolveLlmQuotaCooldownMilliseconds', () => {
  it('uses the default without configuration', () => {
    expect(resolveLlmQuotaCooldownMilliseconds(createFakeApolloEnvironment())).toBe(
      LLM_QUOTA_DEFAULT_COOLDOWN_MILLISECONDS,
    );
  });

  it('honors a valid configured cooldown', () => {
    const environment = createFakeApolloEnvironment({
      LLM_QUOTA_COOLDOWN_MS: '60000',
    });
    expect(resolveLlmQuotaCooldownMilliseconds(environment)).toBe(60000);
  });
});

describe('isLlmQuotaCooldownActive', () => {
  it('is inactive without any recorded failure', () => {
    expect(
      isLlmQuotaCooldownActive(
        createQuotaSqlExecutor(),
        createFakeApolloEnvironment(),
        1000,
      ),
    ).toBe(false);
  });

  it('is active right after a recorded failure', () => {
    const sqlExecutor = createQuotaSqlExecutor();
    recordLlmQuotaFailure(sqlExecutor, 1000);
    expect(
      isLlmQuotaCooldownActive(sqlExecutor, createFakeApolloEnvironment(), 1000 + 60_000),
    ).toBe(true);
  });

  it('expires after the cooldown', () => {
    const sqlExecutor = createQuotaSqlExecutor();
    recordLlmQuotaFailure(sqlExecutor, 1000);
    expect(
      isLlmQuotaCooldownActive(
        sqlExecutor,
        createFakeApolloEnvironment(),
        1000 + LLM_QUOTA_DEFAULT_COOLDOWN_MILLISECONDS,
      ),
    ).toBe(false);
  });

  it('clears after a Gemini success', () => {
    const sqlExecutor = createQuotaSqlExecutor();
    recordLlmQuotaFailure(sqlExecutor, 1000);
    clearLlmQuotaFailure(sqlExecutor);
    expect(
      isLlmQuotaCooldownActive(sqlExecutor, createFakeApolloEnvironment(), 1000 + 60_000),
    ).toBe(false);
  });
});

describe('isLiveSkipActive', () => {
  it('is inactive without any recorded failure', () => {
    expect(
      isLiveSkipActive(
        createLiveHealthSqlExecutor(),
        createFakeApolloEnvironment(),
        1000,
      ),
    ).toBe(false);
  });

  it('stays inactive below the consecutive threshold', () => {
    const sqlExecutor = createLiveHealthSqlExecutor();
    recordLiveSetupFailure(sqlExecutor, 1000);
    recordLiveSetupFailure(sqlExecutor, 2000);
    expect(isLiveSkipActive(sqlExecutor, createFakeApolloEnvironment(), 3000)).toBe(
      false,
    );
  });

  it('activates after repeated failures', () => {
    const sqlExecutor = createLiveHealthSqlExecutor();
    for (let index = 0; index < LIVE_SKIP_CONSECUTIVE_FAILURES; index += 1) {
      recordLiveSetupFailure(sqlExecutor, 1000 + index);
    }
    expect(isLiveSkipActive(sqlExecutor, createFakeApolloEnvironment(), 2000)).toBe(true);
  });

  it('expires after the cooldown', () => {
    const sqlExecutor = createLiveHealthSqlExecutor();
    for (let index = 0; index < LIVE_SKIP_CONSECUTIVE_FAILURES; index += 1) {
      recordLiveSetupFailure(sqlExecutor, 1000);
    }
    expect(
      isLiveSkipActive(
        sqlExecutor,
        createFakeApolloEnvironment({ LIVE_SKIP_COOLDOWN_MS: '5000' }),
        1000 + 5000,
      ),
    ).toBe(false);
  });

  it('clears after a Live success', () => {
    const sqlExecutor = createLiveHealthSqlExecutor();
    for (let index = 0; index < LIVE_SKIP_CONSECUTIVE_FAILURES; index += 1) {
      recordLiveSetupFailure(sqlExecutor, 1000);
    }
    clearLiveSetupFailure(sqlExecutor);
    expect(isLiveSkipActive(sqlExecutor, createFakeApolloEnvironment(), 2000)).toBe(
      false,
    );
  });

  it('uses the default cooldown without configuration', () => {
    expect(resolveLiveSkipCooldownMilliseconds(createFakeApolloEnvironment())).toBe(
      30 * 60 * 1000,
    );
  });
});

function createFallbackEnvironment() {
  return createFakeApolloEnvironment({
    LLM_FALLBACK_API_KEY: 'fallback-key',
    LLM_FALLBACK_BASE_URL: 'https://api.groq.com/openai/v1',
    LLM_FALLBACK_MODEL: 'llama-3.3-70b-versatile',
  });
}

function hangingFetchHandler(
  _input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  return new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => {
      reject(new DOMException('Aborted', 'AbortError'));
    });
  });
}

function createTranscriptionFetchMock(transcript: string) {
  const callList: { url: string }[] = [];
  const fetchHandler = async (
    input: string | URL | Request,
    _init?: RequestInit,
  ): Promise<Response> => {
    callList.push({ url: String(input) });
    return new Response(JSON.stringify({ text: transcript }), { status: 200 });
  };
  return {
    fetchImplementation: Object.assign(fetchHandler, { preconnect: () => {} }),
    callList,
  };
}

describe('transcribeAudioWithGemini quota error', () => {
  it('throws a quota error after repeated 429s', async () => {
    const { fetchImplementation } = createJsonFetchMock(429, { error: 'quota' });
    const thrown = await transcribeAudioWithGemini({
      audioBuffer: new ArrayBuffer(16),
      geminiApiKey: 'key-123',
      fetchImplementation,
    }).catch((error: unknown) => error);
    expect(isGeminiSttQuotaExceededError(thrown)).toBe(true);
  }, 15000);
});

describe('transcribeWithFallbackStt', () => {
  it('returns the transcript from an OpenAI-compatible endpoint', async () => {
    const { fetchImplementation, callList } = createTranscriptionFetchMock('hola mundo');

    const text = await transcribeWithFallbackStt({
      environment: createFallbackEnvironment(),
      audioBuffer: new ArrayBuffer(32),
      fetchImplementation,
    });

    expect(text).toBe('hola mundo');
    expect(callList).toHaveLength(1);
    expect(callList[0].url).toContain('/audio/transcriptions');
  });

  it('throws when fallback is not configured', async () => {
    const { fetchImplementation } = createTranscriptionFetchMock('hola');
    await expect(
      transcribeWithFallbackStt({
        environment: createFakeApolloEnvironment(),
        audioBuffer: new ArrayBuffer(32),
        fetchImplementation,
      }),
    ).rejects.toThrow('LLM_FALLBACK no configurado');
  });

  it('throws on an empty transcript', async () => {
    const { fetchImplementation } = createTranscriptionFetchMock('   ');
    await expect(
      transcribeWithFallbackStt({
        environment: createFallbackEnvironment(),
        audioBuffer: new ArrayBuffer(32),
        fetchImplementation,
      }),
    ).rejects.toThrow('STT fallback vacío');
  });

  it('aborts a hung provider instead of hanging forever', async () => {
    const hangingImplementation = Object.assign(hangingFetchHandler, {
      preconnect: () => {},
    });
    await expect(
      chatWithFallbackLlm({
        environment: createFallbackEnvironment(),
        messageList: [{ role: 'user', content: 'hola' }],
        fetchImplementation: hangingImplementation,
        fetchTimeoutMilliseconds: 50,
      }),
    ).rejects.toThrow();
  });
});
