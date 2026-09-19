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
  // Si el setup viene fallando (esta key no tiene Live), se salta directo
  // a la rama clásica hasta que expire el cooldown.
  if (
    !isMockVoice &&
    isGeminiLiveAvailable(dependencies.environment) &&
    turnPart.audioBuffer !== undefined &&
    turnPart.audioBuffer.byteLength >= 8000 &&
    (await shouldAttemptLiveTurn(dependencies))
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
      trackLiveOutcome(() =>
        clearLiveSetupFailure(dependencies.sqlExecutor),
      );
      return;
    } catch (error) {
      trackLiveOutcome(() =>
        recordLiveSetupFailure(dependencies.sqlExecutor),
      );
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
          const { transcribeAudioWithGemini, isGeminiSttQuotaExceededError } =
            await import('@/voice/gemini');
          const {
            isLlmFallbackConfigured,
            transcribeWithFallbackStt,
            isLlmQuotaCooldownActive,
          } = await import('@/voice/provider');
          const useFallbackStt = async (reason: string) => {
            console.log(
              JSON.stringify({ level: 'warn', message: reason }),
            );
            return transcribeWithFallbackStt({
              environment: dependencies.environment,
              audioBuffer,
            });
          };
          if (
            isLlmFallbackConfigured(dependencies.environment) &&
            isLlmQuotaCooldownActive(dependencies.sqlExecutor, dependencies.environment)
          ) {
            return useFallbackStt(
              'ApolloGemini: STT skipping Gemini, quota cooldown active',
            );
          }
          try {
            await dependencies.acquireGeminiToken();
            return await transcribeAudioWithGemini({
              audioBuffer,
              geminiApiKey: dependencies.environment.GEMINI_API_KEY ?? '',
              modelId:
                dependencies.environment.GEMINI_STT_MODEL ?? 'models/gemini-3.6-flash',
            });
          } catch (sttError) {
            if (
              isGeminiSttQuotaExceededError(sttError) &&
              isLlmFallbackConfigured(dependencies.environment)
            ) {
              return useFallbackStt(
                'ApolloGemini: STT_QUOTA_EXCEEDED using STT fallback for this turn',
              );
            }
            throw sttError;
          }
        },
        llm: async ({ messageList, toolDefinitionList, onTextDelta }) => {
          await dependencies.acquireGeminiToken();
          const {
            isLlmFallbackConfigured,
            chatWithFallbackLlm,
            isLlmQuotaCooldownActive,
            recordLlmQuotaFailure,
            clearLlmQuotaFailure,
          } = await import('@/voice/provider');
          const fallbackMessageList = messageList as unknown as Parameters<
            typeof chatWithFallbackLlm
          >[0]['messageList'];
          const useFallbackForTurn = async (reason: string) => {
            console.log(
              JSON.stringify({ level: 'warn', message: reason }),
            );
            return chatWithFallbackLlm({
              environment: dependencies.environment,
              messageList: fallbackMessageList,
              toolDefinitionList,
              onTextDelta,
            });
          };
          if (
            dependencies.environment.LLM_FALLBACK_FORCE === '1' &&
            isLlmFallbackConfigured(dependencies.environment)
          ) {
            return useFallbackForTurn(
              'ApolloGemini: LLM_FALLBACK_FORCE active, skipping Gemini for this turn',
            );
          }
          if (
            isLlmFallbackConfigured(dependencies.environment) &&
            isLlmQuotaCooldownActive(
              dependencies.sqlExecutor,
              dependencies.environment,
            )
          ) {
            return useFallbackForTurn(
              'ApolloGemini: quota cooldown active, skipping Gemini for this turn',
            );
          }
          const {
            chatWithGemini,
            isGeminiQuotaExceededError,
            needsThoughtSignatureRetry,
          } = await import('@/voice/gemini');
          const runGeminiLlm = (
            modelId: string,
            streamDeltas: boolean,
          ): Promise<Awaited<ReturnType<typeof chatWithGemini>>> =>
            chatWithGemini({
              geminiApiKey: dependencies.environment.GEMINI_API_KEY ?? '',
              modelId,
              messageList: messageList as unknown as {
                role: string;
                content: string | null;
              }[],
              toolDefinitionList,
              onTextDelta: streamDeltas ? onTextDelta : undefined,
            });
          const defaultModelId =
            dependencies.environment.GEMINI_MODEL ?? 'models/gemini-3.6-flash';
          try {
            let geminiResult = await runGeminiLlm(defaultModelId, true);
            if (
              needsThoughtSignatureRetry(geminiResult) &&
              !geminiResult.hadAvailabilityRetry
            ) {
              console.log(
                JSON.stringify({
                  level: 'warn',
                  message:
                    'ApolloGemini: TOOL_CALL sin firma, reintentando el request',
                }),
              );
              geminiResult = await runGeminiLlm(defaultModelId, false);
            }
            if (needsThoughtSignatureRetry(geminiResult)) {
              if (!isLlmFallbackConfigured(dependencies.environment)) {
                console.log(
                  JSON.stringify({
                    level: 'warn',
                    message:
                      'ApolloGemini: sin firma y sin fallback configurado, sigue el turno',
                  }),
                );
              } else {
                return useFallbackForTurn(
                  'ApolloGemini: sin firma de pensamiento, usando fallback para este turno',
                );
              }
            }
            trackQuotaOutcome(() =>
              clearLlmQuotaFailure(dependencies.sqlExecutor),
            );
            return geminiResult;
          } catch (llmError) {
            const isThoughtSig400 =
              llmError instanceof Error &&
              llmError.message.includes('thought_signature');
            if (isThoughtSig400 && isLlmFallbackConfigured(dependencies.environment)) {
              return useFallbackForTurn(
                'ApolloGemini: 400 sin firma (historial Groq→Gemini), usando fallback',
              );
            }
            if (isGeminiQuotaExceededError(llmError)) {
              trackQuotaOutcome(() =>
                recordLlmQuotaFailure(dependencies.sqlExecutor),
              );
              if (isLlmFallbackConfigured(dependencies.environment)) {
                return useFallbackForTurn(
                  'ApolloGemini: QUOTA_EXCEEDED using LLM fallback for this turn',
                );
              }
            }
            throw llmError;
          }
        },
        tts: async (text) => {
          const { shouldUseFallbackTts, recordGeminiTtsUsageCharCount } = await import(
            '@/voice/quota'
          );
          const { isWorkersAiTtsAvailable, synthesizeWithWorkersAi } = await import(
            '@/voice/fallback'
          );
          const tryWorkersAiTts = async (): Promise<ArrayBuffer | null> => {
            if (!isWorkersAiTtsAvailable(dependencies.environment)) {
              return null;
            }
            try {
              return await synthesizeWithWorkersAi({
                text,
                environment: dependencies.environment,
              });
            } catch (fallbackTtsError) {
              console.error(
                JSON.stringify({
                  level: 'error',
                  message: 'apollo_tts_fallback_failed, reintentando con Gemini',
                  error:
                    fallbackTtsError instanceof Error
                      ? fallbackTtsError.message
                      : String(fallbackTtsError),
                }),
              );
              return null;
            }
          };
          if (shouldUseFallbackTts(dependencies.sqlExecutor, dependencies.environment)) {
            const fallbackAudio = await tryWorkersAiTts();
            if (fallbackAudio !== null) {
              return fallbackAudio;
            }
          }
          const { synthesizeWithGemini, isGeminiTtsQuotaExceededError } = await import(
            '@/voice/gemini'
          );
          try {
            const geminiAudio = await synthesizeWithGemini({
              text,
              geminiApiKey: dependencies.environment.GEMINI_API_KEY ?? '',
              modelId:
                dependencies.environment.GEMINI_TTS_MODEL ??
                'models/gemini-2.5-flash-preview-tts',
            });
            recordGeminiTtsUsageCharCount(dependencies.sqlExecutor, text.length);
            return geminiAudio;
          } catch (ttsError) {
            if (isGeminiTtsQuotaExceededError(ttsError)) {
              console.log(
                JSON.stringify({
                  level: 'warn',
                  message:
                    'ApolloGemini: TTS_QUOTA_EXCEEDED using TTS fallback for this turn',
                }),
              );
              const fallbackAudio = await tryWorkersAiTts();
              if (fallbackAudio !== null) {
                return fallbackAudio;
              }
            }
            throw ttsError;
          }
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
function trackLiveOutcome(record: () => void): void {
  try {
    record();
  } catch (trackingError) {
    console.error(
      JSON.stringify({
        level: 'error',
        message: 'apollo_live_tracking_failed',
        error:
          trackingError instanceof Error ? trackingError.message : String(trackingError),
      }),
    );
  }
}

function trackQuotaOutcome(record: () => void): void {
  try {
    record();
  } catch (quotaError) {
    console.error(
      JSON.stringify({
        level: 'error',
        message: 'apollo_llm_quota_tracking_failed',
        error:
          quotaError instanceof Error ? quotaError.message : String(quotaError),
      }),
    );
  }
}
async function shouldAttemptLiveTurn(
  dependencies: Pick<ApolloTurnRuntimeDependencies, 'environment' | 'sqlExecutor'>,
): Promise<boolean> {
  try {
    const { isLiveSkipActive } = await import('@/voice/provider');
    if (isLiveSkipActive(dependencies.sqlExecutor, dependencies.environment)) {
      console.log(
        JSON.stringify({
          level: 'warn',
          message: 'ApolloGemini: live skip active (sin Live en esta key), usando rama clásica',
        }),
      );
      return false;
    }
    return true;
  } catch {
    return true;
  }
}

function encodeMockSpeechAudio(spokenText: string): ArrayBuffer {  const encodedSpokenTextBytes = new TextEncoder().encode(spokenText);
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
