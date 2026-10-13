import { z } from 'zod';

import type { JsonSerializableValue, ToolDefinition } from '@/tools/types';

export type GeminiChatMessage =
  | { role: 'user'; parts: { text: string }[] }
  | {
      role: 'model';
      parts: (
        | { text: string }
        | { functionCall: { name: string; args: JsonSerializableValue } }
      )[];
    }
  | {
      role: 'tool';
      parts: { functionResponse: { name: string; response: JsonSerializableValue } }[];
    };

export type GeminiChatResult = {
  readonly text: string;
  readonly toolCallList: readonly {
    id: string;
    name: string;
    args: JsonSerializableValue;
    thoughtSignature?: string;
  }[];
  readonly hadAvailabilityRetry?: boolean;
  /** Tokens reales reportados por el proveedor; undefined = desconocido. */
  readonly usage?: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly totalTokens: number;
  };
};

export class GeminiQuotaExceededError extends Error {
  readonly status: number;

  constructor(status: number, detail: string) {
    super(`Gemini falló con status ${status}: ${detail.slice(0, 500)}`);
    this.name = 'GeminiQuotaExceededError';
    this.status = status;
  }
}

export function isGeminiQuotaExceededError(error: unknown): boolean {
  return error instanceof GeminiQuotaExceededError;
}

export class GeminiSttQuotaExceededError extends Error {
  readonly status: number;

  constructor(status: number, detail: string) {
    super(`Gemini STT falló ${status}: ${detail.slice(0, 500)}`);
    this.name = 'GeminiSttQuotaExceededError';
    this.status = status;
  }
}

export function isGeminiSttQuotaExceededError(error: unknown): boolean {
  return error instanceof GeminiSttQuotaExceededError;
}

export class GeminiTtsQuotaExceededError extends Error {
  readonly status: number;

  constructor(status: number, detail: string) {
    super(`Gemini TTS falló ${status}: ${detail.slice(0, 500)}`);
    this.name = 'GeminiTtsQuotaExceededError';
    this.status = status;
  }
}

export function isGeminiTtsQuotaExceededError(error: unknown): boolean {
  return error instanceof GeminiTtsQuotaExceededError;
}

export function needsThoughtSignatureRetry(result: {
  readonly toolCallList: readonly { readonly thoughtSignature?: string }[];
}): boolean {
  return (
    result.toolCallList.length > 0 &&
    result.toolCallList.every((toolCall) => toolCall.thoughtSignature === undefined)
  );
}

const geminiGenerateContentResponseSchema = z.object({
  candidates: z
    .array(
      z.object({
        content: z
          .object({
            parts: z.array(
              z.object({
                text: z.string().optional(),
                functionCall: z
                  .object({
                    name: z.string(),
                    args: z.unknown().optional(),
                    thoughtSignature: z.string().optional(),
                  })
                  .optional(),
                inlineData: z
                  .object({
                    data: z.string(),
                    mimeType: z.string(),
                  })
                  .optional(),
              }),
            ),
          })
          .optional(),
      }),
    )
    .optional(),
  // FASE 2.4: contabilidad real. Gemini devuelve usageMetadata en
  // generateContent; si el modo streaming no lo trae, queda undefined
  // (desconocido) y NUNCA se infiere.
  usageMetadata: z
    .object({
      promptTokenCount: z.number().optional(),
      candidatesTokenCount: z.number().optional(),
      totalTokenCount: z.number().optional(),
    })
    .optional(),
});


/**
 * Tokens reales del proveedor; undefined = el proveedor no los reportó
 * (p. ej. streaming). Nunca se infieren de caracteres ni palabras.
 */
function resolveReportedUsage(
  payload: z.infer<typeof geminiGenerateContentResponseSchema>,
): GeminiChatResult['usage'] | undefined {
  const usageMetadata = payload.usageMetadata;
  if (usageMetadata === undefined) {
    return undefined;
  }
  const inputTokens = usageMetadata.promptTokenCount;
  const outputTokens = usageMetadata.candidatesTokenCount;
  const totalTokens = usageMetadata.totalTokenCount;
  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    totalTokens === undefined
  ) {
    return undefined;
  }
  return {
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    totalTokens: totalTokens ?? (inputTokens ?? 0) + (outputTokens ?? 0),
  };
}

export function buildGeminiSystemPrompt(input: {
  readonly soulSystemPrompt: string;
  readonly memoryContentList: readonly string[];
  readonly isFocusActive: boolean;
}): string {
  const memoryBlock =
    input.memoryContentList.length === 0
      ? 'Sin memorias relevantes.'
      : input.memoryContentList.map((c) => `- ${c}`).join('\n');
  const focusBlock = input.isFocusActive
    ? 'Focus activo: evitá announces ruidosos; sé breve.'
    : 'Focus inactivo.';
  return [
    input.soulSystemPrompt,
    '',
    'Memorias relevantes:',
    memoryBlock,
    '',
    focusBlock,
  ].join('\n');
}

export async function chatWithGemini(input: {
  readonly geminiApiKey: string;
  readonly modelId: string;
  readonly messageList: readonly {
    role: string;
    content: string | null;
    tool_calls?: readonly unknown[];
    tool_call_id?: string;
  }[];
  readonly toolDefinitionList?: readonly Pick<
    ToolDefinition,
    'name' | 'description' | 'parameters'
  >[];
  readonly onTextDelta?: (deltaText: string) => void;
  readonly fetchImplementation?: typeof fetch;
  readonly request_id?: string;
}): Promise<GeminiChatResult> {
  const requestId = input.request_id ?? 'unknown';
  const geminiStartMs = Date.now();
  if (input.geminiApiKey.length === 0) {
    throw new Error('GEMINI_API_KEY no configurado');
  }

  console.log(
    JSON.stringify({
      level: 'debug',
      message: '[worker-debug] gemini_llm_start',
      request_id: requestId,
      modelId: input.modelId,
      messageListLength: input.messageList.length,
    }),
  );

  // Build a map from tool_call_id to tool name for functionResponse (must be before geminiContents loop)
  const toolCallIdToName = new Map<string, string>();
  for (const msg of input.messageList) {
    const toolCalls = (
      msg as unknown as {
        tool_calls?: readonly { id: string; function: { name: string } }[];
      }
    ).tool_calls;
    if (toolCalls !== undefined) {
      for (const tc of toolCalls) toolCallIdToName.set(tc.id, tc.function.name);
    }
  }

  const geminiContents: unknown[] = [];
  let systemInstruction: unknown | undefined;

  for (const msg of input.messageList) {
    if (msg.role === 'system') {
      systemInstruction = { parts: [{ text: msg.content ?? '' }] };
      continue;
    }
    if (msg.role === 'user') {
      geminiContents.push({ role: 'user', parts: [{ text: msg.content ?? '' }] });
      continue;
    }
    if (msg.role === 'assistant') {
      const parts: unknown[] = [];
      if (msg.content !== null && msg.content.length > 0) {
        parts.push({ text: msg.content });
      }
      const toolCalls = (
        msg as unknown as {
          tool_calls?: readonly {
            id: string;
            function: { name: string; arguments: string; thoughtSignature?: string };
          }[];
        }
      ).tool_calls;
      if (toolCalls !== undefined) {
        for (const tc of toolCalls) {
          let args: JsonSerializableValue = {};
          try {
            args = JSON.parse(tc.function.arguments) as JsonSerializableValue;
          } catch {}
          const rebuiltCall: {
            name: string;
            args: JsonSerializableValue;
            thoughtSignature?: string;
          } = { name: tc.function.name, args };
          if (tc.function.thoughtSignature !== undefined) {
            rebuiltCall.thoughtSignature = tc.function.thoughtSignature;
          }
          console.log(
            JSON.stringify({
              level: 'info',
              message: 'ApolloGemini: TOOL_CALL_REPLAY',
              toolName: rebuiltCall.name,
              hasThoughtSignature: rebuiltCall.thoughtSignature !== undefined,
            }),
          );
          parts.push({ functionCall: rebuiltCall });
        }
      }
      if (parts.length > 0) {
        geminiContents.push({ role: 'model', parts });
      }
      continue;
    }
    if (msg.role === 'tool') {
      const toolMsg = msg as unknown as { tool_call_id: string; content: string };
      let response: JsonSerializableValue = {};
      try {
        response = JSON.parse(toolMsg.content) as JsonSerializableValue;
      } catch {
        response = { result: toolMsg.content } as unknown as JsonSerializableValue;
      }
      const toolName = toolCallIdToName.get(toolMsg.tool_call_id) ?? toolMsg.tool_call_id;
      geminiContents.push({
        // La API v1beta solo acepta roles user/model: el resultado de una
        // tool va como functionResponse dentro de un content rol 'user'.
        role: 'user',
        parts: [{ functionResponse: { name: toolName, response } }],
      });
      continue;
    }
    // Fallback: treat as user
    geminiContents.push({
      role: 'user',
      parts: [{ text: (msg.content as string) ?? '' }],
    });
  }

  const tools =
    input.toolDefinitionList !== undefined && input.toolDefinitionList.length > 0
      ? [
          {
            functionDeclarations: input.toolDefinitionList.map((t) => ({
              name: t.name,
              description: t.description,
              parameters: t.parameters,
            })),
          },
        ]
      : undefined;

  const isStreaming = input.onTextDelta !== undefined;
  const baseUrl = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(input.modelId)}`;
  const url = isStreaming
    ? `${baseUrl}:streamGenerateContent?key=${encodeURIComponent(input.geminiApiKey)}&alt=sse`
    : `${baseUrl}:generateContent?key=${encodeURIComponent(input.geminiApiKey)}`;

  // Diagnóstico: loguear URL sin secretos
  const sanitizedBaseUrl = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(input.modelId ?? 'gemini-3.6-flash')}:generateContent`;
  console.log(
    JSON.stringify({
      level: 'info',
      message: 'Gemini LLM request',
      url: sanitizedBaseUrl,
      streaming: isStreaming,
      modelId: input.modelId,
      toolsCount: tools?.length ?? 0,
    }),
  );

  const body: Record<string, unknown> = {
    contents: geminiContents,
  };
  if (systemInstruction !== undefined) body.systemInstruction = systemInstruction;
  if (tools !== undefined) body.tools = tools;

  const fetchImpl = input.fetchImplementation ?? globalThis.fetch;

  // Retry con backoff exponencial para 429 (rate limit)
  const maxRetries = 3;
  let lastError: Error | null = null;
  let availabilityRetried = false;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Connection: 'keep-alive',
      },
      body: JSON.stringify(body),
    });

    if (response.ok) {
      if (isStreaming) {
        const streamedResult = await consumeGeminiStream(response, input.onTextDelta!);
        const geminiElapsedMs = Date.now() - geminiStartMs;
        console.log(
          JSON.stringify({
            level: 'debug',
            message: '[worker-debug] gemini_llm_end',
            request_id: requestId,
            elapsedMs: geminiElapsedMs,
            textLength: streamedResult.text.length,
            toolCallCount: streamedResult.toolCallList.length,
          }),
        );
        return { ...streamedResult, hadAvailabilityRetry: availabilityRetried };
      }

      const payload = geminiGenerateContentResponseSchema.parse(await response.json());
      const candidate = payload.candidates?.[0];
      const parts = candidate?.content?.parts ?? [];
      let text = '';
      const toolCallList: {
        id: string;
        name: string;
        args: JsonSerializableValue;
        thoughtSignature?: string;
      }[] = [];
      for (const part of parts) {
        if (part.text !== undefined) text += part.text;
        if (part.functionCall !== undefined) {
          const toolCall: {
            id: string;
            name: string;
            args: JsonSerializableValue;
            thoughtSignature?: string;
          } = {
            id: crypto.randomUUID(),
            name: part.functionCall.name,
            args: (part.functionCall.args ?? {}) as JsonSerializableValue,
          };
          if (typeof part.functionCall.thoughtSignature === 'string') {
            toolCall.thoughtSignature = part.functionCall.thoughtSignature;
          }
          console.log(
            JSON.stringify({
              level: 'info',
              message: 'ApolloGemini: TOOL_CALL_RECEIVED',
              toolName: toolCall.name,
              hasThoughtSignature: toolCall.thoughtSignature !== undefined,
            }),
          );
          toolCallList.push(toolCall);
        }
      }
      const geminiElapsedMs = Date.now() - geminiStartMs;
      console.log(
        JSON.stringify({
          level: 'debug',
          message: '[worker-debug] gemini_llm_end',
          request_id: requestId,
          elapsedMs: geminiElapsedMs,
          textLength: text.trim().length,
          toolCallCount: toolCallList.length,
        }),
      );
      return {
        text: text.trim(),
        toolCallList,
        hadAvailabilityRetry: availabilityRetried,
        usage: resolveReportedUsage(payload),
      };
    }

    const detail = await response.text().catch(() => '');
    console.error(
      JSON.stringify({
        level: 'error',
        message: 'Gemini LLM error response',
        status: response.status,
        url: new URL(url).host,
        detail: detail.slice(0, 500),
        attempt: attempt + 1,
      }),
    );

    // Si es 429 (rate limit) o 503 (servicio no disponible temporalmente), reintentar con backoff exponencial
    if ((response.status === 429 || response.status === 503) && attempt < maxRetries) {
      availabilityRetried = true;
      const retryAfterMs =
        parseRetryAfter(response.headers.get('retry-after')) ??
        1000 * Math.pow(2, attempt);
      console.log(
        JSON.stringify({
          level: 'warn',
          message: `Gemini LLM rate limited/unavailable, retrying in ${retryAfterMs}ms (attempt ${attempt + 1}/${maxRetries})`,
        }),
      );
      await sleep(retryAfterMs);
      continue;
    }

    if (response.status === 429) {
      lastError = new GeminiQuotaExceededError(response.status, detail);
    } else {
      lastError = new Error(
        `Gemini falló con status ${response.status}: ${detail.slice(0, 500)}`,
      );
    }
    break; // No reintentar en otros errores
  }

  throw lastError ?? new Error('Gemini LLM falló tras reintentos');
}

async function consumeGeminiStream(
  response: Response,
  onTextDelta: (delta: string) => void,
): Promise<GeminiChatResult> {
  const reader = response.body?.getReader();
  if (reader === undefined) throw new Error('Gemini stream sin body');
  let fullText = '';
  const toolCalls: {
    id: string;
    name: string;
    args: JsonSerializableValue;
    thoughtSignature?: string;
  }[] = [];
  let buffer = '';
  const decoder = new TextDecoder();

  const handleData = (dataText: string) => {
    try {
      const chunk = JSON.parse(dataText);
      const candidates = chunk.candidates ?? [];
      for (const cand of candidates) {
        const parts = cand.content?.parts ?? [];
        for (const part of parts) {
          if (part.text !== undefined && part.text.length > 0) {
            fullText += part.text;
            onTextDelta(part.text);
          }
          if (part.functionCall !== undefined) {
            const streamedCall: {
              id: string;
              name: string;
              args: JsonSerializableValue;
              thoughtSignature?: string;
            } = {
              id: crypto.randomUUID(),
              name: part.functionCall.name,
              args: (part.functionCall.args ?? {}) as JsonSerializableValue,
            };
            if (typeof part.functionCall.thoughtSignature === 'string') {
              streamedCall.thoughtSignature = part.functionCall.thoughtSignature;
            }
            console.log(
              JSON.stringify({
                level: 'info',
                message: 'ApolloGemini: TOOL_CALL_RECEIVED',
                toolName: streamedCall.name,
                hasThoughtSignature: streamedCall.thoughtSignature !== undefined,
              }),
            );
            toolCalls.push(streamedCall);
          }
        }
      }
    } catch {}
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data: ') || trimmed === 'data: [DONE]') continue;
      handleData(trimmed.slice('data: '.length));
    }
  }
  buffer += decoder.decode();
  if (buffer.trim().length > 0 && buffer.trim().startsWith('data: ')) {
    handleData(buffer.trim().slice('data: '.length));
  }

  return { text: fullText.trim(), toolCallList: toolCalls };
}

function encodePcmForGemini(pcmBuffer: ArrayBuffer): string {
  const bytes = new Uint8Array(pcmBuffer);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

export async function transcribeAudioWithGemini(input: {
  readonly audioBuffer: ArrayBuffer;
  readonly geminiApiKey: string;
  readonly modelId?: string;
  readonly fetchImplementation?: typeof fetch;
}): Promise<string> {
  if (input.geminiApiKey.length === 0) {
    throw new Error('GEMINI_API_KEY no configurado');
  }
  const model = input.modelId ?? 'models/gemini-3.6-flash';
  const base64Audio = encodePcmForGemini(input.audioBuffer);
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(input.geminiApiKey)}`;

  // Diagnóstico: loguear URL sin secretos
  const sanitizedBaseUrl = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  console.log(
    JSON.stringify({
      level: 'info',
      message: 'Gemini STT request',
      url: sanitizedBaseUrl,
      model,
      audioBytes: input.audioBuffer.byteLength,
    }),
  );

  const fetchImpl = input.fetchImplementation ?? globalThis.fetch;

  // Retry con backoff exponencial para 429 (rate limit)
  const maxRetries = 3;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Connection: 'keep-alive',
      },
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [
              { inlineData: { data: base64Audio, mimeType: 'audio/pcm;rate=16000' } },
              { text: 'Transcribe español, solo el texto.' },
            ],
          },
        ],
      }),
    });

    if (response.ok) {
      const payload = geminiGenerateContentResponseSchema.parse(await response.json());
      const text =
        payload.candidates?.[0]?.content?.parts
          ?.map((p) => p.text ?? '')
          .join('')
          .trim() ?? '';
      if (text.length === 0) throw new Error('Gemini STT vacío');
      return text;
    }

    const detail = await response.text().catch(() => '');
    console.error(
      JSON.stringify({
        level: 'error',
        message: 'Gemini STT error response',
        status: response.status,
        url: new URL(url).host,
        detail: detail.slice(0, 500),
        attempt: attempt + 1,
      }),
    );

    // Si es 429 (rate limit) o 503 (servicio no disponible temporalmente), reintentar con backoff exponencial
    if ((response.status === 429 || response.status === 503) && attempt < maxRetries) {
      const retryAfterMs =
        parseRetryAfter(response.headers.get('retry-after')) ??
        1000 * Math.pow(2, attempt);
      console.log(
        JSON.stringify({
          level: 'warn',
          message: `Gemini STT rate limited/unavailable, retrying in ${retryAfterMs}ms (attempt ${attempt + 1}/${maxRetries})`,
        }),
      );
      await sleep(retryAfterMs);
      continue;
    }

    if (response.status === 429) {
      lastError = new GeminiSttQuotaExceededError(response.status, detail);
    } else {
      lastError = new Error(
        `Gemini STT falló ${response.status}: ${detail.slice(0, 500)}`,
      );
    }
    break; // No reintentar en otros errores
  }

  throw lastError ?? new Error('Gemini STT falló tras reintentos');
}

function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const seconds = parseInt(header, 10);
  if (!isNaN(seconds)) return seconds * 1000;
  // Try parsing as HTTP date
  const date = new Date(header);
  if (!isNaN(date.getTime())) return Math.max(0, date.getTime() - Date.now());
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function synthesizeWithGemini(input: {
  readonly text: string;
  readonly geminiApiKey: string;
  readonly modelId?: string;
  readonly fetchImplementation?: typeof fetch;
}): Promise<ArrayBuffer> {
  // Gemini Live already returns audio; for non-live TTS we use generateContent with audio modality
  const model = input.modelId ?? 'models/gemini-2.5-flash-tts';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(input.geminiApiKey)}`;

  // Diagnóstico: loguear URL sin secretos
  const sanitizedBaseUrl = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  console.log(
    JSON.stringify({
      level: 'info',
      message: 'Gemini TTS request',
      url: sanitizedBaseUrl,
      model,
      textLength: input.text.length,
    }),
  );

  const fetchImpl = input.fetchImplementation ?? globalThis.fetch;

  // Retry con backoff exponencial para 429/503
  const maxRetries = 3;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Connection: 'keep-alive',
      },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: input.text }] }],
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Puck' } } },
        },
      }),
    });

    if (response.ok) {
      const payload = geminiGenerateContentResponseSchema.parse(await response.json());
      const candidates = payload.candidates ?? [];
      console.log(
        JSON.stringify({
          level: 'info',
          message: 'Gemini TTS response',
          candidatesCount: candidates.length,
          partsCount: candidates[0]?.content?.parts?.length ?? 0,
          partTypes:
            candidates[0]?.content?.parts?.map(
              (p: { inlineData?: { mimeType?: string }; text?: string }) =>
                p.inlineData !== undefined
                  ? `inlineData:${p.inlineData.mimeType}`
                  : 'text',
            ) ?? [],
        }),
      );
      const parts = candidates[0]?.content?.parts ?? [];
      for (const part of parts) {
        const inlineData = (
          part as unknown as { inlineData?: { data: string; mimeType: string } }
        ).inlineData;
        if (inlineData !== undefined && inlineData.mimeType.startsWith('audio/')) {
          const binary = atob(inlineData.data);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
          return bytes.buffer as ArrayBuffer;
        }
        if (part.text !== undefined) {
          console.warn(
            JSON.stringify({
              level: 'warn',
              message: 'Gemini TTS returned text instead of audio',
              textLength: part.text.length,
            }),
          );
          return new TextEncoder().encode(part.text).buffer as ArrayBuffer;
        }
      }
      throw new Error('Gemini TTS no devolvió audio');
    }

    const detail = await response.text().catch(() => '');
    console.error(
      JSON.stringify({
        level: 'error',
        message: 'Gemini TTS error response',
        status: response.status,
        url: new URL(url).host,
        detail: detail.slice(0, 500),
        attempt: attempt + 1,
      }),
    );

    // Si es 429 (rate limit) o 503 (servicio no disponible temporalmente), reintentar con backoff exponencial
    if ((response.status === 429 || response.status === 503) && attempt < maxRetries) {
      const retryAfterMs =
        parseRetryAfter(response.headers.get('retry-after')) ??
        1000 * Math.pow(2, attempt);
      console.log(
        JSON.stringify({
          level: 'warn',
          message: `Gemini TTS rate limited/unavailable, retrying in ${retryAfterMs}ms (attempt ${attempt + 1}/${maxRetries})`,
        }),
      );
      await sleep(retryAfterMs);
      continue;
    }

    if (response.status === 429) {
      lastError = new GeminiTtsQuotaExceededError(response.status, detail);
    } else {
      lastError = new Error(
        `Gemini TTS falló ${response.status}: ${detail.slice(0, 500)}`,
      );
    }
    break; // No reintentar en otros errores
  }

  throw lastError ?? new Error('Gemini TTS falló tras reintentos');
}
