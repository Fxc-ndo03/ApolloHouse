import { buildCapabilityExecutionTarget } from '@/tools/execution-target';
import { sendMobileCapabilityCommand } from '@/tools/mobile/sender';
import type { ToolDefinition } from '@/tools/types';

// mobile.volume (BLOCK 11 §3). realtime_only: el volumen es del momento.

export const setMobileVolumeTool: ToolDefinition = {
  executionTarget: buildCapabilityExecutionTarget('mobile.volume'),
  name: 'set_mobile_volume',
  safety: 'safe',
  description:
    'Ajusta el volumen del teléfono del usuario. Usá esto cuando pida subir, bajar o silenciar el celular.',
  parameters: {
    type: 'object',
    properties: {
      level: {
        type: 'number',
        description: 'Nivel de volumen de 0 (silencio) a 100 (máximo).',
      },
    },
    required: ['level'],
  },
  async handler(args, context) {
    return sendMobileCapabilityCommand({
      context,
      capabilityName: 'mobile.volume',
      args,
      successSummary: 'Volumen del teléfono ajustado.',
      invalidPayloadSummary: 'El volumen necesita un nivel de 0 a 100.',
    });
  },
};

export const getMobileVolumeTool: ToolDefinition = {
  executionTarget: buildCapabilityExecutionTarget('mobile.volume'),
  name: 'get_mobile_volume',
  safety: 'safe',
  description:
    'Consulta el volumen actual del teléfono del usuario. Usá esto cuando pregunte cuánto volumen tiene.',
  parameters: {
    type: 'object',
    properties: {},
    required: [],
  },
  async handler(args, context) {
    return sendMobileCapabilityCommand({
      context,
      capabilityName: 'mobile.volume',
      commandName: 'volume_get',
      args,
      successSummary: 'Consulté el volumen del teléfono.',
      buildSuccessSummary: (result) => {
        const level = readVolumeLevel(result);
        return level === null
          ? 'No pude leer el volumen del teléfono.'
          : `El volumen del teléfono está en ${level}%.`;
      },
      invalidPayloadSummary: 'No hace falta ningún dato para consultar el volumen.',
    });
  },
};

function readVolumeLevel(result: unknown): number | null {
  if (typeof result !== 'object' || result === null) {
    return null;
  }
  const level = (result as { readonly level?: unknown }).level;
  return typeof level === 'number' && Number.isInteger(level) ? level : null;
}
