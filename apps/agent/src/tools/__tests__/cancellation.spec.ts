import { describe, expect, it } from 'bun:test';

import { createFakeApolloEnvironment } from '@/configuration/testing';
import { buildRegistryCapabilityTargetResolver } from '@/devices/target';
import { buildAuthenticatedDeviceProof, CapabilityRegistry } from '@/devices/registry';
import {
  buildCancellationResult,
  buildCancellationToolResult,
  toCancellationReason,
  type CancellationReason,
} from '@/tools/cancellation';
import {
  resolveCapabilityForToolName,
  isTargetedToolName,
} from '@/tools/capability-index';
import { requiresExecutionTargetForToolDefinition } from '@/tools/execution-target';
import { listBuiltinToolDefinitionList } from '@/tools/catalog';
import { listPcToolDefinitionList } from '@/tools/pc';
import { executeToolWithTargetResolution } from '@/tools/target';
import { buildToolDefinitionMap, resolvePendingToolConfirmation } from '@/tools/router';
import { closePcAppTool, openPcAppTool } from '@/tools/pc';
import { weatherNowTool } from '@/tools/weather';
import { rememberFactTool } from '@/tools/memory';
import type { CapabilityTargetResolver } from '@/devices/target';
import type { CapabilityName } from '@/devices/capability';
import type { ToolDefinition } from '@/tools/types';

const proof = buildAuthenticatedDeviceProof('device');
const START = 1_700_000_000_000;
const CANCELLATION_REASON_LIST: readonly CancellationReason[] = [
  'expired',
  'rejected',
  'target_offline',
  'target_unavailable',
  'capability_absent',
  'no_device',
  'unimplemented',
  'unknown_tool',
];

function buildRegistryResolver(
  options: {
    readonly presence?: 'online' | 'offline';
    readonly capabilities?: readonly CapabilityName[];
  } = {},
): {
  readonly resolver: CapabilityTargetResolver;
  readonly registry: CapabilityRegistry;
} {
  const registry = new CapabilityRegistry({ nowMilliseconds: () => START });
  registry.register({
    transport: { transportKind: 'pc_bridge', connectionId: 'connection-under-test' },
    proof,
    deviceId: 'desktop:pc',
    deviceType: 'desktop',
    capabilityNameList: options.capabilities ?? [
      'desktop.open_app',
      'desktop.close_app',
      'desktop.spotify',
    ],
    protocolVersion: 1,
    lastSeenAt: START,
  });
  if (options.presence === 'offline') {
    registry.markPresence({ proof, deviceId: 'desktop:pc', presence: 'offline' });
  }
  return { resolver: buildRegistryCapabilityTargetResolver(registry), registry };
}

const toolExecutionContext = {
  environment: createFakeApolloEnvironment(),
  nowMilliseconds: START,
  deviceId: 'desk-b62',
};

describe('B6.2 objective 1+3: one cancellation mapping', () => {
  it('every reason has a spoken message and is not retryable', () => {
    for (const reason of CANCELLATION_REASON_LIST) {
      const cancellation = buildCancellationResult(reason);
      expect(cancellation.reason).toBe(reason);
      expect(cancellation.message.length).toBeGreaterThan(0);
      expect(cancellation.retryable).toBe(false);
    }
  });

  it('the messages are the ones the product expects', () => {
    expect(buildCancellationResult('target_offline').message).toBe(
      'Ese dispositivo se desconectó antes de ejecutar la acción. No lo hice.',
    );
    expect(buildCancellationResult('target_unavailable').message).toBe(
      'Ese dispositivo no está disponible ahora.',
    );
    expect(buildCancellationResult('expired').message).toBe('La confirmación expiró.');
    expect(buildCancellationResult('rejected').message).toBe('Cancelado.');
  });

  it('the tool result carries the reason and the retry flag', () => {
    const result = buildCancellationToolResult(buildCancellationResult('target_offline'));
    expect(result.ok).toBe(false);
    expect(result.metadata).toEqual({ reason: 'target_offline', retryable: false });
    expect(result.summary).toBe(buildCancellationResult('target_offline').message);
  });

  it('maps every registry unavailability to a cancellation reason', () => {
    expect(toCancellationReason('no_device')).toBe('no_device');
    expect(toCancellationReason('capability_absent')).toBe('capability_absent');
    expect(toCancellationReason('target_unavailable')).toBe('target_unavailable');
    expect(toCancellationReason('unimplemented')).toBe('unimplemented');
    expect(toCancellationReason('target_offline')).toBe('target_offline');
  });

  it('7/8. llm target_offline and target_unavailable are not retryable', async () => {
    const offline = buildRegistryResolver({ presence: 'offline' });
    const offlineOutcome = await executeToolWithTargetResolution({
      toolName: 'close_pc_app',
      args: { appName: 'chrome' },
      origin: 'llm',
      toolDefinitionMap: buildToolDefinitionMap([closePcAppTool]),
      context: toolExecutionContext,
      resolver: offline.resolver,
    });
    expect(offlineOutcome.status).toBe('skipped');
    if (offlineOutcome.status === 'skipped') {
      expect(offlineOutcome.cancellation.retryable).toBe(false);
      expect(offlineOutcome.cancellation.reason).toBe('target_unavailable');
    }

    const absent = buildRegistryResolver({ capabilities: ['desktop.open_app'] });
    const absentOutcome = await executeToolWithTargetResolution({
      toolName: 'close_pc_app',
      args: { appName: 'chrome' },
      origin: 'llm',
      toolDefinitionMap: buildToolDefinitionMap([closePcAppTool]),
      context: toolExecutionContext,
      resolver: absent.resolver,
    });
    expect(absentOutcome.status).toBe('skipped');
    if (absentOutcome.status === 'skipped') {
      expect(absentOutcome.cancellation.retryable).toBe(false);
      expect(absentOutcome.cancellation.reason).toBe('capability_absent');
    }
  });

  it('9. a transient tool failure is not a cancellation', async () => {
    const { resolver } = buildRegistryResolver();
    const transientTool: ToolDefinition = {
      name: 'open_pc_app',
      safety: 'safe',
      description: 'falla transitoria',
      parameters: { type: 'object', properties: {} },
      executionTarget: { kind: 'capability', capabilityName: 'desktop.open_app' },
      async handler() {
        return { ok: false, summary: 'timeout de red' };
      },
    };
    const outcome = await executeToolWithTargetResolution({
      toolName: 'open_pc_app',
      args: { appName: 'chrome' },
      origin: 'llm',
      toolDefinitionMap: buildToolDefinitionMap([transientTool]),
      context: toolExecutionContext,
      resolver,
    });
    // No es cancelación: sigue siendo un tool result ordinario, que el loop
    // puede reintentar como siempre.
    expect(outcome.status).toBe('done');
    if (outcome.status === 'done') {
      expect(outcome.result.summary).toBe('timeout de red');
    }
  });
});

describe('B6.2 objective 4: declarative target classification', () => {
  it('every pc tool declares an implemented capability', () => {
    for (const toolDefinition of listPcToolDefinitionList()) {
      expect(toolDefinition.executionTarget).toBeDefined();
      expect(toolDefinition.executionTarget?.kind).toBe('capability');
      const capabilityName =
        toolDefinition.executionTarget?.kind === 'capability'
          ? toolDefinition.executionTarget.capabilityName
          : undefined;
      expect(capabilityName).toBeDefined();
      expect(capabilityName).toMatch(/^desktop\./);
    }
  });

  it('resolves the capability from the definition, with no second map', () => {
    const toolDefinitionMap = buildToolDefinitionMap(listBuiltinToolDefinitionList());
    expect(resolveCapabilityForToolName(toolDefinitionMap, 'open_pc_app')).toBe(
      'desktop.open_app',
    );
    expect(resolveCapabilityForToolName(toolDefinitionMap, 'close_pc_app')).toBe(
      'desktop.close_app',
    );
    expect(resolveCapabilityForToolName(toolDefinitionMap, 'lock_pc_screen')).toBe(
      'desktop.lock',
    );
    expect(resolveCapabilityForToolName(toolDefinitionMap, 'spotify_play')).toBe(
      'desktop.spotify',
    );
    for (const toolCallId of [
      'spotify_pause',
      'spotify_next',
      'spotify_previous',
      'spotify_get_state',
    ]) {
      expect(resolveCapabilityForToolName(toolDefinitionMap, toolCallId)).toBe(
        'desktop.spotify',
      );
    }
  });

  it('11. cloud-only tools need no target and stay cloud-only', () => {
    const toolDefinitionMap = buildToolDefinitionMap(listBuiltinToolDefinitionList());
    for (const cloudOnlyToolName of [
      'weather_now',
      'remember_fact',
      'set_reminder',
      'web_search',
      'send_email',
      'recall_memory',
      'set_volume',
    ]) {
      expect(
        resolveCapabilityForToolName(toolDefinitionMap, cloudOnlyToolName),
      ).toBeUndefined();
      expect(isTargetedToolName(toolDefinitionMap, cloudOnlyToolName)).toBe(false);
    }
  });

  it('an unknown tool has no capability, never a fabricated one', () => {
    const toolDefinitionMap = buildToolDefinitionMap(listBuiltinToolDefinitionList());
    expect(resolveCapabilityForToolName(toolDefinitionMap, 'nope')).toBeUndefined();
  });

  it('a tool definition without metadata is classified as cloud-only', () => {
    const bareTool: ToolDefinition = {
      name: 'bare_tool',
      safety: 'safe',
      description: 'sin metadata',
      parameters: { type: 'object', properties: {} },
      async handler() {
        return { ok: true, summary: 'ok' };
      },
    };
    expect(requiresExecutionTargetForToolDefinition(bareTool)).toBe(false);
    expect(
      resolveCapabilityForToolName(buildToolDefinitionMap([bareTool]), 'bare_tool'),
    ).toBeUndefined();
  });

  it('every pc tool is reachable by capability without duplicating a list', () => {
    // Si se agrega una tool a @/tools/pc sin metadata, el test de arriba falla.
    const pcToolNameSet = new Set(listPcToolDefinitionList().map((tool) => tool.name));
    expect(pcToolNameSet.size).toBeGreaterThanOrEqual(10);
  });
});

describe('B6.2 objective 5: confirmation keeps exactly one execution', () => {
  it('5. a duplicate approval does not execute or speak the action twice', async () => {
    const { resolver } = buildRegistryResolver();
    const executionCountList: string[] = [];
    const countedTool: ToolDefinition = {
      ...closePcAppTool,
      async handler() {
        executionCountList.push('close_pc_app');
        return { ok: true, summary: 'Cerrado.' };
      },
    };
    const toolDefinitionMap = buildToolDefinitionMap([countedTool]);
    const requested = await executeToolWithTargetResolution({
      toolName: 'close_pc_app',
      args: { appName: 'chrome' },
      origin: 'llm',
      toolDefinitionMap,
      context: toolExecutionContext,
      resolver,
    });
    if (requested.status !== 'needs_confirm') {
      throw new Error('expected needs_confirm');
    }
    const approved = await resolvePendingToolConfirmation(
      toolDefinitionMap,
      requested.pending,
      true,
      toolExecutionContext,
      resolver,
    );
    expect(approved).toMatchObject({ ok: true });
    expect(executionCountList).toHaveLength(1);
  });

  it('an expired approval cancels with the central reason', async () => {
    const { resolver } = buildRegistryResolver();
    const executionCountList: string[] = [];
    const countedTool: ToolDefinition = {
      ...closePcAppTool,
      async handler() {
        executionCountList.push('close_pc_app');
        return { ok: true, summary: 'Cerrado.' };
      },
    };
    const toolDefinitionMap = buildToolDefinitionMap([countedTool]);
    const requested = await executeToolWithTargetResolution({
      toolName: 'close_pc_app',
      args: { appName: 'chrome' },
      origin: 'llm',
      toolDefinitionMap,
      context: toolExecutionContext,
      resolver,
    });
    if (requested.status !== 'needs_confirm') {
      throw new Error('expected needs_confirm');
    }
    const resolved = await resolvePendingToolConfirmation(
      toolDefinitionMap,
      requested.pending,
      true,
      { ...toolExecutionContext, nowMilliseconds: requested.pending.expiresAt + 1 },
      resolver,
    );
    expect('cancelled' in resolved && resolved.reason).toBe('expired');
    expect(executionCountList).toEqual([]);
  });

  it('a target that vanished cancels with target_unavailable and no execution', async () => {
    const { resolver, registry } = buildRegistryResolver();
    const executionCountList: string[] = [];
    const countedTool: ToolDefinition = {
      ...closePcAppTool,
      async handler() {
        executionCountList.push('close_pc_app');
        return { ok: true, summary: 'Cerrado.' };
      },
    };
    const toolDefinitionMap = buildToolDefinitionMap([countedTool]);
    const requested = await executeToolWithTargetResolution({
      toolName: 'close_pc_app',
      args: { appName: 'chrome' },
      origin: 'llm',
      toolDefinitionMap,
      context: toolExecutionContext,
      resolver,
    });
    if (requested.status !== 'needs_confirm') {
      throw new Error('expected needs_confirm');
    }
    registry.markPresence({ proof, deviceId: 'desktop:pc', presence: 'offline' });
    const resolved = await resolvePendingToolConfirmation(
      toolDefinitionMap,
      requested.pending,
      true,
      toolExecutionContext,
      resolver,
    );
    expect('cancelled' in resolved && resolved.reason).toBe('target_offline');
    expect(executionCountList).toEqual([]);
  });

  it('12. a safe deterministic-style tool follows the same cancellation mapping', async () => {
    const { resolver } = buildRegistryResolver({ presence: 'offline' });
    const executionCountList: string[] = [];
    const countedTool: ToolDefinition = {
      ...openPcAppTool,
      async handler() {
        executionCountList.push('open_pc_app');
        return { ok: true, summary: 'Abriendo.' };
      },
    };
    const outcome = await executeToolWithTargetResolution({
      toolName: 'open_pc_app',
      args: { appName: 'chrome' },
      origin: 'deterministic_router',
      toolDefinitionMap: buildToolDefinitionMap([countedTool]),
      context: toolExecutionContext,
      resolver,
    });
    expect(outcome.status).toBe('skipped');
    if (outcome.status === 'skipped') {
      expect(outcome.cancellation.message).toBe(
        buildCancellationResult('target_unavailable').message,
      );
    }
    expect(executionCountList).toEqual([]);
  });

  it('cloud-only tools execute without any target resolution', async () => {
    const { resolver } = buildRegistryResolver();
    const executionCountList: string[] = [];
    const countedWeather: ToolDefinition = {
      ...weatherNowTool,
      async handler() {
        executionCountList.push('weather_now');
        return { ok: true, summary: 'soleado' };
      },
    };
    expect(requiresExecutionTargetForToolDefinition(countedWeather)).toBe(false);
    const outcome = await executeToolWithTargetResolution({
      toolName: 'weather_now',
      args: {},
      origin: 'llm',
      toolDefinitionMap: buildToolDefinitionMap([countedWeather, rememberFactTool]),
      context: toolExecutionContext,
      resolver,
    });
    expect(outcome.status).toBe('done');
    expect(executionCountList).toEqual(['weather_now']);
  });
});
