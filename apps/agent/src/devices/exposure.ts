import {
  describeCapabilityDeviceType,
  isImplementedCapability,
  type CapabilityName,
} from '@/devices/capability';
import { resolveMobileBridgeClient } from '@/devices/bridge-client';
import { resolveCapabilityForToolDefinition } from '@/tools/capability-index';
import type { ToolWithExecutionTarget } from '@/tools/execution-target';

// Exposición de tools según el registry (BLOCK 11 §11 y §13).
//
// El optimizador de Block 3 filtra por dominio; esto agrega el filtro que faltaba:
// una tool que necesita un device NO se expone si no hay ningún device compatible.
// El motivo es concreto: el modelo ofrece "abrir en el teléfono" y el teléfono no
// existe, el usuario lo pide y la tool falla por unavailable en vez de responder
// algo útil.

export type ReachableCapabilitySnapshot = {
  /** Capabilities que tienen al menos un device conectado y presente. */
  readonly reachableCapabilityNameSet: ReadonlySet<string>;
  /** Devices mobile conocidos, para el contexto del prompt. */
  readonly mobileDeviceSummaryList: readonly {
    readonly deviceId: string;
    readonly presence: string;
    readonly capabilityNameList: readonly string[];
  }[];
};

export function listCapabilityNameForDevice(
  toolDefinitionList: readonly ToolWithExecutionTarget[],
  snapshot: ReachableCapabilitySnapshot,
): readonly string[] {
  const blocked = new Set<string>();
  for (const toolDefinition of toolDefinitionList) {
    const capabilityName = resolveCapabilityForToolDefinition(toolDefinition);
    if (capabilityName === undefined) {
      continue;
    }
    if (!isImplementedCapability(capabilityName)) {
      continue;
    }
    // Cloud-only (deviceType desktop sin registry) no se toca: su resolución la
    // hace PcBridge, no el MobileBridge.
    if (describeCapabilityDeviceType(capabilityName) !== 'mobile') {
      continue;
    }
    if (!snapshot.reachableCapabilityNameSet.has(capabilityName)) {
      blocked.add(toolDefinition.name);
    }
  }
  return [...blocked];
}

/**
 * Quita del catálogo las tools mobile sin device compatible. Cloud-only y MCP
 * quedan intactos: sólo se bloquea lo que realmente depende de un teléfono.
 */
export function filterToolByReachableDevice<T extends { readonly name: string }>(
  toolDefinitionList: readonly T[],
  snapshot: ReachableCapabilitySnapshot,
): readonly T[] {
  const blockedNameSet = new Set(
    listCapabilityNameForDevice(toolDefinitionList, snapshot),
  );
  if (blockedNameSet.size === 0) {
    return toolDefinitionList;
  }
  return toolDefinitionList.filter(
    (toolDefinition) => !blockedNameSet.has(toolDefinition.name),
  );
}

/**
 * Contexto cross-device mínimo (BLOCK 11 §13). Sólo deviceId, deviceType,
 * presence y un resumen de capabilities: el registry entero NO va en el prompt.
 * Devuelve cadena vacía cuando no hay nada mobile que contar, para que el prompt
 * no cambie de forma innecesaria.
 */
export function buildDeviceContextNote(
  activeDeviceId: string,
  snapshot: ReachableCapabilitySnapshot,
): string {
  const mobileLineList = snapshot.mobileDeviceSummaryList.map((device) => {
    const activeMarker = device.deviceId === activeDeviceId ? ' (activo)' : '';
    const capabilitySummary =
      device.capabilityNameList.length === 0
        ? 'sin capabilities'
        : device.capabilityNameList.join(', ');
    return `- ${device.deviceId} [${device.presence}]${activeMarker}: ${capabilitySummary}`;
  });
  if (mobileLineList.length === 0) {
    return '';
  }
  return [
    '',
    'Dispositivos disponibles:',
    ...mobileLineList,
    '',
    'El teléfono tiene sus propias capabilities (mobile.*). La PC tiene las desktop.*.',
    'No asumas que una capability de un dispositivo existe en el otro.',
  ].join('\n');
}

/** Convierte la respuesta del bridge en el snapshot que usan los dos filtros. */
export function buildReachableCapabilitySnapshot(answer: {
  readonly reachableCapabilityEntryList: readonly {
    readonly capabilityName: CapabilityName;
    readonly deviceId: string | null;
    readonly presence: string | null;
  }[];
  readonly deviceSummaryList: readonly {
    readonly deviceId: string;
    readonly presence: string;
    readonly capabilityNameList: readonly string[];
  }[];
}): ReachableCapabilitySnapshot {
  return {
    reachableCapabilityNameSet: new Set(
      answer.reachableCapabilityEntryList
        .filter((entry) => entry.deviceId !== null)
        .map((entry) => entry.capabilityName),
    ),
    mobileDeviceSummaryList: answer.deviceSummaryList,
  };
}

/**
 * Snapshot vacío: no hay MobileBridge, o el bridge no respondió. En ese caso no
 * se filtra nada, para que el turno se comporte como antes de Block 11 en vez de
 * ocultar capabilities que quizá otro transporte pueda cumplir.
 */
export function buildEmptyReachableCapabilitySnapshot(): ReachableCapabilitySnapshot {
  return { reachableCapabilityNameSet: new Set(), mobileDeviceSummaryList: [] };
}

/**
 * Pide el snapshot al bridge. Es la ÚNICA llamada extra por turno, y solo en el
 * LLM path: el fast path determinista no la hace porque no arma catálogo ni
 * prompt (BLOCK 11 §13 y §21).
 */
export async function loadReachableCapabilitySnapshotFromBridge(
  environment: Env,
): Promise<ReachableCapabilitySnapshot> {
  const mobileBridge = resolveMobileBridgeClient(environment);
  if (mobileBridge === undefined) {
    return buildEmptyReachableCapabilitySnapshot();
  }
  try {
    const answer = await mobileBridge.listReachableCapabilityList();
    return buildReachableCapabilitySnapshot(answer);
  } catch {
    // Un bridge caído no puede romper el turno: sin snapshot, sin filtro.
    return buildEmptyReachableCapabilitySnapshot();
  }
}
