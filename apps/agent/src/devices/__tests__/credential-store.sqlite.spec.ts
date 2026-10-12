import { Database } from 'bun:sqlite';
import { describe, expect, it } from 'bun:test';

import { createSqliteEnrollmentStore } from '@/devices/credential-store';
import {
  claimEnrollmentChallenge,
  hashSecret,
  issueEnrollmentChallenge,
} from '@/devices/enrollment';

const PHONE_DEVICE_ID = 'mobile:phone-123';
const OTHER_DEVICE_ID = 'mobile:phone-456';
const START_MILLISECONDS = 1_700_000_000_000;
const ONE_HOUR_MILLISECONDS = 3_600_000;

/**
 * Adaptador de `SqlStorage` de Durable Objects sobre `bun:sqlite`.
 *
 * LIMITACION CONOCIDA: esto NO es workerd. `bun:sqlite` es el mismo motor SQLite,
 * pero `SqlStorage` de los Durable Objects tiene su propia API y su propio
 * planificador. Este spec prueba el SQL y el orden de las decisiones, que es
 * donde estaban W1 y W2; no prueba el comportamiento del runtime de produccion.
 *
 * Los tests de `enrollment.spec.ts` usan `createInMemoryEnrollmentStore()`, que es
 * OTRA implementacion. Por eso el store SQLite de produccion estaba sin cubrir y
 * los dos bugs convivieron con 1303 tests en verde.
 */
function createSqlStorage(initialSchema: 'empty' | 'legacy' | 'current') {
  const database = new Database(':memory:');
  if (initialSchema === 'legacy') {
    // Esquema de BLOCK 12: sin device_id, sin consumed_at, sin consumed_token.
    database.run(
      'CREATE TABLE mobile_enrollment_challenge (challenge_hash TEXT PRIMARY KEY, issued_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)',
    );
  }
  if (initialSchema === 'current') {
    database.run(
      `CREATE TABLE mobile_enrollment_challenge (
        challenge_hash TEXT PRIMARY KEY,
        device_id TEXT NOT NULL DEFAULT '',
        issued_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        consumed_at INTEGER,
        consumed_token TEXT
      )`,
    );
  }
  return {
    exec(query: string, ...bindValues: unknown[]) {
      const statement = database.query(query);
      const isRead = /^\s*(SELECT|PRAGMA)/i.test(query);
      if (isRead) {
        const rowList = statement.all(...(bindValues as never[])) as Record<
          string,
          unknown
        >[];
        return { toArray: () => rowList };
      }
      statement.run(...(bindValues as never[]));
      return { toArray: () => [] };
    },
  };
}

describe('credential-store SQLite: W2 (esquema de una instancia nueva)', () => {
  it('una base totalmente vacía emite desafíos sin fallar', async () => {
    const store = createSqliteEnrollmentStore(createSqlStorage('empty'));
    const issued = await issueEnrollmentChallenge({
      store,
      nowMilliseconds: START_MILLISECONDS,
      boundDeviceId: PHONE_DEVICE_ID,
    });
    expect(issued.status).toBe('issued');
  });

  it('una base totalmente vacía permite un canje completo', async () => {
    const store = createSqliteEnrollmentStore(createSqlStorage('empty'));
    const issued = await issueEnrollmentChallenge({
      store,
      nowMilliseconds: START_MILLISECONDS,
      boundDeviceId: PHONE_DEVICE_ID,
    });
    const claim = await claimEnrollmentChallenge({
      store,
      nowMilliseconds: START_MILLISECONDS + 1_000,
      challenge: issued.challenge,
      deviceId: PHONE_DEVICE_ID,
      isDeviceIdValid: () => true,
    });
    expect(claim.status).toBe('enrolled');
  });

  it('una tabla heredada de BLOCK 12 se migra y puede emitir desafíos', async () => {
    const store = createSqliteEnrollmentStore(createSqlStorage('legacy'));
    const issued = await issueEnrollmentChallenge({
      store,
      nowMilliseconds: START_MILLISECONDS,
      boundDeviceId: PHONE_DEVICE_ID,
    });
    expect(issued.status).toBe('issued');
  });

  it('una tabla ya actual no se rompe ni duplica columnas', async () => {
    const store = createSqliteEnrollmentStore(createSqlStorage('current'));
    const issued = await issueEnrollmentChallenge({
      store,
      nowMilliseconds: START_MILLISECONDS,
      boundDeviceId: PHONE_DEVICE_ID,
    });
    expect(issued.status).toBe('issued');
    const second = await issueEnrollmentChallenge({
      store,
      nowMilliseconds: START_MILLISECONDS + 1,
      boundDeviceId: PHONE_DEVICE_ID,
    });
    expect(second.status).toBe('issued');
  });

  it('las tres formas de base producen el mismo comportamiento', async () => {
    for (const initialSchema of ['empty', 'legacy', 'current'] as const) {
      const store = createSqliteEnrollmentStore(createSqlStorage(initialSchema));
      const issued = await issueEnrollmentChallenge({
        store,
        nowMilliseconds: START_MILLISECONDS,
        boundDeviceId: PHONE_DEVICE_ID,
      });
      const claim = await claimEnrollmentChallenge({
        store,
        nowMilliseconds: START_MILLISECONDS + 1_000,
        challenge: issued.challenge,
        deviceId: PHONE_DEVICE_ID,
        isDeviceIdValid: () => true,
      });
      expect(`${initialSchema}:${claim.status}`).toBe(`${initialSchema}:enrolled`);
    }
  });
});

describe('credential-store SQLite: W1 (un desafío vencido no emite credencial)', () => {
  it('un vencido, con el deviceId y el token correctos, NO se consume', async () => {
    const store = createSqliteEnrollmentStore(createSqlStorage('legacy'));
    const issued = await issueEnrollmentChallenge({
      store,
      nowMilliseconds: START_MILLISECONDS,
      boundDeviceId: PHONE_DEVICE_ID,
    });

    const outcome = await store.consumeChallenge({
      challengeHash: await hashSecret(issued.challenge),
      deviceId: PHONE_DEVICE_ID,
      consumedToken: 'token-ganador',
      // Una hora despues del vencimiento: el CAS igual matchea, porque su WHERE
      // no mira expires_at. Esto es exactamente lo que rompia.
      nowMilliseconds: issued.expiresAtMilliseconds + ONE_HOUR_MILLISECONDS,
    });

    expect(outcome.wasConsumed).toBe(false);
    expect(outcome).toMatchObject({ reason: 'challenge_expired' });
  });

  it('un vencido rechaza el canje y NO guarda credencial', async () => {
    const store = createSqliteEnrollmentStore(createSqlStorage('legacy'));
    const issued = await issueEnrollmentChallenge({
      store,
      nowMilliseconds: START_MILLISECONDS,
      boundDeviceId: PHONE_DEVICE_ID,
    });

    const claim = await claimEnrollmentChallenge({
      store,
      nowMilliseconds: issued.expiresAtMilliseconds + ONE_HOUR_MILLISECONDS,
      challenge: issued.challenge,
      deviceId: PHONE_DEVICE_ID,
      isDeviceIdValid: () => true,
    });

    expect(claim).toEqual({ status: 'rejected', reason: 'challenge_expired' });
    expect(await store.readCredential(PHONE_DEVICE_ID)).toBeNull();
  });

  it('un vencido queda consumido y no se puede reintentar', async () => {
    const store = createSqliteEnrollmentStore(createSqlStorage('legacy'));
    const issued = await issueEnrollmentChallenge({
      store,
      nowMilliseconds: START_MILLISECONDS,
      boundDeviceId: PHONE_DEVICE_ID,
    });
    const challengeHash = await hashSecret(issued.challenge);

    const expiredOutcome = await store.consumeChallenge({
      challengeHash,
      deviceId: PHONE_DEVICE_ID,
      consumedToken: 'token-ganador',
      nowMilliseconds: issued.expiresAtMilliseconds + ONE_HOUR_MILLISECONDS,
    });
    expect(expiredOutcome.wasConsumed).toBe(false);

    // Un desafio vencido no es un desafio reutilizable: quemarlo es lo seguro.
    const retryOutcome = await store.consumeChallenge({
      challengeHash,
      deviceId: PHONE_DEVICE_ID,
      consumedToken: 'token-otro',
      nowMilliseconds: issued.expiresAtMilliseconds + ONE_HOUR_MILLISECONDS + 1,
    });
    expect(retryOutcome.wasConsumed).toBe(false);
    expect(retryOutcome).toMatchObject({ reason: 'challenge_consumed' });
  });

  it('un desafío VIGENTE con el deviceId correcto se consume bien', async () => {
    const store = createSqliteEnrollmentStore(createSqlStorage('legacy'));
    const issued = await issueEnrollmentChallenge({
      store,
      nowMilliseconds: START_MILLISECONDS,
      boundDeviceId: PHONE_DEVICE_ID,
    });

    const outcome = await store.consumeChallenge({
      challengeHash: await hashSecret(issued.challenge),
      deviceId: PHONE_DEVICE_ID,
      consumedToken: 'token-ganador',
      nowMilliseconds: START_MILLISECONDS + 1_000,
    });

    expect(outcome).toMatchObject({
      wasConsumed: true,
      boundDeviceId: PHONE_DEVICE_ID,
    });
  });

  it('un desafío vigente 1 ms antes del vencimiento se consume bien', async () => {
    const store = createSqliteEnrollmentStore(createSqlStorage('legacy'));
    const issued = await issueEnrollmentChallenge({
      store,
      nowMilliseconds: START_MILLISECONDS,
      boundDeviceId: PHONE_DEVICE_ID,
    });

    const outcome = await store.consumeChallenge({
      challengeHash: await hashSecret(issued.challenge),
      deviceId: PHONE_DEVICE_ID,
      consumedToken: 'token-ganador',
      nowMilliseconds: issued.expiresAtMilliseconds - 1,
    });

    expect(outcome.wasConsumed).toBe(true);
  });

  it('un desafío vigente con el deviceId equivocado NO se consume', async () => {
    const store = createSqliteEnrollmentStore(createSqlStorage('legacy'));
    const issued = await issueEnrollmentChallenge({
      store,
      nowMilliseconds: START_MILLISECONDS,
      boundDeviceId: PHONE_DEVICE_ID,
    });

    const outcome = await store.consumeChallenge({
      challengeHash: await hashSecret(issued.challenge),
      deviceId: OTHER_DEVICE_ID,
      consumedToken: 'token-ganador',
      nowMilliseconds: START_MILLISECONDS + 1_000,
    });

    expect(outcome.wasConsumed).toBe(false);
    expect(outcome).toMatchObject({ reason: 'device_id_mismatch' });
  });

  it('un desafío vigente mantiene la semántica de carrera: un solo ganador', async () => {
    const store = createSqliteEnrollmentStore(createSqlStorage('legacy'));
    const issued = await issueEnrollmentChallenge({
      store,
      nowMilliseconds: START_MILLISECONDS,
      boundDeviceId: PHONE_DEVICE_ID,
    });
    const challengeHash = await hashSecret(issued.challenge);
    const validNow = START_MILLISECONDS + 1_000;

    const [first, second] = await Promise.all([
      store.consumeChallenge({
        challengeHash,
        deviceId: PHONE_DEVICE_ID,
        consumedToken: 'token-a',
        nowMilliseconds: validNow,
      }),
      store.consumeChallenge({
        challengeHash,
        deviceId: PHONE_DEVICE_ID,
        consumedToken: 'token-b',
        nowMilliseconds: validNow,
      }),
    ]);

    // Exactamente uno gana: el CAS sigue siendo el que decide.
    expect([first.wasConsumed, second.wasConsumed].filter(Boolean)).toHaveLength(1);
  });
});
