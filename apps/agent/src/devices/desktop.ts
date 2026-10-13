import {
  listImplementedCapabilityNameList,
  type CapabilityName,
} from '@/devices/capability';
import {
  targetPreferenceSchema,
  LEGACY_PROTOCOL_VERSION,
  type DeviceType,
  type TargetPreference,
} from '@/devices/schema';
import type { DeviceIdentitySource } from '@/devices/identity';
import { deviceIdSchema } from '@/devices/identity';
import {
  normalizePresence,
  normalizeUnavailableReason,
  type CapabilityTargetResolver,
} from '@/devices/target';
import type { PcToServerHelloMessage } from '@/protocol/schema';

// Adaptador desktop: traduce el 'hello' que YA manda el cliente de Windows a un
// registro de dispositivo. No reescribe PcBridge ni el protocolo existente: sólo
// lee campos opcionales que el schema ya acepta.

export const DESKTOP_DEVICE_ID_PREFIX = 'desktop:';

export function buildDesktopDeviceIdFromHostname(hostname: string): string {
  return `${DESKTOP_DEVICE_ID_PREFIX}${hostname}`;
}

// Un cliente que no declara capabilities recibe el conjunto que el desktop de
// hoy implementa de verdad contra PcBridge. Es una política explícita para
// clientes legacy, no un default silencioso de cualquier cosa.
export function resolveDesktopCapabilityNameList(
  declaredCapabilityNameList: readonly CapabilityName[] | undefined,
): readonly CapabilityName[] {
  if (declaredCapabilityNameList === undefined) {
    return listImplementedCapabilityNameList().filter((capabilityName) =>
      capabilityName.startsWith('desktop.'),
    );
  }
  return declaredCapabilityNameList;
}

export function buildDesktopRegistrationFromHello(input: {
  readonly hello: PcToServerHelloMessage;
  readonly hostname: string;
  readonly nowMilliseconds: number;
}): {
  readonly deviceId: string;
  readonly deviceType: DeviceType;
  readonly identitySource: DeviceIdentitySource;
  readonly capabilityNameList: readonly CapabilityName[];
  readonly protocolVersion: number;
  readonly lastSeenAt: number;
} {
  // FASE 2.4: el deviceId persistente de la instalación (si el cliente lo
  // manda y tiene formato válido) gana sobre el hostname. La AUTORIZACIÓN no
  // viene de acá: la resuelve authorizeDesktopHello contra el registro.
  const declaredDeviceId = input.hello.deviceId;
  const usesDeclaredIdentity =
    declaredDeviceId !== undefined && deviceIdSchema.safeParse(declaredDeviceId).success;
  const deviceId = usesDeclaredIdentity
    ? declaredDeviceId
    : buildDesktopDeviceIdFromHostname(input.hostname);
  return {
    deviceId,
    deviceType: 'desktop',
    identitySource: usesDeclaredIdentity ? 'device_id' : 'desktop_hostname_legacy',
    capabilityNameList: resolveDesktopCapabilityNameList(input.hello.capabilities),
    protocolVersion: input.hello.protocolVersion ?? LEGACY_PROTOCOL_VERSION,
    lastSeenAt: input.nowMilliseconds,
  };
}

// Adaptador de producción: pregunta al PcBridge, que es quien tiene la conexión
// real y su registry.
export function buildPcBridgeCapabilityTargetResolver(
  environment: Env,
  requestingAccountId: string | null = null,
): CapabilityTargetResolver {
  return async ({ capabilityName, targetPreference }) => {
    const { getAgentByName } = await import('agents');
    // FASE 2.5 — con cuenta autenticada, el destino se elige entre los
    // desktops ENROLADOS de ESA cuenta, instancia PcBridge por dispositivo.
    if (requestingAccountId !== null) {
      const { selectDesktopTarget } = await import('@/devices/desktop-target');
      const registry = environment.AccountRegistry.getByName('registry');
      const accountDesktopList = await registry.listAccountDesktopDevices(
        requestingAccountId,
      );
      const parsedPreference = targetPreferenceSchema.safeParse(
        targetPreference ?? { kind: 'any' },
      );
      const preference: TargetPreference = parsedPreference.success
        ? parsedPreference.data
        : { kind: 'any' };
      const preferenceKind: 'any' | 'specific' =
        preference.kind === 'device' ? 'specific' : 'any';
      const specificDeviceId =
        preference.kind === 'device' ? preference.deviceId : null;
      const isDesktopOnline = async (deviceId: string): Promise<boolean> => {
        try {
          const bridge = await getAgentByName(environment.PcBridge, deviceId);
          return (await bridge.isDesktopConnectionAlive()) === true;
        } catch {
          return false;
        }
      };
      const candidateStatusList = await Promise.all(
        accountDesktopList.map(async (candidate) => ({
          deviceId: candidate.deviceId,
          isRevoked: candidate.isRevoked,
          isOnline: await isDesktopOnline(candidate.deviceId),
        })),
      );
      const selection = selectDesktopTarget({
        requestingAccountId,
        targetPreference:
          preferenceKind === 'specific' && specificDeviceId !== null
            ? { kind: 'specific', deviceId: specificDeviceId }
            : { kind: 'any' },
        accountDesktopList: candidateStatusList,
        isDesktopOnline: (deviceId) =>
          candidateStatusList.find((candidate) => candidate.deviceId === deviceId)?.isOnline ===
          true,
      });
      if (selection.status !== 'resolved') {
        return {
          status: 'unavailable',
          reason: normalizeUnavailableReason(selection.reason),
        };
      }
      const targetBridge = await getAgentByName(environment.PcBridge, selection.deviceId);
      const presence = (await targetBridge.resolveDesktopPresence()) ?? 'online';
      return {
        status: 'resolved',
        target: {
          deviceId: selection.deviceId,
          deviceType: 'desktop',
          presence: normalizePresence(presence),
        },
      };
    }
    const pcBridge = await getAgentByName(environment.PcBridge, 'pc-bridge');
    const answer = (await pcBridge.resolveCapabilityTarget({
      capabilityName,
      targetPreference,
      requestingAccountId,
    })) as {
      readonly status: 'resolved' | 'unavailable';
      readonly deviceId: string | null;
      readonly deviceType: string | null;
      readonly presence: string | null;
      readonly reason: string | null;
    };
    if (
      answer.status !== 'resolved' ||
      answer.deviceId === null ||
      answer.deviceType === null
    ) {
      return {
        status: 'unavailable',
        reason: normalizeUnavailableReason(answer.reason),
      };
    }
    return {
      status: 'resolved',
      target: {
        deviceId: answer.deviceId,
        deviceType: answer.deviceType === 'mobile' ? 'mobile' : 'desktop',
        presence: normalizePresence(answer.presence),
      },
    };
  };
}
