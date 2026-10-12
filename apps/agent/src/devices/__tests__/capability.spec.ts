import { describe, expect, it } from 'bun:test';

import {
  CAPABILITY_NAME_LIST,
  describeCapability,
  isImplementedCapability,
  listCapabilityContractList,
  listImplementedCapabilityNameList,
  MOBILE_COMMAND_NAME_LIST,
  PC_BRIDGE_COMMAND_NAME_LIST,
  type CapabilityName,
} from '@/devices/capability';
import {
  buildDesktopRegistrationFromHello,
  buildDesktopDeviceIdFromHostname,
  resolveDesktopCapabilityNameList,
} from '@/devices/desktop';
import { LEGACY_PROTOCOL_VERSION } from '@/devices/schema';
import { GENERIC_SPOTIFY_INTENT, resolveCapabilityIntent } from '@/devices/intent';
import { ANY_TARGET_PREFERENCE, desktopTargetPreference } from '@/devices/schema';
import { pcToServerMessageSchema } from '@/protocol/schema';
import { routeDeterministic } from '@/voice/router';

const FIXED_NOW = new Date('2026-10-04T12:00:00-03:00');

describe('capability catalog', () => {
  it('has no duplicate capability names', () => {
    expect(new Set(CAPABILITY_NAME_LIST).size).toBe(CAPABILITY_NAME_LIST.length);
  });

  it('maps every implemented capability to a real device command', () => {
    const knownCommandSet = new Set<string>([
      ...PC_BRIDGE_COMMAND_NAME_LIST,
      ...MOBILE_COMMAND_NAME_LIST,
    ]);
    for (const contract of listCapabilityContractList()) {
      if (contract.status !== 'implemented') {
        expect(contract.commandList).toEqual([]);
        continue;
      }
      expect(contract.commandList.length).toBeGreaterThan(0);
      for (const commandName of contract.commandList) {
        expect(knownCommandSet.has(commandName)).toBe(true);
      }
    }
  });

  it('marks contract-only capabilities as unimplemented', () => {
    // Declaradas para que el modelo sea exhaustivo, sin comando que las satisfaga.
    for (const capabilityName of [
      'desktop.volume',
      'desktop.brightness',
      'desktop.notifications',
      'desktop.files',
      'desktop.system_status',
    ] as const) {
      expect(describeCapability(capabilityName).status).toBe('unimplemented');
      expect(isImplementedCapability(capabilityName)).toBe(false);
    }
  });

  it('BLOCK 11: every mobile capability has a real command, no contract-only', () => {
    const mobileContractList = listCapabilityContractList().filter((contract) =>
      contract.name.startsWith('mobile.'),
    );
    expect(mobileContractList).toHaveLength(6);
    for (const contract of mobileContractList) {
      expect(contract.status).toBe('implemented');
      expect(contract.deviceType).toBe('mobile');
      expect(contract.commandList.length).toBeGreaterThan(0);
      for (const commandName of contract.commandList) {
        expect(MOBILE_COMMAND_NAME_LIST).toContain(
          commandName as (typeof MOBILE_COMMAND_NAME_LIST)[number],
        );
      }
    }
  });

  it('BLOCK 11: no mobile capability is satisfied by a PcBridge command', () => {
    for (const contract of listCapabilityContractList()) {
      if (contract.deviceType !== 'mobile') {
        continue;
      }
      for (const commandName of contract.commandList) {
        expect(PC_BRIDGE_COMMAND_NAME_LIST).not.toContain(
          commandName as (typeof PC_BRIDGE_COMMAND_NAME_LIST)[number],
        );
      }
    }
  });

  it('BLOCK 11: the implemented mobile set is exactly the six mobile names', () => {
    const implementedMobileList = listImplementedCapabilityNameList().filter(
      (capabilityName) => capabilityName.startsWith('mobile.'),
    );
    expect(implementedMobileList).toEqual([
      'mobile.open_app',
      'mobile.notifications',
      'mobile.alarm',
      'mobile.calendar',
      'mobile.media',
      'mobile.volume',
    ]);
  });

  it('BLOCK 11: every mobile command maps to exactly one capability', () => {
    const ownerMap = new Map<string, string>();
    for (const contract of listCapabilityContractList()) {
      if (contract.deviceType !== 'mobile') {
        continue;
      }
      for (const commandName of contract.commandList) {
        expect(ownerMap.has(commandName)).toBe(false);
        ownerMap.set(commandName, contract.name);
      }
    }
    // Todo comando mobile declarado tiene dueño, y no sobra ninguno.
    expect([...ownerMap.keys()].toSorted()).toEqual(
      [...MOBILE_COMMAND_NAME_LIST].toSorted(),
    );
  });

  it('only claims the desktop capabilities that a real command satisfies', () => {
    // Siete: las seis de Block 5 más brave_search, que abre una URL con el
    // mismo comando apps_open (BLOCK 6.2).
    const implementedList = listImplementedCapabilityNameList();
    expect(implementedList).toEqual([
      'desktop.open_app',
      'desktop.focus_app',
      'desktop.close_app',
      'desktop.list_apps',
      'desktop.lock',
      'desktop.spotify',
      'desktop.brave_search',
      // BLOCK 11: las seis mobile, todas con comando real.
      'mobile.open_app',
      'mobile.notifications',
      'mobile.alarm',
      'mobile.calendar',
      'mobile.media',
      'mobile.volume',
    ]);
  });

  it('throws for a capability outside the catalog', () => {
    expect(() => describeCapability('desktop.teleport' as CapabilityName)).toThrow(
      /fuera de cat/,
    );
  });
});

describe('protocol handshake', () => {
  it('accepts the legacy hello without identity fields', () => {
    const parsed = pcToServerMessageSchema.parse({
      type: 'hello',
      hostname: 'PC-ESTUDIO',
      ts: 1_700_000_000_000,
    });
    expect(parsed.type).toBe('hello');
    if (parsed.type !== 'hello') {
      throw new Error('expected hello');
    }
    expect(parsed.protocolVersion).toBeUndefined();
    expect(parsed.capabilities).toBeUndefined();
  });

  it('accepts a hello that declares protocolVersion and capabilities', () => {
    const parsed = pcToServerMessageSchema.parse({
      type: 'hello',
      hostname: 'PC-ESTUDIO',
      ts: 1_700_000_000_000,
      protocolVersion: 1,
      capabilities: ['desktop.open_app', 'desktop.spotify'],
    });
    if (parsed.type !== 'hello') {
      throw new Error('expected hello');
    }
    expect(parsed.protocolVersion).toBe(1);
    expect(parsed.capabilities).toEqual(['desktop.open_app', 'desktop.spotify']);
  });

  it('rejects a hello with an unknown capability', () => {
    const parseResult = pcToServerMessageSchema.safeParse({
      type: 'hello',
      hostname: 'PC-ESTUDIO',
      ts: 1_700_000_000_000,
      capabilities: ['desktop.teleport'],
    });
    expect(parseResult.success).toBe(false);
  });
});

describe('desktop registration adapter', () => {
  it('derives a stable deviceId from the hostname', () => {
    expect(buildDesktopDeviceIdFromHostname('PC-ESTUDIO')).toBe('desktop:PC-ESTUDIO');
  });

  it('maps a legacy hello to the implemented desktop capabilities', () => {
    const hello = pcToServerMessageSchema.parse({
      type: 'hello',
      hostname: 'PC-ESTUDIO',
      ts: 1_700_000_000_000,
    });
    if (hello.type !== 'hello') {
      throw new Error('expected hello');
    }
    const registration = buildDesktopRegistrationFromHello({
      hello,
      hostname: 'PC-ESTUDIO',
      nowMilliseconds: 1_700_000_000_000,
    });
    expect(registration.deviceId).toBe('desktop:PC-ESTUDIO');
    expect(registration.deviceType).toBe('desktop');
    expect(registration.protocolVersion).toBe(LEGACY_PROTOCOL_VERSION);
    expect(registration.capabilityNameList).toEqual([
      'desktop.open_app',
      'desktop.focus_app',
      'desktop.close_app',
      'desktop.list_apps',
      'desktop.lock',
      'desktop.spotify',
      'desktop.brave_search',
    ]);
  });

  it('honours capabilities declared by the client', () => {
    const hello = pcToServerMessageSchema.parse({
      type: 'hello',
      hostname: 'PC-ESTUDIO',
      ts: 1,
      protocolVersion: 1,
      capabilities: ['desktop.open_app'],
    });
    if (hello.type !== 'hello') {
      throw new Error('expected hello');
    }
    const registration = buildDesktopRegistrationFromHello({
      hello,
      hostname: 'PC-ESTUDIO',
      nowMilliseconds: 1_700_000_000_000,
    });
    expect(registration.capabilityNameList).toEqual(['desktop.open_app']);
    expect(registration.protocolVersion).toBe(1);
  });

  it('falls back to the implemented desktop set for a legacy client', () => {
    expect(resolveDesktopCapabilityNameList(undefined)).toEqual(
      listImplementedCapabilityNameList().filter((name) => name.startsWith('desktop.')),
    );
  });
});

describe('router integration (mapping only)', () => {
  it('maps a deterministic pc command to a capability intent', () => {
    const outcome = routeDeterministic('abrí chrome', FIXED_NOW);
    expect(outcome.kind).toBe('pc_command');
    if (outcome.kind !== 'pc_command') {
      throw new Error('expected pc_command');
    }
    expect(resolveCapabilityIntent(outcome)).toEqual({
      domain: 'pc',
      capabilityName: 'desktop.open_app',
      targetPreference: desktopTargetPreference,
    });
  });

  it('maps lock to desktop.lock', () => {
    const outcome = routeDeterministic('bloqueá la pantalla', FIXED_NOW);
    if (outcome.kind !== 'pc_command') {
      throw new Error('expected pc_command');
    }
    expect(resolveCapabilityIntent(outcome)?.capabilityName).toBe('desktop.lock');
  });

  it('models spotify as a desktop-scoped intent', () => {
    const outcome = routeDeterministic('siguiente canción', FIXED_NOW);
    if (outcome.kind !== 'pc_command') {
      throw new Error('expected pc_command');
    }
    const intent = resolveCapabilityIntent(outcome);
    expect(intent?.capabilityName).toBe('desktop.spotify');
    expect(intent?.targetPreference).toEqual(desktopTargetPreference);
  });

  it('offers a generic any-target intent for untargeted media', () => {
    expect(GENERIC_SPOTIFY_INTENT).toEqual({
      domain: 'media',
      capabilityName: 'desktop.spotify',
      targetPreference: ANY_TARGET_PREFERENCE,
    });
  });

  it('returns null for outcomes that are not pc commands', () => {
    expect(
      resolveCapabilityIntent(routeDeterministic('qué hora es', FIXED_NOW)),
    ).toBeNull();
    expect(
      resolveCapabilityIntent(routeDeterministic('contame un chiste', FIXED_NOW)),
    ).toBeNull();
  });
});
