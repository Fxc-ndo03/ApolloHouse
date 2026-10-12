// Política de presencia y heartbeat.
//
// El heartbeat NO es un timer nuevo: es el ping de 30 s que PcBridge ya envía y
// el pong que el cliente ya responde (ver src/agents/pc-bridge.ts y
// apps/desktop/src-tauri/src/pcbridge.rs). Estos valores son la única fuente de
// verdad del timing; nada más debe inventar números.
//
//   ONLINE   : heartbeat dentro de la ventana reciente.
//   DEGRADED : conectado, pero el heartbeat se atrasó más de un intervalo.
//   OFFLINE  : el heartbeat es más viejo que la ventana offline, o el socket
//              está cerrado.
//
// Los umbrales son múltiplos del intervalo: 1.5x y 3x.

export const HEARTBEAT_INTERVAL_MILLISECONDS = 30_000;
export const PRESENCE_DEGRADED_AFTER_MILLISECONDS = 45_000;
export const PRESENCE_OFFLINE_AFTER_MILLISECONDS = 90_000;

export type PresenceState = 'online' | 'offline' | 'degraded' | 'unknown';
export type ConnectionState = 'open' | 'closed';

export type PresenceSignal = {
  readonly connectionState: ConnectionState;
  readonly lastHeartbeatAt: number | null;
};

export function resolvePresenceFromSignal(
  signal: PresenceSignal,
  nowMilliseconds: number,
): PresenceState {
  if (signal.connectionState === 'closed') {
    return 'offline';
  }
  if (signal.lastHeartbeatAt === null) {
    return 'unknown';
  }
  const heartbeatAge = nowMilliseconds - signal.lastHeartbeatAt;
  if (heartbeatAge >= PRESENCE_OFFLINE_AFTER_MILLISECONDS) {
    return 'offline';
  }
  if (heartbeatAge >= PRESENCE_DEGRADED_AFTER_MILLISECONDS) {
    return 'degraded';
  }
  return 'online';
}

// Antigüedad máxima tolerable antes de considerar un device no disponible. Es un
// alias del umbral offline: mismo número, otro nombre para quien consulta.
export const PRESENCE_STALE_MILLISECONDS = PRESENCE_OFFLINE_AFTER_MILLISECONDS;

export function isPresenceSelectable(presence: PresenceState): boolean {
  return presence === 'online' || presence === 'degraded';
}
