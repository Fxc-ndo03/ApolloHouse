import { z } from 'zod';

import { mobileNotificationPayloadSchema } from '@/protocol/schema';

// Payloads mobile estrictos (BLOCK 11 §3).
//
// Una sola fuente de verdad: el bridge valida con esto antes de tocar el socket,
// la tool valida antes de llamar al bridge, y el peer valida lo que recibe. Los
// tres usan el MISMO schema, así que no puede haber drift entre lo que Apollo
// cree mandar y lo que el teléfono acepta.
//
// `.strict()` en todos: un campo extra se rechaza en vez de ignorarse.

const hourMinutePattern = /^([01]\d|2[0-3]):[0-5]\d$/;

export const mobileAlarmSetPayloadSchema = z
  .object({
    hourMinute: z.string().regex(hourMinutePattern, 'La hora debe tener formato HH:MM.'),
    label: z.string().min(1).max(80),
    // Repetir el aviso tiene sentido en un teléfono aunque Apollo esté offline.
    repeatDaily: z.boolean().default(false),
  })
  .strict();
export type MobileAlarmSetPayload = z.infer<typeof mobileAlarmSetPayloadSchema>;

export const mobileAlarmCancelPayloadSchema = z
  .object({
    label: z.string().min(1).max(80),
  })
  .strict();
export type MobileAlarmCancelPayload = z.infer<typeof mobileAlarmCancelPayloadSchema>;

export const mobileCalendarCreatePayloadSchema = z
  .object({
    title: z.string().min(1).max(120),
    startsAt: z.string().min(1).max(40),
    location: z.string().max(160).default(''),
  })
  .strict();
export type MobileCalendarCreatePayload = z.infer<
  typeof mobileCalendarCreatePayloadSchema
>;

export const mobileCalendarListPayloadSchema = z
  .object({
    // Ventana relativa en días: el teléfono decide qué significa "hoy".
    withinDays: z.number().int().min(1).max(30).default(1),
  })
  .strict();
export type MobileCalendarListPayload = z.infer<typeof mobileCalendarListPayloadSchema>;

export const mobileCalendarCancelPayloadSchema = z
  .object({
    title: z.string().min(1).max(120),
  })
  .strict();
export type MobileCalendarCancelPayload = z.infer<
  typeof mobileCalendarCancelPayloadSchema
>;

export const mobileMediaCommandPayloadSchema = z
  .object({
    query: z.string().min(1).max(120).default(''),
  })
  .strict();
export type MobileMediaCommandPayload = z.infer<typeof mobileMediaCommandPayloadSchema>;

export const mobileVolumeSetPayloadSchema = z
  .object({
    level: z.number().int().min(0).max(100),
  })
  .strict();
export type MobileVolumeSetPayload = z.infer<typeof mobileVolumeSetPayloadSchema>;

// volume_get no necesita payload, pero el envelope siempre manda `payload`, así
// que se declara vacío y estricto para que un campo extra también se rechace.
export const mobileVolumeGetPayloadSchema = z.object({}).strict();
export type MobileVolumeGetPayload = z.infer<typeof mobileVolumeGetPayloadSchema>;

export const mobileOpenAppPayloadSchema = z
  .object({
    appName: z.string().min(1).max(64),
  })
  .strict();
export type MobileOpenAppPayload = z.infer<typeof mobileOpenAppPayloadSchema>;

/**
 * El payload lo define el COMANDO, no la capability (BLOCK 11 §4).
 *
 * Esto se corrigió porque el cliente Kotlin lo encontró ejecutando de verdad:
 * `alarm_set` manda `{hourMinute, label}` y `alarm_cancel` manda `{label}`. Con
 * un schema por capability, `cancel_mobile_alarm` fallaba SIEMPRE con
 * `invalid_payload` porque le exigía la hora. Un comando por schema elimina la
 * ambigüedad.
 *
 * `notification_post` reusa el schema de Block 9 en vez de duplicarlo.
 */
const MOBILE_COMMAND_PAYLOAD_SCHEMA_MAP: ReadonlyMap<
  string,
  z.ZodType<unknown>
> = new Map<string, z.ZodType<unknown>>([
  ['notification_post', mobileNotificationPayloadSchema],
  ['alarm_set', mobileAlarmSetPayloadSchema],
  ['alarm_cancel', mobileAlarmCancelPayloadSchema],
  ['calendar_create', mobileCalendarCreatePayloadSchema],
  ['calendar_list', mobileCalendarListPayloadSchema],
  ['calendar_cancel', mobileCalendarCancelPayloadSchema],
  ['media_play', mobileMediaCommandPayloadSchema],
  ['media_pause', mobileMediaCommandPayloadSchema],
  ['media_next', mobileMediaCommandPayloadSchema],
  ['media_previous', mobileMediaCommandPayloadSchema],
  ['volume_set', mobileVolumeSetPayloadSchema],
  ['volume_get', mobileVolumeGetPayloadSchema],
  ['app_open', mobileOpenAppPayloadSchema],
]);

/**
 * Todo comando mobile declarado en el catálogo tiene schema. Si mañana se agrega
 * un comando sin schema, el typecheck no lo detecta pero este helper sí: `listMobileCommandNameList`
 * se contrasta contra las keys en `src/devices/__tests__/command.spec.ts`.
 */
export function readMobilePayloadSchema(commandName: string): z.ZodType<unknown> {
  const schema = MOBILE_COMMAND_PAYLOAD_SCHEMA_MAP.get(commandName);
  if (schema === undefined) {
    throw new Error(`No hay payload schema para el comando ${commandName}`);
  }
  return schema;
}

export type MobilePayloadParseOutcome =
  | { readonly isValid: true; readonly payload: Record<string, unknown> }
  | { readonly isValid: false; readonly detail: string };

/**
 * Valida el payload de una capability mobile. Devuelve un detalle legible para
 * que el error al usuario no sea "ZodError".
 */
export function parseMobileCommandPayload(
  commandName: string,
  payload: unknown,
): MobilePayloadParseOutcome {
  const parsed = readMobilePayloadSchema(commandName).safeParse(payload);
  if (parsed.success) {
    return { isValid: true, payload: parsed.data as Record<string, unknown> };
  }
  const issue = parsed.error.issues[0];
  const fieldPath = issue?.path.join('.') ?? '';
  const message = issue?.message ?? 'payload inválido';
  return {
    isValid: false,
    detail: fieldPath === '' ? message : `${fieldPath}: ${message}`,
  };
}
