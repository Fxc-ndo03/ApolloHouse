import { formatCurrentDateTimeForPrompt } from '@/persona/clock';
import { chatWithGemini } from '@/voice/gemini';

// Deep research now via Gemini.
export async function runDeepResearchWithGemini(input: {
  readonly geminiApiKey?: string;
  readonly modelId: string;
  readonly prompt: string;
  readonly nowMilliseconds: number;
  readonly fetchImplementation?: typeof fetch;
}): Promise<string> {
  const geminiApiKey = input.geminiApiKey ?? '';
  const chatResult = await chatWithGemini({
    geminiApiKey,
    modelId: input.modelId,
    messageList: [
      {
        role: 'system',
        content:
          `Sos Apollo en modo deep research. Hoy es ${formatCurrentDateTimeForPrompt(input.nowMilliseconds)}. ` +
          'Investigá a fondo priorizando información vigente y escribí un informe en markdown en español: resumen ejecutivo, hallazgos, matices/contradicciones, y sección Fuentes con links. Citá las fuentes y aclará la fecha de los datos cuando importe.',
      },
      { role: 'user', content: input.prompt },
    ],
    fetchImplementation: input.fetchImplementation,
  });
  return chatResult.text.trim();
}
