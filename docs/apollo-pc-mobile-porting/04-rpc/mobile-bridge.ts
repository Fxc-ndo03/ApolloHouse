import {
  Agent,
  callable,
  type Connection,
  type ConnectionContext,
  type WSMessage,
} from 'agents';

import {
  buildAuthenticatedDeviceProof,
  type CapabilityUnavailableReason,
} from '@/devices/registry';
import { MobileDeviceEndpoint } from '@/devices/endpoint';
import type { MobileConnectionAuth } from '@/devices/endpoint';
import type { MobileMessagePort } from '@/devices/mobile';
import { createSqliteEnrollmentStore } from '@/devices/credential-store';
import { verifyDeviceCredential, type EnrollmentStore } from '@/devices/enrollment';
import {
  handleEnrollmentChallengeRequest,
  handleEnrollmentClaimRequest,
  handleEnrollmentRevokeRequest,
  resolveEnrollmentRouteKind,
} from '@/devices/route';
import { readBearerCredentialFromRequest } from '@/auth/token';
import {
  buildMobileSessionInspectorResponse,
  isInspectorRequestDenied,
  isMobileSessionInspectorRequest,
} from '@/devices/inspector';
import { targetPreferenceSchema, type TargetPreference } from '@/devices/schema';
import {
  describeCapability,
  isImplementedCapability,
  listCapabilityNameForDeviceType,
  type CapabilityName,
} from '@/devices/capability';
import { resolveMobileCommand } from '@/devices/command';
import {
  mobileNotificationPayloadSchema,
  type MobileNotificationPayload,
} from '@/protocol/schema';
import {
  buildDeviceCommandResultEnvelope,
  type DeviceCommandResultEnvelope,
} from '@/devices/envelope';
import type {
  DeviceCommandFailureReason,
  DeviceCommandOutcome,
} from '@/devices/dispatch';

// ─────────────────────────────────────────────────────────────────────────────
// MobileBridge: el endpoint Cloudflare de mobile.
//
// Adaptador de eventos de WebSocket a llamadas del MobileDeviceEndpoint. Acá no
// hay handlers de capability, ni tools, ni ejecución de tools, ni PcBridge, ni
// resolución de target: la capa queda
//
//   Cloudflare endpoint (este archivo)
//     ↓ MobilePeerTransport
//     ↓ DeviceSessionLifecycle
//     ↓ Registry
//
// Las dos únicas:callables de producto son el discovery (espejo de PcBridge) y
// el envío de una notification ya autorizada. La lógica de negocio vive en la
// tool y en el peer, nunca acá.
// ─────────────────────────────────────────────────────────────────────────────

interface MobileBridgeState {
  connectedCount: number;
}

export type MobileNotificationCommandInput = {
  readonly targetDeviceId: string;
  readonly requestId: string;
  readonly payload: MobileNotificationPayload;
  readonly clientTurnId?: string;
  readonly generation?: number;
};

export type MobileCapabilityTargetAnswer = {
  readonly status: 'resolved' | 'unavailable';
  readonly deviceId: string | null;
  readonly deviceType: string | null;
  readonly presence: string | null;
  readonly reason: string | null;
  readonly commandList: readonly string[];
};

// La respuesta es plana a propósito: la tool lee reason/detail sin conocer el
// endpoint. El outcome completo viaja aparte para el que quiera inspeccionar.
// BLOCK 11 §4: el dispatch mobile genérico. El caller pide una CAPABILITY y el
// catálogo decide el comando: no existe campo `command` en el input, así que no
// hay forma de dispatchear algo que la capability no declare (BLOCK 11 §16).
export type MobileCommandRequest = {
  readonly targetDeviceId: string;
  readonly capabilityName: CapabilityName;
  // BLOCK 11 §4: comando explicito dentro de la capability. Ausente = canónico.
  readonly commandName?: string;
  readonly requestId: string;
  readonly payload: unknown;
  readonly clientTurnId?: string;
  readonly generation?: number;
};

export type MobileCommandAnswer = {
  readonly status: 'completed' | 'failed';
  readonly reason?: DeviceCommandFailureReason;
  readonly detail?: string;
  readonly outcome?: DeviceCommandOutcome;
  readonly result?: DeviceCommandResultEnvelope;
};

// BLOCK 11 §11 y §13: una sola llamada sirve para las dos cosas. El tool filter
// necesita saber qué capabilities tienen device compatible; el contexto del
// prompt necesita un resumen de los devices. No se pone el registry entero en el
// prompt: solo presencia y resumen de capabilities.
export type MobileReachableDeviceSummary = {
  readonly deviceId: string;
  readonly presence: string;
  readonly capabilityNameList: readonly string[];
};

export type MobileReachableCapabilityEntry = {
  readonly capabilityName: CapabilityName;
  readonly deviceId: string | null;
  readonly presence: string | null;
};

export type MobileReachableCapabilityAnswer = {
  readonly reachableCapabilityEntryList: readonly MobileReachableCapabilityEntry[];
  readonly deviceSummaryList: readonly MobileReachableDeviceSummary[];
};

export type MobileNotificationCommandAnswer = {
  readonly status: 'completed' | 'failed';
  readonly reason?: DeviceCommandFailureReason;
  readonly detail?: string;
  readonly outcome?: DeviceCommandOutcome;
  readonly result?: DeviceCommandResultEnvelope;
};

export class MobileBridge extends Agent<Env, MobileBridgeState> {
  initialState: MobileBridgeState = { connectedCount: 0 };

  // Una sola registry y un solo lifecycle para todos los sockets del bridge: el
  // estado de sesión no se duplica por device.
  readonly #endpoint = new MobileDeviceEndpoint();
  // La Connection del SDK es la clave: el bridge no asume que haya una sola.
  readonly #connectionIdMap = new Map<Connection, string>();
  #connectionCounter = 0;
  // BLOCK 12 §5: el store vive en el SQLite del DO, así que una revocación
  // sobrevive a que el DO se descargue. El endpoint lo recibe por constructor
  // abajo, una vez que existe `ctx`.
  #enrollmentStore: EnrollmentStore | null = null;

  /**
   * BLOCK 12 §1: el DO es la única autoridad de autenticación.
   *
   * El borde ya rechazó un bearer con la forma equivocada, pero no verificó la
   * credencial: el store está en este SQLite. Así que la verificación real
   * pasa acá, una vez por conexión, ANTES de que el transport exista.
   *
   * Un bearer válido o revocado no deja conexión registrada: se cierra el socket
   * y nada entra al endpoint. Un `?token=` global se acepta como ámbito legacy, y
   * la regla anti-bypass se aplica en el hello, cuando por fin hay un deviceId.
   */
  async onConnect(connection: Connection, context: ConnectionContext): Promise<void> {
    const store = this.#resolveEnrollmentStore();
    const request = readConnectionRequest(context);
    const bearerCredential =
      request === undefined ? null : readBearerCredentialFromRequest(request);
    let auth: MobileConnectionAuth = {
      scope: 'legacy_shared_secret',
      boundDeviceId: null,
    };
    if (bearerCredential !== null) {
      if (store === null) {
        // Sin store no hay nada contra qué verificar: no se admite el ámbito
        // enrolado en vez de aceptarlo sin comprobar nada.
        connection.close(1008, 'enrollment_unavailable');
        return;
      }
      const verification = await verifyDeviceCredential({
        store,
        credential: bearerCredential,
      });
      if (verification.status !== 'valid') {
        // 1008 = policy violation. El cliente usa el motivo para dejar de
        // reconectar en loop, pero nunca se le manda la credencial.
        connection.close(
          1008,
          verification.reason === 'credential_revoked'
            ? 'credential_revoked'
            : 'credential_rejected',
        );
        return;
      }
      auth = { scope: 'enrolled_android', boundDeviceId: verification.deviceId };
    }
    // El snapshot anti-bypass se refresca por conexión: es una lectura de una
    // tabla con primary key, y así una revocación que acaba de ocurrir ya se ve.
    await this.#endpoint.refreshEnrollmentSnapshot();

    this.#connectionCounter += 1;
    const connectionId = `mobile-${this.#connectionCounter}`;
    const port: MobileMessagePort = {
      send: (messageText: string) => connection.send(messageText),
      close: () => connection.close(1000, 'closing'),
    };
    this.#endpoint.handleConnect({
      connectionId,
      port,
      // El proof usa el mismo helper que el desktop. Acá sí puede existir
      // porque hubo un ámbito válido verificado por el servidor: ni el socket
      // por sí solo ni un deviceId autentican nada.
      proof: buildAuthenticatedDeviceProof('device'),
      auth,
    });
    this.#connectionIdMap.set(connection, connectionId);
    this.setState({ ...this.state, connectedCount: this.#connectionIdMap.size });
  }

  async onMessage(connection: Connection, message: WSMessage): Promise<void> {
    const connectionId = this.#connectionIdMap.get(connection);
    if (connectionId === undefined) {
      return;
    }
    this.#endpoint.handleRawMessage(connectionId, message);
  }

  onClose(connection: Connection): void {
    const connectionId = this.#connectionIdMap.get(connection);
    if (connectionId === undefined) {
      return;
    }
    this.#endpoint.handleClose(connectionId);
    this.#connectionIdMap.delete(connection);
    this.setState({ ...this.state, connectedCount: this.#connectionIdMap.size });
  }

  // Discovery: "¿qué device puede hacer esta capability?". Espejo del RPC que ya
  // expone PcBridge, para que el runtime no sepa que existe más de un bridge.
  // La política de selección es la del registry, no una segunda implementación.
  @callable()
  async resolveCapabilityTarget(input: {
    readonly capabilityName: CapabilityName;
    readonly targetPreference?: unknown;
  }): Promise<MobileCapabilityTargetAnswer> {
    const parsedTargetPreference = targetPreferenceSchema.safeParse(
      input.targetPreference ?? { kind: 'any' },
    );
    const targetPreference: TargetPreference = parsedTargetPreference.success
      ? parsedTargetPreference.data
      : { kind: 'any' };
    const resolution = this.#endpoint.registry.resolveTarget({
      capabilityName: input.capabilityName,
      targetPreference,
    });
    if (resolution.status !== 'resolved') {
      return {
        status: 'unavailable',
        deviceId: null,
        deviceType: null,
        presence: null,
        reason: resolution.reason satisfies CapabilityUnavailableReason,
        commandList: [],
      };
    }
    return {
      status: 'resolved',
      deviceId: resolution.device.deviceId,
      deviceType: resolution.device.deviceType,
      // La revalidación pre-ejecución necesita la presencia vigente.
      presence: this.#endpoint.registry.resolvePresence(resolution.device.deviceId),
      reason: null,
      commandList: describeCapability(input.capabilityName).commandList,
    };
  }

  // Envío de una notification. La tool ya resolvió target y autorizó antes de
  // llegar acá: este RPC sólo despacha el envelope y espera el resultado.
  @callable()
  async sendNotificationCommand(
    input: MobileNotificationCommandInput,
  ): Promise<MobileNotificationCommandAnswer> {
    const payload = mobileNotificationPayloadSchema.safeParse(input.payload);
    if (!payload.success) {
      const outcome: DeviceCommandOutcome = {
        ok: false,
        reason: 'device_rejected',
        detail: 'El payload de la notificación no es válido.',
      };
      return {
        status: 'failed',
        reason: outcome.ok ? undefined : outcome.reason,
        detail: outcome.ok ? undefined : outcome.detail,
        outcome,
      };
    }
    const outcome = await this.#endpoint.dispatchCommand({
      deviceId: input.targetDeviceId,
      capability: 'mobile.notifications',
      payload: payload.data,
      requestId: input.requestId,
      clientTurnId: input.clientTurnId,
      generation: input.generation,
    });
    if (!outcome.ok) {
      return {
        status: 'failed',
        reason: outcome.reason,
        detail: outcome.detail,
        outcome,
      };
    }
    return {
      status: 'completed',
      outcome,
      result: buildDeviceCommandResultEnvelope({
        requestId: input.requestId,
        deviceId: input.targetDeviceId,
        capability: 'mobile.notifications',
        ok: true,
        result: outcome.result,
      }),
    };
  }

  // Canal de inspección para el smoke test de concurrencia. NO es un @callable:
  // no existe en el RPC del WebSocket, así que un device no puede invocarlo
  // aunque tenga la sesión abierta. Sólo responde si el servidor tiene el env de
  // inspector prendido, y en una deployment normal no lo tiene.
  // ───────────────────────────────────────────────────────────────────────────
  // Dispatch mobile por capability (BLOCK 11 §4).
  //
  // El comando sale del catálogo, no del caller: `resolveMobileCommand` deriva el
  // comando canónico, valida el payload con el schema de la capability y rechaza
  // cualquier capability que no sea mobile o no esté implementada. Recién ahí se
  // toca el socket.
  // ───────────────────────────────────────────────────────────────────────────
  @callable()
  async sendMobileCommand(input: MobileCommandRequest): Promise<MobileCommandAnswer> {
    const resolution = resolveMobileCommand(
      input.capabilityName,
      input.payload,
      input.commandName,
    );
    if (!resolution.isResolved) {
      return {
        status: 'failed',
        reason: resolution.reason,
        detail: resolution.detail,
        outcome: { ok: false, reason: resolution.reason, detail: resolution.detail },
      };
    }
    const outcome = await this.#endpoint.dispatchCommand({
      deviceId: input.targetDeviceId,
      capability: input.capabilityName,
      command: resolution.commandName,
      payload: resolution.payload,
      requestId: input.requestId,
      clientTurnId: input.clientTurnId,
      generation: input.generation,
    });
    if (!outcome.ok) {
      return {
        status: 'failed',
        reason: outcome.reason,
        detail: outcome.detail,
        outcome,
      };
    }
    return {
      status: 'completed',
      outcome,
      result: buildDeviceCommandResultEnvelope({
        requestId: input.requestId,
        deviceId: input.targetDeviceId,
        capability: input.capabilityName,
        ok: true,
        result: outcome.result,
      }),
    };
  }

  // Qué capabilities tienen un device compatible ahora mismo, y qué devices hay.
  // Sirve para filtrar el catálogo de tools (BLOCK 11 §11) y para el contexto
  // cross-device del prompt (BLOCK 11 §13) sin exponer el registry.
  @callable()
  async listReachableCapabilityList(): Promise<MobileReachableCapabilityAnswer> {
    const reachableCapabilityEntryList: MobileReachableCapabilityEntry[] = [];
    for (const capabilityName of listCapabilityNameForDeviceType('mobile')) {
      if (!isImplementedCapability(capabilityName)) {
        continue;
      }
      const resolution = this.#endpoint.registry.resolveTarget({
        capabilityName,
        targetPreference: { kind: 'device_type', deviceType: 'mobile' },
      });
      reachableCapabilityEntryList.push({
        capabilityName,
        deviceId: resolution.status === 'resolved' ? resolution.device.deviceId : null,
        presence:
          resolution.status === 'resolved'
            ? this.#endpoint.registry.resolvePresence(resolution.device.deviceId)
            : null,
      });
    }
    const deviceSummaryList: MobileReachableDeviceSummary[] = this.#endpoint.registry
      .listDeviceList()
      .filter((device) => device.deviceType === 'mobile')
      .map((device) => ({
        deviceId: device.deviceId,
        presence: device.presence,
        capabilityNameList: device.availableCapabilities,
      }));
    return { reachableCapabilityEntryList, deviceSummaryList };
  }

  override async fetch(request: Request): Promise<Response> {
    const requestUrl = new URL(request.url);
    if (
      isMobileSessionInspectorRequest({
        pathname: requestUrl.pathname,
        upgradeHeader: request.headers.get('Upgrade'),
        environment: this.env,
      })
    ) {
      // BLOCK 12.2 §1: el inspector lista TODAS las sesiones (deviceId,
      // presencia y capabilities), así que no puede abrirlo un teléfono.
      //
      // El borde no alcanza para decidir esto: `Authorization: Bearer` con la
      // credencial de un teléfono es una credencial VÁLIDA, y en el borde eso sólo
      // significa «pasa». La pregunta «¿esto es la credencial de un teléfono?» la
      // responde el store, y el store vive acá. Por eso el cierre va en el DO y
      // no en index.ts, que además no debe conocer la existencia del inspector.
      //
      // Sobre workerd real se comprobó que sin esto un teléfono enrolado pedía
      // `__inspect` y recibía 200 con la lista de los teléfonos de los demás.
      // El borde no alcanza para decidir esto: `Authorization: Bearer` con la
      // credencial de un teléfono es una credencial VÁLIDA, y en el borde eso sólo
      // significa «pasa». La política vive en el DO, que además es el único que
      // puede resolver la existencia del inspector sin que index.ts la conozca.
      if (isInspectorRequestDenied(readBearerCredentialFromRequest(request))) {
        return new Response('Not found', { status: 404 });
      }
      return buildMobileSessionInspectorResponse(this.#endpoint.inspectSessionSnapshot());
    }
    // BLOCK 12 §2: las tres rutas de enrollment las atiende este DO, no el Worker.
    // Es el único lugar que tiene el store Y los sockets vivos, que es lo que
    // hace posible revocar sin salir al borde.
    const store = this.#resolveEnrollmentStore();
    if (store !== null) {
      const enrollmentRouteKind = resolveEnrollmentRouteKind(requestUrl.pathname);
      if (enrollmentRouteKind === 'challenge') {
        return handleEnrollmentChallengeRequest({
          request,
          environment: this.env,
          store,
          nowMilliseconds: Date.now(),
        });
      }
      if (enrollmentRouteKind === 'claim') {
        return handleEnrollmentClaimRequest({
          request,
          store,
          nowMilliseconds: Date.now(),
        });
      }
      if (enrollmentRouteKind === 'revoke') {
        return handleEnrollmentRevokeRequest({
          request,
          environment: this.env,
          store,
          nowMilliseconds: Date.now(),
          revoke: async (deviceId) =>
            this.#revokeLiveConnection(deviceId) ? 'closed_socket' : 'no_socket',
        });
      }
    }
    return super.fetch(request);
  }

  /**
   * §5: revocar cierra el socket VIVO de ese deviceId. El `handleClose` del
   * endpoint corta además los comandos en vuelo, así que un comando que estaba a
   * medias termina como desconexión y no queda colgado.
   */
  #revokeLiveConnection(deviceId: string): boolean {
    let closedAny = false;
    for (const connection of Array.from(this.#connectionIdMap.keys())) {
      const connectionId = this.#connectionIdMap.get(connection);
      if (connectionId === undefined) {
        continue;
      }
      if (this.#endpoint.getTransport(connectionId)?.getDeviceId() !== deviceId) {
        continue;
      }
      connection.close(1008, 'revoked');
      this.#endpoint.handleClose(connectionId);
      this.#connectionIdMap.delete(connection);
      closedAny = true;
    }
    return closedAny;
  }

  /**
   * El store se crea una vez por instancia. `ctx.storage.sql` ya existe porque
   * MobileBridge está declarado como `new_sqlite_classes` en wrangler.jsonc, y
   * las tablas se crean con IF NOT EXISTS en el primer uso.
   */
  #resolveEnrollmentStore(): EnrollmentStore | null {
    if (this.#enrollmentStore !== null) {
      return this.#enrollmentStore;
    }
    const sqlStorage = readSqlStorage(this);
    if (sqlStorage === null) {
      return null;
    }
    const store = createSqliteEnrollmentStore(sqlStorage);
    this.#enrollmentStore = store;
    // Sin esto el endpoint queda sin store, su authorizer es `null` y la regla
    // anti-bypass de §1 no se aplica nunca.
    this.#endpoint.attachEnrollmentStore(store);
    return store;
  }
}

/**
 * `ConnectionContext.request` es el Request original del upgrade. El SDK lo
 * expone como opcional, y sin él no hay forma de leer el header Authorization:
 * por eso se degrada a `null` en vez de inventar una fuente.
 */
function readConnectionRequest(context: ConnectionContext): Request | undefined {
  const candidate = (context as { readonly request?: unknown }).request;
  return candidate instanceof Request ? candidate : undefined;
}

/** El tipo global `SqlStorage` no existe fuera de los tipos generados. */
type SqlStorageLike = Parameters<typeof createSqliteEnrollmentStore>[0];

function readSqlStorage(bridge: MobileBridge): SqlStorageLike | null {
  const context = (bridge as unknown as { readonly ctx?: { storage?: unknown } }).ctx;
  const storage = context?.storage as { sql?: unknown } | undefined;
  const sqlStorage = storage?.sql;
  if (
    sqlStorage === undefined ||
    typeof (sqlStorage as { exec?: unknown }).exec !== 'function'
  ) {
    return null;
  }
  return sqlStorage as SqlStorageLike;
}
