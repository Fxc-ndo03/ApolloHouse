import {
  describeCapability,
  isImplementedCapability,
  type CapabilityName,
  type MobileCapabilityName,
} from '@/devices/capability';
import { parseMobileCommandPayload } from '@/devices/payload';

// Resolución capability → comando mobile (BLOCK 11 §4).
//
// El comando NUNCA se inventa: se valida contra el `commandList` de la
// capability en el catálogo. Un caller que pida `capability: 'mobile.media'` con
// `command: 'rm -rf'` recibe `unsupported_command` antes de tocar el socket, y no
// hay forma de ejecutar un comando que su capability no declare (BLOCK 11 §16).

export type MobileCommandResolution =
  | {
      readonly isResolved: true;
      readonly commandName: string;
      readonly payload: Record<string, unknown>;
    }
  | {
      readonly isResolved: false;
      // Solo dos razones, y las dos son `DeviceCommandFailureReason`: la
      // capability no es mobile, no está implementada o no declara ese comando es
      // indistinguible desde el bridge de "este puente no sabe hacer eso"
      // (BLOCK 11 §5), y el aislamiento cross-device impide que una capability
      // desktop llegue siquiera a evaluarse acá.
      readonly reason: 'unsupported_command' | 'invalid_payload';
      readonly detail: string;
    };

export function isMobileCapabilityName(
  candidateCapabilityName: string,
): candidateCapabilityName is MobileCapabilityName {
  try {
    return (
      describeCapability(candidateCapabilityName as CapabilityName).deviceType ===
      'mobile'
    );
  } catch {
    return false;
  }
}

/**
 * Resuelve una capability mobile a un comando concreto y valida el payload con el
 * schema de esa capability.
 *
 * `commandName` ausente = comando canónico (el primero del commandList), que es
 * exactamente lo que mandaba un peer de Block 9.
 */
export function resolveMobileCommand(
  capabilityName: string,
  payload: unknown,
  commandName?: string,
): MobileCommandResolution {
  if (!isMobileCapabilityName(capabilityName)) {
    return {
      isResolved: false,
      reason: 'unsupported_command',
      detail: `La capability ${capabilityName} no es mobile.`,
    };
  }
  if (!isImplementedCapability(capabilityName)) {
    return {
      isResolved: false,
      reason: 'unsupported_command',
      detail: `La capability ${capabilityName} todavía no está implementada.`,
    };
  }
  const declaredCommandList = describeCapability(capabilityName)
    .commandList as readonly string[];
  const resolvedCommandName =
    commandName === undefined || commandName === ''
      ? declaredCommandList[0]
      : commandName;
  if (
    resolvedCommandName === undefined ||
    !declaredCommandList.includes(resolvedCommandName)
  ) {
    return {
      isResolved: false,
      reason: 'unsupported_command',
      detail: `La capability ${capabilityName} no declara el comando ${resolvedCommandName}.`,
    };
  }
  // El schema se elige por comando, no por capability: `alarm_set` y
  // `alarm_cancel` tienen payloads distintos (BLOCK 11 §4).
  const parsedPayload = parseMobileCommandPayload(resolvedCommandName, payload);
  if (!parsedPayload.isValid) {
    return {
      isResolved: false,
      reason: 'invalid_payload',
      detail: parsedPayload.detail,
    };
  }
  return {
    isResolved: true,
    commandName: resolvedCommandName,
    payload: parsedPayload.payload,
  };
}

/** El peer sólo acepta comandos que su capability declara (BLOCK 11 §16). */
export function isCommandDeclaredByCapability(
  capabilityName: string,
  commandName: string,
): boolean {
  try {
    return (
      describeCapability(capabilityName as CapabilityName)
        .commandList as readonly string[]
    ).includes(commandName);
  } catch {
    return false;
  }
}
