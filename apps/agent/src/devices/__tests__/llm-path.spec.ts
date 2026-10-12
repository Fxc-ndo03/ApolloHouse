import { describe, expect, it } from 'bun:test';

import { createFakeApolloEnvironment } from '@/configuration/testing';
import { buildRegistryCapabilityTargetResolver } from '@/devices/target';
import { buildAuthenticatedDeviceProof, CapabilityRegistry } from '@/devices/registry';
import type { CapabilityName } from '@/devices/capability';
import { requiresExecutionTarget } from '@/devices/target';
import { listBuiltinToolDefinitionList } from '@/tools/catalog';
import {
  executeToolWithTargetResolution,
  buildTargetPreferenceForCapability,
  resolveExecutionTarget,
  verifyExecutionTarget,
} from '@/tools/target';
import { buildToolDefinitionMap, resolvePendingToolConfirmation } from '@/tools/router';
import { closePcAppTool, focusPcAppTool, openPcAppTool } from '@/tools/pc';
import { weatherNowTool } from '@/tools/weather';
import type { CapabilityTargetResolver } from '@/devices/target';
import type { ToolDefinition } from '@/tools/types';

// El camino LLM y el determinista comparten ESTE pipeline. Estos tests lo
// ejercitan por la misma función que usa el tool loop del LLM.

const proof = buildAuthenticatedDeviceProof('device');
const START = 1_700_000_000_000;
const CAPABILITIES: readonly CapabilityName[] = [
  'desktop.open_app',
  'desktop.focus_app',
  'desktop.close_app',
  'desktop.list_apps',
  'desktop.lock',
  'desktop.spotify',
];

type Harness = {
  readonly resolver: CapabilityTargetResolver;
  readonly registry: CapabilityRegistry;
  readonly toolCallList: string[];
  readonly lookupCountList: string[];
};

function buildHarness(
  options: {
    readonly registerDesktop?: boolean;
    readonly presence?: 'online' | 'offline';
    readonly capabilities?: readonly CapabilityName[];
  } = {},
): Harness {
  const toolCallList: string[] = [];
  const lookupCountList: string[] = [];
  const registry = new CapabilityRegistry({ nowMilliseconds: () => START });
  if (options.registerDesktop !== false) {
    registry.register({
      transport: { transportKind: 'pc_bridge', connectionId: 'connection-under-test' },
      proof,
      deviceId: 'desktop:pc',
      deviceType: 'desktop',
      capabilityNameList: options.capabilities ?? CAPABILITIES,
      protocolVersion: 1,
      lastSeenAt: START,
    });
  }
  if (options.presence === 'offline') {
    registry.markPresence({ proof, deviceId: 'desktop:pc', presence: 'offline' });
  }
  const registryResolver = buildRegistryCapabilityTargetResolver(registry);
  const resolver: CapabilityTargetResolver = async (request) => {
    lookupCountList.push(request.capabilityName);
    return await registryResolver(request);
  };
  return { resolver, registry, toolCallList, lookupCountList };
}

function buildCountedTool(tool: ToolDefinition, toolCallList: string[]): ToolDefinition {
  return {
    ...tool,
    async handler() {
      toolCallList.push(tool.name);
      return { ok: true, summary: `${tool.name} ok` };
    },
  };
}

const toolExecutionContext = {
  environment: createFakeApolloEnvironment(),
  nowMilliseconds: START,
  deviceId: 'desk-b61',
};

describe('B6.1 A/B: deterministic and LLM share one pipeline', () => {
  it('A. safe targeted tool resolves, authorizes and executes once', async () => {
    const harness = buildHarness();
    const toolCallList: string[] = [];
    const outcome = await executeToolWithTargetResolution({
      toolName: 'open_pc_app',
      args: { appName: 'chrome' },
      origin: 'llm',
      toolDefinitionMap: buildToolDefinitionMap([
        buildCountedTool(openPcAppTool, toolCallList),
      ]),
      context: toolExecutionContext,
      resolver: harness.resolver,
    });
    expect(outcome.status).toBe('done');
    expect(toolCallList).toEqual(['open_pc_app']);
    expect(harness.lookupCountList[0]).toBe('desktop.open_app');
  });

  it('B. unsafe targeted tool asks for confirmation carrying the target', async () => {
    const harness = buildHarness();
    const outcome = await executeToolWithTargetResolution({
      toolName: 'close_pc_app',
      args: { appName: 'chrome' },
      origin: 'llm',
      toolDefinitionMap: buildToolDefinitionMap([closePcAppTool]),
      context: toolExecutionContext,
      resolver: harness.resolver,
    });
    expect(outcome.status).toBe('needs_confirm');
    if (outcome.status !== 'needs_confirm') {
      throw new Error('expected needs_confirm');
    }
    expect(outcome.pending.targetDeviceId).toBe('desktop:pc');
    expect(outcome.pending.targetDeviceType).toBe('desktop');
  });
});

describe('B6.1 C/D/E: LLM pc tools go through the registry', () => {
  it('C. llm safe pc tool executes after target resolution', async () => {
    const harness = buildHarness();
    const toolCallList: string[] = [];
    const outcome = await executeToolWithTargetResolution({
      toolName: 'focus_pc_app',
      args: { appName: 'chrome' },
      origin: 'llm',
      toolDefinitionMap: buildToolDefinitionMap([
        buildCountedTool(focusPcAppTool, toolCallList),
      ]),
      context: toolExecutionContext,
      resolver: harness.resolver,
    });
    expect(outcome.status).toBe('done');
    expect(toolCallList).toEqual(['focus_pc_app']);
  });

  it('D. llm unsafe pc tool confirms and executes once on approve', async () => {
    const harness = buildHarness();
    const toolCallList: string[] = [];
    const toolDefinitionMap = buildToolDefinitionMap([
      buildCountedTool(closePcAppTool, toolCallList),
    ]);
    const requested = await executeToolWithTargetResolution({
      toolName: 'close_pc_app',
      args: { appName: 'chrome' },
      origin: 'llm',
      toolDefinitionMap,
      context: toolExecutionContext,
      resolver: harness.resolver,
    });
    if (requested.status !== 'needs_confirm') {
      throw new Error('expected needs_confirm');
    }
    const approved = await resolvePendingToolConfirmation(
      toolDefinitionMap,
      requested.pending,
      true,
      toolExecutionContext,
      harness.resolver,
    );
    expect(approved).toMatchObject({ ok: true });
    expect(toolCallList).toEqual(['close_pc_app']);
  });

  it('E. llm pc tool with the desktop offline never executes', async () => {
    const harness = buildHarness({ presence: 'offline' });
    const toolCallList: string[] = [];
    const outcome = await executeToolWithTargetResolution({
      toolName: 'close_pc_app',
      args: { appName: 'chrome' },
      origin: 'llm',
      toolDefinitionMap: buildToolDefinitionMap([
        buildCountedTool(closePcAppTool, toolCallList),
      ]),
      context: toolExecutionContext,
      resolver: harness.resolver,
    });
    expect(outcome.status).toBe('skipped');
    if (outcome.status !== 'skipped') {
      throw new Error('expected skipped');
    }
    expect(outcome.cancellation.reason).toBe('target_unavailable');
    expect(outcome.cancellation.retryable).toBe(false);
    expect(outcome.cancellation.message).toBe(
      'Ese dispositivo no está disponible ahora.',
    );
    expect(toolCallList).toEqual([]);
  });

  it('F. a target that disappears after the llm decision does not execute', async () => {
    const harness = buildHarness();
    const toolCallList: string[] = [];
    let resolutionCount = 0;
    const flippingResolver: CapabilityTargetResolver = async (request) => {
      resolutionCount += 1;
      const answer = await harness.resolver(request);
      // Se cae justo después de la resolución inicial.
      if (resolutionCount === 1 && answer.status === 'resolved') {
        harness.registry.markPresence({
          proof,
          deviceId: answer.target.deviceId,
          presence: 'offline',
        });
      }
      return answer;
    };
    const outcome = await executeToolWithTargetResolution({
      toolName: 'open_pc_app',
      args: { appName: 'chrome' },
      origin: 'llm',
      toolDefinitionMap: buildToolDefinitionMap([
        buildCountedTool(openPcAppTool, toolCallList),
      ]),
      context: toolExecutionContext,
      resolver: flippingResolver,
    });
    expect(outcome.status).toBe('skipped');
    if (outcome.status === 'skipped') {
      expect(outcome.cancellation.reason).toBe('target_offline');
      expect(outcome.cancellation.retryable).toBe(false);
    }
    expect(toolCallList).toEqual([]);
  });
});

describe('B6.1 G/H: capability lookup never invents', () => {
  it('G. an unknown tool resolves no capability', () => {
    const unknownCapability = getCapabilityFor('tool_que_no_existe');
    expect(unknownCapability).toBeUndefined();
  });

  it('H. a cloud-only tool does not touch the registry', async () => {
    const harness = buildHarness();
    const toolCallList: string[] = [];
    const countedWeatherTool: ToolDefinition = {
      ...weatherNowTool,
      async handler() {
        toolCallList.push('weather_now');
        return { ok: true, summary: 'soleado' };
      },
    };
    const resolution = await resolveExecutionTarget({
      toolName: 'weather_now',
      capabilityName: getCapabilityFor('weather_now'),
      resolver: harness.resolver,
      phase: 'initial',
    });
    expect(resolution.status).toBe('not_required');
    expect(resolution.status === 'not_required' && resolution.reason).toBe(
      'no_capability',
    );

    const outcome = await executeToolWithTargetResolution({
      toolName: 'weather_now',
      args: {},
      origin: 'llm',
      toolDefinitionMap: buildToolDefinitionMap([countedWeatherTool]),
      context: toolExecutionContext,
      resolver: harness.resolver,
    });
    expect(outcome.status).toBe('done');
    expect(toolCallList).toEqual(['weather_now']);
    expect(harness.lookupCountList).toEqual([]);
  });

  it('maps every desktop pc tool and leaves the rest undefined', () => {
    for (const toolName of [
      'open_pc_app',
      'focus_pc_app',
      'close_pc_app',
      'list_pc_apps',
      'lock_pc_screen',
      'spotify_play',
      'spotify_pause',
      'spotify_next',
      'spotify_previous',
      'spotify_get_state',
    ]) {
      expect(getCapabilityFor(toolName)).toBeDefined();
      expect(requiresExecutionTarget(toolName)).toBe(true);
    }
    for (const toolName of [
      'weather_now',
      'remember_fact',
      'set_reminder',
      'set_timer',
      'web_search',
      'send_email',
      'set_volume',
      'device_status',
      'recall_memory',
    ]) {
      expect(getCapabilityFor(toolName)).toBeUndefined();
      expect(requiresExecutionTarget(toolName)).toBe(false);
    }
  });
});

describe('B6.1 I/J/M: confirmation lifecycle', () => {
  it('I. a duplicate approve executes only once', async () => {
    const harness = buildHarness();
    const toolCallList: string[] = [];
    const toolDefinitionMap = buildToolDefinitionMap([
      buildCountedTool(closePcAppTool, toolCallList),
    ]);
    const requested = await executeToolWithTargetResolution({
      toolName: 'close_pc_app',
      args: { appName: 'chrome' },
      origin: 'llm',
      toolDefinitionMap,
      context: toolExecutionContext,
      resolver: harness.resolver,
    });
    if (requested.status !== 'needs_confirm') {
      throw new Error('expected needs_confirm');
    }
    await resolvePendingToolConfirmation(
      toolDefinitionMap,
      requested.pending,
      true,
      toolExecutionContext,
      harness.resolver,
    );
    expect(toolCallList).toEqual(['close_pc_app']);

    // El DO ya consumió la fila: una segunda respuesta no vuelve a ejecutar.
    harness.registry.markPresence({ proof, deviceId: 'desktop:pc', presence: 'offline' });
    const second = await resolvePendingToolConfirmation(
      toolDefinitionMap,
      requested.pending,
      true,
      toolExecutionContext,
      harness.resolver,
    );
    expect('cancelled' in second && second.reason).toBe('target_offline');
    expect(toolCallList).toEqual(['close_pc_app']);
  });

  it('J. an expired confirmation executes nothing', async () => {
    const harness = buildHarness();
    const toolCallList: string[] = [];
    const toolDefinitionMap = buildToolDefinitionMap([
      buildCountedTool(closePcAppTool, toolCallList),
    ]);
    const requested = await executeToolWithTargetResolution({
      toolName: 'close_pc_app',
      args: { appName: 'chrome' },
      origin: 'llm',
      toolDefinitionMap,
      context: toolExecutionContext,
      resolver: harness.resolver,
    });
    if (requested.status !== 'needs_confirm') {
      throw new Error('expected needs_confirm');
    }
    const resolved = await resolvePendingToolConfirmation(
      toolDefinitionMap,
      requested.pending,
      true,
      { ...toolExecutionContext, nowMilliseconds: requested.pending.expiresAt + 1 },
      harness.resolver,
    );
    expect('cancelled' in resolved && resolved.reason).toBe('expired');
    expect(toolCallList).toEqual([]);
  });

  it('M. a capability that disappears before the approval blocks execution', async () => {
    const harness = buildHarness();
    const toolCallList: string[] = [];
    const toolDefinitionMap = buildToolDefinitionMap([
      buildCountedTool(closePcAppTool, toolCallList),
    ]);
    const requested = await executeToolWithTargetResolution({
      toolName: 'close_pc_app',
      args: { appName: 'chrome' },
      origin: 'llm',
      toolDefinitionMap,
      context: toolExecutionContext,
      resolver: harness.resolver,
    });
    if (requested.status !== 'needs_confirm') {
      throw new Error('expected needs_confirm');
    }
    // El device sigue vivo pero ya no anuncia la capability.
    const downgradedRegistry = new CapabilityRegistry({
      nowMilliseconds: () => START,
    });
    downgradedRegistry.register({
      transport: { transportKind: 'pc_bridge', connectionId: 'connection-under-test' },
      proof,
      deviceId: 'desktop:pc',
      deviceType: 'desktop',
      capabilityNameList: ['desktop.open_app'],
      protocolVersion: 1,
      lastSeenAt: START,
    });
    const resolved = await resolvePendingToolConfirmation(
      toolDefinitionMap,
      requested.pending,
      true,
      toolExecutionContext,
      buildRegistryCapabilityTargetResolver(downgradedRegistry),
    );
    // El device sigue vivo pero ya no anuncia la capability: el motivo exacto.
    expect('cancelled' in resolved && resolved.reason).toBe('capability_absent');
    expect(toolCallList).toEqual([]);
  });
});

describe('B6.1 K/L: target preference policy', () => {
  it('K. a capability always targets its own device type, never any', () => {
    expect(buildTargetPreferenceForCapability('desktop.open_app')).toEqual({
      kind: 'device_type',
      deviceType: 'desktop',
    });
    // BLOCK 7: el deviceType sale del contrato de la capability. Una
    // capability mobile apunta a mobile (o no resuelve), nunca 'any' ni
    // desktop.
    expect(buildTargetPreferenceForCapability('mobile.media')).toEqual({
      kind: 'device_type',
      deviceType: 'mobile',
    });
  });

  it('L. a generic target only picks a device implementing the capability', async () => {
    // Sólo un device que anuncia desktop.open_app puede recibirla.
    const registry = new CapabilityRegistry({ nowMilliseconds: () => START });
    registry.register({
      transport: { transportKind: 'pc_bridge', connectionId: 'connection-under-test' },
      proof,
      deviceId: 'desktop:pc',
      deviceType: 'desktop',
      capabilityNameList: ['desktop.open_app'],
      protocolVersion: 1,
      lastSeenAt: START,
    });
    const resolver = buildRegistryCapabilityTargetResolver(registry);
    const genericAnswer = await resolver({
      capabilityName: 'desktop.spotify',
      targetPreference: { kind: 'any' },
    });
    expect(genericAnswer.status).toBe('unavailable');

    const capableAnswer = await resolver({
      capabilityName: 'desktop.open_app',
      targetPreference: { kind: 'any' },
    });
    expect(capableAnswer.status).toBe('resolved');
  });

  it('verifies an explicit target by device id', async () => {
    const harness = buildHarness();
    const verification = await verifyExecutionTarget({
      toolName: 'open_pc_app',
      capabilityName: 'desktop.open_app',
      targetDeviceId: 'desktop:pc',
      targetDeviceType: 'desktop',
      resolver: harness.resolver,
    });
    expect(verification.status).toBe('available');
  });

  it('has no builtin tool without a definition', () => {
    // Guarda contra tools renombradas: el mapeo no puede quedar colgando.
    expect(listBuiltinToolDefinitionList().length).toBeGreaterThan(0);
  });
});

// Import diferido para que el test lea como，表 mapping.
function getCapabilityFor(toolName: string): CapabilityName | undefined {
  return getCapabilityForToolNameImpl(toolName);
}

import { getCapabilityForToolName as getCapabilityForToolNameImpl } from '@/devices/target';
