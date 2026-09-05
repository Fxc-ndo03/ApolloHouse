import { z } from 'zod';

import { embedTextWithGemini } from '@/voice/geminiEmbeddings';

const memoryVectorMetadataSchema = z.object({
  content: z.string(),
});

export type MemoryVectorMatch = {
  readonly id: string;
  readonly content: string;
  readonly score: number;
};

export async function upsertMemoryVector(input: {
  readonly vectorizeIndex: VectorizeIndex;
  readonly memoryId: string;
  readonly content: string;
  readonly values: number[];
  readonly deviceId: string;
}): Promise<void> {
  await input.vectorizeIndex.upsert([
    {
      id: input.memoryId,
      values: input.values,
      namespace: input.deviceId,
      metadata: {
        content: input.content.slice(0, 2048),
      },
    },
  ]);
}

export async function queryMemoryVectors(input: {
  readonly vectorizeIndex: VectorizeIndex;
  readonly values: number[];
  readonly deviceId: string;
  readonly topK?: number;
}): Promise<readonly MemoryVectorMatch[]> {
  const queryResult = await input.vectorizeIndex.query(input.values, {
    topK: input.topK ?? 5,
    namespace: input.deviceId,
    returnMetadata: 'all',
  });

  return queryResult.matches.map((match) => {
    const parsedMetadata = memoryVectorMetadataSchema.safeParse(match.metadata);
    return {
      id: match.id,
      content: parsedMetadata.success ? parsedMetadata.data.content : '',
      score: match.score,
    };
  });
}

export async function recallSemanticMemoryContent(input: {
  readonly vectorizeIndex: VectorizeIndex | undefined;
  readonly geminiApiKey?: string;
  readonly geminiEmbeddingModelId?: string;
  readonly queryText: string;
  readonly deviceId: string;
  readonly topK?: number;
}): Promise<readonly string[]> {
  if (input.vectorizeIndex === undefined || input.queryText.trim().length === 0) {
    return [];
  }

  try {
    const apiKey = input.geminiApiKey ?? '';
    const modelId = input.geminiEmbeddingModelId ?? 'models/text-embedding-004';
    const values = await embedTextWithGemini({
      geminiApiKey: apiKey,
      modelId,
      text: input.queryText,
    });
    const matchList = await queryMemoryVectors({
      vectorizeIndex: input.vectorizeIndex,
      values,
      deviceId: input.deviceId,
      topK: input.topK,
    });
    return matchList
      .filter((match) => match.content.length > 0)
      .map((match) => match.content);
  } catch {
    return [];
  }
}

export { embedTextWithGemini } from '@/voice/geminiEmbeddings';
