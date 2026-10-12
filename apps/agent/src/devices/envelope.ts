import { z } from 'zod';

import { capabilityNameSchema, type CapabilityName } from '@/devices/capability';
import { deviceIdSchema } from '@/devices/identity';

// ─────────────────────────────────────────────────────────────────────────────
// Envelope de comando neutral (§6).
//
// Es CONTRATO, no ejecución: describe cómo se le pide una capability a un device
// y cómo contesta, sin saber todavía qué transport lo lleva ni qué handler lo
// satisface. La ejecución real sigue siendo la de src/tools/execution.ts, y el
// registry nunca construye ni despacha estos envelopes.
//
// La correlación viaja en el envelope (requestId, clientTurnId, generation) para
// que un mensaje device <-> Apollo se pueda atar a un turno aunque el comando
// llegue por un camino distinto al que lo pidió (§7).
// ─────────────────────────────────────────────────────────────────────────────

export const deviceCommandEnvelopeSchema = z.object({
  requestId: z.string().min(1).max(128),
  clientTurnId: z.string().min(1).max(128).optional(),
  generation: z.number().int().nonnegative().optional(),
  capability: capabilityNameSchema,
  // BLOCK 11 §4: comando explicito, opcional. Si falta, el peer usa el comando
  // canonico de la capability (el primero de su commandList), que es lo que
  // mandaban los peers de Block 9.
  command: z.string().min(1).max(48).optional(),
  targetDeviceId: deviceIdSchema,
  payload: z.record(z.unknown()),
});

export type DeviceCommandEnvelope = z.infer<typeof deviceCommandEnvelopeSchema>;

export const deviceCommandResultEnvelopeSchema = z.object({
  requestId: z.string().min(1).max(128),
  deviceId: deviceIdSchema,
  capability: capabilityNameSchema,
  ok: z.boolean(),
  error: z.string().min(1).max(512).optional(),
  result: z.unknown().optional(),
});

export type DeviceCommandResultEnvelope = z.infer<
  typeof deviceCommandResultEnvelopeSchema
>;

export type DeviceEnvelopeCorrelation = {
  readonly requestId: string;
  readonly clientTurnId?: string;
  readonly generation?: number;
};

export function buildDeviceCommandEnvelope(input: {
  readonly requestId: string;
  readonly clientTurnId?: string;
  readonly generation?: number;
  readonly capability: CapabilityName;
  // BLOCK 11 §4: comando explicito de la capability. Opcional: si falta, el peer
  // usa el canónico (el primero del commandList), que es lo que mandaba un peer
  // de Block 9.
  readonly command?: string;
  readonly targetDeviceId: string;
  readonly payload?: Readonly<Record<string, unknown>>;
}): DeviceCommandEnvelope {
  return deviceCommandEnvelopeSchema.parse({
    requestId: input.requestId,
    clientTurnId: input.clientTurnId,
    generation: input.generation,
    capability: input.capability,
    command: input.command,
    targetDeviceId: input.targetDeviceId,
    payload: input.payload ?? {},
  });
}

export function buildDeviceCommandResultEnvelope(input: {
  readonly requestId: string;
  readonly deviceId: string;
  readonly capability: CapabilityName;
  readonly ok: boolean;
  readonly error?: string;
  readonly result?: unknown;
}): DeviceCommandResultEnvelope {
  return deviceCommandResultEnvelopeSchema.parse({
    requestId: input.requestId,
    deviceId: input.deviceId,
    capability: input.capability,
    ok: input.ok,
    error: input.ok ? undefined : input.error,
    result: input.result,
  });
}

export function readDeviceEnvelopeCorrelation(
  envelope: DeviceCommandEnvelope,
): DeviceEnvelopeCorrelation {
  return {
    requestId: envelope.requestId,
    clientTurnId: envelope.clientTurnId,
    generation: envelope.generation,
  };
}
