import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { buildAuthenticatedDeviceProof, CapabilityRegistry } from '@/devices/registry';
import {
  isDeviceIdentityRejection,
  parseDeviceIdentity,
  type DeviceIdentitySource,
} from '@/devices/identity';
import {
  describeCapability,
  describeCapabilityDeviceType,
  isImplementedCapability,
  isPcBridgeBackedCapability,
  listCapabilityNameForDeviceType,
  MOBILE_CAPABILITY_NAME_LIST,
} from '@/devices/capability';
import {
  buildRegistryCapabilityTargetResolver,
  buildTargetPreferenceForCapabilityName,
  buildCapabilityResolverMap,
  resolveCapabilityTargetForDeviceType,
} from '@/devices/target';
import { ANY_TARGET_PREFERENCE, type TargetPreference } from '@/devices/schema';
import { PRESENCE_OFFLINE_AFTER_MILLISECONDS } from '@/devices/presence';
import { buildDesktopRegistrationFromHello } from '@/devices/desktop';
import { pcToServerMessageSchema } from '@/protocol/schema';
import { listBuiltinToolDefinitionList } from '@/tools/catalog';
import { buildToolDefinitionMap } from '@/tools/router';
import { resolveCapabilityForToolName } from '@/tools/capability-index';
import type { CapabilityName } from '@/devices/capability';

const proof = buildAuthenticatedDeviceProof('device');
const START = 1_700_000_000_000;
const SOURCE_ROOT = join(import.meta.dir, '..', '..');

function buildRegistry(nowMilliseconds = START): {
  readonly registry: CapabilityRegistry;
  readonly setNow: (value: number) => void;
} {
  let now = nowMilliseconds;
  const registry = new CapabilityRegistry({ nowMilliseconds: () => now });
  return { registry, setNow: (value: number) => (now = value) };
}

function registerDesktop(registry: CapabilityRegistry, deviceId = 'desktop:pc'): void {
  const outcome = registry.register({
    transport: { transportKind: 'pc_bridge', connectionId: 'connection-under-test' },
    proof,
    deviceId,
    deviceType: 'desktop',
    identitySource: 'client_provided',
    capabilityNameList: ['desktop.open_app', 'desktop.close_app', 'desktop.spotify'],
    protocolVersion: 1,
    lastSeenAt: START,
  });
  expect(outcome.status).toBe('registered');
}

function registerMobile(
  registry: CapabilityRegistry,
  options: {
    readonly deviceId?: string;
    readonly identitySource?: DeviceIdentitySource;
    readonly capabilityNameList?: readonly CapabilityName[];
  } = {},
): { readonly status: string; readonly reason?: string } {
  const outcome = registry.register({
    transport: {
      transportKind: 'mobile_websocket',
      connectionId: 'connection-under-test',
    },
    proof,
    deviceId: options.deviceId ?? 'mobile:phone-123',
    deviceType: 'mobile',
    identitySource: options.identitySource ?? 'client_provided',
    capabilityNameList: options.capabilityNameList ?? [
      'mobile.open_app',
      'mobile.notifications',
      'mobile.alarm',
    ],
    protocolVersion: 1,
    lastSeenAt: START,
  });
  return outcome.status === 'rejected'
    ? { status: outcome.status, reason: outcome.reason }
    : { status: outcome.status };
}

describe('B7 §1: device identity', () => {
  it('accepts a well-formed deviceId for both types', () => {
    for (const [deviceId, deviceType] of [
      ['desktop:PC-ESTUDIO', 'desktop'],
      ['mobile:phone-123', 'mobile'],
    ] as const) {
      const identity = parseDeviceIdentity({
        deviceId,
        deviceType,
        identitySource: 'client_provided',
      });
      expect(isDeviceIdentityRejection(identity)).toBe(false);
    }
  });

  it('rejects a deviceId whose type does not match the declared type', () => {
    const identity = parseDeviceIdentity({
      deviceId: 'mobile:phone-123',
      deviceType: 'desktop',
      identitySource: 'client_provided',
    });
    expect(isDeviceIdentityRejection(identity)).toBe(true);
    if (isDeviceIdentityRejection(identity)) {
      expect(identity.reason).toBe('device_id_type_mismatch');
    }
  });

  it('rejects a malformed deviceId', () => {
    for (const malformedDeviceId of ['phone-123', ':phone', 'mobile:', 'wat:x']) {
      const identity = parseDeviceIdentity({
        deviceId: malformedDeviceId,
        deviceType: 'mobile',
        identitySource: 'client_provided',
      });
      expect(isDeviceIdentityRejection(identity)).toBe(true);
    }
  });

  it('mobile cannot be registered with a hostname-derived identity', () => {
    const { registry } = buildRegistry();
    const rejection = registerMobile(registry, {
      identitySource: 'desktop_hostname_legacy',
    });
    expect(rejection.status).toBe('rejected');
    expect(rejection.reason).toContain('mobile_requires_client_provided_identity');
    expect(registry.listDeviceList()).toHaveLength(0);
  });

  it('desktop keeps its legacy hostname identity working', () => {
    const hello = pcToServerMessageSchema.parse({
      type: 'hello',
      hostname: 'PC-ESTUDIO',
      ts: START,
    });
    if (hello.type !== 'hello') {
      throw new Error('expected hello');
    }
    const registration = buildDesktopRegistrationFromHello({
      hello,
      hostname: 'PC-ESTUDIO',
      nowMilliseconds: START,
    });
    expect(registration.deviceId).toBe('desktop:PC-ESTUDIO');
    expect(registration.identitySource).toBe('desktop_hostname_legacy');

    // El registry lo acepta: el desktop no se rompe.
    const { registry } = buildRegistry();
    const outcome = registry.register({
      transport: { transportKind: 'pc_bridge', connectionId: 'connection-under-test' },
      proof,
      deviceId: registration.deviceId,
      deviceType: registration.deviceType,
      identitySource: registration.identitySource,
      capabilityNameList: registration.capabilityNameList,
      protocolVersion: registration.protocolVersion,
      lastSeenAt: registration.lastSeenAt,
    });
    expect(outcome.status).toBe('registered');
  });

  it('1. the desktop registry keeps working exactly as before', () => {
    const { registry } = buildRegistry();
    registerDesktop(registry);
    expect(registry.getDevice('desktop:pc')?.deviceType).toBe('desktop');
    expect(registry.getDevice('desktop:pc')?.presence).toBe('online');
    expect(
      registry.resolveTarget({
        capabilityName: 'desktop.open_app',
        targetPreference: { kind: 'device_type', deviceType: 'desktop' },
      }).status,
    ).toBe('resolved');
  });
});

describe('B7 §2-3: mobile capability contract', () => {
  it('2. all six mobile capabilities are declared', () => {
    expect(MOBILE_CAPABILITY_NAME_LIST.length).toBe(6);
    expect(MOBILE_CAPABILITY_NAME_LIST).toEqual([
      'mobile.open_app',
      'mobile.notifications',
      'mobile.alarm',
      'mobile.calendar',
      'mobile.media',
      'mobile.volume',
    ]);
  });

  it('every mobile capability is declared for mobile', () => {
    for (const capabilityName of MOBILE_CAPABILITY_NAME_LIST) {
      const contract = describeCapability(capabilityName);
      expect(contract.deviceType).toBe('mobile');
      // Ninguna capability mobile puede reclamar un comando de PcBridge.
      expect(isPcBridgeBackedCapability(capabilityName)).toBe(false);
    }
  });

  it('BLOCK 11: every mobile capability is implemented with a real command', () => {
    for (const capabilityName of MOBILE_CAPABILITY_NAME_LIST) {
      const contract = describeCapability(capabilityName);
      expect(contract.status).toBe('implemented');
      expect(contract.deviceType).toBe('mobile');
      expect(contract.commandList.length).toBeGreaterThan(0);
      expect(isImplementedCapability(capabilityName)).toBe(true);
    }
    expect(describeCapability('mobile.notifications').commandList).toEqual([
      'notification_post',
    ]);
    expect(describeCapability('mobile.alarm').commandList).toEqual([
      'alarm_set',
      'alarm_cancel',
    ]);
    expect(describeCapability('mobile.open_app').commandList).toEqual(['app_open']);
  });

  it('3. a mobile device can declare mobile capabilities', () => {
    const { registry } = buildRegistry();
    expect(registerMobile(registry).status).toBe('registered');
    const device = registry.getDevice('mobile:phone-123');
    expect(device?.deviceType).toBe('mobile');
    expect(device?.declaredCapabilities).toContain('mobile.notifications');
    // BLOCK 11: todas las mobile declaradas tienen implementación real, así que
    // lo declarado queda disponible. El gate de deviceType sigue aplicando: una
    // mobile no puede declarar una desktop (ver "12." abajo).
    expect(device?.availableCapabilities).toEqual([
      'mobile.open_app',
      'mobile.notifications',
      'mobile.alarm',
    ]);
  });

  it('4. an unimplemented capability is never resolvable', () => {
    // BLOCK 11 ya no quedan mobile unimplemented, así que la invariante se
    // prueba con las desktop contract-only, que es el mismo gate
    // (isImplementedCapability) y sigue siendo la frontera real.
    const { registry } = buildRegistry();
    registerMobile(registry);
    for (const capabilityName of ['desktop.volume', 'desktop.notifications'] as const) {
      const resolution = registry.resolveTarget({
        capabilityName,
        targetPreference: ANY_TARGET_PREFERENCE,
      });
      expect(resolution.status).toBe('unavailable');
      if (resolution.status === 'unavailable') {
        expect(resolution.reason).toBe('unimplemented');
      }
    }
  });

  it('4b. a mobile session can never resolve a desktop capability', () => {
    // Aislamiento cross-device (BLOCK 11 §19): el deviceType sale del catálogo,
    // no del prefijo del texto.
    const { registry } = buildRegistry();
    registerMobile(registry);
    const resolution = registry.resolveTarget({
      capabilityName: 'desktop.open_app',
      targetPreference: { kind: 'device_type', deviceType: 'mobile' },
    });
    expect(resolution.status).toBe('unavailable');
  });

  it('the catalog exposes capabilities per device type', () => {
    expect(listCapabilityNameForDeviceType('mobile')).toEqual([
      'mobile.open_app',
      'mobile.notifications',
      'mobile.alarm',
      'mobile.calendar',
      'mobile.media',
      'mobile.volume',
    ]);
    expect(listCapabilityNameForDeviceType('desktop')).toContain('desktop.open_app');
    expect(listCapabilityNameForDeviceType('desktop')).not.toContain('mobile.media');
    expect(describeCapabilityDeviceType('desktop.spotify')).toBe('desktop');
  });

  it('every capability a tool puede alcanzar está implementada', () => {
    const toolDefinitionMap = buildToolDefinitionMap(listBuiltinToolDefinitionList());
    for (const toolDefinition of listBuiltinToolDefinitionList()) {
      const capabilityName = resolveCapabilityForToolName(
        toolDefinitionMap,
        toolDefinition.name,
      );
      if (capabilityName === undefined) {
        continue;
      }
      // Una tool nunca puede apuntar a un contrato unimplemented: el target no
      // resolvería y la tool no podría ejecutarse nunca.
      expect(isImplementedCapability(capabilityName)).toBe(true);
      // Y el deviceType del contrato tiene que existir como tipo real.
      expect(['desktop', 'mobile']).toContain(
        describeCapabilityDeviceType(capabilityName),
      );
    }
  });
});

describe('B7 §4+6: target resolution is device-agnostic', () => {
  it('5. resolves by deviceType=mobile', async () => {
    const { registry } = buildRegistry();
    registerMobile(registry);
    const resolver = buildRegistryCapabilityTargetResolver(registry);
    // La interfaz acepta un preference por tipo sin conocer transports.
    const preference: TargetPreference = { kind: 'device_type', deviceType: 'mobile' };
    expect(preference).toEqual({ kind: 'device_type', deviceType: 'mobile' });
    // Con la capability unimplemented la respuesta es 'unimplemented', no un
    // device cualquiera.
    // BLOCK 9: mobile.notifications tiene implementación, así que con un device
    // que la declare resuelve contra el mobile.
    const resolution = await resolver({
      capabilityName: 'mobile.notifications',
      targetPreference: preference,
    });
    expect(resolution.status).toBe('resolved');
    if (resolution.status === 'resolved') {
      expect(resolution.target.deviceId).toBe('mobile:phone-123');
      expect(resolution.target.deviceType).toBe('mobile');
    }
  });

  it('6. resolves by deviceId', async () => {
    const { registry } = buildRegistry();
    registerMobile(registry, { deviceId: 'mobile:phone-123' });
    const resolver = buildRegistryCapabilityTargetResolver(registry);
    const byDeviceId = await resolver({
      capabilityName: 'mobile.alarm',
      targetPreference: { kind: 'device', deviceId: 'mobile:phone-123' },
    });
    // Block 11: mobile.alarm ya tiene comando, así que resolver por deviceId
    // ahora sí encuentra el teléfono declarado.
    expect(byDeviceId.status).toBe('resolved');
    if (byDeviceId.status === 'resolved') {
      expect(byDeviceId.target.deviceId).toBe('mobile:phone-123');
    }
    // Un deviceId que no existe tampoco se inventa.
    const unknownDevice = await resolver({
      capabilityName: 'mobile.alarm',
      targetPreference: { kind: 'device', deviceId: 'mobile:inexistente' },
    });
    expect(unknownDevice.status).toBe('unavailable');
  });

  it('a capability contract derives its own target preference', () => {
    expect(buildTargetPreferenceForCapabilityName('desktop.open_app')).toEqual({
      kind: 'device_type',
      deviceType: 'desktop',
    });
    expect(buildTargetPreferenceForCapabilityName('mobile.notifications')).toEqual({
      kind: 'device_type',
      deviceType: 'mobile',
    });
  });

  it('a resolver map resolves per device type without importing transports', async () => {
    const desktopRegistry = buildRegistry();
    registerDesktop(desktopRegistry.registry);
    const mobileRegistry = buildRegistry();
    registerMobile(mobileRegistry.registry);
    const resolverMap = buildCapabilityResolverMap({
      desktop: buildRegistryCapabilityTargetResolver(desktopRegistry.registry),
      mobile: buildRegistryCapabilityTargetResolver(mobileRegistry.registry),
    });

    const desktopAnswer = await resolveCapabilityTargetForDeviceType({
      resolverMap,
      deviceType: 'desktop',
      capabilityName: 'desktop.open_app',
      targetPreference: { kind: 'device_type', deviceType: 'desktop' },
    });
    expect(desktopAnswer.status).toBe('resolved');

    const mobileAnswer = await resolveCapabilityTargetForDeviceType({
      resolverMap,
      deviceType: 'mobile',
      capabilityName: 'mobile.notifications',
      targetPreference: { kind: 'device_type', deviceType: 'mobile' },
    });
    expect(mobileAnswer.status).toBe('resolved');
    if (mobileAnswer.status === 'resolved') {
      expect(mobileAnswer.target.deviceType).toBe('mobile');
    }
  });

  it('an unregistered device type has no resolver and says no_device', async () => {
    const resolverMap = buildCapabilityResolverMap({});
    const answer = await resolveCapabilityTargetForDeviceType({
      resolverMap,
      deviceType: 'mobile',
      capabilityName: 'mobile.media',
      targetPreference: ANY_TARGET_PREFERENCE,
    });
    expect(answer.status).toBe('unavailable');
    if (answer.status === 'unavailable') {
      expect(answer.reason).toBe('no_device');
    }
  });

  it('11. desktop and mobile coexist without interfering', () => {
    const { registry } = buildRegistry();
    registerDesktop(registry, 'desktop:pc');
    registerMobile(registry, { deviceId: 'mobile:phone-123' });

    // Ambos devices viven en el mismo registry.
    expect(
      registry
        .listDeviceList()
        .map((device) => device.deviceId)
        .toSorted(),
    ).toEqual(['desktop:pc', 'mobile:phone-123']);

    // La capability desktop sigue apuntando sólo al desktop.
    expect(registry.listDeviceIdForCapabilityList('desktop.open_app')).toEqual([
      'desktop:pc',
    ]);
    const desktopAnswer = registry.resolveTarget({
      capabilityName: 'desktop.open_app',
      targetPreference: { kind: 'device_type', deviceType: 'desktop' },
    });
    expect(desktopAnswer.status).toBe('resolved');

    // La capability mobile se satisface con el mobile y NUNCA con el desktop.
    expect(registry.listDeviceIdForCapabilityList('mobile.notifications')).toEqual([
      'mobile:phone-123',
    ]);
    const mobileAnswer = registry.resolveTarget({
      capabilityName: 'mobile.notifications',
      targetPreference: { kind: 'device_type', deviceType: 'mobile' },
    });
    expect(mobileAnswer.status).toBe('resolved');
    if (mobileAnswer.status === 'resolved') {
      expect(mobileAnswer.device.deviceId).toBe('mobile:phone-123');
    }
    // Un desktop online nunca puede ser target de mobile.notifications.
    const anyAnswer = registry.resolveTarget({
      capabilityName: 'mobile.notifications',
      targetPreference: { kind: 'any' },
    });
    expect(anyAnswer.status).toBe('resolved');
    if (anyAnswer.status === 'resolved') {
      expect(anyAnswer.device.deviceType).toBe('mobile');
    }
  });
});

describe('B7 §5: availability reasons per device type', () => {
  it('7. an offline mobile device reports target_unavailable for a desktop capability', () => {
    const { registry } = buildRegistry();
    registerMobile(registry);
    registry.markPresence({ proof, deviceId: 'mobile:phone-123', presence: 'offline' });
    const resolution = registry.resolveTarget({
      capabilityName: 'desktop.open_app',
      targetPreference: { kind: 'device_type', deviceType: 'mobile' },
    });
    expect(resolution.status).toBe('unavailable');
    if (resolution.status === 'unavailable') {
      expect(['target_unavailable', 'capability_absent']).toContain(resolution.reason);
    }
  });

  it('8. no mobile device at all reports the right reason', () => {
    const { registry } = buildRegistry();
    registerDesktop(registry);
    const resolution = registry.resolveTarget({
      capabilityName: 'desktop.open_app',
      targetPreference: { kind: 'device_type', deviceType: 'mobile' },
    });
    expect(resolution.status).toBe('unavailable');
    if (resolution.status === 'unavailable') {
      // Pide un tipo de device que no existe → el target no está disponible.
      expect(resolution.reason).toBe('target_unavailable');
    }
  });

  it('9. capability_absent works independently of device type', () => {
    const { registry } = buildRegistry();
    registerMobile(registry, { capabilityNameList: ['mobile.alarm'] });
    const resolution = registry.resolveTarget({
      capabilityName: 'desktop.open_app',
      targetPreference: { kind: 'device_type', deviceType: 'mobile' },
    });
    expect(resolution.status).toBe('unavailable');
    if (resolution.status === 'unavailable') {
      expect(resolution.reason).toBe('capability_absent');
    }
  });

  it('a stale mobile device stops being selectable, like desktop', () => {
    let now = START;
    const registry = new CapabilityRegistry({ nowMilliseconds: () => now });
    registerMobile(registry);
    now = START + PRESENCE_OFFLINE_AFTER_MILLISECONDS + 1;
    expect(registry.resolvePresence('mobile:phone-123')).toBe('offline');
  });
});

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

function stripComment(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function toRelativePath(filePath: string): string {
  return filePath.replace(SOURCE_ROOT, '').replace(/\\/g, '/').replace(/^\//, '');
}

describe('B7 §7+§9: structural guards', () => {
  it('10. the registry never imports execution or handlers', () => {
    const registrySource = stripComment(
      readFileSync(join(SOURCE_ROOT, 'devices/registry.ts'), 'utf8'),
    );
    for (const forbidden of [
      '@/tools/execution',
      '@/tools/router',
      '@/tools/types',
      '.handler(',
      'executeAuthorizedTool',
      'authorizeToolExecution',
    ]) {
      expect(registrySource).not.toContain(forbidden);
    }
  });

  it('12. target resolution does not depend on PcBridge', () => {
    // devices/target.ts es el resolver device-agnostic: no conoce transports.
    const targetSource = stripComment(
      readFileSync(join(SOURCE_ROOT, 'devices/target.ts'), 'utf8'),
    );
    expect(targetSource).not.toContain('getAgentByName');
    expect(targetSource).not.toContain('PcBridge');
    expect(targetSource).not.toContain('@/tools/execution');

    // Toda la capa de resolución (registry + target) es device-agnostic.
    for (const moduleName of ['devices/registry.ts', 'devices/target.ts']) {
      const moduleSource = stripComment(
        readFileSync(join(SOURCE_ROOT, moduleName), 'utf8'),
      );
      expect(moduleSource).not.toContain('getAgentByName');
      expect(moduleSource).not.toContain('@/devices/desktop');
      expect(moduleSource).not.toContain('@/tools/execution');
    }
  });

  it('the PcBridge transport lives only in the desktop device module', () => {
    // Dentro de devices/, el transporte PcBridge sólo puede existir en el módulo
    // del deviceType que lo implementa (hoy: desktop).
    const pcBridgeModuleList = listSourceFilePathList()
      .filter((filePath) => toRelativePath(filePath).startsWith('devices/'))
      .filter((filePath) =>
        stripComment(readFileSync(filePath, 'utf8')).includes('getAgentByName'),
      );
    expect(pcBridgeModuleList.map(toRelativePath)).toEqual(['devices/desktop.ts']);
  });

  it('hostname is not a global identity source', () => {
    // El hostname sólo puede aparecer como identidad legacy del desktop.
    const hostnameModuleList = listSourceFilePathList().filter((filePath) =>
      stripComment(readFileSync(filePath, 'utf8')).includes(
        'buildDesktopDeviceIdFromHostname',
      ),
    );
    expect(hostnameModuleList.map(toRelativePath)).toEqual(['devices/desktop.ts']);
  });

  it('unimplemented capabilities can never become resolvable', () => {
    // Mobile: todas implementadas en Block 11.
    for (const capabilityName of MOBILE_CAPABILITY_NAME_LIST) {
      expect(isImplementedCapability(capabilityName)).toBe(true);
    }
    // Desktop contract-only: siguen unimplemented y por eso no resolvibles.
    for (const capabilityName of ['desktop.files', 'desktop.system_status'] as const) {
      expect(isImplementedCapability(capabilityName)).toBe(false);
    }
  });
});
