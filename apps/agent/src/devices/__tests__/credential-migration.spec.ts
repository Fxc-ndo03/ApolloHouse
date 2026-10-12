import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  claimEnrollmentChallenge,
  issueEnrollmentChallenge,
  type EnrollmentStore,
} from '@/devices/enrollment';
import {
  createSqliteEnrollmentStore,
  type EnrollmentSqlStorage,
} from '@/devices/credential-store';
import { isEnrollableMobileDeviceId } from '@/devices/route';

// ─────────────────────────────────────────────────────────────────────────────
// BLOCK 12.1: la migración del schema de desafíos.
//
// `CREATE TABLE IF NOT EXISTS` no agrega columnas a una tabla que ya existe, así
// que una deployment de BLOCK 12 -- que ya tiene `mobile_enrollment_challenge`
// con el schema viejo -- fallaría con "no column named device_id" en el primer
// enrollment. Lo encontró el primer smoke contra workerd real.
//
// Estos tests usan un doble de SQLStorage con el schema VIEJO para que la
// migración se ejecute en la JVM, sin workerd.
// ─────────────────────────────────────────────────────────────────────────────

const NOW = 1_700_000_000_000;
const PHONE_A = 'mobile:phone-a';
const VALID_DEVICE_ID = (deviceId: string): boolean =>
  isEnrollableMobileDeviceId(deviceId);

/**
 * Un `SqlStorage` mínimo que registra las sentencias. No evalúa SQL: lo que se
 * prueba es que el store EMITA la migración, no que SQLite la interprete.
 */
function createRecordingSqlStorage(
  existingColumnList: readonly string[],
  selectRowList: readonly Record<string, unknown>[] = [],
) {
  const executedStatementList: string[] = [];
  const storage: EnrollmentSqlStorage = {
    exec(query: string) {
      const normalizedQuery = query.replaceAll(/\s+/g, ' ').trim();
      executedStatementList.push(normalizedQuery);
      if (normalizedQuery.startsWith('PRAGMA table_info')) {
        return {
          toArray: () => existingColumnList.map((columnName) => ({ name: columnName })),
        };
      }
      return { toArray: () => [...selectRowList] };
    },
  };
  return { storage, executedStatementList };
}

const BLOCK_12_CHALLENGE_COLUMN_LIST = [
  'challenge_hash',
  'issued_at',
  'expires_at',
] as const;

describe('B12.1 §5: la migración del schema de desafíos', () => {
  it('una base de BLOCK 12 recibe las columnas nuevas', async () => {
    const { storage, executedStatementList } = createRecordingSqlStorage(
      BLOCK_12_CHALLENGE_COLUMN_LIST,
    );
    const store: EnrollmentStore = createSqliteEnrollmentStore(storage);

    await store.readChallenge('cualquiera');

    const migrationStatementList = executedStatementList.filter((statement) =>
      statement.startsWith('ALTER TABLE'),
    );
    expect(migrationStatementList).toHaveLength(3);
    expect(migrationStatementList.join(' ')).toContain('ADD COLUMN device_id');
    expect(migrationStatementList.join(' ')).toContain('ADD COLUMN consumed_at');
    expect(migrationStatementList.join(' ')).toContain('ADD COLUMN consumed_token');
  });

  it('una base ya migrada no vuelve a migrar', async () => {
    // Idempotente: si el guard no comprobara las columnas, cada request ejecutaría
    // tres ALTER TABLE sobre una tabla que ya las tiene.
    const { storage, executedStatementList } = createRecordingSqlStorage([
      ...BLOCK_12_CHALLENGE_COLUMN_LIST,
      'device_id',
      'consumed_at',
      'consumed_token',
    ]);
    const store: EnrollmentStore = createSqliteEnrollmentStore(storage);

    await store.readChallenge('cualquiera');
    await store.readChallenge('otra');

    expect(
      executedStatementList.filter((statement) => statement.startsWith('ALTER TABLE')),
    ).toHaveLength(0);
  });

  it('la migración da a device_id un default, porque SQLite lo exige', async () => {
    const { storage, executedStatementList } = createRecordingSqlStorage(
      BLOCK_12_CHALLENGE_COLUMN_LIST,
    );
    const store: EnrollmentStore = createSqliteEnrollmentStore(storage);

    await store.readChallenge('cualquiera');

    // Sin el DEFAULT, `ADD COLUMN ... NOT NULL` es un error de sintaxis en SQLite.
    expect(
      executedStatementList.some(
        (statement) =>
          statement.includes('device_id') && statement.includes("DEFAULT ''"),
      ),
    ).toBe(true);
  });

  it('el INSERT guarda el deviceId atado', async () => {
    const { storage, executedStatementList } = createRecordingSqlStorage([
      ...BLOCK_12_CHALLENGE_COLUMN_LIST,
      'device_id',
      'consumed_at',
      'consumed_token',
    ]);
    const store: EnrollmentStore = createSqliteEnrollmentStore(storage);

    await issueEnrollmentChallenge({
      store,
      nowMilliseconds: NOW,
      boundDeviceId: PHONE_A,
    });

    const insertStatementList = executedStatementList.filter((statement) =>
      statement.startsWith('INSERT OR REPLACE INTO mobile_enrollment_challenge'),
    );
    expect(insertStatementList).toHaveLength(1);
    expect(insertStatementList[0]).toContain('device_id');
    // No alcanza con que la COLUMNA esté en el INSERT: tiene que ir el VALOR del
    // vínculo. Con `''` en el binding, `consumeChallenge` leería un deviceId
    // vacío y rechazaría todo enrollment, y el assert anterior no lo notaría.
    const saveChallengeBody = readStoreFunctionBody(
      'async saveChallenge(input): Promise<void> {',
    );
    expect(saveChallengeBody).toContain('device_id');
    expect(saveChallengeBody).toContain('input.boundDeviceId');
  });

  it('el CAS sólo matchea desafíos sin consumir y del deviceId correcto', async () => {
    const { storage, executedStatementList } = createRecordingSqlStorage([
      ...BLOCK_12_CHALLENGE_COLUMN_LIST,
      'device_id',
      'consumed_at',
      'consumed_token',
    ]);
    const store: EnrollmentStore = createSqliteEnrollmentStore(storage);

    await store.consumeChallenge({
      challengeHash: 'hash',
      deviceId: PHONE_A,
      consumedToken: 'token',
      nowMilliseconds: NOW,
    });

    const updateStatement = executedStatementList.find((statement) =>
      statement.startsWith('UPDATE mobile_enrollment_challenge'),
    );
    expect(updateStatement).toBeDefined();
    // Las dos condiciones son la garantía: sin `consumed_at IS NULL` dos claims
    // podrían ganar, y sin `device_id = ?` el de B consumiría el de A.
    expect(updateStatement).toContain('consumed_at IS NULL');
    expect(updateStatement).toContain('device_id = ?');
  });

  it('dos operaciones concurrentes no disparan la migración dos veces', async () => {
    // Con un memo de BOOLEANO, dos requests concurrentes veían `false` y las dos
    // ejecutaban el ALTER; la segunda moría con "duplicate column name" y
    // devolvía un 500. Se veía como un fallo intermitente del smoke, una de cada
    // N corridas.
    const alterCountList: number[] = [];
    let columnNameList: string[] = [...BLOCK_12_CHALLENGE_COLUMN_LIST];
    const storage: EnrollmentSqlStorage = {
      exec(query: string) {
        const normalizedQuery = query.replaceAll(/\s+/g, ' ').trim();
        if (normalizedQuery.startsWith('PRAGMA table_info')) {
          return { toArray: () => columnNameList.map((name) => ({ name })) };
        }
        if (normalizedQuery.startsWith('ALTER TABLE')) {
          alterCountList.push(1);
          const addedColumn = normalizedQuery.split('ADD COLUMN ')[1]?.split(' ')[0];
          if (addedColumn !== undefined) {
            columnNameList = [...columnNameList, addedColumn];
          }
        }
        return { toArray: () => [] as Record<string, unknown>[] };
      },
    };
    const store: EnrollmentStore = createSqliteEnrollmentStore(storage);

    await Promise.all([
      store.readChallenge('a'),
      store.readChallenge('b'),
      store.readChallenge('c'),
    ]);

    // Las tres columnas, una vez cada una, y no nueve.
    expect(alterCountList).toHaveLength(3);
  });

  it('la migracion completa antes de que la operacion siga', async () => {
    // Si `ensureSchema` no esperara la promesa, el INSERT de `saveChallenge`
    // corria contra el schema viejo y fallaba con "no column named device_id",
    // que es el error exacto que dio el primer smoke.
    const executedStatementList: string[] = [];
    const storage: EnrollmentSqlStorage = {
      exec(query: string) {
        const normalizedQuery = query.replaceAll(/\s+/g, ' ').trim();
        executedStatementList.push(normalizedQuery);
        if (normalizedQuery.startsWith('PRAGMA table_info')) {
          return {
            toArray: () => BLOCK_12_CHALLENGE_COLUMN_LIST.map((name) => ({ name })),
          };
        }
        return { toArray: () => [] as Record<string, unknown>[] };
      },
    };
    const store: EnrollmentStore = createSqliteEnrollmentStore(storage);

    await issueEnrollmentChallenge({
      store,
      nowMilliseconds: NOW,
      boundDeviceId: PHONE_A,
    });

    const alterIndex = executedStatementList.findIndex((statement) =>
      statement.startsWith('ALTER TABLE'),
    );
    const insertIndex = executedStatementList.findIndex((statement) =>
      statement.startsWith('INSERT OR REPLACE INTO mobile_enrollment_challenge'),
    );
    expect(alterIndex).toBeGreaterThan(-1);
    expect(insertIndex).toBeGreaterThan(alterIndex);
  });

  it('un claim sobre una base migrada no puede autorizarse a sí mismo', async () => {
    // Una fila vieja tiene deviceId vacío: no hay vínculo, así que no autoriza.
    const { storage } = createRecordingSqlStorage(BLOCK_12_CHALLENGE_COLUMN_LIST);
    const store: EnrollmentStore = createSqliteEnrollmentStore(storage);

    const result = await claimEnrollmentChallenge({
      store,
      nowMilliseconds: NOW,
      // Un desafío de BLOCK 12: el hash existe pero el store no tiene fila con
      // vínculo, así que el CAS devuelve unknown y no se emite nada.
      challenge: 'apollo_enr_desafio-viejo',
      deviceId: PHONE_A,
      isDeviceIdValid: VALID_DEVICE_ID,
    });

    expect(result.status).toBe('rejected');
  });
});

// El store no se puede ejercitar con un motor de SQL real en la JVM, así que
// esto lee el fuente para poder afirmar sobre el binding del INSERT.
function readStoreSource(): string {
  return readFileSync(join(import.meta.dir, '..', 'credential-store.ts'), 'utf8');
}

function readStoreFunctionBody(signatureFragment: string): string {
  const source = readStoreSource();
  const signatureIndex = source.indexOf(signatureFragment);
  if (signatureIndex === -1) {
    throw new Error(`no se encontro ${signatureFragment}`);
  }
  const openBraceIndex = source.indexOf('{', signatureIndex);
  let depth = 0;
  for (let index = openBraceIndex; index < source.length; index += 1) {
    if (source[index] === '{') {
      depth += 1;
      continue;
    }
    if (source[index] !== '}') {
      continue;
    }
    depth -= 1;
    if (depth === 0) {
      return source.slice(openBraceIndex, index + 1);
    }
  }
  throw new Error('el cuerpo no cierra');
}

describe('B12.2 §2: la limpieza en SQLite', () => {
  const MIGRATED_COLUMN_LIST = [
    ...BLOCK_12_CHALLENGE_COLUMN_LIST,
    'device_id',
    'consumed_at',
    'consumed_token',
  ];

  it('el SELECT acota el trabajo y sólo pide las filas que no autorizan', async () => {
    const { storage, executedStatementList } =
      createRecordingSqlStorage(MIGRATED_COLUMN_LIST);
    const store: EnrollmentStore = createSqliteEnrollmentStore(storage);

    await store.pruneChallenge({ nowMilliseconds: 1_000, limit: 7 });

    const selectStatementList = executedStatementList.filter((statement) =>
      statement.startsWith('SELECT challenge_hash'),
    );
    expect(selectStatementList).toHaveLength(1);
    const selectStatement = selectStatementList[0];
    // Las dos clases que se pueden borrar, y sólo esas.
    expect(selectStatement).toContain('expires_at <= ?');
    expect(selectStatement).toContain("device_id = ''");
    // El techo de trabajo: sin LIMIT, una tabla grande bloquea el DO.
    expect(selectStatement).toContain('LIMIT ?');
    // Y se ordena por deadline, si no la limpieza se queda siempre con la misma
    // mitad de la tabla.
    expect(selectStatement).toContain('ORDER BY expires_at ASC');
  });

  it('el DELETE sólo toca la tabla de desafíos', async () => {
    const { storage, executedStatementList } = createRecordingSqlStorage(
      MIGRATED_COLUMN_LIST,
      [
        { challenge_hash: 'vencido-1' },
        { challenge_hash: 'heredado-2' },
        { challenge_hash: 'vencido-3' },
      ],
    );
    const store: EnrollmentStore = createSqliteEnrollmentStore(storage);

    expect(await store.pruneChallenge({ nowMilliseconds: 1_000, limit: 7 })).toBe(3);

    const deleteStatementList = executedStatementList.filter((statement) =>
      statement.startsWith('DELETE FROM'),
    );
    expect(deleteStatementList.length).toBeGreaterThan(0);
    for (const deleteStatement of deleteStatementList) {
      expect(deleteStatement).toContain('mobile_enrollment_challenge');
      // La fila revocada es la que le cierra `?token=` a un teléfono. Borrarla acá
      // sería desrevocar un equipo sin que nadie lo pidiera.
      expect(deleteStatement).not.toContain('mobile_device_credential');
    }
  });

  it('el cuerpo de la limpieza no menciona la tabla de credenciales', () => {
    // A diferencia del resto de este archivo, acá se lee el fuente porque la
    // afirmación que importa es negativa: no hay ninguna mención que se pueda
    // colar por una ruta que el recorder SQL no vería.
    const body = readStoreFunctionBody('async pruneChallenge(input: {');
    expect(body).not.toContain('CREDENTIAL_TABLE');
    expect(body).not.toContain('deleteCredential');
  });

  it('sin filas que borrar no ejecuta ningún DELETE', async () => {
    const { storage, executedStatementList } =
      createRecordingSqlStorage(MIGRATED_COLUMN_LIST);
    const store: EnrollmentStore = createSqliteEnrollmentStore(storage);

    expect(await store.pruneChallenge({ nowMilliseconds: 1_000, limit: 7 })).toBe(0);
    expect(
      executedStatementList.filter((statement) => statement.startsWith('DELETE FROM')),
    ).toHaveLength(0);
  });
});
