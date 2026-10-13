import { describe, expect, it } from 'bun:test';
import type { Connection } from 'agents';
import type { Session } from 'agents/experimental/memory/session';

import { executeApolloTurn } from '@/agents/runtime';
import type { ApolloTurnRuntimeDependencies } from '@/agents/runtime';
import type { ApolloState } from '@/agents/apollo';
import {
  createFakeApolloEnvironment,
  createFakeStorageBucket,
  createInMemoryPendingConfirmationSqlExecutor,
  createStubDeskToolEffects,
} from '@/configuration/testing';
import { createDeskUiMachine } from '@/session/machine';
import { buildRegistryCapabilityTargetResolver } from '@/devices/target';
import { buildAuthenticatedDeviceProof, CapabilityRegistry } from '@/devices/registry';
import { PRESENCE_OFFLINE_AFTER_MILLISECONDS } from '@/devices/presence';
import type { TargetPreference } from '@/devices/schema';
import type { CapabilityName } from '@/devices/capability';
import {
  deletePendingToolConfirmations,
  readPendingToolConfirmation,
  savePendingToolConfirmation,
} from '@/tools/pending';
import {
  closePcAppTool,
  lockPcScreenTool,
  openPcAppTool,
  focusPcAppTool,
} from '@/tools/pc';
import { buildToolDefinitionMap } from '@/tools/router';
import type { ToolDefinition } from '@/tools/types';

// Harness del camino completo: intent → router → REGISTRY → authorization →
// execution. El registry es real; lo único que se dobla es el efecto físico de
// Windows (el handler de la tool), igual que en el harness de Block 4.1.

type SentMessageRecord = {
  readonly type: string;
  readonly payload: Record<string, unknown>;
};

const proof = buildAuthenticatedDeviceProof('device');
const DESKTOP_CAPABILITIES: readonly CapabilityName[] = [
  'desktop.open_app',
  'desktop.focus_app',
  'desktop.close_app',
  'desktop.list_apps',
  'desktop.lock',
  'desktop.spotify',
];
const START = 1_700_000_000_000;

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
      const parsed = JSON.parse(message) as { type: string } & Record<string, unknown>;
      sentMessageRecordList.push({ type: parsed.type, payload: parsed });
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

type Harness = {
  readonly dependencies: ApolloTurnRuntimeDependencies;
  readonly registry: CapabilityRegistry;
  readonly sqlExecutor: ReturnType<typeof createInMemoryPendingConfirmationSqlExecutor>;
  readonly toolCallList: string[];
  readonly state: ApolloState;
  readonly setNow: (value: number) => void;
  readonly setTargetPreference: (preference: TargetPreference) => void;
  readonly resolutionCallList: {
    readonly capabilityName: string;
    readonly kind: string;
  }[];
};

function buildHarness(
  input: {
    readonly withRegistry?: boolean;
    readonly capabilities?: readonly CapabilityName[];
    readonly registerDesktop?: boolean;
    // Simula la race: el device resuelve y se cae antes de que se ejecute.
    readonly dropTargetAfterFirstResolution?: boolean;
  } = {},
): Harness {
  const toolCallList: string[] = [];
  const resolutionCallList: { readonly capabilityName: string; readonly kind: string }[] =
    [];
  const sqlExecutor = createInMemoryPendingConfirmationSqlExecutor();
  const state = { ...baseState } as ApolloState;
  let now = START;
  let targetPreferenceOverride: TargetPreference | null = null;

  const registry = new CapabilityRegistry({ nowMilliseconds: () => now });
  if (input.registerDesktop !== false) {
    registry.register({
      transport: { transportKind: 'pc_bridge', connectionId: 'connection-under-test' },
      proof,
      deviceId: 'desktop:pc',
      deviceType: 'desktop',
      capabilityNameList: input.capabilities ?? DESKTOP_CAPABILITIES,
      protocolVersion: 1,
      lastSeenAt: START,
    });
  }
  const registryResolver = buildRegistryCapabilityTargetResolver(registry);
  let resolutionCallCount = 0;
  const resolveCapabilityTarget = async (request: {
    readonly capabilityName: CapabilityName;
    readonly targetPreference: TargetPreference;
  }) => {
    const effectiveTargetPreference =
      targetPreferenceOverride ?? request.targetPreference;
    resolutionCallList.push({
      capabilityName: request.capabilityName,
      kind: effectiveTargetPreference.kind,
    });
    const answer = await registryResolver({
      capabilityName: request.capabilityName,
      targetPreference: effectiveTargetPreference,
    });
    resolutionCallCount += 1;
    if (
      input.dropTargetAfterFirstResolution === true &&
      resolutionCallCount === 1 &&
      answer.status === 'resolved'
    ) {
      registry.markPresence({
        proof,
        deviceId: answer.target.deviceId,
        presence: 'offline',
      });
    }
    return answer;
  };

  const countedTool = (tool: ToolDefinition): ToolDefinition => ({
    ...tool,
    async handler() {
      toolCallList.push(tool.name);
      return { ok: true, summary: `${tool.name} ok` };
    },
  });

  const dependencies: ApolloTurnRuntimeDependencies = {
    environment: createFakeApolloEnvironment({ MOCK_VOICE: '1' }),
    sqlExecutor,
    storageBucket: createFakeStorageBucket(),
    uiMachine: createDeskUiMachine(),
    currentState: state,
    getCurrentState: () => state,
    setAgentState: (nextState) => {
      Object.assign(state, nextState);
    },
    scheduleConfirmExpiry: async () => {},
    persistPendingConfirmation: async (confirmation) => {
      await savePendingToolConfirmation(sqlExecutor, confirmation);
    },
    session: {
      async appendMessage() {},
      async appendContextBlock() {},
      async refreshSystemPrompt() {},
      async freezeSystemPrompt() {
        return 'system';
      },
      async getRecentHistory() {
        return { messages: [] };
      },
    } as unknown as Session,
    deviceId: 'desk-b6',
    accountId: 'acc_0000000000000000000000000000abc3',
    effects: createStubDeskToolEffects(),
    loadToolDefinitionMap: async () =>
      buildToolDefinitionMap([
        countedTool(openPcAppTool),
        countedTool(focusPcAppTool),
        countedTool(closePcAppTool),
        countedTool(lockPcScreenTool),
      ]),
    ...(input.withRegistry === false ? {} : { resolveCapabilityTarget }),
    acquireGeminiToken: async () => {},
  };

  return {
    dependencies,
    registry,
    sqlExecutor,
    toolCallList,
    state,
    setNow: (value: number) => (now = value),
    setTargetPreference: (preference: TargetPreference) =>
      (targetPreferenceOverride = preference),
    resolutionCallList,
  };
}

// El fast path usa SIEMPRE el catálogo builtin real (equivale al del turno por
// colisión de nombres, ver tools/__tests__/pipeline.spec.ts). El handler real de
// las tools de PC intenta getAgentByName(PcBridge), que no existe en bun test y
// devuelve su summary de falla: eso prueba que el handler se invocó.
const REAL_PC_TOOL_FAILURE_MARKER = 'La PC no respondi';

function didRealToolExecute(list: readonly SentMessageRecord[]): boolean {
  return list.some(
    (record) =>
      record.type === 'text_response_chunk' &&
      typeof record.payload.text === 'string' &&
      record.payload.text.includes(REAL_PC_TOOL_FAILURE_MARKER),
  );
}

function findRecord(
  list: readonly SentMessageRecord[],
  type: string,
): SentMessageRecord | undefined {
  return list.find((record) => record.type === type);
}

function listMessageTypeList(
  list: readonly SentMessageRecord[],
  fromIndex = 0,
): string[] {
  return list.slice(fromIndex).map((record) => record.type);
}

function spokenTextOf(list: readonly SentMessageRecord[]): string | undefined {
  const chunk = findRecord(list, 'text_response_chunk');
  return typeof chunk?.payload.text === 'string' ? chunk.payload.text : undefined;
}

describe('B6 SAFE: capability → target → authorization → execution', () => {
  it('1. open Chrome resolves the desktop and executes', async () => {
    const harness = buildHarness();
    const { connection, sentMessageRecordList } = createRecordingConnection();
    await executeApolloTurn(connection, harness.dependencies, { text: 'abrí chrome' });
    // 1) resolución por target explícito y 2) revalidación del device exacto.
    expect(harness.resolutionCallList[0]).toEqual({
      capabilityName: 'desktop.open_app',
      kind: 'device_type',
    });
    expect(harness.resolutionCallList[1]).toEqual({
      capabilityName: 'desktop.open_app',
      kind: 'device',
    });
    // Autorizado y ejecutado: el handler real llegó a talking con PcBridge.
    expect(didRealToolExecute(sentMessageRecordList)).toBe(true);
    expect(spokenTextOf(sentMessageRecordList)).toContain(REAL_PC_TOOL_FAILURE_MARKER);
  });

  it('2. focus Chrome resolves the desktop and executes', async () => {
    const harness = buildHarness();
    const { connection, sentMessageRecordList } = createRecordingConnection();
    await executeApolloTurn(connection, harness.dependencies, { text: 'enfocá chrome' });
    expect(harness.resolutionCallList[0]?.capabilityName).toBe('desktop.focus_app');
    expect(didRealToolExecute(sentMessageRecordList)).toBe(true);
  });

  it('3. spotify play resolves the desktop and executes', async () => {
    const harness = buildHarness();
    const { connection, sentMessageRecordList } = createRecordingConnection();
    await executeApolloTurn(connection, harness.dependencies, { text: 'poné música' });
    expect(harness.resolutionCallList[0]?.capabilityName).toBe('desktop.spotify');
    expect(didRealToolExecute(sentMessageRecordList)).toBe(true);
  });
});

describe('B6 UNSAFE: target travels inside the confirmation', () => {
  it('4. close Chrome resolves desktop, confirms, and executes once on approve', async () => {
    const harness = buildHarness();
    const { connection, sentMessageRecordList } = createRecordingConnection();
    await executeApolloTurn(connection, harness.dependencies, { text: 'cerrá chrome' });

    // No se ejecutó: confirmation.
    expect(harness.toolCallList).toEqual([]);
    const stored = await readPendingToolConfirmation(harness.sqlExecutor);
    expect(stored?.toolName).toBe('close_pc_app');
    expect(stored?.targetDeviceId).toBe('desktop:pc');
    expect(stored?.targetDeviceType).toBe('desktop');
    expect(findRecord(sentMessageRecordList, 'confirm_request')).toBeDefined();

    // Approve.
    await deletePendingToolConfirmations(harness.sqlExecutor);
    if (stored === undefined) {
      throw new Error('expected stored confirmation');
    }
    await executeApolloTurn(connection, harness.dependencies, {
      text: 'confirmado',
      confirmOk: true,
      pendingConfirmation: stored,
    });
    expect(harness.toolCallList).toEqual(['close_pc_app']);
  });

  it('5. lock PC resolves desktop and confirms', async () => {
    const harness = buildHarness();
    const { connection } = createRecordingConnection();
    await executeApolloTurn(connection, harness.dependencies, {
      text: 'bloqueá la pantalla',
    });
    expect(harness.toolCallList).toEqual([]);
    const stored = await readPendingToolConfirmation(harness.sqlExecutor);
    expect(stored?.toolName).toBe('lock_pc_screen');
    expect(stored?.targetDeviceId).toBe('desktop:pc');
  });
});

describe('B6 OFFLINE: no execution', () => {
  it('6. a desktop that is offline blocks a safe pc action', async () => {
    const harness = buildHarness();
    harness.registry.markPresence({ proof, deviceId: 'desktop:pc', presence: 'offline' });
    const { connection, sentMessageRecordList } = createRecordingConnection();
    await executeApolloTurn(connection, harness.dependencies, { text: 'abrí chrome' });
    expect(didRealToolExecute(sentMessageRecordList)).toBe(false);
    expect(spokenTextOf(sentMessageRecordList)).toBe(
      'Ese dispositivo no está disponible ahora.',
    );
    expect(sentMessageRecordList.map((r) => r.type)).not.toContain('confirm_request');
  });

  it('10. a capability that no device declares does not execute', async () => {
    const harness = buildHarness({ capabilities: ['desktop.list_apps'] });
    const { connection, sentMessageRecordList } = createRecordingConnection();
    await executeApolloTurn(connection, harness.dependencies, { text: 'abrí chrome' });
    expect(didRealToolExecute(sentMessageRecordList)).toBe(false);
    expect(spokenTextOf(sentMessageRecordList)).toBe(
      'Ese dispositivo no puede hacer eso.',
    );
  });

  it('with no device registered there is nothing to execute', async () => {
    const harness = buildHarness({ registerDesktop: false });
    const { connection, sentMessageRecordList } = createRecordingConnection();
    await executeApolloTurn(connection, harness.dependencies, { text: 'abrí chrome' });
    expect(didRealToolExecute(sentMessageRecordList)).toBe(false);
    expect(spokenTextOf(sentMessageRecordList)).toBe(
      'No tengo ningún dispositivo conectado.',
    );
  });

  it('keeps the previous behaviour when no registry is wired', async () => {
    const harness = buildHarness({ withRegistry: false });
    const { connection, sentMessageRecordList } = createRecordingConnection();
    await executeApolloTurn(connection, harness.dependencies, { text: 'abrí chrome' });
    expect(harness.resolutionCallList).toEqual([]);
    expect(didRealToolExecute(sentMessageRecordList)).toBe(true);
  });
});

describe('B6 RACE: the target disappears between resolve and execute', () => {
  it('7. a target that goes offline after resolve aborts instead of executing', async () => {
    const harness = buildHarness({ dropTargetAfterFirstResolution: true });
    const { connection, sentMessageRecordList } = createRecordingConnection();
    await executeApolloTurn(connection, harness.dependencies, { text: 'abrí chrome' });
    // Resolvió (1er call), se autorizó, y la revalidación encontró el device caído.
    expect(harness.resolutionCallList.length).toBe(2);
    expect(didRealToolExecute(sentMessageRecordList)).toBe(false);
    // BLOCK 6.2: el texto viene del mapeo central de cancelaciones.
    expect(spokenTextOf(sentMessageRecordList)).toBe(
      'Ese dispositivo se desconectó antes de ejecutar la acción. No lo hice.',
    );
  });

  it('a target stale before the turn never even reaches authorization', async () => {
    const harness = buildHarness();
    harness.setNow(START + PRESENCE_OFFLINE_AFTER_MILLISECONDS + 1);
    const { connection, sentMessageRecordList } = createRecordingConnection();
    await executeApolloTurn(connection, harness.dependencies, { text: 'abrí chrome' });
    expect(didRealToolExecute(sentMessageRecordList)).toBe(false);
    expect(spokenTextOf(sentMessageRecordList)).toBe(
      'Ese dispositivo no está disponible ahora.',
    );
  });

  it('14. approving a confirmation whose target went offline does not execute', async () => {
    const harness = buildHarness();
    const { connection, sentMessageRecordList } = createRecordingConnection();
    await executeApolloTurn(connection, harness.dependencies, { text: 'cerrá chrome' });
    const stored = await readPendingToolConfirmation(harness.sqlExecutor);
    if (stored === undefined) {
      throw new Error('expected stored confirmation');
    }
    // El desktop se cae mientras el usuario decide.
    harness.registry.markPresence({ proof, deviceId: 'desktop:pc', presence: 'offline' });
    await deletePendingToolConfirmations(harness.sqlExecutor);
    const messageCountBeforeApprove = sentMessageRecordList.length;
    await executeApolloTurn(connection, harness.dependencies, {
      text: 'confirmado',
      confirmOk: true,
      pendingConfirmation: stored,
    });
    expect(harness.toolCallList).toEqual([]);
    // El turno de aprobación responde con el mensaje de target caído. Como en el
    // reject existente, la respuesta sale por TTS y el caption, no por chunk.
    expect(harness.state.caption).toBe(
      'Ese dispositivo se desconectó antes de ejecutar la acción. No lo hice.',
    );
    const approveMessageTypeList = listMessageTypeList(
      sentMessageRecordList,
      messageCountBeforeApprove,
    );
    // Mismo cierre que el reject preexistente: el turno termina sin pedir otra
    // confirmación ni volver a ejecutar la tool.
    expect(approveMessageTypeList).toContain('turn_end');
    expect(approveMessageTypeList).not.toContain('confirm_request');
    // BLOCK 6.2: la cancelación se habla.
    expect(approveMessageTypeList).toContain('tts_start');
  });

  it('15. approving while the target is online executes exactly once', async () => {
    const harness = buildHarness();
    const { connection } = createRecordingConnection();
    await executeApolloTurn(connection, harness.dependencies, { text: 'cerrá chrome' });
    const stored = await readPendingToolConfirmation(harness.sqlExecutor);
    if (stored === undefined) {
      throw new Error('expected stored confirmation');
    }
    await deletePendingToolConfirmations(harness.sqlExecutor);
    await executeApolloTurn(connection, harness.dependencies, {
      text: 'confirmado',
      confirmOk: true,
      pendingConfirmation: stored,
    });
    expect(harness.toolCallList).toEqual(['close_pc_app']);
  });
});

describe('B6 TARGET: explicit vs generic', () => {
  it('8. an explicit desktop target never resolves to another device type', async () => {
    const harness = buildHarness();
    harness.setTargetPreference({ kind: 'device_type', deviceType: 'mobile' });
    const { connection, sentMessageRecordList } = createRecordingConnection();
    await executeApolloTurn(connection, harness.dependencies, { text: 'abrí chrome' });
    expect(didRealToolExecute(sentMessageRecordList)).toBe(false);
    expect(spokenTextOf(sentMessageRecordList)).toBe(
      'Ese dispositivo no está disponible ahora.',
    );
  });

  it('9. a generic target picks the desktop when it is available', async () => {
    const harness = buildHarness();
    harness.setTargetPreference({ kind: 'any' });
    const { connection, sentMessageRecordList } = createRecordingConnection();
    await executeApolloTurn(connection, harness.dependencies, { text: 'abrí chrome' });
    expect(harness.resolutionCallList[0]?.kind).toBe('any');
    expect(didRealToolExecute(sentMessageRecordList)).toBe(true);
  });

  it('11. desktop + a mobile contract: explicit picks desktop, any follows policy', async () => {
    const harness = buildHarness();
    // El registry nunca anuncia mobile (todo mobile es unimplemented), pero el
    // catálogo sí lo contiene: comprobar que no se filtra como target.
    const mobileResolution = harness.registry.resolveTarget({
      capabilityName: 'mobile.media',
      targetPreference: { kind: 'any' },
    });
    expect(mobileResolution.status).toBe('unavailable');

    harness.setTargetPreference({ kind: 'any' });
    const { connection, sentMessageRecordList } = createRecordingConnection();
    await executeApolloTurn(connection, harness.dependencies, { text: 'abrí chrome' });
    expect(didRealToolExecute(sentMessageRecordList)).toBe(true);
  });
});
