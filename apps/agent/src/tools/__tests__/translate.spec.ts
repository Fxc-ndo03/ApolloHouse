import { describe, expect, it } from 'bun:test';

import { createFakeApolloEnvironment } from '@/configuration/testing';
import { translateTool } from '@/tools/translate';

describe('translateTool', () => {
  it('returns translation from Gemini', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(
      async () =>
        new Response(
          JSON.stringify({
            candidates: [{ content: { parts: [{ text: 'Hello world' }] } }],
          }),
          { status: 200 },
        ),
      { preconnect: () => {} },
    );

    try {
      const result = await translateTool.handler(
        { text: 'Hola mundo', targetLanguage: 'english' },
        {
          environment: createFakeApolloEnvironment({
            GEMINI_API_KEY: 'test-gemini-key',
          }),
          nowMilliseconds: 1,
        },
      );
      expect(result.ok).toBe(true);
      expect(result.summary).toBe('Hello world');
      expect(result.data).toMatchObject({
        translatedText: 'Hello world',
        targetLanguage: 'english',
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('reports empty translation honestly', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(
      async () =>
        new Response(
          JSON.stringify({
            candidates: [{ content: { parts: [{ text: '   ' }] } }],
          }),
          { status: 200 },
        ),
      { preconnect: () => {} },
    );

    try {
      const result = await translateTool.handler(
        { text: 'Hola mundo', targetLanguage: 'english' },
        {
          environment: createFakeApolloEnvironment({
            GEMINI_API_KEY: 'test-gemini-key',
          }),
          nowMilliseconds: 1,
        },
      );
      expect(result.ok).toBe(false);
      expect(result.summary).toContain('vacía');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
