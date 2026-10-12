import {
  listImplementedCapabilityNameList,
  type CapabilityName,
} from '@/devices/capability';
import { LEGACY_PROTOCOL_VERSION, type DeviceType } from '@/devices/schema';
import type { DeviceIdentitySource } from '@/devices/identity';
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
  return {
    deviceId: buildDesktopDeviceIdFromHostname(input.hostname),
    deviceType: 'desktop',
    // El desktop sí deriva su id del hostname (identidad de transporte heredada).
    // Es explícito para que ningún otro device type pueda aplicarlo.
    identitySource: 'desktop_hostname_legacy',
    capabilityNameList: resolveDesktopCapabilityNameList(input.hello.capabilities),
    protocolVersion: input.hello.protocolVersion ?? LEGACY_PROTOCOL_VERSION,
    lastSeenAt: input.nowMilliseconds,
  };
}

// Adaptador de producción: pregunta al PcBridge, que es quien tiene la conexión
// real y su registry.
export function buildPcBridgeCapabilityTargetResolver(
  environment: Env,
): CapabilityTargetResolver {
  return async ({ capabilityName, targetPreference }) => {
    const { getAgentByName } = await import('agents');
    const pcBridge = await getAgentByName(environment.PcBridge, 'pc-bridge');
    const answer = (await pcBridge.resolveCapabilityTarget({
      capabilityName,
      targetPreference,
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
