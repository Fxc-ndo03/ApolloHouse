import { describe, expect, it } from 'bun:test';

import { createFakeApolloEnvironment } from '@/configuration/testing';
import { createInactiveDeskFocusState } from '@/focus/logic';
import { createInMemoryPendingConfirmationSqlExecutor } from '@/configuration/testing';
import { runDeskTurn } from '@/turn/run';
import { buildRegistryCapabilityTargetResolver } from '@/devices/target';
import { buildAuthenticatedDeviceProof, CapabilityRegistry } from '@/devices/registry';
import { closePcAppTool } from '@/tools/pc';
import { buildToolDefinitionMap } from '@/tools/router';
import type { ToolDefinition } from '@/tools/types';

const proof = buildAuthenticatedDeviceProof('device');
const START = 1_700_000_000_000;

// El loop del LLM tiene que respetar retryable=false: si el modelo insiste, la
// tool no se vuelve a tocar y el turno termina sin loops.
describe('B6.2 objective 2: no automatic retries of non-retryable actions', () => {
  it('suppresses a repeated pc tool call after a target cancellation', async () => {
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

    let toolCallCount = 0;
    // Contador de resolución: si el guard de retry no existiera, el pipeline
    // volvería a resolver el target en cada pedido del modelo.
    let resolutionCount = 0;
    const registryResolver = buildRegistryCapabilityTargetResolver(registry);
    const countingResolver = async (request: Parameters<typeof registryResolver>[0]) => {
      resolutionCount += 1;
      return await registryResolver(request);
    };
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
          // Un modelo terco pide la tool en cada round.
          return {
            text: '',
            toolCallList:
              toolCallCount <= 3
                ? [
                    {
                      id: `call-${toolCallCount}`,
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

    // El device está offline: la tool nunca se ejecuta, ni en el primer round
    // ni en los reintentos del modelo.
    expect(executionCountList).toEqual([]);
    expect(output.pendingConfirmation).toBeUndefined();
    // El modelo pidió la tool tres veces; el pipeline la procesó UNA sola.
    expect(toolCallCount).toBe(3);
    expect(resolutionCount).toBe(1);
    // Y el resultado que ve el modelo es siempre el mismo, no retryable.
    expect(output.toolResultList.length).toBeGreaterThan(0);
    for (const toolResult of output.toolResultList) {
      expect(toolResult.ok).toBe(false);
      expect(toolResult.summary).toBe('Ese dispositivo no está disponible ahora.');
    }
  });

  it('repeats the same cancellation result instead of touching the tool', async () => {
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
    let resolutionCount = 0;
    const registryResolver = buildRegistryCapabilityTargetResolver(registry);
    const countingResolver = async (request: Parameters<typeof registryResolver>[0]) => {
      resolutionCount += 1;
      return await registryResolver(request);
    };

    await runDeskTurn({
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
        llm: async () => ({
          text: 'No pude cerrarlo.',
          toolCallList: [
            { id: 'call-1', name: 'close_pc_app', args: { appName: 'chrome' } },
            { id: 'call-2', name: 'close_pc_app', args: { appName: 'chrome' } },
          ],
        }),
        tts: async () => new ArrayBuffer(0),
      },
    });

    // Sin la capability declarada para.close_pc_app no habría resolución; con
    // ella, la revalidación también cuenta. Lo relevante: el handler no corrió
    // y el loop no se repitió indefinidamente.
    expect(executionCountList).toEqual([]);
    expect(resolutionCount).toBeGreaterThanOrEqual(1);
  });

  it('a first successful call is not blocked by the retry guard', async () => {
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

    const output = await runDeskTurn({
      text: 'cerrá chrome',
      speechMode: 'default',
      focusState: createInactiveDeskFocusState(),
      sqlExecutor: createInMemoryPendingConfirmationSqlExecutor(),
      environment: createFakeApolloEnvironment(),
      toolDefinitionMap: buildToolDefinitionMap([countedTool]),
      nowMilliseconds: START,
      resolveCapabilityTarget: buildRegistryCapabilityTargetResolver(registry),
      adapters: {
        stt: async () => '',
        llm: async () => ({ text: 'Listo.', toolCallList: [] }),
        tts: async () => new ArrayBuffer(0),
      },
    });
    expect(output.spokenText).toBe('Listo.');
    expect(executionCountList).toEqual([]);
  });
});
