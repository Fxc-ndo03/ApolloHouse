import {
  readCapabilityForToolDefinition,
  type ToolWithExecutionTarget,
} from '@/tools/execution-target';
import type { CapabilityName } from '@/devices/capability';

// La fuente de verdad es el campo `executionTarget` de cada ToolDefinition. Este
// módulo sólo lo consulta, sin índice global que pueda quedar viejo.

export function resolveCapabilityForToolDefinition(
  toolDefinition: ToolWithExecutionTarget,
): CapabilityName | undefined {
  return readCapabilityForToolDefinition(toolDefinition);
}

export function resolveCapabilityForToolName(
  toolDefinitionMap: ReadonlyMap<string, ToolWithExecutionTarget>,
  toolName: string,
): CapabilityName | undefined {
  const toolDefinition = toolDefinitionMap.get(toolName);
  if (toolDefinition === undefined) {
    return undefined;
  }
  return readCapabilityForToolDefinition(toolDefinition);
}

export function isTargetedToolName(
  toolDefinitionMap: ReadonlyMap<string, ToolWithExecutionTarget>,
  toolName: string,
): boolean {
  return resolveCapabilityForToolName(toolDefinitionMap, toolName) !== undefined;
}
