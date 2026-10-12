import { mobileNotificationPayloadSchema } from '@/protocol/schema';
import {
  encodeServerToMobileMessage,
  serverToMobileMessageSchema,
} from '@/protocol/schema';

// ─────────────────────────────────────────────────────────────────────────────
// Peer mobile in-memory (§6).
//
// Representa EXACTAMENTE el protocolo que usará el cliente mobile real: recibe
// un mensaje 'command', valida capability y payload con el mismo schema que el
// Worker, y responde con un 'command_result'. No es un mock del transporte: es
// el otro lado del cable, con la misma validación.
//
// Lo que SÍ se inyecta es el reloj y el handler de notificación, porque un peer
// real lo postearía en la pantalla del teléfono.
// ─────────────────────────────────────────────────────────────────────────────

export type MobilePeerCommand = {
  readonly requestId: string;
  readonly capability: string;
  readonly payload: Record<string, unknown>;
  readonly clientTurnId?: string;
  readonly generation?: number;
};

export type MobilePeerBehavior = 'accept' | 'reject' | 'ignore' | 'disconnect';

export type InMemoryMobilePeerOptions = {
  readonly connectionId: string;
  readonly nowMilliseconds: () => number;
  /** Entrega un mensaje del servidor al peer. */
  readonly deliver: (messageText: string) => void;
  /** Avisa que el peer se desconectó, para que el harness lo cierre. */
  readonly onDisconnect: () => void;
  readonly behavior?: MobilePeerBehavior;
  /** Retardo simulado antes de responder, en ms. */
  readonly respondDelayMilliseconds?: number;
};

export class InMemoryMobilePeer {
  readonly receivedCommandList: MobilePeerCommand[] = [];
  readonly #options: InMemoryMobilePeerOptions;
  #isConnected = true;

  constructor(options: InMemoryMobilePeerOptions) {
    this.#options = options;
  }

  get isConnected(): boolean {
    return this.#isConnected;
  }

  get commandCount(): number {
    return this.receivedCommandList.length;
  }

  /** El endpoint entrega acá todo mensaje server → mobile. */
  receive(messageText: string): void {
    if (!this.#isConnected) {
      return;
    }
    const parsed = serverToMobileMessageSchema.safeParse(
      JSON.parse(messageText) as unknown,
    );
    if (!parsed.success || parsed.data.type !== 'command') {
      return;
    }
    const command = parsed.data;
    this.receivedCommandList.push({
      requestId: command.requestId,
      capability: command.capability,
      payload: command.payload,
      clientTurnId: command.clientTurnId,
      generation: command.generation,
    });
    const behavior = this.#options.behavior ?? 'accept';
    if (behavior === 'ignore') {
      return;
    }
    if (behavior === 'disconnect') {
      this.#isConnected = false;
      this.#options.onDisconnect();
      return;
    }
    const delay = this.#options.respondDelayMilliseconds ?? 0;
    if (delay > 0) {
      setTimeout(
        () => this.#respond(command.requestId, command.capability, behavior),
        delay,
      );
      return;
    }
    this.#respond(command.requestId, command.capability, behavior);
  }

  #respond(requestId: string, capability: string, behavior: MobilePeerBehavior): void {
    if (!this.#isConnected) {
      return;
    }
    if (behavior === 'reject') {
      this.#deliverResult({
        type: 'command_result',
        requestId,
        capability,
        ok: false,
        error: 'notifications_disabled',
        ts: this.#options.nowMilliseconds(),
      });
      return;
    }
    // El peer valida el payload con el MISMO schema que el Worker.
    const payload = mobileNotificationPayloadSchema.safeParse(this.lastPayload);
    if (!payload.success) {
      this.#deliverResult({
        type: 'command_result',
        requestId,
        capability,
        ok: false,
        error: 'invalid_payload',
        ts: this.#options.nowMilliseconds(),
      });
      return;
    }
    this.#deliverResult({
      type: 'command_result',
      requestId,
      capability,
      ok: true,
      result: { posted: true },
      ts: this.#options.nowMilliseconds(),
    });
  }

  get lastPayload(): Record<string, unknown> {
    return this.receivedCommandList.at(-1)?.payload ?? {};
  }

  #deliverResult(message: Record<string, unknown>): void {
    // El peer responde por el mismo camino del socket.
    this.#options.deliver(JSON.stringify(message));
  }
}

export function buildHelloAcceptedProbeMessage(deviceId: string): string {
  return encodeServerToMobileMessage({
    type: 'hello_accepted',
    deviceId,
    protocolVersion: 1,
    availableCapabilities: ['mobile.notifications'],
    ignoredCapabilityCount: 0,
    heartbeatIntervalMilliseconds: 30_000,
  });
}
