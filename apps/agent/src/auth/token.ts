function encodeUtf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/**
 * Compara dos textos sin filtrar por longitud ni por posición del primer byte
 * distinto.
 *
 * El `difference` acumula todos los XOR en vez de cortar en el primero: si
 * cortara, el tiempo que tarda depende de cuántos bytes correctos hubo, y eso ya
 * es un canal.
 */
export function areTextsEqualTimingSafe(leftText: string, rightText: string): boolean {
  return areByteArraysEqualTimingSafe(encodeUtf8(leftText), encodeUtf8(rightText));
}

function areByteArraysEqualTimingSafe(
  leftBytes: Uint8Array,
  rightBytes: Uint8Array,
): boolean {
  if (leftBytes.byteLength !== rightBytes.byteLength) {
    return false;
  }
  let difference = 0;
  for (let index = 0; index < leftBytes.byteLength; index += 1) {
    const leftByte = leftBytes[index] ?? 0;
    const rightByte = rightBytes[index] ?? 0;
    difference |= leftByte ^ rightByte;
  }
  return difference === 0;
}

/**
 * Un secreto esperado que no está cargado NO es un secreto vacío: es la
 * ausencia del secreto, y la respuesta es siempre no.
 *
 * Centralizado porque los tres caminos que comparan secretos tienen que
 * coincidir en esto. Donde un camino `===` y otro usa esta función, uno de los
 * dos está abierto: si el binding no se provisionó, la comparación directa
 * terminaría comparando contra `undefined`.
 */
function isPresentedSecretAccepted(
  presentedSecret: string | null,
  expectedSecret: string | undefined,
): boolean {
  if (expectedSecret === undefined || expectedSecret.length === 0) {
    return false;
  }
  if (presentedSecret === null) {
    return false;
  }
  return areTextsEqualTimingSafe(presentedSecret, expectedSecret);
}

export async function isDeviceSharedSecretValid(
  presentedSecret: string | null,
  // The generated Env type claims the Worker secret is always a string, but an
  // unset secret arrives as undefined at runtime: accept that honestly and
  // reject the connection instead of throwing a 500.
  expectedSecret: string | undefined,
): Promise<boolean> {
  return isPresentedSecretAccepted(presentedSecret, expectedSecret);
}

export function readDeviceTokenFromRequestUrl(requestUrl: URL): string | null {
  return requestUrl.searchParams.get('token');
}

// ─────────────────────────────────────────────────────────────────────────────
// BLOCK 12 §4: credenciales individuales en el header Authorization.
//
// Por qué el header y no la URL: un `?token=` aparece en access logs, en
// `Referer` cuando el cliente navega, en cualquier `console.log` de una URL y en
// los diagnostics del runtime. La credencial de un teléfono no puede ir ahí.
//
// El header tiene su propio namespace: un `Authorization` NUNCA se valida contra
// DEVICE_SHARED_SECRET ni contra DASHBOARD_SHARED_SECRET. Si se aceptara, una
// credencial individual podría actuar como secreto global, y al revés: el secreto
// global podría ocupar el lugar de una credencial individual. Son ámbitos
// separados y el código los separa por construcción: cada uno sólo se compara
// contra lo que le corresponde.
// ─────────────────────────────────────────────────────────────────────────────

const BEARER_PREFIX = 'bearer ';

const DEVICE_SECRET_HEADER = 'x-apollo-device-secret';

/**
 * El secreto global del cliente legacy traveling en un header.
 *
 * Header propio, y no `Authorization`, porque ese último tiene su propio
 * namespace: si se aceptara aqui, una credencial individual podria actuar como
 * secreto global y al reves.
 *
 * Existe porque un `?token=` queda en los access logs, en `Referer`, en
 * cualquier volcado de URL y en los diagnosticos del runtime.
 *
 * NO cambia la validacion: el valor se sigue comparando en el servidor, con la
 * misma comparacion timing-safe. Este helper solo decide de donde se lee.
 *
 * Va ANTES de `readBearerCredentialFromRequest` a proposito: el guard de
 * `apps/mobile/__tests__/contract.spec.ts` recorta el archivo desde
 * `readBearerCredentialFromRequest` hasta el final y afirma que ese camino no
 * toca ningun secreto global. Si esta funcion estuviera despues, el recorte la
 * incluiria y el guard leeria esto como si fuera el camino del bearer.
 */
export function readDeviceSecretFromRequest(request: Request): string | null {
  const headerValue = request.headers.get(DEVICE_SECRET_HEADER);
  const headerSecret = headerValue === null ? null : headerValue.trim();
  if (headerSecret !== null && headerSecret.length > 0) {
    return headerSecret;
  }
  // Transicion: un cliente viejo sigue mandando `?token=`. Mientras haya
  // clientes en produccion la URL se sigue aceptando; este es el unico punto a
  // tocar cuando se planee retirarla.
  return readDeviceTokenFromRequestUrl(new URL(request.url));
}

/**
 * El valor crudo del header Authorization, o null. No se valida acá: sólo se
 * separa del header. Quien valida es `verifyDeviceCredential`, contra el store
 * de enrollment.
 */
export function readBearerCredentialFromRequest(request: Request): string | null {
  const authorizationHeader = request.headers.get('Authorization');
  if (authorizationHeader === null) {
    return null;
  }
  const normalizedHeader = authorizationHeader.trim().toLowerCase();
  if (!normalizedHeader.startsWith(BEARER_PREFIX)) {
    return null;
  }
  const credential = authorizationHeader.trim().slice(BEARER_PREFIX.length);
  return credential.length === 0 ? null : credential;
}

/**
 * BLOCK 12.2 §3: el token interno de `/api/internal/*`.
 *
 * Antes comparaba con `===` contra `env.INTERNAL_CORE_TOKEN`. Eso ya fallaba
 * cerrado por casualidad —`null === undefined` es `false`— y por eso el hueco no
 * se veía. Lo que faltaba era el motivo: si algún día el valor esperado llegaba
 * vacío en vez de ausente, `''` y un header vacío habrían coincidido. Ahora usa el
 * mismo camino que los secretos de device y de dashboard.
 */
export function isInternalCoreTokenValid(
  presentedToken: string | null,
  expectedToken: string | undefined,
): boolean {
  return isPresentedSecretAccepted(presentedToken, expectedToken);
}
