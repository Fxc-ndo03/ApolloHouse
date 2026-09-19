import decodeMp3Audio from '@audio/decode-mp3';
import { z } from 'zod';

import { resampleToMonoS16Pcm } from '@/voice/resample';

export const MELOTTS_MODEL_ID = '@cf/myshell-ai/melotts';

export const MELOTTS_LANGUAGE = 'ES';

export const WORKERS_AI_TTS_TIMEOUT_MILLISECONDS = 15_000;

function rejectAfterTimeout(
  timeoutMilliseconds: number,
  message: string,
): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    setTimeout(() => reject(new Error(message)), timeoutMilliseconds);
  });
}

export type Mp3DecodeResult = {
  readonly channelData: readonly Float32Array[];
  readonly sampleRate: number;
};

export type Mp3DecodeImplementation = (
  mp3Bytes: Uint8Array,
) => Promise<Mp3DecodeResult>;

const base64AudioResponseSchema = z.object({ audio: z.string() });

export function isWorkersAiTtsAvailable(environment: Env): boolean {
  return environment.AI !== undefined;
}

function decodeBase64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

async function collectStreamToBytes(
  audioStream: ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
  const chunkList: Uint8Array[] = [];
  const streamReader = audioStream.getReader();
  for (;;) {
    const { done, value: chunk } = await streamReader.read();
    if (done) {
      break;
    }
    if (!(chunk instanceof Uint8Array)) {
      throw new Error('Workers AI TTS devolvió un chunk no binario');
    }
    chunkList.push(chunk);
  }
  const totalByteLength = chunkList.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  if (totalByteLength === 0) {
    throw new Error('Workers AI TTS devolvió audio vacío');
  }
  const mergedBytes = new Uint8Array(totalByteLength);
  let offset = 0;
  for (const chunk of chunkList) {
    mergedBytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return mergedBytes;
}

async function readSynthesisBytes(synthesisResult: unknown): Promise<Uint8Array> {
  if (synthesisResult instanceof ReadableStream) {
    return collectStreamToBytes(synthesisResult);
  }
  const base64Parsed = base64AudioResponseSchema.safeParse(synthesisResult);
  if (base64Parsed.success) {
    return decodeBase64ToBytes(base64Parsed.data.audio);
  }
  throw new Error('Workers AI TTS devolvió un formato desconocido');
}

async function synthesizeWithMelotts(input: {
  readonly text: string;
  readonly runModel: (
    modelName: string,
    inputs: Record<string, string | number>,
  ) => Promise<unknown>;
  readonly decodeMp3: Mp3DecodeImplementation;
}): Promise<ArrayBuffer> {
  const synthesisResult: unknown = await input.runModel(MELOTTS_MODEL_ID, {
    prompt: input.text,
    lang: MELOTTS_LANGUAGE,
  });
  const mp3Bytes = await readSynthesisBytes(synthesisResult);
  const decodedAudio = await input.decodeMp3(mp3Bytes);
  if (decodedAudio.channelData.length === 0) {
    throw new Error('MeloTTS devolvió audio vacío');
  }
  return resampleToMonoS16Pcm({
    channelDataList: decodedAudio.channelData,
    sourceSampleRateHz: decodedAudio.sampleRate,
  });
}

function logFallbackWarning(message: string, error: unknown): void {
  console.warn(
    JSON.stringify({
      level: 'warn',
      message,
      error: error instanceof Error ? error.message : String(error),
    }),
  );
}

export async function synthesizeWithWorkersAi(input: {
  readonly text: string;
  readonly environment: Env;
  readonly decodeMp3Implementation?: Mp3DecodeImplementation;
}): Promise<ArrayBuffer> {
  const workersAi = input.environment.AI;
  if (workersAi === undefined) {
    throw new Error('Workers AI binding no disponible');
  }
  const trimmedText = input.text.trim();
  if (trimmedText.length === 0) {
    throw new Error('Workers AI TTS recibió texto vacío');
  }
  const runModel = (
    modelName: string,
    modelInputs: Record<string, string | number>,
  ): Promise<unknown> => workersAi.run(modelName, modelInputs);

  try {
    return await Promise.race([
      synthesizeWithMelotts({
        text: trimmedText,
        runModel,
        decodeMp3: input.decodeMp3Implementation ?? decodeMp3Audio,
      }),
      rejectAfterTimeout(
        WORKERS_AI_TTS_TIMEOUT_MILLISECONDS,
        'MeloTTS tardó demasiado',
      ),
    ]);
  } catch (error) {
    logFallbackWarning('MeloTTS falló', error);
    throw new Error('Workers AI TTS sin motores disponibles');
  }
}
