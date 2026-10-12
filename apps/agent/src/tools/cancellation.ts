import type { CapabilityUnavailableReason } from '@/devices/registry';

// ─────────────────────────────────────────────────────────────────────────────
// Pipeline único de cancelación.
//
// Un solo lugar decide, para cada razón:
//   - el texto que oye el usuario (caption y TTS),
//   - si el resultado es reintentable,
//   - la etiqueta de telemetría.
//
// Lo usan igual el camino determinista, el tool loop del LLM, el motor de
// confirmación y la revalidación de target. No se duplica un string en otro
// módulo: la fuente es este mapa.
// ─────────────────────────────────────────────────────────────────────────────

export type CancellationReason =
  | 'expired'
  | 'rejected'
  | 'target_offline'
  | 'target_unavailable'
  | 'capability_absent'
  | 'no_device'
  | 'unimplemented'
  | 'unknown_tool';

export type CancellationResult = {
  readonly reason: CancellationReason;
  readonly message: string;
  readonly retryable: boolean;
};

// Ninguna cancelación es reintentable: todas son estructurales (el device no
// está, la capability no existe, la confirmación venció). Un error transitorio
// de una tool NO es una cancelación y sigue el comportamiento de siempre; sólo
// una tool que declare retry seguro podría reintentarse, y hoy ninguna lo
// hace. Un retry nunca lo decide el modelo.
const CANCELLATION_TEXT_MAP: ReadonlyMap<CancellationReason, string> = new Map([
  ['expired', 'La confirmación expiró.'],
  ['rejected', 'Cancelado.'],
  [
    'target_offline',
    'Ese dispositivo se desconectó antes de ejecutar la acción. No lo hice.',
  ],
  ['target_unavailable', 'Ese dispositivo no está disponible ahora.'],
  ['capability_absent', 'Ese dispositivo no puede hacer eso.'],
  ['no_device', 'No tengo ningún dispositivo conectado.'],
  ['unimplemented', 'Todavía no puedo hacer eso.'],
  ['unknown_tool', 'No encontré la herramienta para eso.'],
]);

const RETRYABLE_CANCELLATION_REASON_SET = new Set<CancellationReason>([]);

export function buildCancellationResult(reason: CancellationReason): CancellationResult {
  return {
    reason,
    message: CANCELLATION_TEXT_MAP.get(reason) ?? 'No pude hacer eso.',
    retryable: RETRYABLE_CANCELLATION_REASON_SET.has(reason),
  };
}

// Las razones de indisponibilidad del registry son reasons de cancelación.
export function toCancellationReason(
  unavailableReason: CapabilityUnavailableReason,
): CancellationReason {
  switch (unavailableReason) {
    case 'no_device':
    case 'capability_absent':
    case 'target_unavailable':
    case 'unimplemented':
    case 'target_offline':
      return unavailableReason;
    default:
      return 'target_unavailable';
  }
}

export function buildCancellationToolResult(cancellation: CancellationResult): {
  readonly ok: false;
  readonly summary: string;
} & {
  readonly metadata: {
    readonly reason: CancellationReason;
    readonly retryable: boolean;
  };
} {
  return {
    ok: false,
    summary: cancellation.message,
    metadata: { reason: cancellation.reason, retryable: cancellation.retryable },
  };
}
