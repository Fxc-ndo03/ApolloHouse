import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { buildAuthenticatedDeviceProof, CapabilityRegistry } from '@/devices/registry';
import {
  ANY_TARGET_PREFERENCE,
  desktopTargetPreference,
  mobileTargetPreference,
} from '@/devices/schema';
import { PRESENCE_STALE_MILLISECONDS } from '@/devices/presence';
import type { CapabilityName } from '@/devices/capability';

const proof = buildAuthenticatedDeviceProof('device');
const DESKTOP_CAPABILITIES: readonly CapabilityName[] = [
  'desktop.open_app',
  'desktop.focus_app',
  'desktop.close_app',
  'desktop.list_apps',
  'desktop.lock',
  'desktop.spotify',
];

function buildRegistry(nowMilliseconds = 1_000_000): CapabilityRegistry {
  return new CapabilityRegistry({ nowMilliseconds: () => nowMilliseconds });
}

function registerDesktop(
  registry: CapabilityRegistry,
  deviceId = 'desktop:pc',
  capabilityNameList: readonly CapabilityName[] = DESKTOP_CAPABILITIES,
  nowMilliseconds = 1_000_000,
): void {
  const outcome = registry.register({
    transport: { transportKind: 'pc_bridge', connectionId: 'connection-under-test' },
    proof,
    deviceId,
    deviceType: 'desktop',
    capabilityNameList,
    protocolVersion: 1,
    lastSeenAt: nowMilliseconds,
  });
  expect(outcome.status).toBe('registered');
}

describe('device registration', () => {
  it('1. registers a new device', () => {
    const registry = buildRegistry();
    const outcome = registry.register({
      transport: { transportKind: 'pc_bridge', connectionId: 'connection-under-test' },
      proof,
      deviceId: 'desktop:pc',
      deviceType: 'desktop',
      capabilityNameList: DESKTOP_CAPABILITIES,
      protocolVersion: 1,
    });
    expect(outcome.status).toBe('registered');
    if (outcome.status !== 'registered') {
      throw new Error('expected registered');
    }
    expect(outcome.isNewDevice).toBe(true);
    expect(outcome.device.presence).toBe('online');
    expect(outcome.device.deviceType).toBe('desktop');
    expect(registry.getDevice('desktop:pc')?.protocolVersion).toBe(1);
  });

  it('2. registering the same device twice is idempotent', () => {
    const registry = buildRegistry();
    registerDesktop(registry);
    const secondOutcome = registry.register({
      transport: { transportKind: 'pc_bridge', connectionId: 'connection-under-test' },
      proof,
      deviceId: 'desktop:pc',
      deviceType: 'desktop',
      capabilityNameList: DESKTOP_CAPABILITIES,
      protocolVersion: 1,
    });
    expect(secondOutcome.status).toBe('registered');
    if (secondOutcome.status !== 'registered') {
      throw new Error('expected registered');
    }
    expect(secondOutcome.isNewDevice).toBe(false);
    expect(registry.listDeviceList()).toHaveLength(1);
  });

  it('18. never creates duplicate registrations', () => {
    const registry = buildRegistry();
    for (let repetition = 0; repetition < 25; repetition += 1) {
      registerDesktop(registry);
    }
    expect(registry.listDeviceList()).toHaveLength(1);
    expect(registry.listDeviceIdForCapabilityList('desktop.open_app')).toEqual([
      'desktop:pc',
    ]);
  });

  it('3. updates capabilities on an existing device', () => {
    const registry = buildRegistry();
    registerDesktop(registry, 'desktop:pc', ['desktop.open_app']);
    expect(registry.getDevice('desktop:pc')?.availableCapabilities).toEqual([
      'desktop.open_app',
    ]);

    registerDesktop(registry, 'desktop:pc', ['desktop.open_app', 'desktop.spotify']);
    expect(registry.getDevice('desktop:pc')?.availableCapabilities).toEqual([
      'desktop.open_app',
      'desktop.spotify',
    ]);
  });

  it('drops capabilities that are not implemented in the catalog', () => {
    const registry = buildRegistry();
    registerDesktop(registry, 'desktop:pc', [
      'desktop.open_app',
      'desktop.volume',
      'desktop.files',
    ]);
    // El cliente las declaró, pero no existe comando que las satisfaga.
    expect(registry.getDevice('desktop:pc')?.availableCapabilities).toEqual([
      'desktop.open_app',
    ]);
  });

  it('14. refuses registration without an authenticated proof', () => {
    const registry = buildRegistry();
    const outcome = registry.register({
      transport: { transportKind: 'pc_bridge', connectionId: 'connection-under-test' },
      proof: null,
      deviceId: 'desktop:spoofed',
      deviceType: 'desktop',
      capabilityNameList: DESKTOP_CAPABILITIES,
      protocolVersion: 1,
    });
    expect(outcome.status).toBe('unauthenticated');
    expect(registry.getDevice('desktop:spoofed')).toBeUndefined();
    expect(registry.listDeviceList()).toHaveLength(0);
  });

  it('ignores presence and capability updates from unauthenticated callers', () => {
    const registry = buildRegistry();
    registerDesktop(registry);
    expect(
      registry.markPresence({ proof: null, deviceId: 'desktop:pc', presence: 'offline' }),
    ).toBe(false);
    expect(
      registry.updateCapabilityList({
        proof: null,
        deviceId: 'desktop:pc',
        capabilityNameList: ['desktop.lock'],
      }),
    ).toBe(false);
    expect(registry.getDevice('desktop:pc')?.presence).toBe('online');
    expect(registry.getDevice('desktop:pc')?.availableCapabilities).toEqual([
      ...DESKTOP_CAPABILITIES,
    ]);
  });

  it('16. rejects an incompatible protocol version', () => {
    const registry = buildRegistry();
    const tooOld = registry.register({
      transport: { transportKind: 'pc_bridge', connectionId: 'connection-under-test' },
      proof,
      deviceId: 'desktop:old',
      deviceType: 'desktop',
      capabilityNameList: DESKTOP_CAPABILITIES,
      protocolVersion: 0,
    });
    expect(tooOld.status).toBe('rejected');
    expect(registry.listDeviceList()).toHaveLength(0);
  });
});

describe('presence', () => {
  it('4. online → offline', () => {
    const registry = buildRegistry();
    registerDesktop(registry);
    expect(
      registry.markPresence({ proof, deviceId: 'desktop:pc', presence: 'offline' }),
    ).toBe(true);
    expect(registry.getDevice('desktop:pc')?.presence).toBe('offline');
    const resolution = registry.resolveTarget({
      capabilityName: 'desktop.open_app',
      targetPreference: desktopTargetPreference,
    });
    expect(resolution.status).toBe('unavailable');
  });

  it('5. offline → online', () => {
    const registry = buildRegistry();
    registerDesktop(registry);
    registry.markPresence({ proof, deviceId: 'desktop:pc', presence: 'offline' });
    registry.markPresence({ proof, deviceId: 'desktop:pc', presence: 'online' });
    expect(registry.getDevice('desktop:pc')?.presence).toBe('online');
    expect(
      registry.resolveTarget({
        capabilityName: 'desktop.open_app',
        targetPreference: desktopTargetPreference,
      }).status,
    ).toBe('resolved');
  });

  it('17. treats a silent device as offline after the stale window', () => {
    const now = 1_000_000;
    const registry = buildRegistry(now);
    registerDesktop(registry, 'desktop:pc', DESKTOP_CAPABILITIES, now);

    // Todavía dentro de la ventana: sigue disponible.
    expect(
      registry.resolveTarget({
        capabilityName: 'desktop.open_app',
        targetPreference: ANY_TARGET_PREFERENCE,
      }).status,
    ).toBe('resolved');

    const silentRegistry = new CapabilityRegistry({
      nowMilliseconds: () => now + PRESENCE_STALE_MILLISECONDS + 1,
    });
    registerDesktop(silentRegistry, 'desktop:pc', DESKTOP_CAPABILITIES, now);
    const staleResolution = silentRegistry.resolveTarget({
      capabilityName: 'desktop.open_app',
      targetPreference: ANY_TARGET_PREFERENCE,
    });
    expect(staleResolution.status).toBe('unavailable');
    if (staleResolution.status === 'unavailable') {
      expect(staleResolution.reason).toBe('target_unavailable');
    }
    // El registro guardado sigue diciendo online: la vigencia se calcula.
    expect(silentRegistry.getDevice('desktop:pc')?.presence).toBe('online');
  });

  it('keeps a degraded device selectable', () => {
    const registry = buildRegistry();
    registerDesktop(registry);
    registry.markPresence({ proof, deviceId: 'desktop:pc', presence: 'degraded' });
    expect(
      registry.resolveTarget({
        capabilityName: 'desktop.open_app',
        targetPreference: desktopTargetPreference,
      }).status,
    ).toBe('resolved');
  });
});

describe('capability resolution', () => {
  it('6. resolves a capability the device declares', () => {
    const registry = buildRegistry();
    registerDesktop(registry);
    const resolution = registry.resolveTarget({
      capabilityName: 'desktop.spotify',
      targetPreference: desktopTargetPreference,
    });
    expect(resolution.status).toBe('resolved');
    if (resolution.status !== 'resolved') {
      throw new Error('expected resolved');
    }
    expect(resolution.device.deviceId).toBe('desktop:pc');
  });

  it('7. reports absent when the device lacks the capability', () => {
    const registry = buildRegistry();
    registerDesktop(registry, 'desktop:pc', ['desktop.open_app']);
    const resolution = registry.resolveTarget({
      capabilityName: 'desktop.spotify',
      targetPreference: desktopTargetPreference,
    });
    expect(resolution.status).toBe('unavailable');
    if (resolution.status === 'unavailable') {
      expect(resolution.reason).toBe('capability_absent');
    }
  });

  it('8. reports unavailable when there is no device at all', () => {
    const registry = buildRegistry();
    const resolution = registry.resolveTarget({
      capabilityName: 'desktop.open_app',
      targetPreference: ANY_TARGET_PREFERENCE,
    });
    expect(resolution.status).toBe('unavailable');
    if (resolution.status === 'unavailable') {
      expect(resolution.reason).toBe('no_device');
    }
  });

  it('marks a declared-but-unimplemented capability as unimplemented', () => {
    const registry = buildRegistry();
    registerDesktop(registry);
    const resolution = registry.resolveTarget({
      capabilityName: 'desktop.volume',
      targetPreference: desktopTargetPreference,
    });
    expect(resolution.status).toBe('unavailable');
    if (resolution.status === 'unavailable') {
      expect(resolution.reason).toBe('unimplemented');
    }
  });

  it('never resolves a mobile capability: no mobile client exists', () => {
    const registry = buildRegistry();
    registerDesktop(registry);
    const resolution = registry.resolveTarget({
      capabilityName: 'mobile.media',
      targetPreference: ANY_TARGET_PREFERENCE,
    });
    expect(resolution.status).toBe('unavailable');
    if (resolution.status === 'unavailable') {
      // BLOCK 11: mobile.media ya está implementada, así que el motivo NO es
      // 'unimplemented' sino que ningún device conectado puede hacerla.
      expect(resolution.reason).toBe('capability_absent');
    }
  });
});

describe('target selection policy', () => {
  it('9. picks one device among several with the same capability', () => {
    const registry = buildRegistry();
    registerDesktop(registry, 'desktop:pc-a', DESKTOP_CAPABILITIES, 1_000_000);
    registerDesktop(registry, 'desktop:pc-b', DESKTOP_CAPABILITIES, 1_000_000);
    const resolution = registry.resolveTarget({
      capabilityName: 'desktop.open_app',
      targetPreference: ANY_TARGET_PREFERENCE,
    });
    expect(resolution.status).toBe('resolved');
    if (resolution.status === 'resolved') {
      expect(resolution.device.deviceId).toBe('desktop:pc-a');
    }
  });

  it('10. prefers the most recently seen device', () => {
    const registry = buildRegistry(1_100_000);
    registerDesktop(registry, 'desktop:pc-a', DESKTOP_CAPABILITIES, 1_000_000);
    registerDesktop(registry, 'desktop:pc-b', DESKTOP_CAPABILITIES, 1_090_000);
    const resolution = registry.resolveTarget({
      capabilityName: 'desktop.open_app',
      targetPreference: ANY_TARGET_PREFERENCE,
    });
    expect(resolution.status).toBe('resolved');
    if (resolution.status === 'resolved') {
      expect(resolution.device.deviceId).toBe('desktop:pc-b');
    }
  });

  it('11. honours an explicit device target', () => {
    const registry = buildRegistry();
    registerDesktop(registry, 'desktop:pc-a', DESKTOP_CAPABILITIES, 1_000_000);
    registerDesktop(registry, 'desktop:pc-b', DESKTOP_CAPABILITIES, 1_090_000);
    const resolution = registry.resolveTarget({
      capabilityName: 'desktop.open_app',
      targetPreference: { kind: 'device', deviceId: 'desktop:pc-a' },
    });
    expect(resolution.status).toBe('resolved');
    if (resolution.status === 'resolved') {
      expect(resolution.device.deviceId).toBe('desktop:pc-a');
    }
  });

  it('12. never routes an explicit desktop target to another device type', () => {
    const registry = buildRegistry();
    registerDesktop(registry, 'desktop:pc', DESKTOP_CAPABILITIES);
    const resolution = registry.resolveTarget({
      capabilityName: 'desktop.open_app',
      // "abrí Chrome en la PC": sólo desktop, sin fallback silencioso.
      targetPreference: desktopTargetPreference,
    });
    expect(resolution.status).toBe('resolved');
    if (resolution.status === 'resolved') {
      expect(resolution.device.deviceType).toBe('desktop');
    }

    // Y al revés: si sólo hay desktop, pedir mobile noYR.
    const mobileRequest = registry.resolveTarget({
      capabilityName: 'desktop.spotify',
      targetPreference: mobileTargetPreference,
    });
    expect(mobileRequest.status).toBe('unavailable');
    if (mobileRequest.status === 'unavailable') {
      expect(mobileRequest.reason).toBe('target_unavailable');
    }
  });

  it('13. lets a generic request use whatever target is available', () => {
    const registry = buildRegistry();
    registerDesktop(registry, 'desktop:pc', DESKTOP_CAPABILITIES);
    const resolution = registry.resolveTarget({
      capabilityName: 'desktop.spotify',
      targetPreference: ANY_TARGET_PREFERENCE,
    });
    expect(resolution.status).toBe('resolved');
  });

  it('is deterministic when two devices tie on every criterion', () => {
    const registry = buildRegistry();
    registerDesktop(registry, 'desktop:pc-b', DESKTOP_CAPABILITIES, 1_000_000);
    registerDesktop(registry, 'desktop:pc-a', DESKTOP_CAPABILITIES, 1_000_000);
    const firstDeviceId = (
      registry.resolveTarget({
        capabilityName: 'desktop.open_app',
        targetPreference: ANY_TARGET_PREFERENCE,
      }) as { readonly device: { readonly deviceId: string } }
    ).device.deviceId;
    expect(firstDeviceId).toBe('desktop:pc-a');
  });

  it('15. a capability list never implies authorization', () => {
    // El Registry sólo responde "¿quién puede?": no importa nada del pipeline de
    // tools, no invoca handlers y no menciona confirmaciones. La autorización
    // sigue siendo la de Block 4 (authorizeToolExecution).
    const registry = buildRegistry();
    registerDesktop(registry);
    expect(registry.getDevice('desktop:pc')?.availableCapabilities).toContain(
      'desktop.close_app',
    );

    const source = readRegistrySource();
    const importPathList = [...source.matchAll(/from '(@\/[^']+)'/g)].map(
      (match) => match[1] ?? '',
    );
    expect(importPathList).not.toContain('@/tools/router');
    expect(importPathList).not.toContain('@/tools/execution');
    expect(importPathList).not.toContain('@/tools/types');
    expect(source).not.toContain('executeToolByName(');
    expect(source).not.toContain('resolveToolExecution(');
    expect(source).not.toContain('.handler(');
  });
});

function readRegistrySource(): string {
  return readFileSync(join(import.meta.dir, '..', 'registry.ts'), 'utf8');
}
