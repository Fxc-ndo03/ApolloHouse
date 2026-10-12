import { buildCapabilityExecutionTarget } from '@/tools/execution-target';
import { sendMobileCapabilityCommand } from '@/tools/mobile/sender';
import type { ToolDefinition } from '@/tools/types';

// mobile.alarm (BLOCK 11 §3). Cola declarada en el catálogo: el teléfono persiste
// la alarma y la dispara aunque Apollo no esté, así que sobrevive a un corte.
export const setMobileAlarmTool: ToolDefinition = {
  executionTarget: buildCapabilityExecutionTarget('mobile.alarm'),
  name: 'set_mobile_alarm',
  safety: 'safe',
  description:
    'Programa una alarma en el teléfono del usuario para una hora concreta. Usá esto cuando pida despertarlo o ponerle una alarma al celular. La hora va en formato 24hs HH:MM.',
  parameters: {
    type: 'object',
    properties: {
      hourMinute: {
        type: 'string',
        description: 'Hora de la alarma en formato 24hs, por ejemplo "07:30".',
      },
      label: {
        type: 'string',
        description:
          'Texto corto que identifica la alarma (ej: "Despertar", "Pastillas").',
      },
      repeatDaily: {
        type: 'boolean',
        description: 'true si la alarma tiene que repetirse todos los días.',
      },
    },
    required: ['hourMinute', 'label'],
  },
  async handler(args, context) {
    return sendMobileCapabilityCommand({
      context,
      capabilityName: 'mobile.alarm',
      args,
      successSummary: 'Alarma programada en el teléfono.',
      invalidPayloadSummary: 'La alarma necesita una hora HH:MM y una etiqueta.',
    });
  },
};

export const cancelMobileAlarmTool: ToolDefinition = {
  executionTarget: buildCapabilityExecutionTarget('mobile.alarm'),
  name: 'cancel_mobile_alarm',
  safety: 'safe',
  description:
    'Cancela una alarma del teléfono por su etiqueta. Usá esto cuando pida borrar o apagar una alarma del celular.',
  parameters: {
    type: 'object',
    properties: {
      label: {
        type: 'string',
        description: 'Etiqueta exacta de la alarma a cancelar.',
      },
    },
    required: ['label'],
  },
  async handler(args, context) {
    return sendMobileCapabilityCommand({
      context,
      capabilityName: 'mobile.alarm',
      commandName: 'alarm_cancel',
      args,
      successSummary: 'Alarma cancelada.',
      invalidPayloadSummary: 'La alarma necesita una etiqueta.',
    });
  },
};
