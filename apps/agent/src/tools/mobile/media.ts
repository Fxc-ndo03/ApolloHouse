import { buildCapabilityExecutionTarget } from '@/tools/execution-target';
import { sendMobileCapabilityCommand } from '@/tools/mobile/sender';
import type { ToolDefinition } from '@/tools/types';

// mobile.media (BLOCK 11 §3). realtime_only en el catálogo: reproducir necesita un
// teléfono vivo en el momento, no sirve encolarlo.

const mediaParameters = {
  type: 'object' as const,
  properties: {
    query: {
      type: 'string',
      description: 'Qué reproducir o buscar: artista, canción o álbum.',
    },
  },
  required: ['query'],
};

export const playMobileMediaTool: ToolDefinition = {
  executionTarget: buildCapabilityExecutionTarget('mobile.media'),
  name: 'play_mobile_media',
  safety: 'safe',
  description:
    'Reproduce música o un video en el teléfono del usuario. Usá esto cuando pida poner algo a reproducir en el celular.',
  parameters: mediaParameters,
  async handler(args, context) {
    return sendMobileCapabilityCommand({
      context,
      capabilityName: 'mobile.media',
      args,
      successSummary: 'Reproduciendo en el teléfono.',
      invalidPayloadSummary: 'Necesito saber qué reproducir.',
    });
  },
};

export const pauseMobileMediaTool: ToolDefinition = {
  executionTarget: buildCapabilityExecutionTarget('mobile.media'),
  name: 'pause_mobile_media',
  safety: 'safe',
  description: 'Pausa la reproducción de media en el teléfono del usuario.',
  parameters: mediaParameters,
  async handler(args, context) {
    return sendMobileCapabilityCommand({
      context,
      capabilityName: 'mobile.media',
      commandName: 'media_pause',
      args,
      successSummary: 'Media pausada en el teléfono.',
      invalidPayloadSummary: 'Necesito saber qué pausar.',
    });
  },
};

export const nextMobileMediaTool: ToolDefinition = {
  executionTarget: buildCapabilityExecutionTarget('mobile.media'),
  name: 'next_mobile_media',
  safety: 'safe',
  description: 'Salta a la pista siguiente en el teléfono del usuario.',
  parameters: mediaParameters,
  async handler(args, context) {
    return sendMobileCapabilityCommand({
      context,
      capabilityName: 'mobile.media',
      commandName: 'media_next',
      args,
      successSummary: 'Pista siguiente.',
      invalidPayloadSummary: 'Necesito saber qué lista usar.',
    });
  },
};

export const previousMobileMediaTool: ToolDefinition = {
  executionTarget: buildCapabilityExecutionTarget('mobile.media'),
  name: 'previous_mobile_media',
  safety: 'safe',
  description: 'Vuelve a la pista anterior en el teléfono del usuario.',
  parameters: mediaParameters,
  async handler(args, context) {
    return sendMobileCapabilityCommand({
      context,
      capabilityName: 'mobile.media',
      commandName: 'media_previous',
      args,
      successSummary: 'Pista anterior.',
      invalidPayloadSummary: 'Necesito saber qué lista usar.',
    });
  },
};
