import { CapabilityRegistry, type AuthenticatedDeviceProof } from '@/devices/registry';
import { DeviceSessionLifecycle } from '@/devices/connection';
import {
  buildMobileTransport,
  type MobileMessagePort,
  type MobilePeerTransport,
} from '@/devices/mobile';
import type { DeviceSession } from '@/devices/session';
import type { HeartbeatTimerPort } from '@/devices/heartbeat';
import {
  PendingCommandRegistry,
  type DeviceCommandOutcome,
  type PendingCommandRegistryOptions,
} from '@/devices/dispatch';
import { buildDeviceCommandEnvelope } from '@/devices/envelope';
import type { CapabilityName } from '@/devices/capability';
import type { MobileHelloAuthorization, MobileHelloAuthorizer } from '@/devices/mobile';
import { decideLegacyAdmission, type EnrollmentStore } from '@/devices/enrollment';

// ─────────────────────────────────────────────────────────────────────────────
// MobileDeviceEndpoint: el ciclo de vida del endpoint mobile, sin Cloudflare.
//
// Acá vive la lógica que decide qué es una conexión, cuándo es una sesión y
// cuándo se limpia. El Durable Object (src/agents/mobile-bridge.ts) es un
// adaptador de ~40 líneas sobre esto, así que el endpoint se puede testear
// entero sin workerd: lo que se prueba acá es el endpoint real, no una copia.
//
// Un socket abierto NO es un dispositivo. El DeviceConnection nace sin deviceId
// y sólo un hello autenticado produce una DeviceSession en el registry.
// ─────────────────────────────────────────────────────────────────────────────

export type MobileEndpointSessionSnapshot = {
  // Transports abiertos, incluyendo conexiones que todavía no completaron hello
  // (un inspector RPC, por ejemplo). No equivale a dispositivos.
  readonly connectedCount: number;
  // Connections que YA completaron el handshake: los sockets que son
  // dispositivos de verdad. Es la métrica que responde "¿cuántos sockets
  // sobreviven a la vez?".
  readonly handshakenConnectionCount: number;
  readonly sessionCount: number;
  readonly heartbeatSchedulerCount: number;
  readonly runningHeartbeatTimerCount: number;
  readonly sessionList: readonly {
    readonly deviceId: string;
    readonly deviceType: string;
    readonly authenticated: boolean;
    readonly presence: string;
    readonly connectionId: string;
    readonly transportKind: string;
    readonly protocolVersion: number;
    readonly lastSeenAt: number;
    readonly declaredCapabilities: readonly string[];
    readonly availableCapabilities: readonly string[];
  }[];
};

export type MobileConnectionOutcome = {
  readonly wasNewConnection: boolean;
  readonly isConnected: boolean;
};

/**
 * BLOCK 12 §1: qué окно autorizó ESTA conexión.
 *
 * `boundDeviceId` viene del hash de la credencial, nunca de lo que dice el
 * cliente: es la identidad que el servidor dedujo, y por eso un teléfono no
 * puede abrir una sesión declarando ser otro.
 */
export type MobileConnectionAuth = {
  readonly scope: 'enrolled_android' | 'legacy_shared_secret';
  readonly boundDeviceId: string | null;
};

export type MobileDeviceEndpointOptions = {
  readonly nowMilliseconds?: () => number;
  readonly timerPort?: HeartbeatTimerPort;
  // El timeout de comando se inyecta para poder testearlo sin sleeps.
  readonly pendingCommandOptions?: PendingCommandRegistryOptions;
  // BLOCK 12: el store de enrollment. Sin él, todas las conexiones son legacy,
  // que es exactamente el comportamiento de antes de este bloque.
  readonly enrollmentStore?: EnrollmentStore;
};

export class MobileDeviceEndpoint {
  readonly #registry: CapabilityRegistry;
  readonly #lifecycle: DeviceSessionLifecycle;
  readonly #transportMap = new Map<string, MobilePeerTransport>();
  readonly #pendingCommands: PendingCommandRegistry;
  #enrollmentStore: EnrollmentStore | null = null;
  // Estado de enrollment por deviceId, leído del store. Guarda el status, no
  // sólo la presencia, porque hacen falta las dos cosas:
  //   - la presencia de la fila  -> cierra el bypass legacy
  //   - que la fila sea 'active' -> una credencial revocada no abre sesión
  // El credencialHash queda afuera a propósito: acá no se necesita para nada.
  #enrollmentStatusMap = new Map<string, 'active' | 'revoked'>();
  #enrolledDeviceIdSet = new Set<string>();
  #connectionCounter = 0;

  constructor(options: MobileDeviceEndpointOptions = {}) {
    this.#registry = new CapabilityRegistry({
      nowMilliseconds: options.nowMilliseconds,
    });
    this.#lifecycle = new DeviceSessionLifecycle({
      registry: this.#registry,
      nowMilliseconds: options.nowMilliseconds,
      timerPort: options.timerPort,
      sendHeartbeatProbe: (session: DeviceSession) => {
        this.#findTransportForDeviceId(session.deviceId)?.sendHeartbeatProbe();
      },
    });
    this.#pendingCommands = new PendingCommandRegistry(options.pendingCommandOptions);
    this.#enrollmentStore = options.enrollmentStore ?? null;
  }

  /**
   * El DO no puede construir el endpoint con el store: el store sale de
   * `ctx.storage.sql` y los campos de clase se inicializan antes de que exista
   * `ctx`. Por eso se adjunta una vez, antes de aceptar la primera conexión.
   *
   * Esto NO es opcional: sin store el authorizer es `null`, la regla anti-bypass
   * no corre, y un teléfono revocado vuelve por `?token=`. El bug real lo
   * encontró el smoke de BLOCK 12, no un test unitario.
   */
  attachEnrollmentStore(store: EnrollmentStore): void {
    this.#enrollmentStore = store;
  }

  /**
   * Atajo de la regla legacy para quien la necesite sin authorizer. El endpoint
   * usa el snapshot; esto existe para que un test pueda preguntar la regla cruda.
   */
  async isLegacyAdmissionAllowed(deviceId: string): Promise<boolean> {
    if (this.#enrollmentStore === null) {
      return true;
    }
    return (await decideLegacyAdmission({ store: this.#enrollmentStore, deviceId }))
      .isAllowed;
  }

  get registry(): CapabilityRegistry {
    return this.#registry;
  }

  get lifecycle(): DeviceSessionLifecycle {
    return this.#lifecycle;
  }

  listConnectedCount(): number {
    return this.#transportMap.size;
  }

  listTransportList(): readonly MobilePeerTransport[] {
    return [...this.#transportMap.values()];
  }

  getTransport(connectionId: string): MobilePeerTransport | undefined {
    return this.#transportMap.get(connectionId);
  }

  /**
   * BLOCK 12 §1: `auth` describe el ámbito de la conexión y lo autoriza el DO
   * ANTES de llegar acá. El proof sigue siendo un branded token del registry, así
   * que la sesión sólo existe si hubo un ámbito válido detrás.
   *
   * El `authorizer` se construye acá y seCaptura por conexión: decide sobre el
   * deviceId del hello contra el store, que ya fue leído. Por eso es síncrono.
   */
  handleConnect(input: {
    readonly connectionId?: string;
    readonly port: MobileMessagePort;
    readonly proof: AuthenticatedDeviceProof | null;
    readonly auth?: MobileConnectionAuth;
  }): MobileConnectionOutcome {
    this.#connectionCounter += 1;
    const connectionId = input.connectionId ?? `mobile-${this.#connectionCounter}`;
    const auth: MobileConnectionAuth = input.auth ?? {
      scope: 'legacy_shared_secret',
      boundDeviceId: null,
    };
    const authorizer = this.#buildHelloAuthorizer(auth);
    const { transport } = buildMobileTransport({
      registry: this.#registry,
      lifecycle: this.#lifecycle,
      port: input.port,
      connectionId,
      nowMilliseconds: this.#lifecycle.nowMilliseconds,
      ...(authorizer === null ? {} : { authorizer }),
    });
    transport.connect();
    transport.authenticate(input.proof);
    const isNewConnection = !this.#transportMap.has(connectionId);
    this.#transportMap.set(connectionId, transport);
    return { wasNewConnection: isNewConnection, isConnected: true };
  }

  /**
   * La regla por ámbito, en un solo lugar:
   *
   * - enrolled: el deviceId del hello tiene que SER el deviceId atado a la
   *   credencial. Una credencial de A no abre una sesión de B.
   * - legacy: se cierra por completo para identidades mobile (§3 de BLOCK 12.1).
   *
   * En BLOCK 12 el camino legacy sólo rechazaba los deviceIds YA enrolados o
   * revocados, y dejaba pasar los nunca enrolados. Eso dejaba el secreto global
   * como alternativa permanente al enrollment individual, que es exactamente lo
   * que este bloque cierra: ahora una identidad mobile que no tiene credencial
   * propia queda rechazada por `?token=` con el motivo `device_not_enrolled`.
   *
   * Por qué el cierre va en el hello y no en el borde: el borde no sabe qué
   * identidad trae la conexión -- esa información no existe hasta el primer
   * mensaje-- y usar un `?deviceId=` de la URL para decidir sería confiar en lo
   * que dice el cliente, que §3 prohíbe. El hello es el primer momento en que la
   * identidad es declarada y la conexión ya viene autenticada a nivel de ruta.
   *
   * Lo que NO cambia: Desktop y el ESP32 no pasan por acá. Conectan contra
   * `/agents/apollo/<desk>`, que sigue usando su propio `onBeforeConnect` y su
   * propio rol 'device'. Esta ruta es sólo de teléfonos.
   *
   * Sin store no hay regla: en una deployment sin enrollment el comportamiento
   * es el legacy de siempre, en vez de un rechazo silencioso.
   */
  #buildHelloAuthorizer(auth: MobileConnectionAuth): MobileHelloAuthorizer | null {
    const store = this.#enrollmentStore;
    if (store === null) {
      return null;
    }
    if (auth.scope === 'enrolled_android') {
      const boundDeviceId = auth.boundDeviceId;
      if (boundDeviceId === null) {
        return () => ({
          isAllowed: false,
          reason: 'credential_device_mismatch' as const,
        });
      }
      return (helloDeviceId: string): MobileHelloAuthorization => {
        if (helloDeviceId !== boundDeviceId) {
          return { isAllowed: false, reason: 'credential_device_mismatch' };
        }
        // Defensa en profundidad: `onConnect` ya verificó la credencial, pero
        // entre esa verificación y este hello la fila pudo revocarse. Sin este
        // chequeo, un `boundDeviceId` válido abriría una sesión de un teléfono
        // revocado, que es exactamente lo que §5 prohíbe.
        if (this.#enrollmentStatusMap.get(helloDeviceId) !== 'active') {
          return { isAllowed: false, reason: 'credential_revoked' };
        }
        return { isAllowed: true };
      };
    }
    // El snapshot se cargó antes de conectar, así que esto no toca el SQLite.
    //
    // Los DOS casos se rechazan: el que está en el store (activo o revocado) y el
    // que no está. Lo que queda del camino legacy es un socket que abre y se
    // cierra en el hello, lo cual es lo correcto: el cliente recibe un motivo
    // accionable en vez de quedarse esperando un hello_accepted que no llega.
    return (helloDeviceId: string): MobileHelloAuthorization => {
      if (this.#enrolledDeviceIdSet.has(helloDeviceId)) {
        return { isAllowed: false, reason: 'device_is_enrolled_or_revoked' };
      }
      return { isAllowed: false, reason: 'device_not_enrolled' };
    };
  }

  /**
   * Cargar el store antes de aceptar conexiones. Lo llama el DO una vez, en el
   * arranque y después de cada cambio de enrollment: el anti-bypass necesita el
   * conjunto de deviceIds conocidos, y consultarlo por hello sería un SQL por
   * mensaje.
   */
  async refreshEnrollmentSnapshot(): Promise<void> {
    if (this.#enrollmentStore === null) {
      return;
    }
    const recordList = await this.#enrollmentStore.listCredentialRecordList();
    this.#enrollmentStatusMap = new Map(
      recordList.map((record) => [record.deviceId, record.status]),
    );
    this.#enrolledDeviceIdSet = new Set(recordList.map((record) => record.deviceId));
  }

  /**
   * §5: revocar tiene que cortar el socket VIVO, no esperar al timeout del
   * cliente. Devuelve cuántos sockets se cerraron para ese deviceId.
   *
   * `transport.disconnect()` para el heartbeat y la presencia pero NO cierra el
   * socket —el socket es del DO— así que el port se cierra explícitamente acá. Sin
   * esto la sesión se va pero el teléfono sigue creyendo que está conectado.
   *
   * Se recorre una COPIA de las entradas porque `handleClose` borra del mapa
   * mientras se itera, y mutar un Map en su propio for...of salta entradas.
   */
  closeConnectionsForDeviceId(deviceId: string): number {
    let closedCount = 0;
    for (const [connectionId, transport] of Array.from(this.#transportMap.entries())) {
      if (transport.getDeviceId() !== deviceId) {
        continue;
      }
      transport.closePort();
      this.handleClose(connectionId);
      closedCount += 1;
    }
    return closedCount;
  }

  handleMessage(connectionId: string, rawMessageText: string): void {
    const transport = this.#transportMap.get(connectionId);
    if (transport === undefined) {
      return;
    }
    const commandResult = transport.readCommandResult(rawMessageText);
    if (commandResult !== null) {
      this.#pendingCommands.settleByRequestId(commandResult.requestId, commandResult);
      return;
    }
    transport.handleMessage(rawMessageText);
  }

  // Un mensaje que no es JSON válido, o que no pertenece al protocolo mobile, no
  // tira la conexión: se ignora.
  handleRawMessage(connectionId: string, message: unknown): void {
    if (typeof message !== 'string') {
      return;
    }
    this.handleMessage(connectionId, message);
  }

  handleClose(connectionId: string): boolean {
    const transport = this.#transportMap.get(connectionId);
    if (transport === undefined) {
      return false;
    }
    const deviceId = transport.getDeviceId();
    // Primero se cortan los comandos en vuelo: si el device se va con un comando
    // a medias, ese comando termina como desconexión y no como timeout.
    if (deviceId !== null) {
      this.#pendingCommands.rejectAllForDevice(
        deviceId,
        'El device se desconectó antes de responder.',
      );
    }
    // disconnect() corta el heartbeat y marca presencia antes de soltar el
    // socket: no queda ningún timer vivo.
    transport.disconnect();
    this.#transportMap.delete(connectionId);
    return true;
  }

  get pendingCommandCount(): number {
    return this.#pendingCommands.pendingCount;
  }

  // Envío de un comando a un device concreto. El endpoint no sabe de
  // notifications: arma el envelope genérico y lo despacha contra el socket del
  // target. La lógica de negocio vive en la tool y en el peer.
  async dispatchCommand(input: {
    readonly deviceId: string;
    readonly capability: CapabilityName;
    // BLOCK 11 §4: comando explicito de la capability. Opcional: si falta, el
    // peer usa el canónico, que es lo que mandaba un peer de Block 9.
    readonly command?: string;
    readonly payload: Readonly<Record<string, unknown>>;
    readonly requestId: string;
    readonly clientTurnId?: string;
    readonly generation?: number;
  }): Promise<DeviceCommandOutcome> {
    const transport = this.#findTransportForDeviceId(input.deviceId);
    if (transport === undefined) {
      return {
        ok: false,
        reason: 'unknown_device',
        detail: `No hay socket para ${input.deviceId}.`,
      };
    }
    const envelope = buildDeviceCommandEnvelope({
      requestId: input.requestId,
      clientTurnId: input.clientTurnId,
      generation: input.generation,
      capability: input.capability,
      ...(input.command === undefined ? {} : { command: input.command }),
      targetDeviceId: input.deviceId,
      payload: input.payload,
    });
    return this.#pendingCommands.register({
      envelope,
      send: () => transport.sendCommandEnvelope(envelope),
    });
  }

  // Snapshot de solo lectura para poder observar el estado del DO desde afuera
  // (smoke test de concurrencia). No expone nada sensible: el transport de una
  // sesión es sólo transportKind + connectionId, nunca el proof.
  inspectSessionSnapshot(): MobileEndpointSessionSnapshot {
    const sessionList = this.#registry.listDeviceList();
    let handshakenConnectionCount = 0;
    for (const transport of this.#transportMap.values()) {
      if (transport.getDeviceId() !== null) {
        handshakenConnectionCount += 1;
      }
    }
    return {
      connectedCount: this.#transportMap.size,
      handshakenConnectionCount,
      sessionCount: sessionList.length,
      heartbeatSchedulerCount: this.#lifecycle.listHeartbeatSchedulerCount(),
      runningHeartbeatTimerCount: this.#lifecycle.countRunningHeartbeatTimer(),
      sessionList: sessionList.map((session) => ({
        deviceId: session.deviceId,
        deviceType: session.deviceType,
        authenticated: session.authenticated,
        presence: session.presence,
        connectionId: session.transport.connectionId,
        transportKind: session.transport.transportKind,
        protocolVersion: session.protocolVersion,
        lastSeenAt: session.lastSeenAt,
        declaredCapabilities: session.declaredCapabilities,
        availableCapabilities: session.availableCapabilities,
      })),
    };
  }

  #findTransportForDeviceId(deviceId: string): MobilePeerTransport | undefined {
    for (const transport of this.#transportMap.values()) {
      if (transport.getDeviceId() === deviceId) {
        return transport;
      }
    }
    return undefined;
  }
}
