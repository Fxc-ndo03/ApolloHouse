import { z } from 'zod';

const geminiEmbeddingResponseSchema = z.object({
  embedding: z.object({
    values: z.array(z.number()),
  }),
});

export async function embedTextWithGemini(input: {
  readonly geminiApiKey: string;
  readonly modelId?: string;
  readonly text: string;
  readonly fetchImplementation?: typeof fetch;
}): Promise<number[]> {
  const model = input.modelId ?? 'models/text-embedding-004';
  const url = `https://generativelanguage.googleapis.com/v1beta/${encodeURIComponent(model)}:embedContent?key=${encodeURIComponent(input.geminiApiKey)}`;
  const fetchImpl = input.fetchImplementation ?? globalThis.fetch;
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      content: { parts: [{ text: input.text }] },
    }),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Gemini Embedding falló ${response.status}: ${detail.slice(0, 500)}`);
  }
  const payload = geminiEmbeddingResponseSchema.parse(await response.json());
  return payload.embedding.values;
}
