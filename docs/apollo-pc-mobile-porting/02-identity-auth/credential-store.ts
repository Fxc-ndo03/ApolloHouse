import type {
  ChallengeConsumeOutcome,
  DeviceCredentialRecord,
  EnrollmentChallengeRecord,
  EnrollmentStore,
} from '@/devices/enrollment';

// ─────────────────────────────────────────────────────────────────────────────
// BLOCK 12 §5: el registro de credenciales del MobileBridge, sobre SQLite.
//
// La tabla vive en el DO, así que sobrevive a que el DO se descargue, se reinicie
// o se despliegue código nuevo. Esa es la razón de que la revocación sea real:
// si el estado fuera sólo memoria, revocar sería barra un socket y la próxima
// conexión volvería a pasar.
//
// Se guardan HASHES. `credential_hash` nunca es una credencial utilizable, y la
// fila revocada usa un hash que ningún secreto emitido puede producir, así que
// ni siquiera un dump del DO permite reconectar.
//
// NOTA de migraciones: el DO MobileBridge ya está declarado como
// `new_sqlite_classes` en `wrangler.jsonc` (tag v4), así que `ctx.storage.sql`
// existe sin tocar la config. Las tablas se crean con IF NOT EXISTS en el
// primer uso: es idempotente y no necesita un tag de migración nuevo.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * La superficie mínima de `SqlStorage` que usa este store. Declararla propia
 * (en vez de importar el tipo global) es lo que permite ejercitar el store con
 * un doble en los tests sin workerd.
 */
export type EnrollmentSqlStorage = {
  exec(
    query: string,
    ...bindValues: unknown[]
  ): {
    toArray(): readonly Record<string, unknown>[];
  };
};

const CREDENTIAL_TABLE = 'mobile_device_credential';
const CHALLENGE_TABLE = 'mobile_enrollment_challenge';

// `pruneChallenge` sólo toca CHALLENGE_TABLE. Nunca toca CREDENTIAL_TABLE: una
// fila revocada es la que le cierra `?token=` a ese deviceId, así que borrarla en
// una limpieza sería desrevocar un teléfono sin que nadie lo pidiera.

export function createSqliteEnrollmentStore(
  sqlStorage: EnrollmentSqlStorage,
): EnrollmentStore {
  // La migración corre UNA vez por instancia del store, y el memo es la PROMESA,
  // no un booleano.
  //
  // `ensureSchema` se llama en cada operación. Con un `boolean hasMigrated` corrida
  // con dos requests concurrentes, las dos veían `false`, las dos entraban a la
  // migración y la segunda moría con "duplicate column name" -- un 500 que se
  // veía en un 1 de cada N intentos del smoke. Memoizar la promesa hace que la
  // segunda espere la migración en curso en vez de arrancar otra.
  let migrationPromise: Promise<void> | null = null;

  async function ensureSchema(): Promise<void> {
    if (migrationPromise === null) {
      migrationPromise = addMissingChallengeColumn(sqlStorage);
    }
    await migrationPromise;
    sqlStorage.exec(
      `CREATE TABLE IF NOT EXISTS ${CREDENTIAL_TABLE} (
        device_id TEXT PRIMARY KEY,
        credential_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
    );
    sqlStorage.exec(
      `CREATE TABLE IF NOT EXISTS ${CHALLENGE_TABLE} (
        challenge_hash TEXT PRIMARY KEY,
        issued_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      )`,
    );
  }

  /**
   * BLOCK 12.1: migración aditiva, y no es opcional.
   *
   * `CREATE TABLE IF NOT EXISTS` NO agrega columnas a una tabla que ya existe.
   * Una deployment de BLOCK 12 ya tiene `mobile_enrollment_challenge` con el
   * schema viejo, así que sin esto el primer `saveChallenge` revienta con
   * "table mobile_enrollment_challenge has no column named device_id" -- que es
   * exactamente lo que pasó al correr el primer smoke de este bloque.
   *
   * Por eso se consulta el schema real y se agrega lo que falte. Es idempotente:
   * en una base nueva no hay nada que hacer, y en una vieja agrega tres columnas
   * una sola vez.
   *
   * `device_id` va con DEFAULT '' porque SQLite no permite ADD COLUMN NOT NULL sin
   * default. Las filas viejas quedan con deviceId vacío, y `consumeChallenge` las
   * rechaza: un desafío de BLOCK 12 no tiene vínculo, así que no puede autorizar
   * a nadie. Es lo seguro para un dato que en su momento no ligaba nada.
   */
  async function addMissingChallengeColumn(
    targetSqlStorage: EnrollmentSqlStorage,
  ): Promise<void> {
    const existingColumnNameSet = new Set(
      targetSqlStorage
        .exec(`PRAGMA table_info(${CHALLENGE_TABLE})`)
        .toArray()
        .map((row) => String(row['name'])),
    );
    if (existingColumnNameSet.size === 0) {
      return;
    }
    const migrationList: readonly (readonly [string, string])[] = [
      [
        'device_id',
        `ALTER TABLE ${CHALLENGE_TABLE} ADD COLUMN device_id TEXT NOT NULL DEFAULT ''`,
      ],
      ['consumed_at', `ALTER TABLE ${CHALLENGE_TABLE} ADD COLUMN consumed_at INTEGER`],
      ['consumed_token', `ALTER TABLE ${CHALLENGE_TABLE} ADD COLUMN consumed_token TEXT`],
    ];
    for (const [columnName, alterStatement] of migrationList) {
      if (existingColumnNameSet.has(columnName)) {
        continue;
      }
      targetSqlStorage.exec(alterStatement);
    }
  }

  return {
    async saveChallenge(input): Promise<void> {
      await ensureSchema();
      sqlStorage.exec(
        `INSERT OR REPLACE INTO ${CHALLENGE_TABLE}
          (challenge_hash, device_id, issued_at, expires_at, consumed_at, consumed_token)
          VALUES (?, ?, ?, ?, NULL, NULL)`,
        input.challengeHash,
        input.boundDeviceId,
        input.issuedAtMilliseconds,
        input.expiresAtMilliseconds,
      );
    },

    async readChallenge(
      challengeHash: string,
    ): Promise<EnrollmentChallengeRecord | null> {
      await ensureSchema();
      const rowList = sqlStorage
        .exec(
          `SELECT challenge_hash, device_id, issued_at, expires_at, consumed_at, consumed_token
           FROM ${CHALLENGE_TABLE} WHERE challenge_hash = ?`,
          challengeHash,
        )
        .toArray();
      const row = rowList[0];
      if (row === undefined) {
        return null;
      }
      return readChallengeRow(row);
    },

    /**
     * BLOCK 12.1 §5: el consumo es un compare-and-swap de UNA sola sentencia.
     *
     * El `UPDATE` sólo matchea si el desafío no fue consumido Y el deviceId
     * coincide con el atado. Dos claims concurrentes no pueden ganar los dos: el
     * segundo no matchea porque `consumed_at` ya no es NULL. En BLOCK 12 esto era
     * un `readChallenge` + `deleteChallenge`, con carrera entre los dos awaits:
     * los dos claims leían el mismo desafío válido y los dos pasaban los chequeos
     * antes de que uno lo borrara.
     *
     * La expiración NO va en el WHERE a propósito: si un claim perdedor borrara
     * la fila, el siguiente vería `challenge_unknown` en vez de
     * `challenge_expired`, que es un motivo peor para el teléfono. Se clasifica
     * con una lectura posterior, que es consultiva: el CAS ya decidió.
     */
    async consumeChallenge(input): Promise<ChallengeConsumeOutcome> {
      await ensureSchema();
      sqlStorage.exec(
        `UPDATE ${CHALLENGE_TABLE} SET consumed_at = ?, consumed_token = ?
         WHERE challenge_hash = ? AND consumed_at IS NULL AND device_id = ?`,
        input.nowMilliseconds,
        input.consumedToken,
        input.challengeHash,
        input.deviceId,
      );
      const record = await this.readChallenge(input.challengeHash);
      if (record === null) {
        return { wasConsumed: false, reason: 'challenge_unknown' };
      }
      // Una fila migrada desde BLOCK 12 no tiene deviceId atado: no puede
      // autorizar a nadie, ni siquiera al que la reportes como suyo.
      if (record.boundDeviceId.length === 0) {
        return { wasConsumed: false, reason: 'challenge_unknown' };
      }
      if (record.consumedToken === input.consumedToken) {
        return { wasConsumed: true, boundDeviceId: record.boundDeviceId };
      }
      if (record.consumedAtMilliseconds !== null) {
        return { wasConsumed: false, reason: 'challenge_consumed' };
      }
      if (input.nowMilliseconds >= record.expiresAtMilliseconds) {
        return { wasConsumed: false, reason: 'challenge_expired' };
      }
      // No consumido, vigente, y el UPDATE no matcheó: sólo puede ser que el
      // deviceId no sea el atado.
      return { wasConsumed: false, reason: 'device_id_mismatch' };
    },

    /**
     * BLOCK 12.2 §2: borra sólo lo que ya no puede autorizar a nadie.
     *
     * El `LIMIT` acota el trabajo por llamada: una tabla grande no puede bloquear
     * el DO con un barrido masivo. Se ordenan por deadline para no hacer
     * round-robin: si no, la primera mitad de la tabla se limpia siempre y la
     * segunda nunca.
     */
    async pruneChallenge(input: {
      readonly nowMilliseconds: number;
      readonly limit: number;
    }): Promise<number> {
      await ensureSchema();
      const doomedRowList = sqlStorage
        .exec(
          `SELECT challenge_hash FROM ${CHALLENGE_TABLE}
            WHERE expires_at <= ? OR device_id = ''
            ORDER BY expires_at ASC
            LIMIT ?`,
          input.nowMilliseconds,
          input.limit,
        )
        .toArray();
      for (const row of doomedRowList) {
        sqlStorage.exec(
          `DELETE FROM ${CHALLENGE_TABLE} WHERE challenge_hash = ?`,
          String(row['challenge_hash']),
        );
      }
      return doomedRowList.length;
    },

    async deleteChallenge(challengeHash: string): Promise<boolean> {
      await ensureSchema();
      const existing = await this.readChallenge(challengeHash);
      if (existing === null) {
        return false;
      }
      sqlStorage.exec(
        `DELETE FROM ${CHALLENGE_TABLE} WHERE challenge_hash = ?`,
        challengeHash,
      );
      return true;
    },

    async saveCredential(input): Promise<void> {
      await ensureSchema();
      sqlStorage.exec(
        `INSERT OR REPLACE INTO ${CREDENTIAL_TABLE}
          (device_id, credential_hash, status, updated_at) VALUES (?, ?, ?, ?)`,
        input.deviceId,
        input.credentialHash,
        input.status,
        input.updatedAtMilliseconds,
      );
    },

    async readCredential(deviceId: string): Promise<DeviceCredentialRecord | null> {
      await ensureSchema();
      const rowList = sqlStorage
        .exec(
          `SELECT device_id, credential_hash, status, updated_at FROM ${CREDENTIAL_TABLE} WHERE device_id = ?`,
          deviceId,
        )
        .toArray();
      return readCredentialRowList(rowList);
    },

    async deleteCredential(deviceId: string): Promise<boolean> {
      await ensureSchema();
      const existing = await this.readCredential(deviceId);
      if (existing === null) {
        return false;
      }
      sqlStorage.exec(`DELETE FROM ${CREDENTIAL_TABLE} WHERE device_id = ?`, deviceId);
      return true;
    },

    async listCredentialRecordList(): Promise<DeviceCredentialRecord[]> {
      await ensureSchema();
      const rowList = sqlStorage
        .exec(
          `SELECT device_id, credential_hash, status, updated_at FROM ${CREDENTIAL_TABLE}`,
        )
        .toArray();
      const recordList: DeviceCredentialRecord[] = [];
      for (const row of rowList) {
        const record = readCredentialRowList([row]);
        if (record !== null) {
          recordList.push(record);
        }
      }
      return recordList;
    },
  };
}

function readChallengeRow(row: Record<string, unknown>): EnrollmentChallengeRecord {
  const rawConsumedAt = row['consumed_at'];
  const rawConsumedToken = row['consumed_token'];
  return {
    challengeHash: String(row['challenge_hash']),
    boundDeviceId: String(row['device_id']),
    issuedAtMilliseconds: Number(row['issued_at']),
    expiresAtMilliseconds: Number(row['expires_at']),
    consumedAtMilliseconds: rawConsumedAt === null ? null : Number(rawConsumedAt),
    consumedToken: rawConsumedToken === null ? null : String(rawConsumedToken),
  };
}

function readCredentialRowList(
  rowList: readonly Record<string, unknown>[],
): DeviceCredentialRecord | null {
  const row = rowList[0];
  if (row === undefined) {
    return null;
  }
  return {
    deviceId: String(row['device_id']),
    credentialHash: String(row['credential_hash']),
    status: row['status'] === 'revoked' ? 'revoked' : 'active',
    updatedAtMilliseconds: Number(row['updated_at']),
  };
}

/**
 * Store de memoria, para tests y para ejercitar el núcleo sin Cloudflare. NO se
 * usa en producción: perder el proceso sería perder todas las revocaciones, que
 * es exactamente el bug que §5 prohíbe. El guard de §7 falla si algo de `src/`
 * lo referencia fuera de un `__tests__`.
 */
export function createInMemoryEnrollmentStore(): EnrollmentStore {
  const challengeMap = new Map<string, EnrollmentChallengeRecord>();
  const credentialMap = new Map<string, DeviceCredentialRecord>();
  return {
    async saveChallenge(input): Promise<void> {
      challengeMap.set(input.challengeHash, {
        ...input,
        consumedAtMilliseconds: null,
        consumedToken: null,
      });
    },
    async readChallenge(
      challengeHash: string,
    ): Promise<EnrollmentChallengeRecord | null> {
      return challengeMap.get(challengeHash) ?? null;
    },
    /**
     * El store de memoria comparte el contrato del CAS, porque los tests tienen
     * que ejercitar la misma carrera que el SQLite. Si acá no fuera atómico, un
     * test de concurrencia pasaría en verde y el bug seguiría en producción.
     */
    async consumeChallenge(
      input: Parameters<EnrollmentStore['consumeChallenge']>[0],
    ): Promise<ChallengeConsumeOutcome> {
      const record = challengeMap.get(input.challengeHash);
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
      challengeMap.set(input.challengeHash, {
        ...record,
        consumedAtMilliseconds: input.nowMilliseconds,
        consumedToken: input.consumedToken,
      });
      return { wasConsumed: true, boundDeviceId: record.boundDeviceId };
    },
    /**
     * Mismo contrato que el store de SQLite, para que un test de limpieza no
     * esté probando una lógica distinta de la de producción.
     */
    async pruneChallenge(input: {
      readonly nowMilliseconds: number;
      readonly limit: number;
    }): Promise<number> {
      const doomedHashList: string[] = [];
      for (const [challengeHash, record] of challengeMap) {
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
        challengeMap.delete(challengeHash);
      }
      return doomedHashList.length;
    },
    async deleteChallenge(challengeHash: string): Promise<boolean> {
      return challengeMap.delete(challengeHash);
    },
    async saveCredential(input): Promise<void> {
      credentialMap.set(input.deviceId, { ...input });
    },
    async readCredential(deviceId: string): Promise<DeviceCredentialRecord | null> {
      return credentialMap.get(deviceId) ?? null;
    },
    async deleteCredential(deviceId: string): Promise<boolean> {
      return credentialMap.delete(deviceId);
    },
    async listCredentialRecordList(): Promise<DeviceCredentialRecord[]> {
      return [...credentialMap.values()].map((record) => ({ ...record }));
    },
  };
}
