import { isValidAccountId, requireAccountId, requireDeviceId } from '@/accounts/identity';

export type AccountTier = 'free' | 'paid' | 'admin';

export type AccountRecord = {
  readonly accountId: string;
  readonly emailHash: string;
  readonly passwordHash: string;
  readonly tier: AccountTier;
  readonly createdAtMilliseconds: number;
};

export type SessionRecord = {
  readonly tokenHash: string;
  readonly accountId: string;
  readonly createdAtMilliseconds: number;
  readonly expiresAtMilliseconds: number;
  readonly revokedAtMilliseconds: number | null;
  readonly lastSeenAtMilliseconds: number;
};

export type DeviceRecord = {
  readonly deviceId: string;
  readonly accountId: string;
  readonly deviceType: string;
  readonly deviceName: string;
  readonly createdAtMilliseconds: number;
  readonly lastSeenAtMilliseconds: number;
  readonly revokedAtMilliseconds: number | null;
};

export type ResolvedSession = {
  readonly sessionId: string;
  readonly accountId: string;
};

const ACCOUNTS_TABLE = 'auth_accounts';
const SESSIONS_TABLE = 'auth_sessions';
const DEVICES_TABLE = 'auth_devices';

export const ACCOUNT_REGISTRY_SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS ${ACCOUNTS_TABLE} (
    account_id TEXT PRIMARY KEY,
    email_hash TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    tier TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS ${SESSIONS_TABLE} (
    token_hash TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    revoked_at INTEGER,
    last_seen_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS auth_sessions_account
    ON ${SESSIONS_TABLE} (account_id, expires_at)`,
  `CREATE TABLE IF NOT EXISTS ${DEVICES_TABLE} (
    device_id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    device_type TEXT NOT NULL,
    device_name TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    revoked_at INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS auth_devices_account
    ON ${DEVICES_TABLE} (account_id, revoked_at)`,
];

export type CreateAccountOutcome =
  | { readonly status: 'created'; readonly account: AccountRecord }
  | { readonly status: 'email_taken' };

export type EnrollDeviceOutcome =
  | { readonly status: 'enrolled'; readonly device: DeviceRecord }
  | { readonly status: 'device_rebound'; readonly device: DeviceRecord };

export type ResolvedDevice = {
  readonly accountId: string;
  readonly isRevoked: boolean;
  readonly deviceType: string;
};

export type AccountRegistryStore = {
  ensureSchema(): void;
  createAccount(input: {
    accountId: string;
    emailHash: string;
    passwordHash: string;
    tier: AccountTier;
    atMilliseconds: number;
  }): CreateAccountOutcome;
  findAccountIdByEmailHash(emailHash: string): string | null;
  readAccount(accountId: string): AccountRecord | null;
  createSession(input: {
    tokenHash: string;
    accountId: string;
    atMilliseconds: number;
    expiresAtMilliseconds: number;
  }): SessionRecord;
  resolveSessionByTokenHash(
    tokenHash: string,
    atMilliseconds: number,
  ): ResolvedSession | null;
  revokeSessionByTokenHash(tokenHash: string, atMilliseconds: number): boolean;
  revokeAllAccountSessions(accountId: string, atMilliseconds: number): number;
  enrollDevice(input: {
    deviceId: string;
    accountId: string;
    deviceType: string;
    deviceName: string;
    atMilliseconds: number;
  }): EnrollDeviceOutcome;
  resolveDevice(deviceId: string): ResolvedDevice | null;
  markDeviceSeen(deviceId: string, atMilliseconds: number): void;
  listDevices(accountId: string): readonly DeviceRecord[];
  revokeDevice(accountId: string, deviceId: string, atMilliseconds: number): boolean;
  revokeAllAccountDevices(accountId: string, atMilliseconds: number): number;
  deleteAccount(accountId: string, atMilliseconds: number): boolean;
};

export type RegistryRow = Record<string, string | number | boolean | null>;

export function createAccountRegistryStore(sql: {
  exec(query: string, ...bindValues: unknown[]): RegistryRow[];
}): AccountRegistryStore {
  function ensureSchema(): void {
    for (const statement of ACCOUNT_REGISTRY_SCHEMA_STATEMENTS) {
      sql.exec(statement);
    }
  }

  function rowToAccount(row: RegistryRow): AccountRecord {
    return {
      accountId: String(row['account_id']),
      emailHash: String(row['email_hash']),
      passwordHash: String(row['password_hash']),
      tier: String(row['tier']) as AccountTier,
      createdAtMilliseconds: Number(row['created_at']),
    };
  }

  function rowToSession(row: RegistryRow): SessionRecord {
    return {
      tokenHash: String(row['token_hash']),
      accountId: String(row['account_id']),
      createdAtMilliseconds: Number(row['created_at']),
      expiresAtMilliseconds: Number(row['expires_at']),
      revokedAtMilliseconds:
        row['revoked_at'] === null || row['revoked_at'] === undefined
          ? null
          : Number(row['revoked_at']),
      lastSeenAtMilliseconds: Number(row['last_seen_at']),
    };
  }

  function rowToDevice(row: RegistryRow): DeviceRecord {
    return {
      deviceId: String(row['device_id']),
      accountId: String(row['account_id']),
      deviceType: String(row['device_type']),
      deviceName: String(row['device_name']),
      createdAtMilliseconds: Number(row['created_at']),
      lastSeenAtMilliseconds: Number(row['last_seen_at']),
      revokedAtMilliseconds:
        row['revoked_at'] === null || row['revoked_at'] === undefined
          ? null
          : Number(row['revoked_at']),
    };
  }

  return {
    ensureSchema,

    createAccount(input) {
      const accountId = requireAccountId(input.accountId);
      try {
        sql.exec(
          `INSERT INTO ${ACCOUNTS_TABLE}
             (account_id, email_hash, password_hash, tier, created_at)
           VALUES (?, ?, ?, ?, ?)`,
          accountId,
          input.emailHash,
          input.passwordHash,
          input.tier,
          input.atMilliseconds,
        );
      } catch {
        return { status: 'email_taken' };
      }
      return {
        status: 'created',
        account: {
          accountId,
          emailHash: input.emailHash,
          passwordHash: input.passwordHash,
          tier: input.tier,
          createdAtMilliseconds: input.atMilliseconds,
        },
      };
    },

    findAccountIdByEmailHash(emailHash) {
      const rows = sql.exec(
        `SELECT account_id FROM ${ACCOUNTS_TABLE} WHERE email_hash = ?`,
        emailHash,
      );
      return rows.length > 0 ? String(rows[0]['account_id']) : null;
    },

    readAccount(accountId) {
      const rows = sql.exec(
        `SELECT * FROM ${ACCOUNTS_TABLE} WHERE account_id = ?`,
        requireAccountId(accountId),
      );
      return rows.length > 0 ? rowToAccount(rows[0]) : null;
    },

    createSession(input) {
      sql.exec(
        `INSERT INTO ${SESSIONS_TABLE}
           (token_hash, account_id, created_at, expires_at, revoked_at, last_seen_at)
         VALUES (?, ?, ?, ?, NULL, ?)`,
        input.tokenHash,
        requireAccountId(input.accountId),
        input.atMilliseconds,
        input.expiresAtMilliseconds,
        input.atMilliseconds,
      );
      return {
        tokenHash: input.tokenHash,
        accountId: input.accountId,
        createdAtMilliseconds: input.atMilliseconds,
        expiresAtMilliseconds: input.expiresAtMilliseconds,
        revokedAtMilliseconds: null,
        lastSeenAtMilliseconds: input.atMilliseconds,
      };
    },

    resolveSessionByTokenHash(tokenHash, atMilliseconds) {
      const rows = sql.exec(
        `SELECT * FROM ${SESSIONS_TABLE} WHERE token_hash = ?`,
        tokenHash,
      );
      if (rows.length === 0) {
        return null;
      }
      const session = rowToSession(rows[0]);
      if (session.revokedAtMilliseconds !== null) {
        return null;
      }
      if (atMilliseconds >= session.expiresAtMilliseconds) {
        return null;
      }
      sql.exec(
        `UPDATE ${SESSIONS_TABLE} SET last_seen_at = ? WHERE token_hash = ?`,
        atMilliseconds,
        tokenHash,
      );
      return { sessionId: session.tokenHash.slice(0, 16), accountId: session.accountId };
    },

    revokeSessionByTokenHash(tokenHash, atMilliseconds) {
      const rows = sql.exec(
        `SELECT token_hash FROM ${SESSIONS_TABLE}
         WHERE token_hash = ? AND revoked_at IS NULL`,
        tokenHash,
      );
      if (rows.length === 0) {
        return false;
      }
      sql.exec(
        `UPDATE ${SESSIONS_TABLE} SET revoked_at = ? WHERE token_hash = ?`,
        atMilliseconds,
        tokenHash,
      );
      return true;
    },

    revokeAllAccountSessions(accountId, atMilliseconds) {
      const rows = sql.exec(
        `SELECT token_hash FROM ${SESSIONS_TABLE}
         WHERE account_id = ? AND revoked_at IS NULL AND expires_at > ?`,
        requireAccountId(accountId),
        atMilliseconds,
      );
      sql.exec(
        `UPDATE ${SESSIONS_TABLE} SET revoked_at = ?
         WHERE account_id = ? AND revoked_at IS NULL`,
        atMilliseconds,
        requireAccountId(accountId),
      );
      return rows.length;
    },

    enrollDevice(input) {
      const deviceId = requireDeviceId(input.deviceId);
      const accountId = requireAccountId(input.accountId);
      const existingRows = sql.exec(
        `SELECT * FROM ${DEVICES_TABLE} WHERE device_id = ?`,
        deviceId,
      );
      if (existingRows.length > 0) {
        const existing = rowToDevice(existingRows[0]);
        if (existing.accountId === accountId && existing.revokedAtMilliseconds === null) {
          return { status: 'enrolled', device: existing };
        }
        if (existing.accountId !== accountId) {
          return { status: 'device_rebound', device: existing };
        }
      }
      sql.exec(
        `INSERT INTO ${DEVICES_TABLE}
           (device_id, account_id, device_type, device_name, created_at, last_seen_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL)
         ON CONFLICT(device_id) DO UPDATE SET
           account_id = excluded.account_id,
           device_type = excluded.device_type,
           device_name = excluded.device_name,
           revoked_at = NULL`,
        deviceId,
        accountId,
        input.deviceType,
        input.deviceName,
        input.atMilliseconds,
        input.atMilliseconds,
      );
      const rows = sql.exec(`SELECT * FROM ${DEVICES_TABLE} WHERE device_id = ?`, deviceId);
      return { status: 'enrolled', device: rowToDevice(rows[0]) };
    },

    resolveDevice(deviceId) {
      const rows = sql.exec(
        `SELECT * FROM ${DEVICES_TABLE} WHERE device_id = ?`,
        requireDeviceId(deviceId),
      );
      if (rows.length === 0) {
        return null;
      }
      const device = rowToDevice(rows[0]);
      return {
        accountId: device.accountId,
        isRevoked: device.revokedAtMilliseconds !== null,
        deviceType: device.deviceType,
      };
    },

    markDeviceSeen(deviceId, atMilliseconds) {
      sql.exec(
        `UPDATE ${DEVICES_TABLE} SET last_seen_at = ? WHERE device_id = ?`,
        atMilliseconds,
        requireDeviceId(deviceId),
      );
    },

    listDevices(accountId) {
      return sql
        .exec(
          `SELECT * FROM ${DEVICES_TABLE} WHERE account_id = ? ORDER BY created_at`,
          requireAccountId(accountId),
        )
        .map(rowToDevice);
    },

    revokeDevice(accountId, deviceId, atMilliseconds) {
      const resolved = this.resolveDevice(deviceId);
      if (resolved === null || resolved.accountId !== requireAccountId(accountId)) {
        return false;
      }
      // Revoking a device binding must NOT touch account sessions: losing the
      // PC must not log the phone (or the browser) out of the account.
      sql.exec(
        `UPDATE ${DEVICES_TABLE} SET revoked_at = ?
         WHERE device_id = ? AND revoked_at IS NULL`,
        atMilliseconds,
        requireDeviceId(deviceId),
      );
      return true;
    },

    revokeAllAccountDevices(accountId, atMilliseconds) {
      const rows = sql.exec(
        `SELECT device_id FROM ${DEVICES_TABLE}
         WHERE account_id = ? AND revoked_at IS NULL`,
        requireAccountId(accountId),
      );
      sql.exec(
        `UPDATE ${DEVICES_TABLE} SET revoked_at = ?
         WHERE account_id = ? AND revoked_at IS NULL`,
        atMilliseconds,
        requireAccountId(accountId),
      );
      return rows.length;
    },

    deleteAccount(accountId, atMilliseconds) {
      const accountIdValidated = requireAccountId(accountId);
      const existing = sql.exec(
        `SELECT account_id FROM ${ACCOUNTS_TABLE} WHERE account_id = ?`,
        accountIdValidated,
      );
      if (existing.length === 0) {
        return false;
      }
      this.revokeAllAccountSessions(accountIdValidated, atMilliseconds);
      this.revokeAllAccountDevices(accountIdValidated, atMilliseconds);
      sql.exec(`DELETE FROM ${ACCOUNTS_TABLE} WHERE account_id = ?`, accountIdValidated);
      return true;
    },
  } satisfies AccountRegistryStore;
}

export { isValidAccountId };
