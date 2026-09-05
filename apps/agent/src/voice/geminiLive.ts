import type {
  ToolDefinition,
  ToolExecutionResult,
  JsonSerializableValue,
} from '@/tools/types';
import { executeToolByName } from '@/tools/router';

const GEMINI_LIVE_WS_URL =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

const GEMINI_INPUT_SAMPLE_RATE = 16000;

function encodePcmAsBase64(pcmBuffer: ArrayBuffer): string {
  const bytes = new Uint8Array(pcmBuffer);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function decodeBase64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function buildGeminiTools(
  toolDefinitionList: readonly Pick<
    ToolDefinition,
    'name' | 'description' | 'parameters'
  >[],
): unknown[] | undefined {
  if (toolDefinitionList.length === 0) return undefined;
  return [
    {
      functionDeclarations: toolDefinitionList.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      })),
    },
  ];
}

export type GeminiLiveTurnResult = {
  readonly transcript: string;
  readonly spokenText: string;
  readonly ttsAudio: ArrayBuffer;
  readonly toolCallList?: readonly unknown[];
};

export async function handleGeminiLiveTurn(input: {
  readonly audioBuffer?: ArrayBuffer;
  readonly text?: string;
  readonly environment: Env;
  readonly systemPrompt: string;
  readonly toolDefinitionList: readonly Pick<
    ToolDefinition,
    'name' | 'description' | 'parameters'
  >[];
  readonly toolDefinitionMap: ReadonlyMap<string, ToolDefinition>;
  readonly nowMilliseconds: number;
  readonly deviceId: string | undefined;
  readonly effects: import('@/tools/types').DeskToolEffects | undefined;
  readonly recentHistoryMessageList?: readonly unknown[];
  readonly onAudioChunk?: (chunk: ArrayBuffer) => void;
}): Promise<GeminiLiveTurnResult> {
  const apiKey = input.environment.GEMINI_API_KEY;
  if (apiKey === undefined || apiKey.length === 0) {
    throw new Error('GEMINI_API_KEY no configurado');
  }

  const modelId =
    input.environment.GEMINI_LIVE_MODEL ??
    'models/gemini-3.6-flash-preview-native-audio-dialog';

  const wsUrl = `${GEMINI_LIVE_WS_URL}?key=${encodeURIComponent(apiKey)}`;

  console.log(
    JSON.stringify({
      level: 'info',
      message: 'ApolloGemini: SESSION_CONNECTING',
      model: modelId,
    }),
  );

  const ws = new WebSocket(wsUrl);

  let setupComplete = false;
  const audioChunkList: ArrayBuffer[] = [];
  let transcriptText = '';
  let spokenText = '';
  let turnComplete = false;
  let sessionError: Error | null = null;

  const setupPromise = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('Gemini Live setup timeout')),
      10000,
    );
    ws.addEventListener('open', () => {
      console.log(
        JSON.stringify({
          level: 'info',
          message: 'ApolloGemini: SESSION_CONNECTED',
        }),
      );
      const setupMessage = {
        setup: {
          model: modelId,
          generationConfig: {
            responseModalities: ['AUDIO'],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: { voiceName: 'Puck' },
              },
            },
          },
          systemInstruction: {
            parts: [{ text: input.systemPrompt }],
          },
          tools: buildGeminiTools(input.toolDefinitionList),
          inputAudioTranscription: {},
          outputAudioTranscription: {},
        },
      };
      ws.send(JSON.stringify(setupMessage));
    });

    ws.addEventListener('close', (event) => {
      const closeEvent = event as CloseEvent;
      if (!setupComplete && !sessionError) {
        sessionError = new Error(
          `Gemini Live closed before setup: ${closeEvent.code} ${closeEvent.reason}`,
        );
        clearTimeout(timeout);
        reject(sessionError);
      }
    });

    ws.addEventListener('error', (event) => {
      const errMsg =
        event instanceof ErrorEvent
          ? event.message
          : String((event as unknown as { message?: string }).message ?? event);
      sessionError = new Error(`Gemini Live error: ${errMsg}`);
      clearTimeout(timeout);
      reject(sessionError);
    });
  });

  async function handleMessage(event: MessageEvent): Promise<void> {
    const data =
      typeof event.data === 'string'
        ? event.data
        : new TextDecoder().decode(event.data as ArrayBuffer);
    const msg = JSON.parse(data as string);

    if (msg.setupComplete !== undefined) {
      setupComplete = true;
      return;
    }

    if (msg.serverContent !== undefined) {
      const content = msg.serverContent;

      if (content.inputTranscription !== undefined) {
        const t = content.inputTranscription.text ?? '';
        if (t.length > 0) transcriptText += t;
      }

      if (content.outputTranscription !== undefined) {
        const t = content.outputTranscription.text ?? '';
        if (t.length > 0) spokenText += t;
      }

      if (content.modelTurn !== undefined) {
        const parts = content.modelTurn.parts ?? [];
        for (const part of parts) {
          if (part.inlineData !== undefined) {
            const mimeType: string = part.inlineData.mimeType ?? '';
            const isAudio = mimeType.startsWith('audio/pcm');
            if (isAudio) {
              const pcmBuffer = decodeBase64ToArrayBuffer(part.inlineData.data);
              audioChunkList.push(pcmBuffer);
              if (input.onAudioChunk !== undefined) {
                try {
                  input.onAudioChunk(pcmBuffer);
                } catch {}
              }
              console.log(
                JSON.stringify({
                  level: 'info',
                  message: 'ApolloGemini: AUDIO_RECEIVED',
                  bytes: pcmBuffer.byteLength,
                }),
              );
            }
          }
          if (part.text !== undefined && part.text.length > 0) {
            spokenText += part.text;
          }
        }
      }

      if (content.turnComplete === true) {
        turnComplete = true;
      }

      if (content.toolCall !== undefined) {
        const toolCall = content.toolCall;
        console.log(
          JSON.stringify({
            level: 'info',
            message: 'ApolloGemini: TOOL_CALL_RECEIVED',
            toolCall,
          }),
        );

        const toolName = toolCall.name as string;
        const toolArgs = toolCall.args as JsonSerializableValue | undefined;

        const toolDef = input.toolDefinitionMap.get(toolName);
        if (toolDef === undefined) {
          console.error(
            JSON.stringify({
              level: 'error',
              message: 'ApolloGemini: TOOL_NOT_FOUND',
              toolName,
            }),
          );
          const errorResponse = {
            toolResponse: {
              name: toolName,
              response: { error: `Tool ${toolName} not found` },
            },
          };
          ws.send(JSON.stringify(errorResponse));
        } else {
          try {
            const outcome = await executeToolByName(
              input.toolDefinitionMap,
              toolName,
              toolArgs ?? {},
              {
                environment: input.environment,
                nowMilliseconds: input.nowMilliseconds,
                deviceId: input.deviceId,
                effects: input.effects,
              },
            );

            let response: ToolExecutionResult;
            if (outcome.status === 'needs_confirm') {
              response = {
                ok: false,
                summary: outcome.pending.summary,
                data: { needsConfirm: true, pending: outcome.pending },
              };
            } else {
              response = outcome.result;
            }

            const toolResponseMessage = {
              toolResponse: {
                name: toolName,
                response,
              },
            };
            ws.send(JSON.stringify(toolResponseMessage));

            console.log(
              JSON.stringify({
                level: 'info',
                message: 'ApolloGemini: TOOL_RESPONSE_SENT',
                toolName,
                ok: response.ok,
              }),
            );
          } catch (e) {
            console.error(
              JSON.stringify({
                level: 'error',
                message: 'ApolloGemini: TOOL_EXECUTION_ERROR',
                toolName,
                error: e instanceof Error ? e.message : String(e),
              }),
            );
            const errorResponse = {
              toolResponse: {
                name: toolName,
                response: { error: e instanceof Error ? e.message : String(e) },
              },
            };
            ws.send(JSON.stringify(errorResponse));
          }
        }
      }

      if (content.turnComplete === true) {
        turnComplete = true;
      }
    }
  }

  ws.addEventListener('message', async (event) => {
    try {
      await handleMessage(event);
    } catch (e) {
      console.error(
        JSON.stringify({
          level: 'error',
          message: 'ApolloGemini: MESSAGE_HANDLER_ERROR',
          error: e instanceof Error ? e.message : String(e),
        }),
      );
    }
  });

  try {
    await setupPromise;
  } catch (e) {
    try {
      ws.close();
    } catch {}
    throw e;
  }

  if (
    input.recentHistoryMessageList !== undefined &&
    input.recentHistoryMessageList.length > 0
  ) {
    const historyTurns = (
      input.recentHistoryMessageList as readonly {
        role: string;
        content: string | null;
      }[]
    ).map((msg) => ({
      role: msg.role === 'assistant' || msg.role === 'model' ? 'model' : 'user',
      parts: [{ text: msg.content ?? '' }],
    }));
    if (historyTurns.length > 0) {
      ws.send(
        JSON.stringify({ clientContent: { turns: historyTurns, turnComplete: false } }),
      );
    }
  }

  console.log(
    JSON.stringify({
      level: 'info',
      message: 'ApolloGemini: AUDIO_SENT',
      bytes: input.audioBuffer?.byteLength ?? 0,
    }),
  );

  if (input.text !== undefined && input.text.length > 0) {
    ws.send(
      JSON.stringify({
        clientContent: {
          turns: [{ role: 'user', parts: [{ text: input.text }] }],
          turnComplete: true,
        },
      }),
    );
  } else if (input.audioBuffer !== undefined && input.audioBuffer.byteLength > 0) {
    const base64Audio = encodePcmAsBase64(input.audioBuffer);
    ws.send(
      JSON.stringify({
        realtimeInput: {
          audio: {
            data: base64Audio,
            mimeType: `audio/pcm;rate=${GEMINI_INPUT_SAMPLE_RATE}`,
          },
        },
      }),
    );
    // Signal end of audio stream
    ws.send(
      JSON.stringify({
        clientContent: { turnComplete: true },
      }),
    );
    console.log(
      JSON.stringify({ level: 'info', message: 'ApolloGemini: AUDIO_STREAM_END' }),
    );
  } else {
    throw new Error('No audio or text provided for Gemini Live turn');
  }

  // Wait for turnComplete or timeout
  const turnPromise = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      console.log(
        JSON.stringify({
          level: 'info',
          message: 'ApolloGemini: RESPONSE_FINISHED timeout',
        }),
      );
      resolve();
    }, 30000);

    const checkInterval = setInterval(() => {
      if (turnComplete) {
        clearTimeout(timeout);
        clearInterval(checkInterval);
        resolve();
      }
      if (sessionError) {
        clearTimeout(timeout);
        clearInterval(checkInterval);
        reject(sessionError);
      }
    }, 100);

    // Also listen for close
    ws.addEventListener('close', () => {
      clearTimeout(timeout);
      clearInterval(checkInterval);
      resolve();
    });
    ws.addEventListener('error', (e) => {
      clearTimeout(timeout);
      clearInterval(checkInterval);
      reject(e);
    });
  });

  await turnPromise;

  try {
    ws.close();
  } catch {}

  console.log(
    JSON.stringify({
      level: 'info',
      message: 'ApolloGemini: RESPONSE_FINISHED',
      transcriptLength: transcriptText.length,
      spokenLength: spokenText.length,
      audioChunks: audioChunkList.length,
    }),
  );

  if (audioChunkList.length === 0 && spokenText.length === 0) {
    throw new Error('Gemini Live no devolvió audio ni texto');
  }

  // Concatenate audio chunks
  const totalBytes = audioChunkList.reduce((sum, buf) => sum + buf.byteLength, 0);
  const merged = new Uint8Array(totalBytes);
  let offset = 0;
  for (const buf of audioChunkList) {
    merged.set(new Uint8Array(buf), offset);
    offset += buf.byteLength;
  }

  // If spokenText is empty but we have transcript, use transcript as spokenText for fallback
  const finalSpokenText = spokenText.length > 0 ? spokenText : transcriptText;

  // Ensure we have audio; if not, synthesize empty
  const finalAudio = totalBytes > 0 ? merged.buffer : new ArrayBuffer(0);

  return {
    transcript: transcriptText.length > 0 ? transcriptText : (input.text ?? ''),
    spokenText: finalSpokenText,
    ttsAudio: finalAudio,
  };
}

export function isGeminiLiveAvailable(environment: Env): boolean {
  return (
    environment.GEMINI_API_KEY !== undefined && environment.GEMINI_API_KEY.length > 0
  );
}
