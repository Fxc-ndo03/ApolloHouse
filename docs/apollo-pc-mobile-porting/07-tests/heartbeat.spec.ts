import { describe, expect, it } from 'bun:test';

import { buildAuthenticatedDeviceProof, CapabilityRegistry } from '@/devices/registry';
import { ANY_TARGET_PREFERENCE } from '@/devices/schema';
import { PRESENCE_STALE_MILLISECONDS } from '@/devices/presence';

const proof = buildAuthenticatedDeviceProof('device');

describe('regression: a live heartbeat must keep the device available', () => {
  it('a pong every 30s keeps a desktop selectable past the stale window', () => {
    let now = 1_000_000;
    const registry = new CapabilityRegistry({ nowMilliseconds: () => now });
    registry.register({
      transport: { transportKind: 'pc_bridge', connectionId: 'connection-under-test' },
      proof,
      deviceId: 'desktop:pc',
      deviceType: 'desktop',
      capabilityNameList: ['desktop.open_app'],
      protocolVersion: 1,
      lastSeenAt: now,
    });

    // El Worker manda ping cada 30 s y el cliente responde pong. Eso es la
    // única señal de vida: si el beat no actualiza lastSeenAt, el desktop se
    // cae solo a los 90 s aunque el proceso siga vivo.
    for (let elapsed = 30_000; elapsed <= 120_000; elapsed += 30_000) {
      now = 1_000_000 + elapsed;
      registry.recordHeartbeat({ proof, deviceId: 'desktop:pc', atMilliseconds: now });
      expect(
        registry.resolveTarget({
          capabilityName: 'desktop.open_app',
          targetPreference: ANY_TARGET_PREFERENCE,
        }).status,
      ).toBe('resolved');
    }
  });

  it('without beats the device goes offline after the stale window', () => {
    let now = 1_000_000;
    const registry = new CapabilityRegistry({ nowMilliseconds: () => now });
    registry.register({
      transport: { transportKind: 'pc_bridge', connectionId: 'connection-under-test' },
      proof,
      deviceId: 'desktop:pc',
      deviceType: 'desktop',
      capabilityNameList: ['desktop.open_app'],
      protocolVersion: 1,
      lastSeenAt: now,
    });
    now = 1_000_000 + PRESENCE_STALE_MILLISECONDS + 1;
    expect(
      registry.resolveTarget({
        capabilityName: 'desktop.open_app',
        targetPreference: ANY_TARGET_PREFERENCE,
      }).status,
    ).toBe('unavailable');
  });
});
