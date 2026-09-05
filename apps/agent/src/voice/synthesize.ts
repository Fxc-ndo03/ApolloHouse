import { synthesizeWithGemini } from '@/voice/elevenlabs';
import { synthesizeSpeechThroughCache } from '@/voice/ttscache';
import type { StorageBucket } from '@/storage/local';

// The one production speech path: every caller gets the cache, so a repeated
// utterance never costs ElevenLabs credits twice.
export async function synthesizeApolloSpeech(input: {
  readonly storageBucket: StorageBucket;
  readonly environment: Env;
  readonly text: string;
  readonly voiceId: string;
}): Promise<ArrayBuffer> {
  return synthesizeSpeechThroughCache({
    mediaBucket: input.storageBucket,
    text: input.text,
    voiceId: input.voiceId,
    modelId: input.environment.GEMINI_LIVE_MODEL,
    synthesize: () =>
      synthesizeWithGemini({
        text: input.text,
        geminiApiKey: input.environment.GEMINI_API_KEY,
        modelId: input.environment.GEMINI_LIVE_MODEL,
      }),
  });
}
