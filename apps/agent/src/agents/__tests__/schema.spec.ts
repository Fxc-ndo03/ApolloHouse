import { describe, expect, it } from 'bun:test';

import { Database } from 'bun:sqlite';

import { initializeApolloSchema } from '@/agents/schema';
import type { MemorySqlExecutor, MemorySqlRow } from '@/memory/store';
import { listUsageTotalsWithinWindow, recordUsageEvent } from '@/usage/usage';

const ACCOUNT = 'acc_11111111111111111111111111111111';

function createSqlExecutorFor(database: Database): MemorySqlExecutor {
  return {
    execute<Row extends MemorySqlRow>(query: string, ...bindValues: unknown[]): readonly Row[] {
      return database
        .prepare(query)
        .all(...(bindValues as never[])) as unknown as readonly Row[];
    },
  };
}

function listTableNameList(database: Database): readonly string[] {
  return database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((row) => String((row as { name: string }).name));
}

function listColumnNameList(database: Database, tableName: string): readonly string[] {
  return database
    .prepare(`SELECT name FROM pragma_table_info('${tableName}')`)
    .all()
    .map((row) => String((row as { name: string }).name));
}

describe('initializeApolloSchema', () => {
  it('1. instancia nueva: crea todas las tablas de Apollo junto a las del SDK', () => {
    const database = new Database(':memory:');
    database.run('CREATE TABLE IF NOT EXISTS cf_agents_state (id TEXT PRIMARY KEY, state TEXT)');
    initializeApolloSchema(createSqlExecutorFor(database));

    expect(listTableNameList(database)).toEqual([
      'cf_agents_state',
      'list_items',
      'mcp_tool_settings',
      'memories',
      'pending_confirmations',
      'pending_device_messages',
      'session_prefs',
      'thread_meta',
      'usage_events',
    ]);
  });

  it('2. instancia existente sin usage_events: la crea y conserva sus datos', () => {
    const database = new Database(':memory:');
    database.run(
      'CREATE TABLE IF NOT EXISTS memories (id TEXT PRIMARY KEY, content TEXT NOT NULL, created_at INTEGER NOT NULL)',
    );
    database.run(
      "INSERT INTO memories (id, content, created_at) VALUES ('mem-1', 'recuerdo previo', 1700000000000)",
    );

    expect(listTableNameList(database)).not.toContain('usage_events');
    initializeApolloSchema(createSqlExecutorFor(database));

    expect(listTableNameList(database)).toContain('usage_events');
    const memoryRows = database.prepare('SELECT content FROM memories').all();
    expect(memoryRows).toEqual([{ content: 'recuerdo previo' }]);
  });

  it('3. instancia existente con la tabla: no la modifica ni pierde filas', () => {
    const database = new Database(':memory:');
    database.run(
      'CREATE TABLE IF NOT EXISTS usage_events (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, tokens INTEGER NOT NULL, requests INTEGER NOT NULL, voice_seconds INTEGER NOT NULL, created_at INTEGER NOT NULL)',
    );
    database.run(
      "INSERT INTO usage_events (id, account_id, tokens, requests, voice_seconds, created_at) VALUES ('u-1', 'acc_viejo', 7, 1, 0, 1700000000000)",
    );

    initializeApolloSchema(createSqlExecutorFor(database));

    const rows = database.prepare('SELECT id, tokens FROM usage_events').all();
    expect(rows).toEqual([{ id: 'u-1', tokens: 7 }]);
  });

  it('4. inicialización repetida: idempotente, sin errores ni cambios', () => {
    const database = new Database(':memory:');
    const sqlExecutor = createSqlExecutorFor(database);

    initializeApolloSchema(sqlExecutor);
    const firstRunColumnList = listColumnNameList(database, 'thread_meta');
    initializeApolloSchema(sqlExecutor);
    initializeApolloSchema(sqlExecutor);

    expect(listColumnNameList(database, 'thread_meta')).toEqual(firstRunColumnList);
    expect(listTableNameList(database)).toContain('usage_events');
  });

  it('5. operación de usage inmediatamente después de inicializar', () => {
    const database = new Database(':memory:');
    const sqlExecutor = createSqlExecutorFor(database);
    initializeApolloSchema(sqlExecutor);

    const now = Date.UTC(2026, 9, 13, 12, 0, 0);
    recordUsageEvent(sqlExecutor, {
      accountId: ACCOUNT,
      tokens: 0,
      requests: 1,
      voiceSeconds: 0,
      atMilliseconds: now,
    });

    expect(listUsageTotalsWithinWindow(sqlExecutor, ACCOUNT, now - 60_000, now)).toEqual({
      tokens: 0,
      requests: 1,
      voiceSeconds: 0,
    });
  });

  it('6. fallo de inicialización: error explícito, nunca lectura vacía', () => {
    const database = new Database(':memory:');
    const failingExecutor: MemorySqlExecutor = {
      execute<Row extends MemorySqlRow>(query: string, ...bindValues: unknown[]): readonly Row[] {
        if (query.includes('usage_events')) {
          throw new Error('SQLITE_ERROR: no such table: usage_events');
        }
        return createSqlExecutorFor(database).execute<Row>(query, ...bindValues);
      },
    };

    expect(() => initializeApolloSchema(failingExecutor)).toThrow('usage_events');
  });

  it('las columnas account_id quedan en tablas nuevas y en instancias viejas', () => {
    const database = new Database(':memory:');
    database.run(
      'CREATE TABLE IF NOT EXISTS thread_meta (session_id TEXT PRIMARY KEY, kind TEXT NOT NULL, summary TEXT, last_turn_at INTEGER NOT NULL)',
    );
    database.run(
      'CREATE TABLE IF NOT EXISTS memories (id TEXT PRIMARY KEY, content TEXT NOT NULL, created_at INTEGER NOT NULL)',
    );
    initializeApolloSchema(createSqlExecutorFor(database));

    expect(listColumnNameList(database, 'thread_meta')).toContain('account_id');
    expect(listColumnNameList(database, 'memories')).toContain('account_id');
    const indexNameList = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name")
      .all()
      .map((row) => String((row as { name: string }).name));
    expect(indexNameList).toContain('memories_account_idx');
    expect(indexNameList).toContain('thread_meta_account_idx');
  });
});