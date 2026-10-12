import { z } from 'zod';

import { fetchWithTimeout } from '@/http/fetch';
import type { MemorySqlExecutor } from '@/memory/store';
import type { JsonSerializableValue } from '@/tools/types';
import type { GeminiChatMessage, GeminiChatResult, GeminiToolCall } from '@/voice/llm';
import { wrapPcmAsWavBuffer } from '@/voice/wav';

export const FALLBACK_STT_MODEL_ID = 'whisper-large-v3-turbo';

export const FALLBACK_FETCH_TIMEOUT_MILLISECONDS = 20_000;

export const LLM_QUOTA_DEFAULT_COOLDOWN_MILLISECONDS = 10 * 60 * 1000;

type LlmQuotaRow = {
  readonly failed_at: number;
};

function ensureLlmQuotaTable(sqlExecutor: MemorySqlExecutor): void {
  sqlExecutor.execute(
    'CREATE TABLE IF NOT EXISTS llm_quota_state (id INTEGER PRIMARY KEY CHECK (id = 1), failed_at INTEGER NOT NULL)',
  );
}

export function resolveLlmQuotaCooldownMilliseconds(environment: Env): number {
  const configuredCooldown = Number(environment.LLM_QUOTA_COOLDOWN_MS ?? '');
  if (Number.isFinite(configuredCooldown) && configuredCooldown > 0) {
    return configuredCooldown;
  }
  return LLM_QUOTA_DEFAULT_COOLDOWN_MILLISECONDS;
}

export function recordLlmQuotaFailure(
  sqlExecutor: MemorySqlExecutor,
  nowMilliseconds: number = Date.now(),
): void {
  ensureLlmQuotaTable(sqlExecutor);
  sqlExecutor.execute(
    'INSERT INTO llm_quota_state (id, failed_at) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET failed_at = excluded.failed_at',
    nowMilliseconds,
  );
}

export function clearLlmQuotaFailure(sqlExecutor: MemorySqlExecutor): void {
  ensureLlmQuotaTable(sqlExecutor);
  sqlExecutor.execute('DELETE FROM llm_quota_state WHERE id = 1');
}

export const LIVE_SKIP_CONSECUTIVE_FAILURES = 3;

export const LIVE_SKIP_DEFAULT_COOLDOWN_MILLISECONDS = 30 * 60 * 1000;

type LiveHealthRow = {
  readonly consecutive_failures: number;
  readonly failed_at: number;
};

function ensureLiveHealthTable(sqlExecutor: MemorySqlExecutor): void {
  sqlExecutor.execute(
    'CREATE TABLE IF NOT EXISTS live_health (id INTEGER PRIMARY KEY CHECK (id = 1), consecutive_failures INTEGER NOT NULL DEFAULT 0, failed_at INTEGER NOT NULL DEFAULT 0)',
  );
}

export function resolveLiveSkipCooldownMilliseconds(environment: Env): number {
  const configuredCooldown = Number(environment.LIVE_SKIP_COOLDOWN_MS ?? '');
  if (Number.isFinite(configuredCooldown) && configuredCooldown > 0) {
    return configuredCooldown;
  }
  return LIVE_SKIP_DEFAULT_COOLDOWN_MILLISECONDS;
}

export function recordLiveSetupFailure(
  sqlExecutor: MemorySqlExecutor,
  nowMilliseconds: number = Date.now(),
): void {
  ensureLiveHealthTable(sqlExecutor);
  const rowList = sqlExecutor.execute<LiveHealthRow>(
    'SELECT consecutive_failures, failed_at FROM live_health WHERE id = 1 LIMIT 1',
  );
  const consecutiveFailures = (rowList[0]?.consecutive_failures ?? 0) + 1;
  sqlExecutor.execute(
    'INSERT INTO live_health (id, consecutive_failures, failed_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET consecutive_failures = excluded.consecutive_failures, failed_at = excluded.failed_at',
    consecutiveFailures,
    nowMilliseconds,
  );
}

export function clearLiveSetupFailure(sqlExecutor: MemorySqlExecutor): void {
  ensureLiveHealthTable(sqlExecutor);
  sqlExecutor.execute('DELETE FROM live_health WHERE id = 1');
}

export function isLiveSkipActive(
  sqlExecutor: MemorySqlExecutor,
  environment: Env,
  nowMilliseconds: number = Date.now(),
): boolean {
  ensureLiveHealthTable(sqlExecutor);
  const rowList = sqlExecutor.execute<LiveHealthRow>(
    'SELECT consecutive_failures, failed_at FROM live_health WHERE id = 1 LIMIT 1',
  );
  const row = rowList[0];
  if (row === undefined) {
    return false;
  }
  return (
    row.consecutive_failures >= LIVE_SKIP_CONSECUTIVE_FAILURES &&
    nowMilliseconds - row.failed_at < resolveLiveSkipCooldownMilliseconds(environment)
  );
}

export function isLlmQuotaCooldownActive(
  sqlExecutor: MemorySqlExecutor,
  environment: Env,
  nowMilliseconds: number = Date.now(),
): boolean {
  ensureLlmQuotaTable(sqlExecutor);
  const rowList = sqlExecutor.execute<LlmQuotaRow>(
    'SELECT failed_at FROM llm_quota_state WHERE id = 1 LIMIT 1',
  );
  const failedAt = rowList[0]?.failed_at;
  if (failedAt === undefined) {
    return false;
  }
  return nowMilliseconds - failedAt < resolveLlmQuotaCooldownMilliseconds(environment);
}

const fallbackChatCompletionResponseSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({
          content: z.string().nullable().optional(),
          tool_calls: z
            .array(
              z.object({
                id: z.string(),
                function: z.object({
                  name: z.string(),
                  arguments: z.string(),
                }),
              }),
            )
            .optional(),
        }),
      }),
    )
    .optional(),
});

type FallbackToolDescriptor = {
  readonly name: string;
  readonly description: string;
  readonly parameters: unknown;
};

export function isLlmFallbackConfigured(environment: Env): boolean {
  return (
    (environment.LLM_FALLBACK_API_KEY ?? '').length > 0 &&
    (environment.LLM_FALLBACK_BASE_URL ?? '').length > 0 &&
    (environment.LLM_FALLBACK_MODEL ?? '').length > 0
  );
}

function mapMessageListToFallbackMessageList(
  messageList: readonly GeminiChatMessage[],
): unknown[] {
  return messageList.map((message) => {
    if (message.role === 'system') return { role: 'system', content: message.content };
    if (message.role === 'user') return { role: 'user', content: message.content };
    if (message.role === 'assistant') {
      const assistantMessage: Record<string, unknown> = {
        role: 'assistant',
        content: message.content ?? '',
      };
      if (message.tool_calls !== undefined && message.tool_calls.length > 0) {
        assistantMessage.tool_calls = message.tool_calls.map((toolCall) => ({
          id: toolCall.id,
          type: 'function',
          function: {
            name: toolCall.function.name,
            arguments: toolCall.function.arguments,
          },
        }));
      }
      return assistantMessage;
    }
    return {
      role: 'tool',
      tool_call_id: message.tool_call_id,
      content: message.content,
    };
  });
}

export async function chatWithFallbackLlm(input: {
  readonly environment: Env;
  readonly messageList: readonly GeminiChatMessage[];
  readonly toolDefinitionList?: readonly FallbackToolDescriptor[];
  readonly onTextDelta?: (deltaText: string) => void;
  readonly fetchImplementation?: typeof fetch;
  readonly fetchTimeoutMilliseconds?: number;
  readonly request_id?: string;
}): Promise<GeminiChatResult> {
  const requestId = input.request_id ?? 'unknown';
  const geminiStartMs = Date.now();
  const baseUrl = (input.environment.LLM_FALLBACK_BASE_URL ?? '').replace(/\/$/, '');
  const apiKey = input.environment.LLM_FALLBACK_API_KEY ?? '';
  const modelId = input.environment.LLM_FALLBACK_MODEL ?? '';
  if (baseUrl.length === 0 || apiKey.length === 0 || modelId.length === 0) {
    throw new Error('LLM_FALLBACK no configurado');
  }

  console.log(
    JSON.stringify({
      level: 'debug',
      message: '[worker-debug] fallback_llm_start',
      request_id: requestId,
      modelId,
    }),
  );

  const toolPayload =
    input.toolDefinitionList !== undefined && input.toolDefinitionList.length > 0
      ? input.toolDefinitionList.map((tool) => ({
          type: 'function',
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
          },
        }))
      : undefined;

  const requestBody: Record<string, unknown> = {
    model: modelId,
    messages: mapMessageListToFallbackMessageList(input.messageList),
  };
  if (toolPayload !== undefined) requestBody.tools = toolPayload;

  const response = await fetchWithTimeout({
    url: `${baseUrl}/chat/completions`,
    init: {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(requestBody),
    },
    fetchImplementation: input.fetchImplementation,
    timeoutMilliseconds:
      input.fetchTimeoutMilliseconds ?? FALLBACK_FETCH_TIMEOUT_MILLISECONDS,
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(
      `LLM fallback falló con status ${response.status}: ${detail.slice(0, 500)}`,
    );
  }

  const payload = fallbackChatCompletionResponseSchema.parse(await response.json());
  const fallbackMessage = payload.choices?.[0]?.message;
  const text = (fallbackMessage?.content ?? '').trim();
  const toolCallList: GeminiToolCall[] = [];
  for (const toolCall of fallbackMessage?.tool_calls ?? []) {
    let parsedArgs: GeminiToolCall['args'] = {};
    try {
      parsedArgs = JSON.parse(toolCall.function.arguments) as GeminiToolCall['args'];
    } catch {}
    toolCallList.push({
      id: toolCall.id,
      name: toolCall.function.name,
      args: stripDisallowedNullArgs(
        toolCall.function.name,
        parsedArgs,
        input.toolDefinitionList,
      ),
    });
  }
  console.log(
    JSON.stringify({
      level: 'info',
      message: 'ApolloGemini: LLM fallback respondió',
      model: modelId,
      toolCallCount: toolCallList.length,
      toolNameList: toolCallList.map((call) => call.name),
    }),
  );

  if (text.length > 0) input.onTextDelta?.(text);
  const fallbackElapsedMs = Date.now() - geminiStartMs;
  console.log(
    JSON.stringify({
      level: 'debug',
      message: '[worker-debug] fallback_llm_end',
      request_id: requestId,
      elapsedMs: fallbackElapsedMs,
      textLength: text.length,
      toolCallCount: toolCallList.length,
    }),
  );
  return { text, toolCallList };
}

function readRequiredList(parameters: unknown): readonly string[] {
  if (typeof parameters !== 'object' || parameters === null) {
    return [];
  }
  const required = (parameters as { required?: unknown }).required;
  if (!Array.isArray(required)) {
    return [];
  }
  return required.filter((entry: unknown): entry is string => typeof entry === 'string');
}

function stripDisallowedNullArgs(
  toolName: string,
  rawArgs: GeminiToolCall['args'],
  toolDefinitionList: readonly FallbackToolDescriptor[] | undefined,
): GeminiToolCall['args'] {
  if (typeof rawArgs !== 'object' || rawArgs === null || Array.isArray(rawArgs)) {
    return rawArgs;
  }
  const descriptor = toolDefinitionList?.find((tool) => tool.name === toolName);
  const requiredList = readRequiredList(descriptor?.parameters);
  let strippedAny = false;
  const cleanedArgs: Record<string, JsonSerializableValue> = {};
  for (const [key, value] of Object.entries(rawArgs)) {
    if (value === null && !requiredList.includes(key)) {
      strippedAny = true;
      continue;
    }
    cleanedArgs[key] = value;
  }
  return strippedAny ? cleanedArgs : rawArgs;
}

const fallbackTranscriptionResponseSchema = z.object({
  text: z.string(),
});

export async function transcribeWithFallbackStt(input: {
  readonly environment: Env;
  readonly audioBuffer: ArrayBuffer;
  readonly fetchImplementation?: typeof fetch;
  readonly fetchTimeoutMilliseconds?: number;
}): Promise<string> {
  const baseUrl = (input.environment.LLM_FALLBACK_BASE_URL ?? '').replace(/\/$/, '');
  const apiKey = input.environment.LLM_FALLBACK_API_KEY ?? '';
  if (baseUrl.length === 0 || apiKey.length === 0) {
    throw new Error('LLM_FALLBACK no configurado');
  }

  const wavBuffer = wrapPcmAsWavBuffer({ pcmBuffer: input.audioBuffer });
  const requestForm = new FormData();
  requestForm.append('file', new File([wavBuffer], 'audio.wav', { type: 'audio/wav' }));
  requestForm.append('model', FALLBACK_STT_MODEL_ID);
  requestForm.append('language', 'es');

  const response = await fetchWithTimeout({
    url: `${baseUrl}/audio/transcriptions`,
    init: {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: requestForm,
    },
    fetchImplementation: input.fetchImplementation,
    timeoutMilliseconds:
      input.fetchTimeoutMilliseconds ?? FALLBACK_FETCH_TIMEOUT_MILLISECONDS,
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(
      `STT fallback falló con status ${response.status}: ${detail.slice(0, 500)}`,
    );
  }

  const payload = fallbackTranscriptionResponseSchema.parse(await response.json());
  const text = payload.text.trim();
  if (text.length === 0) {
    throw new Error('STT fallback vacío');
  }
  return text;
}
