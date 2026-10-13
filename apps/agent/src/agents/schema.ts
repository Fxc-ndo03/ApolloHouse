/**
 * FASE 2.8 — esquema SQLite de Apollo, guarantee de inicialización.
 *
 * Contexto (medido en `apollo-staging`, ver informe FASE 2.8): el hook
 * `onStart()` de la clase `Apollo` **no lo invoca el SDK `agents` instalado**
 * (sólo lo reescribe; no hay call-site en `node_modules/agents/dist/index.js`).
 * Todo el DDL vivía ahí, así que las tablas de Apollo nunca se creaban: las
 * instancias sólo tenían las del SDK (`cf_agents_*`). Por eso
 * `debugListUsageEvents` fallaba con `500 no such table: usage_events`.
 *
 * La inicialización pasa a ser un embudo síncrono idempotente que corre en el
 * primer acceso al almacenamiento de la instancia en curso, no en un hook de
 * ciclo de vida del SDK.
 */

import type { MemorySqlExecutor } from '@/memory/store';

import { createUsageTableStatement } from '@/usage/usage';

/**
 * Tablas base, en orden de dependencia. Todas `IF NOT EXISTS`: correrlas sobre
 * una instancia ya inicializada no las toca ni destruye datos.
 */
export const APOLLO_SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    account_id TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS session_prefs (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS pending_device_messages (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS list_items (
    id TEXT PRIMARY KEY,
    list_name TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  // La ventana de confirmación queda ociosa por naturaleza, así que el agente
  // hiberna a mitad de la espera y pierde la copia en memoria.
  `CREATE TABLE IF NOT EXISTS pending_confirmations (
    id TEXT PRIMARY KEY,
    tool_name TEXT NOT NULL,
    args_json TEXT NOT NULL,
    summary TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    target_device_id TEXT,
    target_device_type TEXT
  )`,
  // El SDK es dueño de las filas de servidor en cf_agents_mcp_servers; cuáles de
  // sus herramientas Apollo puede llamar es asunto nuestro.
  `CREATE TABLE IF NOT EXISTS mcp_tool_settings (
    namespaced_name TEXT PRIMARY KEY,
    server_id TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    is_enabled INTEGER NOT NULL,
    safety TEXT NOT NULL
  )`,
  // La clasificación de hilos vive fuera de las tablas de sesión del SDK para no
  // tocar su esquema.
  `CREATE TABLE IF NOT EXISTS thread_meta (
    session_id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    summary TEXT,
    last_turn_at INTEGER NOT NULL,
    account_id TEXT
  )`,
  createUsageTableStatement,
];

/**
 * Migraciones aditivas para instancias creadas antes de que existieran las
 * columnas. Son idempotentes por error (columna/índice duplicado), que es la
 * única razón por la que acá se toleran errores: son `ALTER`/`CREATE INDEX`, no
 * creación de tablas, así que un fallo no puede devolver una lectura vacía.
 */
export const APOLLO_ADDITIVE_MIGRATION_STATEMENTS: readonly string[] = [
  'ALTER TABLE pending_confirmations ADD COLUMN target_device_id TEXT',
  'ALTER TABLE pending_confirmations ADD COLUMN target_device_type TEXT',
  'ALTER TABLE memories ADD COLUMN account_id TEXT',
  'ALTER TABLE thread_meta ADD COLUMN account_id TEXT',
  'CREATE INDEX IF NOT EXISTS memories_account_idx ON memories (account_id, created_at)',
  'CREATE INDEX IF NOT EXISTS thread_meta_account_idx ON thread_meta (account_id, last_turn_at)',
];

const IDEMPOTENT_MIGRATION_ERROR_PATTERN =
  /duplicate column name|already exists|no such index/i;

/**
 * Inicializa (o verifica) el esquema de Apollo. Sintáctica síncrona a propósito:
 * el DO es mono-hilo, así que sin `await` en el medio dos inicializaciones
 * concurrentes no pueden intercalarse ni dejar la instancia a medio crear.
 *
 * Un fallo al crear una tabla se propaga: prefiero un error explícito a una
 * lectura vacía que aparente que la cuenta no gastó nada.
 */
export function initializeApolloSchema(sqlExecutor: MemorySqlExecutor): void {
  for (const createTableStatement of APOLLO_SCHEMA_STATEMENTS) {
    sqlExecutor.execute(createTableStatement);
  }
  for (const migrationStatement of APOLLO_ADDITIVE_MIGRATION_STATEMENTS) {
    try {
      sqlExecutor.execute(migrationStatement);
    } catch (error) {
      if (!isIdempotentMigrationError(error)) {
        throw error;
      }
    }
  }
}

function isIdempotentMigrationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return IDEMPOTENT_MIGRATION_ERROR_PATTERN.test(message);
}

/** Nombre de tabla usada por las consultas de usage, para los tests. */
export const APOLLO_USAGE_TABLE_NAME = 'usage_events';