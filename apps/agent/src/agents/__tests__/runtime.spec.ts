import { describe, expect, it } from 'bun:test';
import type { Connection } from 'agents';
import type { Session } from 'agents/experimental/memory/session';

import { executeApolloTurn } from '@/agents/runtime';
import type { ApolloTurnRuntimeDependencies } from '@/agents/runtime';
import type { ApolloState } from '@/agents/apollo';
import {
  createFakeApolloEnvironment,
  createFakeStorageBucket,
  createStubDeskToolEffects,
} from '@/configuration/testing';
import type { MemorySqlExecutor } from '@/memory/store';
import { createDeskUiMachine } from '@/session/machine';
import { buildToolDefinitionMap } from '@/tools/router';
import type { ToolDefinition } from '@/tools/types';

type SentMessageRecord = {
  readonly type: string;
  readonly payload: Record<string, unknown>;
};

// El fast path resuelve SIEMPRE contra el catálogo builtin real: son las únicas
// tools que el router determinista puede pedir (ver tools/__tests__/pipeline.spec.ts).
// Por eso estos tests no inyectan tools falsas, sino que observan los efectos.

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

function buildNoopSqlExecutor(): MemorySqlExecutor {
  return { execute: () => [] } as unknown as MemorySqlExecutor;
}

function buildDependencies(input: {
  readonly persistMemoryCallList?: string[];
  readonly persistedConfirmationToolNameList?: string[];
  readonly scheduledExpiryIdList?: string[];
  readonly loadToolDefinitionMap?: () => Promise<ReadonlyMap<string, ToolDefinition>>;
}): ApolloTurnRuntimeDependencies {
  const state = { ...baseState };
  const persistMemoryCallList = input.persistMemoryCallList;
  const effects =
    persistMemoryCallList === undefined
      ? createStubDeskToolEffects()
      : createStubDeskToolEffects({
          persistMemory: async (content: string) => {
            persistMemoryCallList.push(content);
            return { memoryId: 'memory-1', content };
          },
        });
  return {
    environment: createFakeApolloEnvironment(),
    sqlExecutor: buildNoopSqlExecutor(),
    storageBucket: createFakeStorageBucket(),
    uiMachine: createDeskUiMachine(),
    currentState: state,
    getCurrentState: () => state,
    setAgentState: (nextState) => {
      Object.assign(state, nextState);
    },
    scheduleConfirmExpiry: async (confirmationId) => {
      input.scheduledExpiryIdList?.push(confirmationId);
    },
    persistPendingConfirmation: async (confirmation) => {
      input.persistedConfirmationToolNameList?.push(confirmation.toolName);
    },
    session: buildFakeSession(),
    deviceId: 'desk-test',
    accountId: 'acc_0000000000000000000000000000abc2',
    effects,
    ...(input.loadToolDefinitionMap === undefined
      ? {}
      : { loadToolDefinitionMap: input.loadToolDefinitionMap }),
    acquireGeminiToken: async () => {},
  };
}

function findMessageRecord(
  sentMessageRecordList: readonly SentMessageRecord[],
  type: string,
): SentMessageRecord | undefined {
  return sentMessageRecordList.find((record) => record.type === type);
}

function listMessageTypeList(
  sentMessageRecordList: readonly SentMessageRecord[],
): string[] {
  return sentMessageRecordList.map((record) => record.type);
}

describe('pipeline SAFE: user → router → safe tool → execute → response', () => {
  it('executes a safe deterministic tool without asking anything', async () => {
    const persistMemoryCallList: string[] = [];
    const { connection, sentMessageRecordList } = createRecordingConnection();
    const dependencies = buildDependencies({ persistMemoryCallList });

    await executeApolloTurn(connection, dependencies, {
      text: 'recordá que mi cumple es en mayo',
      request_id: 'req-safe',
      client_turn_id: 'turn-safe',
      generation: 7,
    });

    expect(persistMemoryCallList).toEqual(['mi cumple es en mayo']);
    expect(listMessageTypeList(sentMessageRecordList)).not.toContain('confirm_request');
    expect(listMessageTypeList(sentMessageRecordList)).toContain('turn_end');
    expect(
      findMessageRecord(sentMessageRecordList, 'text_response_chunk')?.payload.text,
    ).toBe('Anotado: mi cumple es en mayo.');
  });

  it('keeps answering a safe pc command without a confirmation', async () => {
    const { connection, sentMessageRecordList } = createRecordingConnection();
    const dependencies = buildDependencies({});

    await executeApolloTurn(connection, dependencies, {
      text: 'enfocá vscode',
      request_id: 'req-safe-pc',
      client_turn_id: 'turn-safe-pc',
    });

    expect(listMessageTypeList(sentMessageRecordList)).not.toContain('confirm_request');
    expect(listMessageTypeList(sentMessageRecordList)).toContain('turn_end');
  });

  it('answers time without touching a tool at all', async () => {
    const { connection, sentMessageRecordList } = createRecordingConnection();
    const dependencies = buildDependencies({});

    await executeApolloTurn(connection, dependencies, {
      text: 'qué hora es',
      request_id: 'req-time',
      client_turn_id: 'turn-time',
    });

    expect(listMessageTypeList(sentMessageRecordList)).not.toContain('confirm_request');
    const spokenText = findMessageRecord(sentMessageRecordList, 'text_response_chunk')
      ?.payload.text;
    expect(typeof spokenText).toBe('string');
    expect(String(spokenText)).toStartWith('Son las ');
  });
});

describe('pipeline UNSAFE: user → router → unsafe tool → confirmation', () => {
  it('asks instead of executing, and persists the confirmation first', async () => {
    const persistMemoryCallList: string[] = [];
    const persistedConfirmationToolNameList: string[] = [];
    const scheduledExpiryIdList: string[] = [];
    const { connection, sentMessageRecordList } = createRecordingConnection();
    const dependencies = buildDependencies({
      persistMemoryCallList,
      persistedConfirmationToolNameList,
      scheduledExpiryIdList,
    });

    await executeApolloTurn(connection, dependencies, {
      text: 'cerrá chrome',
      request_id: 'req-unsafe',
      client_turn_id: 'turn-unsafe',
    });

    expect(persistedConfirmationToolNameList).toEqual(['close_pc_app']);
    expect(scheduledExpiryIdList).toHaveLength(1);
    const confirmRequest = findMessageRecord(sentMessageRecordList, 'confirm_request');
    expect(confirmRequest?.payload.summary).toBe('Cerrar chrome en la PC');
    expect(typeof confirmRequest?.payload.id).toBe('string');
    expect(Number(confirmRequest?.payload.expiresAt)).toBeGreaterThan(Date.now());
    // The tool did NOT run: the pc bridge was never called (no device effect)
    // and the spoken text is the confirmation summary, not a tool result.
    expect(
      findMessageRecord(sentMessageRecordList, 'text_response_chunk')?.payload.text,
    ).toBe('Cerrar chrome en la PC');
    expect(listMessageTypeList(sentMessageRecordList)).toContain('turn_end');
  });

  it('gates lock_pc_screen the same way', async () => {
    const persistedConfirmationToolNameList: string[] = [];
    const { connection, sentMessageRecordList } = createRecordingConnection();
    const dependencies = buildDependencies({ persistedConfirmationToolNameList });

    await executeApolloTurn(connection, dependencies, {
      text: 'bloqueá la pantalla',
      request_id: 'req-lock',
      client_turn_id: 'turn-lock',
    });

    expect(persistedConfirmationToolNameList).toEqual(['lock_pc_screen']);
    expect(
      findMessageRecord(sentMessageRecordList, 'confirm_request')?.payload.summary,
    ).toBe('Bloquear la pantalla de la PC');
  });
});

describe('pipeline order: context is built only when the turn needs it', () => {
  it('deterministic turn never loads the mcp tool catalog', async () => {
    const { connection } = createRecordingConnection();
    let loadToolDefinitionMapCallCount = 0;
    const dependencies = buildDependencies({
      loadToolDefinitionMap: async () => {
        loadToolDefinitionMapCallCount += 1;
        return buildToolDefinitionMap([]);
      },
    });

    await executeApolloTurn(connection, dependencies, {
      text: 'enfocá vscode',
      request_id: 'req-fast',
      client_turn_id: 'turn-fast',
    });

    // The loader is MCP discovery + tool settings: pure waste for a turn that a
    // regex just resolved.
    expect(loadToolDefinitionMapCallCount).toBe(0);
  });

  it('llm turn loads the catalog before anything else', async () => {
    const { connection } = createRecordingConnection();
    const catalogLoaded = new Error('catalog-loaded');
    let loadToolDefinitionMapCallCount = 0;
    const dependencies = buildDependencies({
      loadToolDefinitionMap: async () => {
        loadToolDefinitionMapCallCount += 1;
        throw catalogLoaded;
      },
    });

    // The sentinel proves the ordering without standing up the whole llm turn.
    await expect(
      executeApolloTurn(connection, dependencies, {
        text: 'contame un chiste corto',
        request_id: 'req-llm',
        client_turn_id: 'turn-llm',
      }),
    ).rejects.toBe(catalogLoaded);
    expect(loadToolDefinitionMapCallCount).toBe(1);
  });
});
