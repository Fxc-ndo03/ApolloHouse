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
import {
  buildExposedToolNameList,
  filterExposedToolDefinitions,
  resolveToolDomain,
} from '@/tools/domain';
import { selectRouterToolRequest } from '@/tools/selection';
import {
  buildDeviceContextNote,
  buildEmptyReachableCapabilitySnapshot,
  filterToolByReachableDevice,
  type ReachableCapabilitySnapshot,
} from '@/devices/exposure';
import { resolveCapabilityIntent } from '@/devices/intent';
import { executeToolWithTargetResolution } from '@/tools/target';
import { buildCapabilityTimingLogLine } from '@/devices/events';
import type { CapabilityTargetResolver } from '@/devices/target';
import type {
  DeskToolEffects,
  PendingToolConfirmation,
  ToolDefinition,
} from '@/tools/types';
import { runDeskTurn, type TurnInput, type VoiceAdapters } from '@/turn/run';
import { TTS_PCM_CHANNEL_COUNT, TTS_PCM_SAMPLE_RATE_HZ } from '@/voice/elevenlabs';
import { handleGeminiLiveTurn, isGeminiLiveAvailable } from '@/voice/geminiLive';
import { routeDeterministic, type RouterOutcome } from '@/voice/router';
import { chatWithWorkersAi } from '@/voice/workersai';
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
  readonly accountId: string;
  /** FASE 2.4: tokens reales de Gemini por turno (si el proveedor los reporta). */
  readonly onGeminiUsage?: (usage: {
    readonly modelId: string;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly totalTokens: number;
  }) => void;
  readonly effects: DeskToolEffects;
  readonly loadToolDefinitionMap?: () => Promise<ReadonlyMap<string, ToolDefinition>>;
  // BLOCK 6: puerto de target selection. Ausente = el runtime se comporta como
  // antes (sin gate de target); presente = toda capability pasa por el registry.
  readonly resolveCapabilityTarget?: CapabilityTargetResolver;
  // BLOCK 11 §11/§13: qué devices están realmente conectados. Ausente = el
  // turno se comporta como antes (catálogo completo, sin contexto).
  readonly loadReachableCapabilitySnapshot?: () => Promise<ReachableCapabilitySnapshot>;
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
    readonly ttsConfig?: {
      provider?: string;
      voice?: string;
      language?: string;
      speed?: number;
    };
    readonly request_id?: string;
    readonly client_turn_id?: string;
    readonly generation?: number;
  },
): Promise<void> {
  const requestId = turnPart.request_id ?? 'unknown';
  const clientTurnId = turnPart.client_turn_id ?? 'none';
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
  const focusNote = focusState.active
    ? '\n\nFocus activo: evitá announces ruidosos; sed breve.'
    : '\n\nFocus inactivo.';
  const telemetryNote = buildTelemetryPromptNote(
    dependencies.telemetrySnapshot,
    nowMilliseconds,
  );

  // ── Pipeline: routing → tool selection → authorization → execution ──────
  // El router corre PRIMERO y con contexto mínimo. Todo lo caro (memoria
  // semántica, historial, prompt de sesión, descubrimiento MCP) se arma
  // después, solo si el turno no se resolvió aquí. Antes se armaba
  // todo antes de saber si el turno iba a ser determinista.
  const isDeterministicCandidate =
    turnPart.text !== undefined &&
    turnPart.text.trim().length > 0 &&
    turnPart.pendingConfirmation === undefined;

  // Tools que el router determinista puede pedir son TODOS builtin (ver
  // listRouterReachableToolNameList + buildTurnToolDefinitionMap: los builtins
  // ganan colisiones de nombre). Por eso el fast path usa el mapa builtin, sin
  // descubrir MCP ni leer settings: misma definición, cero I/O.
  if (isDeterministicCandidate) {
    const routerStartMs = Date.now();
    const routerOutcome = routeDeterministic(turnPart.text, new Date(nowMilliseconds));
    const routerElapsedMs = Date.now() - routerStartMs;

    if (routerOutcome.kind !== 'ai_needed') {
      logRouterDecision({
        requestId,
        clientTurnId,
        generation: turnPart.generation ?? null,
        deviceId: dependencies.deviceId,
        routeType: 'deterministic',
        routeKind: routerOutcome.kind,
        ...(routerOutcome.kind === 'pc_command'
          ? { commandType: routerOutcome.commandType }
          : {}),
        domain: routerOutcome.kind === 'pc_command' ? 'pc' : 'memory',
        confidence: 'high',
        toolCatalogSize: 1,
        fallbackUsed: false,
        routerElapsedMs,
      });
      return await executeDeterministicTurn({
        connection,
        dependencies,
        routerOutcome,
        userText: turnPart.text.trim(),
        toolDefinitionMap: createBuiltinToolDefinitionMap(),
        nowMilliseconds,
        requestId,
        clientTurnId,
        routerElapsedMs,
        generation: turnPart.generation,
      });
    }
  }

  // ── LLM path: acá sí se arma el contexto que el turno necesita ────────
  let cachedToolDefinitionMap: Promise<ReadonlyMap<string, ToolDefinition>> | undefined;
  const loadTurnToolDefinitionMap = (): Promise<ReadonlyMap<string, ToolDefinition>> =>
    (cachedToolDefinitionMap ??=
      dependencies.loadToolDefinitionMap?.() ??
      Promise.resolve(createBuiltinToolDefinitionMap()));

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
      accountId: dependencies.accountId,
    });

  // BLOCK 11 §11: una tool mobile sin teléfono conectado no se le ofrece al
  // modelo. Es UNA llamada al bridge y sirve para el filtro de tools y para
  // el contexto cross-device. Sin bridge, el snapshot es vacío y el turno se
  // comporta exactamente como antes.
  const reachableCapabilitySnapshot =
    (await dependencies.loadReachableCapabilitySnapshot?.()) ??
    buildEmptyReachableCapabilitySnapshot();
  const deviceContextNote = buildDeviceContextNote(
    dependencies.deviceId,
    reachableCapabilitySnapshot,
  );

  const toolDefinitionMap = await loadTurnToolDefinitionMap();
  const toolDefinitionMapWithReachableDevice = filterToolByReachableDevice(
    [...toolDefinitionMap.values()],
    reachableCapabilitySnapshot,
  );
  const installedToolNote = buildInstalledToolPromptNote(
    [...toolDefinitionMap.keys()].filter((toolName) => isNamespacedMcpToolName(toolName)),
  );

  let exposedToolNames: readonly string[] | undefined;
  if (isDeterministicCandidate) {
    const domainStartMs = Date.now();
    const domainResolution = resolveToolDomain(turnPart.text ?? '');
    const exposedNameList = buildExposedToolNameList(domainResolution);
    const exposedFilteredList = filterExposedToolDefinitions(
      [...toolDefinitionMap.values()],
      exposedNameList,
    );
    exposedToolNames =
      exposedNameList === null ? undefined : exposedFilteredList.map((tool) => tool.name);
    logRouterDecision({
      requestId,
      clientTurnId,
      generation: turnPart.generation ?? null,
      deviceId: dependencies.deviceId,
      routeType: 'llm',
      routeKind: 'ai_needed',
      domain: domainResolution.domain,
      confidence: domainResolution.confidence,
      toolCatalogSize: exposedToolNames?.length ?? toolDefinitionMap.size,
      fallbackUsed: exposedNameList === null,
      routerElapsedMs: Date.now() - domainStartMs,
    });
  }

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
    const toolDefinitionList = toolDefinitionMapWithReachableDevice.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));
    const systemPrompt = `${sessionSystemPrompt}${focusNote}${telemetryNote}${deviceContextNote}${installedToolNote}`;
    try {
      const geminiResult = await handleGeminiLiveTurn({
        audioBuffer: turnPart.audioBuffer,
        environment: dependencies.environment,
        systemPrompt,
        toolDefinitionList,
        toolDefinitionMap: new Map(
          toolDefinitionMapWithReachableDevice.map((toolDefinition) => [
            toolDefinition.name,
            toolDefinition,
          ]),
        ),
        nowMilliseconds,
        deviceId: dependencies.deviceId,
        effects: dependencies.effects,
        recentHistoryMessageList,
        request_id: requestId,
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
      trackLiveOutcome(() => clearLiveSetupFailure(dependencies.sqlExecutor));
      return;
    } catch (error) {
      trackLiveOutcome(() => recordLiveSetupFailure(dependencies.sqlExecutor));
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
          console.log(
            JSON.stringify({
              level: 'debug',
              message: '[worker-debug] llm_start',
              request_id: requestId,
              mode: 'mock',
            }),
          );
          const result = {
            text: `Mock: ${userText}`,
            toolCallList: [],
          };
          console.log(
            JSON.stringify({
              level: 'debug',
              message: '[worker-debug] llm_end',
              request_id: requestId,
              mode: 'mock',
              textLength: result.text.length,
            }),
          );
          return result;
        },
        tts: async (text) => {
          const result = encodeMockSpeechAudio(text);
          console.log(
            JSON.stringify({
              level: 'debug',
              message: '[worker-debug] tts_end',
              request_id: requestId,
              mode: 'mock',
              audioBytes: result.byteLength,
            }),
          );
          return result;
        },
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
            console.log(JSON.stringify({ level: 'warn', message: reason }));
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
          const llmStartMs = Date.now();
          console.log(
            JSON.stringify({
              level: 'debug',
              message: '[worker-debug] llm_start',
              request_id: requestId,
              mode: 'gemini',
              messageListLength: messageList.length,
            }),
          );

          // ── Workers AI fast path (Llama 3.2 1B) ──────────────────
          // Try Workers AI first for simple questions.  It's free,
          // runs on Cloudflare's edge, and returns in <1 s for short
          // prompts.  If the model is unavailable or returns empty, we
          // fall through to Gemini below.
          if (dependencies.environment.AI !== undefined) {
            try {
              const workersAiResult = await chatWithWorkersAi({
                environment: dependencies.environment,
                messageList: messageList as unknown as {
                  readonly role: string;
                  readonly content: string | null;
                }[],
                onTextDelta,
                request_id: requestId,
              });
              const workersAiElapsedMs = Date.now() - llmStartMs;
              console.log(
                JSON.stringify({
                  level: 'info',
                  message: 'WorkersAI_LLM_success',
                  elapsedMs: workersAiElapsedMs,
                  responseLength: workersAiResult.text.length,
                  toolCallCount: workersAiResult.toolCallList.length,
                }),
              );
              // Workers AI 1B doesn't support function calling, so if it
              // returned tool calls we ignore them and fall through to Gemini.
              if (
                workersAiResult.toolCallList.length === 0 &&
                workersAiResult.text.length > 0
              ) {
                return workersAiResult;
              }
              console.log(
                JSON.stringify({
                  level: 'info',
                  message: 'WorkersAI_LLM_no_useful_result, escalating to Gemini',
                  hasToolCalls: workersAiResult.toolCallList.length > 0,
                  hasText: workersAiResult.text.length > 0,
                }),
              );
            } catch (workersAiError) {
              console.log(
                JSON.stringify({
                  level: 'warn',
                  message: 'WorkersAI_LLM_failed, escalating to Gemini',
                  error:
                    workersAiError instanceof Error
                      ? workersAiError.message
                      : String(workersAiError),
                  elapsedMs: Date.now() - llmStartMs,
                }),
              );
            }
          }
          // ── End Workers AI path ───────────────────────────────────

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
            const llmElapsedMs = Date.now() - llmStartMs;
            console.log(
              JSON.stringify({
                level: 'debug',
                message: '[worker-debug] llm_end',
                request_id: requestId,
                mode: 'gemini',
                elapsedMs: llmElapsedMs,
                error: reason,
              }),
            );
            console.log(JSON.stringify({ level: 'warn', message: reason }));
            return chatWithFallbackLlm({
              environment: dependencies.environment,
              messageList: fallbackMessageList,
              toolDefinitionList,
              onTextDelta,
              request_id: requestId,
            });
          };
          if (
            dependencies.environment.LLM_FALLBACK_FORCE === '1' &&
            isLlmFallbackConfigured(dependencies.environment)
          ) {
            const llmElapsedMs = Date.now() - llmStartMs;
            console.log(
              JSON.stringify({
                level: 'debug',
                message: '[worker-debug] llm_end',
                request_id: requestId,
                mode: 'gemini',
                elapsedMs: llmElapsedMs,
                error: 'LLM_FALLBACK_FORCE',
              }),
            );
            return useFallbackForTurn(
              'ApolloGemini: LLM_FALLBACK_FORCE active, skipping Gemini for this turn',
            );
          }
          if (
            isLlmFallbackConfigured(dependencies.environment) &&
            isLlmQuotaCooldownActive(dependencies.sqlExecutor, dependencies.environment)
          ) {
            const llmElapsedMs = Date.now() - llmStartMs;
            console.log(
              JSON.stringify({
                level: 'debug',
                message: '[worker-debug] llm_end',
                request_id: requestId,
                mode: 'gemini',
                elapsedMs: llmElapsedMs,
                error: 'quota_cooldown',
              }),
            );
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
              request_id: requestId,
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
                  message: 'ApolloGemini: TOOL_CALL sin firma, reintentando el request',
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
            trackQuotaOutcome(() => clearLlmQuotaFailure(dependencies.sqlExecutor));
            // FASE 2.4: contabilidad real del proveedor. Si Gemini reportó
            // usageMetadata se entrega a la cuenta; si no, no se inventa nada.
            if (geminiResult.usage !== undefined) {
              dependencies.onGeminiUsage?.({
                modelId: defaultModelId,
                inputTokens: geminiResult.usage.inputTokens,
                outputTokens: geminiResult.usage.outputTokens,
                totalTokens: geminiResult.usage.totalTokens,
              });
            }
            const llmElapsedMs = Date.now() - llmStartMs;
            console.log(
              JSON.stringify({
                level: 'debug',
                message: '[worker-debug] llm_end',
                request_id: requestId,
                mode: 'gemini',
                elapsedMs: llmElapsedMs,
                textLength: geminiResult.text.length,
                toolCallCount: geminiResult.toolCallList.length,
              }),
            );
            return geminiResult;
          } catch (llmError) {
            const isThoughtSig400 =
              llmError instanceof Error && llmError.message.includes('thought_signature');
            if (isThoughtSig400 && isLlmFallbackConfigured(dependencies.environment)) {
              const llmElapsedMs = Date.now() - llmStartMs;
              console.log(
                JSON.stringify({
                  level: 'debug',
                  message: '[worker-debug] llm_end',
                  request_id: requestId,
                  mode: 'gemini',
                  elapsedMs: llmElapsedMs,
                  error: 'thought_sig_400_fallback',
                }),
              );
              return useFallbackForTurn(
                'ApolloGemini: 400 sin firma (historial Groq→Gemini), usando fallback',
              );
            }
            if (isGeminiQuotaExceededError(llmError)) {
              trackQuotaOutcome(() => recordLlmQuotaFailure(dependencies.sqlExecutor));
              if (isLlmFallbackConfigured(dependencies.environment)) {
                return useFallbackForTurn(
                  'ApolloGemini: QUOTA_EXCEEDED using LLM fallback for this turn',
                );
              }
            }
            throw llmError;
          }
        },
        tts: async (text, voiceId) => {
          const ttsConfig = turnPart.ttsConfig;
          const provider = ttsConfig?.provider ?? 'cloudflare';
          const voice = ttsConfig?.voice ?? voiceId ?? 'carina';
          const ttsStartMs = Date.now();
          console.log(
            JSON.stringify({
              level: 'debug',
              message: '[worker-debug] tts_start',
              request_id: requestId,
              textLength: text.length,
              provider,
              voice,
            }),
          );

          if (provider === 'cloudflare') {
            const {
              synthesizeWithAura2,
              AURA2_VOICE_LIST,
              isAura2QuotaExceededError,
              Aura2QuotaExceededError,
            } = await import('@/voice/aura2');
            const aura2Voice =
              AURA2_VOICE_LIST.find((v) => v.id === voice)?.id ?? 'carina';
            try {
              const result = await synthesizeWithAura2({
                text,
                voice: aura2Voice,
                environment: dependencies.environment,
              });
              console.log(
                JSON.stringify({
                  level: 'debug',
                  message: '[worker-debug] tts_end',
                  request_id: requestId,
                  elapsedMs: Date.now() - ttsStartMs,
                  audioBytes: result.byteLength,
                  provider: 'aura2',
                }),
              );
              return result;
            } catch (aura2Error) {
              if (isAura2QuotaExceededError(aura2Error)) {
                console.error(
                  JSON.stringify({
                    level: 'error',
                    message: 'apollo_tts_aura2_quota_exceeded_daily_limit_reached',
                  }),
                );
                console.log(
                  JSON.stringify({
                    level: 'debug',
                    message: '[worker-debug] tts_end',
                    request_id: requestId,
                    elapsedMs: Date.now() - ttsStartMs,
                    audioBytes: 0,
                    provider: 'aura2_quota_exceeded',
                  }),
                );
                return new ArrayBuffer(0);
              }
              console.error(
                JSON.stringify({
                  level: 'error',
                  message: 'apollo_tts_aura2_failed_falling_back_to_gemini',
                  error:
                    aura2Error instanceof Error ? aura2Error.message : String(aura2Error),
                }),
              );
            }
          }

          const { shouldUseFallbackTts, recordGeminiTtsUsageCharCount } =
            await import('@/voice/quota');
          const { isWorkersAiTtsAvailable, synthesizeWithWorkersAi } =
            await import('@/voice/fallback');
          const tryWorkersAiTts = async (): Promise<ArrayBuffer | null> => {
            if (!isWorkersAiTtsAvailable(dependencies.environment)) {
              return null;
            }
            try {
              const result = await synthesizeWithWorkersAi({
                text,
                environment: dependencies.environment,
              });
              console.log(
                JSON.stringify({
                  level: 'debug',
                  message: '[worker-debug] tts_end',
                  request_id: requestId,
                  elapsedMs: Date.now() - ttsStartMs,
                  audioBytes: result.byteLength,
                  provider: 'workersai',
                }),
              );
              return result;
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
          const { synthesizeWithGemini, isGeminiTtsQuotaExceededError } =
            await import('@/voice/gemini');
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
    accountId: dependencies.accountId,
    text: turnPart.text,
    audioBuffer: turnPart.audioBuffer,
    request_id: requestId,
    client_turn_id: turnPart.client_turn_id,
    generation: turnPart.generation,
    exposedToolNames,
    // BLOCK 6.1: el tool loop del LLM y la resolución de confirmaciones usan el
    // mismo pipeline de target que el router determinista.
    resolveCapabilityTarget: dependencies.resolveCapabilityTarget,
    speechMode: dependencies.currentState.speechMode,
    focusState,
    sqlExecutor: dependencies.sqlExecutor,
    environment: dependencies.environment,
    toolDefinitionMap: new Map(
      toolDefinitionMapWithReachableDevice.map((toolDefinition) => [
        toolDefinition.name,
        toolDefinition,
      ]),
    ),
    pendingConfirmation: turnPart.pendingConfirmation,
    confirmOk: turnPart.confirmOk,
    nowMilliseconds,
    deviceId: dependencies.deviceId,
    systemPromptOverride: `${sessionSystemPrompt}${focusNote}${telemetryNote}${deviceContextNote}${installedToolNote}`,
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

  // Filter out SPEAK_DONE — TTS audio streams asynchronously below.
  const uiEventList = turnOutput.uiEventList.filter((e) => e !== 'SPEAK_DONE');
  for (const uiEventName of uiEventList) {
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
  const ttsPromise = turnOutput.ttsAudioPromise;
  if (ttsPromise !== undefined) {
    const followUpSegmentTextList = turnOutput.ttsFollowUpSegmentTextList ?? [];
    let currentAudioBuffer: ArrayBuffer | undefined = await ttsPromise.catch(
      () => undefined,
    );
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
        error: quotaError instanceof Error ? quotaError.message : String(quotaError),
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
          message:
            'ApolloGemini: live skip active (sin Live en esta key), usando rama clásica',
        }),
      );
      return false;
    }
    return true;
  } catch {
    return true;
  }
}

// ── Deterministic turn executor ────────────────────────────────────────
// Handles PC commands, time, and date queries without any LLM call.
// Sends text responses as streaming chunks so the Desktop can display them
// incrementally, then sends turn_end like the classic path.

type DeterministicTurnInput = {
  connection: Connection;
  dependencies: ApolloTurnRuntimeDependencies;
  routerOutcome: Extract<
    RouterOutcome,
    {
      kind:
        | 'pc_command'
        | 'mobile_command'
        | 'time_answer'
        | 'date_answer'
        | 'memory_write';
    }
  >;
  userText: string;
  toolDefinitionMap: ReadonlyMap<string, ToolDefinition>;
  nowMilliseconds: number;
  requestId: string;
  clientTurnId: string;
  routerElapsedMs: number;
  generation?: number;
};

async function executeDeterministicTurn(input: DeterministicTurnInput): Promise<void> {
  const {
    connection,
    dependencies,
    routerOutcome,
    userText,
    toolDefinitionMap,
    nowMilliseconds,
    requestId,
    clientTurnId,
    routerElapsedMs,
    generation,
  } = input;

  const startMs = Date.now();

  // 1. Push thinking state
  dependencies.uiMachine.transition('START_THINK');
  const thinkingState = dependencies.getCurrentState();
  const thinkingCaption =
    routerOutcome.kind === 'mobile_command'
      ? `Ejecutando ${routerOutcome.commandType} en el teléfono…`
      : routerOutcome.kind === 'pc_command'
        ? `Ejecutando ${routerOutcome.commandType}…`
        : routerOutcome.kind === 'time_answer'
          ? ' Consultando hora…'
          : ' Consultando fecha…';
  dependencies.setAgentState({
    ...thinkingState,
    uiState: 'thinking',
    caption: thinkingCaption,
  });
  connection.send(
    encodeServerToDeviceMessage({
      type: 'ui_state',
      state: 'thinking',
      speechMode: thinkingState.speechMode,
      caption: thinkingCaption,
      emotion: resolveDeskFaceEmotion('thinking'),
      accentColor: resolveDeskSpeechMode(thinkingState.speechMode).accentColor,
    }),
  );

  // 2. Tool selection + authorization. El router NO ejecuta: elige la
  // intención, selectRouterToolRequest elige la tool, y resolveToolExecution
  // aplica safety. Una tool 'unsafe' (close_pc_app, lock_pc_screen) devuelve
  // needs_confirm y NO se ejecuta hasta que el usuario apruebe.
  let responseText = routerOutcome.responseText;
  let pendingConfirmation: PendingToolConfirmation | undefined;

  if (
    routerOutcome.kind === 'pc_command' ||
    routerOutcome.kind === 'mobile_command' ||
    routerOutcome.kind === 'memory_write'
  ) {
    const selectedToolRequest = selectRouterToolRequest(routerOutcome);
    const capabilityIntent = resolveCapabilityIntent(routerOutcome);
    const actionStartMs = Date.now();

    // Un solo pipeline para deterministic y LLM: capability → target →
    // authorization → confirmation → revalidación → execution.
    const outcome = await executeToolWithTargetResolution({
      toolName: selectedToolRequest.toolName,
      args: selectedToolRequest.args,
      origin: 'deterministic_router',
      toolDefinitionMap,
      context: {
        environment: dependencies.environment,
        nowMilliseconds,
        deviceId: dependencies.deviceId,
        effects: dependencies.effects,
      },
      resolver: dependencies.resolveCapabilityTarget,
      ...(capabilityIntent === null
        ? {}
        : { targetPreference: capabilityIntent.targetPreference }),
      correlation: { requestId, clientTurnId, generation },
      onTiming: (timing) => {
        console.log(
          buildCapabilityTimingLogLine({
            requestId,
            clientTurnId,
            generation,
            toolName: selectedToolRequest.toolName,
            capabilityName: capabilityIntent?.capabilityName ?? null,
            timing,
            routingMs: routerElapsedMs,
            totalActionMs: Date.now() - actionStartMs,
          }),
        );
      },
    });

    if (outcome.status === 'needs_confirm') {
      pendingConfirmation = outcome.pending;
      responseText = outcome.pending.summary;
    } else if (outcome.status === 'skipped') {
      responseText = outcome.cancellation.message;
    } else if (!outcome.result.ok) {
      responseText = outcome.result.summary;
    }
  }

  // 3. Same order as the LLM path: persist BEFORE confirm_request so #resolveConfirm
  // finds it even if the device answers while this turn is still speaking.
  if (pendingConfirmation !== undefined) {
    await dependencies.persistPendingConfirmation(pendingConfirmation);
    await dependencies.scheduleConfirmExpiry(pendingConfirmation.id);
    connection.send(encodeServerToDeviceMessage({ type: 'play_effect', name: 'chime' }));
    connection.send(
      encodeServerToDeviceMessage({
        type: 'confirm_request',
        id: pendingConfirmation.id,
        summary: pendingConfirmation.summary,
        expiresAt: pendingConfirmation.expiresAt,
      }),
    );
  }

  // 4. Send streaming text response
  connection.send(
    encodeServerToDeviceMessage({
      type: 'text_response_chunk',
      text: responseText,
    }),
  );
  connection.send(
    encodeServerToDeviceMessage({
      type: 'text_response_end',
    }),
  );

  // 5. Push speaking state then turn_end
  dependencies.uiMachine.transition('START_SPEAK');
  const speakState = dependencies.getCurrentState();
  dependencies.setAgentState({
    ...speakState,
    uiState: 'speaking',
    caption: responseText,
    pendingConfirmId: pendingConfirmation?.id ?? null,
    pendingConfirmSummary: pendingConfirmation?.summary ?? null,
  });
  connection.send(
    encodeServerToDeviceMessage({
      type: 'ui_state',
      state: 'speaking',
      speechMode: speakState.speechMode,
      caption: responseText,
      emotion: resolveDeskFaceEmotion('speaking'),
      accentColor: resolveDeskSpeechMode(speakState.speechMode).accentColor,
    }),
  );

  // 6. turn_end
  connection.send(
    encodeServerToDeviceMessage({
      type: 'turn_end',
      expectsReply: false,
    }),
  );

  // 7. Save to session
  if (userText.length > 0) {
    await dependencies.session.appendMessage({
      id: crypto.randomUUID(),
      role: 'user',
      parts: [{ type: 'text', text: userText }],
      createdAt: new Date(),
    });
    await dependencies.session.appendMessage({
      id: crypto.randomUUID(),
      role: 'assistant',
      parts: [{ type: 'text', text: responseText }],
      createdAt: new Date(),
    });
  }

  // 8. Back to idle
  dependencies.uiMachine.transition('SPEAK_DONE');
  const idleState = dependencies.getCurrentState();
  dependencies.setAgentState({
    ...idleState,
    uiState: dependencies.uiMachine.state,
    caption: responseText,
  });

  const elapsedMs = Date.now() - startMs;
  console.log(
    JSON.stringify({
      level: 'info',
      message: 'deterministic_turn_complete',
      kind: routerOutcome.kind,
      commandType:
        routerOutcome.kind === 'pc_command' ? routerOutcome.commandType : undefined,
      authorization: pendingConfirmation === undefined ? 'executed' : 'needs_confirm',
      pendingConfirmId: pendingConfirmation?.id ?? null,
      elapsedMs,
      responseLength: responseText.length,
      request_id: requestId,
      client_turn_id: clientTurnId,
      device_id: dependencies.deviceId,
    }),
  );
}

function logRouterDecision(input: {
  readonly requestId: string;
  readonly clientTurnId: string;
  readonly generation: number | null;
  readonly deviceId: string;
  readonly routeType: 'deterministic' | 'llm';
  readonly routeKind: string;
  readonly commandType?: string;
  readonly domain: string;
  readonly confidence: string;
  readonly toolCatalogSize: number;
  readonly fallbackUsed: boolean;
  readonly routerElapsedMs: number;
}): void {
  console.log(
    JSON.stringify({
      level: 'info',
      message: 'router_decision',
      route_type: input.routeType,
      route_kind: input.routeKind,
      command_type: input.commandType,
      domain: input.domain,
      confidence: input.confidence,
      tool_catalog_size: input.toolCatalogSize,
      fallback_used: input.fallbackUsed,
      routing_duration_ms: input.routerElapsedMs,
      request_id: input.requestId,
      client_turn_id: input.clientTurnId,
      // El turn_id del cliente Python viaja como client_turn_id (FASE 26); no se
      // duplica bajo otro nombre. generation si viene en el mismo mensaje.
      generation: input.generation,
      device_id: input.deviceId,
    }),
  );
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
