import { chatWithGemini } from '@/voice/gemini';

export async function synthesizeQuickWebAnswer(input: {
  readonly geminiApiKey: string;
  readonly modelId: string;
  readonly query: string;
  readonly currentDateText?: string;
  readonly sourceList: readonly {
    readonly url: string;
    readonly title: string;
    readonly text: string;
  }[];
}): Promise<string> {
  const sourceBlock = input.sourceList
    .map(
      (source, index) =>
        `[${index + 1}] ${source.title}\nURL: ${source.url}\n${source.text}`,
    )
    .join('\n\n');
  const currentDateNote =
    input.currentDateText === undefined
      ? ''
      : ` Hoy es ${input.currentDateText}: priorizá la información más reciente y si una fuente es vieja, aclaralo.`;
  const geminiApiKey =
    (input as unknown as { geminiApiKey?: string }).geminiApiKey ??
    input.geminiApiKey ??
    '';
  const chatResult = await chatWithGemini({
    geminiApiKey,
    modelId: input.modelId,
    messageList: [
      {
        role: 'system',
        content:
          'Respondé en español rioplatense, 2 a 4 oraciones, con hechos solo de las fuentes. Citá URLs al final. No inventes.' +
          currentDateNote,
      },
      {
        role: 'user',
        content: `Pregunta: ${input.query}\n\nFuentes:\n${sourceBlock}`,
      },
    ],
  });
  return chatResult.text.trim();
}

export async function synthesizeResearchSpokenSummary(input: {
  readonly geminiApiKey?: string;
  readonly modelId: string;
  readonly prompt: string;
  readonly reportMarkdown: string;
}): Promise<string> {
  const geminiApiKey = input.geminiApiKey ?? '';
  const chatResult = await chatWithGemini({
    geminiApiKey,
    modelId: input.modelId,
    messageList: [
      {
        role: 'system',
        content:
          'Resumí el informe en 2 a 4 oraciones para voz en español rioplatense. Cerrá diciendo que guardaste el informe completo.',
      },
      {
        role: 'user',
        content: `Pedido: ${input.prompt}\n\nInforme:\n${input.reportMarkdown.slice(0, 6000)}`,
      },
    ],
  });
  return chatResult.text.trim();
}
