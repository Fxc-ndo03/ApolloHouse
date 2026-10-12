import type { GeminiChatResult, GeminiToolCall } from '@/voice/llm';

export const WORKERS_AI_LLM_MODEL = '@cf/meta/llama-3.2-1b-instruct';
export const WORKERS_AI_LLM_TIMEOUT_MILLISECONDS = 30_000;

function rejectAfterTimeout(
  timeoutMilliseconds: number,
  message: string,
): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    setTimeout(() => reject(new Error(message)), timeoutMilliseconds);
  });
}

function mapMessageListForWorkersAi(
  messageList: readonly {
    readonly role: string;
    readonly content: string | null;
  }[],
): { role: string; content: string }[] {
  const mapped: { role: string; content: string }[] = [];
  for (const message of messageList) {
    if (message.role === 'system') {
      mapped.push({ role: 'system', content: message.content ?? '' });
    } else if (message.role === 'user') {
      mapped.push({ role: 'user', content: message.content ?? '' });
    } else if (message.role === 'assistant') {
      mapped.push({ role: 'assistant', content: message.content ?? '' });
    }
    // Skip tool messages — Workers AI 1B doesn't support function calling
  }
  return mapped;
}

export async function chatWithWorkersAi(input: {
  readonly environment: Env;
  readonly messageList: readonly {
    readonly role: string;
    readonly content: string | null;
  }[];
  readonly onTextDelta?: (deltaText: string) => void;
  readonly fetchImplementation?: typeof fetch;
  readonly request_id?: string;
}): Promise<GeminiChatResult> {
  const requestId = input.request_id ?? 'unknown';
  const workersAi = input.environment.AI;
  if (workersAi === undefined) {
    throw new Error('Workers AI binding no disponible');
  }

  const messages = mapMessageListForWorkersAi(input.messageList);
  if (messages.length === 0) {
    throw new Error('Workers AI recibió mensajeList vacío');
  }

  const startTime = Date.now();
  console.log(
    JSON.stringify({
      level: 'debug',
      message: '[worker-debug] workersai_start',
      request_id: requestId,
      model: WORKERS_AI_LLM_MODEL,
      messageCount: messages.length,
    }),
  );

  let text = '';
  try {
    const result = await Promise.race([
      workersAi.run(
        WORKERS_AI_LLM_MODEL,
        { messages },
        {
          streaming: input.onTextDelta !== undefined,
        },
      ),
      rejectAfterTimeout(
        WORKERS_AI_LLM_TIMEOUT_MILLISECONDS,
        'Workers AI LLM tardó demasiado',
      ),
    ]);

    const elapsed = Date.now() - startTime;
    const text = await result.text();
    console.log(
      JSON.stringify({
        level: 'debug',
        message: '[worker-debug] workersai_end',
        request_id: requestId,
        elapsedMs: elapsed,
        model: WORKERS_AI_LLM_MODEL,
        textLength: text.length,
      }),
    );

    if (input.onTextDelta !== undefined) {
      const reader = result.body?.getReader();
      if (reader) {
        const decoder = new TextDecoder();
        let fullText = '';
        let buffer = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';
          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.length === 0) continue;
            try {
              const chunk = JSON.parse(trimmed) as { response?: string };
              if (typeof chunk.response === 'string') {
                fullText += chunk.response;
                input.onTextDelta(chunk.response);
              }
            } catch {
              // Non-JSON trailing data, skip
            }
          }
        }
        return { text: fullText.trim(), toolCallList: [] };
      }
    }

    return { text: text.trim(), toolCallList: [] };
  } catch (error) {
    const elapsed = Date.now() - startTime;
    console.error(
      JSON.stringify({
        level: 'error',
        message: 'WorkersAI_LLM_error',
        request_id: requestId,
        elapsedMs: elapsed,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    throw error;
  }
}
