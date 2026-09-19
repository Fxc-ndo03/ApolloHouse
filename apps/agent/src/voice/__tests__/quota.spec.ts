import { describe, expect, it } from 'bun:test';

import { createFakeApolloEnvironment } from '@/configuration/testing';
import type { MemorySqlExecutor } from '@/memory/store';
import {
  readGeminiTtsUsageCharCount,
  recordGeminiTtsUsageCharCount,
  resolveTtsFallbackDailyCharLimit,
  shouldUseFallbackTts,
  TTS_FALLBACK_DEFAULT_DAILY_CHAR_LIMIT,
} from '@/voice/quota';

function createQuotaSqlExecutor(): MemorySqlExecutor {
  const usageByDay = new Map<string, number>();
  const fakeExecutor = {
    execute(query: string, ...bindValues: unknown[]) {
      if (query.startsWith('CREATE TABLE')) {
        return [];
      }
      if (query.startsWith('SELECT char_count')) {
        const day = String(bindValues[0]);
        const charCount = usageByDay.get(day);
        return charCount === undefined ? [] : [{ char_count: charCount }];
      }
      if (query.startsWith('INSERT INTO tts_usage')) {
        const day = String(bindValues[0]);
        usageByDay.set(day, (usageByDay.get(day) ?? 0) + Number(bindValues[1]));
        return [];
      }
      throw new Error(`Unexpected query: ${query}`);
    },
  };
  return fakeExecutor as MemorySqlExecutor;
}

const FIRST_DAY_MILLISECONDS = Date.parse('2026-09-01T12:00:00.000Z');

const SECOND_DAY_MILLISECONDS = Date.parse('2026-09-02T12:00:00.000Z');

describe('readGeminiTtsUsageCharCount', () => {
  it('starts at zero for a fresh day', () => {
    expect(
      readGeminiTtsUsageCharCount(createQuotaSqlExecutor(), FIRST_DAY_MILLISECONDS),
    ).toBe(0);
  });
});

describe('recordGeminiTtsUsageCharCount', () => {
  it('accumulates characters within the same day', () => {
    const sqlExecutor = createQuotaSqlExecutor();
    recordGeminiTtsUsageCharCount(sqlExecutor, 200, FIRST_DAY_MILLISECONDS);
    recordGeminiTtsUsageCharCount(sqlExecutor, 300, FIRST_DAY_MILLISECONDS);
    expect(readGeminiTtsUsageCharCount(sqlExecutor, FIRST_DAY_MILLISECONDS)).toBe(500);
  });

  it('resets at midnight UTC', () => {
    const sqlExecutor = createQuotaSqlExecutor();
    recordGeminiTtsUsageCharCount(sqlExecutor, 200, FIRST_DAY_MILLISECONDS);
    expect(readGeminiTtsUsageCharCount(sqlExecutor, SECOND_DAY_MILLISECONDS)).toBe(0);
  });

  it('ignores non-positive counts', () => {
    const sqlExecutor = createQuotaSqlExecutor();
    recordGeminiTtsUsageCharCount(sqlExecutor, 0, FIRST_DAY_MILLISECONDS);
    recordGeminiTtsUsageCharCount(sqlExecutor, -50, FIRST_DAY_MILLISECONDS);
    expect(readGeminiTtsUsageCharCount(sqlExecutor, FIRST_DAY_MILLISECONDS)).toBe(0);
  });
});

describe('resolveTtsFallbackDailyCharLimit', () => {
  it('uses the default without configuration', () => {
    expect(resolveTtsFallbackDailyCharLimit(createFakeApolloEnvironment())).toBe(
      TTS_FALLBACK_DEFAULT_DAILY_CHAR_LIMIT,
    );
  });

  it('honors a valid configured limit', () => {
    const environment = createFakeApolloEnvironment({
      TTS_FALLBACK_DAILY_CHAR_LIMIT: '1000',
    });
    expect(resolveTtsFallbackDailyCharLimit(environment)).toBe(1000);
  });

  it('falls back to the default on invalid configuration', () => {
    const environment = createFakeApolloEnvironment({
      TTS_FALLBACK_DAILY_CHAR_LIMIT: 'not-a-number',
    });
    expect(resolveTtsFallbackDailyCharLimit(environment)).toBe(
      TTS_FALLBACK_DEFAULT_DAILY_CHAR_LIMIT,
    );
  });
});

describe('shouldUseFallbackTts', () => {
  it('stays on Gemini below 80 percent of the limit', () => {
    const sqlExecutor = createQuotaSqlExecutor();
    const environment = createFakeApolloEnvironment({
      TTS_FALLBACK_DAILY_CHAR_LIMIT: '1000',
    });
    recordGeminiTtsUsageCharCount(sqlExecutor, 799, FIRST_DAY_MILLISECONDS);
    expect(shouldUseFallbackTts(sqlExecutor, environment, FIRST_DAY_MILLISECONDS)).toBe(
      false,
    );
  });

  it('switches to fallback at 80 percent of the limit', () => {
    const sqlExecutor = createQuotaSqlExecutor();
    const environment = createFakeApolloEnvironment({
      TTS_FALLBACK_DAILY_CHAR_LIMIT: '1000',
    });
    recordGeminiTtsUsageCharCount(sqlExecutor, 800, FIRST_DAY_MILLISECONDS);
    expect(shouldUseFallbackTts(sqlExecutor, environment, FIRST_DAY_MILLISECONDS)).toBe(
      true,
    );
  });
});
