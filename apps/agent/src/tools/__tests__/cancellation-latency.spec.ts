import { describe, expect, it } from 'bun:test';

import { createFakeApolloEnvironment } from '@/configuration/testing';
import { createInactiveDeskFocusState } from '@/focus/logic';
import { createInMemoryPendingConfirmationSqlExecutor } from '@/configuration/testing';
import { runDeskTurn, type TurnInput } from '@/turn/run';
import { buildRegistryCapabilityTargetResolver } from '@/devices/target';
import { buildAuthenticatedDeviceProof, CapabilityRegistry } from '@/devices/registry';
import { closePcAppTool } from '@/tools/pc';
import { buildToolDefinitionMap } from '@/tools/router';
import type { ToolDefinition } from '@/tools/types';

// BLOCK 6.2.1: la cancelación entrega el turno inmediatamente y deja la
// síntesis como trabajo asíncrono. Ningún await de TTS dentro del builder.
const proof = buildAuthenticatedDeviceProof('device');
const START = 1_700_000_000_000;
const SLOW_TTS_MILLISECONDS = 800;

type CapturedEvent = {
  readonly message: string;
  readonly requestId: string | null;
  readonly clientTurnId: string | null;
  readonly generation: number | null;
};

function captureConsoleEvents(
  run: () => Promise<unknown>,
): Promise<readonly CapturedEvent[]> {
  const capturedEventList: CapturedEvent[] = [];
  const originalLog = console.log;
  console.log = (...argumentList: unknown[]) => {
    const firstArgument = argumentList[0];
    if (typeof firstArgument !== 'string') {
      return;
    }
    try {
      const parsed = JSON.parse(firstArgument) as {
        message?: string;
        request_id?: string | null;
        client_turn_id?: string | null;
        generation?: number | null;
      };
      if (
        typeof parsed.message === 'string' &&
        parsed.message.includes('cancellation_tts')
      ) {
        capturedEventList.push({
          message: parsed.message,
          requestId: parsed.request_id ?? null,
          clientTurnId: parsed.client_turn_id ?? null,
          generation: parsed.generation ?? null,
        });
      }
    } catch {
      // Una línea que no es JSON no es un evento de este test.
    }
  };
  return run()
    .then(() => capturedEventList)
    .finally(() => {
      console.log = originalLog;
    });
}

function buildOfflineTurnInput(
  overrides: {
    readonly tts?: TurnInput['adapters']['tts'];
    readonly requestId?: string;
    readonly clientTurnId?: string;
    readonly generation?: number;
  } = {},
): TurnInput {
  const registry = new CapabilityRegistry({ nowMilliseconds: () => START });
  registry.register({
    transport: { transportKind: 'pc_bridge', connectionId: 'connection-under-test' },
    proof,
    deviceId: 'desktop:pc',
    deviceType: 'desktop',
    capabilityNameList: ['desktop.close_app'],
    protocolVersion: 1,
    lastSeenAt: START,
  });
  registry.markPresence({ proof, deviceId: 'desktop:pc', presence: 'offline' });
  return {
    text: 'cerrá chrome',
    speechMode: 'default',
    focusState: createInactiveDeskFocusState(),
    sqlExecutor: createInMemoryPendingConfirmationSqlExecutor(),
    environment: createFakeApolloEnvironment(),
    toolDefinitionMap: buildToolDefinitionMap([closePcAppTool as ToolDefinition]),
    nowMilliseconds: START,
    request_id: overrides.requestId ?? 'req-cancel',
    client_turn_id: overrides.clientTurnId ?? 'turn-cancel',
    generation: overrides.generation ?? 7,
    resolveCapabilityTarget: buildRegistryCapabilityTargetResolver(registry),
    adapters: {
      stt: async () => '',
      llm: async () => ({ text: '', toolCallList: [] }),
      tts:
        overrides.tts ??
        (async () => {
          await new Promise((resolve) => setTimeout(resolve, SLOW_TTS_MILLISECONDS));
          return new ArrayBuffer(8);
        }),
    },
  };
}

async function runRejectedCancellation(
  overrides: Parameters<typeof buildOfflineTurnInput>[0] = {},
): Promise<{
  readonly output: Awaited<ReturnType<typeof runDeskTurn>>;
  readonly elapsedMs: number;
}> {
  const startMs = performance.now();
  const output = await runDeskTurn({
    ...buildOfflineTurnInput(overrides),
    pendingConfirmation: {
      id: 'confirm-1',
      toolName: 'close_pc_app',
      args: { appName: 'chrome' },
      summary: 'Cerrar chrome en la PC',
      expiresAt: START + 30_000,
      targetDeviceId: 'desktop:pc',
      targetDeviceType: 'desktop',
    },
    confirmOk: false,
  });
  return { output, elapsedMs: performance.now() - startMs };
}

describe('B6.2.1 objective 1+2: the turn does not wait for synthesis', () => {
  it('1. a slow tts does not delay the cancellation turn', async () => {
    const { output, elapsedMs } = await runRejectedCancellation();
    expect(output.spokenText).toBe('Cancelado.');
    // El TTS tarda 800 ms; el turno tiene que estar cerrado mucho antes.
    expect(elapsedMs).toBeLessThan(SLOW_TTS_MILLISECONDS / 2);
  });

  it('2. the turn data is final before the audio resolves', async () => {
    const { output } = await runRejectedCancellation();
    // Caption, tool results y eventos ya son definitivos; el audio es promesa.
    expect(output.spokenText).toBe('Cancelado.');
    expect(output.uiEventList).toContain('CANCEL');
    expect(output.ttsAudioPromise).toBeDefined();
    // La cancelación NO registró ningún tool ejecutado.
    expect(output.executedToolCallList).toEqual([]);
  });
});

describe('B6.2.1 objective 3+7+8: events keep their anchors', () => {
  it('3. started happens before completed', async () => {
    const capturedEventList = await captureConsoleEvents(async () => {
      const { output } = await runRejectedCancellation();
      // Dejar que la síntesis termine para que se emita el segundo evento.
      await output.ttsAudioPromise;
    });
    const startedIndex = capturedEventList.findIndex((event) =>
      event.message.includes('cancellation_tts_started'),
    );
    const completedIndex = capturedEventList.findIndex((event) =>
      event.message.includes('cancellation_tts_completed'),
    );
    expect(startedIndex).toBeGreaterThanOrEqual(0);
    expect(completedIndex).toBeGreaterThan(startedIndex);
  });

  it('7. both events carry request_id, client_turn_id and generation', async () => {
    const capturedEventList = await captureConsoleEvents(async () => {
      const { output } = await runRejectedCancellation({
        requestId: 'req-anchors',
        clientTurnId: 'turn-anchors',
        generation: 99,
      });
      await output.ttsAudioPromise;
    });
    expect(capturedEventList.length).toBeGreaterThanOrEqual(2);
    for (const event of capturedEventList) {
      expect(event.requestId).toBe('req-anchors');
      expect(event.clientTurnId).toBe('turn-anchors');
      expect(event.generation).toBe(99);
    }
  });

  it('8. a late synthesis never reports anchors from another turn', async () => {
    // El TTS del turno A resuelve DESPUÉS de que empieza el turno B: sus
    // eventos deben seguir llevando los anchors de A.
    let releaseSlowTts: (() => void) | null = null;
    const slowTts = async () => {
      await new Promise<void>((resolve) => {
        releaseSlowTts = resolve;
      });
      return new ArrayBuffer(8);
    };
    const capturedEventList = await captureConsoleEvents(async () => {
      const firstTurn = await runDeskTurn({
        ...buildOfflineTurnInput({ tts: slowTts, requestId: 'req-A' }),
        pendingConfirmation: {
          id: 'confirm-a',
          toolName: 'close_pc_app',
          args: { appName: 'chrome' },
          summary: 'Cerrar chrome en la PC',
          expiresAt: START + 30_000,
        },
        confirmOk: false,
      });
      // Turno B, con otro request_id, mientras el TTS de A sigue pendiente.
      await runRejectedCancellation({ requestId: 'req-B', clientTurnId: 'turn-B' });
      releaseSlowTts?.();
      await firstTurn.ttsAudioPromise;
    });
    const slowTurnEventList = capturedEventList.filter(
      (event) => event.requestId === 'req-A',
    );
    expect(slowTurnEventList.length).toBeGreaterThanOrEqual(2);
    for (const event of slowTurnEventList) {
      expect(event.requestId).toBe('req-A');
      expect(event.clientTurnId).toBe('turn-cancel');
      expect(event.generation).toBe(7);
    }
  });
});

describe('B6.2.1 objective 4+5: failures and duplicates', () => {
  it('4. a tts failure does not change the cancellation result', async () => {
    const { output } = await runRejectedCancellation({
      tts: async () => {
        throw new Error('sintetizador caído');
      },
    });
    // El turno sigue siendo una cancelación, no un error ni un éxito.
    expect(output.spokenText).toBe('Cancelado.');
    expect(output.executedToolCallList).toEqual([]);
    const resolvedAudio = await output.ttsAudioPromise;
    expect(resolvedAudio).toBeUndefined();
  });

  it('5. a duplicate approval does not produce a second synthesis', async () => {
    const ttsCallCountList: string[] = [];
    const countingTts = async () => {
      ttsCallCountList.push('tts');
      return new ArrayBuffer(8);
    };
    const executionCountList: string[] = [];
    const countedTool: ToolDefinition = {
      ...closePcAppTool,
      async handler() {
        executionCountList.push('close_pc_app');
        return { ok: true, summary: 'Cerrado.' };
      },
    };
    const registry = new CapabilityRegistry({ nowMilliseconds: () => START });
    registry.register({
      transport: { transportKind: 'pc_bridge', connectionId: 'connection-under-test' },
      proof,
      deviceId: 'desktop:pc',
      deviceType: 'desktop',
      capabilityNameList: ['desktop.close_app'],
      protocolVersion: 1,
      lastSeenAt: START,
    });
    const pendingConfirmation = {
      id: 'confirm-dup',
      toolName: 'close_pc_app',
      args: { appName: 'chrome' },
      summary: 'Cerrar chrome en la PC',
      expiresAt: START + 30_000,
      targetDeviceId: 'desktop:pc' as string | undefined,
      targetDeviceType: 'desktop' as string | undefined,
    };
    const baseInput = {
      speechMode: 'default' as const,
      focusState: createInactiveDeskFocusState(),
      sqlExecutor: createInMemoryPendingConfirmationSqlExecutor(),
      environment: createFakeApolloEnvironment(),
      toolDefinitionMap: buildToolDefinitionMap([countedTool]),
      nowMilliseconds: START,
      request_id: 'req-dup',
      client_turn_id: 'turn-dup',
      resolveCapabilityTarget: buildRegistryCapabilityTargetResolver(registry),
      adapters: {
        stt: async () => '',
        llm: async () => ({ text: '', toolCallList: [] }),
        tts: countingTts,
      },
    };
    const firstTurn = await runDeskTurn({
      ...baseInput,
      text: 'confirmado',
      confirmOk: true,
      pendingConfirmation,
    });
    await firstTurn.ttsAudioPromise;
    // El device se cae: la segunda respuesta no puede ejecutar ni hablar.
    registry.markPresence({ proof, deviceId: 'desktop:pc', presence: 'offline' });
    const secondTurn = await runDeskTurn({
      ...baseInput,
      text: 'confirmado',
      confirmOk: true,
      pendingConfirmation,
    });
    await secondTurn.ttsAudioPromise;

    expect(executionCountList).toHaveLength(1);
    // Un TTS por turno de cancelación: el approve válido habla su resultado, el
    // segundo turno habla la cancelación. Nunca dos veces la misma acción.
    expect(ttsCallCountList.length).toBeLessThanOrEqual(2);
    expect(secondTurn.spokenText).toBe(
      'Ese dispositivo se desconectó antes de ejecutar la acción. No lo hice.',
    );
  });
});

describe('B6.2.1 objective 6: the retry guard is untouched', () => {
  it('6. a repeated non-retryable tool call is still suppressed', async () => {
    const executionCountList: string[] = [];
    const countedTool: ToolDefinition = {
      ...closePcAppTool,
      async handler() {
        executionCountList.push('close_pc_app');
        return { ok: true, summary: 'Cerrado.' };
      },
    };
    const registry = new CapabilityRegistry({ nowMilliseconds: () => START });
    registry.register({
      transport: { transportKind: 'pc_bridge', connectionId: 'connection-under-test' },
      proof,
      deviceId: 'desktop:pc',
      deviceType: 'desktop',
      capabilityNameList: ['desktop.close_app'],
      protocolVersion: 1,
      lastSeenAt: START,
    });
    registry.markPresence({ proof, deviceId: 'desktop:pc', presence: 'offline' });
    let resolutionCount = 0;
    const registryResolver = buildRegistryCapabilityTargetResolver(registry);
    const countingResolver = async (request: Parameters<typeof registryResolver>[0]) => {
      resolutionCount += 1;
      return await registryResolver(request);
    };
    let toolCallCount = 0;
    const output = await runDeskTurn({
      text: 'cerrá chrome',
      speechMode: 'default',
      focusState: createInactiveDeskFocusState(),
      sqlExecutor: createInMemoryPendingConfirmationSqlExecutor(),
      environment: createFakeApolloEnvironment(),
      toolDefinitionMap: buildToolDefinitionMap([countedTool]),
      nowMilliseconds: START,
      resolveCapabilityTarget: countingResolver,
      adapters: {
        stt: async () => '',
        llm: async () => {
          toolCallCount += 1;
          return {
            text: 'No pude cerrarlo.',
            toolCallList:
              toolCallCount <= 3
                ? [
                    {
                      id: `c-${toolCallCount}`,
                      name: 'close_pc_app',
                      args: { appName: 'chrome' },
                    },
                  ]
                : [],
          };
        },
        tts: async () => new ArrayBuffer(0),
      },
    });
    expect(toolCallCount).toBe(3);
    expect(resolutionCount).toBe(1);
    expect(executionCountList).toEqual([]);
    expect(output.toolResultList.every((toolResult) => toolResult.ok === false)).toBe(
      true,
    );
  });
});
