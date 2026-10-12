import {
  describeCapability,
  describeCapabilityDeviceType,
  isImplementedCapability,
  type CapabilityName,
} from '@/devices/capability';
import type { CapabilityUnavailableReason } from '@/devices/registry';
import {
  desktopTargetPreference,
  mobileTargetPreference,
  targetPreferenceSchema,
  type DeviceType,
  type PresenceState,
  type TargetPreference,
} from '@/devices/schema';

// Puente entre el CapabilityRegistry (discovery + target selection) y el runtime
// de ejecución. Este módulo NO ejecuta ni autoriza: sólo traduce intención →
// capability → target y describe por qué no hay target.
//
// La cadena completa queda:
//   intent → router → capability → REGISTRY(target) → AUTHORIZATION → EXECUTION

export type ResolvedCapabilityTarget = {
  readonly deviceId: string;
  readonly deviceType: DeviceType;
  readonly presence: PresenceState;
};

export type CapabilityTargetResolution =
  | { readonly status: 'resolved'; readonly target: ResolvedCapabilityTarget }
  | { readonly status: 'unavailable'; readonly reason: CapabilityUnavailableReason };

export type CapabilityTargetResolver = (input: {
  readonly capabilityName: CapabilityName;
  readonly targetPreference: TargetPreference;
}) => Promise<CapabilityTargetResolution>;

export type CapabilityResolutionTiming = {
  readonly capabilityResolutionMs: number;
};

// ── capability → tool existente ─────────────────────────────────────────────
// Sólo capabilities implementadas, y sólo tools que ya existen. El mapa se
// valida contra el catálogo builtin en los tests para que no se desincronice.
const CAPABILITY_TOOL_NAME_MAP: ReadonlyMap<CapabilityName, readonly string[]> = new Map([
  ['desktop.open_app', ['open_pc_app']],
  ['desktop.focus_app', ['focus_pc_app']],
  ['desktop.close_app', ['close_pc_app']],
  ['desktop.list_apps', ['list_pc_apps']],
  ['desktop.lock', ['lock_pc_screen']],
  [
    'desktop.spotify',
    [
      'spotify_play',
      'spotify_pause',
      'spotify_next',
      'spotify_previous',
      'spotify_get_state',
    ],
  ],
  // BLOCK 9: la única capability mobile con tool real.
  ['mobile.notifications', ['send_mobile_notification']],
]);

export function listToolNameForCapability(
  capabilityName: CapabilityName,
): readonly string[] {
  if (!isImplementedCapability(capabilityName)) {
    return [];
  }
  return CAPABILITY_TOOL_NAME_MAP.get(capabilityName) ?? [];
}

export function listConnectedCapabilityNameList(): readonly CapabilityName[] {
  return [...CAPABILITY_TOOL_NAME_MAP.keys()];
}

// Inversa: qué capability representa una tool. Se usa al revalidar el target de
// una confirmación, que guarda el toolName y no la capability.
const TOOL_NAME_TO_CAPABILITY_MAP: ReadonlyMap<string, CapabilityName> = new Map(
  [...CAPABILITY_TOOL_NAME_MAP.entries()].flatMap(([capabilityName, toolNameList]) =>
    toolNameList.map((toolName) => [toolName, capabilityName] as const),
  ),
);

// Sin mapping NO se inventa capability: una tool cloud-only o desconocida
// simplemente no tiene target que resolver (undefined), y el pipeline la trata
// como no-targeted. Un default inventado haría que una tool sin target pasara
// por el registry como si fuera de escritorio.
export function getCapabilityForToolName(toolName: string): CapabilityName | undefined {
  return TOOL_NAME_TO_CAPABILITY_MAP.get(toolName);
}

export function listCapabilityNameForToolName(
  toolName: string,
): CapabilityName | undefined {
  return getCapabilityForToolName(toolName);
}

// Toda tool que necesita un device remoto para ejecutarse.
export function requiresExecutionTarget(toolName: string): boolean {
  return getCapabilityForToolName(toolName) !== undefined;
}

// ── mensajes de indisponibilidad ────────────────────────────────────────────
const UNAVAILABLE_RESPONSE_TEXT_MAP: ReadonlyMap<CapabilityUnavailableReason, string> =
  new Map([
    ['no_device', 'No tengo ningún dispositivo conectado.'],
    ['capability_absent', 'Ese dispositivo no puede hacer eso.'],
    ['target_unavailable', 'Ese dispositivo no está disponible ahora.'],
    ['unimplemented', 'Todavía no puedo hacer eso.'],
    [
      'target_offline',
      'Ese dispositivo se desconectó antes de que terminara. No lo ejecuté.',
    ],
  ]);

export function describeUnavailableCapability(
  reason: CapabilityUnavailableReason,
): string {
  return UNAVAILABLE_RESPONSE_TEXT_MAP.get(reason) ?? 'No puedo hacer eso ahora.';
}

export function normalizeTargetPreference(
  rawTargetPreference: unknown,
): TargetPreference {
  const parsedTargetPreference = targetPreferenceSchema.safeParse(rawTargetPreference);
  return parsedTargetPreference.success ? parsedTargetPreference.data : { kind: 'any' };
}

// Un resolver vacío: sin registry inyectado, el runtime se comporta como antes
// (sin gate de target) en vez de bloquear la acción.
export const unconfiguredCapabilityTargetResolver: CapabilityTargetResolver =
  async () => ({
    status: 'unavailable',
    reason: 'no_device',
  });

export function listCommandNameForCapability(
  capabilityName: CapabilityName,
): readonly string[] {
  return describeCapability(capabilityName).commandList;
}

// Adaptador in-process: mismo Registry, sin RPC. Es lo que usan los tests y lo
// que usaría un runtime que ya tenga el registry en memoria.
export function buildRegistryCapabilityTargetResolver(registry: {
  resolveTarget: (input: {
    readonly capabilityName: CapabilityName;
    readonly targetPreference: TargetPreference;
  }) => {
    readonly status: 'resolved' | 'unavailable';
    readonly device?: { readonly deviceId: string; readonly deviceType: DeviceType };
    readonly reason?: CapabilityUnavailableReason;
  };
  resolvePresence: (deviceId: string) => PresenceState | null;
}): CapabilityTargetResolver {
  return async ({ capabilityName, targetPreference }) => {
    const resolution = registry.resolveTarget({ capabilityName, targetPreference });
    if (resolution.status === 'unavailable' || resolution.device === undefined) {
      return {
        status: 'unavailable',
        reason: resolution.reason ?? 'capability_absent',
      };
    }
    return {
      status: 'resolved',
      target: {
        deviceId: resolution.device.deviceId,
        deviceType: resolution.device.deviceType,
        presence: normalizePresence(registry.resolvePresence(resolution.device.deviceId)),
      },
    };
  };
}

export function normalizeUnavailableReason(
  rawReason: string | null,
): CapabilityUnavailableReason {
  switch (rawReason) {
    case 'no_device':
    case 'capability_absent':
    case 'target_unavailable':
    case 'unimplemented':
      return rawReason;
    default:
      return 'target_unavailable';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Resolver device-agnostic (Block 7).
//
// Un resolver por tipo de device. El código futuro pregunta por el resolver de
// 'mobile' sin importar PcBridge ni ningún handler de escritorio: sólo el
// módulo de transporte de cada deviceType registra el suyo.
// ─────────────────────────────────────────────────────────────────────────────
export type CapabilityResolverMap = ReadonlyMap<DeviceType, CapabilityTargetResolver>;

export function buildCapabilityResolverMap(
  resolverByDeviceTypeMap: Partial<Record<DeviceType, CapabilityTargetResolver>>,
): CapabilityResolverMap {
  return new Map(
    Object.entries(resolverByDeviceTypeMap) as [DeviceType, CapabilityTargetResolver][],
  );
}

export function resolveCapabilityTargetForDeviceType(input: {
  readonly resolverMap: CapabilityResolverMap;
  readonly deviceType: DeviceType;
  readonly capabilityName: CapabilityName;
  readonly targetPreference: TargetPreference;
}): Promise<CapabilityTargetResolution> {
  const resolver = input.resolverMap.get(input.deviceType);
  if (resolver === undefined) {
    return Promise.resolve({ status: 'unavailable', reason: 'no_device' });
  }
  return resolver({
    capabilityName: input.capabilityName,
    targetPreference: input.targetPreference,
  });
}

// El target preference de una capability sale del CONTRATO (deviceType), no de
// un prefijo de texto.
export function buildTargetPreferenceForCapabilityName(
  capabilityName: CapabilityName,
): TargetPreference {
  return describeCapabilityDeviceType(capabilityName) === 'desktop'
    ? desktopTargetPreference
    : mobileTargetPreference;
}

export function normalizePresence(rawPresence: string | null): PresenceState {
  switch (rawPresence) {
    case 'online':
    case 'offline':
    case 'degraded':
    case 'unknown':
      return rawPresence;
    default:
      return 'unknown';
  }
}
