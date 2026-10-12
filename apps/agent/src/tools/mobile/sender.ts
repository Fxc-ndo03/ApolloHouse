import { describeCapability, type CapabilityName } from '@/devices/capability';
import { parseMobileCommandPayload } from '@/devices/payload';
import { resolveMobileBridgeClient } from '@/devices/bridge-client';
import type {
  JsonSerializableValue,
  ToolExecutionContext,
  ToolExecutionResult,
} from '@/tools/types';

// Envío mobile compartido por TODAS las capabilities mobile (BLOCK 11 §3).
//
// La tool decide qué capability y qué payload; el bridge decide el comando (del
// catálogo) y valida el payload con el MISMO schema. La tool NO manda un nombre
// de comando: no hay campo para eso.

export type MobileCommandSender = (input: {
  readonly targetDeviceId: string;
  readonly capabilityName: CapabilityName;
  // BLOCK 11 §4: una capability puede tener varios comandos. La tool sabe cuál
  // pidió el usuario; si falta, el bridge usa el canónico de la capability.
  readonly commandName?: string;
  readonly requestId: string;
  readonly payload: Record<string, unknown>;
  readonly clientTurnId?: string;
  readonly generation?: number;
}) => Promise<MobileBridgeAnswer>;

export type MobileBridgeAnswer = {
  readonly status: 'completed' | 'failed';
  readonly reason?: string | null;
  readonly detail?: string | null;
  readonly result?: unknown;
};

// El requestId lo decide la correlación del turno: el mismo turno nunca genera
// dos requestId, y un reintento del mismo turno conserva el suyo.
export function buildMobileRequestId(context: ToolExecutionContext): string {
  const correlationRequestId = context.correlation?.requestId;
  if (typeof correlationRequestId === 'string' && correlationRequestId.length > 0) {
    return correlationRequestId;
  }
  return crypto.randomUUID();
}

/**
 * Comando canonico de una capability: el primero de su `commandList`. Es lo que
 * usa el peer cuando Apollo no manda `command`, y lo que usa esta tool para
 * elegir el schema del payload antes de llamar al bridge.
 */
export function resolveCanonicalCommandName(capabilityName: CapabilityName): string {
  const canonicalCommandName = describeCapability(capabilityName).commandList[0];
  if (canonicalCommandName === undefined) {
    throw new Error(`La capability ${capabilityName} no declara comando`);
  }
  return canonicalCommandName;
}

const FAILURE_SUMMARY_MAP: ReadonlyMap<string, string> = new Map([
  ['device_timeout', 'El teléfono no respondió a tiempo.'],
  ['device_disconnected', 'El teléfono se desconectó antes de responder.'],
  ['unknown_device', 'El teléfono ya no está conectado.'],
  ['duplicate_request_id', 'La operación ya se estaba enviando.'],
  ['unsupported_command', 'El teléfono todavía no soporta esa operación.'],
  ['invalid_payload', 'Los datos de la operación no son válidos.'],
  ['device_rejected', 'El teléfono rechazó la operación.'],
]);

export function readMobileFailureSummary(answer: MobileBridgeAnswer): string {
  if (answer.reason === 'device_rejected' || answer.reason === 'invalid_payload') {
    return (
      answer.detail ?? FAILURE_SUMMARY_MAP.get(answer.reason) ?? 'Falló la operación.'
    );
  }
  return (
    FAILURE_SUMMARY_MAP.get(answer.reason ?? '') ?? 'No pude completar la operación.'
  );
}

/**
 * Ejecuta una capability mobile. Valida el payload antes de llamar al bridge (no
 * tiene sentido un round trip para un payload inválido) y traduce los fallos a
 * un mensaje que el usuario entienda, sin esconder el error del device.
 */
export async function sendMobileCapabilityCommand(input: {
  readonly context: ToolExecutionContext;
  readonly capabilityName: CapabilityName;
  readonly commandName?: string;
  readonly args: JsonSerializableValue | undefined;
  readonly successSummary: string;
  /**
   * Los comandos de lectura (`volume_get`, `calendar_list`) devuelven datos, así
   * que su resumen se arma con la respuesta en vez de ser texto fijo.
   */
  readonly buildSuccessSummary?: (result: unknown) => string;
  readonly invalidPayloadSummary: string;
  readonly sendCommand?: MobileCommandSender;
}): Promise<ToolExecutionResult> {
  // La tool valida con el schema del COMANDO que va a pedir, que es el mismo
  // que valida el bridge: una sola definición de la forma (BLOCK 11 §3).
  const commandName =
    input.commandName ?? resolveCanonicalCommandName(input.capabilityName);
  const parsedPayload = parseMobileCommandPayload(commandName, input.args ?? {});
  if (!parsedPayload.isValid) {
    return { ok: false, summary: input.invalidPayloadSummary };
  }
  const sendCommand = input.sendCommand ?? buildRpcCommandSender(input.context);
  let answer: MobileBridgeAnswer;
  try {
    answer = await sendCommand({
      // El device lo resolvió el pipeline; la tool no vuelve a buscarlo.
      targetDeviceId: input.context.targetDeviceId ?? input.context.deviceId ?? '',
      capabilityName: input.capabilityName,
      ...(input.commandName === undefined ? {} : { commandName: input.commandName }),
      requestId: buildMobileRequestId(input.context),
      payload: parsedPayload.payload,
      clientTurnId: input.context.correlation?.clientTurnId ?? undefined,
      generation: input.context.correlation?.generation ?? undefined,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, summary: `El teléfono no respondió (${detail}).` };
  }
  if (answer.status !== 'completed') {
    return { ok: false, summary: readMobileFailureSummary(answer) };
  }
  return {
    ok: true,
    summary: input.buildSuccessSummary?.(answer.result) ?? input.successSummary,
    data: answer.result as JsonSerializableValue | undefined,
  };
}

function buildRpcCommandSender(context: ToolExecutionContext): MobileCommandSender {
  return async (request) => {
    // El MISMO cliente que usa el resolver: una sola forma de llegar al bridge.
    const mobileBridge = resolveMobileBridgeClient(context.environment);
    if (mobileBridge === undefined) {
      return { status: 'failed', reason: 'unknown_device' };
    }
    return (await mobileBridge.sendMobileCommand(request)) as MobileBridgeAnswer;
  };
}
