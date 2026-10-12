import { z } from 'zod';

import type { MobileEndpointSessionSnapshot } from '@/devices/endpoint';

// ─────────────────────────────────────────────────────────────────────────────
// Inspector de sesiones mobile: SOLO para el smoke test de concurrencia.
//
// No es un RPC. No hay @callable, no es alcanzable desde el WebSocket de un
// device, y en una deployment normal no existe en absoluto: depende de una
// variable de entorno del SERVIDOR, que un device no puede influenciar.
//
// La condición es deliberadamente del lado del servidor (env de wrangler), no
// del cliente: sin deviceId, sin deviceType, sin query param, sin flag que el
// device pueda mandar. Si el env no está, la respuesta es "no".
// ─────────────────────────────────────────────────────────────────────────────

// Subpath del path del bridge, no una ruta nueva: el mismo stub lo atiende y
// pasa por la misma auth de rol 'device'.
export const MOBILE_SESSION_INSPECTOR_PATH = '__inspect';

export function isMobileSessionInspectorEnabled(environment: Env): boolean {
  return environment.MOBILE_SESSION_INSPECTOR === 'enabled';
}

/**
 * BLOCK 12.2 §1: el roster de sesiones no se abre con una credencial de
 * teléfono.
 *
 * La regla es «sin bearer, sí; con bearer, no» y no «bearer enrolado, no». Se
 * podría afinar a lo segundo preguntando al store si esa credencial es la de un
 * teléfono, pero la versión amplia no necesita ninguna lectura, no depende del
 * estado del store y no deja que un bearer raro se cuele por una respuesta mal
 * resuelta. Lo que se pierde es mínimo: el camino del operador es `?token=`, que
 * no es un bearer, así que sigue entrando.
 *
 * El motivo es que este diagnóstico lista el deviceId, la presencia y las
 * capabilities de TODOS los teléfonos. Un teléfono que lo lee conoce el resto de
 * la flota, que es exactamente lo que el enrollment vino a impedir.
 */
export function isInspectorRequestDenied(bearerCredential: string | null): boolean {
  return bearerCredential !== null;
}

export function isMobileSessionInspectorRequest(input: {
  readonly pathname: string;
  readonly upgradeHeader: string | null;
  readonly environment: Env;
}): boolean {
  if (!isMobileSessionInspectorEnabled(input.environment)) {
    return false;
  }
  // Un WebSocket nunca es el inspector: un device no debe poder llegar por ahí
  // aunque el flag esté puesto.
  if (input.upgradeHeader !== null) {
    return false;
  }
  return input.pathname.endsWith(`/${MOBILE_SESSION_INSPECTOR_PATH}`);
}

// Whitelist estricta de lo que el inspector puede publicar. Al ser strict(),
// cualquier campo que alguien agregue al modelo (un proof, un token, un
// secret) hace fallar el parse y el inspector responde 503 en vez de filtrarlo.
const inspectorSessionSchema = z
  .object({
    deviceId: z.string().min(1),
    deviceType: z.string().min(1),
    authenticated: z.literal(true),
    presence: z.string().min(1),
    connectionId: z.string().min(1),
    transportKind: z.string().min(1),
    protocolVersion: z.number().int().positive(),
    lastSeenAt: z.number().int().nonnegative(),
    declaredCapabilities: z.array(z.string()),
    availableCapabilities: z.array(z.string()),
  })
  .strict();

const inspectorSnapshotSchema = z
  .object({
    connectedCount: z.number().int().nonnegative(),
    handshakenConnectionCount: z.number().int().nonnegative(),
    sessionCount: z.number().int().nonnegative(),
    heartbeatSchedulerCount: z.number().int().nonnegative(),
    runningHeartbeatTimerCount: z.number().int().nonnegative(),
    sessionList: z.array(inspectorSessionSchema),
  })
  .strict();

export function buildMobileSessionInspectorResponse(
  snapshot: MobileEndpointSessionSnapshot,
): Response {
  const parsed = inspectorSnapshotSchema.safeParse(snapshot);
  if (!parsed.success) {
    return new Response('Inspector unavailable', { status: 503 });
  }
  return Response.json(parsed.data, { headers: { 'Cache-Control': 'no-store' } });
}
