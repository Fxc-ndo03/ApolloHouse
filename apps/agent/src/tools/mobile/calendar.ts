import { buildCapabilityExecutionTarget } from '@/tools/execution-target';
import { mobileCalendarCancelPayloadSchema } from '@/devices/payload';
import { sendMobileCapabilityCommand } from '@/tools/mobile/sender';
import type { ToolDefinition } from '@/tools/types';

// mobile.calendar (BLOCK 11 §3). El peer valida el payload con
// mobileCalendarCreatePayloadSchema, que es el que el bridge usa también.

export const createMobileCalendarEventTool: ToolDefinition = {
  executionTarget: buildCapabilityExecutionTarget('mobile.calendar'),
  name: 'create_mobile_calendar_event',
  safety: 'safe',
  description:
    'Crea un evento en el calendario del teléfono. Usá esto cuando pida agendar o anotar algo en el calendario del celular.',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Título del evento.' },
      startsAt: {
        type: 'string',
        description: 'Fecha y hora de inicio en ISO 8601 (ej: "2026-10-08T15:00:00").',
      },
      location: { type: 'string', description: 'Lugar del evento, opcional.' },
    },
    required: ['title', 'startsAt'],
  },
  async handler(args, context) {
    return sendMobileCapabilityCommand({
      context,
      capabilityName: 'mobile.calendar',
      args,
      successSummary: 'Evento anotado en el calendario del teléfono.',
      invalidPayloadSummary: 'El evento necesita un título y una fecha de inicio.',
    });
  },
};

export const cancelMobileCalendarEventTool: ToolDefinition = {
  executionTarget: buildCapabilityExecutionTarget('mobile.calendar'),
  name: 'cancel_mobile_calendar_event',
  safety: 'unsafe',
  description:
    'Borra un evento del calendario del teléfono por su título. Pide confirmación porque borra algo.',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Título exacto del evento a borrar.' },
    },
    required: ['title'],
  },
  buildConfirmSummary(args) {
    const parsed = mobileCalendarCancelPayloadSchema.safeParse(args);
    return parsed.success
      ? `Borrar "${parsed.data.title}" del calendario del teléfono`
      : 'Borrar un evento del calendario del teléfono';
  },
  async handler(args, context) {
    return sendMobileCapabilityCommand({
      context,
      capabilityName: 'mobile.calendar',
      commandName: 'calendar_cancel',
      args,
      successSummary: 'Evento borrado del calendario.',
      invalidPayloadSummary: 'El evento necesita un título.',
    });
  },
};

export const listMobileCalendarEventsTool: ToolDefinition = {
  executionTarget: buildCapabilityExecutionTarget('mobile.calendar'),
  name: 'list_mobile_calendar_events',
  safety: 'safe',
  description:
    'Lista los eventos del calendario del teléfono. Usá esto cuando pregunte qué tiene agendado el celular.',
  parameters: {
    type: 'object',
    properties: {
      withinDays: {
        type: 'number',
        description:
          'Cuántos días hacia adelante mirar, de 1 a 30. Por defecto 1 (solo hoy).',
      },
    },
    required: [],
  },
  async handler(args, context) {
    return sendMobileCapabilityCommand({
      context,
      capabilityName: 'mobile.calendar',
      commandName: 'calendar_list',
      args,
      successSummary: 'Consulté el calendario del teléfono.',
      buildSuccessSummary: (result) => {
        const eventList = readCalendarEventList(result);
        if (eventList.length === 0) {
          return 'El calendario del teléfono no tiene eventos en ese rango.';
        }
        return `El teléfono tiene ${eventList.length} ${
          eventList.length === 1 ? 'evento' : 'eventos'
        }: ${eventList
          .slice(0, 3)
          .map((eventSummary) => eventSummary.title)
          .join(', ')}.`;
      },
      invalidPayloadSummary: 'La ventana del calendario va de 1 a 30 días.',
    });
  },
};

type CalendarEventSummary = {
  readonly title: string;
  readonly startsAt: string;
  readonly location: string;
};

function readCalendarEventList(result: unknown): readonly CalendarEventSummary[] {
  if (typeof result !== 'object' || result === null) {
    return [];
  }
  const eventList = (result as { readonly events?: unknown }).events;
  if (!Array.isArray(eventList)) {
    return [];
  }
  return eventList.filter(
    (item): item is CalendarEventSummary =>
      typeof item === 'object' &&
      item !== null &&
      typeof (item as { readonly title?: unknown }).title === 'string' &&
      typeof (item as { readonly startsAt?: unknown }).startsAt === 'string',
  );
}
