import { z } from 'zod';

// ─────────────────────────────────────────────────────────────────────────────
// Harness de ejecución de tools dentro del Apollo DO.
//
// Existe para una sola cosa: probar el CAMINO DE PRODUCCIÓN de Apollo contra el
// MobileBridge sobre workerd real — resolver target, autorizar y ejecutar, sin
// mocks. Corre exactamente el mismo `executeToolWithTargetResolution` con el
// mismo `buildCapabilityTargetResolver` y el mismo catálogo que un turno real.
//
// NO es un @callable (Block 9.2): no existe en el RPC del WebSocket ni para el
// AgentClient del SDK, así que ningún cliente de device puede invocarlo. Se
// atiende en un fetch HTTP bajo un subpath del propio Apollo, y sólo si el
// servidor tiene la condición test-only prendida. Sin esa variable — que en una
// deployment real no existe — la superficie no existe, ni por RPC ni por HTTP.
//
// Es capability-agnostic: recibe un toolName, nunca una capability.
// ─────────────────────────────────────────────────────────────────────────────

// Subpath del path del Apollo, no una ruta nueva: el mismo stub lo atiende y
// pasa por la misma auth (authorizeApolloHttpRequest) que cualquier otra.
export const APOLLO_TOOL_HARNESS_PATH = '__tool-harness';

export function isApolloToolHarnessEnabled(environment: Env): boolean {
  return environment.APOLLO_TOOL_HARNESS === 'enabled';
}

// Igual que el inspector: sólo una petición HTTP (nunca un WebSocket) puede ser
// un harness, y sólo con el env prendido. La decisión NO lee nada del cliente:
// ni token, ni deviceId, ni deviceType, ni flags.
export function isApolloToolHarnessRequest(input: {
  readonly pathname: string;
  readonly upgradeHeader: string | null;
  readonly environment: Env;
}): boolean {
  if (!isApolloToolHarnessEnabled(input.environment)) {
    return false;
  }
  if (input.upgradeHeader !== null) {
    return false;
  }
  return input.pathname.endsWith(`/${APOLLO_TOOL_HARNESS_PATH}`);
}

export const apolloToolHarnessRequestSchema = z
  .object({
    toolName: z.string().min(1).max(64),
    args: z.record(z.unknown()).optional(),
    // strict() también acá: si un cliente manda un deviceId dentro de la
    // correlación no queremos que se ignore en silencio, sino que se rechace.
    correlation: z
      .object({
        requestId: z.string().min(1).max(128).optional(),
        clientTurnId: z.string().min(1).max(128).optional(),
        generation: z.number().int().nonnegative().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type ApolloToolHarnessRequest = z.infer<typeof apolloToolHarnessRequestSchema>;

export function readApolloToolHarnessRequest(rawBody: string): {
  readonly status: 'parsed' | 'invalid';
  readonly request?: ApolloToolHarnessRequest;
} {
  let rawJson: unknown;
  try {
    rawJson = JSON.parse(rawBody) as unknown;
  } catch {
    return { status: 'invalid' };
  }
  const parsed = apolloToolHarnessRequestSchema.safeParse(rawJson);
  return parsed.success
    ? { status: 'parsed', request: parsed.data }
    : { status: 'invalid' };
}

export function buildApolloToolHarnessDisabledResponse(): Response {
  // 404 y no 403: sin la variable, la superficie no existe — no es una puerta
  // cerrada, es una que no está.
  return new Response('Not found', { status: 404 });
}
