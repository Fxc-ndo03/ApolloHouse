import type { CapabilityName } from '@/devices/capability';

// ─────────────────────────────────────────────────────────────────────────────
// Clasificación declarativa de tools.
//
// Una tool dice si necesita un device. No hay listas paralelas: el mapa de
// capabilities se DERIVA de acá, así que una tool nueva no puede quedar sin
// clasificar si su módulo la declara como targeted.
//
//   executionTarget ausente → cloud-only (no necesita device)
//   executionTarget.kind === 'capability' → targeted, con su capability
// ─────────────────────────────────────────────────────────────────────────────

export type ToolExecutionTargetKind = 'none' | 'capability';

export type ToolExecutionTarget =
  | { readonly kind: 'none' }
  | { readonly kind: 'capability'; readonly capabilityName: CapabilityName };

export const NO_EXECUTION_TARGET: ToolExecutionTarget = { kind: 'none' };

export function buildCapabilityExecutionTarget(
  capabilityName: CapabilityName,
): ToolExecutionTarget {
  return { kind: 'capability', capabilityName };
}

export type ToolWithExecutionTarget = {
  readonly name: string;
  readonly executionTarget?: ToolExecutionTarget;
};

export function readCapabilityForToolDefinition(
  toolDefinition: ToolWithExecutionTarget,
): CapabilityName | undefined {
  const executionTarget = toolDefinition.executionTarget;
  if (executionTarget === undefined || executionTarget.kind === 'none') {
    return undefined;
  }
  return executionTarget.capabilityName;
}

export function requiresExecutionTargetForToolDefinition(
  toolDefinition: ToolWithExecutionTarget,
): boolean {
  return readCapabilityForToolDefinition(toolDefinition) !== undefined;
}
