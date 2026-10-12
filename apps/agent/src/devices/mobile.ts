import {
  DeviceSessionLifecycle,
  type DeviceRegistrationInput,
  type HandshakeOutcome,
} from '@/devices/connection';
import { splitDeclaredCapabilityList, type DeviceSession } from '@/devices/session';
import { describeCapabilityDeviceType } from '@/devices/capability';
import { HEARTBEAT_INTERVAL_MILLISECONDS } from '@/devices/presence';
import { emitDeviceEvent } from '@/devices/events';
import type { AuthenticatedDeviceProof, CapabilityRegistry } from '@/devices/registry';
import type { HeartbeatTimerPort } from '@/devices/heartbeat';
import type { DeviceCommandEnvelope } from '@/devices/envelope';
import type { CapabilityName } from '@/devices/capability';
import {
  encodeServerToMobileMessage,
  parseMobileToServerMessage,
  type MobileToServerMessage,
  type MobileToServerHelloMessage,
  type ServerToMobileMessage,
} from '@/protocol/schema';
import {
  buildDeviceCommandEnvelope,
  deviceCommandResultEnvelopeSchema,
  type DeviceCommandResultEnvelope,
} from '@/devices/envelope';

// ─────────────────────────────────────────────────────────────────────────────
// Adaptador de transporte mobile.
//
// No importa PcBridge, ni handlers, ni tools: traduce wire <-> sesión y nada más.
// El transporte concreto (un WebSocket de Cloudflare u otro) se inyecta como
// port, así que el ciclo de vida se testea entero sin workerd (§12).
//
// El proof lo inyecta el borde con el MISMO authorizeApolloConnection del
// desktop. Este módulo no lo fabrica ni lo adivina: sin proof el handshake
// devuelve 'unauthenticated' y la respuesta es hello_rejected (§3, §10).
// ─────────────────────────────────────────────────────────────────────────────

export type MobileMessagePort = {
  readonly send: (messageText: string) => void;
  readonly close: () => void;
};

export type MobileRegistration = {
  readonly registration: DeviceRegistrationInput;
  // Capabilities que el cliente anunció y este catálogo no conoce. Se ignoran
  // de forma explícita: tirarlas sería rechazar una sesión válida (§2).
  readonly unknownCapabilityList: readonly string[];
  // Capabilities que existen pero pertenecen a otro deviceType. Un mobile no
  // puede reclamar desktop.open_app: si pudiera, el catálogo la daría por
  // disponible y el targeting podría mandarle una capability de desktop al
  // teléfono.
  readonly foreignCapabilityList: readonly string[];
  readonly ignoredCapabilityList: readonly string[];
};

export type MobileHandshakeOutcome =
  | {
      readonly status: 'accepted';
      readonly session: DeviceSession;
      readonly response: ServerToMobileMessage;
      readonly ignoredCapabilityList: readonly string[];
    }
  | {
      readonly status: 'rejected';
      readonly reason: string;
      readonly response: ServerToMobileMessage;
    };

// El hello mobile es un contrato cerrado: deviceType fijo, deviceId estructurado
// y protocolVersion obligatoria (a diferencia del hello legacy del desktop).
export function buildMobileRegistrationFromHello(
  hello: MobileToServerHelloMessage,
): MobileRegistration {
  const split = splitDeclaredCapabilityList(hello.capabilities ?? []);
  const capabilityNameList: (typeof split.knownCapabilityList)[number][] = [];
  const foreignCapabilityList: string[] = [];
  for (const capabilityName of split.knownCapabilityList) {
    if (describeCapabilityDeviceType(capabilityName) === 'mobile') {
      capabilityNameList.push(capabilityName);
      continue;
    }
    foreignCapabilityList.push(capabilityName);
  }
  return {
    registration: {
      deviceId: hello.deviceId,
      deviceType: 'mobile',
      // Mobile nunca deriva identidad de hostname: el cliente la declara.
      identitySource: 'client_provided',
      capabilityNameList,
      protocolVersion: hello.protocolVersion,
    },
    unknownCapabilityList: split.unknownCapabilityList,
    foreignCapabilityList,
    ignoredCapabilityList: [...split.unknownCapabilityList, ...foreignCapabilityList],
  };
}

export function buildMobileHelloAcceptedMessage(input: {
  readonly session: DeviceSession;
  readonly ignoredCapabilityCount: number;
}): ServerToMobileMessage {
  return {
    type: 'hello_accepted',
    deviceId: input.session.deviceId,
    protocolVersion: input.session.protocolVersion,
    // Se devuelve lo que puede hacer HOY, no lo que declaró: la diferencia
    // declared/available es explícita en el handshake (§5).
    availableCapabilities: input.session.availableCapabilities,
    ignoredCapabilityCount: input.ignoredCapabilityCount,
    heartbeatIntervalMilliseconds: HEARTBEAT_INTERVAL_MILLISECONDS,
  };
}

// Sniff mínimo para distinguir "hello inválido" de "basura en el socket": sólo
// mira el discriminante, sin validar nada del resto.
function isDiscardedHello(rawMessageText: string): boolean {
  try {
    const parsed = JSON.parse(rawMessageText) as unknown;
    return (
      typeof parsed === 'object' &&
      parsed !== null &&
      (parsed as { type?: unknown }).type === 'hello'
    );
  } catch {
    return false;
  }
}

export type MobileHelloAuthorization =
  | { readonly isAllowed: true }
  | { readonly isAllowed: false; readonly reason: MobileAuthRejectionReason };

/**
 * Los motivos que el teléfono puede entender. Son parte del contrato: Android
 * usa `credential_revoked` para DEJAR de reconectar en loop, así que agregar uno
 * nuevo es un cambio de comportamiento en el cliente.
 */
export const MOBILE_AUTH_REJECTION_REASON_LIST = [
  'credential_revoked',
  'credential_device_mismatch',
  'device_is_enrolled_or_revoked',
  // BLOCK 12.1 §3: una identidad mobile que nunca se enroló no puede entrar por
  // el secreto global. El teléfono necesita distinguir "enrolate" de "ya estabas
  // enrolado, no uses el secreto global", porque la respuesta es distinta.
  'device_not_enrolled',
] as const;

export type MobileAuthRejectionReason =
  (typeof MOBILE_AUTH_REJECTION_REASON_LIST)[number];

/**
 * BLOCK 12 §1: se consulta en cada `hello`, que es el primer momento en que el
 * cliente declara su identidad.
 *
 * Va como puerto y no como `if` acá adentro porque la regla depende del ámbito
 * de ESA conexión, y el ámbito se decide en el DO. Este módulo sigue sin saber
 * qué es un teléfono enrolled: sólo pregunta y obedece.
 *
 * Es SÍNCRONO a propósito. Consultar el store es async, pero el DO lo resuelve
 * en `onConnect` (antes de que llegue un solo byte) y lo captura acá como una
 * decisión inmutable. El handshake entero sigue siendo síncrono, que es lo que
 * permite que el transport sea testeable sin promesas y sin workerd.
 */
export type MobileHelloAuthorizer = (helloDeviceId: string) => MobileHelloAuthorization;

export type MobilePeerTransportOptions = {
  readonly lifecycle: DeviceSessionLifecycle;
  readonly port: MobileMessagePort;
  readonly connectionId: string;
  readonly nowMilliseconds?: () => number;
  readonly authorizer?: MobileHelloAuthorizer;
};

export class MobilePeerTransport {
  readonly #lifecycle: DeviceSessionLifecycle;
  readonly #port: MobileMessagePort;
  readonly #connectionId: string;
  readonly #nowMilliseconds: () => number;
  readonly #authorizer: MobileHelloAuthorizer | null;
  #authProof: AuthenticatedDeviceProof | null = null;

  constructor(options: MobilePeerTransportOptions) {
    this.#lifecycle = options.lifecycle;
    this.#port = options.port;
    this.#connectionId = options.connectionId;
    this.#nowMilliseconds = options.nowMilliseconds ?? (() => Date.now());
    this.#authorizer = options.authorizer ?? null;
  }

  get connectionId(): string {
    return this.#connectionId;
  }

  get isAuthenticated(): boolean {
    return this.#authProof !== null;
  }

  // El socket ya está abierto, pero el device todavía no es seleccionable: hasta
  // que completeHandshake valide el hello no existe DeviceSession (§3).
  connect(): void {
    this.#lifecycle.openConnection({
      connectionId: this.#connectionId,
      transportKind: 'mobile_websocket',
    });
  }

  // Lo llama el borde una vez que la conexión pasó authorizeApolloConnection.
  authenticate(proof: AuthenticatedDeviceProof | null): void {
    this.#authProof = proof;
  }

  getDeviceId(): string | null {
    return this.#lifecycle.getConnection(this.#connectionId)?.deviceId ?? null;
  }

  handleHelloMessage(rawMessageText: string): MobileHandshakeOutcome {
    const parsed = this.#parseHello(rawMessageText);
    if (parsed === null) {
      return this.#reject('malformed_hello');
    }
    // La identidad se valida ANTES de tocar el registry: una sesión no llega a
    // existir si el ámbito de esta conexión no autoriza ese deviceId.
    if (this.#authorizer !== null) {
      const authorization = this.#authorizer(parsed.deviceId);
      if (!authorization.isAllowed) {
        return this.#reject(authorization.reason);
      }
    }
    const { registration, ignoredCapabilityList } =
      buildMobileRegistrationFromHello(parsed);
    const outcome: HandshakeOutcome = this.#lifecycle.completeHandshake({
      connectionId: this.#connectionId,
      proof: this.#authProof,
      registration,
    });
    if (outcome.status !== 'authenticated') {
      const reason =
        outcome.status === 'unauthenticated' ? 'unauthenticated' : outcome.reason;
      emitDeviceEvent({
        event: 'device_registered',
        deviceId: registration.deviceId,
        deviceType: 'mobile',
        detail: `rejected:${reason}`,
      });
      return this.#reject(reason);
    }
    const response = buildMobileHelloAcceptedMessage({
      session: outcome.session,
      ignoredCapabilityCount: ignoredCapabilityList.length,
    });
    this.#port.send(encodeServerToMobileMessage(response));
    return {
      status: 'accepted',
      session: outcome.session,
      response,
      ignoredCapabilityList,
    };
  }

  // El heartbeat del mobile cuenta igual que el pong del desktop: mismo
  // intervalo, mismos umbrales, misma actualización de lastSeenAt (§4).
  handleHeartbeatMessage(rawMessageText: string): boolean {
    const parsed = this.#parseMessage(rawMessageText);
    if (parsed === null || parsed.type !== 'heartbeat') {
      return false;
    }
    const deviceId = this.getDeviceId();
    if (deviceId === null) {
      return false;
    }
    return (
      this.#lifecycle.recordHeartbeat({
        proof: this.#authProof,
        deviceId,
        atMilliseconds: parsed.ts,
      }) !== null
    );
  }

  handleMessage(rawMessageText: string): MobileHandshakeOutcome | null {
    const parsed = this.#parseMessage(rawMessageText);
    if (parsed === null) {
      // Un mensaje que no entra al contrato no se tira la conexión, pero si era
      // un hello el device tiene que saber por qué lo dejaron afuera: sin esto
      // se queda esperando un hello_accepted que nunca llega.
      return isDiscardedHello(rawMessageText) ? this.#reject('malformed_hello') : null;
    }
    if (parsed.type === 'hello') {
      return this.handleHelloMessage(rawMessageText);
    }
    if (parsed.type === 'heartbeat') {
      this.handleHeartbeatMessage(rawMessageText);
      return null;
    }
    return null;
  }

  disconnect(): void {
    this.#lifecycle.disconnect({
      connectionId: this.#connectionId,
      proof: this.#authProof,
    });
  }

  /**
   * BLOCK 12 §5: cerrar el socket de verdad. disconnect() para timers y
   * presencia, pero el socket es del DO: revocar tiene que cortarlo, no dejar que
   * el cliente se entere por timeout.
   */
  closePort(): void {
    this.#port.close();
  }

  // El probe de heartbeat es un mensaje de wire como cualquier otro, así que
  // vive acá y no en el lifecycle: el lifecycle sólo decide cuándo.
  sendHeartbeatProbe(): void {
    this.#port.send(
      encodeServerToMobileMessage({
        type: 'heartbeat_probe',
        ts: this.#nowMilliseconds(),
      }),
    );
  }

  // El endpointcanónico se envía como su subset de wire: targetDeviceId es
  // implícito en el socket. El transporte no decide a qué capability corresponde
  // ni qué hacer con la respuesta: sólo manda bytes y parsea.
  sendCommandEnvelope(envelope: DeviceCommandEnvelope): void {
    this.#port.send(
      encodeServerToMobileMessage({
        type: 'command',
        requestId: envelope.requestId,
        capability: envelope.capability,
        ...(envelope.command === undefined ? {} : { command: envelope.command }),
        payload: envelope.payload,
        clientTurnId: envelope.clientTurnId,
        generation: envelope.generation,
      }),
    );
  }

  sendCommand(input: {
    readonly requestId: string;
    readonly capability: CapabilityName;
    readonly payload?: Readonly<Record<string, unknown>>;
    readonly clientTurnId?: string;
    readonly generation?: number;
  }): void {
    this.sendCommandEnvelope(
      buildDeviceCommandEnvelope({
        requestId: input.requestId,
        clientTurnId: input.clientTurnId,
        generation: input.generation,
        capability: input.capability,
        targetDeviceId: this.getDeviceId() ?? 'mobile:unknown',
        payload: input.payload ?? {},
      }),
    );
  }

  // Un command_result del peer, o null si el mensaje no es uno. El transporte
  // no lo interpreta: sólo lo normaliza al envelope de resultado.
  readCommandResult(rawMessageText: string): DeviceCommandResultEnvelope | null {
    const parsed = this.#parseMessage(rawMessageText);
    if (parsed === null || parsed.type !== 'command_result') {
      return null;
    }
    return deviceCommandResultEnvelopeSchema.parse({
      requestId: parsed.requestId,
      deviceId: this.getDeviceId() ?? 'mobile:unknown',
      capability: parsed.capability,
      ok: parsed.ok,
      result: parsed.result,
      error: parsed.error,
    });
  }

  #parseMessage(rawMessageText: string): MobileToServerMessage | null {
    try {
      return parseMobileToServerMessage(rawMessageText);
    } catch {
      return null;
    }
  }

  #parseHello(rawMessageText: string): MobileToServerHelloMessage | null {
    const parsed = this.#parseMessage(rawMessageText);
    return parsed !== null && parsed.type === 'hello' ? parsed : null;
  }

  #reject(reason: string): MobileHandshakeOutcome {
    const response: ServerToMobileMessage = { type: 'hello_rejected', reason };
    this.#port.send(encodeServerToMobileMessage(response));
    return { status: 'rejected', reason, response };
  }
}

export type MobileTransportBundle = {
  readonly lifecycle: DeviceSessionLifecycle;
  readonly transport: MobilePeerTransport;
};

// Registry + lifecycle + transport en un solo lugar. Quien lo use en un runtime
// real sólo tiene que inyectar el port y el timer; no hay timers sueltos por
// armar. Un endpoint con muchos sockets pasa su propio lifecycle para que
// todos compartan el mismo registry y el mismo heartbeat por device.
export function buildMobileTransport(input: {
  readonly registry: CapabilityRegistry;
  readonly port: MobileMessagePort;
  readonly connectionId: string;
  readonly nowMilliseconds?: () => number;
  readonly timerPort?: HeartbeatTimerPort;
  readonly lifecycle?: DeviceSessionLifecycle;
  readonly authorizer?: MobileHelloAuthorizer;
}): MobileTransportBundle {
  const nowMilliseconds = input.nowMilliseconds ?? (() => Date.now());
  const lifecycle =
    input.lifecycle ??
    new DeviceSessionLifecycle({
      registry: input.registry,
      nowMilliseconds,
      timerPort: input.timerPort,
      // El lifecycle emite el evento; el port sólo lleva bytes, así que no hay
      // doble conteo del mismo beat.
      sendHeartbeatProbe: () => undefined,
    });
  const transport = new MobilePeerTransport({
    lifecycle,
    port: input.port,
    connectionId: input.connectionId,
    nowMilliseconds,
    ...(input.authorizer === undefined ? {} : { authorizer: input.authorizer }),
  });
  return { lifecycle, transport };
}
