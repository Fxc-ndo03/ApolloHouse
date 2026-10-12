import { beforeEach, describe, expect, it } from 'bun:test';

import {
  ENROLLMENT_CHALLENGE_TTL_MILLISECONDS,
  claimEnrollmentChallenge,
  type ChallengeConsumeOutcome,
  decideLegacyAdmission,
  hashSecret,
  issueEnrollmentChallenge,
  isDeviceCredentialShaped,
  isEnrollmentChallengeShaped,
  mintDeviceCredential,
  revokeDeviceCredential,
  verifyDeviceCredential,
  type EnrollmentStore,
} from '@/devices/enrollment';
import { createInMemoryEnrollmentStore } from '@/devices/credential-store';
import { isEnrollableMobileDeviceId } from '@/devices/route';

// ─────────────────────────────────────────────────────────────────────────────
// BLOCK 12 §7: los casos de seguridad de enrollment y revocación.
//
// Estos tests cubren el NÚCLEO (functions puras sobre el puerto de store). El
// transporte real, el DO y los sockets se prueban en `revocation.spec.ts` (con
// endpoint y sockets falsos) y en el smoke con workerd de verdad.
//
// Reloj inyectado a mano en todos lados: la expiración es una regla de
// seguridad, no puede depender de un `Date.now()` real o el test sería flaky.
// ─────────────────────────────────────────────────────────────────────────────

const PHONE_A = 'mobile:phone-a';
const PHONE_B = 'mobile:phone-b';
const NOW = 1_700_000_000_000;

const ALWAYS_VALID_DEVICE_ID = (deviceId: string): boolean =>
  isEnrollableMobileDeviceId(deviceId);

describe('B12 §7.1: enrollment válido', () => {
  it('un dueño pide un desafío y el teléfono lo canjea por una credencial', async () => {
    const store = createInMemoryEnrollmentStore();
    const issued = await issueEnrollmentChallenge({
      store,
      nowMilliseconds: NOW,
      boundDeviceId: PHONE_A,
    });

    expect(issued.status).toBe('issued');
    expect(isEnrollmentChallengeShaped(issued.challenge)).toBe(true);

    const claim = await claimEnrollmentChallenge({
      store,
      nowMilliseconds: NOW + 1_000,
      challenge: issued.challenge,
      deviceId: PHONE_A,
      isDeviceIdValid: ALWAYS_VALID_DEVICE_ID,
    });

    expect(claim.status).toBe('enrolled');
    if (claim.status !== 'enrolled') {
      throw new Error('el claim deberia haber enrolled');
    }
    expect(claim.deviceId).toBe(PHONE_A);
    expect(claim.rotated).toBe(false);
    expect(isDeviceCredentialShaped(claim.credential)).toBe(true);

    // Y la credencial sirve para autenticarse como A, y sólo como A.
    const verification = await verifyDeviceCredential({
      store,
      credential: claim.credential,
    });
    expect(verification).toEqual({ status: 'valid', deviceId: PHONE_A });
  });

  it('el store guarda el HASH, nunca el secreto', async () => {
    const store = createInMemoryEnrollmentStore();
    const issued = await issueEnrollmentChallenge({
      store,
      nowMilliseconds: NOW,
      boundDeviceId: PHONE_A,
    });
    const claim = await claimEnrollmentChallenge({
      store,
      nowMilliseconds: NOW,
      challenge: issued.challenge,
      deviceId: PHONE_A,
      isDeviceIdValid: ALWAYS_VALID_DEVICE_ID,
    });
    if (claim.status !== 'enrolled') {
      throw new Error('el claim deberia haber enrolled');
    }

    const record = await store.readCredential(PHONE_A);
    expect(record?.credentialHash).toBe(await hashSecret(claim.credential));
    // Un dump del store no contiene nada utilizable.
    const dump = JSON.stringify(await store.listCredentialRecordList());
    expect(dump).not.toContain(claim.credential);
    expect(dump).not.toContain(issued.challenge);
  });

  it('dos desafíos distintos nunca se parecen', async () => {
    const store = createInMemoryEnrollmentStore();
    const first = await issueEnrollmentChallenge({
      store,
      nowMilliseconds: NOW,
      boundDeviceId: PHONE_A,
    });
    const second = await issueEnrollmentChallenge({
      store,
      nowMilliseconds: NOW,
      boundDeviceId: PHONE_A,
    });
    expect(first.challenge).not.toBe(second.challenge);
  });

  it('las credenciales tienen entropía y prefijo propio', async () => {
    const credentialList = Array.from({ length: 8 }, () => mintDeviceCredential());
    expect(new Set(credentialList).size).toBe(credentialList.length);
    for (const credential of credentialList) {
      expect(credential.startsWith('apollo_dev_')).toBe(true);
      // 32 bytes en base64url = 43 caracteres.
      expect(credential.length).toBe('apollo_dev_'.length + 43);
    }
  });
});

describe('B12 §7.2-7.4: desafíos expirado, reutilizado e incorrecto', () => {
  it('un desafío expirado no registra nada', async () => {
    const store = createInMemoryEnrollmentStore();
    const issued = await issueEnrollmentChallenge({
      store,
      nowMilliseconds: NOW,
      boundDeviceId: PHONE_A,
    });

    const claim = await claimEnrollmentChallenge({
      store,
      // Un milisegundo pasado el deadline.
      nowMilliseconds: issued.expiresAtMilliseconds,
      challenge: issued.challenge,
      deviceId: PHONE_A,
      isDeviceIdValid: ALWAYS_VALID_DEVICE_ID,
    });

    expect(claim).toEqual({ status: 'rejected', reason: 'challenge_expired' });
    expect(await store.readCredential(PHONE_A)).toBeNull();
  });

  it('un desafío se puede canjear UNA vez', async () => {
    const store = createInMemoryEnrollmentStore();
    const issued = await issueEnrollmentChallenge({
      store,
      nowMilliseconds: NOW,
      boundDeviceId: PHONE_A,
    });

    const first = await claimEnrollmentChallenge({
      store,
      nowMilliseconds: NOW + 1_000,
      challenge: issued.challenge,
      deviceId: PHONE_A,
      isDeviceIdValid: ALWAYS_VALID_DEVICE_ID,
    });
    expect(first.status).toBe('enrolled');

    const second = await claimEnrollmentChallenge({
      store,
      nowMilliseconds: NOW + 2_000,
      challenge: issued.challenge,
      deviceId: PHONE_B,
      isDeviceIdValid: ALWAYS_VALID_DEVICE_ID,
    });
    // BLOCK 12.1: la fila sigue existiendo marcada consumida, así que el motivo
    // es preciso en vez del genérico `challenge_unknown` de BLOCK 12.
    expect(second).toEqual({ status: 'rejected', reason: 'challenge_consumed' });
    // Y el segundo intento no registró a B.
    expect(await store.readCredential(PHONE_B)).toBeNull();
  });

  it('un desafío incorrecto no registra nada', async () => {
    const store = createInMemoryEnrollmentStore();
    await issueEnrollmentChallenge({
      store,
      nowMilliseconds: NOW,
      boundDeviceId: PHONE_A,
    });

    for (const wrongChallenge of [
      'apollo_enr_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      'not-a-challenge',
      '',
      'apollo_dev_credential-shaped-but-wrong-scope',
    ]) {
      const claim = await claimEnrollmentChallenge({
        store,
        nowMilliseconds: NOW + 1_000,
        challenge: wrongChallenge,
        deviceId: PHONE_A,
        isDeviceIdValid: ALWAYS_VALID_DEVICE_ID,
      });
      expect(claim.status).toBe('rejected');
      expect(await store.readCredential(PHONE_A)).toBeNull();
    }
  });

  it('el TTL por defecto es corto y el desafío no expira nunca', async () => {
    const store = createInMemoryEnrollmentStore();
    const issued = await issueEnrollmentChallenge({
      store,
      nowMilliseconds: NOW,
      boundDeviceId: PHONE_A,
    });
    expect(issued.expiresAtMilliseconds - NOW).toBe(
      ENROLLMENT_CHALLENGE_TTL_MILLISECONDS,
    );

    // Justo antes del deadline todavía vale: la expiración es por reloj, no por
    // "la segunda vez que se usa".
    const justInTime = await claimEnrollmentChallenge({
      store,
      nowMilliseconds: issued.expiresAtMilliseconds - 1,
      challenge: issued.challenge,
      deviceId: PHONE_A,
      isDeviceIdValid: ALWAYS_VALID_DEVICE_ID,
    });
    expect(justInTime.status).toBe('enrolled');
  });

  it('un deviceId que no es mobile no se puede enrolar', async () => {
    const store = createInMemoryEnrollmentStore();
    const issued = await issueEnrollmentChallenge({
      store,
      nowMilliseconds: NOW,
      boundDeviceId: PHONE_A,
    });

    for (const deviceId of ['desktop:desk', 'phone-a', '', 'mobile:']) {
      const claim = await claimEnrollmentChallenge({
        store,
        nowMilliseconds: NOW + 1_000,
        challenge: issued.challenge,
        deviceId,
        isDeviceIdValid: ALWAYS_VALID_DEVICE_ID,
      });
      expect(claim.status).toBe('rejected');
      expect(await store.readCredential(deviceId)).toBeNull();
    }
  });
});

describe('B12 §7.5-7.8: credenciales ausentes, válidas, inválidas y ajenas', () => {
  let store: EnrollmentStore;
  let credentialOfA: string;
  let credentialOfB: string;

  beforeEach(async () => {
    store = createInMemoryEnrollmentStore();
    credentialOfA = await enrollPhone(store, PHONE_A, 0);
    credentialOfB = await enrollPhone(store, PHONE_B, 1_000);
  });

  it('un cliente sin credencial no verifica', async () => {
    for (const missing of [null, '', '   ']) {
      const verification = await verifyDeviceCredential({ store, credential: missing });
      expect(verification.status).toBe('rejected');
    }
  });

  it('una credencial válida verifica contra su propio deviceId', async () => {
    expect(await verifyDeviceCredential({ store, credential: credentialOfA })).toEqual({
      status: 'valid',
      deviceId: PHONE_A,
    });
    expect(await verifyDeviceCredential({ store, credential: credentialOfB })).toEqual({
      status: 'valid',
      deviceId: PHONE_B,
    });
  });

  it('una credencial inválida no verifica', async () => {
    for (const invalid of [
      'apollo_dev_not-a-real-credential',
      mintDeviceCredential(),
      credentialOfA.slice(0, -1) + 'X',
    ]) {
      const verification = await verifyDeviceCredential({ store, credential: invalid });
      expect(verification.status).toBe('rejected');
      if (verification.status === 'rejected') {
        expect(verification.reason).toBe('credential_unknown');
      }
    }
  });

  it('la credencial de A no autentica a B', async () => {
    // La credencial resuelve SIEMPRE al deviceId atada en el server. No hay
    // forma de presentar la de A y terminar con la sesión de B.
    const verification = await verifyDeviceCredential({
      store,
      credential: credentialOfA,
    });
    expect(verification).toEqual({ status: 'valid', deviceId: PHONE_A });
    expect(verification).not.toEqual({ status: 'valid', deviceId: PHONE_B });
  });

  it('el secreto global NO es una credencial válida', async () => {
    // §3: el mecanismo legacy no puede ocupar el lugar de una credencial
    // individual, porque cada ámbito se verifica contra lo suyo.
    const verification = await verifyDeviceCredential({
      store,
      credential: 'block-8-2-smoke-device-secret',
    });
    expect(verification).toEqual({
      status: 'rejected',
      reason: 'credential_malformed',
    });
  });
});

describe('B12 §7.9-7.12: revocación, socket activo, reconexión y aislamiento', () => {
  it('una credencial revocada se rechaza y no vuelve por legacy', async () => {
    const store = createInMemoryEnrollmentStore();
    const credential = await enrollPhone(store, PHONE_A, 0);

    const revocation = await revokeDeviceCredential({
      store,
      deviceId: PHONE_A,
      nowMilliseconds: NOW + 5_000,
    });
    expect(revocation).toEqual({
      status: 'revoked',
      deviceId: PHONE_A,
      hadCredential: true,
    });

    const verification = await verifyDeviceCredential({ store, credential });
    expect(verification).toEqual({ status: 'rejected', reason: 'credential_revoked' });

    // Y el bypass: con la fila revocada presente, `?token=` legacy tampoco entra.
    const legacyDecision = await decideLegacyAdmission({ store, deviceId: PHONE_A });
    expect(legacyDecision).toEqual({
      isAllowed: false,
      reason: 'device_is_enrolled_or_revoked',
    });
  });

  it('reconectar tras la revocación no devuelve el acceso', async () => {
    const store = createInMemoryEnrollmentStore();
    const credential = await enrollPhone(store, PHONE_A, 0);
    await revokeDeviceCredential({ store, deviceId: PHONE_A, nowMilliseconds: NOW });

    // Tres intentos, como un cliente que insiste.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const verification = await verifyDeviceCredential({ store, credential });
      expect(verification.status).toBe('rejected');
      const legacyDecision = await decideLegacyAdmission({ store, deviceId: PHONE_A });
      expect(legacyDecision.isAllowed).toBe(false);
    }
  });

  it('los otros dispositivos siguen funcionando tras revocar A', async () => {
    const store = createInMemoryEnrollmentStore();
    const credentialOfA = await enrollPhone(store, PHONE_A, 0);
    const credentialOfB = await enrollPhone(store, PHONE_B, 1_000);

    await revokeDeviceCredential({ store, deviceId: PHONE_A, nowMilliseconds: NOW });

    expect(
      (await verifyDeviceCredential({ store, credential: credentialOfA })).status,
    ).toBe('rejected');
    expect(await verifyDeviceCredential({ store, credential: credentialOfB })).toEqual({
      status: 'valid',
      deviceId: PHONE_B,
    });
    expect((await decideLegacyAdmission({ store, deviceId: PHONE_B })).isAllowed).toBe(
      false,
    );
  });

  it('revocar un deviceId desconocido no inventa nada', async () => {
    const store = createInMemoryEnrollmentStore();
    expect(
      await revokeDeviceCredential({
        store,
        deviceId: 'mobile:nunca-visto',
        nowMilliseconds: NOW,
      }),
    ).toEqual({ status: 'unknown_device', deviceId: 'mobile:nunca-visto' });
  });

  it('la fila revocada existe y con el MISMO hash: reportar el motivo sin dar acceso', async () => {
    const store = createInMemoryEnrollmentStore();
    const credential = await enrollPhone(store, PHONE_A, 0);
    const activeHash = (await store.readCredential(PHONE_A))?.credentialHash;

    await revokeDeviceCredential({ store, deviceId: PHONE_A, nowMilliseconds: NOW });
    const revokedRecord = await store.readCredential(PHONE_A);

    // Conservar el hash es lo que permite decir "revocada" y no "desconocida".
    expect(revokedRecord?.status).toBe('revoked');
    expect(revokedRecord?.credentialHash).toBe(activeHash);
    // Y aun así no da acceso: es un hash, y la fila revocada rechaza.
    expect((await verifyDeviceCredential({ store, credential })).status).toBe('rejected');
  });

  it('una credencial con el prefijo pero sin valor no tiene la forma de una credencial', async () => {
    // No alcanza con el prefijo: sin entropía detrás no puede ser una
    // credencial emitida, así que ni se busca en el store.
    const store = createInMemoryEnrollmentStore();
    expect(await verifyDeviceCredential({ store, credential: 'apollo_dev_' })).toEqual({
      status: 'rejected',
      reason: 'credential_malformed',
    });
  });
});

describe('B12 §7.13-7.14: persistencia y regeneración de identidad', () => {
  it('las credenciales registradas sobreviven a que se pierda el proceso', async () => {
    // Dos instancias del store sobre el mismo "almacenamiento": la segunda es
    // un DO que se reinició.
    const backingStore = new Map<string, unknown>();
    const persistedStore = createPersistentBackingStore(backingStore);
    const credential = await enrollPhone(persistedStore, PHONE_A, 0);

    const afterRestart = createPersistentBackingStore(backingStore);
    expect(await verifyDeviceCredential({ store: afterRestart, credential })).toEqual({
      status: 'valid',
      deviceId: PHONE_A,
    });

    // Y la revocación también sobrevive, que es el motivo de que el store sea
    // SQLite y no memoria.
    await revokeDeviceCredential({
      store: afterRestart,
      deviceId: PHONE_A,
      nowMilliseconds: NOW,
    });
    const afterRevocationAndRestart = createPersistentBackingStore(backingStore);
    expect(
      (
        await decideLegacyAdmission({
          store: afterRevocationAndRestart,
          deviceId: PHONE_A,
        })
      ).isAllowed,
    ).toBe(false);
  });

  it('un deviceId que no estaba enrolado sí puede entrar por legacy', async () => {
    // La transición: Desktop y teléfonos legacy que nunca se enrolaron siguen
    // conectando con el secreto global, que es lo que §1 pide mantener.
    const store = createInMemoryEnrollmentStore();
    expect(await decideLegacyAdmission({ store, deviceId: PHONE_A })).toEqual({
      isAllowed: true,
    });
  });

  it('re-enrolar el mismo teléfono rota la credencial anterior', async () => {
    const store = createInMemoryEnrollmentStore();
    const firstCredential = await enrollPhone(store, PHONE_A, 0);

    const issued = await issueEnrollmentChallenge({
      store,
      nowMilliseconds: NOW,
      boundDeviceId: PHONE_A,
    });
    const claim = await claimEnrollmentChallenge({
      store,
      nowMilliseconds: NOW + 1,
      challenge: issued.challenge,
      deviceId: PHONE_A,
      isDeviceIdValid: ALWAYS_VALID_DEVICE_ID,
    });
    if (claim.status !== 'enrolled') {
      throw new Error('el re-enrollment deberia haber funcionado');
    }
    expect(claim.rotated).toBe(true);

    expect(
      (await verifyDeviceCredential({ store, credential: firstCredential })).status,
    ).toBe('rejected');
    expect(await verifyDeviceCredential({ store, credential: claim.credential })).toEqual(
      {
        status: 'valid',
        deviceId: PHONE_A,
      },
    );
  });
});

describe('B12 §7.15: nada de esto aparece en un mensaje de error', () => {
  it('un rechazo nunca incluye el secreto presentado ni el desafío', async () => {
    const store = createInMemoryEnrollmentStore();
    const credential = mintDeviceCredential();
    const challenge = 'apollo_enr_secreto-del-duenno';

    const rejectedList = [
      await verifyDeviceCredential({ store, credential }),
      await claimEnrollmentChallenge({
        store,
        nowMilliseconds: NOW,
        challenge,
        deviceId: PHONE_A,
        isDeviceIdValid: ALWAYS_VALID_DEVICE_ID,
      }),
    ];
    for (const rejected of rejectedList) {
      expect(JSON.stringify(rejected)).not.toContain(credential);
      expect(JSON.stringify(rejected)).not.toContain(challenge);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

async function enrollPhone(
  store: EnrollmentStore,
  deviceId: string,
  offsetMilliseconds: number,
): Promise<string> {
  const issued = await issueEnrollmentChallenge({
    store,
    nowMilliseconds: NOW + offsetMilliseconds,
    boundDeviceId: deviceId,
  });
  const claim = await claimEnrollmentChallenge({
    store,
    nowMilliseconds: NOW + offsetMilliseconds + 1,
    challenge: issued.challenge,
    deviceId,
    isDeviceIdValid: ALWAYS_VALID_DEVICE_ID,
  });
  if (claim.status !== 'enrolled') {
    throw new Error(`no se pudo enrolar ${deviceId}: ${claim.reason}`);
  }
  return claim.credential;
}

/**
 * Un store que escribe en un Map externo, para simular que el segundo
 * "proceso" ve lo que escribió el primero. Es el modelo de lo que hace SQLite
 * detrás del store real, sin workerd.
 */
type PersistedChallenge = {
  readonly challengeHash: string;
  readonly boundDeviceId: string;
  readonly issuedAtMilliseconds: number;
  readonly expiresAtMilliseconds: number;
  readonly consumedAtMilliseconds: number | null;
  readonly consumedToken: string | null;
};

type PersistedCredential = {
  readonly deviceId: string;
  readonly credentialHash: string;
  readonly status: 'active' | 'revoked';
  readonly updatedAtMilliseconds: number;
};

type BackingStore = {
  challengeMap: Map<string, PersistedChallenge>;
  credentialMap: Map<string, PersistedCredential>;
};

function createPersistentBackingStore(backing: Map<string, unknown>): EnrollmentStore {
  const readBacking = (): BackingStore => {
    const existing = backing.get('backing');
    if (existing !== undefined) {
      return existing as BackingStore;
    }
    const created: BackingStore = {
      challengeMap: new Map(),
      credentialMap: new Map(),
    };
    backing.set('backing', created);
    return created;
  };
  return {
    async saveChallenge(input): Promise<void> {
      readBacking().challengeMap.set(input.challengeHash, {
        ...input,
        consumedAtMilliseconds: null,
        consumedToken: null,
      });
    },
    async readChallenge(challengeHash: string): Promise<PersistedChallenge | null> {
      return readBacking().challengeMap.get(challengeHash) ?? null;
    },
    async consumeChallenge(
      input: Parameters<EnrollmentStore['consumeChallenge']>[0],
    ): Promise<ChallengeConsumeOutcome> {
      const record = readBacking().challengeMap.get(input.challengeHash);
      if (record === undefined) {
        return { wasConsumed: false, reason: 'challenge_unknown' };
      }
      if (record.consumedAtMilliseconds !== null) {
        return { wasConsumed: false, reason: 'challenge_consumed' };
      }
      if (input.nowMilliseconds >= record.expiresAtMilliseconds) {
        return { wasConsumed: false, reason: 'challenge_expired' };
      }
      if (record.boundDeviceId !== input.deviceId) {
        return { wasConsumed: false, reason: 'device_id_mismatch' };
      }
      readBacking().challengeMap.set(input.challengeHash, {
        ...record,
        consumedAtMilliseconds: input.nowMilliseconds,
        consumedToken: input.consumedToken,
      });
      return { wasConsumed: true, boundDeviceId: record.boundDeviceId };
    },
    async pruneChallenge(input): Promise<number> {
      const doomedHashList: string[] = [];
      for (const [challengeHash, record] of readBacking().challengeMap) {
        if (
          record.expiresAtMilliseconds <= input.nowMilliseconds ||
          record.boundDeviceId.length === 0
        ) {
          doomedHashList.push(challengeHash);
        }
        if (doomedHashList.length >= input.limit) {
          break;
        }
      }
      for (const challengeHash of doomedHashList) {
        readBacking().challengeMap.delete(challengeHash);
      }
      return doomedHashList.length;
    },
    async deleteChallenge(challengeHash: string): Promise<boolean> {
      return readBacking().challengeMap.delete(challengeHash);
    },
    async saveCredential(input): Promise<void> {
      readBacking().credentialMap.set(input.deviceId, { ...input });
    },
    async readCredential(deviceId: string): Promise<PersistedCredential | null> {
      return readBacking().credentialMap.get(deviceId) ?? null;
    },
    async deleteCredential(deviceId: string): Promise<boolean> {
      return readBacking().credentialMap.delete(deviceId);
    },
    async listCredentialRecordList(): Promise<PersistedCredential[]> {
      return [...readBacking().credentialMap.values()];
    },
  };
}

describe('B12.2 §2: la limpieza se lleva lo que ya no autoriza a nadie', () => {
  it('una fila heredada sin vinculo no sobrevive a la siguiente emision', async () => {
    const store = createInMemoryEnrollmentStore();
    // Filas heredadas de BLOCK 12: existen, pero `device_id` vacio no puede
    // autorizar a nadie porque el consumo exige el vinculo.
    await store.saveChallenge({
      challengeHash: 'hash-heredado-sin-vinculo',
      boundDeviceId: '',
      issuedAtMilliseconds: NOW,
      expiresAtMilliseconds: NOW + 10_000_000,
    });
    await issueEnrollmentChallenge({
      store,
      boundDeviceId: PHONE_A,
      nowMilliseconds: NOW,
      ttlMilliseconds: 100_000,
    });
    // No hace falta que venza para que se la lleve: ya no puede autorizar a nadie.
    expect(await store.readChallenge('hash-heredado-sin-vinculo')).toBeNull();
  });

  it('borra lo vencido y deja lo vigente', async () => {
    const store = createInMemoryEnrollmentStore();
    const expired = await issueEnrollmentChallenge({
      store,
      boundDeviceId: PHONE_A,
      nowMilliseconds: NOW,
      ttlMilliseconds: 1,
    });
    const live = await issueEnrollmentChallenge({
      store,
      boundDeviceId: PHONE_A,
      nowMilliseconds: NOW,
      ttlMilliseconds: 100_000,
    });

    expect(await store.pruneChallenge({ nowMilliseconds: NOW + 500, limit: 50 })).toBe(1);

    expect(await store.readChallenge(await hashSecret(expired.challenge))).toBeNull();
    expect(await store.readChallenge(await hashSecret(live.challenge))).not.toBeNull();
  });

  it('la limpieza NO toca una credencial revocada', async () => {
    const store = createInMemoryEnrollmentStore();
    const credential = await enrollPhone(store, PHONE_A, 0);
    await revokeDeviceCredential({ store, deviceId: PHONE_A, nowMilliseconds: NOW });
    const revokedHash = (await store.readCredential(PHONE_A))?.credentialHash;

    await store.pruneChallenge({ nowMilliseconds: NOW + 10_000_000, limit: 50 });

    // Es lo que le cierra `?token=` a este telefono. Si la limpieza lo borrara,
    // estaria desrevocando un equipo sin que nadie lo pidiera.
    const afterPrune = await store.readCredential(PHONE_A);
    expect(afterPrune?.status).toBe('revoked');
    expect(afterPrune?.credentialHash).toBe(revokedHash);
    expect(await verifyDeviceCredential({ store, credential })).toMatchObject({
      status: 'rejected',
      reason: 'credential_revoked',
    });
  });

  it('limpiar no convierte un rechazo en un acierto', async () => {
    const store = createInMemoryEnrollmentStore();
    const expired = await issueEnrollmentChallenge({
      store,
      boundDeviceId: PHONE_A,
      nowMilliseconds: NOW,
      ttlMilliseconds: 1,
    });
    // Antes de limpiar, el rechazo es por vencimiento.
    expect(
      await claimEnrollmentChallenge({
        store,
        challenge: expired.challenge,
        deviceId: PHONE_A,
        nowMilliseconds: NOW + 500,
        isDeviceIdValid: ALWAYS_VALID_DEVICE_ID,
      }),
    ).toMatchObject({ status: 'rejected', reason: 'challenge_expired' });

    await store.pruneChallenge({ nowMilliseconds: NOW + 500, limit: 50 });

    // Despues de limpiar, el rechazo es por desconocido. Cambia el motivo, nunca
    // el veredicto: por eso la limpieza no puede servir para bypassear el claim.
    expect(
      await claimEnrollmentChallenge({
        store,
        challenge: expired.challenge,
        deviceId: PHONE_A,
        nowMilliseconds: NOW + 500,
        isDeviceIdValid: ALWAYS_VALID_DEVICE_ID,
      }),
    ).toMatchObject({ status: 'rejected', reason: 'challenge_unknown' });
  });

  it('el limite acota el trabajo por llamada', async () => {
    const store = createInMemoryEnrollmentStore();
    for (let index = 0; index < 5; index += 1) {
      await store.saveChallenge({
        challengeHash: `hash-vencido-${index}`,
        boundDeviceId: PHONE_A,
        issuedAtMilliseconds: NOW,
        expiresAtMilliseconds: NOW - 1,
      });
    }
    expect(await store.pruneChallenge({ nowMilliseconds: NOW, limit: 2 })).toBe(2);
    expect(await store.pruneChallenge({ nowMilliseconds: NOW, limit: 50 })).toBe(3);
    expect(await store.pruneChallenge({ nowMilliseconds: NOW, limit: 50 })).toBe(0);
  });

  it('emitir un desafio dispara la limpieza, y no por el claim', async () => {
    const store = createInMemoryEnrollmentStore();
    await store.saveChallenge({
      challengeHash: 'hash-vencido-para-la-emision',
      boundDeviceId: PHONE_A,
      issuedAtMilliseconds: NOW,
      expiresAtMilliseconds: NOW - 1,
    });
    await issueEnrollmentChallenge({
      store,
      boundDeviceId: PHONE_A,
      nowMilliseconds: NOW,
      ttlMilliseconds: 100_000,
    });
    expect(await store.readChallenge('hash-vencido-para-la-emision')).toBeNull();
  });
});
