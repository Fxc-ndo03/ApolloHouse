import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { buildAuthenticatedDeviceProof, CapabilityRegistry } from '@/devices/registry';
import { ANY_TARGET_PREFERENCE, desktopTargetPreference } from '@/devices/schema';
import {
  HEARTBEAT_INTERVAL_MILLISECONDS,
  PRESENCE_DEGRADED_AFTER_MILLISECONDS,
  PRESENCE_OFFLINE_AFTER_MILLISECONDS,
  isPresenceSelectable,
  resolvePresenceFromSignal,
} from '@/devices/presence';
import type { CapabilityName } from '@/devices/capability';

const proof = buildAuthenticatedDeviceProof('device');
const CAPABILITIES: readonly CapabilityName[] = ['desktop.open_app', 'desktop.spotify'];
const START = 1_700_000_000_000;

function buildRegistry(): {
  registry: CapabilityRegistry;
  setNow: (value: number) => void;
} {
  let now = START;
  const registry = new CapabilityRegistry({ nowMilliseconds: () => now });
  registry.register({
    transport: { transportKind: 'pc_bridge', connectionId: 'connection-under-test' },
    proof,
    deviceId: 'desktop:pc',
    deviceType: 'desktop',
    capabilityNameList: CAPABILITIES,
    protocolVersion: 1,
    lastSeenAt: START,
  });
  return { registry, setNow: (value: number) => (now = value) };
}

function beat(registry: CapabilityRegistry, atMilliseconds: number): void {
  registry.recordHeartbeat({ proof, deviceId: 'desktop:pc', atMilliseconds });
}

function resolveOpenApp(registry: CapabilityRegistry) {
  return registry.resolveTarget({
    capabilityName: 'desktop.open_app',
    targetPreference: ANY_TARGET_PREFERENCE,
  });
}

describe('heartbeat interval constants', () => {
  it('derives both thresholds from the interval', () => {
    expect(HEARTBEAT_INTERVAL_MILLISECONDS).toBe(30_000);
    expect(PRESENCE_DEGRADED_AFTER_MILLISECONDS).toBeGreaterThan(
      HEARTBEAT_INTERVAL_MILLISECONDS,
    );
    expect(PRESENCE_OFFLINE_AFTER_MILLISECONDS).toBeGreaterThan(
      PRESENCE_DEGRADED_AFTER_MILLISECONDS,
    );
  });
});

describe('no second heartbeat timer', () => {
  const sourceRoot = join(import.meta.dir, '..', '..');

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
    walk(sourceRoot);
    return filePathList;
  }

  function toRelativePath(filePath: string): string {
    return filePath.replace(sourceRoot, '').replace(/\\/g, '/').replace(/^\//, '');
  }

  it('only the scheduler module creates a heartbeat timer', () => {
    const schedulerPath = join(sourceRoot, 'devices', 'heartbeat.ts');
    const offenderList = listSourceFilePathList().filter((filePath) => {
      if (filePath === schedulerPath) {
        return false;
      }
      const source = readFileSync(filePath, 'utf8');
      // setInterval propio para presencia/heartbeat: prohibido.
      return /setInterval\s*\(/.test(source) && /heartbeat|presence|ping/i.test(source);
    });
    expect(offenderList.map(toRelativePath)).toEqual([]);
  });

  it('PcBridge drives the heartbeat through the scheduler, not a raw timer', () => {
    const pcBridgeSource = readFileSync(
      join(sourceRoot, 'agents', 'pc-bridge.ts'),
      'utf8',
    );
    expect(pcBridgeSource).not.toMatch(/setInterval\s*\(/);
    expect(pcBridgeSource).toContain('this.#heartbeat.start(');
    expect(pcBridgeSource).toContain('this.#heartbeat.stop(');
  });

  it('the interval is declared in exactly one place', () => {
    const declaringFileList = listSourceFilePathList().filter((filePath) =>
      /HEARTBEAT_INTERVAL_MILLISECONDS\s*=\s*\d/.test(readFileSync(filePath, 'utf8')),
    );
    expect(declaringFileList.map(toRelativePath)).toEqual(['devices/presence.ts']);
  });
});

describe('presence policy', () => {
  it('1. a recent heartbeat is online', () => {
    expect(
      resolvePresenceFromSignal(
        { connectionState: 'open', lastHeartbeatAt: START },
        START + 1_000,
      ),
    ).toBe('online');
  });

  it('2. a late heartbeat is degraded', () => {
    expect(
      resolvePresenceFromSignal(
        { connectionState: 'open', lastHeartbeatAt: START },
        START + PRESENCE_DEGRADED_AFTER_MILLISECONDS,
      ),
    ).toBe('degraded');
  });

  it('3. a heartbeat older than the offline window is offline', () => {
    expect(
      resolvePresenceFromSignal(
        { connectionState: 'open', lastHeartbeatAt: START },
        START + PRESENCE_OFFLINE_AFTER_MILLISECONDS,
      ),
    ).toBe('offline');
  });

  it('reports offline immediately when the socket is closed, whatever the beat', () => {
    expect(
      resolvePresenceFromSignal(
        { connectionState: 'closed', lastHeartbeatAt: START },
        START,
      ),
    ).toBe('offline');
  });

  it('reports unknown when there was never a heartbeat', () => {
    expect(
      resolvePresenceFromSignal(
        { connectionState: 'open', lastHeartbeatAt: null },
        START,
      ),
    ).toBe('unknown');
  });

  it('10. degraded is still selectable, offline is not', () => {
    expect(isPresenceSelectable('online')).toBe(true);
    expect(isPresenceSelectable('degraded')).toBe(true);
    expect(isPresenceSelectable('offline')).toBe(false);
    expect(isPresenceSelectable('unknown')).toBe(false);
  });

  it('11. is deterministic for the same inputs', () => {
    const signal = { connectionState: 'open', lastHeartbeatAt: START } as const;
    const first = resolvePresenceFromSignal(signal, START + 60_000);
    const second = resolvePresenceFromSignal(signal, START + 60_000);
    expect(first).toBe(second);
    expect(first).toBe('degraded');
  });
});

describe('heartbeat keeps the device available', () => {
  it('a beat every interval keeps a desktop selectable indefinitely', () => {
    const { registry, setNow } = buildRegistry();
    for (
      let elapsed = HEARTBEAT_INTERVAL_MILLISECONDS;
      elapsed <= 600_000;
      elapsed += 30_000
    ) {
      elapsed += 0;
      setNow(START + elapsed);
      beat(registry, START + elapsed);
      expect(resolveOpenApp(registry).status).toBe('resolved');
    }
    expect(registry.getDevice('desktop:pc')?.lastSeenAt).toBe(START + 600_000);
  });

  it('9. a stale device is not selected', () => {
    const { registry, setNow } = buildRegistry();
    setNow(START + PRESENCE_OFFLINE_AFTER_MILLISECONDS + 1);
    expect(resolveOpenApp(registry).status).toBe('unavailable');
    if (registry.getDevice('desktop:pc') !== undefined) {
      expect(registry.getDevice('desktop:pc')?.presence).not.toBe('offline');
    }
  });

  it('reports degraded while connected but late', () => {
    const { registry, setNow } = buildRegistry();
    setNow(START + PRESENCE_DEGRADED_AFTER_MILLISECONDS);
    expect(registry.resolvePresence('desktop:pc')).toBe('degraded');
    // Un device degradado sigue siendo un candidate válido.
    expect(resolveOpenApp(registry).status).toBe('resolved');
  });

  it('reports offline once the beat window closes', () => {
    const { registry, setNow } = buildRegistry();
    setNow(START + PRESENCE_OFFLINE_AFTER_MILLISECONDS);
    expect(registry.resolvePresence('desktop:pc')).toBe('offline');
  });
});

describe('disconnect and reconnect', () => {
  it('4. disconnect marks the device offline and stops selection', () => {
    const { registry } = buildRegistry();
    registry.markPresence({ proof, deviceId: 'desktop:pc', presence: 'offline' });
    expect(registry.resolvePresence('desktop:pc')).toBe('offline');
    expect(
      registry.resolveTarget({
        capabilityName: 'desktop.open_app',
        targetPreference: desktopTargetPreference,
      }).status,
    ).toBe('unavailable');
  });

  it('5. a heartbeat after reconnect brings it back online', () => {
    const { registry, setNow } = buildRegistry();
    registry.markPresence({ proof, deviceId: 'desktop:pc', presence: 'offline' });
    setNow(START + 5 * 60_000);
    beat(registry, START + 5 * 60_000);
    expect(registry.resolvePresence('desktop:pc')).toBe('online');
    expect(resolveOpenApp(registry).status).toBe('resolved');
  });

  it('re-registering on reconnect refreshes identity without duplicating', () => {
    const { registry, setNow } = buildRegistry();
    registry.markPresence({ proof, deviceId: 'desktop:pc', presence: 'offline' });
    setNow(START + 60_000);
    const outcome = registry.register({
      transport: { transportKind: 'pc_bridge', connectionId: 'connection-under-test' },
      proof,
      deviceId: 'desktop:pc',
      deviceType: 'desktop',
      capabilityNameList: CAPABILITIES,
      protocolVersion: 1,
    });
    expect(outcome.status).toBe('registered');
    if (outcome.status === 'registered') {
      expect(outcome.isNewDevice).toBe(false);
    }
    expect(registry.listDeviceList()).toHaveLength(1);
    expect(registry.resolvePresence('desktop:pc')).toBe('online');
  });

  it('ignores heartbeats from unauthenticated callers', () => {
    const { registry } = buildRegistry();
    expect(
      registry.recordHeartbeat({
        proof: null,
        deviceId: 'desktop:pc',
        atMilliseconds: START,
      }),
    ).toBeNull();
    expect(registry.getDevice('desktop:pc')?.lastSeenAt).toBe(START);
  });

  it('ignores heartbeats for an unknown device', () => {
    const { registry } = buildRegistry();
    expect(
      registry.recordHeartbeat({
        proof,
        deviceId: 'desktop:fantasma',
        atMilliseconds: START,
      }),
    ).toBeNull();
  });
});
