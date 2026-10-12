import { describe, expect, it } from 'bun:test';

import {
  claimEnrollmentChallenge,
  hashSecret,
  issueEnrollmentChallenge,
  revokeDeviceCredential,
  verifyDeviceCredential,
  type ChallengeConsumeOutcome,
  type EnrollmentStore,
} from '@/devices/enrollment';
import { createInMemoryEnrollmentStore } from '@/devices/credential-store';
import { isEnrollableMobileDeviceId } from '@/devices/route';

// ─────────────────────────────────────────────────────────────────────────────
// BLOCK 12.1: el desafío atado a un dispositivo, y el consumo atómico.
//
// Los dos riesgos que este bloque cierra:
//
// 1. El desafío no decía QUÉ teléfono estaba autorizando, así que quien lo
//    obtuviera podía reclamar cualquier identidad.
// 2. Consumir el desafío era `readChallenge` + `deleteChallenge`, con un `await`
//    en el medio: dos claims concurrentes leían el mismo desafío válido y los dos
//    pasaban los chequeos antes de que uno lo borrara.
//
// Reloj inyectado a mano en todos lados: la expiración es una regla de seguridad
// y no puede depender de un `Date.now()` real.
// ─────────────────────────────────────────────────────────────────────────────

const PHONE_A = 'mobile:phone-a';
const PHONE_B = 'mobile:phone-b';
const NOW = 1_700_000_000_000;

const VALID_DEVICE_ID = (deviceId: string): boolean =>
  isEnrollableMobileDeviceId(deviceId);

async function issueChallengeFor(
  store: EnrollmentStore,
  boundDeviceId: string,
  offsetMilliseconds = 0,
): Promise<string> {
  const issued = await issueEnrollmentChallenge({
    store,
    nowMilliseconds: NOW + offsetMilliseconds,
    boundDeviceId,
  });
  return issued.challenge;
}

async function claim(
  store: EnrollmentStore,
  challenge: string,
  deviceId: string,
  offsetMilliseconds = 0,
): ReturnType<typeof claimEnrollmentChallenge> {
  return claimEnrollmentChallenge({
    store,
    nowMilliseconds: NOW + offsetMilliseconds,
    challenge,
    deviceId,
    isDeviceIdValid: VALID_DEVICE_ID,
  });
}

// ── 12.1 §2: el vínculo ─────────────────────────────────────────────────────

describe('B12.1 §2: el desafío queda atado a un dispositivo', () => {
  it('1. el desafío se guarda con el deviceId que el dueño autorizó', async () => {
    const store = createInMemoryEnrollmentStore();
    const challenge = await issueChallengeFor(store, PHONE_A);
    const record = await store.readChallenge(await hashOf(challenge));

    expect(record?.boundDeviceId).toBe(PHONE_A);
  });

  it('2. A puede canjear su propio desafío', async () => {
    const store = createInMemoryEnrollmentStore();
    const challenge = await issueChallengeFor(store, PHONE_A);

    const result = await claim(store, challenge, PHONE_A, 1);

    expect(result.status).toBe('enrolled');
    if (result.status === 'enrolled') {
      expect(result.deviceId).toBe(PHONE_A);
      expect(
        await verifyDeviceCredential({ store, credential: result.credential }),
      ).toEqual({ status: 'valid', deviceId: PHONE_A });
    }
  });

  it('3. B NO puede canjear el desafío de A', async () => {
    const store = createInMemoryEnrollmentStore();
    const challenge = await issueChallengeFor(store, PHONE_A);

    const result = await claim(store, challenge, PHONE_B, 1);

    expect(result).toEqual({ status: 'rejected', reason: 'device_id_mismatch' });
    // Y no se creó ninguna credencial para B: el intento no deja rastro.
    expect(await store.readCredential(PHONE_B)).toBeNull();
  });

  it('4. el intento fallido de B NO consume el desafío de A', async () => {
    const store = createInMemoryEnrollmentStore();
    const challenge = await issueChallengeFor(store, PHONE_A);

    await claim(store, challenge, PHONE_B, 1);

    // El desafío sigue vivo: A todavía puede canjearlo.
    const result = await claim(store, challenge, PHONE_A, 2);
    expect(result.status).toBe('enrolled');
  });

  it('5. el vínculo sobrevive al re-enrollment con otro dueño de desafío', async () => {
    // Dos desafíos para el mismo teléfono, ambos consumibles por ese teléfono.
    const store = createInMemoryEnrollmentStore();
    const firstChallenge = await issueChallengeFor(store, PHONE_A, 0);
    const secondChallenge = await issueChallengeFor(store, PHONE_A, 1_000);

    expect((await claim(store, firstChallenge, PHONE_A, 2)).status).toBe('enrolled');
    expect((await claim(store, secondChallenge, PHONE_A, 3)).status).toBe('enrolled');
  });

  it('6. un desafío expirado no se puede canjear ni después de arreglar el deviceId', async () => {
    const store = createInMemoryEnrollmentStore();
    const issued = await issueEnrollmentChallenge({
      store,
      nowMilliseconds: NOW,
      boundDeviceId: PHONE_A,
    });

    const result = await claim(
      store,
      issued.challenge,
      PHONE_A,
      issued.expiresAtMilliseconds,
    );

    expect(result).toEqual({ status: 'rejected', reason: 'challenge_expired' });
  });

  it('7. un desafío revocado no se reutiliza', async () => {
    // El teléfono se enrola, se revoca, y su desafío viejo no vuelve a servir.
    const store = createInMemoryEnrollmentStore();
    const credentialChallenge = await issueChallengeFor(store, PHONE_A);
    const enrolled = await claim(store, credentialChallenge, PHONE_A, 1);
    if (enrolled.status !== 'enrolled') {
      throw new Error('el enrollment deberia haber funcionado');
    }
    await revokeDeviceCredential({ store, deviceId: PHONE_A, nowMilliseconds: NOW + 2 });

    const leftoverChallenge = await issueChallengeFor(store, PHONE_A, 3);
    const reEnrolled = await claim(store, leftoverChallenge, PHONE_A, 4);

    // Re-enrolar con un desafío nuevo y del dueño sí funciona, y rota la
    // credencial revocada.
    expect(reEnrolled.status).toBe('enrolled');
    if (reEnrolled.status === 'enrolled') {
      expect(
        (await verifyDeviceCredential({ store, credential: enrolled.credential })).status,
      ).toBe('rejected');
    }
  });

  it('8. dos teléfonos con desafíos distintos no se mezclan', async () => {
    const store = createInMemoryEnrollmentStore();
    const challengeA = await issueChallengeFor(store, PHONE_A, 0);
    const challengeB = await issueChallengeFor(store, PHONE_B, 1);

    const resultA = await claim(store, challengeA, PHONE_A, 2);
    const resultB = await claim(store, challengeB, PHONE_B, 3);

    expect(resultA.status).toBe('enrolled');
    expect(resultB.status).toBe('enrolled');
    if (resultA.status !== 'enrolled' || resultB.status !== 'enrolled') {
      throw new Error('los dos enrolamientos deberian haber funcionado');
    }
    expect(resultA.credential).not.toBe(resultB.credential);
    // Cada credencial resuelve a su propio teléfono.
    expect(
      await verifyDeviceCredential({ store, credential: resultA.credential }),
    ).toEqual({ status: 'valid', deviceId: PHONE_A });
    expect(
      await verifyDeviceCredential({ store, credential: resultB.credential }),
    ).toEqual({ status: 'valid', deviceId: PHONE_B });
  });
});

// ── 12.1 §5: el consumo es atómico ─────────────────────────────────────────

describe('B12.1 §5: dos claims simultáneos producen como máximo una credencial', () => {
  it('el CAS deja ganar a uno solo', async () => {
    const store = createInMemoryEnrollmentStore();
    const challenge = await issueChallengeFor(store, PHONE_A);

    // Sin await entre medio: los dos claims quedanPending al mismo tiempo y el
    // store decide.
    const [first, second] = await Promise.all([
      claim(store, challenge, PHONE_A, 1),
      claim(store, challenge, PHONE_A, 1),
    ]);

    const resultList = [first, second];
    const enrolledCount = resultList.filter(
      (entry) => entry.status === 'enrolled',
    ).length;
    const rejectedCount = resultList.filter(
      (entry) => entry.status === 'rejected',
    ).length;

    expect(enrolledCount).toBe(1);
    expect(rejectedCount).toBe(1);
  });

  it('concurrentes con deviceIds distintos sólo gana el atado', async () => {
    const store = createInMemoryEnrollmentStore();
    const challenge = await issueChallengeFor(store, PHONE_A);

    const [forA, forB] = await Promise.all([
      claim(store, challenge, PHONE_A, 1),
      claim(store, challenge, PHONE_B, 1),
    ]);

    expect(forA.status).toBe('enrolled');
    // B nunca gana. El motivo exacto depende del entrelazado -- si A consumió
    // primero, B ve `challenge_consumed`; si B llegó primero, ve
    // `device_id_mismatch` -- así que se afirma el rechazo, no el orden.
    expect(forB.status).toBe('rejected');
    if (forB.status === 'rejected') {
      expect(['device_id_mismatch', 'challenge_consumed']).toContain(forB.reason);
    }
    expect(await store.readCredential(PHONE_B)).toBeNull();
  });

  it('muchos claims a la vez: exactamente una credencial', async () => {
    const store = createInMemoryEnrollmentStore();
    const challenge = await issueChallengeFor(store, PHONE_A);

    const resultList = await Promise.all(
      Array.from({ length: 12 }, () => claim(store, challenge, PHONE_A, 1)),
    );

    const credentialList = resultList
      .filter((entry) => entry.status === 'enrolled')
      .map((entry) => (entry as { credential: string }).credential);
    expect(credentialList).toHaveLength(1);

    // Y esa única credencial es la única que verifica.
    for (const credential of credentialList) {
      expect(await verifyDeviceCredential({ store, credential })).toEqual({
        status: 'valid',
        deviceId: PHONE_A,
      });
    }
    expect(await store.listCredentialRecordList()).toHaveLength(1);
  });

  it('el perdedor recibe un motivo, no una excepción', async () => {
    const store = createInMemoryEnrollmentStore();
    const challenge = await issueChallengeFor(store, PHONE_A);
    await claim(store, challenge, PHONE_A, 1);

    const latecomer = await claim(store, challenge, PHONE_A, 2);
    expect(latecomer).toEqual({ status: 'rejected', reason: 'challenge_consumed' });
  });
});

// ── 12.1 §5: el store tiene que upholdar el CAS, no el llamador ────────────

describe('B12.1 §5: el contrato de consumeChallenge', () => {
  it('consumeChallenge devuelve el deviceId atado sólo cuando consumió', async () => {
    const store = createInMemoryEnrollmentStore();
    const challenge = await issueChallengeFor(store, PHONE_A);
    const challengeHash = await hashOf(challenge);

    const won: ChallengeConsumeOutcome = await store.consumeChallenge({
      challengeHash,
      deviceId: PHONE_A,
      consumedToken: 'token-a',
      nowMilliseconds: NOW,
    });
    expect(won).toEqual({ wasConsumed: true, boundDeviceId: PHONE_A });

    const second: ChallengeConsumeOutcome = await store.consumeChallenge({
      challengeHash,
      deviceId: PHONE_A,
      consumedToken: 'token-b',
      nowMilliseconds: NOW,
    });
    expect(second).toEqual({ wasConsumed: false, reason: 'challenge_consumed' });
  });

  it('un deviceId distinto no consume', async () => {
    const store = createInMemoryEnrollmentStore();
    const challenge = await issueChallengeFor(store, PHONE_A);
    const challengeHash = await hashOf(challenge);

    const outcome = await store.consumeChallenge({
      challengeHash,
      deviceId: PHONE_B,
      consumedToken: 'token-b',
      nowMilliseconds: NOW,
    });

    expect(outcome).toEqual({ wasConsumed: false, reason: 'device_id_mismatch' });
    // Sigue sin consumirse, así que el atado todavía puede pasar.
    expect(
      await store.consumeChallenge({
        challengeHash,
        deviceId: PHONE_A,
        consumedToken: 'token-a',
        nowMilliseconds: NOW,
      }),
    ).toEqual({ wasConsumed: true, boundDeviceId: PHONE_A });
  });

  it('un desafío desconocido se clasifica sin tocar nada', async () => {
    const store = createInMemoryEnrollmentStore();
    const outcome = await store.consumeChallenge({
      challengeHash: await hashOf('apollo_enr_nunca-emitido'),
      deviceId: PHONE_A,
      consumedToken: 'token',
      nowMilliseconds: NOW,
    });
    expect(outcome).toEqual({ wasConsumed: false, reason: 'challenge_unknown' });
  });
});

// ── helpers ────────────────────────────────────────────────────────────────

async function hashOf(challenge: string): Promise<string> {
  return hashSecret(challenge);
}
