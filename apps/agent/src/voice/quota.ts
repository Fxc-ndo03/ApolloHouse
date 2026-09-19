import type { MemorySqlExecutor } from '@/memory/store';

export const TTS_FALLBACK_DEFAULT_DAILY_CHAR_LIMIT = 150000;

export const TTS_FALLBACK_USAGE_RATIO = 0.8;

type TtsUsageRow = {
  readonly char_count: number;
};

function buildTodayDayKey(nowMilliseconds: number): string {
  return new Date(nowMilliseconds).toISOString().slice(0, 10);
}

function ensureTtsUsageTable(sqlExecutor: MemorySqlExecutor): void {
  sqlExecutor.execute(
    'CREATE TABLE IF NOT EXISTS tts_usage (day TEXT PRIMARY KEY, char_count INTEGER NOT NULL DEFAULT 0)',
  );
}

export function resolveTtsFallbackDailyCharLimit(environment: Env): number {
  const configuredLimit = Number(environment.TTS_FALLBACK_DAILY_CHAR_LIMIT ?? '');
  if (Number.isFinite(configuredLimit) && configuredLimit > 0) {
    return configuredLimit;
  }
  return TTS_FALLBACK_DEFAULT_DAILY_CHAR_LIMIT;
}

export function readGeminiTtsUsageCharCount(
  sqlExecutor: MemorySqlExecutor,
  nowMilliseconds: number = Date.now(),
): number {
  ensureTtsUsageTable(sqlExecutor);
  const rowList = sqlExecutor.execute<TtsUsageRow>(
    'SELECT char_count FROM tts_usage WHERE day = ? LIMIT 1',
    buildTodayDayKey(nowMilliseconds),
  );
  return rowList[0]?.char_count ?? 0;
}

export function recordGeminiTtsUsageCharCount(
  sqlExecutor: MemorySqlExecutor,
  charCount: number,
  nowMilliseconds: number = Date.now(),
): void {
  if (charCount <= 0) {
    return;
  }
  ensureTtsUsageTable(sqlExecutor);
  sqlExecutor.execute(
    'INSERT INTO tts_usage (day, char_count) VALUES (?, ?) ON CONFLICT(day) DO UPDATE SET char_count = char_count + excluded.char_count',
    buildTodayDayKey(nowMilliseconds),
    charCount,
  );
}

export function shouldUseFallbackTts(
  sqlExecutor: MemorySqlExecutor,
  environment: Env,
  nowMilliseconds: number = Date.now(),
): boolean {
  const dailyLimit = resolveTtsFallbackDailyCharLimit(environment);
  const usedCharCount = readGeminiTtsUsageCharCount(sqlExecutor, nowMilliseconds);
  return usedCharCount >= dailyLimit * TTS_FALLBACK_USAGE_RATIO;
}
