import { z } from 'zod';

import {
  isDeviceSharedSecretValid,
  readBearerCredentialFromRequest,
  readDeviceTokenFromRequestUrl,
} from '@/auth/token';
import {
  claimEnrollmentChallenge,
  isDeviceCredentialShaped,
  issueEnrollmentChallenge,
  type EnrollmentStore,
} from '@/devices/enrollment';
import { resolveMobileBridgeClient } from '@/devices/bridge-client';
import { deviceIdSchema } from '@/devices/identity';

// ─────────────────────────────────────────────────────────────────────────────
// BLOCK 12: la frontera de autorización del endpoint mobile.
//
// Antes de este bloque había UN secreto para todos: `?token=DEVICE_SHARED_SECRET`
// abría el socket y `mobile-bridge.ts` fabricaba el mismo proof para cualquier
// conexión que llegara. No existía identidad por dispositivo, así que revocar
// un teléfono era imposible de expresar.
//
// Ahora hay DOS ámbitos, y no se mezclan:
//
//   enrolled_android      Authorization: Bearer <credencial individual>
//                         Se verifica contra el hash guardado, en el servidor.
//
//   legacy_shared_secret  ?token=<DEVICE_SHARED_SECRET>
//                         Desktop y teléfonos legacy. Sin cambios.
//
// La separación no es una convención: si viene `Authorization`, se resuelve SÓLO
// por bearer y `?token=` se ignora. No hay fallback de uno al otro, así que una
// credencial revocada no puede "colarse" por el camino legacy, ni una credencial
// individual puede ser aceptada como secreto global.
//
// La autorización de verdad —incluido el rechazo de un deviceId revocado que
// vuelve por el camino legacy— vive en `devices/enrollment.ts` y se aplica en el
// DO. Acá sólo se decide si la petición llega.
// ─────────────────────────────────────────────────────────────────────────────

// Rutas y binding del bridge mobile. Sin cambios respecto de Block 8.1: PcBridge
// y Apollo siguen por su propio camino.
//
// El nombre de instancia del Apollo DO ES la identidad de un desk (memoria,
// preferencias, trabajo pendiente), y un teléfono no es un desk. MobileBridge es
// UNA sola instancia compartida que multiplexa todos los sockets mobile sobre un
// único registry: es el mismo patrón que PcBridge, que también es dueño de su
// registry y se consulta por RPC.
export const MOBILE_BRIDGE_AGENT_NAME = 'mobile-bridge';
export const MOBILE_BRIDGE_ROUTE_PREFIX = `/agents/${MOBILE_BRIDGE_AGENT_NAME}`;

export type MobileBridgeRouteDecision =
  | { readonly isMobileBridgeRoute: true; readonly instanceName: string }
  | { readonly isMobileBridgeRoute: false };

export function isMobileBridgeRequestPath(pathname: string): boolean {
  return pathname.startsWith(`${MOBILE_BRIDGE_ROUTE_PREFIX}/`);
}

// Un device se presenta siempre con Upgrade: websocket. Esto decide si la
// petición ES una conexión de dispositivo.
export function resolveMobileBridgeRoute(input: {
  readonly pathname: string;
  readonly upgradeHeader: string | null;
}): MobileBridgeRouteDecision {
  if (input.upgradeHeader?.toLowerCase() !== 'websocket') {
    return { isMobileBridgeRoute: false };
  }
  if (!isMobileBridgeRequestPath(input.pathname)) {
    return { isMobileBridgeRoute: false };
  }
  const instanceName = input.pathname.slice(MOBILE_BRIDGE_ROUTE_PREFIX.length + 1);
  if (instanceName.length === 0) {
    return { isMobileBridgeRoute: false };
  }
  return { isMobileBridgeRoute: true, instanceName };
}

export type MobileRequestAuth = {
  readonly scope: 'enrolled_android' | 'legacy_shared_secret';
};

export type MobileRouteAuthorization =
  | { readonly isAuthorized: true; readonly auth: MobileRequestAuth }
  | { readonly isAuthorized: false; readonly response: Response };

function unauthorizedResponse(): Response {
  // El body es exactamente 'Unauthorized': ni el motivo ni el secreto
  // presentado van en la respuesta. El por qué se queda en el log del servidor,
  // que es donde lo consulta el dueño y no un atacante anónimo.
  return new Response('Unauthorized', { status: 401 });
}

/**
 * Decide si una petición al endpoint mobile está autorizada, y con qué ámbito.
 *
 * Orden deliberado:
 *   1. Si hay `Authorization`, ése es el ámbito. Sin fallback al legacy.
 *   2. Si no hay `Authorization`, es el camino legacy: rol 'device' por
 *      `DEVICE_SHARED_SECRET`, exactamente como antes de este bloque.
 */
export async function authorizeMobileDeviceRequest(input: {
  readonly request: Request;
  readonly environment: Env;
}): Promise<MobileRouteAuthorization> {
  const bearerCredential = readBearerCredentialFromRequest(input.request);
  if (bearerCredential !== null) {
    // El borde NO verifica la credencial contra el store: el store vive en el
    // SQLite del DO y consultarlo desde acá sería un round-trip por conexión.
    //
    // Lo que sí hace el borde es descartar lo que no puede ser válido nunca: un
    // bearer con otra forma no es una credencial per-device. Eso es lo que
    // impide que alguien ponga DEVICE_SHARED_SECRET en el header Authorization
    // esperando que se lo aceptemos como credencial.
    //
    // La verificación real —y la revocación— pasan en `MobileBridge.onConnect`,
    // que es la única autoridad. Dos reglas de autorización en dos lugares es
    // exactamente cómo nace un bypass.
    if (!isDeviceCredentialShaped(bearerCredential)) {
      return { isAuthorized: false, response: unauthorizedResponse() };
    }
    return { isAuthorized: true, auth: { scope: 'enrolled_android' } };
  }

  // Camino legacy, idéntico al de antes: rol 'device' por el secreto global.
  const presentedToken = readDeviceTokenFromRequestUrl(new URL(input.request.url));
  const isLegacyDevice = await isDeviceSharedSecretValid(
    presentedToken,
    input.environment.DEVICE_SHARED_SECRET,
  );
  if (!isLegacyDevice) {
    return { isAuthorized: false, response: unauthorizedResponse() };
  }
  // Sin deviceId todavía: la regla anti-bypass se aplica en el DO, cuando llega
  // el hello, que es el primer momento en que el cliente declara su identidad.
  return { isAuthorized: true, auth: { scope: 'legacy_shared_secret' } };
}

// ─────────────────────────────────────────────────────────────────────────────
// Superficie HTTP de enrollment (§2).
//
// Rutas relativas al prefijo del bridge, sobre el MISMO DO que las conexiones,
// que es lo que hace posible revocar un socket vivo sin salir al Worker.
//
// La autenticación de estas rutas NO es la de device: issuing un desafío es una
// acción del dueño, así que pide el rol 'dashboard'. El claim NO pide nada,
// porque el teléfono todavía no tiene credencial: lo autoriza el desafío, que
// es de un solo uso y expira solo.
//
// El transporte del rol `dashboard` es `Authorization: Bearer` y sólo eso. Estas
// rutas NO comparten el camino `?token=` que sigue usando el ámbito legacy del
// socket mobile: ese `?token=` abre conexiones, no administra enrollment. Que un
// secreto sirva para una cosa no lo hace servir para la de al lado.
// ─────────────────────────────────────────────────────────────────────────────

export const ENROLLMENT_CHALLENGE_SUFFIX = '/enrollment/challenge';
export const ENROLLMENT_CLAIM_SUFFIX = '/enrollment/claim';
export const ENROLLMENT_REVOKE_SUFFIX = '/enrollment/revoke';

export type EnrollmentHttpResponse = {
  readonly status: number;
  readonly body: unknown;
};

/**
 * BLOCK 12.1 §4: el token del dashboard viaja en `Authorization: Bearer` para las
 * operaciones administrativas de enrollment, no en la URL.
 *
 * `Authorization` es el ÚNICO mecanismo. No hay fallback a `?token=`, y antes de
 * escribir esto el comentario afirmaba lo contrario: decía que `?token=` quedaba
 * "como compatibilidad" mientras el código no lo aceptaba. No era una decisión,
 * era un comentario equivocado que además se contradecía a sí mismo en la misma
 * frase ("no hay cliente legado que preservar" / "rompería a un script").
 *
 * No se agrega el fallback. Las rutas son nuevas de BLOCK 12, ningún cliente del
 * repo las llama con `?token=` —el único que las usa es `apps/mobile`, por
 * `Authorization`— y un token del dueño en la query aparece en los access logs,
 * en el `Referer` y en cualquier diagnóstico de URL.
 *
 * Comprobado sobre workerd: `?token=<DASHBOARD_SHARED_SECRET>` responde 401 en
 * `/enrollment/challenge` y en `/enrollment/revoke`.
 *
 * El bearer se compara contra DASHBOARD_SHARED_SECRET y NUNCA contra
 * DEVICE_SHARED_SECRET: una credencial de dispositivo no puede administrar
 * enrollment. Tampoco acepta el esquema `Basic`.
 */
function isOwnerAuthorized(request: Request, environment: Env): Promise<boolean> {
  return isDeviceSharedSecretValid(
    readBearerCredentialFromRequest(request),
    environment.DASHBOARD_SHARED_SECRET,
  );
}

/** §2 paso 2: el dueño pide un desafío. Devuelve el valor UNA vez, en claro. */
export async function handleEnrollmentChallengeRequest(input: {
  readonly request: Request;
  readonly environment: Env;
  readonly store: EnrollmentStore;
  readonly nowMilliseconds: number;
}): Promise<Response> {
  // El body se lee ANTES de autorizar, no después.
  //
  // Un handler que responde 401 sin consumir el cuerpo deja el stream abierto:
  // el runtime de Cloudflare y el middleware de wrangler intentan drenarlo después
  // de que la respuesta ya salió, y el request muere con un 500 en vez del 401.
  // Pasaba en el smoke una de cada N corridas, y sólo con el camino NO autorizado,
  // que es justo el que se prueba para confirmar que rechaza.
  let body: unknown;
  try {
    body = await input.request.clone().json();
  } catch {
    body = null;
  }
  if (!(await isOwnerAuthorized(input.request, input.environment))) {
    return new Response('Unauthorized', { status: 401 });
  }
  const parsed = enrollmentChallengeRequestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ status: 'rejected', reason: 'body_invalid' }, { status: 400 });
  }
  const deviceId = parsed.data.deviceId;
  if (!isEnrollableMobileDeviceId(deviceId)) {
    return Response.json(
      { status: 'rejected', reason: 'device_id_invalid' },
      { status: 400 },
    );
  }
  const issued = await issueEnrollmentChallenge({
    store: input.store,
    nowMilliseconds: input.nowMilliseconds,
    boundDeviceId: deviceId,
  });
  return Response.json({
    challenge: issued.challenge,
    deviceId,
    expiresAtMilliseconds: issued.expiresAtMilliseconds,
  });
}

/**
 * BLOCK 12.1 §2.3: el dueño declara el `deviceId` que autoriza y el vínculo queda
 * guardado con el desafío. Antes el desafío era un pase sin dueño, así que quien
 * lo obtuviera podía reclamar cualquier identidad.
 *
 * El body va con Zod estricto: un campo de más, o un deviceId que no sea mobile,
 * se rechazan antes de tocar el store y no después.
 */
export const enrollmentChallengeRequestSchema = z
  .object({
    deviceId: z.string().min(3).max(128),
  })
  .strict();

/**
 * §2 pasos 3 a 5: el teléfono canjea el desafío y recibe su credencial.
 *
 * Sin autenticación propia a propósito: el desafío ES la autorización. Por eso
 * tiene que ser impredecible, de un solo uso y corto — y por eso el claim corre
 * SIEMPRE contra el reloj del servidor.
 */
export async function handleEnrollmentClaimRequest(input: {
  readonly request: Request;
  readonly store: EnrollmentStore;
  readonly nowMilliseconds: number;
}): Promise<Response> {
  let body: unknown;
  try {
    body = await input.request.clone().json();
  } catch {
    return Response.json({ status: 'rejected', reason: 'body_invalid' }, { status: 400 });
  }
  const claim = readClaimInput(body);
  if (claim === null) {
    return Response.json({ status: 'rejected', reason: 'body_invalid' }, { status: 400 });
  }
  const result = await claimEnrollmentChallenge({
    store: input.store,
    nowMilliseconds: input.nowMilliseconds,
    challenge: claim.challenge,
    deviceId: claim.deviceId,
    isDeviceIdValid: isEnrollableMobileDeviceId,
  });
  if (result.status !== 'enrolled') {
    return Response.json({ status: 'rejected', reason: result.reason }, { status: 403 });
  }
  // La credencial viaja una sola vez, en el body de esta respuesta, y de ahí
  // sigue al Keystore del teléfono. Nunca se loguea ni vuelve al servidor.
  return Response.json({
    status: 'enrolled',
    deviceId: result.deviceId,
    credential: result.credential,
    rotated: result.rotated,
  });
}

/** §5: revocar. Sólo el dueño. La fila revocada es lo que cierra el bypass legacy. */
export async function handleEnrollmentRevokeRequest(input: {
  readonly request: Request;
  readonly environment: Env;
  readonly store: EnrollmentStore;
  readonly nowMilliseconds: number;
  readonly revoke: (deviceId: string) => Promise<'closed_socket' | 'no_socket'>;
}): Promise<Response> {
  // Mismo motivo que en el challenge: el cuerpo se consume antes de responder,
  // incluso en el 401.
  let body: unknown;
  try {
    body = await input.request.clone().json();
  } catch {
    body = null;
  }
  if (!(await isOwnerAuthorized(input.request, input.environment))) {
    return new Response('Unauthorized', { status: 401 });
  }
  const deviceId = readDeviceIdInput(body);
  if (deviceId === null || !isEnrollableMobileDeviceId(deviceId)) {
    return Response.json({ status: 'rejected', reason: 'body_invalid' }, { status: 400 });
  }
  const record = await input.store.readCredential(deviceId);
  if (record === null) {
    return Response.json({ status: 'unknown_device', deviceId }, { status: 404 });
  }
  // Se marca revoked conservando el hash, igual que `revokeDeviceCredential`: es
  // lo que permite reportar `credential_revoked` al teléfono en vez de un
  // `credential_unknown` que lo haría reconectar en loop.
  await input.store.saveCredential({
    deviceId,
    credentialHash: record.credentialHash,
    status: 'revoked',
    updatedAtMilliseconds: input.nowMilliseconds,
  });
  // El socket vivo se cierra acá, no por timeout del cliente: revocar tiene que
  // doler en el momento.
  const socketOutcome = await input.revoke(deviceId);
  return Response.json({ status: 'revoked', deviceId, socketOutcome });
}

function readClaimInput(body: unknown): { challenge: string; deviceId: string } | null {
  if (typeof body !== 'object' || body === null) {
    return null;
  }
  const record = body as Record<string, unknown>;
  const challenge = record['challenge'];
  const deviceId = record['deviceId'];
  if (typeof challenge !== 'string' || typeof deviceId !== 'string') {
    return null;
  }
  return { challenge, deviceId };
}

function readDeviceIdInput(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) {
    return null;
  }
  const deviceId = (body as Record<string, unknown>)['deviceId'];
  return typeof deviceId === 'string' ? deviceId : null;
}

/**
 * Las tres rutas de enrollment comparten un mismo contrato: 401 sin autorización
 * de dueño, 400 con body inválido, y un body `{status, reason}` con el motivo
 *estable. El smoke y los tests leen siempre esa forma.
 */
export type EnrollmentRouteKind = 'challenge' | 'claim' | 'revoke';

export function resolveEnrollmentRouteKind(pathname: string): EnrollmentRouteKind | null {
  if (pathname.endsWith(ENROLLMENT_CHALLENGE_SUFFIX)) {
    return 'challenge';
  }
  if (pathname.endsWith(ENROLLMENT_CLAIM_SUFFIX)) {
    return 'claim';
  }
  if (pathname.endsWith(ENROLLMENT_REVOKE_SUFFIX)) {
    return 'revoke';
  }
  return null;
}

// El binding lo hereda el starter. El index.ts usa este alias; la resolución de
// la instancia vive en devices/bridge-client.ts para que no haya dos formas de
// nombrar el bridge.
export const resolveMobileBridgeStub = resolveMobileBridgeClient;

/**
 * Un deviceId de enrollment tiene que ser mobile. Aceptar `desktop:algo` sería
 * abrir una fila de credenciales para algo que no es un teléfono, y `?token=`
 * seguiría siendo la única forma de autenticarse para ese id.
 */
export function isEnrollableMobileDeviceId(deviceId: string): boolean {
  return deviceIdSchema.safeParse(deviceId).success && deviceId.startsWith('mobile:');
}
