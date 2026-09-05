// Kept for backward compat: now delegates to Gemini TTS.
// Original ElevenLabs PCM 24k s16le is compatible with Gemini audio output.

export const TTS_PCM_SAMPLE_RATE_HZ = 24000;
export const TTS_PCM_CHANNEL_COUNT = 1;

import { synthesizeWithGemini } from '@/voice/gemini';

export async function synthesizeSpeechWithElevenLabs(input: {
  readonly text: string;
  readonly voiceId: string;
  readonly elevenLabsApiKey: string;
  readonly modelId: string;
  readonly outputFormat?: string;
  readonly fetchImplementation?: typeof fetch;
}): Promise<ArrayBuffer> {
  // elevenLabsApiKey is treated as geminiApiKey for migration
  return synthesizeWithGemini({
    text: input.text,
    geminiApiKey: input.elevenLabsApiKey,
    modelId: 'models/gemini-3.6-flash-preview-tts',
    fetchImplementation: input.fetchImplementation,
  });
}

export { synthesizeWithGemini } from '@/voice/gemini';
