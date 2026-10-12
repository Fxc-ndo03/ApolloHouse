import { buildMobileTransport } from '@/devices/mobile';
import type { MobileHandshakeOutcome, MobileMessagePort } from '@/devices/mobile';
import type { CapabilityRegistry } from '@/devices/registry';
import type { HeartbeatTimerPort } from '@/devices/heartbeat';

// ─────────────────────────────────────────────────────────────────────────────
// Harness de sesión (§12).
//
// El transporte mobile real necesita un endpoint de Cloudflare, que a su vez
// arrastra los imports `cloudflare:` del SDK y no se puede cargar bajo `bun test`.
// Este harness aísla la sesión: registry real + lifecycle real + transporte real
// sobre un port falso. Lo que se testea aquí es el contrato; el e2e contra el DO
// real es otra capa y no se simula con hacks globales.
// ─────────────────────────────────────────────────────────────────────────────

export type RecordingMobilePort = MobileMessagePort & {
  readonly sentMessageList: string[];
};

export function createRecordingMobilePort(): RecordingMobilePort {
  const sentMessageList: string[] = [];
  return {
    sentMessageList,
    send: (messageText: string) => {
      sentMessageList.push(messageText);
    },
    close: () => undefined,
  };
}

export function buildMobilePeerTransportForTest(input: {
  readonly registry: CapabilityRegistry;
  readonly port: MobileMessagePort;
  readonly timerPort: HeartbeatTimerPort;
  readonly connectionId: string;
  readonly nowMilliseconds: () => number;
}): ReturnType<typeof buildMobileTransport> {
  return buildMobileTransport({
    registry: input.registry,
    port: input.port,
    connectionId: input.connectionId,
    timerPort: input.timerPort,
    nowMilliseconds: input.nowMilliseconds,
  });
}

// Narrowing explícito del union de handshake, para que los tests puedan leer la
// razón del rechazo sin castear a mano.
export function readRejectionReason(outcome: MobileHandshakeOutcome): string {
  if (outcome.status !== 'rejected') {
    throw new Error(`se esperaba un rejection y llegó '${outcome.status}'`);
  }
  return outcome.reason;
}
