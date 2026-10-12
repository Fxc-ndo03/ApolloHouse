import {
  describeCapability,
  isImplementedCapability,
  type CapabilityName,
} from '@/devices/capability';
import { emitDeviceEvent, type DeviceEventCorrelation } from '@/devices/events';
import {
  isDeviceIdentityRejection,
  parseDeviceIdentity,
  type DeviceIdentitySource,
} from '@/devices/identity';
import {
  deviceCapabilityListSchema,
  isProtocolVersionCompatible,
  type DeviceType,
  type PresenceState,
  type TargetPreference,
} from '@/devices/schema';
import {
  deviceSessionSchema,
  doesSessionMatchTargetPreference,
  isDeviceSessionPresent,
  isSelectableDeviceSession,
  resolveAvailableCapabilityList,
  resolveSessionEffectivePresence,
  type DeviceSession,
  type DeviceTransportMetadata,
} from '@/devices/session';

// ─────────────────────────────────────────────────────────────────────────────
// CapabilityRegistry: responde UNA sola pregunta —"¿qué dispositivo puede hacer
// esto?"—.
//
// NO autoriza, NO ejecuta, NO decide seguridad. La cadena completa es:
//   capability discovery → target selection → authorization → execution
// y este módulo es sólo los dos primeros pasos. La autorización sigue siendo la
// de Block 4 (executeToolByName / authorizeToolExecution), y la ejecución la
// de las tools existentes.
// ─────────────────────────────────────────────────────────────────────────────

const DEVICE_AUTHENTICATED_BRAND: unique symbol = Symbol('device-authenticated');

export type AuthenticatedDeviceProof = {
  readonly [DEVICE_AUTHENTICATED_BRAND]: true;
  readonly connectionRole: 'device' | 'dashboard';
};

// Nominal e imposible de fabricar desde un camino no autenticado: sólo lo
// construye buildAuthenticatedDeviceProof, que sólo llama el código que ya
// pasó por authorizeApolloConnection.
export function buildAuthenticatedDeviceProof(
  connectionRole: 'device' | 'dashboard',
): AuthenticatedDeviceProof {
  return { [DEVICE_AUTHENTICATED_BRAND]: true, connectionRole };
}

export type RegistrationOutcome =
  | {
      readonly status: 'registered';
      readonly device: DeviceSession;
      readonly isNewDevice: boolean;
    }
  | { readonly status: 'unauthenticated' }
  | { readonly status: 'rejected'; readonly reason: string };

export type CapabilityUnavailableReason =
  | 'no_device'
  | 'capability_absent'
  | 'target_unavailable'
  | 'unimplemented'
  // El target se resolvió bien pero dejó de estar disponible antes de ejecutar.
  // No lo devuelve resolveTarget: lo detecta el runtime al revalidar.
  | 'target_offline';

export type CapabilityResolution =
  | {
      readonly status: 'resolved';
      readonly device: DeviceSession;
      readonly capabilityName: CapabilityName;
      readonly consideredDeviceCount: number;
    }
  | {
      readonly status: 'unavailable';
      readonly reason: CapabilityUnavailableReason;
      readonly capabilityName: CapabilityName;
      readonly consideredDeviceCount: number;
    };

export type RegistryOptions = {
  readonly nowMilliseconds?: () => number;
  readonly correlation?: DeviceEventCorrelation;
};

export class CapabilityRegistry {
  readonly #sessionMap = new Map<string, DeviceSession>();
  readonly #lastEmittedPresenceMap = new Map<string, PresenceState>();
  readonly #nowMilliseconds: () => number;
  readonly #correlation: DeviceEventCorrelation;

  constructor(options: RegistryOptions = {}) {
    this.#nowMilliseconds = options.nowMilliseconds ?? (() => Date.now());
    this.#correlation = options.correlation ?? {};
  }

  // Idempotente por deviceId: el mismo dispositivo actualiza su registro, no
  // lo duplica. Volver aanutscribir un hello es la operación normal.
  register(input: {
    readonly proof: AuthenticatedDeviceProof | null;
    readonly deviceId: string;
    readonly deviceType: DeviceType;
    readonly capabilityNameList: readonly CapabilityName[];
    readonly protocolVersion: number;
    // BLOCK 7: si no se declara, se asume identidad estable del cliente. El
    // único que puede reclamar 'desktop_hostname_legacy' es el transporte del
    // desktop, que de verdad deriva del hostname.
    readonly identitySource?: DeviceIdentitySource;
    readonly hostname?: string;
    readonly connectedAt?: number;
    readonly lastSeenAt?: number;
    readonly transport: DeviceTransportMetadata;
  }): RegistrationOutcome {
    if (input.proof === null) {
      emitDeviceEvent({
        ...this.#correlation,
        event: 'device_registered',
        deviceId: input.deviceId,
        deviceType: input.deviceType,
        detail: 'unauthenticated',
      });
      return { status: 'unauthenticated' };
    }
    if (!isProtocolVersionCompatible(input.protocolVersion)) {
      return {
        status: 'rejected',
        reason: `protocolVersion incompatible: ${input.protocolVersion}`,
      };
    }
    const identity = parseDeviceIdentity({
      deviceId: input.deviceId,
      deviceType: input.deviceType,
      identitySource: input.identitySource ?? 'client_provided',
    });
    if (isDeviceIdentityRejection(identity)) {
      return { status: 'rejected', reason: `${identity.reason}: ${identity.detail}` };
    }

    const now = this.#nowMilliseconds();
    const previousSession = this.#sessionMap.get(input.deviceId);
    const declaredCapabilityList = deviceCapabilityListSchema.parse(
      input.capabilityNameList,
    );
    const parsedSession = deviceSessionSchema.safeParse({
      sessionId: input.transport.connectionId,
      deviceId: identity.deviceId,
      deviceType: identity.deviceType,
      identitySource: identity.identitySource,
      protocolVersion: input.protocolVersion,
      // Una sesión en el registry siempre está autenticada: se llega aquí sólo
      // con proof, y el tipo lo vuelve imposible de otro modo (§3).
      authenticated: true,
      connectedAt: input.connectedAt ?? now,
      lastSeenAt: input.lastSeenAt ?? now,
      // Lo que dice el device, y lo que puede hacer hoy. Una capability
      // unimplemented se declara pero nunca queda disponible (§5).
      declaredCapabilities: declaredCapabilityList,
      availableCapabilities: [
        ...resolveAvailableCapabilityList(declaredCapabilityList, identity.deviceType),
      ],
      presence: 'online',
      transport: input.transport,
      priority: previousSession?.priority ?? 50,
    });
    if (!parsedSession.success) {
      return { status: 'rejected', reason: parsedSession.error.message };
    }
    const session = parsedSession.data;
    this.#sessionMap.set(session.deviceId, session);

    if (previousSession === undefined) {
      emitDeviceEvent({
        ...this.#correlation,
        event: 'device_registered',
        deviceId: session.deviceId,
        deviceType: session.deviceType,
        presence: session.presence,
        protocolVersion: session.protocolVersion,
      });
    } else {
      if (previousSession.presence !== session.presence) {
        emitDeviceEvent({
          ...this.#correlation,
          event: 'device_presence_changed',
          deviceId: session.deviceId,
          deviceType: session.deviceType,
          presence: session.presence,
          protocolVersion: session.protocolVersion,
        });
      }
      if (
        previousSession.availableCapabilities.join(',') !==
        session.availableCapabilities.join(',')
      ) {
        emitDeviceEvent({
          ...this.#correlation,
          event: 'device_capabilities_updated',
          deviceId: session.deviceId,
          deviceType: session.deviceType,
          presence: session.presence,
          protocolVersion: session.protocolVersion,
        });
      }
    }
    return {
      status: 'registered',
      device: session,
      isNewDevice: previousSession === undefined,
    };
  }

  // El heartbeat (pong) es la señal de vida. Actualiza lastSeenAt SIEMPRE: si
  // sólo cambiara la presencia, un desktop con pong cada 30 s seguiría
  // expirando a los 90 s del hello, porque lastSeenAt nunca avanzaría.
  recordHeartbeat(input: {
    readonly proof: AuthenticatedDeviceProof | null;
    readonly deviceId: string;
    readonly atMilliseconds?: number;
  }): PresenceState | null {
    if (input.proof === null) {
      return null;
    }
    const session = this.#sessionMap.get(input.deviceId);
    if (session === undefined) {
      return null;
    }
    const beatAt = input.atMilliseconds ?? this.#nowMilliseconds();
    const updatedSession: DeviceSession = {
      ...session,
      lastSeenAt: beatAt,
      presence: 'online',
    };
    this.#sessionMap.set(updatedSession.deviceId, updatedSession);
    this.#emitPresenceTransition(updatedSession, 'online', beatAt);
    return 'online';
  }

  // Presencia efectiva de un device, según la política y el último heartbeat.
  resolvePresence(deviceId: string): PresenceState | null {
    const device = this.#sessionMap.get(deviceId);
    if (device === undefined) {
      return null;
    }
    return resolveSessionEffectivePresence(device, this.#nowMilliseconds());
  }

  markPresence(input: {
    readonly proof: AuthenticatedDeviceProof | null;
    readonly deviceId: string;
    readonly presence: PresenceState;
  }): boolean {
    if (input.proof === null) {
      return false;
    }
    const device = this.#sessionMap.get(input.deviceId);
    if (device === undefined) {
      return false;
    }
    if (device.presence === input.presence) {
      return true;
    }
    const updatedSession: DeviceSession = { ...device, presence: input.presence };
    this.#sessionMap.set(updatedSession.deviceId, updatedSession);
    emitDeviceEvent({
      ...this.#correlation,
      event: 'device_presence_changed',
      deviceId: updatedSession.deviceId,
      deviceType: updatedSession.deviceType,
      presence: updatedSession.presence,
      protocolVersion: updatedSession.protocolVersion,
    });
    return true;
  }

  updateCapabilityList(input: {
    readonly proof: AuthenticatedDeviceProof | null;
    readonly deviceId: string;
    readonly capabilityNameList: readonly CapabilityName[];
    readonly lastSeenAt?: number;
  }): boolean {
    if (input.proof === null) {
      return false;
    }
    const device = this.#sessionMap.get(input.deviceId);
    if (device === undefined) {
      return false;
    }
    const declaredCapabilityList = deviceCapabilityListSchema.parse(
      input.capabilityNameList,
    );
    const updatedSession: DeviceSession = {
      ...device,
      declaredCapabilities: declaredCapabilityList,
      availableCapabilities: [
        ...resolveAvailableCapabilityList(declaredCapabilityList, device.deviceType),
      ],
      lastSeenAt: input.lastSeenAt ?? this.#nowMilliseconds(),
    };
    this.#sessionMap.set(updatedSession.deviceId, updatedSession);
    emitDeviceEvent({
      ...this.#correlation,
      event: 'device_capabilities_updated',
      deviceId: updatedSession.deviceId,
      deviceType: updatedSession.deviceType,
      presence: updatedSession.presence,
      protocolVersion: updatedSession.protocolVersion,
    });
    return true;
  }

  listDeviceList(): readonly DeviceSession[] {
    return [...this.#sessionMap.values()];
  }

  getDevice(deviceId: string): DeviceSession | undefined {
    return this.#sessionMap.get(deviceId);
  }

  // Sesiones que un target puede usar ahora mismo: autenticadas, con alguna
  // capability disponible y presencia viva (§3).
  listSelectableSessionList(): readonly DeviceSession[] {
    const now = this.#nowMilliseconds();
    return this.listDeviceList().filter((session) =>
      isSelectableDeviceSession(session, now),
    );
  }

  listDeviceIdForCapabilityList(capabilityName: CapabilityName): readonly string[] {
    return this.listDeviceList()
      .filter((session) => session.availableCapabilities.includes(capabilityName))
      .map((session) => session.deviceId);
  }

  // Política determinista y sin sorpresas:
  //  1. target preference explícita (si no puede, NO hay fallback silencioso)
  //  2. presencia disponible (online/degraded y no stale)
  //  3. capability presente y unimplemented descartada
  //  4. lastSeen más reciente
  //  5. prioridad configurada
  //  6. deviceId, para que el resultado sea estable
  resolveTarget(input: {
    readonly capabilityName: CapabilityName;
    readonly targetPreference: TargetPreference;
  }): CapabilityResolution {
    const consideredDeviceCount = this.#sessionMap.size;
    if (!isImplementedCapability(input.capabilityName)) {
      const resolution: CapabilityResolution = {
        status: 'unavailable',
        reason: 'unimplemented',
        capabilityName: input.capabilityName,
        consideredDeviceCount,
      };
      this.#logResolution(resolution, input);
      return resolution;
    }

    const now = this.#nowMilliseconds();
    const candidateList = this.listDeviceList()
      .filter((session) =>
        doesSessionMatchTargetPreference(session, input.targetPreference),
      )
      .filter((session) => session.availableCapabilities.includes(input.capabilityName))
      .filter((session) =>
        input.targetPreference.kind === 'device'
          ? true
          : isDeviceSessionPresent(session, now),
      )
      .toSorted((leftDevice, rightDevice) => {
        const leftPresence = resolveSessionEffectivePresence(leftDevice, now);
        const rightPresence = resolveSessionEffectivePresence(rightDevice, now);
        if (leftPresence !== rightPresence) {
          return leftPresence === 'online' ? -1 : 1;
        }
        if (leftDevice.lastSeenAt !== rightDevice.lastSeenAt) {
          return rightDevice.lastSeenAt - leftDevice.lastSeenAt;
        }
        if (leftDevice.priority !== rightDevice.priority) {
          return rightDevice.priority - leftDevice.priority;
        }
        return leftDevice.deviceId.localeCompare(rightDevice.deviceId);
      });

    if (candidateList.length === 0) {
      const resolution: CapabilityResolution = {
        status: 'unavailable',
        reason: this.#resolveUnavailableReason(input, now),
        capabilityName: input.capabilityName,
        consideredDeviceCount,
      };
      this.#logResolution(resolution, input);
      return resolution;
    }

    const selectedDevice = candidateList[0];
    if (selectedDevice === undefined) {
      throw new Error('candidateList vacío tras el filtro');
    }
    const resolution: CapabilityResolution = {
      status: 'resolved',
      device: selectedDevice,
      capabilityName: input.capabilityName,
      consideredDeviceCount,
    };
    this.#logResolution(resolution, input);
    return resolution;
  }

  #resolveUnavailableReason(
    input: {
      readonly capabilityName: CapabilityName;
      readonly targetPreference: TargetPreference;
    },
    nowMilliseconds: number,
  ): CapabilityUnavailableReason {
    if (this.#sessionMap.size === 0) {
      return 'no_device';
    }
    const matchingTargetList = this.listDeviceList().filter((device) =>
      doesSessionMatchTargetPreference(device, input.targetPreference),
    );
    if (matchingTargetList.length === 0) {
      return 'target_unavailable';
    }
    const capableList = matchingTargetList.filter((device) =>
      device.availableCapabilities.includes(input.capabilityName),
    );
    if (capableList.length === 0) {
      return 'capability_absent';
    }
    return capableList.some((device) => isDeviceSessionPresent(device, nowMilliseconds))
      ? 'capability_absent'
      : 'target_unavailable';
  }

  // Los heartbeats individuales son debug; las transiciones de presencia son
  // eventos normales. Sin spam: sólo se emite cuando el estado cambia.
  #emitPresenceTransition(
    device: DeviceSession,
    presence: PresenceState,
    atMilliseconds: number,
  ): void {
    const previousPresence = this.#lastEmittedPresenceMap.get(device.deviceId);
    if (previousPresence === presence) {
      return;
    }
    this.#lastEmittedPresenceMap.set(device.deviceId, presence);
    emitDeviceEvent({
      ...this.#correlation,
      event:
        presence === 'online'
          ? 'presence_online'
          : presence === 'degraded'
            ? 'presence_degraded'
            : 'presence_offline',
      deviceId: device.deviceId,
      deviceType: device.deviceType,
      presence,
      protocolVersion: device.protocolVersion,
      detail: `last_heartbeat_at=${atMilliseconds}`,
    });
  }

  #logResolution(
    resolution: CapabilityResolution,
    input: {
      readonly capabilityName: CapabilityName;
      readonly targetPreference: TargetPreference;
    },
  ): void {
    if (resolution.status === 'resolved') {
      emitDeviceEvent({
        ...this.#correlation,
        event: 'capability_resolution',
        deviceId: resolution.device.deviceId,
        deviceType: resolution.device.deviceType,
        capabilityName: input.capabilityName,
        presence: resolveSessionEffectivePresence(
          resolution.device,
          this.#nowMilliseconds(),
        ),
        protocolVersion: resolution.device.protocolVersion,
        detail: `target=${input.targetPreference.kind}`,
      });
      return;
    }
    emitDeviceEvent({
      ...this.#correlation,
      event: 'capability_unavailable',
      deviceId: 'none',
      deviceType:
        input.targetPreference.kind === 'device_type'
          ? input.targetPreference.deviceType
          : 'desktop',
      capabilityName: input.capabilityName,
      detail: resolution.status === 'unavailable' ? resolution.reason : 'unknown',
    });
  }
}

export function listPcBridgeCommandListForCapability(
  capabilityName: CapabilityName,
): readonly string[] {
  return describeCapability(capabilityName).commandList;
}
