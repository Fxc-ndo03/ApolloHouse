import { describe, expect, it } from 'bun:test';

import { MobileDeviceEndpoint } from '@/devices/endpoint';
import { buildAuthenticatedDeviceProof, CapabilityRegistry } from '@/devices/registry';
import { buildRegistryCapabilityTargetResolver } from '@/devices/target';
import { mobileTargetPreference } from '@/devices/schema';
import type { CapabilityName } from '@/devices/capability';
import { PendingCommandRegistry } from '@/devices/dispatch';
import {
  buildDeviceCommandEnvelope,
  buildDeviceCommandResultEnvelope,
} from '@/devices/envelope';
import {
  sendMobileNotification,
  sendMobileNotificationTool,
} from '@/tools/mobile/notification';
import type { MobileCommandSender } from '@/tools/mobile/sender';
import { buildToolDefinitionMap } from '@/tools/router';
import { executeToolWithTargetResolution } from '@/tools/target';
import {
  describeCapability,
  listImplementedCapabilityNameList,
} from '@/devices/capability';
import { mobileNotificationPayloadSchema } from '@/protocol/schema';
import { InMemoryMobilePeer, type MobilePeerBehavior } from '@/devices/__tests__/peer';
import type { ToolExecutionContext } from '@/tools/types';

// ─────────────────────────────────────────────────────────────────────────────
// BLOCK 9: mobile.notifications de punta a punta.
//
// El camino completo —tool → target → authorize → transport → peer → result—
// se ejercita con piezas reales: registry real, resolver real, pipeline real de
// ejecución, endpoint real, transporte real y peer que habla el protocolo real.
// Lo único inyectado es el socket (el peer) y el reloj del timeout.
// ─────────────────────────────────────────────────────────────────────────────

const START = 1_700_000_000_000;
const DEVICE_ID = 'mobile:test-a';
const proof = buildAuthenticatedDeviceProof('device');

type Harness = {
  readonly endpoint: MobileDeviceEndpoint;
  readonly peer: InMemoryMobilePeer;
  readonly sentMessageList: string[];
  readonly setNow: (value: number) => void;
};

function buildHarness(
  options: {
    readonly behavior?: MobilePeerBehavior;
    readonly respondDelayMilliseconds?: number;
    readonly deviceId?: string;
    readonly deviceType?: 'mobile' | 'desktop';
  } = {},
): Harness {
  let now = START;
  const sentMessageList: string[] = [];
  let peer: InMemoryMobilePeer;
  const endpoint = new MobileDeviceEndpoint({
    nowMilliseconds: () => now,
    pendingCommandOptions: {
      timeoutMilliseconds: 2_000,
      timeoutPort: {
        setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
        clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      },
    },
  });
  endpoint.handleConnect({
    connectionId: 'mobile-1',
    port: {
      send: (messageText: string) => {
        sentMessageList.push(messageText);
        peer?.receive(messageText);
      },
      close: () => undefined,
    },
    proof,
  });
  peer = new InMemoryMobilePeer({
    connectionId: 'mobile-1',
    nowMilliseconds: () => now,
    deliver: (messageText: string) => endpoint.handleMessage('mobile-1', messageText),
    onDisconnect: () => endpoint.handleClose('mobile-1'),
    behavior: options.behavior,
    respondDelayMilliseconds: options.respondDelayMilliseconds,
  });
  endpoint.handleMessage(
    'mobile-1',
    JSON.stringify({
      type: 'hello',
      deviceId: options.deviceId ?? DEVICE_ID,
      deviceType: options.deviceType ?? 'mobile',
      protocolVersion: 1,
      capabilities: ['mobile.notifications'],
      ts: START,
    }),
  );
  return {
    endpoint,
    peer,
    sentMessageList,
    setNow: (value: number) => (now = value),
  };
}

// El sender que usa la tool en el test vertical: el MISMO endpoint que el DO
// invoca, sin la hop de Durable Object (que es la que cubre el smoke real).
function buildEndpointCommandSender(
  harness: Harness,
  deviceId: string,
  capabilityName: CapabilityName = 'mobile.notifications',
) {
  return async (request: Parameters<MobileCommandSender>[0]) => {
    const outcome = await harness.endpoint.dispatchCommand({
      deviceId: request.targetDeviceId === '' ? deviceId : request.targetDeviceId,
      capability: capabilityName,
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
          deviceId,
          capability: capabilityName,
          ok: true,
          result: outcome.result,
        }),
      };
    }
    // Mismo contrato que el RPC real: reason y detail van planos.
    return {
      status: 'failed' as const,
      reason: outcome.reason,
      detail: outcome.detail,
      outcome,
    };
  };
}

function buildToolExecutionContext(input: {
  readonly deviceId?: string;
  readonly requestId?: string;
  readonly clientTurnId?: string;
  readonly generation?: number;
}): ToolExecutionContext {
  return {
    environment: {} as unknown as ToolExecutionContext['environment'],
    nowMilliseconds: START,
    ...(input.deviceId === undefined ? {} : { deviceId: input.deviceId }),
    ...(input.requestId === undefined
      ? {}
      : {
          correlation: {
            requestId: input.requestId,
            clientTurnId: input.clientTurnId,
            generation: input.generation,
          },
        }),
  };
}

describe('B9 §1: capability catalog', () => {
  it('1. mobile.notifications stays implemented and has its own command', () => {
    expect(describeCapability('mobile.notifications').status).toBe('implemented');
    expect(describeCapability('mobile.notifications').commandList).toEqual([
      'notification_post',
    ]);
    // BLOCK 11 agregó las otras cinco mobile con comando real.
    expect(
      listImplementedCapabilityNameList().filter((name) => name.startsWith('mobile.')),
    ).toEqual([
      'mobile.open_app',
      'mobile.notifications',
      'mobile.alarm',
      'mobile.calendar',
      'mobile.media',
      'mobile.volume',
    ]);
  });
});

describe('B9 §3: target resolution', () => {
  it('2. a desktop can never resolve mobile.notifications', () => {
    const registry = new CapabilityRegistry({ nowMilliseconds: () => START });
    registry.register({
      proof,
      deviceId: 'desktop:pc',
      deviceType: 'desktop',
      capabilityNameList: ['desktop.open_app', 'mobile.notifications'],
      protocolVersion: 1,
      lastSeenAt: START,
      transport: { transportKind: 'pc_bridge', connectionId: 'desktop:pc' },
    });
    const resolution = registry.resolveTarget({
      capabilityName: 'mobile.notifications',
      targetPreference: { kind: 'any' },
    });
    // El desktop no puede declarar una capability mobile: el handshake mobile
    // filtra por deviceType y el registry no mezcla.
    expect(resolution.status).toBe('unavailable');
  });

  it('3. the mobile target resolves to the mobile device', () => {
    const harness = buildHarness();
    const resolution = harness.endpoint.registry.resolveTarget({
      capabilityName: 'mobile.notifications',
      targetPreference: mobileTargetPreference,
    });
    expect(resolution.status).toBe('resolved');
    if (resolution.status === 'resolved') {
      expect(resolution.device.deviceId).toBe(DEVICE_ID);
      expect(resolution.device.deviceType).toBe('mobile');
    }
  });

  it('4. no mobile device at all reports no_device', () => {
    const registry = new CapabilityRegistry({ nowMilliseconds: () => START });
    const resolution = registry.resolveTarget({
      capabilityName: 'mobile.notifications',
      targetPreference: mobileTargetPreference,
    });
    expect(resolution.status).toBe('unavailable');
    if (resolution.status === 'unavailable') {
      expect(resolution.reason).toBe('no_device');
    }
  });

  it('5. an offline mobile device is not selectable', () => {
    const harness = buildHarness();
    harness.endpoint.handleClose('mobile-1');
    const resolution = harness.endpoint.registry.resolveTarget({
      capabilityName: 'mobile.notifications',
      targetPreference: mobileTargetPreference,
    });
    expect(resolution.status).toBe('unavailable');
    if (resolution.status === 'unavailable') {
      expect(resolution.reason).toBe('target_unavailable');
    }
  });
});

describe('B9 §2+6: tool definition and payload', () => {
  it('6. the ToolDefinition declares its executionTarget', () => {
    expect(sendMobileNotificationTool.executionTarget).toEqual({
      kind: 'capability',
      capabilityName: 'mobile.notifications',
    });
    expect(sendMobileNotificationTool.name).toBe('send_mobile_notification');
  });

  it('7. a valid payload passes the schema', () => {
    expect(
      mobileNotificationPayloadSchema.safeParse({ title: 'Apollo', body: 'Hola' })
        .success,
    ).toBe(true);
  });

  it('8. an invalid payload is rejected', () => {
    for (const invalid of [
      { title: '', body: 'Hola' },
      { title: 'Apollo', body: '' },
      { title: 'Apollo' },
      { body: 'Hola' },
      { title: 'Apollo', body: 'Hola', extra: 'no' },
      null,
    ]) {
      expect(mobileNotificationPayloadSchema.safeParse(invalid).success).toBe(false);
    }
  });
});

describe('B9 §4+6: envelopes', () => {
  it('9. the command envelope has the canonical shape', () => {
    const envelope = buildDeviceCommandEnvelope({
      requestId: 'request-1',
      clientTurnId: 'turn-1',
      generation: 4,
      capability: 'mobile.notifications',
      targetDeviceId: DEVICE_ID,
      payload: { title: 'Apollo', body: 'Hola' },
    });
    // `command` es opcional (BLOCK 11 §4): sin él, el peer usa el canónico de la
    // capability, que es lo que hacían los peers de Block 9.
    expect(Object.keys(envelope).toSorted()).toEqual([
      'capability',
      'clientTurnId',
      'command',
      'generation',
      'payload',
      'requestId',
      'targetDeviceId',
    ]);
    expect(envelope.command).toBeUndefined();
  });

  it('9b. the command envelope can carry an explicit command', () => {
    const envelope = buildDeviceCommandEnvelope({
      requestId: 'request-1',
      capability: 'mobile.alarm',
      command: 'alarm_cancel',
      targetDeviceId: DEVICE_ID,
      payload: { label: 'Despertar' },
    });
    expect(envelope.command).toBe('alarm_cancel');
  });

  it('10. a success result envelope carries ok and no error', () => {
    const envelope = buildDeviceCommandResultEnvelope({
      requestId: 'request-1',
      deviceId: DEVICE_ID,
      capability: 'mobile.notifications',
      ok: true,
      result: { posted: true },
    });
    expect(envelope.ok).toBe(true);
    expect(envelope.error).toBeUndefined();
    expect(envelope.result).toEqual({ posted: true });
  });

  it('11. an error result envelope carries error and no result', () => {
    const envelope = buildDeviceCommandResultEnvelope({
      requestId: 'request-1',
      deviceId: DEVICE_ID,
      capability: 'mobile.notifications',
      ok: false,
      error: 'notifications_disabled',
    });
    expect(envelope.ok).toBe(false);
    expect(envelope.error).toBe('notifications_disabled');
    expect(envelope.result).toBeUndefined();
  });

  it('12-15. requestId, clientTurnId, generation and deviceId are preserved', async () => {
    const harness = buildHarness();
    const pending = harness.endpoint.dispatchCommand({
      deviceId: DEVICE_ID,
      capability: 'mobile.notifications',
      payload: { title: 'Apollo', body: 'Hola' },
      requestId: 'request-xyz',
      clientTurnId: 'turn-xyz',
      generation: 9,
    });
    await Promise.resolve();
    const command = harness.peer.receivedCommandList[0];
    expect(command?.requestId).toBe('request-xyz');
    expect(command?.clientTurnId).toBe('turn-xyz');
    expect(command?.generation).toBe(9);
    expect(command?.capability).toBe('mobile.notifications');
    expect(await pending).toEqual({ ok: true, result: { posted: true } });
  });
});

describe('B9 §9: disconnect during execution', () => {
  it('16. a disconnect mid-command resolves as disconnected, never hangs', async () => {
    const harness = buildHarness({ behavior: 'disconnect' });
    const outcome = await harness.endpoint.dispatchCommand({
      deviceId: DEVICE_ID,
      capability: 'mobile.notifications',
      payload: { title: 'Apollo', body: 'Hola' },
      requestId: 'request-1',
    });
    expect(outcome).toEqual({
      ok: false,
      reason: 'device_disconnected',
      detail: 'El device se desconectó antes de responder.',
    });
    // No queda ningún waiter huérfano.
    expect(harness.endpoint.pendingCommandCount).toBe(0);
  });

  it('a disconnect leaves the other mobile untouched', async () => {
    const harness = buildHarness();
    const other = harness.endpoint.handleConnect({
      connectionId: 'mobile-2',
      port: { send: () => undefined, close: () => undefined },
      proof,
    });
    expect(other.isConnected).toBe(true);
    harness.endpoint.handleClose('mobile-1');
    expect(harness.endpoint.registry.getDevice(DEVICE_ID)?.presence).toBe('offline');
  });
});

describe('B9 §10: timeout', () => {
  it('17. a silent device produces a structured timeout, not a hang', async () => {
    const harness = buildHarness({ behavior: 'ignore' });
    const outcome = await harness.endpoint.dispatchCommand({
      deviceId: DEVICE_ID,
      capability: 'mobile.notifications',
      payload: { title: 'Apollo', body: 'Hola' },
      requestId: 'request-1',
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      // Un failure de EJECUCIÓN, no de resolución: no se confunde con
      // target_offline, capability_absent ni unimplemented.
      expect(outcome.reason).toBe('device_timeout');
      expect(outcome.detail).toContain('2000ms');
    }
    expect(harness.endpoint.pendingCommandCount).toBe(0);
  });

  it('the timeout is centralized and testable without sleeps', async () => {
    const outcomes: string[] = [];
    const registry = new PendingCommandRegistry({
      timeoutMilliseconds: 5,
      timeoutPort: {
        setTimeout: (callback) => {
          queueMicrotask(callback);
          return 1;
        },
        clearTimeout: () => undefined,
      },
    });
    const outcome = await registry.register({
      envelope: buildDeviceCommandEnvelope({
        requestId: 'r-1',
        capability: 'mobile.notifications',
        targetDeviceId: 'mobile:x',
        payload: {},
      }),
      send: () => undefined,
    });
    if (!outcome.ok) {
      outcomes.push(outcome.reason);
    }
    expect(outcomes).toEqual(['device_timeout']);
  });
});

describe('B9 §11: duplicate request id', () => {
  it('18. the same requestId twice does not produce two effects', async () => {
    const harness = buildHarness({ behavior: 'ignore' });
    const first = harness.endpoint.dispatchCommand({
      deviceId: DEVICE_ID,
      capability: 'mobile.notifications',
      payload: { title: 'Apollo', body: 'Hola' },
      requestId: 'request-dup',
    });
    await Promise.resolve();
    const second = await harness.endpoint.dispatchCommand({
      deviceId: DEVICE_ID,
      capability: 'mobile.notifications',
      payload: { title: 'Apollo', body: 'Hola' },
      requestId: 'request-dup',
    });
    // El peer recibió un solo comando.
    expect(harness.peer.commandCount).toBe(1);
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.reason).toBe('duplicate_request_id');
    }
    void first;
  });
});

describe('B9 §8: correlation isolation', () => {
  it('19. a late result from turn A never completes turn B', async () => {
    const registry = new PendingCommandRegistry({
      timeoutMilliseconds: 60_000,
      timeoutPort: { setTimeout: () => 1, clearTimeout: () => undefined },
    });
    const buildPending = (requestId: string) =>
      registry.register({
        envelope: buildDeviceCommandEnvelope({
          requestId,
          capability: 'mobile.notifications',
          targetDeviceId: DEVICE_ID,
          payload: {},
        }),
        send: () => undefined,
      });
    const turnA = buildPending('turn-a-request');
    const turnB = buildPending('turn-b-request');

    // El resultado tardío de A llega con su requestId y no toca B.
    expect(
      registry.settleByRequestId('turn-a-request', {
        requestId: 'turn-a-request',
        deviceId: DEVICE_ID,
        capability: 'mobile.notifications',
        ok: true,
        result: { posted: 'A' },
      }),
    ).toBe(true);
    expect(await turnA).toEqual({ ok: true, result: { posted: 'A' } });
    // B sigue pendiente: no se resolvió por el resultado de A.
    expect(registry.isPending('turn-b-request')).toBe(true);
    const settledB: unknown[] = [];
    void turnB.then((outcome) => settledB.push(outcome));
    await Promise.resolve();
    expect(settledB).toEqual([]);

    expect(
      registry.settleByRequestId('turn-b-request', {
        requestId: 'turn-b-request',
        deviceId: DEVICE_ID,
        capability: 'mobile.notifications',
        ok: true,
        result: { posted: 'B' },
      }),
    ).toBe(true);
    expect(await turnB).toEqual({ ok: true, result: { posted: 'B' } });
  });

  it('19b. a result settles the request it names, not the first one in flight', async () => {
    const registry = new PendingCommandRegistry({
      timeoutMilliseconds: 60_000,
      timeoutPort: { setTimeout: () => 1, clearTimeout: () => undefined },
    });
    const register = (requestId: string) =>
      registry.register({
        envelope: buildDeviceCommandEnvelope({
          requestId,
          capability: 'mobile.notifications',
          targetDeviceId: DEVICE_ID,
          payload: {},
        }),
        send: () => undefined,
      });

    // Se registra B PRIMERO a propósito: si la correlación no fuera por
    // requestId, el resultado de A resolvería el comando de B.
    const turnB = register('turn-b-request');
    const turnA = register('turn-a-request');

    registry.settleByRequestId('turn-a-request', {
      requestId: 'turn-a-request',
      deviceId: DEVICE_ID,
      capability: 'mobile.notifications',
      ok: true,
      result: { posted: 'A' },
    });
    expect(await turnA).toEqual({ ok: true, result: { posted: 'A' } });
    // B sigue esperando SU resultado.
    expect(registry.isPending('turn-b-request')).toBe(true);
    expect(registry.isPending('turn-a-request')).toBe(false);

    registry.settleByRequestId('turn-b-request', {
      requestId: 'turn-b-request',
      deviceId: DEVICE_ID,
      capability: 'mobile.notifications',
      ok: true,
      result: { posted: 'B' },
    });
    expect(await turnB).toEqual({ ok: true, result: { posted: 'B' } });
  });

  it('a result for an unknown requestId is discarded', () => {
    const registry = new PendingCommandRegistry({
      timeoutMilliseconds: 60_000,
      timeoutPort: { setTimeout: () => 1, clearTimeout: () => undefined },
    });
    expect(registry.settleByRequestId('nope', { anything: true })).toBe(false);
  });
});

describe('B9 §14: vertical test — tool to peer and back', () => {
  it('20. tool → target → authorize → transport → peer → result', async () => {
    const harness = buildHarness();
    const sendCommand = buildEndpointCommandSender(harness, DEVICE_ID);

    // El resolver que usa el runtime, con el registry real del endpoint.
    const resolver = async (input: {
      readonly capabilityName: 'mobile.notifications';
      readonly targetPreference: {
        readonly kind: 'device_type';
        readonly deviceType: 'mobile';
      };
    }) => {
      const registryResolver = buildRegistryCapabilityTargetResolver(
        harness.endpoint.registry,
      );
      return registryResolver(input);
    };

    // Misma ToolDefinition y mismo handler lógico; lo único que cambia es el
    // puerto de envío, porque la hop real es el RPC de Cloudflare (que cubre el
    // smoke). Todo lo demás —pipeline, autorización, endpoint, transporte y
    // peer— es el de producción.
    const toolDefinitionMapWithPort = buildToolDefinitionMap([
      {
        ...sendMobileNotificationTool,
        handler: (args, context) =>
          sendMobileNotification({ context, args, sendCommand }),
      },
    ]);
    const outcome = await executeToolWithTargetResolution({
      toolName: 'send_mobile_notification',
      args: { title: 'Apollo', body: 'Llegaste' },
      origin: 'llm',
      toolDefinitionMap: toolDefinitionMapWithPort,
      context: buildToolExecutionContext({
        requestId: 'request-vertical',
        clientTurnId: 'turn-vertical',
        generation: 3,
      }),
      resolver: resolver as never,
      correlation: {
        requestId: 'request-vertical',
        clientTurnId: 'turn-vertical',
        generation: 3,
      },
    });

    expect(outcome.status).toBe('done');
    if (outcome.status !== 'done') {
      return;
    }
    expect(outcome.target?.deviceId).toBe(DEVICE_ID);
    expect(outcome.result.ok).toBe(true);
    expect(harness.peer.commandCount).toBe(1);
    expect(harness.peer.receivedCommandList[0]?.requestId).toBe('request-vertical');
    expect(harness.peer.receivedCommandList[0]?.clientTurnId).toBe('turn-vertical');
    expect(harness.peer.receivedCommandList[0]?.generation).toBe(3);
    expect(harness.peer.receivedCommandList[0]?.payload).toEqual({
      title: 'Apollo',
      body: 'Llegaste',
    });
  });

  it('21. the full pipeline surfaces a tool error when the device disconnects', async () => {
    const harness = buildHarness({ behavior: 'disconnect' });
    const sendCommand: MobileCommandSender = buildEndpointCommandSender(
      harness,
      DEVICE_ID,
    );
    const toolDefinitionMap = buildToolDefinitionMap([
      {
        ...sendMobileNotificationTool,
        handler: (args, context) =>
          sendMobileNotification({ context, args, sendCommand }),
      },
    ]);
    const registryResolver = buildRegistryCapabilityTargetResolver(
      harness.endpoint.registry,
    );
    const outcome = await executeToolWithTargetResolution({
      toolName: 'send_mobile_notification',
      args: { title: 'Apollo', body: 'Llegaste' },
      origin: 'llm',
      toolDefinitionMap,
      context: buildToolExecutionContext({ requestId: 'r-1' }),
      resolver: registryResolver as never,
      correlation: { requestId: 'r-1' },
    });
    expect(outcome.status).toBe('done');
    if (outcome.status === 'done') {
      expect(outcome.result.ok).toBe(false);
      expect(outcome.result.summary).toContain('desconectó');
    }
  });
});
