import { APOLLO_TTS_VOICE } from '@/configuration/identity';
import type { DeskFocusState } from '@/focus/logic';
import { recallMemoryRecords, type MemorySqlExecutor } from '@/memory/store';
import { buildCurrentTimePromptNote } from '@/persona/clock';
import { buildApolloSoulPrompt } from '@/persona/soul';
import type { DeskUiEventName } from '@/session/machine';
import { resolvePendingToolConfirmation } from '@/tools/router';
import { executeToolWithTargetResolution } from '@/tools/target';
import {
  buildCancellationResult,
  buildCancellationToolResult,
  type CancellationReason,
} from '@/tools/cancellation';
import { resolveCapabilityForToolName } from '@/tools/capability-index';
import type { CapabilityTargetResolver } from '@/devices/target';
import type {
  DeskToolEffects,
  PendingToolConfirmation,
  ToolDefinition,
  ToolExecutionResult,
} from '@/tools/types';
import { mapToolNameToThinkingCaption } from '@/turn/caption';
import {
  buildGeminiSystemPrompt,
  buildSemanticMemoryPromptNote,
  type GeminiChatMessage,
  type GeminiToolCall,
} from '@/voice/llm';
import { sanitizeTextForSpeech } from '@/voice/sanitize';
import { splitTextIntoSpeechSegmentList } from '@/voice/segment';

const DEFAULT_MAX_TOOL_ROUND_COUNT = 3;

export type LanguageModelToolDescriptor = {
  readonly name: string;
  readonly description: string;
  readonly parameters: ToolDefinition['parameters'];
};

export type VoiceAdapters = {
  readonly stt: (audioBuffer: ArrayBuffer) => Promise<string>;
  readonly llm: (input: {
    readonly messageList: readonly GeminiChatMessage[];
    readonly toolDefinitionList: readonly LanguageModelToolDescriptor[];
    // Optional streaming hook: adapters that support it push content deltas
    // as they arrive so the turn can start synthesizing speech early.
    readonly onTextDelta?: (deltaText: string) => void;
  }) => Promise<{
    readonly text: string;
    readonly toolCallList: readonly GeminiToolCall[];
  }>;
  readonly tts: (text: string, voiceId: string) => Promise<ArrayBuffer>;
};

export type TurnInput = {
  readonly audioBuffer?: ArrayBuffer;
  readonly text?: string;
  readonly request_id?: string;
  readonly client_turn_id?: string;
  // BLOCK 6.2.1: ancla de correlación para los eventos de TTS de cancelación.
  readonly generation?: number;
  // Nombres expuestos al LLM (domain routing). undefined = catálogo completo.
  // El mapa de EJECUCION (input.toolDefinitionMap) queda siempre completo.
  readonly exposedToolNames?: readonly string[];
  // BLOCK 6.1: el LLM usa el mismo pipeline de target que el router
  // determinista. Ausente = sin registry, la tool se ejecuta como antes.
  readonly resolveCapabilityTarget?: CapabilityTargetResolver;
  readonly speechMode: string;
  readonly focusState: DeskFocusState;
  readonly sqlExecutor: MemorySqlExecutor;
  readonly environment: Env;
  readonly adapters: VoiceAdapters;
  readonly toolDefinitionMap: ReadonlyMap<string, ToolDefinition>;
  readonly pendingConfirmation?: PendingToolConfirmation;
  readonly confirmOk?: boolean;
  readonly nowMilliseconds: number;
  readonly deviceId?: string;
  readonly systemPromptOverride?: string;
  readonly recentHistoryMessageList?: readonly GeminiChatMessage[];
  readonly recallSemanticMemoryContentList?: (
    queryText: string,
  ) => Promise<readonly string[]>;
  readonly effects?: DeskToolEffects;
  readonly maxToolRoundCount?: number;
  readonly onThinkingCaption?: (caption: string) => void | Promise<void>;
};

export type TurnOutput = {
  readonly uiEventList: readonly DeskUiEventName[];
  readonly transcript: string;
  readonly spokenText: string;
  readonly ttsAudio?: ArrayBuffer;
  readonly ttsAudioPromise?: Promise<ArrayBuffer | undefined>;
  // Segments after the first, still as text: the caller synthesizes them while
  // the device is already playing ttsAudio, hiding synthesis latency.
  readonly ttsFollowUpSegmentTextList?: readonly string[];
  readonly pendingConfirmation?: PendingToolConfirmation;
  readonly speechMode: string;
  readonly focusState: DeskFocusState;
  readonly memoryContentList: readonly string[];
  readonly toolResultList: readonly ToolExecutionResult[];
  readonly executedToolCallList: readonly {
    readonly name: string;
    readonly summary: string;
  }[];
  // Whether the reply asks the user for something, so the device should
  // reopen the mic after speaking instead of returning to idle.
  readonly expectsReply: boolean;
};

function buildToolDefinitionListFromMap(
  toolDefinitionMap: ReadonlyMap<string, ToolDefinition>,
  exposedToolNames?: readonly string[],
): readonly LanguageModelToolDescriptor[] {
  const exposedNameSet =
    exposedToolNames === undefined ? null : new Set(exposedToolNames);
  return [...toolDefinitionMap.values()]
    .filter(
      (toolDefinition) =>
        exposedNameSet === null || exposedNameSet.has(toolDefinition.name),
    )
    .map((toolDefinition) => ({
      name: toolDefinition.name,
      description: toolDefinition.description,
      parameters: toolDefinition.parameters,
    }));
}

function buildAssistantToolCallMessage(
  llmText: string,
  toolCallList: readonly GeminiToolCall[],
): GeminiChatMessage {
  return {
    role: 'assistant',
    content: llmText.trim().length > 0 ? llmText : null,
    tool_calls: toolCallList.map((toolCall) => ({
      id: toolCall.id,
      type: 'function' as const,
      function: {
        name: toolCall.name,
        arguments: JSON.stringify(toolCall.args),
        ...(toolCall.thoughtSignature !== undefined
          ? { thoughtSignature: toolCall.thoughtSignature }
          : {}),
      },
    })),
  };
}

function buildToolResultMessage(
  toolCallId: string,
  toolResult: ToolExecutionResult,
): GeminiChatMessage {
  return {
    role: 'tool',
    tool_call_id: toolCallId,
    content: JSON.stringify(toolResult),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Cancelación hablada (Block 6.2): una sola construcción de turno para todos
// los motivos. El caption y el TTS salen del MISMO string que produce el mapa
// central, así que no puede haber un texto hablado que no sea el del caption.
// ─────────────────────────────────────────────────────────────────────────────
// Sin `async` a propósito: la cancelación no puede volver a serializarse
// detrás de la síntesis. La promesa de audio se entrega al runtime como
// trabajo asíncrono del turno.
function buildSpokenCancellationTurn(input: {
  readonly input: TurnInput;
  readonly uiEventList: DeskUiEventName[];
  readonly transcript: string;
  readonly spokenText: string;
  readonly toolResultList: ToolExecutionResult[];
  readonly executedToolCallList: { name: string; summary: string }[];
}): TurnOutput {
  // Los anchors se capturan AHORA: la promesa puede resolverse más tarde y sus
  // eventos tienen que seguirority lb착 de este turno, nunca de otro.
  const requestId = input.input.request_id ?? null;
  const clientTurnId = input.input.client_turn_id ?? null;
  const generation = input.input.generation ?? null;
  console.log(
    JSON.stringify({
      level: 'debug',
      message: '[worker-debug] cancellation_tts_started',
      request_id: requestId,
      client_turn_id: clientTurnId,
      generation,
      textLength: input.spokenText.length,
    }),
  );
  const ttsAudioPromise = input.input.adapters
    .tts(input.spokenText, APOLLO_TTS_VOICE)
    .then((audioBuffer) => {
      console.log(
        JSON.stringify({
          level: 'debug',
          message: '[worker-debug] cancellation_tts_completed',
          request_id: requestId,
          client_turn_id: clientTurnId,
          generation,
          audioBytes: audioBuffer.byteLength,
        }),
      );
      return audioBuffer;
    })
    // Un fallo de TTS no cambia el resultado de la cancelación: el turno ya
    // está cerrado con su caption.
    .catch(() => undefined);
  return {
    uiEventList: input.uiEventList,
    transcript: input.transcript,
    spokenText: input.spokenText,
    speechMode: input.input.speechMode,
    focusState: input.input.focusState,
    memoryContentList: [],
    toolResultList: input.toolResultList,
    executedToolCallList: input.executedToolCallList,
    expectsReply: false,
    ttsAudioPromise,
  };
}

function emitCancellationTelemetry(input: {
  readonly reason: string;
  readonly retryable: boolean;
  readonly toolName: string;
  readonly capabilityName: string | null;
  readonly targetDeviceId: string | null;
  readonly targetDeviceType: string | null;
  readonly requestId: string;
  readonly clientTurnId: string | null;
  readonly phase: 'tool' | 'confirmation';
}): void {
  console.log(
    JSON.stringify({
      level: 'info',
      message: 'device_execution_cancelled',
      reason: input.reason,
      retryable: input.retryable,
      phase: input.phase,
      tool_name: input.toolName,
      capability: input.capabilityName,
      target_device_id: input.targetDeviceId,
      target_device_type: input.targetDeviceType,
      request_id: input.requestId,
      client_turn_id: input.clientTurnId,
      generation: null,
    }),
  );
}

export async function runDeskTurn(input: TurnInput): Promise<TurnOutput> {
  const requestId = input.request_id ?? 'unknown';
  const clientTurnId = input.client_turn_id ?? 'none';
  const turnStartMs = Date.now();
  console.log(
    JSON.stringify({
      level: 'debug',
      message: '[worker-debug] turn_start',
      request_id: requestId,
      client_turn_id: clientTurnId,
      textLength: input.text?.length ?? 0,
      hasAudio: input.audioBuffer !== undefined,
    }),
  );
  const uiEventList: DeskUiEventName[] = ['START_THINK'];
  const toolResultList: ToolExecutionResult[] = [];
  const executedToolCallList: { name: string; summary: string }[] = [];
  // Un registro por turno: qué tool yacanceló de forma no-retryable.
  const nonRetryableCancellationByToolName = new Map<
    string,
    ReturnType<typeof buildCancellationResult>
  >();
  let pendingConfirmation = input.pendingConfirmation;
  let resolvedConfirmation: PendingToolConfirmation | undefined;
  let resolvedConfirmationResult: ToolExecutionResult | undefined;

  if (pendingConfirmation !== undefined && input.confirmOk !== undefined) {
    console.log(
      JSON.stringify({
        level: 'debug',
        message: '[worker-debug] confirm_resolution_start',
        request_id: requestId,
      }),
    );
    const resolved = await resolvePendingToolConfirmation(
      input.toolDefinitionMap,
      pendingConfirmation,
      input.confirmOk,
      {
        environment: input.environment,
        nowMilliseconds: input.nowMilliseconds,
        deviceId: input.deviceId,
        effects: input.effects,
      },
      input.resolveCapabilityTarget,
    );
    const cancelledToolName = pendingConfirmation.toolName;
    const cancelledCapabilityName = resolveCapabilityForToolName(
      input.toolDefinitionMap,
      cancelledToolName,
    );
    const cancelledTargetDeviceId = pendingConfirmation.targetDeviceId ?? null;
    const cancelledTargetDeviceType = pendingConfirmation.targetDeviceType ?? null;
    if ('cancelled' in resolved) {
      pendingConfirmation = undefined;
      // Una sola ruta de cancelación: reason → mensaje → caption + TTS.
      const cancellation = buildCancellationResult(resolved.reason as CancellationReason);
      emitCancellationTelemetry({
        reason: cancellation.reason,
        retryable: cancellation.retryable,
        toolName: cancelledToolName,
        capabilityName: cancelledCapabilityName ?? null,
        targetDeviceId: cancelledTargetDeviceId,
        targetDeviceType: cancelledTargetDeviceType,
        requestId,
        clientTurnId: input.client_turn_id ?? null,
        phase: 'confirmation',
      });
      uiEventList.push('CANCEL');
      return buildSpokenCancellationTurn({
        input,
        uiEventList,
        transcript: input.text?.trim() ?? '',
        spokenText: cancellation.message,
        toolResultList,
        executedToolCallList,
      });
    }

    const approvedConfirmation = pendingConfirmation;
    pendingConfirmation = undefined;
    resolvedConfirmation = approvedConfirmation;
    resolvedConfirmationResult = resolved;
    executedToolCallList.push({
      name: approvedConfirmation?.toolName ?? resolvedConfirmationResult.summary,
      summary: resolved.summary,
    });
    toolResultList.push(resolved);
  }

  let userText = input.text?.trim() ?? '';
  if (userText.length === 0 && input.audioBuffer !== undefined) {
    userText = (await input.adapters.stt(input.audioBuffer)).trim();
  }
  if (userText.length === 0) {
    uiEventList.push('CANCEL');
    return {
      uiEventList,
      transcript: '',
      spokenText: 'No te escuché.',
      speechMode: input.speechMode,
      focusState: input.focusState,
      memoryContentList: [],
      toolResultList,
      executedToolCallList,
      expectsReply: false,
    };
  }

  await input.onThinkingCaption?.('Pensando…');

  const recalledMemoryList = await recallMemoryRecords(input.sqlExecutor, userText, 8);
  const keywordMemoryContentList = recalledMemoryList.map(
    (memoryRecord) => memoryRecord.content,
  );
  const semanticMemoryContentList =
    (await input.recallSemanticMemoryContentList?.(userText)) ?? [];
  const memoryContentList = [
    ...new Set([...semanticMemoryContentList, ...keywordMemoryContentList]),
  ];
  const systemPromptBase =
    input.systemPromptOverride === undefined
      ? buildGeminiSystemPrompt({
          soulSystemPrompt: buildApolloSoulPrompt(input.speechMode),
          memoryContentList,
          isFocusActive: input.focusState.active,
        })
      : input.systemPromptOverride +
        buildSemanticMemoryPromptNote(semanticMemoryContentList);
  const systemPrompt =
    systemPromptBase + buildCurrentTimePromptNote(input.nowMilliseconds);

  const toolDefinitionList = buildToolDefinitionListFromMap(
    input.toolDefinitionMap,
    input.exposedToolNames,
  );
  const toolExecutionContext = {
    environment: input.environment,
    nowMilliseconds: input.nowMilliseconds,
    deviceId: input.deviceId,
    effects: input.effects,
  };
  const maxToolRoundCount = input.maxToolRoundCount ?? DEFAULT_MAX_TOOL_ROUND_COUNT;

  const messageList: GeminiChatMessage[] = [
    { role: 'system', content: systemPrompt },
    ...(input.recentHistoryMessageList ?? []),
    { role: 'user', content: userText },
  ];
  if (resolvedConfirmation !== undefined && resolvedConfirmationResult !== undefined) {
    messageList.push(
      buildAssistantToolCallMessage('', [
        {
          id: resolvedConfirmation.id,
          name: resolvedConfirmation.toolName,
          args: resolvedConfirmation.args ?? null,
        },
      ]),
      buildToolResultMessage(resolvedConfirmation.id, resolvedConfirmationResult),
    );
  }

  let spokenText = '';

  const SPECULATIVE_TTS_MIN_CHARS = 60; // Start TTS after ~60 chars (was 280)

  // While the reply streams in, the first sentence-sized segment is closed as
  // soon as more text follows it — synthesis starts right then, overlapping
  // the rest of the generation. If the round turns out to be a tool call, the
  // speculation is discarded (its text was never going to be spoken).
  let speculativeSegment:
    | {
        readonly text: string;
        readonly audioPromise: Promise<ArrayBuffer | undefined>;
      }
    | undefined;
  let streamedRoundText = '';

  for (let toolRoundIndex = 0; toolRoundIndex < maxToolRoundCount; toolRoundIndex += 1) {
    streamedRoundText = '';
    console.log(
      JSON.stringify({
        level: 'debug',
        message: '[worker-debug] llm_start',
        request_id: requestId,
        toolRoundIndex,
        messageListLength: messageList.length,
      }),
    );
    const llmStartMs = Date.now();
    const llmResult = await input.adapters.llm({
      messageList,
      toolDefinitionList,
      onTextDelta: (deltaText) => {
        if (speculativeSegment !== undefined) {
          return;
        }
        streamedRoundText += deltaText;
        if (streamedRoundText.length <= SPECULATIVE_TTS_MIN_CHARS) {
          return;
        }
        const partialSegmentList = splitTextIntoSpeechSegmentList(
          sanitizeTextForSpeech(streamedRoundText),
        );
        if (partialSegmentList.length < 2) {
          return;
        }
        const firstClosedSegmentText = partialSegmentList[0];
        speculativeSegment = {
          text: firstClosedSegmentText,
          audioPromise: input.adapters
            .tts(firstClosedSegmentText, APOLLO_TTS_VOICE)
            .catch(() => undefined),
        };
      },
    });

    const llmElapsedMs = Date.now() - llmStartMs;
    console.log(
      JSON.stringify({
        level: 'debug',
        message: '[worker-debug] llm_end',
        request_id: requestId,
        toolRoundIndex,
        elapsedMs: llmElapsedMs,
        textLength: llmResult.text.length,
        toolCallCount: llmResult.toolCallList.length,
      }),
    );

    if (llmResult.toolCallList.length === 0) {
      spokenText = llmResult.text.trim();
      break;
    }

    speculativeSegment = undefined;

    messageList.push(
      buildAssistantToolCallMessage(llmResult.text, llmResult.toolCallList),
    );

    for (const toolCall of llmResult.toolCallList) {
      const toolStartMs = Date.now();
      // Una cancelación no-retryable es estructural: si el modelo la pide
      // otra vez en este turno, se le devuelve el mismo resultado sin tocar
      // ninguna tool. El retry lo decide el pipeline, no el modelo.
      const previousCancellation = nonRetryableCancellationByToolName.get(toolCall.name);
      if (previousCancellation !== undefined) {
        const repeatedResult = buildCancellationToolResult(previousCancellation);
        console.log(
          JSON.stringify({
            level: 'debug',
            message: '[worker-debug] tool_retry_suppressed',
            request_id: requestId,
            toolName: toolCall.name,
            reason: previousCancellation.reason,
          }),
        );
        toolResultList.push(repeatedResult);
        messageList.push(buildToolResultMessage(toolCall.id, repeatedResult));
        continue;
      }
      console.log(
        JSON.stringify({
          level: 'debug',
          message: '[worker-debug] tool_start',
          request_id: requestId,
          toolName: toolCall.name,
        }),
      );
      await input.onThinkingCaption?.(mapToolNameToThinkingCaption(toolCall.name));
      // Un solo camino de ejecución: el LLM no tiene un atajo que esquive la
      // resolución de target que usa el router determinista.
      const outcome = await executeToolWithTargetResolution({
        toolName: toolCall.name,
        args: toolCall.args,
        origin: 'llm',
        toolDefinitionMap: input.toolDefinitionMap,
        context: toolExecutionContext,
        resolver: input.resolveCapabilityTarget,
        correlation: {
          requestId,
          clientTurnId: input.client_turn_id ?? null,
        },
      });
      if (outcome.status === 'skipped') {
        const skippedResult = buildCancellationToolResult(outcome.cancellation);
        if (!outcome.cancellation.retryable) {
          nonRetryableCancellationByToolName.set(toolCall.name, outcome.cancellation);
        }
        emitCancellationTelemetry({
          reason: outcome.cancellation.reason,
          retryable: outcome.cancellation.retryable,
          toolName: toolCall.name,
          capabilityName: outcome.capabilityName ?? null,
          targetDeviceId: null,
          targetDeviceType: null,
          requestId,
          clientTurnId: input.client_turn_id ?? null,
          phase: 'tool',
        });
        toolResultList.push(skippedResult);
        executedToolCallList.push({
          name: toolCall.name,
          summary: skippedResult.summary,
        });
        messageList.push(buildToolResultMessage(toolCall.id, skippedResult));
        continue;
      }
      if (outcome.status === 'needs_confirm') {
        uiEventList.push('NEED_CONFIRM');
        return {
          uiEventList,
          transcript: userText,
          spokenText: outcome.pending.summary,
          pendingConfirmation: outcome.pending,
          speechMode: input.speechMode,
          focusState: input.focusState,
          memoryContentList,
          toolResultList,
          executedToolCallList,
          expectsReply: false,
        };
      }
      toolResultList.push(outcome.result);
      executedToolCallList.push({
        name: toolCall.name,
        summary: outcome.result.summary,
      });
      console.log(
        JSON.stringify({
          level: 'debug',
          message: '[worker-debug] tool_end',
          request_id: requestId,
          toolName: toolCall.name,
          elapsedMs: Date.now() - toolStartMs,
        }),
      );
      messageList.push(buildToolResultMessage(toolCall.id, outcome.result));
    }

    if (toolRoundIndex === maxToolRoundCount - 1) {
      spokenText = llmResult.text.trim();
    }
  }

  if (spokenText.length === 0) {
    spokenText = toolResultList.map((result) => result.summary).join(' ');
  }
  // The model appends [[escucho]] when its reply asks the user for something;
  // a reply that ends in a question counts even if the model forgot the mark.
  const hasListenMark = /\[\[escucho\]\]/i.test(spokenText);
  spokenText = spokenText.replace(/\s*\[\[escucho\]\]\s*/gi, ' ').trim();
  const expectsReply = hasListenMark || /\?\s*$/.test(spokenText);
  spokenText = sanitizeTextForSpeech(spokenText);

  const [firstSegmentText, ...ttsFollowUpSegmentTextList] =
    splitTextIntoSpeechSegmentList(spokenText);
  const targetFirstSegmentText = firstSegmentText ?? spokenText;

  uiEventList.push('START_SPEAK');
  const ttsStartMs = Date.now();
  const speculativeAudio =
    speculativeSegment !== undefined && speculativeSegment.text === targetFirstSegmentText
      ? await speculativeSegment.audioPromise
      : undefined;
  console.log(
    JSON.stringify({
      level: 'debug',
      message: '[worker-debug] tts_start',
      request_id: requestId,
      textLength: targetFirstSegmentText.length,
      hasSpeculativeAudio: speculativeAudio !== undefined,
    }),
  );
  const ttsAudioPromise =
    speculativeAudio !== undefined
      ? Promise.resolve(speculativeAudio)
      : input.adapters.tts(targetFirstSegmentText, APOLLO_TTS_VOICE);
  const turnElapsedMs = Date.now() - turnStartMs;
  console.log(
    JSON.stringify({
      level: 'debug',
      message: '[worker-debug] turn_end',
      request_id: requestId,
      elapsedMs: turnElapsedMs,
      transcriptLength: userText.length,
    }),
  );

  return {
    uiEventList,
    transcript: userText,
    spokenText,
    ttsAudio: undefined,
    ttsAudioPromise,
    ttsFollowUpSegmentTextList,
    speechMode: input.speechMode,
    focusState: input.focusState,
    memoryContentList,
    toolResultList,
    executedToolCallList,
    expectsReply,
  };
}
