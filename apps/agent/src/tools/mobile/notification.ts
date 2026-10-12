import { buildCapabilityExecutionTarget } from '@/tools/execution-target';
import { sendMobileCapabilityCommand } from '@/tools/mobile/sender';
import type {
  JsonSerializableValue,
  ToolDefinition,
  ToolExecutionResult,
} from '@/tools/types';

// mobile.notifications (Block 9, sin cambios de comportamiento en Block 11: sólo
// se movió al folder `mobile/` para no dejar un archivo de tools monolítico).

export type SendMobileNotificationInput = {
  readonly context: Parameters<typeof sendMobileCapabilityCommand>[0]['context'];
  readonly args: JsonSerializableValue | undefined;
  readonly sendCommand?: Parameters<typeof sendMobileCapabilityCommand>[0]['sendCommand'];
};

export async function sendMobileNotification(
  input: SendMobileNotificationInput,
): Promise<ToolExecutionResult> {
  return sendMobileCapabilityCommand({
    context: input.context,
    capabilityName: 'mobile.notifications',
    args: input.args,
    successSummary: 'Notificación enviada al teléfono.',
    invalidPayloadSummary: 'La notificación necesita un título y un mensaje.',
    ...(input.sendCommand === undefined ? {} : { sendCommand: input.sendCommand }),
  });
}

export const sendMobileNotificationTool: ToolDefinition = {
  executionTarget: buildCapabilityExecutionTarget('mobile.notifications'),
  name: 'send_mobile_notification',
  safety: 'safe',
  description:
    'Muestra una notificación en el teléfono del usuario. Usá esto cuando pida mandarle una alerta, un aviso o un recordatorio al celular. Necesita un título y un mensaje breve.',
  parameters: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description: 'Título corto de la notificación (ej: "Recordatorio", "Apollo")',
      },
      body: {
        type: 'string',
        description: 'Mensaje de la notificación. Uno o dos oraciones.',
      },
    },
    required: ['title', 'body'],
  },
  async handler(args, context) {
    return sendMobileNotification({ context, args });
  },
};
