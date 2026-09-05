import type { JsonSerializableValue, ToolDefinition } from '@/tools/types';
import {
  buildGeminiSystemPrompt as buildGeminiSystemPromptImpl,
  chatWithGemini as chatWithGeminiImpl,
} from '@/voice/gemini';

export type GeminiToolCall = {
  readonly id: string;
  readonly name: string;
  readonly args: JsonSerializableValue;
};

export type GeminiChatMessage =
  | { readonly role: 'system'; readonly content: string }
  | { readonly role: 'user'; readonly content: string }
  | {
      readonly role: 'assistant';
      readonly content: string | null;
      readonly tool_calls?: readonly {
        readonly id: string;
        readonly type: 'function';
        readonly function: {
          readonly name: string;
          readonly arguments: string;
        };
      }[];
    }
  | {
      readonly role: 'tool';
      readonly tool_call_id: string;
      readonly content: string;
    };

export type GeminiChatResult = {
  readonly text: string;
  readonly toolCallList: readonly GeminiToolCall[];
};

export function buildGeminiSystemPrompt(input: {
  readonly soulSystemPrompt: string;
  readonly memoryContentList: readonly string[];
  readonly isFocusActive: boolean;
}): string {
  return buildGeminiSystemPromptImpl(input);
}

export function buildSemanticMemoryPromptNote(
  semanticMemoryContentList: readonly string[],
): string {
  if (semanticMemoryContentList.length === 0) {
    return '';
  }
  const semanticMemoryBlock = semanticMemoryContentList
    .map((content) => `- ${content}`)
    .join('\n');
  return `\n\nRecall semántico (Vectorize):\n${semanticMemoryBlock}`;
}

export async function chatWithGemini(input: {
  readonly geminiApiKey: string;
  readonly modelId: string;
  readonly messageList: readonly GeminiChatMessage[];
  readonly toolDefinitionList?: readonly Pick<
    ToolDefinition,
    'name' | 'description' | 'parameters'
  >[];
  readonly onTextDelta?: (deltaText: string) => void;
  readonly fetchImplementation?: typeof fetch;
}): Promise<GeminiChatResult> {
  const geminiApiKey = input.geminiApiKey;
  const geminiModelId = 'models/gemini-3.6-flash';
  return chatWithGeminiImpl({
    geminiApiKey,
    modelId: geminiModelId,
    messageList: input.messageList as unknown as {
      role: string;
      content: string | null;
    }[],
    toolDefinitionList: input.toolDefinitionList,
    onTextDelta: input.onTextDelta,
    fetchImplementation: input.fetchImplementation,
  }) as unknown as Promise<GeminiChatResult>;
}
