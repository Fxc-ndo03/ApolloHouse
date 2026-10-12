import { z } from 'zod';

import type { CapabilityName } from '@/devices/capability';

// ─────────────────────────────────────────────────────────────────────────────
// Eventos de ejecución sobre un device.
//
// Reutilizan la infraestructura que ya existe (mismo shape que
// CapabilityExecutionEvent) y agregan los tres que faltaban para poder seguir
// una ejecución de punta a punta sin ruido.
//
// Metadata mínima a propósito: request_id, client_turn_id, generation, tool,
// capability y target. El título y el cuerpo de la notificación NO se loggean —
// son contenido del usuario, no diagnóstico.
// ─────────────────────────────────────────────────────────────────────────────

export const DEVICE_EXECUTION_EVENT_NAME_LIST = [
  'device_execution_started',
  'device_execution_completed',
  'device_execution_failed',
] as const;

export type DeviceExecutionEventName = (typeof DEVICE_EXECUTION_EVENT_NAME_LIST)[number];

export const deviceExecutionEventNameSchema = z.enum(DEVICE_EXECUTION_EVENT_NAME_LIST);

export type DeviceExecutionCorrelation = {
  readonly requestId?: string | null;
  readonly clientTurnId?: string | null;
  readonly generation?: number | null;
};

export type DeviceExecutionEvent = DeviceExecutionCorrelation & {
  readonly event: DeviceExecutionEventName;
  readonly toolName: string;
  readonly capabilityName: CapabilityName | null;
  readonly targetDeviceId: string | null;
  readonly targetDeviceType: string | null;
  // Motivo estructurado del fallo. Nunca contenido del payload.
  readonly reason?: string | null;
  readonly durationMs?: number | null;
  // BLOCK 11 §21: el round trip del comando partido en sus dos mitades, para
  // poder distinguir "tardamos en encolar" de "el device tardó en responder".
  // Los dos se miden con Date.now() real: no hay tiempos inventados.
  readonly deviceDispatchMs?: number | null;
  readonly deviceResponseMs?: number | null;
};

export function buildDeviceExecutionEventLogLine(event: DeviceExecutionEvent): string {
  return JSON.stringify({
    level: 'info',
    message: event.event,
    tool_name: event.toolName,
    capability: event.capabilityName,
    target_device_id: event.targetDeviceId,
    target_device_type: event.targetDeviceType,
    reason: event.reason ?? null,
    duration_ms: event.durationMs ?? null,
    device_dispatch_ms: event.deviceDispatchMs ?? null,
    device_response_ms: event.deviceResponseMs ?? null,
    request_id: event.requestId ?? null,
    client_turn_id: event.clientTurnId ?? null,
    generation: event.generation ?? null,
  });
}

export function emitDeviceExecutionEvent(event: DeviceExecutionEvent): void {
  console.log(buildDeviceExecutionEventLogLine(event));
}
