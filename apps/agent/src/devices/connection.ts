import {
  CapabilityRegistry,
  type AuthenticatedDeviceProof,
  type RegistrationOutcome,
} from '@/devices/registry';
import {
  HeartbeatScheduler,
  systemHeartbeatTimerPort,
  type HeartbeatTimerPort,
} from '@/devices/heartbeat';
import type { CapabilityName } from '@/devices/capability';
import type { PresenceState } from '@/devices/schema';
import type { DeviceSession, DeviceTransportKind } from '@/devices/session';
import { emitDeviceHeartbeatEvent } from '@/devices/events';

// ─────────────────────────────────────────────────────────────────────────────
// Ciclo de vida de una conexión de dispositivo, sin saber qué transporte la
// trajo.
//
// El objeto central es DeviceConnection: un socket abierto que todavía NO es un
// dispositivo. No tiene deviceId, ni capabilities, ni presencia usable, y por
// lo tanto no puede ser target de nada. Sólo después de un handshake validado
// con AuthenticatedDeviceProof se convierte en DeviceSession (§3).
//
// El heartbeat se proudue el Worker, con el MISMO intervalo y umbrales que el
// desktop, y hay exactamente un scheduler por deviceId: un reconnect reutiliza
// el scheduler existente en vez de crear un segundo timer (§4, §10).
// ─────────────────────────────────────────────────────────────────────────────

// Un socket abierto. No autenticado significa, por construcción, sin deviceId:
// todavía no sabemos qué dispositivo es, y sin identidad no hay nada que
// pueda ser target.
export type DeviceConnection = {
  readonly connectionId: string;
  readonly transportKind: DeviceTransportKind;
  readonly connectedAt: number;
  readonly authenticated: boolean;
  readonly deviceId: string | null;
};

export function isAuthenticatedDeviceConnection(connection: DeviceConnection): boolean {
  return connection.authenticated && connection.deviceId !== null;
}

export type DeviceRegistrationInput = {
  readonly deviceId: string;
  readonly deviceType: 'desktop' | 'mobile';
  readonly capabilityNameList: readonly CapabilityName[];
  readonly protocolVersion: number;
  readonly identitySource?: 'client_provided' | 'desktop_hostname_legacy';
  readonly hostname?: string;
};

export type HandshakeOutcome =
  | { readonly status: 'authenticated'; readonly session: DeviceSession }
  | { readonly status: 'unauthenticated' }
  | { readonly status: 'rejected'; readonly reason: string };

export type DisconnectOutcome = {
  readonly didStopHeartbeat: boolean;
  readonly didMarkOffline: boolean;
};

export type DeviceSessionLifecycleOptions = {
  readonly registry: CapabilityRegistry;
  readonly timerPort?: HeartbeatTimerPort;
  readonly nowMilliseconds?: () => number;
  // El transporte decide cómo enviar el probe; el lifecycle decide cuándo.
  readonly sendHeartbeatProbe?: (session: DeviceSession) => void;
  readonly heartbeatIntervalMilliseconds?: number;
};

export class DeviceSessionLifecycle {
  readonly #registry: CapabilityRegistry;
  readonly #timerPort: HeartbeatTimerPort;
  readonly #nowMilliseconds: () => number;
  readonly #sendHeartbeatProbe: ((session: DeviceSession) => void) | null;
  readonly #heartbeatIntervalMilliseconds: number | undefined;
  readonly #connectionMap = new Map<string, DeviceConnection>();
  // Un scheduler por deviceId, no por conexión: un reconnect no puede duplicarlo.
  readonly #heartbeatSchedulerMap = new Map<string, HeartbeatScheduler>();

  constructor(options: DeviceSessionLifecycleOptions) {
    this.#registry = options.registry;
    this.#timerPort = options.timerPort ?? systemHeartbeatTimerPort;
    this.#nowMilliseconds = options.nowMilliseconds ?? (() => Date.now());
    this.#sendHeartbeatProbe = options.sendHeartbeatProbe ?? null;
    this.#heartbeatIntervalMilliseconds = options.heartbeatIntervalMilliseconds;
  }

  get nowMilliseconds(): () => number {
    return this.#nowMilliseconds;
  }

  openConnection(input: {
    readonly connectionId: string;
    readonly transportKind: DeviceTransportKind;
  }): DeviceConnection {
    const connection: DeviceConnection = {
      connectionId: input.connectionId,
      transportKind: input.transportKind,
      connectedAt: this.#nowMilliseconds(),
      authenticated: false,
      deviceId: null,
    };
    this.#connectionMap.set(connection.connectionId, connection);
    return connection;
  }

  getConnection(connectionId: string): DeviceConnection | undefined {
    return this.#connectionMap.get(connectionId);
  }

  listConnectionList(): readonly DeviceConnection[] {
    return [...this.#connectionMap.values()];
  }

  // El handshake es el ÚNICO camino que produce una DeviceSession. Sin proof no
  // hay sesión, y sin sesión no hay presencia online ni capabilities resolubles.
  completeHandshake(input: {
    readonly connectionId: string;
    readonly proof: AuthenticatedDeviceProof | null;
    readonly registration: DeviceRegistrationInput;
  }): HandshakeOutcome {
    const connection = this.#connectionMap.get(input.connectionId);
    if (connection === undefined) {
      return { status: 'rejected', reason: 'unknown_connection' };
    }
    const connectedAt = connection.connectedAt;
    const transport = {
      transportKind: connection.transportKind,
      connectionId: connection.connectionId,
    };
    const outcome: RegistrationOutcome = this.#registry.register({
      proof: input.proof,
      deviceId: input.registration.deviceId,
      deviceType: input.registration.deviceType,
      capabilityNameList: input.registration.capabilityNameList,
      protocolVersion: input.registration.protocolVersion,
      identitySource: input.registration.identitySource,
      hostname: input.registration.hostname,
      connectedAt,
      lastSeenAt: this.#nowMilliseconds(),
      transport,
    });
    if (outcome.status !== 'registered') {
      return outcome.status === 'unauthenticated'
        ? { status: 'unauthenticated' }
        : { status: 'rejected', reason: outcome.reason };
    }

    this.#connectionMap.set(connection.connectionId, {
      ...connection,
      authenticated: true,
      deviceId: outcome.device.deviceId,
    });
    this.#startHeartbeat(outcome.device.deviceId);
    return { status: 'authenticated', session: outcome.device };
  }

  // El heartbeat del device es la señal de vida, igual que el pong del desktop:
  // mueve lastSeenAt siempre y devuelve la presencia resultante.
  recordHeartbeat(input: {
    readonly proof: AuthenticatedDeviceProof | null;
    readonly deviceId: string;
    readonly atMilliseconds?: number;
  }): PresenceState | null {
    const beatAt = input.atMilliseconds ?? this.#nowMilliseconds();
    const presence = this.#registry.recordHeartbeat({
      proof: input.proof,
      deviceId: input.deviceId,
      atMilliseconds: beatAt,
    });
    if (presence === null) {
      return null;
    }
    const session = this.#registry.getDevice(input.deviceId);
    if (session !== undefined) {
      emitDeviceHeartbeatEvent({
        event: 'heartbeat_received',
        deviceId: session.deviceId,
        deviceType: session.deviceType,
        protocolVersion: session.protocolVersion,
        atMilliseconds: beatAt,
      });
    }
    return presence;
  }

  disconnect(input: {
    readonly connectionId: string;
    readonly proof: AuthenticatedDeviceProof | null;
  }): DisconnectOutcome {
    const connection = this.#connectionMap.get(input.connectionId);
    if (connection === undefined) {
      return { didStopHeartbeat: false, didMarkOffline: false };
    }
    this.#connectionMap.delete(input.connectionId);
    if (connection.deviceId === null) {
      // Nunca llegó a ser sesión: no hay nada que apagar.
      return { didStopHeartbeat: false, didMarkOffline: false };
    }
    const didStopHeartbeat = this.#stopHeartbeat(connection.deviceId);
    const didMarkOffline = this.#registry.markPresence({
      proof: input.proof,
      deviceId: connection.deviceId,
      presence: 'offline',
    });
    return { didStopHeartbeat, didMarkOffline };
  }

  listHeartbeatSchedulerCount(): number {
    return this.#heartbeatSchedulerMap.size;
  }

  countRunningHeartbeatTimer(): number {
    let running = 0;
    for (const scheduler of this.#heartbeatSchedulerMap.values()) {
      if (scheduler.isRunning) {
        running += 1;
      }
    }
    return running;
  }

  isHeartbeatRunning(deviceId: string): boolean {
    return this.#heartbeatSchedulerMap.get(deviceId)?.isRunning ?? false;
  }

  #startHeartbeat(deviceId: string): void {
    let scheduler = this.#heartbeatSchedulerMap.get(deviceId);
    if (scheduler === undefined) {
      scheduler = new HeartbeatScheduler(this.#heartbeatIntervalMilliseconds);
      this.#heartbeatSchedulerMap.set(deviceId, scheduler);
    }
    // start() devuelve false si ya había uno vivo: un reconnect no duplica el
    // timer, reutiliza el que ya existe.
    scheduler.start(this.#timerPort, () => {
      this.#sendHeartbeatProbeOnce(deviceId);
    });
  }

  #stopHeartbeat(deviceId: string): boolean {
    return this.#heartbeatSchedulerMap.get(deviceId)?.stop(this.#timerPort) ?? false;
  }

  #sendHeartbeatProbeOnce(deviceId: string): void {
    const session = this.#registry.getDevice(deviceId);
    if (session === undefined || this.#sendHeartbeatProbe === null) {
      return;
    }
    this.#sendHeartbeatProbe(session);
    emitDeviceHeartbeatEvent({
      event: 'heartbeat_sent',
      deviceId: session.deviceId,
      deviceType: session.deviceType,
      protocolVersion: session.protocolVersion,
      atMilliseconds: this.#nowMilliseconds(),
    });
  }
}
