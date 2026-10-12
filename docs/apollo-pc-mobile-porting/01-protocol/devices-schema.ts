import { z } from 'zod';

import { capabilityNameSchema } from '@/devices/capability';
import { deviceIdSchema, deviceTypeSchema, type DeviceType } from '@/devices/identity';

// Unions exhaustivas: no hay strings libres para deviceType ni presence.

export {
  DEVICE_TYPE_LIST,
  deviceTypeSchema,
  type DeviceType,
  type DeviceIdentitySource,
} from '@/devices/identity';

export const PRESENCE_STATE_LIST = ['online', 'offline', 'degraded', 'unknown'] as const;
export const presenceStateSchema = z.enum(PRESENCE_STATE_LIST);
export type PresenceState = z.infer<typeof presenceStateSchema>;

export const protocolVersionSchema = z.number().int().positive();

// Versión que asume un cliente que todavía no declara la suya. Existe una
// política explícita (LEGACY_PROTOCOL_VERSION) en vez de un default silencioso.
export const LEGACY_PROTOCOL_VERSION = 1;
export const MINIMUM_SUPPORTED_PROTOCOL_VERSION = 1;

export function isProtocolVersionCompatible(protocolVersion: number): boolean {
  return (
    protocolVersion >= MINIMUM_SUPPORTED_PROTOCOL_VERSION &&
    protocolVersion <= LEGACY_PROTOCOL_VERSION + 8
  );
}

export const deviceCapabilityListSchema = z
  .array(capabilityNameSchema)
  .max(64)
  .transform((capabilityNameList) => [...new Set(capabilityNameList)]);

export const targetPreferenceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('any') }),
  z.object({ kind: z.literal('device_type'), deviceType: deviceTypeSchema }),
  z.object({ kind: z.literal('device'), deviceId: deviceIdSchema }),
]);
export type TargetPreference = z.infer<typeof targetPreferenceSchema>;

export const ANY_TARGET_PREFERENCE: TargetPreference = { kind: 'any' };
export const desktopTargetPreference: TargetPreference = {
  kind: 'device_type',
  deviceType: 'desktop',
};
export const mobileTargetPreference: TargetPreference = {
  kind: 'device_type',
  deviceType: 'mobile',
};

export function buildDesktopTargetPreference(): TargetPreference {
  return desktopTargetPreference;
}

export function isSameDeviceTypePreference(
  preference: TargetPreference,
  deviceType: DeviceType,
): boolean {
  return preference.kind === 'device_type' && preference.deviceType === deviceType;
}
