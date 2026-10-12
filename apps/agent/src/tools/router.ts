import { executeAuthorizedTool, resolveToolExecution } from '@/tools/execution';
import {
  getCapabilityForToolName,
  type CapabilityTargetResolver,
} from '@/devices/target';
import { verifyExecutionTarget } from '@/tools/target';
import type {
  JsonSerializableValue,
  PendingToolConfirmation,
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutionResult,
} from '@/tools/types';
import type { ToolExecutionOrigin, ToolExecutionOutcome } from '@/tools/execution';

export type ToolRouterOutcome = ToolExecutionOutcome;

export function isPendingConfirmationExpired(
  pendingConfirmation: PendingToolConfirmation,
  nowMilliseconds: number,
): boolean {
  return nowMilliseconds >= pendingConfirmation.expiresAt;
}

export async function executeToolByName(
  toolDefinitionMap: ReadonlyMap<string, ToolDefinition>,
  toolName: string,
  toolArgs: JsonSerializableValue | undefined,
  context: ToolExecutionContext,
  createConfirmationId: () => string = () => crypto.randomUUID(),
  origin: ToolExecutionOrigin = 'llm',
): Promise<ToolRouterOutcome> {
  return await resolveToolExecution({
    toolName,
    args: toolArgs,
    origin,
    toolDefinitionMap,
    context,
    createConfirmationId,
  });
}

export type ConfirmationCancelReason =
  | 'expired'
  | 'rejected'
  | 'unknown_tool'
  // El target se fue, ya no está, o perdió la capability: se distinguen para
  // poder hablar el motivo correcto y para los logs.
  | 'target_offline'
  | 'target_unavailable'
  | 'capability_absent'
  | 'no_device';

// Orden de la resolución (Block 6.1 §8): expiración → aprobación → target →
// autorización → ejecución. La verificación de target vive AQUÍ, junto al motor
// de confirmación, y no en el runtime del turno.
export async function resolvePendingToolConfirmation(
  toolDefinitionMap: ReadonlyMap<string, ToolDefinition>,
  pendingConfirmation: PendingToolConfirmation,
  isApproved: boolean,
  context: ToolExecutionContext,
  resolveCapabilityTarget?: CapabilityTargetResolver,
): Promise<
  | ToolExecutionResult
  | { readonly cancelled: true; readonly reason: ConfirmationCancelReason }
> {
  if (isPendingConfirmationExpired(pendingConfirmation, context.nowMilliseconds)) {
    return { cancelled: true, reason: 'expired' };
  }
  if (!isApproved) {
    return { cancelled: true, reason: 'rejected' };
  }
  if (toolDefinitionMap.get(pendingConfirmation.toolName) === undefined) {
    return { cancelled: true, reason: 'unknown_tool' };
  }

  // El target se resolvió antes de pedir la confirmación: no puede ejecutarse
  // sin comprobar que sigue disponible. Una confirmación unsafe nunca se
  // reroutea a otro device.
  if (pendingConfirmation.targetDeviceId !== undefined) {
    const verification = await verifyExecutionTarget({
      toolName: pendingConfirmation.toolName,
      capabilityName: getCapabilityForToolName(pendingConfirmation.toolName),
      targetDeviceId: pendingConfirmation.targetDeviceId,
      targetDeviceType: pendingConfirmation.targetDeviceType ?? 'unknown',
      resolver: resolveCapabilityTarget,
    });
    if (verification.status === 'unavailable') {
      return {
        cancelled: true,
        reason:
          verification.reason === 'target_unavailable' ||
          verification.reason === 'capability_absent' ||
          verification.reason === 'no_device'
            ? verification.reason
            : 'target_offline',
      };
    }
  }

  return await executeAuthorizedTool({
    toolName: pendingConfirmation.toolName,
    args: pendingConfirmation.args,
    toolDefinitionMap,
    context,
  });
}

export function buildToolDefinitionMap(
  toolDefinitionList: readonly ToolDefinition[],
): Map<string, ToolDefinition> {
  return new Map(
    toolDefinitionList.map((toolDefinition) => [toolDefinition.name, toolDefinition]),
  );
}
