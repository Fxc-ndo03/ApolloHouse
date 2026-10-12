import { buildCapabilityExecutionTarget } from '@/tools/execution-target';
import { sendMobileCapabilityCommand } from '@/tools/mobile/sender';
import type { ToolDefinition } from '@/tools/types';

// mobile.open_app (BLOCK 11 §3). realtime_only por definición: abrir una app
// necesita el teléfono en mano y despierto.

export const openMobileAppTool: ToolDefinition = {
  executionTarget: buildCapabilityExecutionTarget('mobile.open_app'),
  name: 'open_mobile_app',
  safety: 'safe',
  description:
    'Abre una app en el teléfono del usuario. Usá esto cuando pida abrir algo en el celular, por ejemplo "abrí WhatsApp en el teléfono".',
  parameters: {
    type: 'object',
    properties: {
      appName: {
        type: 'string',
        description: 'Nombre de la app a abrir (ej: "whatsapp", "maps", "gmail").',
      },
    },
    required: ['appName'],
  },
  async handler(args, context) {
    return sendMobileCapabilityCommand({
      context,
      capabilityName: 'mobile.open_app',
      args,
      successSummary: 'Abriendo la app en el teléfono.',
      invalidPayloadSummary: 'Necesito el nombre de la app.',
    });
  },
};
