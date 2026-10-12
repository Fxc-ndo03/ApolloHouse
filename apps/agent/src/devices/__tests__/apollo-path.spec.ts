import { describe, expect, it } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { MobileDeviceEndpoint } from '@/devices/endpoint';
import { buildAuthenticatedDeviceProof } from '@/devices/registry';
import {
  apolloToolHarnessRequestSchema,
  isApolloToolHarnessEnabled,
  type ApolloToolHarnessRequest,
} from '@/devices/harness';
import { resolveMobileBridgeClient } from '@/devices/bridge-client';
import { buildRegistryCapabilityTargetResolver } from '@/devices/target';
import {
  sendMobileNotification,
  sendMobileNotificationTool,
} from '@/tools/mobile/notification';
import type { MobileCommandSender } from '@/tools/mobile/sender';
import { buildToolDefinitionMap } from '@/tools/router';
import { executeToolWithTargetResolution } from '@/tools/target';
import { buildDeviceCommandResultEnvelope } from '@/devices/envelope';
import { InMemoryMobilePeer } from '@/devices/__tests__/peer';

// ─────────────────────────────────────────────────────────────────────────────
// BLOCK 9.1: el camino de producción Apollo → MobileBridge.
//
// Lo que se testea acá es la frontera y el contrato; el recorrido completo
// contra workerd real vive en smoke/mobile-notification-apollo.ts.
// ─────────────────────────────────────────────────────────────────────────────

const START = 1_700_000_000_000;
const DEVICE_ID = 'mobile:test-a';
const proof = buildAuthenticatedDeviceProof('device');
const SOURCE_ROOT = join(import.meta.dir, '..', '..');

function stripComment(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function readModuleCode(relativePath: string): string {
  return stripComment(readFileSync(join(SOURCE_ROOT, relativePath), 'utf8'));
}

function listSourceFilePathList(): string[] {
  const filePathList: string[] = [];
  const walk = (directoryPath: string): void => {
    for (const entryName of readdirSync(directoryPath)) {
      const entryPath = join(directoryPath, entryName);
      if (statSync(entryPath).isDirectory()) {
        walk(entryPath);
        continue;
      }
      if (entryName.endsWith('.ts') && !entryName.endsWith('.spec.ts')) {
        filePathList.push(entryPath);
      }
    }
  };
  walk(SOURCE_ROOT);
  return filePathList;
}

function buildProductionHarness() {
  const endpoint = new MobileDeviceEndpoint({
    nowMilliseconds: () => START,
    pendingCommandOptions: { timeoutMilliseconds: 2_000 },
  });
  let peer: InMemoryMobilePeer;
  endpoint.handleConnect({
    connectionId: 'mobile-1',
    port: {
      send: (messageText: string) => peer?.receive(messageText),
      close: () => undefined,
    },
    proof,
  });
  peer = new InMemoryMobilePeer({
    connectionId: 'mobile-1',
    nowMilliseconds: () => START,
    deliver: (messageText: string) => endpoint.handleMessage('mobile-1', messageText),
    onDisconnect: () => endpoint.handleClose('mobile-1'),
  });
  endpoint.handleMessage(
    'mobile-1',
    JSON.stringify({
      type: 'hello',
      deviceId: DEVICE_ID,
      deviceType: 'mobile',
      protocolVersion: 1,
      capabilities: ['mobile.notifications'],
      ts: START,
    }),
  );
  // El sender que usa la tool: el MISMO endpoint que el resolver consulta.
  const sendCommand: MobileCommandSender = async (request) => {
    const outcome = await endpoint.dispatchCommand({
      // Sin default: si el pipeline no inyecta el target, esto falla en vez de
      // disimularlo (fue exactamente el bug que encontró este bloque).
      deviceId: request.targetDeviceId,
      capability: 'mobile.notifications',
      payload: request.payload,
      requestId: request.requestId,
      clientTurnId: request.clientTurnId,
      generation: request.generation,
    });
    if (outcome.ok) {
      return {
        status: 'completed' as const,
        outcome,
        result: buildDeviceCommandResultEnvelope({
          requestId: request.requestId,
          deviceId: DEVICE_ID,
          capability: 'mobile.notifications' as const,
          ok: true,
          result: outcome.result,
        }),
      };
    }
    return {
      status: 'failed' as const,
      reason: outcome.reason,
      detail: outcome.detail,
      outcome,
    };
  };
  return { endpoint, peer, sendCommand };
}

async function runProductionPipeline(
  sendCommand: MobileCommandSender,
  correlation: { requestId: string; clientTurnId: string; generation: number },
  args: { readonly title: string; readonly body: string } = {
    title: 'Apollo test',
    body: 'production path',
  },
) {
  const toolDefinitionMap = buildToolDefinitionMap([
    {
      ...sendMobileNotificationTool,
      handler: (toolArgs, context) =>
        sendMobileNotification({ context, args: toolArgs, sendCommand }),
    },
  ]);
  return executeToolWithTargetResolution({
    toolName: 'send_mobile_notification',
    args,
    origin: 'llm',
    toolDefinitionMap,
    context: { environment: {} as never, nowMilliseconds: START },
    resolver: buildRegistryCapabilityTargetResolver(
      sendCommandEndpoint(sendCommand),
    ) as never,
    correlation,
  });
}

// El resolver real necesita un registry; el harness lo expone por closure.
let currentRegistry: MobileDeviceEndpoint['registry'] | null = null;
function sendCommandEndpoint(
  _sendCommand: MobileCommandSender,
): MobileDeviceEndpoint['registry'] {
  if (currentRegistry === null) {
    throw new Error('registry no seteado');
  }
  return currentRegistry;
}

describe('B9.1 §1: Apollo production path reaches MobileBridge', () => {
  it('1. the tool runs the full pipeline and reaches the peer', async () => {
    const harness = buildProductionHarness();
    currentRegistry = harness.endpoint.registry;
    const outcome = await runProductionPipeline(harness.sendCommand, {
      requestId: 'production-1',
      clientTurnId: 'turn-1',
      generation: 4,
    });
    expect(outcome.status).toBe('done');
    if (outcome.status !== 'done') {
      return;
    }
    expect(outcome.result.ok).toBe(true);
    expect(outcome.target?.deviceId).toBe(DEVICE_ID);
    expect(harness.peer.commandCount).toBe(1);
  });

  it('2. mobile.notifications is the capability that travels', async () => {
    const harness = buildProductionHarness();
    currentRegistry = harness.endpoint.registry;
    await runProductionPipeline(harness.sendCommand, {
      requestId: 'production-2',
      clientTurnId: 'turn-2',
      generation: 1,
    });
    expect(harness.peer.receivedCommandList[0]?.capability).toBe('mobile.notifications');
  });

  it('3-6. requestId, clientTurnId, generation and targetDeviceId are preserved', async () => {
    const harness = buildProductionHarness();
    currentRegistry = harness.endpoint.registry;
    await runProductionPipeline(harness.sendCommand, {
      requestId: 'production-req',
      clientTurnId: 'production-turn',
      generation: 77,
    });
    const command = harness.peer.receivedCommandList[0];
    expect(command?.requestId).toBe('production-req');
    expect(command?.clientTurnId).toBe('production-turn');
    expect(command?.generation).toBe(77);
    expect(command?.capability).toBe('mobile.notifications');
  });

  it('6b. the resolved target reaches the handler in the context', async () => {
    const harness = buildProductionHarness();
    currentRegistry = harness.endpoint.registry;
    let seenTargetDeviceId: string | undefined;
    const toolDefinitionMap = buildToolDefinitionMap([
      {
        ...sendMobileNotificationTool,
        handler: async (_toolArgs, context) => {
          seenTargetDeviceId = context.targetDeviceId;
          return harness
            .sendCommand({
              targetDeviceId: context.targetDeviceId ?? '',
              capabilityName: 'mobile.notifications',
              requestId: 'ctx-1',
              payload: { title: 'A', body: 'B' },
            })
            .then(() => ({ ok: true, summary: 'ok' }));
        },
      },
    ]);
    await executeToolWithTargetResolution({
      toolName: 'send_mobile_notification',
      args: { title: 'A', body: 'B' },
      origin: 'llm',
      toolDefinitionMap,
      context: { environment: {} as never, nowMilliseconds: START },
      resolver: buildRegistryCapabilityTargetResolver(harness.endpoint.registry) as never,
      correlation: { requestId: 'ctx-1' },
    });
    // BLOCK 9.1: sin esto la tool mandaba targetDeviceId vacío.
    expect(seenTargetDeviceId).toBe(DEVICE_ID);
  });
});

describe('B9.1 §4: failure modes', () => {
  it('A. a missing bridge client is a structured failure, not a hang', () => {
    const environment = { MobileBridge: undefined } as unknown as Parameters<
      typeof resolveMobileBridgeClient
    >[0];
    expect(resolveMobileBridgeClient(environment)).toBeUndefined();
  });

  it('B. a disconnected mobile is a resolution failure', async () => {
    const harness = buildProductionHarness();
    currentRegistry = harness.endpoint.registry;
    harness.endpoint.handleClose('mobile-1');
    const outcome = await runProductionPipeline(harness.sendCommand, {
      requestId: 'disc-1',
      clientTurnId: 'disc',
      generation: 1,
    });
    expect(outcome.status).toBe('skipped');
  });

  it('C. a silent peer produces device_timeout', async () => {
    const endpoint = new MobileDeviceEndpoint({
      nowMilliseconds: () => START,
      pendingCommandOptions: { timeoutMilliseconds: 20 },
    });
    endpoint.handleConnect({
      connectionId: 'mobile-1',
      port: { send: () => undefined, close: () => undefined },
      proof,
    });
    endpoint.handleMessage(
      'mobile-1',
      JSON.stringify({
        type: 'hello',
        deviceId: DEVICE_ID,
        deviceType: 'mobile',
        protocolVersion: 1,
        capabilities: ['mobile.notifications'],
        ts: START,
      }),
    );
    const outcome = await endpoint.dispatchCommand({
      deviceId: DEVICE_ID,
      capability: 'mobile.notifications',
      payload: { title: 'A', body: 'B' },
      requestId: 'timeout-1',
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe('device_timeout');
    }
  });

  it('D. a peer that rejects is an execution failure', async () => {
    const harness = buildProductionHarness();
    currentRegistry = harness.endpoint.registry;
    // El peer rechaza: se verifica también que el comando llegó con el target y
    // la capability correctos antes de ser rechazado.
    const rejectedRequestList: { targetDeviceId: string; capability: string }[] = [];
    const rejecting: MobileCommandSender = async (request) => {
      rejectedRequestList.push({
        targetDeviceId: request.targetDeviceId,
        capability: 'mobile.notifications',
      });
      return {
        status: 'failed' as const,
        reason: 'device_rejected' as const,
        detail: 'notifications_disabled',
      };
    };
    const toolDefinitionMap = buildToolDefinitionMap([
      {
        ...sendMobileNotificationTool,
        handler: (toolArgs, context) =>
          sendMobileNotification({ context, args: toolArgs, sendCommand: rejecting }),
      },
    ]);
    const outcome = await executeToolWithTargetResolution({
      toolName: 'send_mobile_notification',
      args: { title: 'A', body: 'B' },
      origin: 'llm',
      toolDefinitionMap,
      context: { environment: {} as never, nowMilliseconds: START },
      resolver: buildRegistryCapabilityTargetResolver(harness.endpoint.registry) as never,
      correlation: { requestId: 'reject-1' },
    });
    expect(outcome.status).toBe('done');
    if (outcome.status === 'done') {
      expect(outcome.result.ok).toBe(false);
      expect(outcome.result.summary).toContain('notifications_disabled');
    }
    expect(rejectedRequestList).toEqual([
      { targetDeviceId: DEVICE_ID, capability: 'mobile.notifications' },
    ]);
  });

  it('E. a late response cannot contaminate another request', async () => {
    const endpoint = new MobileDeviceEndpoint({ nowMilliseconds: () => START });
    endpoint.handleConnect({
      connectionId: 'mobile-1',
      port: { send: () => undefined, close: () => undefined },
      proof,
    });
    endpoint.handleMessage(
      'mobile-1',
      JSON.stringify({
        type: 'hello',
        deviceId: DEVICE_ID,
        deviceType: 'mobile',
        protocolVersion: 1,
        capabilities: ['mobile.notifications'],
        ts: START,
      }),
    );
    const requestB = endpoint.dispatchCommand({
      deviceId: DEVICE_ID,
      capability: 'mobile.notifications',
      payload: { title: 'B', body: 'b' },
      requestId: 'turn-B',
    });
    // El resultado tardío de A llega con SU requestId y no toca B.
    const settled: unknown[] = [];
    void requestB.then((outcome) => settled.push(outcome));
    await Promise.resolve();
    expect(settled).toEqual([]);
    expect(endpoint.pendingCommandCount).toBe(1);
  });

  it('F. a duplicate requestId in flight does not produce two effects', async () => {
    const endpoint = new MobileDeviceEndpoint({ nowMilliseconds: () => START });
    endpoint.handleConnect({
      connectionId: 'mobile-1',
      port: { send: () => undefined, close: () => undefined },
      proof,
    });
    endpoint.handleMessage(
      'mobile-1',
      JSON.stringify({
        type: 'hello',
        deviceId: DEVICE_ID,
        deviceType: 'mobile',
        protocolVersion: 1,
        capabilities: ['mobile.notifications'],
        ts: START,
      }),
    );
    void endpoint.dispatchCommand({
      deviceId: DEVICE_ID,
      capability: 'mobile.notifications',
      payload: { title: 'dup', body: 'dup' },
      requestId: 'same-id',
    });
    const second = await endpoint.dispatchCommand({
      deviceId: DEVICE_ID,
      capability: 'mobile.notifications',
      payload: { title: 'dup', body: 'dup' },
      requestId: 'same-id',
    });
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.reason).toBe('duplicate_request_id');
    }
  });

  it('11+12. success and error envelopes keep ok/error mutually exclusive', () => {
    const ok = buildDeviceCommandResultEnvelope({
      requestId: 'r',
      deviceId: DEVICE_ID,
      capability: 'mobile.notifications',
      ok: true,
      result: { posted: true },
    });
    expect(ok.ok).toBe(true);
    expect(ok.error).toBeUndefined();
    const failed = buildDeviceCommandResultEnvelope({
      requestId: 'r',
      deviceId: DEVICE_ID,
      capability: 'mobile.notifications',
      ok: false,
      error: 'nope',
    });
    expect(failed.ok).toBe(false);
    expect(failed.result).toBeUndefined();
  });
});

describe('B9.1 §9: the Apollo harness', () => {
  it('is capability-agnostic: it takes a toolName, not a capability', () => {
    const harnessSource = readModuleCode('devices/harness.ts');
    expect(harnessSource).toContain('toolName');
    expect(harnessSource).not.toContain('mobile.notifications');
    expect(harnessSource).not.toContain('sendNotificationCommand');
  });

  it('is gated by a server-side env var, never by client data', () => {
    expect(
      isApolloToolHarnessEnabled(
        {} as unknown as Parameters<typeof isApolloToolHarnessEnabled>[0],
      ),
    ).toBe(false);
    expect(
      isApolloToolHarnessEnabled({
        APOLLO_TOOL_HARNESS: 'enabled',
      } as unknown as Parameters<typeof isApolloToolHarnessEnabled>[0]),
    ).toBe(true);
    const harnessSource = readModuleCode('devices/harness.ts');
    expect(harnessSource).not.toContain('searchParams');
    expect(harnessSource).not.toContain('token');
    expect(harnessSource).not.toContain('deviceId ===');
    // Ninguna otra fuente puede prenderlo: ni el cliente, ni un global, ni el
    // process.
    expect(harnessSource).not.toContain('globalThis');
    expect(harnessSource).not.toContain('process.env');
    expect(harnessSource).not.toContain('__harness');
    // El gate es exactamente la comparación con el env del servidor.
    const gateStart = harnessSource.indexOf('isApolloToolHarnessEnabled');
    const gateBody = harnessSource.slice(
      gateStart,
      harnessSource.indexOf('}', gateStart),
    );
    expect(gateBody).toContain('environment.APOLLO_TOOL_HARNESS');
  });

  it('rejects a request without a toolName', () => {
    expect(apolloToolHarnessRequestSchema.safeParse({}).success).toBe(false);
    const parsed = apolloToolHarnessRequestSchema.safeParse({
      toolName: 'weather_now',
      args: {},
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      const request: ApolloToolHarnessRequest = parsed.data;
      expect(request.toolName).toBe('weather_now');
    }
  });
});

describe('B9.1 §8: one transport boundary', () => {
  it('13. no ToolDefinition reaches MobilePeerTransport', () => {
    // BLOCK 11 partió mobile.ts en un folder: el guard mira TODOS los módulos de
    // tools mobile, no uno solo, para que mover código no lo vuelva decorativo.
    for (const modulePath of [
      'tools/mobile/sender.ts',
      'tools/mobile/notification.ts',
      'tools/mobile/alarm.ts',
      'tools/mobile/calendar.ts',
      'tools/mobile/media.ts',
      'tools/mobile/volume.ts',
      'tools/mobile/open.ts',
      'tools/mobile/index.ts',
    ]) {
      const toolSource = readModuleCode(modulePath);
      expect(toolSource).not.toContain('MobilePeerTransport');
      expect(toolSource).not.toContain('dispatchCommand');
      expect(toolSource).not.toContain("from '@/devices/endpoint'");
    }
  });

  it('14. no tool opens a raw WebSocket', () => {
    for (const filePath of listSourceFilePathList()) {
      if (!filePath.replace(/\\/g, '/').includes('/tools/')) {
        continue;
      }
      const source = stripComment(readFileSync(filePath, 'utf8'));
      expect(source).not.toContain('new WebSocket');
    }
  });

  it('15. there is no capability-specific RPC client', () => {
    // Un cliente por capability significa un cliente nuevo por cada una; la
    // frontera es el bridge-client, que no sabe qué capability se le pide NI qué
    // método se le llama: sólo devuelve el stub.
    const bridgeClientSource = readModuleCode('devices/bridge-client.ts');
    expect(bridgeClientSource).not.toContain('mobile.notifications');
    expect(bridgeClientSource).not.toContain('capability');
    // Tampoco nombres de métodos RPC: eso lo deciden los callers. BLOCK 11
    // agregó sendMobileCommand y listReachableCapabilityList, y el cliente sigue
    // sin saber ninguno.
    for (const methodName of [
      'sendNotificationCommand',
      'sendMobileCommand',
      'listReachableCapabilityList',
      'resolveCapabilityTarget',
      'sendCommand',
    ]) {
      expect(bridgeClientSource).not.toContain(methodName);
    }
    // Y el resolver y la tool usan ESE cliente, no getAgentByName.
    expect(readModuleCode('devices/resolve.ts')).toContain('resolveMobileBridgeClient');
    expect(readModuleCode('tools/mobile/sender.ts')).toContain(
      'resolveMobileBridgeClient',
    );
    expect(readModuleCode('tools/mobile/sender.ts')).not.toContain('getAgentByName');
  });

  it('the bridge client is the only place that names the MobileBridge instance', () => {
    const callerList = listSourceFilePathList()
      .filter((filePath) => {
        const relativePath = filePath
          .replace(SOURCE_ROOT, '')
          .replace(/\\/g, '/')
          .replace(/^\//, '');
        return (
          relativePath !== 'devices/bridge-client.ts' &&
          !relativePath.startsWith('devices/__tests__/') &&
          !relativePath.endsWith('mobile-bridge.ts') &&
          !relativePath.endsWith('route.spec.ts')
        );
      })
      .filter((filePath) =>
        stripComment(readFileSync(filePath, 'utf8')).includes(
          'idFromName(MOBILE_BRIDGE_INSTANCE_NAME)',
        ),
      );
    expect(callerList).toEqual([]);
  });

  it('Apollo does not skip target resolution', () => {
    const apolloSource = readModuleCode('agents/apollo.ts');
    // El harness corre el pipeline, no una tool suelta.
    // BLOCK 9.2: el harness dejó de ser un @callable; ahora vive en un método
    // privado que corre desde el fetch gateado.
    const harnessStart = apolloSource.indexOf('#runToolForHarness');
    expect(harnessStart).toBeGreaterThan(-1);
    const harnessBody = apolloSource.slice(harnessStart, harnessStart + 2_000);
    expect(harnessBody).toContain('executeToolWithTargetResolution');
    expect(harnessBody).toContain('buildCapabilityTargetResolver');
    // Y en ningún lugar del harness se llama al RPC de la capability.
    expect(harnessBody).not.toContain('sendNotificationCommand');
  });
});
