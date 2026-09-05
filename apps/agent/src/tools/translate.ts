import { z } from 'zod';

import type { ToolDefinition } from '@/tools/types';
import { chatWithGemini } from '@/voice/gemini';

const translateArgsSchema = z.object({
  text: z.string().min(1).max(8000),
  targetLanguage: z.string().min(1).max(80),
  sourceLanguage: z.string().min(1).max(80).optional(),
});

export const translateTool: ToolDefinition = {
  name: 'translate',
  safety: 'safe',
  description: 'Traduce texto a cualquier idioma con IA',
  parameters: {
    type: 'object',
    properties: {
      text: { type: 'string' },
      targetLanguage: { type: 'string' },
      sourceLanguage: { type: 'string' },
    },
    required: ['text', 'targetLanguage'],
  },
  async handler(args, context) {
    const parsedArgs = translateArgsSchema.parse(args);
    const sourceClause =
      parsedArgs.sourceLanguage === undefined
        ? 'Detectá el idioma de origen.'
        : `Idioma de origen: ${parsedArgs.sourceLanguage}.`;

    try {
      const chatResult = await chatWithGemini({
        geminiApiKey: context.environment.GEMINI_API_KEY ?? '',
        modelId: context.environment.GEMINI_MODEL ?? 'models/gemini-3.6-flash',
        messageList: [
          {
            role: 'system',
            content: `Traducí el texto del usuario. ${sourceClause} Idioma destino: ${parsedArgs.targetLanguage}. Respondé SOLO con la traducción, sin comillas ni explicación.`,
          },
          { role: 'user', content: parsedArgs.text },
        ],
      });
      const translatedText = chatResult.text.trim();
      if (translatedText.length === 0) {
        return { ok: false, summary: 'La traducción vino vacía' };
      }
      return {
        ok: true,
        summary: translatedText,
        data: {
          translatedText,
          targetLanguage: parsedArgs.targetLanguage,
        },
      };
    } catch (error) {
      return {
        ok: false,
        summary:
          error instanceof Error
            ? `No pude traducir: ${error.message}`
            : 'No pude traducir',
      };
    }
  },
};
