import { Agent, type Connection, type ConnectionContext, type WSMessage } from 'agents';
import {
  parsePcToServerMessage,
  encodeServerToPcMessage,
  type PcToServerMessage,
  type ServerToPcMessage,
} from '@/protocol/schema';
import { readBearerCredentialFromRequest } from '@/auth/token';
import { buildDesktopRegistrationFromHello } from '@/devices/desktop';
import {
  authorizeDesktopHello,
  isSessionShapedBearer,
  type DesktopDeviceBinding,
} from '@/devices/desktop-authorization';
import {
  buildAuthenticatedDeviceProof,
  CapabilityRegistry,
  listPcBridgeCommandListForCapability,
  type AuthenticatedDeviceProof,
} from '@/devices/registry';
import type { CapabilityName } from '@/devices/capability';
import { emitDeviceHeartbeatEvent } from '@/devices/events';
import { HeartbeatScheduler, systemHeartbeatTimerPort } from '@/devices/heartbeat';
import { targetPreferenceSchema, type TargetPreference } from '@/devices/schema';

interface PcBridgeState {
  connected: boolean;
  hostname: string | null;
  protocolVersion: number | null;
  deviceId: string | null;
}

export class PcBridge extends Agent<Env, PcBridgeState> {
  initialState: PcBridgeState = {
    connected: false,
    hostname: null,
    protocolVersion: null,
    deviceId: null,
  };

  #connection: Connection | null = null;
  #pending = new Map<
    string,
    {
      resolve: (v: unknown) => void;
      reject: (e: Error) => void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >();
  #heartbeat = new HeartbeatScheduler();
  #registry = new CapabilityRegistry();
  // El worker autentica la conexión antes de que llegue onConnect (authorizeApolloConnection),
  // así que la prueba se construye acá y no desde un mensaje del cliente.
  #authProof: AuthenticatedDeviceProof | null = null;
  // FASE 2.4: cuenta resuelta de la sesión (o null en el camino legacy).
  #sessionAccount: string | null = null;

  async onConnect(connection: Connection, ctx: ConnectionContext): Promise<void> {
    this.#connection = connection;
    // FASE 2.4: la sesión de cuenta (si viene) representa al dueño. La
    // credencial del DISPOSITIVO sigue siendo el plano de capacidades; el
    // binding deviceId↔cuenta se verifica en el hello, no acá.
    const bearer = readBearerCredentialFromRequest(ctx.request);
    this.#sessionAccount =
      bearer !== null && isSessionShapedBearer(bearer)
        ? await this.#resolveSessionAccount(bearer)
        : null;
    this.#authProof = buildAuthenticatedDeviceProof('device');
    this.setState({ ...this.state, connected: true });
  }

  async #resolveSessionAccount(bearer: string): Promise<string | null> {
    try {
      const registry = this.env.AccountRegistry.getByName('registry');
      const resolved = await registry.session({ token: bearer, atMilliseconds: Date.now() });
      return resolved.status === 'ok' ? resolved.accountId : null;
    } catch {
      return null;
    }
  }

  async onMessage(connection: Connection, message: WSMessage): Promise<void> {
    if (typeof message !== 'string') return;

    let msg: PcToServerMessage;
    try {
      msg = parsePcToServerMessage(message);
    } catch {
      return;
    }

    switch (msg.type) {
      case 'hello': {
        this.setState({
          ...this.state,
          hostname: msg.hostname,
          protocolVersion: msg.protocolVersion ?? null,
          deviceId: null,
        });
        // FASE 2.4: binding dispositivo↔cuenta. Con sesión, el deviceId
        // declarado sólo vale si el registro lo asigna a ESA cuenta y no está
        // revocado; revocado o ajeno → cierre (la reconexión no lo restaura).
        const registration = buildDesktopRegistrationFromHello({
          hello: msg,
          hostname: msg.hostname,
          nowMilliseconds: Date.now(),
        });
        let deviceBinding: DesktopDeviceBinding | null = null;
        if (this.#sessionAccount !== null) {
          try {
            const registry = this.env.AccountRegistry.getByName('registry');
            const binding = await registry.resolveDeviceBinding(registration.deviceId);
            deviceBinding = binding;
          } catch {
            deviceBinding = null;
          }
        }
        const identity = authorizeDesktopHello({
          sessionAccount: this.#sessionAccount,
          helloDeviceId: registration.deviceId,
          deviceBinding,
        });
        if (identity.status === 'rejected') {
          connection.close(1008, identity.reason);
          return;
        }
        this.#registerDesktop(msg, msg.hostname, registration);
        this.#startPingInterval(connection);
        break;
      }
      case 'command_result':
        this.#resolvePending(msg.id, msg.ok, msg.result, msg.error);
        break;
      case 'pong':
        this.#touchPresence();
        break;
    }
  }

  onClose(_connection: Connection): void {
    this.setState({ ...this.state, connected: false });
    this.#markPresenceOffline();
    this.#cleanup();
  }

  #registerDesktop(
    hello: Extract<PcToServerMessage, { type: 'hello' }>,
    hostname: string,
    registrationOverride?: ReturnType<typeof buildDesktopRegistrationFromHello>,
  ): void {
    const registration = registrationOverride ?? buildDesktopRegistrationFromHello({
      hello,
      hostname,
      nowMilliseconds: Date.now(),
    });
    const outcome = this.#registry.register({
      proof: this.#authProof,
      deviceId: registration.deviceId,
      deviceType: registration.deviceType,
      capabilityNameList: registration.capabilityNameList,
      protocolVersion: registration.protocolVersion,
      lastSeenAt: registration.lastSeenAt,
      transport: {
        transportKind: 'pc_bridge',
        // Un PcBridge sirve exactamente un desktop, así que la conexión y el
        // device son la misma cosa.
        connectionId: registration.deviceId,
      },
    });
    if (outcome.status === 'registered') {
      this.setState({
        ...this.state,
        deviceId: outcome.device.deviceId,
        protocolVersion: outcome.device.protocolVersion,
      });
    }
  }

  // Actividad real como heartbeat: el pong del cliente ya prueba que la
  // conexión está viva, así que no hace falta polling extra para detectarlo.
  #touchPresence(): void {
    const deviceId = this.state.deviceId;
    if (deviceId === null) {
      return;
    }
    const beatAt = Date.now();
    this.#registry.recordHeartbeat({
      proof: this.#authProof,
      deviceId,
      atMilliseconds: beatAt,
    });
    emitDeviceHeartbeatEvent({
      event: 'heartbeat_received',
      deviceId,
      deviceType: 'desktop',
      protocolVersion: this.state.protocolVersion ?? undefined,
      atMilliseconds: beatAt,
    });
  }

  #markPresenceOffline(): void {
    const deviceId = this.state.deviceId;
    if (deviceId === null) {
      return;
    }
    this.#registry.markPresence({
      proof: this.#authProof,
      deviceId,
      presence: 'offline',
    });
  }

  /** FASE 2.5: ¿hay una PC real conectada en esta instancia? */
  async isDesktopConnectionAlive(): Promise<boolean> {
    return this.#connection !== null && this.state.connected;
  }

  /** FASE 2.5: presencia vigente del desktop de esta instancia. */
  async resolveDesktopPresence(): Promise<string | null> {
    const deviceId = this.state.deviceId;
    if (deviceId === null || this.#connection === null) {
      return null;
    }
    return this.#registry.resolvePresence(deviceId);
  }

  // Método RPC público — se llama desde el Worker/tools vía getAgentByName
  async sendCommand(
    type: ServerToPcMessage['type'],
    extra: Record<string, unknown> = {},
  ): Promise<unknown> {
    if (!this.#connection) {
      throw new Error('PC no conectada');
    }

    const id = crypto.randomUUID();
    const message = { type, id, ...extra, ts: Date.now() } as ServerToPcMessage;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error('PC no respondió (timeout 8s)'));
      }, 8000);

      this.#pending.set(id, { resolve, reject, timeout });
      this.#connection!.send(encodeServerToPcMessage(message));
    });
  }

  // RPC de discovery: responde "¿qué device puede hacer esta capability?" sin
  // autorizar ni ejecutar nada.
  async resolveCapabilityTarget(input: {
    readonly capabilityName: CapabilityName;
    readonly targetPreference?: unknown;
    readonly requestingAccountId?: string | null;
  }): Promise<{
    readonly status: 'resolved' | 'unavailable';
    readonly deviceId: string | null;
    readonly deviceType: string | null;
    readonly presence: string | null;
    readonly reason: string | null;
    readonly commandList: readonly string[];
  }> {
    // FASE 2.4: la cuenta que pide el target debe ser la dueña del desktop
    // conectado. Un Apollo de otra cuenta no puede ejecutar comandos acá.
    if (
      this.#sessionAccount !== null &&
      input.requestingAccountId !== undefined &&
      input.requestingAccountId !== null &&
      input.requestingAccountId !== this.#sessionAccount
    ) {
      return {
        status: 'unavailable',
        deviceId: null,
        deviceType: null,
        presence: null,
        reason: 'capability_account_mismatch',
        commandList: [],
      };
    }
    const parsedTargetPreference = targetPreferenceSchema.safeParse(
      input.targetPreference ?? { kind: 'any' },
    );
    const targetPreference: TargetPreference = parsedTargetPreference.success
      ? parsedTargetPreference.data
      : { kind: 'any' };
    const resolution = this.#registry.resolveTarget({
      capabilityName: input.capabilityName,
      targetPreference,
    });
    if (resolution.status === 'resolved') {
      return {
        status: 'resolved',
        deviceId: resolution.device.deviceId,
        deviceType: resolution.device.deviceType,
        // La revalidación pre-ejecución necesita la presencia vigente.
        presence: this.#registry.resolvePresence(resolution.device.deviceId),
        reason: null,
        commandList: listPcBridgeCommandListForCapability(resolution.capabilityName),
      };
    }
    return {
      status: 'unavailable',
      deviceId: null,
      deviceType: null,
      presence: null,
      reason: resolution.reason,
      commandList: [],
    };
  }

  #resolvePending(id: string, ok: boolean, result?: unknown, error?: string): void {
    const pending = this.#pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.#pending.delete(id);
    if (ok) pending.resolve(result);
    else pending.reject(new Error(error ?? 'PC command failed'));
  }

  // El ping que ya existía ES el heartbeat: mismo socket, misma task, mismo
  // timer. La presencia se deriva del pong, así que no hay un segundo timer.
  #startPingInterval(connection: Connection): void {
    // El ping que ya existía ES el heartbeat: mismo socket, misma task, mismo
    // timer. El scheduler garantiza que nunca haya dos vivos.
    this.#heartbeat.start(systemHeartbeatTimerPort, () => {
      const sentAt = Date.now();
      connection.send(JSON.stringify({ type: 'ping', ts: sentAt }));
      const deviceId = this.state.deviceId;
      if (deviceId !== null) {
        emitDeviceHeartbeatEvent({
          event: 'heartbeat_sent',
          deviceId,
          deviceType: 'desktop',
          protocolVersion: this.state.protocolVersion ?? undefined,
          atMilliseconds: sentAt,
        });
      }
    });
  }

  #cleanup(): void {
    // El heartbeat no sobrevive a la desconexión: stop() no puede revivirlo.
    this.#heartbeat.stop(systemHeartbeatTimerPort);
    this.#pending.forEach(({ reject, timeout }) => {
      clearTimeout(timeout);
      reject(new Error('PC desconectada'));
    });
    this.#pending.clear();
    this.#connection = null;
  }
}
