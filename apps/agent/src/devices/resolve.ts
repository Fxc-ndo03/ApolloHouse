import { describeCapabilityDeviceType } from '@/devices/capability';
import { buildPcBridgeCapabilityTargetResolver } from '@/devices/desktop';
import { resolveMobileBridgeClient } from '@/devices/bridge-client';
import {
  buildCapabilityResolverMap,
  resolveCapabilityTargetForDeviceType,
  type CapabilityResolverMap,
  type CapabilityTargetResolution,
  type CapabilityTargetResolver,
} from '@/devices/target';
import type { CapabilityName } from '@/devices/capability';
import type { DeviceType } from '@/devices/identity';
import type { PresenceState, TargetPreference } from '@/devices/schema';

// ─────────────────────────────────────────────────────────────────────────────
// Resolver de targets device-agnostic.
//
// El runtime (Apollo) no sabe que hay dos bridges: le pasa UN resolver y este
// decide a quién preguntar según el deviceType que declara el CONTRATO de la
// capability. Por construcción una capability mobile nunca cae en un desktop ni
// al revés — no hay fallback, porque no hay lista de candidatos mezclada.
//
//   discovery → target → authorization → execution, igual que siempre.
// ─────────────────────────────────────────────────────────────────────────────

type MobileBridgeTargetAnswer = {
  readonly status: 'resolved' | 'unavailable';
  readonly deviceId: string | null;
  readonly deviceType: string | null;
  readonly presence: string | null;
  readonly reason: string | null;
};

function normalizeUnavailableReason(
  reason: string | null,
): CapabilityTargetResolution extends never
  ? never
  : Extract<CapabilityTargetResolution, { status: 'unavailable' }>['reason'] {
  switch (reason) {
    case 'capability_absent':
      return 'capability_absent';
    case 'target_unavailable':
      return 'target_unavailable';
    case 'unimplemented':
      return 'unimplemented';
    default:
      return 'no_device';
  }
}

function normalizePresence(presence: string | null): PresenceState {
  if (presence === 'online' || presence === 'degraded' || presence === 'offline') {
    return presence;
  }
  return 'unknown';
}

// El resolver mobile habla con el MobileBridge por RPC interno, igual que el
// desktop con PcBridge: el transporte no se importa, sólo se pregunta.
function buildMobileBridgeCapabilityTargetResolver(
  environment: Env,
): CapabilityTargetResolver {
  return async ({ capabilityName, targetPreference }) => {
    const stub = resolveMobileBridgeClient(environment);
    if (stub === undefined) {
      return { status: 'unavailable', reason: 'no_device' };
    }
    const answer = (await stub.resolveCapabilityTarget({
      capabilityName,
      targetPreference,
    })) as MobileBridgeTargetAnswer;
    if (
      answer.status !== 'resolved' ||
      answer.deviceId === null ||
      answer.deviceType === null
    ) {
      return { status: 'unavailable', reason: normalizeUnavailableReason(answer.reason) };
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

export function buildCapabilityTargetResolver(
  environment: Env,
): CapabilityTargetResolver {
  const resolverMap: CapabilityResolverMap = buildCapabilityResolverMap({
    desktop: buildPcBridgeCapabilityTargetResolver(environment),
    mobile: buildMobileBridgeCapabilityTargetResolver(environment),
  });
  return async ({ capabilityName, targetPreference }) =>
    resolveCapabilityTargetForDeviceType({
      resolverMap,
      deviceType: describeCapabilityDeviceType(capabilityName) as DeviceType,
      capabilityName: capabilityName as CapabilityName,
      targetPreference: targetPreference as TargetPreference,
    });
}
