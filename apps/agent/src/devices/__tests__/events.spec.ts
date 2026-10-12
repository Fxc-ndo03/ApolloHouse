import { describe, expect, it } from 'bun:test';

import { buildDeviceEventLogLine } from '@/devices/events';
import { buildAuthenticatedDeviceProof, CapabilityRegistry } from '@/devices/registry';
import type { CapabilityName } from '@/devices/capability';

type ParsedEventLogLine = {
  readonly message: string;
  readonly device_id: string;
  readonly device_type: string;
  readonly capability: string | null;
  readonly presence: string | null;
  readonly protocol_version: number | null;
  readonly request_id: string | null;
  readonly client_turn_id: string | null;
};

function parseLogLine(rawLogLine: string): ParsedEventLogLine {
  return JSON.parse(rawLogLine) as ParsedEventLogLine;
}

function captureDeviceEventLogLineList(run: () => void): readonly string[] {
  const originalLog = console.log;
  const capturedList: string[] = [];
  console.log = (...argumentList: unknown[]) => {
    capturedList.push(argumentList.map(String).join(' '));
  };
  try {
    run();
  } finally {
    console.log = originalLog;
  }
  return capturedList;
}

const proof = buildAuthenticatedDeviceProof('device');
const DESKTOP_CAPABILITIES: readonly CapabilityName[] = [
  'desktop.open_app',
  'desktop.spotify',
];

describe('device observability', () => {
  it('emits device_registered on first sight', () => {
    const registry = new CapabilityRegistry({ nowMilliseconds: () => 1_000 });
    const logLineList = captureDeviceEventLogLineList(() => {
      registry.register({
        transport: { transportKind: 'pc_bridge', connectionId: 'connection-under-test' },
        proof,
        deviceId: 'desktop:pc',
        deviceType: 'desktop',
        capabilityNameList: DESKTOP_CAPABILITIES,
        protocolVersion: 1,
      });
    });
    const event = parseLogLine(logLineList[0] ?? '{}');
    expect(event.message).toBe('device_device_registered');
    expect(event.device_id).toBe('desktop:pc');
    expect(event.device_type).toBe('desktop');
    expect(event.presence).toBe('online');
    expect(event.protocol_version).toBe(1);
  });

  it('emits device_presence_changed when presence moves', () => {
    const registry = new CapabilityRegistry({ nowMilliseconds: () => 1_000 });
    registry.register({
      transport: { transportKind: 'pc_bridge', connectionId: 'connection-under-test' },
      proof,
      deviceId: 'desktop:pc',
      deviceType: 'desktop',
      capabilityNameList: DESKTOP_CAPABILITIES,
      protocolVersion: 1,
    });
    const logLineList = captureDeviceEventLogLineList(() => {
      registry.markPresence({ proof, deviceId: 'desktop:pc', presence: 'offline' });
    });
    const event = parseLogLine(logLineList[0] ?? '{}');
    expect(event.message).toBe('device_device_presence_changed');
    expect(event.presence).toBe('offline');
  });

  it('emits device_capabilities_updated when the list changes', () => {
    const registry = new CapabilityRegistry({ nowMilliseconds: () => 1_000 });
    registry.register({
      transport: { transportKind: 'pc_bridge', connectionId: 'connection-under-test' },
      proof,
      deviceId: 'desktop:pc',
      deviceType: 'desktop',
      capabilityNameList: ['desktop.open_app'],
      protocolVersion: 1,
    });
    const logLineList = captureDeviceEventLogLineList(() => {
      registry.updateCapabilityList({
        proof,
        deviceId: 'desktop:pc',
        capabilityNameList: DESKTOP_CAPABILITIES,
      });
    });
    const event = parseLogLine(logLineList[0] ?? '{}');
    expect(event.message).toBe('device_device_capabilities_updated');
    expect(event.device_id).toBe('desktop:pc');
  });

  it('emits capability_resolution with the selected device', () => {
    const registry = new CapabilityRegistry({ nowMilliseconds: () => 1_000 });
    registry.register({
      transport: { transportKind: 'pc_bridge', connectionId: 'connection-under-test' },
      proof,
      deviceId: 'desktop:pc',
      deviceType: 'desktop',
      capabilityNameList: DESKTOP_CAPABILITIES,
      protocolVersion: 1,
    });
    const logLineList = captureDeviceEventLogLineList(() => {
      registry.resolveTarget({
        capabilityName: 'desktop.spotify',
        targetPreference: { kind: 'any' },
      });
    });
    const event = parseLogLine(logLineList[0] ?? '{}');
    expect(event.message).toBe('device_capability_resolution');
    expect(event.capability).toBe('desktop.spotify');
    expect(event.device_id).toBe('desktop:pc');
  });

  it('emits capability_unavailable with a reason', () => {
    const registry = new CapabilityRegistry({ nowMilliseconds: () => 1_000 });
    const logLineList = captureDeviceEventLogLineList(() => {
      registry.resolveTarget({
        capabilityName: 'desktop.spotify',
        targetPreference: { kind: 'any' },
      });
    });
    const event = parseLogLine(logLineList[0] ?? '{}');
    expect(event.message).toBe('device_capability_unavailable');
    expect(event.device_id).toBe('none');
    expect(logLineList[0]).toContain('no_device');
  });

  it('carries turn correlation when the caller has it', () => {
    const registry = new CapabilityRegistry({
      nowMilliseconds: () => 1_000,
      correlation: { requestId: 'req-1', clientTurnId: 'turn-1' },
    });
    const logLineList = captureDeviceEventLogLineList(() => {
      registry.register({
        transport: { transportKind: 'pc_bridge', connectionId: 'connection-under-test' },
        proof,
        deviceId: 'desktop:pc',
        deviceType: 'desktop',
        capabilityNameList: DESKTOP_CAPABILITIES,
        protocolVersion: 1,
      });
    });
    const event = parseLogLine(logLineList[0] ?? '{}');
    expect(event.request_id).toBe('req-1');
    expect(event.client_turn_id).toBe('turn-1');
  });

  it('never logs secrets', () => {
    const line = buildDeviceEventLogLine({
      event: 'device_registered',
      deviceId: 'desktop:pc',
      deviceType: 'desktop',
      presence: 'online',
      protocolVersion: 1,
    });
    for (const forbiddenKey of [
      'secret',
      'token',
      'password',
      'key',
      'authorization',
      'cookie',
    ]) {
      expect(line.toLowerCase()).not.toContain(forbiddenKey);
    }
  });
});
