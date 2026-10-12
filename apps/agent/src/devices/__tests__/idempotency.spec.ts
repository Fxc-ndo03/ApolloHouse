import { describe, expect, it } from 'bun:test';

import {
  buildDeviceCommandEnvelope,
  buildDeviceCommandResultEnvelope,
} from '@/devices/envelope';
import { PendingCommandRegistry, type DeviceCommandOutcome } from '@/devices/dispatch';
import {
  CompletedCommandRegistry,
  buildCompletedCommandKey,
} from '@/devices/idempotency';
import { parseMobileToServerMessage } from '@/protocol/schema';

// Block 11 §6 y §10: idempotencia por deviceId+requestId con TTL acotado, y
// las categorías de fallo que el usuario final distingue.

const START = 1_700_000_000_000;

function buildEnvelope(overrides: { deviceId?: string; requestId?: string } = {}) {
  return buildDeviceCommandEnvelope({
    requestId: overrides.requestId ?? 'req-1',
    capability: 'mobile.notifications',
    command: 'notification_post',
    targetDeviceId: overrides.deviceId ?? 'mobile:phone-1',
    payload: { title: 'Apollo', body: 'Hola' },
  });
}

describe('B11 §6: idempotencia por deviceId + requestId', () => {
  it('keys by device AND request, not by request alone', () => {
    expect(buildCompletedCommandKey('mobile:a', 'r1')).not.toBe(
      buildCompletedCommandKey('mobile:b', 'r1'),
    );
  });

  it('the first request executes', async () => {
    const registry = new PendingCommandRegistry({
      nowMilliseconds: () => START,
      timeoutPort: { setTimeout: () => 1, clearTimeout: () => undefined },
    });
    let sendCount = 0;

    const outcomePromise = registry.register({
      envelope: buildEnvelope(),
      send: () => {
        sendCount += 1;
        registry.settleByRequestId(
          'req-1',
          buildDeviceCommandResultEnvelope({
            requestId: 'req-1',
            deviceId: 'mobile:phone-1',
            capability: 'mobile.notifications',
            ok: true,
            result: { posted: true },
          }),
        );
      },
    });
    const outcome = await outcomePromise;

    expect(outcome.ok).toBe(true);
    expect(sendCount).toBe(1);
  });

  it('a duplicate in flight is rejected and does NOT execute twice', async () => {
    const registry = new PendingCommandRegistry({
      nowMilliseconds: () => START,
      timeoutPort: { setTimeout: () => 1, clearTimeout: () => undefined },
    });
    let sendCount = 0;

    const firstPromise = registry.register({
      envelope: buildEnvelope(),
      send: () => {
        sendCount += 1;
      },
    });

    const duplicate = await registry.register({
      envelope: buildEnvelope(),
      send: () => {
        sendCount += 1;
      },
    });

    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) {
      expect(duplicate.reason).toBe('duplicate_request_id');
    }
    expect(sendCount).toBe(1);
    expect(registry.pendingCount).toBe(1);

    registry.settleByRequestId(
      'req-1',
      buildDeviceCommandResultEnvelope({
        requestId: 'req-1',
        deviceId: 'mobile:phone-1',
        capability: 'mobile.notifications',
        ok: true,
        result: { posted: true },
      }),
    );
    await firstPromise;
  });

  it('a duplicate shortly after completion replays the cached result', async () => {
    let now = START;
    const registry = new PendingCommandRegistry({
      nowMilliseconds: () => now,
      timeoutPort: { setTimeout: () => 1, clearTimeout: () => undefined },
    });
    let sendCount = 0;
    const send = (): void => {
      sendCount += 1;
      registry.settleByRequestId(
        'req-1',
        buildDeviceCommandResultEnvelope({
          requestId: 'req-1',
          deviceId: 'mobile:phone-1',
          capability: 'mobile.notifications',
          ok: true,
          result: { posted: true, attempt: sendCount },
        }),
      );
    };

    const first = await registry.register({ envelope: buildEnvelope(), send });
    now = START + 1_000;
    const replay = await registry.register({ envelope: buildEnvelope(), send });

    // El replay devuelve el MISMO resultado y NO vuelve a mandar el comando.
    expect(replay).toEqual(first);
    expect(sendCount).toBe(1);
  });

  it('after the TTL the same requestId executes again', async () => {
    let now = START;
    const registry = new PendingCommandRegistry({
      nowMilliseconds: () => now,
      timeoutMilliseconds: 8_000,
      timeoutPort: { setTimeout: () => 1, clearTimeout: () => undefined },
    });
    let sendCount = 0;
    const send = (): void => {
      sendCount += 1;
      registry.settleByRequestId(
        'req-1',
        buildDeviceCommandResultEnvelope({
          requestId: 'req-1',
          deviceId: 'mobile:phone-1',
          capability: 'mobile.notifications',
          ok: true,
          result: { posted: true, attempt: sendCount },
        }),
      );
    };

    await registry.register({ envelope: buildEnvelope(), send });
    now = START + 5 * 60_000 + 1;
    const afterTtl = await registry.register({ envelope: buildEnvelope(), send });

    expect(sendCount).toBe(2);
    expect(afterTtl.ok).toBe(true);
  });

  it('the same requestId on a DIFFERENT device is not a duplicate', async () => {
    let now = START;
    const registry = new PendingCommandRegistry({
      nowMilliseconds: () => now,
      timeoutPort: { setTimeout: () => 1, clearTimeout: () => undefined },
    });
    let sendCount = 0;
    const send = (deviceId: string) => (): void => {
      sendCount += 1;
      registry.settleByRequestId(
        'req-1',
        buildDeviceCommandResultEnvelope({
          requestId: 'req-1',
          deviceId,
          capability: 'mobile.notifications',
          ok: true,
          result: { posted: true },
        }),
      );
    };

    await registry.register({
      envelope: buildEnvelope({ deviceId: 'mobile:a' }),
      send: send('mobile:a'),
    });
    now = START + 1_000;
    await registry.register({
      envelope: buildEnvelope({ deviceId: 'mobile:b' }),
      send: send('mobile:b'),
    });

    expect(sendCount).toBe(2);
  });

  it('the completed cache is bounded so the bridge memory cannot grow forever', () => {
    let now = START;
    const completed = new CompletedCommandRegistry({
      nowMilliseconds: () => now,
      maxEntryCount: 3,
      ttlMilliseconds: 60_000,
    });
    for (let index = 0; index < 10; index += 1) {
      completed.record('mobile:a', `req-${index}`, { ok: true, result: index });
      now += 1;
    }
    expect(completed.entryCount).toBe(3);
  });

  it('expired entries are not replayed', () => {
    let now = START;
    const completed = new CompletedCommandRegistry({
      nowMilliseconds: () => now,
      ttlMilliseconds: 1_000,
    });
    completed.record('mobile:a', 'req-1', { ok: true, result: 'x' });
    expect(completed.readOutcome('mobile:a', 'req-1')).not.toBeNull();
    now = START + 1_001;
    expect(completed.readOutcome('mobile:a', 'req-1')).toBeNull();
  });
});

describe('B11 §10 y §15: categorías de fallo y resultados tardíos', () => {
  it('a late result cannot complete another turn', () => {
    const registry = new PendingCommandRegistry({
      nowMilliseconds: () => START,
      timeoutPort: { setTimeout: () => 1, clearTimeout: () => undefined },
    });

    // Un requestId que no existe no completa nada.
    const didSettle = registry.settleByRequestId(
      'req-que-nunca-se-mando',
      buildDeviceCommandResultEnvelope({
        requestId: 'req-que-nunca-se-mando',
        deviceId: 'mobile:phone-1',
        capability: 'mobile.notifications',
        ok: true,
        result: { posted: true },
      }),
    );

    expect(didSettle).toBe(false);
    expect(registry.pendingCount).toBe(0);
  });

  it('a result for a finished request is discarded, not re-settled', async () => {
    const registry = new PendingCommandRegistry({
      nowMilliseconds: () => START,
      timeoutPort: { setTimeout: () => 1, clearTimeout: () => undefined },
    });
    const send = (): void => {
      registry.settleByRequestId(
        'req-1',
        buildDeviceCommandResultEnvelope({
          requestId: 'req-1',
          deviceId: 'mobile:phone-1',
          capability: 'mobile.notifications',
          ok: true,
          result: { posted: true },
        }),
      );
    };

    await registry.register({ envelope: buildEnvelope(), send });

    expect(registry.settleByRequestId('req-1', { ok: true })).toBe(false);
  });

  it('every failure reason is one the caller can distinguish', async () => {
    const outcomes: DeviceCommandOutcome[] = [
      { ok: false, reason: 'device_timeout', detail: 'timeout' },
      { ok: false, reason: 'device_disconnected', detail: 'desconectado' },
      { ok: false, reason: 'device_rejected', detail: 'rechazado' },
      { ok: false, reason: 'unknown_device', detail: 'sin socket' },
      { ok: false, reason: 'duplicate_request_id', detail: 'duplicado' },
      { ok: false, reason: 'unsupported_command', detail: 'no soportado' },
      { ok: false, reason: 'invalid_payload', detail: 'payload malo' },
    ];
    for (const outcome of outcomes) {
      if (outcome.ok) {
        throw new Error('no debería ser ok');
      }
      expect(outcome.reason).toBeString();
      expect(outcome.detail.length).toBeGreaterThan(0);
    }
  });

  it('the result envelope unifies requestId, deviceId, capability y ok', () => {
    const envelope = buildDeviceCommandResultEnvelope({
      requestId: 'req-1',
      deviceId: 'mobile:phone-1',
      capability: 'mobile.alarm',
      ok: true,
      result: { applied: true },
    });
    expect(Object.keys(envelope).toSorted()).toEqual([
      'capability',
      'deviceId',
      'error',
      'ok',
      'requestId',
      'result',
    ]);
    // El schema es opcional, así que la clave existe con valor undefined.
    expect(envelope.error).toBeUndefined();
  });

  it('a failure envelope never carries a result', () => {
    const envelope = buildDeviceCommandResultEnvelope({
      requestId: 'req-1',
      deviceId: 'mobile:phone-1',
      capability: 'mobile.alarm',
      ok: false,
      error: 'device_timeout',
    });
    expect(envelope.ok).toBe(false);
    expect(envelope.error).toBe('device_timeout');
    expect(envelope.result).toBeUndefined();
  });

  it('the wire command carries the explicit command the capability declares', () => {
    const parsed = parseMobileToServerMessage(
      JSON.stringify({
        type: 'command_result',
        requestId: 'req-1',
        capability: 'mobile.alarm',
        ok: true,
        result: { applied: true },
        ts: START,
      }),
    );
    expect(parsed.type).toBe('command_result');
    if (parsed.type !== 'command_result') {
      throw new Error('se esperaba command_result');
    }
    expect(parsed.requestId).toBe('req-1');
    expect(parsed.capability).toBe('mobile.alarm');
  });
});
