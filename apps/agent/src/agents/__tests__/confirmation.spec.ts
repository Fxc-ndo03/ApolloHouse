import { describe, expect, it } from 'bun:test';
import type { Connection } from 'agents';
import type { Session } from 'agents/experimental/memory/session';

import { executeApolloTurn } from '@/agents/runtime';
import type { ApolloTurnRuntimeDependencies } from '@/agents/runtime';
import type { ApolloState } from '@/agents/apollo';
import {
  createFakeApolloEnvironment,
  createInMemoryPendingConfirmationSqlExecutor,
  createFakeStorageBucket,
  createStubDeskToolEffects,
} from '@/configuration/testing';
import { createDeskUiMachine } from '@/session/machine';
import {
  deletePendingToolConfirmations,
  isPendingConfirmationOrphaned,
  readPendingToolConfirmation,
  savePendingToolConfirmation,
} from '@/tools/pending';
import { closePcAppTool } from '@/tools/pc';
import { buildToolDefinitionMap } from '@/tools/router';
import type { PendingToolConfirmation, ToolDefinition } from '@/tools/types';

// ─────────────────────────────────────────────────────────────────────────────
// Harness del ciclo de confirmación.
//
// Cubre la cadena REAL: executeApolloTurn (la función que Apollo#executeTurn
// invoca) → routeDeterministic → selectRouterToolRequest → authorizeToolExecution
// → savePendingToolConfirmation → confirm_request → runDeskTurn →
// resolvePendingToolConfirmation → executeAuthorizedTool → handler.
//
// Lo único que se dobla es el efecto físico de Windows (PcBridge), que es
// explícitamente el único mock permitido: se conserva la ToolDefinition real
// (safety, buildConfirmSummary, parameters) y se cuenta su handler.
//
// El shell del Durable Object no se puede cargar en bun test: la clase Apollo
// extiende Agent del SDK 'agents', que importa 'cloudflare:email' y
// 'cloudflare:workers', specifiers que solo existen dentro de workerd. Por eso
// el paso '#resolveConfirm' se replica con sus MISMAS funciones reales del
// store (las que usa el DO), no con dobles.
// ─────────────────────────────────────────────────────────────────────────────

type SentMessageRecord = {
  readonly type: string;
  readonly payload: Record<string, unknown>;
};

function createRecordingConnection(): {
  readonly connection: Connection;
  readonly sentMessageRecordList: SentMessageRecord[];
} {
  const sentMessageRecordList: SentMessageRecord[] = [];
  const connection = {
    send(message: string | ArrayBuffer) {
      if (typeof message !== 'string') {
        return;
      }
      const parsedMessage = JSON.parse(message) as { readonly type: string } & Record<
        string,
        unknown
      >;
      sentMessageRecordList.push({ type: parsedMessage.type, payload: parsedMessage });
    },
  } as Connection;
  return { connection, sentMessageRecordList };
}

const baseState = {
  focusEndsAt: null,
  focusStartedAt: null,
  caption: null,
  uiState: 'idle',
  speechMode: 'desk',
  emotion: 'neutral',
  accentColor: '#ffffff',
  responseOutputTarget: 'server',
  pendingConfirmId: null,
  pendingConfirmSummary: null,
} as ApolloState;

function buildFakeSession(): Session {
  return {
    async appendMessage() {},
    async appendContextBlock() {},
    async refreshSystemPrompt() {},
    async freezeSystemPrompt() {
      return 'system prompt de prueba';
    },
    async getRecentHistory() {
      return { messages: [] };
    },
  } as unknown as Session;
}

type Harness = {
  readonly dependencies: ApolloTurnRuntimeDependencies;
  readonly sqlExecutor: ReturnType<typeof createInMemoryPendingConfirmationSqlExecutor>;
  readonly closePcAppCallList: unknown[];
  readonly state: ApolloState;
};

function buildHarness(): Harness {
  const closePcAppCallList: unknown[] = [];
  const sqlExecutor = createInMemoryPendingConfirmationSqlExecutor();
  const state = { ...baseState } as ApolloState;
  const countedClosePcAppTool: ToolDefinition = {
    ...closePcAppTool,
    async handler(args, context) {
      closePcAppCallList.push(args);
      return closePcAppTool.handler(args, context);
    },
  };
  const environment = createFakeApolloEnvironment({ MOCK_VOICE: '1' });
  const dependencies: ApolloTurnRuntimeDependencies = {
    environment,
    sqlExecutor,
    storageBucket: createFakeStorageBucket(),
    uiMachine: createDeskUiMachine(),
    currentState: state,
    getCurrentState: () => state,
    setAgentState: (nextState) => {
      Object.assign(state, nextState);
    },
    // El DO agenda la expiración a los 30 s (#executeTurn).
    scheduleConfirmExpiry: async () => {},
    // Misma dependencia que inyecta el DO: persiste en el store real.
    persistPendingConfirmation: async (confirmation) => {
      await savePendingToolConfirmation(sqlExecutor, confirmation);
    },
    session: buildFakeSession(),
    deviceId: 'desk-confirm',
    effects: createStubDeskToolEffects(),
    loadToolDefinitionMap: async () => buildToolDefinitionMap([countedClosePcAppTool]),
    acquireGeminiToken: async () => {},
  };
  return { dependencies, sqlExecutor, closePcAppCallList, state };
}

type ResolveStep =
  | { readonly kind: 'approved'; readonly pendingConfirmation: PendingToolConfirmation }
  | { readonly kind: 'rejected' }
  | { readonly kind: 'orphaned' };

// Réplica exacta de Apollo#resolveConfirm, usando las funciones reales del
// store que el DO usa: leer la fila, borrarla, y solo entonces ejecutar el
// turno. Si no hay fila, el DO cierra la confirmación huérfana y NO ejecuta.
async function resolveConfirmationLikeDurableObject(input: {
  readonly harness: Harness;
  readonly connection: Connection;
  readonly isApproved: boolean;
  readonly pendingConfirmIdInState: string | null;
  readonly sentMessageRecordList: SentMessageRecord[];
}): Promise<ResolveStep> {
  const pendingConfirmation = await readPendingToolConfirmation(
    input.harness.sqlExecutor,
  );
  if (pendingConfirmation === undefined) {
    if (
      isPendingConfirmationOrphaned({
        restoredConfirmation: pendingConfirmation,
        pendingConfirmIdInState: input.pendingConfirmIdInState,
      })
    ) {
      input.connection.send(
        JSON.stringify({
          type: 'confirm_close',
          id: input.pendingConfirmIdInState,
          reason: 'orphaned',
        }),
      );
    }
    return { kind: 'orphaned' };
  }
  await deletePendingToolConfirmations(input.harness.sqlExecutor);
  input.connection.send(
    JSON.stringify({
      type: 'confirm_close',
      id: pendingConfirmation.id,
      reason: 'resolved',
    }),
  );
  await executeApolloTurn(input.connection, input.harness.dependencies, {
    text: input.isApproved ? 'confirmado' : 'cancelado',
    confirmOk: input.isApproved,
    pendingConfirmation,
    request_id: 'req-confirm',
    client_turn_id: 'turn-confirm',
  });
  return input.isApproved
    ? { kind: 'approved', pendingConfirmation }
    : { kind: 'rejected' };
}

function findMessageRecord(
  sentMessageRecordList: readonly SentMessageRecord[],
  type: string,
): SentMessageRecord | undefined {
  return sentMessageRecordList.find((record) => record.type === type);
}

function listConfirmCloseRecordList(
  sentMessageRecordList: readonly SentMessageRecord[],
): SentMessageRecord[] {
  return sentMessageRecordList.filter((record) => record.type === 'confirm_close');
}

function listMessageTypeList(
  sentMessageRecordList: readonly SentMessageRecord[],
  fromIndex = 0,
): string[] {
  return sentMessageRecordList.slice(fromIndex).map((record) => record.type);
}

async function requestUnsafeConfirmation(): Promise<{
  readonly harness: Harness;
  readonly connection: Connection;
  readonly sentMessageRecordList: SentMessageRecord[];
}> {
  const harness = buildHarness();
  const { connection, sentMessageRecordList } = createRecordingConnection();
  await executeApolloTurn(connection, harness.dependencies, {
    text: 'cerrá chrome',
    request_id: 'req-open',
    client_turn_id: 'turn-open',
  });
  return { harness, connection, sentMessageRecordList };
}

describe('end-to-end confirmation: request half (router → unsafe → pending)', () => {
  it('persists the pending confirmation and emits confirm_request without executing', async () => {
    const { harness, sentMessageRecordList } = await requestUnsafeConfirmation();

    const confirmRequest = findMessageRecord(sentMessageRecordList, 'confirm_request');
    expect(confirmRequest).toBeDefined();

    const storedConfirmation = await readPendingToolConfirmation(harness.sqlExecutor);
    expect(storedConfirmation).toBeDefined();
    if (storedConfirmation === undefined || confirmRequest === undefined) {
      throw new Error('expected a stored confirmation and a confirm_request');
    }

    // El id, la tool y los args que realmente se produjeron coinciden.
    expect(storedConfirmation.id).toBe(String(confirmRequest.payload.id));
    expect(storedConfirmation.toolName).toBe('close_pc_app');
    expect(storedConfirmation.args).toEqual({ appName: 'chrome' });
    expect(storedConfirmation.summary).toBe('Cerrar chrome en la PC');
    expect(storedConfirmation.summary).toBe(String(confirmRequest.payload.summary));

    // expiresAt: ahora + CONFIRM_TIMEOUT (30 s), y el que viaja al device.
    expect(storedConfirmation.expiresAt).toBe(Number(confirmRequest.payload.expiresAt));
    expect(Number(storedConfirmation.expiresAt)).toBeGreaterThan(Date.now());
    expect(Number(storedConfirmation.expiresAt) - Date.now()).toBeLessThanOrEqual(30_000);

    // NO se ejecutó, y el estado del agente muestra la confirmación abierta.
    expect(harness.closePcAppCallList).toEqual([]);
    expect(harness.state.pendingConfirmId).toBe(storedConfirmation.id);
    expect(harness.state.pendingConfirmSummary).toBe('Cerrar chrome en la PC');
  });

  it('plays the chime and ends the turn without a spoken tool result', async () => {
    const { sentMessageRecordList } = await requestUnsafeConfirmation();
    const typeList = sentMessageRecordList.map((record) => record.type);
    expect(typeList).toContain('play_effect');
    expect(typeList).toContain('confirm_request');
    expect(typeList).toContain('turn_end');
    expect(
      findMessageRecord(sentMessageRecordList, 'text_response_chunk')?.payload.text,
    ).toBe('Cerrar chrome en la PC');
  });
});

describe('end-to-end confirmation: 1. approve executes exactly once', () => {
  it('runs the handler once, resolves the row and closes as resolved', async () => {
    const { harness, connection, sentMessageRecordList } =
      await requestUnsafeConfirmation();
    const storedBefore = await readPendingToolConfirmation(harness.sqlExecutor);
    if (storedBefore === undefined) {
      throw new Error('expected a stored confirmation');
    }
    const messageCountBeforeConfirm = sentMessageRecordList.length;

    const step = await resolveConfirmationLikeDurableObject({
      harness,
      connection,
      isApproved: true,
      pendingConfirmIdInState: storedBefore.id,
      sentMessageRecordList,
    });
    expect(step.kind).toBe('approved');

    // Exactamente una ejecución, con los argumentos de la confirmación.
    expect(harness.closePcAppCallList).toEqual([{ appName: 'chrome' }]);

    // La fila se borró antes de ejecutar.
    expect(await readPendingToolConfirmation(harness.sqlExecutor)).toBeUndefined();

    // confirm_close = resolved, con el id correcto.
    const closeRecordList = listConfirmCloseRecordList(sentMessageRecordList);
    expect(closeRecordList).toHaveLength(1);
    expect(closeRecordList[0]?.payload.id).toBe(storedBefore.id);
    expect(closeRecordList[0]?.payload.reason).toBe('resolved');

    // El turno de confirmaciónHabla y cierra; el estado queda en la respuesta.
    const confirmTurnTypeList = listMessageTypeList(
      sentMessageRecordList,
      messageCountBeforeConfirm,
    );
    expect(confirmTurnTypeList).toContain('turn_end');
    expect(confirmTurnTypeList).toContain('tts_start');
    expect(confirmTurnTypeList).not.toContain('confirm_request');
    expect(typeof harness.state.caption).toBe('string');
    expect(harness.state.pendingConfirmId).toBeNull();
  });
});

describe('end-to-end confirmation: 2. reject does not execute', () => {
  it('never runs the handler and reports the cancellation', async () => {
    const { harness, connection, sentMessageRecordList } =
      await requestUnsafeConfirmation();
    const storedBefore = await readPendingToolConfirmation(harness.sqlExecutor);
    if (storedBefore === undefined) {
      throw new Error('expected a stored confirmation');
    }
    const messageCountBeforeConfirm = sentMessageRecordList.length;

    const step = await resolveConfirmationLikeDurableObject({
      harness,
      connection,
      isApproved: false,
      pendingConfirmIdInState: storedBefore.id,
      sentMessageRecordList,
    });
    expect(step.kind).toBe('rejected');
    expect(harness.closePcAppCallList).toEqual([]);
    expect(await readPendingToolConfirmation(harness.sqlExecutor)).toBeUndefined();
    expect(harness.state.caption).toBe('Cancelado.');
    const confirmTurnTypeList = listMessageTypeList(
      sentMessageRecordList,
      messageCountBeforeConfirm,
    );
    expect(confirmTurnTypeList).toContain('turn_end');
    // BLOCK 6.2: la cancelación se habla.
    expect(confirmTurnTypeList).toContain('tts_start');
    expect(confirmTurnTypeList).toContain('tts_end');
  });
});

describe('end-to-end confirmation: 3. expiration does not execute', () => {
  it('an expired row is cancelled instead of running the tool', async () => {
    const harness = buildHarness();
    const { connection, sentMessageRecordList } = createRecordingConnection();
    const expiredConfirmation: PendingToolConfirmation = {
      id: 'confirm-expired',
      toolName: 'close_pc_app',
      args: { appName: 'chrome' },
      summary: 'Cerrar chrome en la PC',
      expiresAt: Date.now() - 1,
    };
    await harness.dependencies.persistPendingConfirmation?.(expiredConfirmation);

    await executeApolloTurn(connection, harness.dependencies, {
      text: 'confirmado',
      confirmOk: true,
      pendingConfirmation: expiredConfirmation,
      request_id: 'req-expired',
      client_turn_id: 'turn-expired',
    });

    expect(harness.closePcAppCallList).toEqual([]);
    expect(harness.state.caption).toBe('La confirmación expiró.');
    const expiredMessageTypeList = sentMessageRecordList.map((record) => record.type);
    expect(expiredMessageTypeList).toContain('turn_end');
    expect(expiredMessageTypeList).toContain('tts_start');
  });
});

describe('end-to-end confirmation: 4. duplicate approve executes zero extra times', () => {
  it('the second answer finds no row and never re-runs the tool', async () => {
    const { harness, connection, sentMessageRecordList } =
      await requestUnsafeConfirmation();
    const storedBefore = await readPendingToolConfirmation(harness.sqlExecutor);
    if (storedBefore === undefined) {
      throw new Error('expected a stored confirmation');
    }

    const firstStep = await resolveConfirmationLikeDurableObject({
      harness,
      connection,
      isApproved: true,
      pendingConfirmIdInState: storedBefore.id,
      sentMessageRecordList,
    });
    expect(firstStep.kind).toBe('approved');
    expect(harness.closePcAppCallList).toHaveLength(1);

    // Doble tap / reintento del device: la fila ya no existe.
    const secondStep = await resolveConfirmationLikeDurableObject({
      harness,
      connection,
      isApproved: true,
      pendingConfirmIdInState: storedBefore.id,
      sentMessageRecordList,
    });
    expect(secondStep.kind).toBe('orphaned');
    expect(harness.closePcAppCallList).toHaveLength(1);

    const closeRecordList = listConfirmCloseRecordList(sentMessageRecordList);
    expect(closeRecordList[closeRecordList.length - 1]?.payload.reason).toBe('orphaned');
  });
});

describe('end-to-end confirmation: 5. orphaned confirmation does not execute', () => {
  it('a confirm answer with nothing pending never reaches a handler', async () => {
    const harness = buildHarness();
    const { connection, sentMessageRecordList } = createRecordingConnection();

    // Sin fila: el DO cierra la confirmación huérfana y no ejecuta el turno.
    const step = await resolveConfirmationLikeDurableObject({
      harness,
      connection,
      isApproved: true,
      pendingConfirmIdInState: 'confirm-ghost',
      sentMessageRecordList,
    });

    expect(step.kind).toBe('orphaned');
    expect(harness.closePcAppCallList).toEqual([]);
    const closeRecordList = listConfirmCloseRecordList(sentMessageRecordList);
    expect(closeRecordList).toHaveLength(1);
    expect(closeRecordList[0]?.payload.reason).toBe('orphaned');
    expect(sentMessageRecordList.map((record) => record.type)).not.toContain('turn_end');
  });

  it('an unreadable row counts as nothing pending', async () => {
    // Mismo camino con una fila corrupta: readPendingToolConfirmation la
    // descarta (zod) y el confirm no puede ejecutar argumentos sin validar.
    const sqlExecutor = createInMemoryPendingConfirmationSqlExecutor();
    const harness = buildHarness();
    const { connection } = createRecordingConnection();
    const step = await resolveConfirmationLikeDurableObject({
      harness: { ...harness, sqlExecutor },
      connection,
      isApproved: true,
      pendingConfirmIdInState: 'confirm-corrupt',
      sentMessageRecordList: [],
    });
    expect(step.kind).toBe('orphaned');
    expect(harness.closePcAppCallList).toEqual([]);
  });
});

describe('end-to-end confirmation: 6. safe deterministic needs no confirmation', () => {
  it('executes a safe tool straight away and stores nothing', async () => {
    const harness = buildHarness();
    const { connection, sentMessageRecordList } = createRecordingConnection();

    await executeApolloTurn(connection, harness.dependencies, {
      text: 'enfocá vscode',
      request_id: 'req-safe',
      client_turn_id: 'turn-safe',
    });

    const typeList = sentMessageRecordList.map((record) => record.type);
    expect(typeList).not.toContain('confirm_request');
    expect(await readPendingToolConfirmation(harness.sqlExecutor)).toBeUndefined();
    expect(harness.state.pendingConfirmId).toBeNull();
  });
});

describe('end-to-end confirmation: 7. unsafe via the approved path runs once', () => {
  it('lock_pc_screen also requires confirmation end to end', async () => {
    const harness = buildHarness();
    const { connection, sentMessageRecordList } = createRecordingConnection();

    await executeApolloTurn(connection, harness.dependencies, {
      text: 'bloqueá la pantalla',
      request_id: 'req-lock',
      client_turn_id: 'turn-lock',
    });

    const storedConfirmation = await readPendingToolConfirmation(harness.sqlExecutor);
    expect(storedConfirmation?.toolName).toBe('lock_pc_screen');
    expect(storedConfirmation?.summary).toBe('Bloquear la pantalla de la PC');
    expect(
      findMessageRecord(sentMessageRecordList, 'confirm_request')?.payload.summary,
    ).toBe('Bloquear la pantalla de la PC');
    expect(String(harness.state.pendingConfirmId)).toBe(String(storedConfirmation?.id));
  });
});
