import type { Connection } from 'agents';
import type { Session } from 'agents/experimental/memory/session';

import type { ApolloState } from '@/agents/apollo';
import { APOLLO_TTS_VOICE } from '@/configuration/identity';
import { createInactiveDeskFocusState, tickDeskFocus } from '@/focus/logic';
import { isNamespacedMcpToolName } from '@/mcp/naming';
import {
  buildRecentTurnHistoryMessageList,
  buildSessionSystemPrompt,
} from '@/memory/session';
import type { MemorySqlExecutor } from '@/memory/store';
import { recallSemanticMemoryContent } from '@/memory/vector';
import { resolveDeskSpeechMode } from '@/persona/catalog';
import { resolveDeskFaceEmotion } from '@/persona/face';
import { buildInstalledToolPromptNote } from '@/persona/soul';
import {
  encodeServerToDeviceMessage,
  encodeServerToPcMessage,
  type ServerToDeviceMessage,
} from '@/protocol/schema';
import type { DeskUiMachine } from '@/session/machine';
import { buildTelemetryPromptNote, type DeskTelemetrySnapshot } from '@/telemetry/logic';
import { createBuiltinToolDefinitionMap } from '@/tools/catalog';
import type {
  DeskToolEffects,
  PendingToolConfirmation,
  ToolDefinition,
} from '@/tools/types';
import { runDeskTurn, type TurnInput, type VoiceAdapters } from '@/turn/run';
import { TTS_PCM_CHANNEL_COUNT, TTS_PCM_SAMPLE_RATE_HZ } from '@/voice/elevenlabs';
import { handleGeminiLiveTurn, isGeminiLiveAvailable } from '@/voice/geminiLive';
import {
  streamAudioChunksAtPlaybackPace,
  type PlaybackAckSnapshot,
} from '@/voice/stream';
import type { StorageBucket } from '@/storage/local';

type DeskUiStateDeviceMessage = Extract<ServerToDeviceMessage, { type: 'ui_state' }>;
type TtsStartDeviceMessage = Extract<ServerToDeviceMessage, { type: 'tts_start' }>;

type PlaybackPacingOptions = {
  prebufferMilliseconds?: number;
  shouldStop?: () => boolean;
  getPlaybackAck?: () => PlaybackAckSnapshot | null;
};

export type ApolloTurnRuntimeDependencies = {
  readonly environment: Env;
  readonly sqlExecutor: MemorySqlExecutor;
  readonly storageBucket: StorageBucket;
  readonly uiMachine: DeskUiMachine;
  readonly currentState: ApolloState;
  readonly getCurrentState: () => ApolloState;
  readonly setAgentState: (nextState: ApolloState) => void;
  readonly scheduleConfirmExpiry: (confirmationId: string) => Promise<void>;
  readonly persistPendingConfirmation: (
    confirmation: PendingToolConfirmation,
  ) => Promise<void>;
  readonly session: Session;
  readonly deviceId: string;
  readonly effects: DeskToolEffects;
  readonly toolDefinitionMap?: ReadonlyMap<string, ToolDefinition>;
  readonly isSpeechAborted?: () => boolean;
  readonly telemetrySnapshot?: DeskTelemetrySnapshot;
  readonly allocateTtsSequence?: () => number;
  readonly getPlaybackAckForSequence?: (sequence: number) => PlaybackAckSnapshot | null;
  readonly acquireGeminiToken: () => Promise<void>;
  readonly pcVisualConnection?: Connection;
};

export async function executeApolloTurn(
  connection: Connection,
  dependencies: ApolloTurnRuntimeDependencies,
  turnPart: {
    readonly text?: string;
    readonly audioBuffer?: ArrayBuffer;
    readonly confirmOk?: boolean;
    readonly pendingConfirmation?: PendingToolConfirmation;
  },
): Promise<void> {
  const nowMilliseconds = Date.now();
  const focusState = tickDeskFocus(
    dependencies.currentState.focusEndsAt === null
      ? createInactiveDeskFocusState()
      : {
          active: true,
          endsAt: dependencies.currentState.focusEndsAt,
        },
    nowMilliseconds,
  );

  const isMockVoice = dependencies.environment.MOCK_VOICE === '1';
  const sessionSystemPrompt = await buildSessionSystemPrompt(dependencies.session);
  const recentHistoryMessageList = await buildRecentTurnHistoryMessageList(
    dependencies.session,
  );
  const recallSemanticMemoryContentList = async (
    queryText: string,
  ): Promise<readonly string[]> =>
    recallSemanticMemoryContent({
      vectorizeIndex: dependencies.environment.VECTORIZE,
      geminiApiKey: dependencies.environment.GEMINI_API_KEY ?? '',
      geminiEmbeddingModelId:
        dependencies.environment.GEMINI_EMBEDDING_MODEL ?? 'models/text-embedding-004',
      queryText,
      deviceId: dependencies.deviceId,
    });

  const focusNote = focusState.active
    ? '\n\nFocus activo: evitá announces ruidosos; sé breve.'
    : '\n\nFocus inactivo.';
  const telemetryNote = buildTelemetryPromptNote(
    dependencies.telemetrySnapshot,
    nowMilliseconds,
  );
  const toolDefinitionMap =
    dependencies.toolDefinitionMap ?? createBuiltinToolDefinitionMap();
  const installedToolNote = buildInstalledToolPromptNote(
    [...toolDefinitionMap.keys()].filter((toolName) => isNamespacedMcpToolName(toolName)),
  );

  // Gemini Live: audio → Gemini → audio (bypass STT/LLM/TTS)
  if (
    !isMockVoice &&
    isGeminiLiveAvailable(dependencies.environment) &&
    turnPart.audioBuffer !== undefined &&
    turnPart.audioBuffer.byteLength >= 8000
  ) {
    console.log(
      JSON.stringify({ level: 'info', message: 'ApolloGemini: TURN_START gemini live' }),
    );
    const toolDefinitionList = [...toolDefinitionMap.values()].map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));
    const systemPrompt = `${sessionSystemPrompt}${focusNote}${telemetryNote}${installedToolNote}`;
    try {
      const geminiResult = await handleGeminiLiveTurn({
        audioBuffer: turnPart.audioBuffer,
        environment: dependencies.environment,
        systemPrompt,
        toolDefinitionList,
        toolDefinitionMap,
        nowMilliseconds,
        deviceId: dependencies.deviceId,
        effects: dependencies.effects,
        recentHistoryMessageList,
      });

      // Map Gemini result to TurnOutput for existing playback/messaging logic
      const geminiTurnOutput: import('@/turn/run').TurnOutput = {
        uiEventList: ['START_THINK', 'START_SPEAK', 'SPEAK_DONE'],
        transcript: geminiResult.transcript,
        spokenText: geminiResult.spokenText,
        ttsAudio:
          geminiResult.ttsAudio.byteLength > 0 ? geminiResult.ttsAudio : undefined,
        speechMode: dependencies.currentState.speechMode,
        focusState,
        memoryContentList: [],
        toolResultList: [],
        executedToolCallList: [],
        expectsReply: /(\?\s*$|\[\[escucho\]\])/i.test(geminiResult.spokenText),
      };

      // Reuse the same post-processing as runDeskTurn (ui, state, playback)
      // This duplicates the logic below but avoids refactoring runDeskTurn for now.
      // We will inline the same handling as for turnOutput.
      for (const uiEventName of geminiTurnOutput.uiEventList) {
        dependencies.uiMachine.transition(uiEventName);
      }
      const liveState = dependencies.getCurrentState();

      // Determine where to send audio/messages based on responseOutputTarget
      const responseOutputTarget =
        dependencies.currentState.responseOutputTarget ?? 'server';
      const targetConnection =
        responseOutputTarget === 'pc' && dependencies.pcVisualConnection
          ? dependencies.pcVisualConnection
          : connection;
      const isPcTarget =
        responseOutputTarget === 'pc' && dependencies.pcVisualConnection !== undefined;
      const encodeMessage = isPcTarget
        ? encodeServerToPcMessage
        : encodeServerToDeviceMessage;

      dependencies.setAgentState({
        ...liveState,
        uiState: dependencies.uiMachine.state,
        caption: geminiTurnOutput.spokenText,
        pendingConfirmId: null,
        pendingConfirmSummary: null,
        focusEndsAt: geminiTurnOutput.focusState.endsAt,
        focusStartedAt: liveState.focusStartedAt,
      });

      if (geminiTurnOutput.ttsAudio !== undefined) {
        const ttsSequence = dependencies.allocateTtsSequence?.();
        const ttsStartMessage: TtsStartDeviceMessage = {
          type: 'tts_start',
          format: 'pcm',
          bytes: geminiTurnOutput.ttsAudio.byteLength,
          sampleRate: TTS_PCM_SAMPLE_RATE_HZ,
          channels: TTS_PCM_CHANNEL_COUNT,
        };
        if (ttsSequence !== undefined) ttsStartMessage.sequence = ttsSequence;
        targetConnection.send(encodeMessage(ttsStartMessage));
        await streamAudioChunksAtPlaybackPace({
          audioBuffer: geminiTurnOutput.ttsAudio,
          sampleRateHz: TTS_PCM_SAMPLE_RATE_HZ,
          channelCount: TTS_PCM_CHANNEL_COUNT,
          send: (chunk) => targetConnection.send(chunk),
          shouldStop: dependencies.isSpeechAborted,
          getPlaybackAck: dependencies.getPlaybackAckForSequence
            ? () => {
                const seq = ttsSequence ?? 0;
                return dependencies.getPlaybackAckForSequence!(seq);
              }
            : undefined,
        });
        if (dependencies.isSpeechAborted?.() === true) {
          targetConnection.send(encodeMessage({ type: 'tts_aborted' }));
        } else {
          targetConnection.send(encodeMessage({ type: 'tts_end' }));
        }
      }

      targetConnection.send(
        encodeMessage({
          type: 'turn_end',
          expectsReply: geminiTurnOutput.expectsReply,
        }),
      );

      if (geminiTurnOutput.transcript.length > 0) {
        await dependencies.session.appendMessage({
          id: crypto.randomUUID(),
          role: 'user',
          parts: [{ type: 'text', text: geminiTurnOutput.transcript }],
          createdAt: new Date(),
        });
        await dependencies.session.appendMessage({
          id: crypto.randomUUID(),
          role: 'assistant',
          parts: [{ type: 'text', text: geminiTurnOutput.spokenText }],
          createdAt: new Date(),
        });
      }
      return;
    } catch (error) {
      console.error(
        JSON.stringify({
          level: 'error',
          message: 'ApolloGemini: TURN_FAILED falling back to regular Gemini path',
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      // Fall through to regular Gemini path
    }
  }

  const voiceAdapters: VoiceAdapters = isMockVoice
    ? {
        stt: async () => turnPart.text ?? 'hola',
        llm: async ({ messageList }) => {
          const userMessage = messageList.findLast((message) => message.role === 'user');
          const userText = userMessage?.role === 'user' ? userMessage.content : '';
          return {
            text: `Mock: ${userText}`,
            toolCallList: [],
          };
        },
        tts: async (text) => encodeMockSpeechAudio(text),
      }
    : {
        stt: async (audioBuffer) => {
          await dependencies.acquireGeminiToken();
          const { transcribeAudioWithGemini } = await import('@/voice/gemini');
          return transcribeAudioWithGemini({
            audioBuffer,
            geminiApiKey: dependencies.environment.GEMINI_API_KEY ?? '',
            modelId:
              dependencies.environment.GEMINI_STT_MODEL ?? 'models/gemini-2.0-flash',
          });
        },
        llm: async ({ messageList, toolDefinitionList, onTextDelta }) => {
          await dependencies.acquireGeminiToken();
          const { chatWithGemini } = await import('@/voice/gemini');
          return chatWithGemini({
            geminiApiKey: dependencies.environment.GEMINI_API_KEY ?? '',
            modelId: dependencies.environment.GEMINI_MODEL ?? 'models/gemini-3.6-flash',
            messageList: messageList as unknown as {
              role: string;
              content: string | null;
            }[],
            toolDefinitionList,
            onTextDelta,
          });
        },
        tts: async (text) => {
          const { synthesizeWithGemini } = await import('@/voice/gemini');
          return synthesizeWithGemini({
            text,
            geminiApiKey: dependencies.environment.GEMINI_API_KEY ?? '',
            modelId:
              dependencies.environment.GEMINI_TTS_MODEL ??
              'models/gemini-2.5-flash-preview-tts',
          });
        },
      };

  const baseTurnInput: TurnInput = {
    text: turnPart.text,
    audioBuffer: turnPart.audioBuffer,
    speechMode: dependencies.currentState.speechMode,
    focusState,
    sqlExecutor: dependencies.sqlExecutor,
    environment: dependencies.environment,
    toolDefinitionMap,
    pendingConfirmation: turnPart.pendingConfirmation,
    confirmOk: turnPart.confirmOk,
    nowMilliseconds,
    deviceId: dependencies.deviceId,
    systemPromptOverride: `${sessionSystemPrompt}${focusNote}${telemetryNote}${installedToolNote}`,
    recentHistoryMessageList,
    effects: dependencies.effects,
    onThinkingCaption: async (caption) => {
      const liveState = dependencies.getCurrentState();
      dependencies.setAgentState({
        ...liveState,
        uiState: 'thinking',
        caption,
      });
      const thinkingUiStateMessage: DeskUiStateDeviceMessage = {
        type: 'ui_state',
        state: 'thinking',
        speechMode: liveState.speechMode,
        caption,
        emotion: resolveDeskFaceEmotion('thinking'),
        accentColor: resolveDeskSpeechMode(liveState.speechMode).accentColor,
      };
      if (liveState.focusEndsAt !== null) {
        thinkingUiStateMessage.focusRemainingSec = Math.max(
          0,
          Math.ceil((liveState.focusEndsAt - Date.now()) / 1000),
        );
        thinkingUiStateMessage.focusEndsAt = Math.floor(liveState.focusEndsAt / 1000);
        if (liveState.focusStartedAt !== null) {
          thinkingUiStateMessage.focusStartedAt = Math.floor(
            liveState.focusStartedAt / 1000,
          );
        }
      }
      connection.send(encodeServerToDeviceMessage(thinkingUiStateMessage));
    },
    adapters: voiceAdapters,
  };
  const turnOutput = await runDeskTurn(
    isMockVoice ? baseTurnInput : { ...baseTurnInput, recallSemanticMemoryContentList },
  );

  for (const uiEventName of turnOutput.uiEventList) {
    dependencies.uiMachine.transition(uiEventName);
  }

  if (turnOutput.pendingConfirmation !== undefined) {
    // Persisted before confirm_request goes out below: the device can answer
    // the moment the screen appears, while the TTS at the bottom of this
    // function is still streaming, and #resolveConfirm must find it by then.
    await dependencies.persistPendingConfirmation(turnOutput.pendingConfirmation);
    await dependencies.scheduleConfirmExpiry(turnOutput.pendingConfirmation.id);
  }

  // `set_focus`/`clear_focus` tool effects (see @/agents/effects) may have
  // updated focusEndsAt on the live agent state mid-turn, ahead of the
  // uiEventList replay above. Reconcile against that live value instead of
  // the pre-turn snapshot so the tool's change isn't clobbered below, while
  // still honoring the tick-based expiry computed into turnOutput.focusState
  // when no focus tool ran this turn.
  const liveState = dependencies.getCurrentState();
  const focusChangedDuringTurn =
    liveState.focusEndsAt !== dependencies.currentState.focusEndsAt;
  const finalFocusEndsAt = focusChangedDuringTurn
    ? liveState.focusEndsAt
    : turnOutput.focusState.endsAt;
  const isFocusActiveNow =
    finalFocusEndsAt !== null && finalFocusEndsAt > nowMilliseconds;

  if (isFocusActiveNow && dependencies.uiMachine.state !== 'focus') {
    dependencies.uiMachine.transition('ENTER_FOCUS');
  } else if (!isFocusActiveNow && dependencies.uiMachine.state === 'focus') {
    dependencies.uiMachine.transition('EXIT_FOCUS');
  }

  dependencies.setAgentState({
    ...liveState,
    uiState: dependencies.uiMachine.state,
    caption: turnOutput.spokenText,
    pendingConfirmId: turnOutput.pendingConfirmation?.id ?? null,
    pendingConfirmSummary: turnOutput.pendingConfirmation?.summary ?? null,
    focusEndsAt: finalFocusEndsAt,
    focusStartedAt: finalFocusEndsAt === null ? null : liveState.focusStartedAt,
  });

  // Determine where to send audio based on responseOutputTarget
  const responseOutputTarget = dependencies.currentState.responseOutputTarget ?? 'server';
  const audioTargetConnection =
    responseOutputTarget === 'pc' && dependencies.pcVisualConnection
      ? dependencies.pcVisualConnection
      : connection;
  const isPcAudioTarget =
    responseOutputTarget === 'pc' && dependencies.pcVisualConnection !== undefined;
  const encodeAudioMessage = isPcAudioTarget
    ? encodeServerToPcMessage
    : encodeServerToDeviceMessage;

  // Confirm request and play_effect always go to the device (UI interactions)
  if (turnOutput.pendingConfirmation !== undefined) {
    connection.send(encodeServerToDeviceMessage({ type: 'play_effect', name: 'chime' }));
    connection.send(
      encodeServerToDeviceMessage({
        type: 'confirm_request',
        id: turnOutput.pendingConfirmation.id,
        summary: turnOutput.pendingConfirmation.summary,
        expiresAt: turnOutput.pendingConfirmation.expiresAt,
      }),
    );
  }

  let speechWasAborted = false;
  if (turnOutput.ttsAudio !== undefined) {
    const followUpSegmentTextList = turnOutput.ttsFollowUpSegmentTextList ?? [];
    let currentAudioBuffer: ArrayBuffer | undefined = turnOutput.ttsAudio;
    let followUpIndex = 0;
    let wasAborted = false;

    const synthesizeFollowUpSegmentAudio = async (
      segmentText: string,
    ): Promise<ArrayBuffer | undefined> => {
      try {
        return await voiceAdapters.tts(segmentText, APOLLO_TTS_VOICE);
      } catch (synthesisError) {
        console.error(
          JSON.stringify({
            level: 'error',
            message: 'apollo_tts_follow_up_segment_failed',
            error:
              synthesisError instanceof Error
                ? synthesisError.message
                : String(synthesisError),
          }),
        );
        return undefined;
      }
    };

    while (currentAudioBuffer !== undefined) {
      // The next segment renders while this one plays, so synthesis latency
      // hides behind the paced stream instead of gapping the speech. A failed
      // follow-up just ends the reply early — the turn already committed.
      const nextAudioBufferPromise =
        followUpIndex < followUpSegmentTextList.length
          ? synthesizeFollowUpSegmentAudio(followUpSegmentTextList[followUpIndex])
          : undefined;
      const isFirstSegment = followUpIndex === 0;
      followUpIndex += 1;
      const ttsSequence = dependencies.allocateTtsSequence?.();

      const ttsStartMessage: TtsStartDeviceMessage = {
        type: 'tts_start',
        format: 'pcm',
        bytes: currentAudioBuffer.byteLength,
        sampleRate: TTS_PCM_SAMPLE_RATE_HZ,
        channels: TTS_PCM_CHANNEL_COUNT,
      };
      if (ttsSequence !== undefined) {
        ttsStartMessage.sequence = ttsSequence;
      }
      audioTargetConnection.send(encodeAudioMessage(ttsStartMessage));

      const getPlaybackAckForSequence = dependencies.getPlaybackAckForSequence;
      const playbackPacingOptions: PlaybackPacingOptions = {};
      if (!isFirstSegment) {
        // Follow-up segments land on a device that is still draining the
        // previous one, so the full 2 s burst would risk the same queue
        // overflow the pacing exists to avoid; a small allowance only
        // covers network jitter.
        playbackPacingOptions.prebufferMilliseconds = 500;
      }
      if (dependencies.isSpeechAborted !== undefined) {
        playbackPacingOptions.shouldStop = dependencies.isSpeechAborted;
      }
      if (ttsSequence !== undefined && getPlaybackAckForSequence !== undefined) {
        playbackPacingOptions.getPlaybackAck = () =>
          getPlaybackAckForSequence(ttsSequence);
      }
      await streamAudioChunksAtPlaybackPace({
        audioBuffer: currentAudioBuffer,
        sampleRateHz: TTS_PCM_SAMPLE_RATE_HZ,
        channelCount: TTS_PCM_CHANNEL_COUNT,
        send: (audioChunk) => {
          audioTargetConnection.send(audioChunk);
        },
        ...playbackPacingOptions,
      });

      if (dependencies.isSpeechAborted?.() === true) {
        wasAborted = true;
        break;
      }
      audioTargetConnection.send(encodeAudioMessage({ type: 'tts_end' }));
      currentAudioBuffer = await nextAudioBufferPromise;
    }

    if (wasAborted) {
      // The device counts bytes against what tts_start promised to know when
      // speech ends, and that total will never arrive now.
      audioTargetConnection.send(encodeAudioMessage({ type: 'tts_aborted' }));
    }
    speechWasAborted = wasAborted;
  }

  // turn_end goes to the audio target (where the audio was sent)
  audioTargetConnection.send(
    encodeAudioMessage({
      type: 'turn_end',
      expectsReply: turnOutput.expectsReply && !speechWasAborted,
    }),
  );

  if (turnOutput.transcript.length > 0) {
    await dependencies.session.appendMessage({
      id: crypto.randomUUID(),
      role: 'user',
      parts: [{ type: 'text', text: turnOutput.transcript }],
      createdAt: new Date(),
    });
    await dependencies.session.appendMessage({
      id: crypto.randomUUID(),
      role: 'assistant',
      parts: [
        { type: 'text', text: turnOutput.spokenText },
        ...turnOutput.executedToolCallList.map((executedToolCall) => ({
          type: 'tool-call',
          toolName: executedToolCall.name,
          output: executedToolCall.summary,
        })),
      ],
      createdAt: new Date(),
    });
  }
}

function encodeMockSpeechAudio(spokenText: string): ArrayBuffer {
  const encodedSpokenTextBytes = new TextEncoder().encode(spokenText);
  const mockSpeechAudioBuffer = new ArrayBuffer(encodedSpokenTextBytes.byteLength);
  new Uint8Array(mockSpeechAudioBuffer).set(encodedSpokenTextBytes);
  return mockSpeechAudioBuffer;
}

export function concatenateArrayBufferList(
  arrayBufferList: readonly ArrayBuffer[],
): ArrayBuffer {
  const totalByteLength = arrayBufferList.reduce(
    (sum, buffer) => sum + buffer.byteLength,
    0,
  );
  const mergedBytes = new Uint8Array(totalByteLength);
  let offset = 0;
  for (const buffer of arrayBufferList) {
    mergedBytes.set(new Uint8Array(buffer), offset);
    offset += buffer.byteLength;
  }
  return mergedBytes.buffer;
}
