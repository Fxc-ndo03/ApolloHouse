/**
 * FASE 3.1 — Lógica pura del panel de actualizaciones de Apollo Desktop.
 *
 * Vive separada del componente a propósito: son reglas de producto comprobables
 * (qué se le muestra a la persona, cuándo se ofrece instalar, cuándo se puede
 * posponer) y no deben depender de React ni de Tauri para verificarse.
 *
 * Estas funciones NUNCA deciden si un artefacto es auténtico: eso lo hace la
 * firma minisign del plugin oficial de Tauri. Acá sólo se decide cómo explicar
 * un resultado ya verificado.
 */

export type UpdateStatusKind =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'upToDate' }
  | { kind: 'available' }
  | { kind: 'downloading'; percent: number }
  | { kind: 'ready' }
  | { kind: 'pendingRestart' }
  | { kind: 'deferred'; untilEpochSeconds: number }
  | { kind: 'failed'; reason: string };

export type UpdateStatus = {
  channel: string;
  installedVersion: string;
  status: UpdateStatusKind;
  latestVersion: string | null;
  notes: string | null;
  publishedAt: string | null;
  message: string | null;
};

/**
 * FASE 3.4 — C1. Esta forma ES el contrato, no una suposición.
 *
 * Rust serializa con `tag = "kind"`, de modo que `status` SIEMPRE llega como
 * objeto con `kind`. Antes, Rust lo emitía como cadena suelta (`"idle"`) y la UI
 * leía `status.kind` sobre una primitiva: `undefined`, subtítulo "Estado
 * desconocido" y botón de instalar que nunca aparecía.
 *
 * El contrato vive en `apps/mobile/__tests__/fixtures/update-status-contract.json`
 * y lo verifican las dos suites.
 */
export const UPDATE_STATUS_KINDS = [
  'idle',
  'checking',
  'upToDate',
  'available',
  'downloading',
  'ready',
  'pendingRestart',
  'deferred',
  'failed',
] as const;

export type UpdateStatusKindName = (typeof UPDATE_STATUS_KINDS)[number];

const RETRYABLE_AUDIT_FAILURE =
  'No se pudo verificar el manifiesto del canal. Reintenta la comprobacion.';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function optionalNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Convierte el JSON crudo de Rust en `UpdateStatusKind`, sin lanzar nunca.
 *
 * Es la defensa que faltaba: un estado desconocido, un `kind` que no existe o
 * campos ausentes NO pueden romper la pantalla de Ajustes. Lo que no se
 * reconoce se degrada a `failed` con un motivo seguro, que además es
 * reintentable, en vez de tragarse el error.
 */
export function normalizeUpdateStatusKind(raw: unknown): UpdateStatusKind {
  if (!isRecord(raw)) return { kind: 'failed', reason: RETRYABLE_AUDIT_FAILURE };

  const kind = raw['kind'];
  switch (kind) {
    case 'idle':
      return { kind: 'idle' };
    case 'checking':
      return { kind: 'checking' };
    case 'upToDate':
      return { kind: 'upToDate' };
    case 'available':
      return { kind: 'available' };
    case 'ready':
      return { kind: 'ready' };
    case 'pendingRestart':
      return { kind: 'pendingRestart' };
    case 'downloading': {
      const percent = optionalNumber(raw['percent']);
      // Sin porcentaje utilizable no se inventa uno: se marca como listo.
      return percent === null ? { kind: 'ready' } : { kind: 'downloading', percent: clampPercent(percent) };
    }
    case 'deferred': {
      const untilEpochSeconds = optionalNumber(raw['untilEpochSeconds']);
      return untilEpochSeconds === null
        ? { kind: 'idle' }
        : { kind: 'deferred', untilEpochSeconds };
    }
    case 'failed': {
      const reason = optionalText(raw['reason']);
      return { kind: 'failed', reason: reason ?? RETRYABLE_AUDIT_FAILURE };
    }
    default:
      return { kind: 'failed', reason: RETRYABLE_AUDIT_FAILURE };
  }
}

/**
 * Normaliza el sobre completo que devuelve `invoke('check_for_update')`.
 *
 * El canal y la versión instalada nunca se inventan: si faltan, se usan valores
 * explícitos y la pantalla muestra que no los conoce, en vez de mentir.
 */
export function normalizeUpdateStatus(raw: unknown): UpdateStatus {
  const record = isRecord(raw) ? raw : {};
  const channel = optionalText(record['channel']) ?? 'desconocido';
  return {
    channel,
    installedVersion: optionalText(record['installedVersion']) ?? '?',
    status: normalizeUpdateStatusKind(record['status']),
    latestVersion: optionalText(record['latestVersion']),
    notes: optionalText(record['notes']),
    publishedAt: optionalText(record['publishedAt']),
    message: optionalText(record['message']),
  };
}

function clampPercent(percent: number): number {
  return Math.min(100, Math.max(0, Math.round(percent)));
}

/** Texto de una línea para el subtítulo de la sección. */
export function describeUpdateState(status: UpdateStatus): string {
  switch (status.status.kind) {
    case 'idle':
      return 'Aun no se comprobo';
    case 'checking':
      return 'Comprobando actualizaciones...';
    case 'upToDate':
      return `Apollo esta al dia (${status.installedVersion})`;
    case 'available':
      return `Hay una version nueva: ${status.latestVersion ?? '?'}`;
    case 'downloading':
      return `Descargando ${status.status.percent}%`;
    case 'ready':
      return 'Descarga lista para instalar';
    case 'pendingRestart':
      return `Actualizado a ${status.latestVersion ?? '?'}. Falta reiniciar`;
    case 'deferred':
      return 'Actualizacion pospuesta';
    case 'failed':
      return status.status.reason;
    default:
      return 'Estado desconocido';
  }
}

/** Normaliza el progreso que emite Rust; devuelve null si no es un porcentaje. */
export function readProgressPercent(raw: unknown): number | null {
  if (typeof raw !== 'number') return null;
  if (!Number.isFinite(raw)) return null;
  return Math.min(100, Math.max(0, Math.round(raw)));
}

/**
 * ¿Se ofrece el botón de instalar?
 *
 * Sólo cuando hay algo verificado pendiente. Un estado `failed` NO ofrece
 * instalar: ofrece reintentar, porque puede ser un error de red (que sí es
 * reintentable) o de seguridad (que no lo es) y no se distinguen aquí.
 */
export function shouldOfferInstall(status: UpdateStatusKind): boolean {
  return status.kind === 'available';
}

/** ¿El error es reintentable sin que el usuario tenga que hacer nada raro? */
export function isRetryableFailure(reason: string): boolean {
  const lowered = reason.toLowerCase();
  if (lowered.includes('firma')) return false;
  if (lowered.includes('no es valida')) return false;
  if (lowered.includes('faltan bytes')) return false;
  if (lowered.includes('no coinciden')) return false;
  return (
    lowered.includes('no se pudo contactar') ||
    lowered.includes('timeout') ||
    lowered.includes('reintenta') ||
    lowered.includes('no hay espacio')
  );
}

/** Horas hasta las que se puede posponer una actualización automática. */
export const ALLOWED_POSTPONE_HOURS = [1, 6, 24, 72] as const;

export type PostponeHours = (typeof ALLOWED_POSTPONE_HOURS)[number];

/**
 * Calcula el instante hasta el que se pospone.
 *
 * Se rechaza cualquier valor fuera de la lista: posponer "para siempre"
 * convertiría al actualizador en algo opcional de facto, y posponer 0 sería un
 * bucle de avisos.
 */
export function postponeDeadline(
  nowEpochSeconds: number,
  hours: number,
): { ok: true; untilEpochSeconds: number } | { ok: false; reason: string } {
  if (!ALLOWED_POSTPONE_HOURS.includes(hours as PostponeHours)) {
    return {
      ok: false,
      reason: `Solo se puede posponer ${ALLOWED_POSTPONE_HOURS.join(', ')} horas`,
    };
  }
  return { ok: true, untilEpochSeconds: nowEpochSeconds + hours * 3600 };
}

/** ¿Toca avisar? Con todo al día, no: el silencio es el comportamiento correcto. */
export function shouldNotifyUser(status: UpdateStatusKind): boolean {
  return status.kind === 'available' || status.kind === 'pendingRestart';
}

/** Una app de staging nunca debe mostrar un canal estable ni al revés. */
export function isStagingApp(status: UpdateStatus): boolean {
  return status.channel.toLowerCase() === 'staging';
}