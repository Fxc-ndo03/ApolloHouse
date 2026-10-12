// ─────────────────────────────────────────────────────────────────────────────
// BLOCK 12 §2, §3: el núcleo de enrollment, sin Cloudflare.
//
// Acá vive la decisión criptográfica y el estado de un desafío, sin Durable
// Object ni WebSocket: son funciones puras sobre un puerto de almacenamiento, así
// que se prueban enteras en la JVM/node sin workerd.
//
// Decisiones que importan y por qué:
//
// 1. Se guarda el HASH, nunca el secreto. Un dump del DO no sirve para conectar.
// 2. El desafío también se guarda hasheado, y se BORRA al consumirse. Es de un
//    solo uso por construcción, no por una bandera que alguien pueda forgetting.
// 3. SHA-256 con WebCrypto (`crypto.subtle`), que es la primitiva de la
//    plataforma. No hay criptografía propia acá: ni KDF homemade, ni compare
//    homemade, ni RNG homemade.
// 4. El secreto tiene prefijo. Sirve para dos cosas: que una credencial
//    individual nunca pueda confundirse con DEVICE_SHARED_SECRET, y para que los
//    logs puedan RECHAZAR el patrón en vez de tener que confiar en la disciplina.
// 5. La entropía viene de `crypto.getRandomValues` (CSPRNG del runtime), que es
//    lo que un attacker no puede predecir. 32 bytes = 256 bits.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Prefijo de las credenciales individuales. El de los desafíos es distinto para que
 * un valor de uno nunca pueda intentar autenticarse como el otro.
 */
export const DEVICE_CREDENTIAL_PREFIX = 'apollo_dev_';
export const ENROLLMENT_CHALLENGE_PREFIX = 'apollo_enr_';

/** 32 bytes de entropía del CSPRNG del runtime: 256 bits. */
const CREDENTIAL_ENTROPY_BYTE_COUNT = 32;
/** 24 bytes para el desafío: suficiente y mantiene el valor corto de tipear. */
const CHALLENGE_ENTROPY_BYTE_COUNT = 24;

/** §2: "expiración corta". Cinco minutos alcanzan para tocar el teléfono y no deja una ventana útil. */
export const ENROLLMENT_CHALLENGE_TTL_MILLISECONDS = 5 * 60 * 1000;

/**
 * Cuántos desafíos borrados por limpieza. Es un techo de trabajo por llamada, no un
 * presupuesto: si quedan más, se borran en las siguientes emisiones.
 */
const PRUNE_LIMIT = 50;

function encodeBase64Url(byteList: Uint8Array): string {
  let binary = '';
  for (const byte of byteList) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function readRandomBase64Url(byteCount: number): string {
  const randomByteList = new Uint8Array(byteCount);
  crypto.getRandomValues(randomByteList);
  return encodeBase64Url(randomByteList);
}

/**
 * SHA-256 en hex. WebCrypto es asíncrono y no tiene streaming, pero un secreto
 * de 43 caracteres entra de sobra: no hace falta HKDF ni nada derivado.
 */
export async function hashSecret(plainSecret: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(plainSecret),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export function isDeviceCredentialShaped(value: string | null): boolean {
  return (
    value !== null &&
    value.startsWith(DEVICE_CREDENTIAL_PREFIX) &&
    value.length > DEVICE_CREDENTIAL_PREFIX.length
  );
}

export function isEnrollmentChallengeShaped(value: string | null): boolean {
  return (
    value !== null &&
    value.startsWith(ENROLLMENT_CHALLENGE_PREFIX) &&
    value.length > ENROLLMENT_CHALLENGE_PREFIX.length
  );
}

export function mintDeviceCredential(): string {
  return `${DEVICE_CREDENTIAL_PREFIX}${readRandomBase64Url(CREDENTIAL_ENTROPY_BYTE_COUNT)}`;
}

export function mintEnrollmentChallenge(): string {
  return `${ENROLLMENT_CHALLENGE_PREFIX}${readRandomBase64Url(
    CHALLENGE_ENTROPY_BYTE_COUNT,
  )}`;
}

/**
 * El puerto de almacenamiento. El DO lo implementa sobre SQLite; los tests usan
 * un Map. Lo que importa es que acá no se sabe si sobrevive a un reinicio: eso
 * lo tiene que garantizar la implementación, no el contrato.
 */
export type EnrollmentStore = {
  saveChallenge(input: {
    readonly challengeHash: string;
    /** BLOCK 12.1 §2: el desafío queda atado a la identidad que el dueño autorizó. */
    readonly boundDeviceId: string;
    readonly issuedAtMilliseconds: number;
    readonly expiresAtMilliseconds: number;
  }): Promise<void>;
  readChallenge(challengeHash: string): Promise<EnrollmentChallengeRecord | null>;
  /**
   * BLOCK 12.1 §5: consumir el desafío y comprobar el vínculo, en UNA operación
   * atómica.
   *
   * Esto reemplaza el `readChallenge` + `deleteChallenge` de BLOCK 12, que tenía
   * una carrera real: dos claims concurrentes podían leer el desafío los dos,
   * y los dos pasar el chequeo de "existe y no expiró", antes de que uno lo
   * borrara. El que perdía la carrera se enteraba tarde, cuando ya podía haber
   * emitido su credencial. Con un CAS el perdedor no emite nada.
   *
   * Contrato: devuelve `wasConsumed: true` como máximo una vez por desafío. Un
   * `deviceId` distinto del atado NO consume el desafío (§2.7).
   */
  consumeChallenge(input: {
    readonly challengeHash: string;
    readonly deviceId: string;
    /** Valor único de esta llamada: permite distinguir "lo consumí yo" de "otro". */
    readonly consumedToken: string;
    readonly nowMilliseconds: number;
  }): Promise<ChallengeConsumeOutcome>;
  /** Limpieza de desafíos vencidos. NO es parte del camino del claim. */
  deleteChallenge(challengeHash: string): Promise<boolean>;
  /**
   * BLOCK 12.2 §2: borra los desafíos que NO pueden autorizar a nadie.
   *
   * Se borran sólo dos clases:
   *   - vencidos (`expires_at <= now`, contra el reloj del servidor);
   *   - filas heredadas sin vínculo (`device_id = ''`), que son de BLOCK 12 y
   *     que `consumeChallenge` ya rechaza como `challenge_unknown`.
   *
   * Lo que NO se borra nunca: un desafío vigente de un teléfono autorizado, y
   * CUALQUIER fila de `mobile_device_credential`, incluidas las revocadas. Las
   * revocadas son las que le cierran `?token=` a un teléfono dado: borrarlas
   * sería desrevocarlo sin querer.
   *
   * Por qué no puede debilitar el claim: las dos clases que borra son justamente
   * las que el claim ya rechaza, así que una carrera limpieza/claim no puede
   * convertir un rechazo en un acierto. El `limit` acota el trabajo por llamada
   * para no bloquear el DO con un DELETE masivo.
   */
  pruneChallenge(input: {
    readonly nowMilliseconds: number;
    readonly limit: number;
  }): Promise<number>;
  saveCredential(input: {
    readonly deviceId: string;
    readonly credentialHash: string;
    readonly status: 'active' | 'revoked';
    readonly updatedAtMilliseconds: number;
  }): Promise<void>;
  readCredential(deviceId: string): Promise<DeviceCredentialRecord | null>;
  deleteCredential(deviceId: string): Promise<boolean>;
  listCredentialRecordList(): Promise<DeviceCredentialRecord[]>;
};

export type EnrollmentChallengeRecord = {
  readonly challengeHash: string;
  readonly boundDeviceId: string;
  readonly issuedAtMilliseconds: number;
  readonly expiresAtMilliseconds: number;
  readonly consumedAtMilliseconds: number | null;
  /** El token con el que lo consumió quien ganó el CAS, si alguien lo consumió. */
  readonly consumedToken: string | null;
};

export type ChallengeConsumeOutcome =
  | { readonly wasConsumed: true; readonly boundDeviceId: string }
  | {
      readonly wasConsumed: false;
      readonly reason:
        | 'challenge_unknown'
        | 'challenge_consumed'
        | 'challenge_expired'
        | 'device_id_mismatch';
    };

export type DeviceCredentialRecord = {
  readonly deviceId: string;
  readonly credentialHash: string;
  readonly status: 'active' | 'revoked';
  readonly updatedAtMilliseconds: number;
};

export type EnrollmentIssueResult = {
  readonly status: 'issued';
  readonly challenge: string;
  readonly expiresAtMilliseconds: number;
};

/**
 * BLOCK 12.1 §2.3: el dueño dice QUÉ teléfono está autorizando, y ese vínculo
 * queda guardado con el desafío. Antes el desafío era un pase sin dueño, así que
 * quien lo obtuviera podía reclamar cualquier identidad.
 */
export async function issueEnrollmentChallenge(input: {
  readonly store: EnrollmentStore;
  readonly nowMilliseconds: number;
  readonly boundDeviceId: string;
  readonly ttlMilliseconds?: number;
}): Promise<EnrollmentIssueResult> {
  const challenge = mintEnrollmentChallenge();
  const ttlMilliseconds = input.ttlMilliseconds ?? ENROLLMENT_CHALLENGE_TTL_MILLISECONDS;
  const expiresAtMilliseconds = input.nowMilliseconds + ttlMilliseconds;
  await input.store.saveChallenge({
    challengeHash: await hashSecret(challenge),
    boundDeviceId: input.boundDeviceId,
    issuedAtMilliseconds: input.nowMilliseconds,
    expiresAtMilliseconds,
  });
  // BLOCK 12.2 §2: se limpia acá y no en el claim a propósito. Esta ruta pide el
  // rol del dueño, así que el trabajo extra no lo puede disparar un anónimo que
  // esté haciendo flood al claim; y emitir es raro, así que la tabla queda
  // acotada sin necesidad de un alarm.
  await input.store.pruneChallenge({
    nowMilliseconds: input.nowMilliseconds,
    limit: PRUNE_LIMIT,
  });
  return { status: 'issued', challenge, expiresAtMilliseconds };
}

export type EnrollmentClaimRejectionReason =
  | 'challenge_malformed'
  | 'challenge_unknown'
  | 'challenge_consumed'
  | 'challenge_expired'
  | 'device_id_invalid'
  /** BLOCK 12.1 §2.5: el desafío es de otro teléfono. */
  | 'device_id_mismatch';

export type EnrollmentClaimResult =
  | {
      readonly status: 'enrolled';
      readonly deviceId: string;
      readonly credential: string;
      readonly rotated: boolean;
    }
  | { readonly status: 'rejected'; readonly reason: EnrollmentClaimRejectionReason };

/**
 * §2 pasos 3 a 5: el teléfono presenta el desafío, el servidor lo valida, lo
 * CONSUME y recién entonces registra el dispositivo y le devuelve su credencial.
 *
 * BLOCK 12.1 cambió el orden de las comprobaciones por dos razones:
 *
 * 1. **El vínculo va dentro del consumo.** `consumeChallenge` recibe el deviceId
 *    y sólo marca el desafío consumido si coincide con el atado. Así el intento de
 *    B con el desafío de A no consume nada y no crea credenciales (§2.7).
 * 2. **El consumo es un CAS.** `readChallenge` + `deleteChallenge` tenían una
 *    carrera: dos claims concurrentes leían el mismo desafío válido y los dos
 *    pasaban los chequeos antes de que uno lo borrara (§5).
 *
 * Si la escritura de la credencial fallara después del consumo, el desafío queda
 * quemado: se pierde un enrollment, no se duplica una identidad. Es el lado
 * correcto de fallar para seguridad.
 */
export async function claimEnrollmentChallenge(input: {
  readonly store: EnrollmentStore;
  readonly nowMilliseconds: number;
  readonly challenge: string;
  readonly deviceId: string;
  readonly isDeviceIdValid: (deviceId: string) => boolean;
}): Promise<EnrollmentClaimResult> {
  if (!isEnrollmentChallengeShaped(input.challenge)) {
    return { status: 'rejected', reason: 'challenge_malformed' };
  }
  if (!input.isDeviceIdValid(input.deviceId)) {
    return { status: 'rejected', reason: 'device_id_invalid' };
  }
  const challengeHash = await hashSecret(input.challenge);
  // Una sola operación decide si este claim gana. Todo lo demás es clasificar un
  // "no" para poder darle un motivo útil al teléfono.
  const consumeOutcome = await input.store.consumeChallenge({
    challengeHash,
    deviceId: input.deviceId,
    consumedToken: crypto.randomUUID(),
    nowMilliseconds: input.nowMilliseconds,
  });
  if (!consumeOutcome.wasConsumed) {
    return { status: 'rejected', reason: consumeOutcome.reason };
  }
  // A partir de acá el desafío es de este teléfono y de nadie más.
  if (consumeOutcome.boundDeviceId !== input.deviceId) {
    return { status: 'rejected', reason: 'device_id_mismatch' };
  }
  const existingRecord = await input.store.readCredential(input.deviceId);
  const credential = mintDeviceCredential();
  await input.store.saveCredential({
    deviceId: input.deviceId,
    credentialHash: await hashSecret(credential),
    status: 'active',
    updatedAtMilliseconds: input.nowMilliseconds,
  });
  return {
    status: 'enrolled',
    deviceId: input.deviceId,
    credential,
    // Reinscribir una credencial existente la rota: sirve para un teléfono
    // reinstalado, y el desafío lo autorizó el dueño.
    rotated: existingRecord !== null,
  };
}

export type CredentialVerification =
  | { readonly status: 'valid'; readonly deviceId: string }
  | {
      readonly status: 'rejected';
      readonly reason:
        | 'credential_malformed'
        | 'credential_unknown'
        | 'credential_revoked';
    };

/**
 * §3: verificar la credencial contra el hash guardado, con comparación
 * timing-safe. El hash es de largo fijo, así que comparar el hex completo es
 * suficiente.
 */
export async function verifyDeviceCredential(input: {
  readonly store: EnrollmentStore;
  readonly credential: string | null;
}): Promise<CredentialVerification> {
  if (!isDeviceCredentialShaped(input.credential)) {
    return { status: 'rejected', reason: 'credential_malformed' };
  }
  const presentedHash = await hashSecret(input.credential as string);
  for (const record of await input.store.listCredentialRecordList()) {
    if (!areHashesEqualTimingSafe(presentedHash, record.credentialHash)) {
      continue;
    }
    if (record.status === 'revoked') {
      // Se lo dice al cliente a propósito: un teléfono que fue revocado debe
      // dejar de reintentar, no quedarse reconectando en loop.
      return { status: 'rejected', reason: 'credential_revoked' };
    }
    return { status: 'valid', deviceId: record.deviceId };
  }
  return { status: 'rejected', reason: 'credential_unknown' };
}

function areHashesEqualTimingSafe(leftHash: string, rightHash: string): boolean {
  if (leftHash.length !== rightHash.length) {
    return false;
  }
  let difference = 0;
  for (let index = 0; index < leftHash.length; index += 1) {
    difference |= leftHash.charCodeAt(index) ^ rightHash.charCodeAt(index);
  }
  return difference === 0;
}

export type RevocationResult =
  | {
      readonly status: 'revoked';
      readonly deviceId: string;
      readonly hadCredential: boolean;
    }
  | { readonly status: 'unknown_device'; readonly deviceId: string };

/**
 * §5: revocar marca la fila como `revoked` conservando su hash, para que el
 * cliente reciba un motivo accionable. El acceso queda cortado igual: una fila
 * revocada nunca autentica, y su presencia es lo que le cierra `?token=`.
 */
export async function revokeDeviceCredential(input: {
  readonly store: EnrollmentStore;
  readonly deviceId: string;
  readonly nowMilliseconds: number;
}): Promise<RevocationResult> {
  const existingRecord = await input.store.readCredential(input.deviceId);
  if (existingRecord === null) {
    return { status: 'unknown_device', deviceId: input.deviceId };
  }
  // La fila NO se borra: se marca revoked conservando su hash.
  //
  // Borrarla parecería más limpio, pero rompe una cosa que el cliente necesita:
  // si el hash desaparece, `verifyDeviceCredential` no puede distinguir "revocada"
  // de "nunca existió" y devuelve `credential_unknown`. El teléfono entonces
  // reconecta en loop para siempre contra una credencial que ya no va a funcionar
  // nunca. Con el hash conservado el rechazo es `credential_revoked`, que es lo
  // que le permite al cliente parar de reintentar (§6).
  //
  // Guardar el hash no da acceso: un hash no es una credencial, y esta fila
  // rejects. Lo que además cierra el bypass es que la fila SIGUE EXISTIENDO, que
  // es lo que `decideLegacyAdmission` lee para negarle `?token=`.
  await input.store.saveCredential({
    deviceId: input.deviceId,
    credentialHash: existingRecord.credentialHash,
    status: 'revoked',
    updatedAtMilliseconds: input.nowMilliseconds,
  });
  return { status: 'revoked', deviceId: input.deviceId, hadCredential: true };
}

export type LegacyAdmissionDecision =
  | { readonly isAllowed: true }
  | { readonly isAllowed: false; readonly reason: 'device_is_enrolled_or_revoked' };

/**
 * §1: el mecanismo legacy no puede ser un bypass de la individual.
 *
 * Un teléfono revocado que vuelve a presentar DEVICE_SHARED_SECRET por
 * `?token=` sería un "legacy desconocido" y entraría. Por eso el camino legacy
 * se consulta contra el store: si el deviceId aparece ahí —activo O revocado—
 * se rechaza. La decisión sale de la identidad persistida, nunca de lo que diga
 * la petición.
 */
export async function decideLegacyAdmission(input: {
  readonly store: EnrollmentStore;
  readonly deviceId: string;
}): Promise<LegacyAdmissionDecision> {
  const record = await input.store.readCredential(input.deviceId);
  if (record === null) {
    return { isAllowed: true };
  }
  return { isAllowed: false, reason: 'device_is_enrolled_or_revoked' };
}
