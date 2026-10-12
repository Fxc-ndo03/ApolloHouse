import {
  deviceCommandResultEnvelopeSchema,
  type DeviceCommandEnvelope,
  type DeviceCommandResultEnvelope,
} from '@/devices/envelope';
import {
  emitDeviceExecutionEvent,
  type DeviceExecutionCorrelation,
} from '@/devices/execution-event';
import { describeCapabilityDeviceType } from '@/devices/capability';
import { CompletedCommandRegistry } from '@/devices/idempotency';

// ─────────────────────────────────────────────────────────────────────────────
// Despacho de comandos a un device, con espera y timeout centralizados.
//
// El registro de comandos pendientes vive acá, indexado por requestId. Eso es lo
// que garantiza dos cosas del contrato:
//
//  - CORRELACIÓN: un result con requestId viejo completa su propio turno y
//    nunca uno nuevo. No hay estado global por device.
//  - NO HANG: si el device se desconecta, todos sus comandos pendientes se
//    resuelven con un error estructurado en el momento del cierre, sin dejar
//    waiters huérfanos.
//
// El timeout es uno solo, configurable, y su error es un failure de EJECUCIÓN:
// no se confunde con un failure de resolución (no_device, capability_absent,
// unimplemented, target_unavailable), que se decide antes de llegar acá.
// ─────────────────────────────────────────────────────────────────────────────

export const DEFAULT_DEVICE_COMMAND_TIMEOUT_MILLISECONDS = 8_000;

// BLOCK 11 §10: las categorías que el usuario final distingue. `resolution
// failure` no vive acá a propósito: se decide ANTES del dispatch (registry ->
// unavailable) y viaja como cancellation, no como fallo de comando.
//
//   device_timeout        -> el device no respondió a tiempo
//   device_disconnected   -> se fue antes de responder (o al cerrar el socket)
//   device_rejected       -> el device recibió y dijo que no
//   unknown_device        -> no hay socket para ese deviceId
//   duplicate_request_id  -> mismo deviceId+requestId en vuelo
//   unsupported_command   -> el device no conoce el comando de esa capability
//   invalid_payload       -> el payload no cumple el schema de la capability
export type DeviceCommandFailureReason =
  | 'device_timeout'
  | 'device_disconnected'
  | 'device_rejected'
  | 'unknown_device'
  | 'duplicate_request_id'
  | 'unsupported_command'
  | 'invalid_payload';

export type DeviceCommandFailure = {
  readonly ok: false;
  readonly reason: DeviceCommandFailureReason;
  readonly detail: string;
};

export type DeviceCommandOutcome =
  | { readonly ok: true; readonly result: unknown }
  | DeviceCommandFailure;

type PendingCommandEntry = {
  readonly deviceId: string;
  readonly capabilityName: string;
  readonly settle: (outcome: DeviceCommandOutcome) => void;
};

export type DeviceCommandTimeoutPort = {
  readonly setTimeout: (callback: () => void, milliseconds: number) => unknown;
  readonly clearTimeout: (handle: unknown) => void;
};

export const systemCommandTimeoutPort: DeviceCommandTimeoutPort = {
  setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
  clearTimeout: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

export type PendingCommandRegistryOptions = {
  readonly timeoutPort?: DeviceCommandTimeoutPort;
  readonly timeoutMilliseconds?: number;
  readonly nowMilliseconds?: () => number;
  readonly correlation?: DeviceExecutionCorrelation;
  readonly toolName?: string;
  // BLOCK 11 §6: cache de resultados completados para replay idempotente.
  readonly completedCommands?: CompletedCommandRegistry;
};

export class PendingCommandRegistry {
  // Indexado por requestId a propósito: la correlación del protocolo es el
  // requestId, no el device. Un result tardío busca su propia entrada y, si ya
  // no existe, se descarta.
  readonly #pendingMap = new Map<string, PendingCommandEntry>();
  readonly #timeoutPort: DeviceCommandTimeoutPort;
  readonly #timeoutMilliseconds: number;
  readonly #nowMilliseconds: () => number;
  readonly #correlation: DeviceExecutionCorrelation;
  readonly #toolName: string;
  readonly #completedCommands: CompletedCommandRegistry;

  constructor(options: PendingCommandRegistryOptions = {}) {
    this.#timeoutPort = options.timeoutPort ?? systemCommandTimeoutPort;
    this.#timeoutMilliseconds =
      options.timeoutMilliseconds ?? DEFAULT_DEVICE_COMMAND_TIMEOUT_MILLISECONDS;
    this.#nowMilliseconds = options.nowMilliseconds ?? (() => Date.now());
    this.#correlation = options.correlation ?? {};
    this.#toolName = options.toolName ?? 'unknown_tool';
    this.#completedCommands =
      options.completedCommands ??
      new CompletedCommandRegistry({
        nowMilliseconds: this.#nowMilliseconds,
      });
  }

  get pendingCount(): number {
    return this.#pendingMap.size;
  }

  listPendingDeviceIdList(): readonly string[] {
    return [...this.#pendingMap.values()].map((entry) => entry.deviceId);
  }

  isPending(requestId: string): boolean {
    return this.#pendingMap.has(requestId);
  }

  // Enviar el mismo requestId dos veces no produce dos efectos: el segundo
  // intento se rechaza explícitamente en vez de duplicar el comando.
  register(input: {
    readonly envelope: DeviceCommandEnvelope;
    readonly send: () => void;
  }): Promise<DeviceCommandOutcome> {
    const requestId = input.envelope.requestId;
    const deviceId = input.envelope.targetDeviceId;
    if (this.#pendingMap.has(requestId)) {
      return Promise.resolve({
        ok: false,
        reason: 'duplicate_request_id',
        detail: `Ya hay un comando en vuelo con requestId ${requestId}.`,
      });
    }
    // BLOCK 11 §6: ya completado y vigente -> se reproduce el MISMO resultado en
    // vez de ejecutar el efecto otra vez en el teléfono.
    const cachedOutcome = this.#completedCommands.readOutcome(deviceId, requestId);
    if (cachedOutcome !== null) {
      return Promise.resolve(cachedOutcome);
    }
    const startedAt = this.#nowMilliseconds();
    emitDeviceExecutionEvent({
      event: 'device_execution_started',
      toolName: this.#toolName,
      capabilityName: input.envelope.capability,
      targetDeviceId: input.envelope.targetDeviceId,
      targetDeviceType: describeCapabilityDeviceType(input.envelope.capability),
      ...this.#correlation,
    });
    return new Promise<DeviceCommandOutcome>((resolve) => {
      let didSettle = false;
      const settle = (outcome: DeviceCommandOutcome): void => {
        if (didSettle) {
          return;
        }
        didSettle = true;
        this.#timeoutPort.clearTimeout(timer);
        this.#pendingMap.delete(requestId);
        this.#completedCommands.record(deviceId, requestId, outcome);
        this.#emitOutcome(input.envelope, outcome, startedAt, sentAtMilliseconds);
        resolve(outcome);
      };
      const timer = this.#timeoutPort.setTimeout(() => {
        settle({
          ok: false,
          reason: 'device_timeout',
          detail: `El device no respondió el comando en ${this.#timeoutMilliseconds}ms.`,
        });
      }, this.#timeoutMilliseconds);
      this.#pendingMap.set(requestId, {
        deviceId: input.envelope.targetDeviceId,
        capabilityName: input.envelope.capability,
        settle,
      });
      // BLOCK 11 §21: `sentAtMilliseconds` es el instante en que el comando sale
      // al socket. Con `startedAtMilliseconds` (arriba) da el dispatch_ms; la
      // respuesta es el resto. Los dos son reloj real.
      const sentAtMilliseconds = this.#nowMilliseconds();
      try {
        input.send();
      } catch (error) {
        settle({
          ok: false,
          reason: 'device_disconnected',
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    });
  }

  // Un result con requestId desconocido se ignora: es un resultado tardío de un
  // comando que ya terminó, y no puede completar nada.
  settleByRequestId(requestId: string, rawResult: unknown): boolean {
    const entry = this.#pendingMap.get(requestId);
    if (entry === undefined) {
      return false;
    }
    entry.settle(readDeviceCommandOutcome(rawResult));
    return true;
  }

  // Los tres eventos de ejecucion sobre un device. Metadata minima: nada del
  // payload del comando, porque el titulo y el cuerpo de una notificacion son
  // contenido del usuario y no diagnostico.
  #emitOutcome(
    envelope: DeviceCommandEnvelope,
    outcome: DeviceCommandOutcome,
    startedAt: number,
    sentAt: number,
  ): void {
    const completedAt = this.#nowMilliseconds();
    const common = {
      toolName: this.#toolName,
      capabilityName: envelope.capability,
      targetDeviceId: envelope.targetDeviceId,
      targetDeviceType: describeCapabilityDeviceType(envelope.capability),
      durationMs: completedAt - startedAt,
      // BLOCK 11 §21: dispatch = encolar + mandar al socket; response = lo que
      // tardó el device (o el timeout). Si dispatchedMs > responseMs, el costo
      // está en nuestro lado del cable, no en el teléfono.
      deviceDispatchMs: sentAt - startedAt,
      deviceResponseMs: completedAt - sentAt,
      ...this.#correlation,
    };
    if (outcome.ok) {
      emitDeviceExecutionEvent({ ...common, event: 'device_execution_completed' });
      return;
    }
    emitDeviceExecutionEvent({
      ...common,
      event: 'device_execution_failed',
      reason: outcome.reason,
    });
  }

  // Al cerrarse un device se resuelven TODOS sus pendientes. Es lo que evita un
  // hang: nobody espera a un socket que ya no existe.
  rejectAllForDevice(deviceId: string, detail: string): number {
    const requestIdList = [...this.#pendingMap.entries()]
      .filter(([, entry]) => entry.deviceId === deviceId)
      .map(([requestId]) => requestId);
    for (const requestId of requestIdList) {
      this.#pendingMap
        .get(requestId)
        ?.settle({ ok: false, reason: 'device_disconnected', detail });
    }
    return requestIdList.length;
  }
}

export function readDeviceCommandOutcome(rawResult: unknown): DeviceCommandOutcome {
  const parsed = deviceCommandResultEnvelopeSchema.safeParse(rawResult);
  if (!parsed.success) {
    return {
      ok: false,
      reason: 'device_rejected',
      detail: 'El device devolvió un resultado con un formato inválido.',
    };
  }
  const envelope: DeviceCommandResultEnvelope = parsed.data;
  if (!envelope.ok) {
    return {
      ok: false,
      reason: 'device_rejected',
      detail: envelope.error ?? 'El device rechazó el comando.',
    };
  }
  return { ok: true, result: envelope.result };
}
