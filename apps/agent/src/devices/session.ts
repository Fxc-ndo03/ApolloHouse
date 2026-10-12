import { z } from 'zod';

import {
  describeCapabilityDeviceType,
  isImplementedCapability,
  isKnownCapabilityName,
  type CapabilityName,
} from '@/devices/capability';
import {
  deviceIdSchema,
  deviceIdentitySourceSchema,
  deviceTypeSchema,
  type DeviceType,
} from '@/devices/identity';
import { isPresenceSelectable, resolvePresenceFromSignal } from '@/devices/presence';
import {
  deviceCapabilityListSchema,
  presenceStateSchema,
  protocolVersionSchema,
  type PresenceState,
  type TargetPreference,
} from '@/devices/schema';

// ─────────────────────────────────────────────────────────────────────────────
// DeviceSession: la sesión de un dispositivo, independiente del transporte.
//
// Es el ÚNICO modelo de "dispositivo conectado" del Worker. El registry lo
// guarda, el handshake lo construye y el transporte lo lee; nadie mantiene una
// copia paralela con campos distintos (§1).
//
// La diferencia entre conexión y sesión es la frontera de autenticación (§3): un
// socket abierto todavía NO es un DeviceSession. Esa conexión sin autenticar se
// representa en devices/connection.ts como DeviceConnection, que no tiene
// deviceId ni capabilities.
// ─────────────────────────────────────────────────────────────────────────────

export const DEVICE_TRANSPORT_KIND_LIST = ['pc_bridge', 'mobile_websocket'] as const;
export const deviceTransportKindSchema = z.enum(DEVICE_TRANSPORT_KIND_LIST);
export type DeviceTransportKind = z.infer<typeof deviceTransportKindSchema>;

// Metadata mínima: qué transporte trajo la sesión y qué conexión la sostiene.
// Nunca lleva tokens, proofs ni cabeceras: eso no se loggea ni se copia al
// registro (§7).
export const deviceTransportMetadataSchema = z.object({
  transportKind: deviceTransportKindSchema,
  connectionId: z.string().min(1).max(128),
});
export type DeviceTransportMetadata = z.infer<typeof deviceTransportMetadataSchema>;

export const deviceSessionSchema = z.object({
  sessionId: z.string().min(1).max(128),
  deviceId: deviceIdSchema,
  deviceType: deviceTypeSchema,
  identitySource: deviceIdentitySourceSchema,
  protocolVersion: protocolVersionSchema,
  // Literal true a propósito: hace imposible que el registry guarde una sesión
  // no autenticada, porque el tipo no se puede construir. La frontera de §3
  // queda en el compilador, no en una convención.
  authenticated: z.literal(true),
  connectedAt: z.number().int().nonnegative(),
  lastSeenAt: z.number().int().nonnegative(),
  // Lo que el device ANUNCIÓ, aunque el catálogo todavía no lo implemente.
  declaredCapabilities: deviceCapabilityListSchema.default([]),
  // Lo que el device puede hacer HOY: sólo capabilities implementadas. Es la
  // única lista que el targeting puede leer (§5).
  availableCapabilities: deviceCapabilityListSchema,
  presence: presenceStateSchema,
  transport: deviceTransportMetadataSchema,
  priority: z.number().int().min(0).max(100).default(50),
});

export type DeviceSession = z.infer<typeof deviceSessionSchema>;

export type DeclaredCapabilitySplit = {
  readonly knownCapabilityList: readonly CapabilityName[];
  readonly unknownCapabilityList: readonly string[];
};

// Un cliente puede mandar capability names que este catálogo no conoce. Se
// ignoran de forma explícita y se cuentan, para que un nombre desconocido no
// tire la sesión: el handshake tiene que ser tolerante (§2).
export function splitDeclaredCapabilityList(
  candidateList: readonly string[],
): DeclaredCapabilitySplit {
  const knownCapabilityList: CapabilityName[] = [];
  const unknownCapabilityList: string[] = [];
  for (const candidate of candidateList) {
    if (isKnownCapabilityName(candidate)) {
      knownCapabilityList.push(candidate);
      continue;
    }
    unknownCapabilityList.push(candidate);
  }
  return { knownCapabilityList, unknownCapabilityList };
}

// La frontera unimplemented → available vive acá y en ningún otro lugar, y tiene
// DOS condiciones: la capability tiene que estar implementada Y tiene que
// pertenecer al deviceType de la sesión.
//
// La segunda condición no es cosmética: sin ella un device (o un cliente
// comprometido) podría declarar mobile.notifications y el catálogo se la daría
// por disponible, así que un targeting con preference 'any' le mandaría una
// notificación de mobile a una PC.
export function resolveAvailableCapabilityList(
  declaredCapabilityList: readonly CapabilityName[],
  deviceType: DeviceType,
): readonly CapabilityName[] {
  return declaredCapabilityList.filter(
    (capabilityName) =>
      isImplementedCapability(capabilityName) &&
      describeCapabilityDeviceType(capabilityName) === deviceType,
  );
}

export function doesSessionMatchTargetPreference(
  session: DeviceSession,
  preference: TargetPreference,
): boolean {
  switch (preference.kind) {
    case 'any':
      return true;
    case 'device_type':
      return session.deviceType === preference.deviceType;
    case 'device':
      return session.deviceId === preference.deviceId;
  }
}

export function resolveSessionEffectivePresence(
  session: DeviceSession,
  nowMilliseconds: number,
): PresenceState {
  if (session.presence === 'offline') {
    return 'offline';
  }
  const policyPresence = resolvePresenceFromSignal(
    {
      connectionState: session.presence === 'unknown' ? 'closed' : 'open',
      lastHeartbeatAt: session.lastSeenAt,
    },
    nowMilliseconds,
  );
  if (policyPresence === 'offline') {
    return 'offline';
  }
  return policyPresence === 'unknown' ? session.presence : policyPresence;
}

export function isDeviceSessionPresent(
  session: DeviceSession,
  nowMilliseconds: number,
): boolean {
  return isPresenceSelectable(resolveSessionEffectivePresence(session, nowMilliseconds));
}

// Conectado ≠ autenticado ≠ seleccionable. Esta es la única definición de
// "seleccionable": autenticada, con al menos una capability disponible y
// presencia viva.
export function isSelectableDeviceSession(
  session: DeviceSession,
  nowMilliseconds: number,
): boolean {
  return (
    session.authenticated &&
    session.availableCapabilities.length > 0 &&
    isDeviceSessionPresent(session, nowMilliseconds)
  );
}
