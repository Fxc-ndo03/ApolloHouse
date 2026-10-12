import { describe, expect, it } from 'bun:test';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { buildAuthenticatedDeviceProof, CapabilityRegistry } from '@/devices/registry';
import {
  ANY_TARGET_PREFERENCE,
  desktopTargetPreference,
  mobileTargetPreference,
} from '@/devices/schema';
import { PRESENCE_OFFLINE_AFTER_MILLISECONDS } from '@/devices/presence';
import {
  resolveCapabilityTargetForDeviceType,
  buildCapabilityResolverMap,
} from '@/devices/target';
import {
  describeCapability,
  listCapabilityContractList,
  type CapabilityName,
} from '@/devices/capability';
import { readMobilePayloadSchema } from '@/devices/payload';
import { buildCompletedCommandKey } from '@/devices/idempotency';
import { resolveMobileCommand } from '@/devices/command';
import { MOBILE_COMMAND_NAME_LIST } from '@/devices/capability';

// Block 11 §19: multi-device core. Un solo registry, desktop y mobile
// conviviendo, y las reglas que no pueden romperse entre ellos.

const proof = buildAuthenticatedDeviceProof('device');
const START = 1_700_000_000_000;

function buildRegistry(nowMilliseconds = START): {
  readonly registry: CapabilityRegistry;
  readonly setNow: (value: number) => void;
} {
  let now = nowMilliseconds;
  const registry = new CapabilityRegistry({ nowMilliseconds: () => now });
  return { registry, setNow: (value: number) => (now = value) };
}

function registerDesktop(
  registry: CapabilityRegistry,
  options: { deviceId?: string; lastSeenAt?: number } = {},
): void {
  registry.register({
    proof,
    deviceId: options.deviceId ?? 'desktop:PC-ESTUDIO',
    deviceType: 'desktop',
    identitySource: 'desktop_hostname_legacy',
    hostname: (options.deviceId ?? 'desktop:PC-ESTUDIO').slice('desktop:'.length),
    capabilityNameList: ['desktop.open_app', 'desktop.spotify', 'desktop.lock'],
    protocolVersion: 1,
    lastSeenAt: options.lastSeenAt ?? START,
    transport: { transportKind: 'pc_bridge', connectionId: 'pc-1' },
  });
}

function registerMobile(
  registry: CapabilityRegistry,
  options: {
    deviceId?: string;
    capabilityNameList?: readonly CapabilityName[];
    lastSeenAt?: number;
    connectionId?: string;
  } = {},
): void {
  registry.register({
    proof,
    deviceId: options.deviceId ?? 'mobile:phone-123',
    deviceType: 'mobile',
    identitySource: 'client_provided',
    capabilityNameList: options.capabilityNameList ?? [
      'mobile.notifications',
      'mobile.alarm',
      'mobile.media',
    ],
    protocolVersion: 1,
    lastSeenAt: options.lastSeenAt ?? START,
    transport: {
      transportKind: 'mobile_websocket',
      connectionId: options.connectionId ?? 'mobile-1',
    },
  });
}

describe('B11 §2: routing multi-device sobre un solo registry', () => {
  it('resolves a desktop target for a desktop capability', () => {
    const { registry } = buildRegistry();
    registerDesktop(registry);

    const resolution = registry.resolveTarget({
      capabilityName: 'desktop.open_app',
      targetPreference: desktopTargetPreference,
    });

    expect(resolution.status).toBe('resolved');
    if (resolution.status === 'resolved') {
      expect(resolution.device.deviceId).toBe('desktop:PC-ESTUDIO');
      expect(resolution.device.deviceType).toBe('desktop');
    }
  });

  it('resolves a mobile target for a mobile capability', () => {
    const { registry } = buildRegistry();
    registerMobile(registry);

    const resolution = registry.resolveTarget({
      capabilityName: 'mobile.notifications',
      targetPreference: mobileTargetPreference,
    });

    expect(resolution.status).toBe('resolved');
    if (resolution.status === 'resolved') {
      expect(resolution.device.deviceId).toBe('mobile:phone-123');
      expect(resolution.device.deviceType).toBe('mobile');
    }
  });

  it('a desktop device is never selected for a mobile capability', () => {
    const { registry } = buildRegistry();
    registerDesktop(registry);

    const resolution = registry.resolveTarget({
      capabilityName: 'mobile.notifications',
      targetPreference: ANY_TARGET_PREFERENCE,
    });

    expect(resolution.status).toBe('unavailable');
  });

  it('a mobile device is never selected for a desktop capability', () => {
    const { registry } = buildRegistry();
    registerMobile(registry);

    const resolution = registry.resolveTarget({
      capabilityName: 'desktop.open_app',
      targetPreference: ANY_TARGET_PREFERENCE,
    });

    expect(resolution.status).toBe('unavailable');
  });

  it('the resolver map routes by contract deviceType, never by prefix', async () => {
    const desktopCalls: string[] = [];
    const mobileCalls: string[] = [];
    const resolverMap = buildCapabilityResolverMap({
      desktop: async (input) => {
        desktopCalls.push(input.capabilityName);
        return { status: 'unavailable', reason: 'no_device' };
      },
      mobile: async (input) => {
        mobileCalls.push(input.capabilityName);
        return { status: 'unavailable', reason: 'no_device' };
      },
    });

    await resolveCapabilityTargetForDeviceType({
      resolverMap,
      deviceType: describeCapability('mobile.alarm').deviceType,
      capabilityName: 'mobile.alarm',
      targetPreference: ANY_TARGET_PREFERENCE,
    });
    await resolveCapabilityTargetForDeviceType({
      resolverMap,
      deviceType: describeCapability('desktop.spotify').deviceType,
      capabilityName: 'desktop.spotify',
      targetPreference: ANY_TARGET_PREFERENCE,
    });

    expect(mobileCalls).toEqual(['mobile.alarm']);
    expect(desktopCalls).toEqual(['desktop.spotify']);
  });
});

describe('B11 §8: target failover sin fallback silencioso', () => {
  it('an explicit mobile target does NOT fall back to the desktop', () => {
    const { registry } = buildRegistry();
    registerDesktop(registry);

    // "mandame una notificación al teléfono" con la PC conectada: el desktop
    // PUEDE desktop.notifications, pero la capability mobile no puede caer ahí.
    const resolution = registry.resolveTarget({
      capabilityName: 'mobile.notifications',
      targetPreference: mobileTargetPreference,
    });

    expect(resolution.status).toBe('unavailable');
    if (resolution.status === 'unavailable') {
      expect(resolution.reason).not.toBe('unimplemented');
    }
  });

  it('an explicit device target does NOT fall back to another device', () => {
    const { registry } = buildRegistry();
    registerDesktop(registry);
    registerMobile(registry, { deviceId: 'mobile:phone-123' });

    const resolution = registry.resolveTarget({
      capabilityName: 'mobile.notifications',
      targetPreference: { kind: 'device', deviceId: 'mobile:inexistente' },
    });

    expect(resolution.status).toBe('unavailable');
  });

  it('any target picks a compatible device when one is present', () => {
    const { registry } = buildRegistry();
    registerDesktop(registry);
    registerMobile(registry);

    const resolution = registry.resolveTarget({
      capabilityName: 'mobile.notifications',
      targetPreference: ANY_TARGET_PREFERENCE,
    });

    expect(resolution.status).toBe('resolved');
  });

  it('any target reports unavailable when no device can do it', () => {
    const { registry } = buildRegistry();
    registerDesktop(registry);

    const resolution = registry.resolveTarget({
      capabilityName: 'mobile.media',
      targetPreference: ANY_TARGET_PREFERENCE,
    });

    expect(resolution.status).toBe('unavailable');
    if (resolution.status === 'unavailable') {
      expect(resolution.reason).toBe('capability_absent');
    }
  });
});

describe('B11 §7: presence y reconexión sin duplicar sesión', () => {
  it('keeps the 30s / 45s / 90s thresholds', () => {
    const { registry, setNow } = buildRegistry();
    registerMobile(registry, { lastSeenAt: START });

    setNow(START + 30_000);
    expect(registry.resolvePresence('mobile:phone-123')).toBe('online');
    setNow(START + 45_000);
    expect(registry.resolvePresence('mobile:phone-123')).toBe('degraded');
    setNow(START + PRESENCE_OFFLINE_AFTER_MILLISECONDS);
    expect(registry.resolvePresence('mobile:phone-123')).toBe('offline');
  });

  it('a reconnect updates the same device instead of creating a second one', () => {
    const { registry } = buildRegistry();
    registerMobile(registry, { connectionId: 'mobile-1' });
    registerMobile(registry, {
      connectionId: 'mobile-2',
      capabilityNameList: [
        'mobile.notifications',
        'mobile.alarm',
        'mobile.media',
        'mobile.volume',
      ],
    });

    expect(registry.listDeviceList()).toHaveLength(1);
    const session = registry.getDevice('mobile:phone-123');
    expect(session?.transport.connectionId).toBe('mobile-2');
    expect(session?.availableCapabilities).toEqual([
      'mobile.notifications',
      'mobile.alarm',
      'mobile.media',
      'mobile.volume',
    ]);
  });

  it('an offline mobile is unavailable and never silently rerouted', () => {
    const { registry, setNow } = buildRegistry();
    registerDesktop(registry);
    registerMobile(registry, { lastSeenAt: START });

    // El registry es UNO solo: la presence se calcula por reloj para todos los
    // deviceTypes. Para que la desktop siga viva hay que darle su heartbeat,
    // igual que en producción.
    setNow(START + PRESENCE_OFFLINE_AFTER_MILLISECONDS + 1_000);
    registry.recordHeartbeat({ proof, deviceId: 'desktop:PC-ESTUDIO' });

    const resolution = registry.resolveTarget({
      capabilityName: 'mobile.notifications',
      targetPreference: mobileTargetPreference,
    });
    expect(resolution.status).toBe('unavailable');
    expect(registry.resolvePresence('mobile:phone-123')).toBe('offline');

    // La desktop sigue viva: el default NO cambia de cuerpo.
    const desktopResolution = registry.resolveTarget({
      capabilityName: 'desktop.open_app',
      targetPreference: desktopTargetPreference,
    });
    expect(desktopResolution.status).toBe('resolved');
  });
});

describe('B11 §3 y §9: contrato de capability y queueability', () => {
  it('every mobile capability declares deviceType, status, commandList y queueability', () => {
    const mobileContractList = listCapabilityContractList().filter(
      (contract) => contract.deviceType === 'mobile',
    );
    expect(mobileContractList).toHaveLength(6);
    for (const contract of mobileContractList) {
      expect(contract.status).toBe('implemented');
      expect(contract.commandList.length).toBeGreaterThan(0);
      expect(['queueable', 'realtime_only']).toContain(contract.queueability);
    }
  });

  it('declares queueable only where the device persists it', () => {
    const expectedQueueability = {
      'mobile.notifications': 'queueable',
      'mobile.alarm': 'queueable',
      'mobile.calendar': 'queueable',
      'mobile.media': 'realtime_only',
      'mobile.volume': 'realtime_only',
      'mobile.open_app': 'realtime_only',
    } as const;
    for (const [capabilityName, queueability] of Object.entries(expectedQueueability)) {
      expect(describeCapability(capabilityName as CapabilityName).queueability).toBe(
        queueability,
      );
    }
  });

  it('desktop capabilities stay realtime_only', () => {
    for (const contract of listCapabilityContractList()) {
      if (contract.deviceType === 'desktop') {
        expect(contract.queueability).toBe('realtime_only');
      }
    }
  });

  it('every mobile command has a strict payload schema', () => {
    for (const commandName of MOBILE_COMMAND_NAME_LIST) {
      // Tira si el comando no tiene schema: es lo que impide agregar un comando
      // al catálogo sin definir su forma.
      expect(() => readMobilePayloadSchema(commandName)).not.toThrow();
    }
  });

  it('every implemented mobile command has a schema', () => {
    for (const contract of listCapabilityContractList()) {
      for (const commandName of contract.commandList) {
        if (contract.deviceType === 'mobile') {
          expect(() => readMobilePayloadSchema(commandName)).not.toThrow();
        }
      }
    }
  });
});

describe('B11 §1: Apollo sigue siendo el unico orquestador', () => {
  it('the registry holds one entry per deviceId across both device types', () => {
    const { registry } = buildRegistry();
    registerDesktop(registry);
    registerMobile(registry);

    const deviceIdList = registry
      .listDeviceList()
      .map((device) => `${device.deviceType}:${device.deviceId}`)
      .toSorted();
    expect(deviceIdList).toEqual([
      'desktop:desktop:PC-ESTUDIO',
      'mobile:mobile:phone-123',
    ]);
  });

  it('the same deviceId cannot be registered with the wrong deviceType', () => {
    const { registry } = buildRegistry();
    registerDesktop(registry, { deviceId: 'desktop:colision' });

    // `parseDeviceIdentity` rechaza el deviceId cuyo prefijo no matchea el
    // deviceType declarado: un peer no puede disfrazarse de otro cuerpo.
    const outcome = registry.register({
      proof,
      deviceId: 'desktop:colision',
      deviceType: 'mobile',
      identitySource: 'client_provided',
      capabilityNameList: ['mobile.notifications'],
      protocolVersion: 1,
      lastSeenAt: START,
      transport: { transportKind: 'mobile_websocket', connectionId: 'mobile-9' },
    });

    expect(outcome.status).toBe('rejected');
    if (outcome.status === 'rejected') {
      expect(outcome.reason).toContain('device_id_type_mismatch');
    }
    expect(registry.listDeviceList()).toHaveLength(1);
    expect(registry.getDevice('desktop:colision')?.deviceType).toBe('desktop');
  });
});

describe('B11 §4 y §16: resolución de comando en el bridge', () => {
  it('rejects a desktop capability as unsupported_command', () => {
    // El peer mobile no puede ejecutar una capability desktop. Esta es la línea
    // exacta que el mutation check M intenta romper.
    const resolution = resolveMobileCommand('desktop.open_app', { appName: 'chrome' });

    expect(resolution.isResolved).toBe(false);
    if (!resolution.isResolved) {
      expect(resolution.reason).toBe('unsupported_command');
    }
  });

  it('rejects a command its capability does not declare', () => {
    const resolution = resolveMobileCommand(
      'mobile.media',
      { query: 'album' },
      'media_stop',
    );

    expect(resolution.isResolved).toBe(false);
    if (!resolution.isResolved) {
      expect(resolution.reason).toBe('unsupported_command');
    }
  });

  it('accepts a declared command and validates its payload', () => {
    const resolution = resolveMobileCommand(
      'mobile.media',
      { query: 'album' },
      'media_play',
    );

    expect(resolution.isResolved).toBe(true);
    if (resolution.isResolved) {
      expect(resolution.commandName).toBe('media_play');
      expect(resolution.payload).toEqual({ query: 'album' });
    }
  });

  it('falls back to the canonical command when none is given', () => {
    const resolution = resolveMobileCommand('mobile.media', { query: 'album' });

    expect(resolution.isResolved).toBe(true);
    if (resolution.isResolved) {
      expect(resolution.commandName).toBe('media_play');
    }
  });

  /**
   * El payload se valida contra el schema del COMANDO, no de la capability.
   * Esto lo encontró el cliente Kotlin ejecutándose de verdad: con schema por
   * capability, `alarm_cancel` (que manda sólo `{label}`) fallaba siempre.
   */
  it('validates the payload against the command schema, not the capability schema', () => {
    const cancelWithoutHour = resolveMobileCommand(
      'mobile.alarm',
      { label: 'Despertar' },
      'alarm_cancel',
    );
    expect(cancelWithoutHour.isResolved).toBe(true);

    const setWithoutHour = resolveMobileCommand(
      'mobile.alarm',
      { label: 'Despertar' },
      'alarm_set',
    );
    expect(setWithoutHour.isResolved).toBe(false);
    if (!setWithoutHour.isResolved) {
      expect(setWithoutHour.reason).toBe('invalid_payload');
    }
  });

  it('rejects a payload that does not match the command schema', () => {
    const resolution = resolveMobileCommand(
      'mobile.alarm',
      { hourMinute: '07:30' },
      'alarm_cancel',
    );

    expect(resolution.isResolved).toBe(false);
    if (!resolution.isResolved) {
      expect(resolution.reason).toBe('invalid_payload');
    }
  });

  it('rejects a strict payload with an extra field', () => {
    const resolution = resolveMobileCommand('mobile.notifications', {
      title: 'Apollo',
      body: 'Hola',
      icon: 'x',
    });

    expect(resolution.isResolved).toBe(false);
    if (!resolution.isResolved) {
      expect(resolution.reason).toBe('invalid_payload');
    }
  });
});

describe('B11 §9: el catálogo no declara implemented sin comando real', () => {
  it('every implemented capability has at least one command', () => {
    for (const contract of listCapabilityContractList()) {
      if (contract.status === 'implemented') {
        expect(contract.commandList.length).toBeGreaterThan(0);
      }
    }
  });

  it('an unimplemented capability never resolves, even if a device declares it', () => {
    const { registry } = buildRegistry();
    registerMobile(registry, {
      capabilityNameList: ['mobile.notifications', 'desktop.volume' as CapabilityName],
    });

    // `desktop.volume` es contract-only: declarado por el peer pero nunca
    // disponible, y por eso jamás resolvible.
    const session = registry.getDevice('mobile:phone-123');
    expect(session?.availableCapabilities).toEqual(['mobile.notifications']);

    const resolution = registry.resolveTarget({
      capabilityName: 'desktop.volume',
      targetPreference: ANY_TARGET_PREFERENCE,
    });
    expect(resolution.status).toBe('unavailable');
    if (resolution.status === 'unavailable') {
      expect(resolution.reason).toBe('unimplemented');
    }
  });

  it('a declared capability from another deviceType never becomes available', () => {
    const { registry } = buildRegistry();
    registerMobile(registry, {
      capabilityNameList: [
        'mobile.notifications',
        'desktop.open_app' as CapabilityName,
        'desktop.spotify' as CapabilityName,
      ],
    });

    const session = registry.getDevice('mobile:phone-123');
    expect(session?.availableCapabilities).toEqual(['mobile.notifications']);
  });
});

describe('B11 §2: el resolver enruta por contrato, no por prefijo de texto', () => {
  /**
   * Hoy `capabilityName.startsWith('mobile.')` y
   * `describeCapabilityDeviceType(capabilityName)` coinciden para las 19
   * capabilities del catálogo, así que un test de comportamiento NO los
   * diferencia: hace falta un guard de fuente que prohíba la heurística.
   * Es el mismo criterio que usan los guards estructurales de PcBridge.
   */
  it('resolve.ts derives the deviceType from the catalog, not from the name prefix', () => {
    const resolveSource = readFileSync(join(import.meta.dir, '..', 'resolve.ts'), 'utf8');
    expect(resolveSource).toContain('describeCapabilityDeviceType(capabilityName)');
    expect(resolveSource).not.toContain("capabilityName.startsWith('mobile.')");
    expect(resolveSource).not.toContain('capabilityName.startsWith("mobile.")');
    expect(resolveSource).not.toContain("startsWith('mobile.')");
    expect(resolveSource).not.toMatch(/startsWith\(['"]mobile\./);
  });

  it('every catalog capability name and its contract deviceType agree', () => {
    // Si mañana una capability se llamara distinto a su prefijo, esta aserción
    // avisa antes de que la heurística y el contrato divergan.
    for (const contract of listCapabilityContractList()) {
      const prefix = contract.deviceType === 'mobile' ? 'mobile.' : 'desktop.';
      expect(contract.name.startsWith(prefix)).toBe(true);
    }
  });

  it('the dedup key separates device and request with a delimiter', () => {
    expect(buildCompletedCommandKey('mobile:a', 'r1')).toBe('mobile:a:r1');
    expect(buildCompletedCommandKey('mobile:a', 'r1')).not.toBe(
      buildCompletedCommandKey('mobile:b', 'r1'),
    );
  });
});
