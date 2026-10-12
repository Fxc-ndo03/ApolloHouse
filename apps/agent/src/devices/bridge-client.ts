import type { MobileBridge } from '@/agents/mobile-bridge';

// ─────────────────────────────────────────────────────────────────────────────
// LA frontera de transporte hacia el MobileBridge.
//
// Existe una sola forma de alcanzar el bridge, y la usan tanto el resolver de
// targets como las tools. Antes cada uno resolvía el stub por su cuenta
// (`getAgentByName` por un lado, `idFromName` por el otro) y eso fue
// exactamente el bug de Block 9.1: el resolver veía el device en una
// instancia del DO y la tool despachaba contra otra, así que el comando nunca
// llegaba al teléfono.
//
// Es capability-agnostic: no sabe qué capability se le pide, sólo cómo
// llegar al bridge.
// ─────────────────────────────────────────────────────────────────────────────

// El nombre de la instancia vive acá: es el único lugar que decide a qué
// Durable Object del bridge se habla. Un device es multiplexado en UNA instancia
// compartida, no en una por device.
export const MOBILE_BRIDGE_INSTANCE_NAME = 'mobile';

export type MobileBridgeStub = DurableObjectStub<MobileBridge> | undefined;

export function resolveMobileBridgeClient(environment: Env): MobileBridgeStub {
  // Sin binding no hay endpoint mobile: quien llama degrada (404 / no_device).
  if (environment.MobileBridge === undefined) {
    return undefined;
  }
  return environment.MobileBridge.get(
    environment.MobileBridge.idFromName(MOBILE_BRIDGE_INSTANCE_NAME),
  );
}
