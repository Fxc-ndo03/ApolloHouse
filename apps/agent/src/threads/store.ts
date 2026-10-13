export type ThreadSqlValue = string | number | null;

export type ThreadSqlExecutor = {
  execute<Row extends Record<string, ThreadSqlValue>>(
    query: string,
    ...bindValues: unknown[]
  ): readonly Row[];
};

export type ThreadKind = 'pending' | 'command' | 'conversation';

export type ThreadMetaRecord = {
  readonly sessionId: string;
  readonly kind: ThreadKind;
  readonly summary: string | null;
  readonly lastTurnAtMilliseconds: number;
};

type ThreadMetaRow = {
  readonly session_id: string;
  readonly kind: string;
  readonly summary: string | null;
  readonly last_turn_at: number;
};

function mapRowToThreadMetaRecord(row: ThreadMetaRow): ThreadMetaRecord {
  return {
    sessionId: row.session_id,
    kind: row.kind === 'command' || row.kind === 'conversation' ? row.kind : 'pending',
    summary: row.summary,
    lastTurnAtMilliseconds: row.last_turn_at,
  };
}

export function recordThreadActivity(
  sqlExecutor: ThreadSqlExecutor,
  sessionId: string,
  nowMilliseconds: number,
  accountId: string,
): void {
  sqlExecutor.execute(
    `INSERT INTO thread_meta (session_id, kind, summary, last_turn_at, account_id)
     VALUES (?, 'pending', NULL, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET last_turn_at = excluded.last_turn_at`,
    sessionId,
    nowMilliseconds,
    accountId,
  );
}

export function markThreadFinalized(
  sqlExecutor: ThreadSqlExecutor,
  input: {
    readonly sessionId: string;
    readonly kind: Exclude<ThreadKind, 'pending'>;
    readonly summary: string | null;
  },
  accountId: string,
): void {
  sqlExecutor.execute(
    `INSERT INTO thread_meta (session_id, kind, summary, last_turn_at, account_id)
     VALUES (?, ?, ?, 0, ?)
     ON CONFLICT(session_id) DO UPDATE SET kind = excluded.kind, summary = excluded.summary`,
    input.sessionId,
    input.kind,
    input.summary,
    accountId,
  );
}

export function getThreadMeta(
  sqlExecutor: ThreadSqlExecutor,
  sessionId: string,
  accountId: string,
): ThreadMetaRecord | undefined {
  const rows = sqlExecutor.execute<ThreadMetaRow>(
    'SELECT session_id, kind, summary, last_turn_at FROM thread_meta WHERE session_id = ? AND (account_id = ? OR account_id IS NULL) LIMIT 1',
    sessionId,
    accountId,
  );
  return rows[0] === undefined ? undefined : mapRowToThreadMetaRecord(rows[0]);
}

export function listThreadMeta(
  sqlExecutor: ThreadSqlExecutor,
  accountId: string,
): readonly ThreadMetaRecord[] {
  const rows = sqlExecutor.execute<ThreadMetaRow>(
    'SELECT session_id, kind, summary, last_turn_at FROM thread_meta WHERE (account_id = ? OR account_id IS NULL) ORDER BY last_turn_at DESC',
    accountId,
  );
  return rows.map(mapRowToThreadMetaRecord);
}

export function reopenThreadMeta(
  sqlExecutor: ThreadSqlExecutor,
  sessionId: string,
  accountId: string,
): void {
  sqlExecutor.execute(
    "UPDATE thread_meta SET kind = 'pending' WHERE session_id = ? AND (account_id = ? OR account_id IS NULL)",
    sessionId,
    accountId,
  );
}

export function listExpiredCommandThreadSessionIds(
  sqlExecutor: ThreadSqlExecutor,
  beforeMilliseconds: number,
  accountId: string,
): readonly string[] {
  const rows = sqlExecutor.execute<{ session_id: string }>(
    "SELECT session_id FROM thread_meta WHERE kind = 'command' AND last_turn_at > 0 AND last_turn_at < ? AND (account_id = ? OR account_id IS NULL)",
    beforeMilliseconds,
    accountId,
  );
  return rows.map((row) => row.session_id);
}

export function deleteThreadMeta(
  sqlExecutor: ThreadSqlExecutor,
  sessionId: string,
  accountId: string,
): void {
  sqlExecutor.execute(
    'DELETE FROM thread_meta WHERE session_id = ? AND (account_id = ? OR account_id IS NULL)',
    sessionId,
    accountId,
  );
}

export function listThreadSessionIdsActiveSince(
  sqlExecutor: ThreadSqlExecutor,
  sinceMilliseconds: number,
  accountId: string,
): readonly string[] {
  const rows = sqlExecutor.execute<{ session_id: string }>(
    'SELECT session_id FROM thread_meta WHERE last_turn_at >= ? AND (account_id = ? OR account_id IS NULL) ORDER BY last_turn_at DESC',
    sinceMilliseconds,
  );
  return rows.map((row) => row.session_id);
}
