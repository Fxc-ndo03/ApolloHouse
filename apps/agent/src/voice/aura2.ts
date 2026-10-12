export const AURA2_MODEL_ID = '@cf/deepgram/aura-2-es';

export const AURA2_TIMEOUT_MILLISECONDS = 15_000;

export const AURA2_SAMPLE_RATE_HZ = 24000;

export type Aura2Voice =
  | 'carina'
  | 'celeste'
  | 'diana'
  | 'selena'
  | 'estrella'
  | 'sirio'
  | 'nestor'
  | 'alvaro'
  | 'aquila'
  | 'javier';

export const AURA2_VOICE_LIST: readonly {
  readonly id: Aura2Voice;
  readonly label: string;
  readonly gender: 'Female' | 'Male';
  readonly accent: string;
}[] = [
  { id: 'carina', label: 'Carina (Femenina, Espana)', gender: 'Female', accent: 'es-es' },
  {
    id: 'celeste',
    label: 'Celeste (Femenina, Colombia)',
    gender: 'Female',
    accent: 'es-co',
  },
  { id: 'diana', label: 'Diana (Femenina, Espana)', gender: 'Female', accent: 'es-es' },
  {
    id: 'selena',
    label: 'Selena (Femenina, codeswitching)',
    gender: 'Female',
    accent: 'en+es',
  },
  {
    id: 'estrella',
    label: 'Estrella (Femenina, Mexico)',
    gender: 'Female',
    accent: 'es-mx',
  },
  { id: 'sirio', label: 'Sirio (Masculino, Mexico)', gender: 'Male', accent: 'es-mx' },
  { id: 'nestor', label: 'Nestor (Masculino, Espana)', gender: 'Male', accent: 'es-es' },
  { id: 'alvaro', label: 'Alvaro (Masculino, Espana)', gender: 'Male', accent: 'es-es' },
  {
    id: 'aquila',
    label: 'Aquila (Masculino, Latinoamericano)',
    gender: 'Male',
    accent: 'es-419',
  },
  { id: 'javier', label: 'Javier (Masculino, Mexico)', gender: 'Male', accent: 'es-mx' },
];

function rejectAfterTimeout(
  timeoutMilliseconds: number,
  message: string,
): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    setTimeout(() => reject(new Error(message)), timeoutMilliseconds);
  });
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
      throw new Error('Aura-2 devolvió un chunk no binario');
    }
    chunkList.push(chunk);
  }
  const totalByteLength = chunkList.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  if (totalByteLength === 0) {
    throw new Error('Aura-2 devolvió audio vacío');
  }
  const mergedBytes = new Uint8Array(totalByteLength);
  let offset = 0;
  for (const chunk of chunkList) {
    mergedBytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return mergedBytes;
}

export class Aura2QuotaExceededError extends Error {
  constructor() {
    super('Workers AI daily neuron limit reached');
    this.name = 'Aura2QuotaExceededError';
  }
}

export function isAura2QuotaExceededError(error: unknown): boolean {
  if (error instanceof Aura2QuotaExceededError) return true;
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes('402') ||
    message.includes('quota') ||
    message.includes('limit') ||
    message.includes(' neurons')
  );
}

export async function synthesizeWithAura2(input: {
  readonly text: string;
  readonly voice: Aura2Voice;
  readonly environment: Env;
}): Promise<ArrayBuffer> {
  const workersAi = input.environment.AI;
  if (workersAi === undefined) {
    throw new Error('Workers AI binding no disponible');
  }
  const trimmedText = input.text.trim();
  if (trimmedText.length === 0) {
    throw new Error('Aura-2 recibió texto vacío');
  }

  const runModel = (
    modelName: string,
    modelInputs: Record<string, string | number>,
  ): Promise<unknown> => workersAi.run(modelName, modelInputs);

  let synthesisResult: unknown;
  try {
    synthesisResult = await Promise.race([
      runModel(AURA2_MODEL_ID, {
        text: trimmedText,
        speaker: input.voice,
        encoding: 'linear16',
        container: 'none',
        sample_rate: AURA2_SAMPLE_RATE_HZ,
      }),
      rejectAfterTimeout(AURA2_TIMEOUT_MILLISECONDS, 'Aura-2 tardó demasiado'),
    ]);
  } catch (error) {
    if (isAura2QuotaExceededError(error)) {
      throw new Aura2QuotaExceededError();
    }
    throw error;
  }

  let pcmBytes: Uint8Array;

  if (synthesisResult instanceof ReadableStream) {
    pcmBytes = await collectStreamToBytes(synthesisResult);
  } else if (synthesisResult instanceof ArrayBuffer) {
    pcmBytes = new Uint8Array(synthesisResult);
  } else if (synthesisResult instanceof Uint8Array) {
    pcmBytes = synthesisResult;
  } else if (
    typeof synthesisResult === 'object' &&
    synthesisResult !== null &&
    'audio' in synthesisResult &&
    typeof (synthesisResult as { audio: unknown }).audio === 'string'
  ) {
    const base64 = (synthesisResult as { audio: string }).audio;
    const binary = atob(base64);
    pcmBytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      pcmBytes[i] = binary.charCodeAt(i);
    }
  } else {
    throw new Error('Aura-2 devolvió un formato desconocido');
  }

  if (pcmBytes.byteLength === 0) {
    throw new Error('Aura-2 devolvió audio vacío');
  }

  return pcmBytes.buffer as ArrayBuffer;
}
