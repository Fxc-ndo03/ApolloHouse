import { z } from 'zod';

// ─────────────────────────────────────────────────────────────────────────────
// Identidad de dispositivo (Block 7).
//
// Un deviceId es estable y específico del dispositivo. El hostname es una
// identidad de transporte heredada del desktop, NO una identidad global: mobile
// no puede registrarse con hostname porque un teléfono no lo expone y porque
// cambiaría al roamear.
//
// Formato: `<deviceType>:<value>`, igual que el que ya usa el desktop
// (`desktop:PC-ESTUDIO`) para no romper los registros existentes.
// ─────────────────────────────────────────────────────────────────────────────

export const DEVICE_TYPE_LIST = ['desktop', 'mobile'] as const;
export const deviceTypeSchema = z.enum(DEVICE_TYPE_LIST);
export type DeviceType = z.infer<typeof deviceTypeSchema>;

export const DEVICE_ID_SEPARATOR = ':';

// Un deviceId es `<deviceType>:<value>` con un value no vacío.
export const deviceIdSchema = z
  .string()
  .min(3)
  .max(128)
  .refine(
    (candidateDeviceId) => {
      const separatorIndex = candidateDeviceId.indexOf(DEVICE_ID_SEPARATOR);
      if (separatorIndex <= 0) {
        return false;
      }
      const prefix = candidateDeviceId.slice(0, separatorIndex);
      const value = candidateDeviceId.slice(separatorIndex + 1);
      return (
        (DEVICE_TYPE_LIST as readonly string[]).includes(prefix) &&
        value.trim().length > 0
      );
    },
    {
      message: 'deviceId inválido: se espera "<desktop|mobile>:<valor>"',
    },
  );

// De dónde salió la identidad. El desktop legacy deriva del hostname; cualquier
// device nuevo (mobile incluido) la declara el cliente y es estable.
export const DEVICE_IDENTITY_SOURCE_LIST = [
  'client_provided',
  'desktop_hostname_legacy',
  // FASE 2.4: deviceId persistente de la instalación declarado en el hello.
  'device_id',
] as const;
export const deviceIdentitySourceSchema = z.enum(DEVICE_IDENTITY_SOURCE_LIST);
export type DeviceIdentitySource = z.infer<typeof deviceIdentitySourceSchema>;

export type DeviceIdentity = {
  readonly deviceId: string;
  readonly deviceType: DeviceType;
  readonly identitySource: DeviceIdentitySource;
};

export type DeviceIdentityRejection = {
  readonly reason:
    | 'malformed_device_id'
    | 'device_id_type_mismatch'
    | 'mobile_requires_client_provided_identity';
  readonly detail: string;
};

// El prefijo del deviceId tiene que concordar con el deviceType declarado: si no,
// un cliente podría pedir targeting por tipo y recibir el device equivocado.
export function parseDeviceIdentity(input: {
  readonly deviceId: string;
  readonly deviceType: DeviceType;
  readonly identitySource: DeviceIdentitySource;
}): DeviceIdentity | DeviceIdentityRejection {
  const parsedDeviceId = deviceIdSchema.safeParse(input.deviceId);
  if (!parsedDeviceId.success) {
    return { reason: 'malformed_device_id', detail: input.deviceId };
  }
  const separatorIndex = input.deviceId.indexOf(DEVICE_ID_SEPARATOR);
  const idDeviceType = input.deviceId.slice(0, separatorIndex);
  if (idDeviceType !== input.deviceType) {
    return {
      reason: 'device_id_type_mismatch',
      detail: `deviceId dice ${idDeviceType} pero se declaró ${input.deviceType}`,
    };
  }
  // Un mobile con identidad heredada del hostname sería frágil: el teléfono
  // cambia de hostname y rompería el registro.
  if (input.deviceType === 'mobile' && input.identitySource !== 'client_provided') {
    return {
      reason: 'mobile_requires_client_provided_identity',
      detail: 'mobile no puede registrarse con identidad derivada de hostname',
    };
  }
  return {
    deviceId: input.deviceId,
    deviceType: input.deviceType,
    identitySource: input.identitySource,
  };
}

export function isDeviceIdentityRejection(
  value: DeviceIdentity | DeviceIdentityRejection,
): value is DeviceIdentityRejection {
  return 'reason' in value;
}
