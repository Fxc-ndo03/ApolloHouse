import {
  type CapabilityTargetResolver,
  type ResolvedCapabilityTarget,
} from '@/devices/target';
import {
  buildCancellationResult,
  toCancellationReason,
  type CancellationResult,
} from '@/tools/cancellation';
import { buildTargetPreferenceForCapabilityName } from '@/devices/target';
import { resolveCapabilityForToolName } from '@/tools/capability-index';
import {
  buildExecutionPipelineEventLogLine,
  type ExecutionPipelineEvent,
} from '@/devices/events';
import type { CapabilityUnavailableReason } from '@/devices/registry';
import type { CapabilityName } from '@/devices/capability';
import {
  authorizeToolExecution,
  executeAuthorizedTool,
  type ToolExecutionOrigin,
} from '@/tools/execution';
import type { TargetPreference } from '@/devices/schema';
import type {
  JsonSerializableValue,
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutionResult,
} from '@/tools/types';

// ─────────────────────────────────────────────────────────────────────────────
// Capa de target en el execution boundary.
//
// Es el ÚNICO camino por el que una tool se ejecuta con target:
//
//   TOOL SELECTION → CAPABILITY → TARGET → AUTHORIZATION → CONFIRMATION →
//   TARGET REVALIDATION → EXECUTION
//
// La usan igual el router determinista y el tool loop del LLM. Una tool sin
// capability (cloud-only o MCP) no hace resolution: se autoriza y ejecuta.
// ─────────────────────────────────────────────────────────────────────────────

export type ExecutionTargetResolution =
  | {
      readonly status: 'not_required';
      readonly capabilityName: CapabilityName | undefined;
      readonly reason: 'no_capability' | 'no_resolver';
    }
  | {
      readonly status: 'resolved';
      readonly capabilityName: CapabilityName;
      readonly target: ResolvedCapabilityTarget;
    }
  | {
      readonly status: 'unavailable';
      readonly capabilityName: CapabilityName | undefined;
      readonly reason: CapabilityUnavailableReason;
    };

export type ExecutionTargetPhase = 'initial' | 'revalidation';

export type TargetCorrelation = {
  readonly requestId?: string | null;
  readonly clientTurnId?: string | null;
  readonly generation?: number | null;
};

// Política de target para el camino LLM. El deviceType sale del CONTRATO de la
// capability (devices/capability.ts), no de un prefijo de texto: el modelo no
// elige el device y una capability mobile jamás cae en un desktop ni al revés.
export function buildTargetPreferenceForCapability(
  capabilityName: CapabilityName,
): TargetPreference {
  return buildTargetPreferenceForCapabilityName(capabilityName);
}

export async function resolveExecutionTarget(input: {
  readonly toolName: string;
  readonly capabilityName: CapabilityName | undefined;
  readonly targetPreference?: TargetPreference;
  readonly resolver: CapabilityTargetResolver | undefined;
  readonly phase: ExecutionTargetPhase;
  readonly correlation?: TargetCorrelation;
}): Promise<ExecutionTargetResolution> {
  if (input.capabilityName === undefined) {
    // Cloud-only o tool desconocida: no hay target que resolver.
    return {
      status: 'not_required',
      capabilityName: undefined,
      reason: 'no_capability',
    };
  }
  if (input.resolver === undefined) {
    // Sin registry conectado no se puede afirmar nada: la tool sigue su camino
    // como antes, pero queda claro en el log que no hubo target.
    return {
      status: 'not_required',
      capabilityName: input.capabilityName,
      reason: 'no_resolver',
    };
  }
  const targetPreference =
    input.targetPreference ?? buildTargetPreferenceForCapability(input.capabilityName);
  const resolution = await input.resolver({
    capabilityName: input.capabilityName,
    targetPreference,
  });
  if (resolution.status === 'resolved') {
    emitPipelineEvent({
      event: 'execution_target_resolved',
      phase: input.phase,
      toolName: input.toolName,
      capabilityName: input.capabilityName,
      targetDeviceId: resolution.target.deviceId,
      targetDeviceType: resolution.target.deviceType,
      presence: resolution.target.presence,
      correlation: input.correlation,
    });
    return {
      status: 'resolved',
      capabilityName: input.capabilityName,
      target: resolution.target,
    };
  }
  emitPipelineEvent({
    event: 'execution_target_unavailable',
    phase: input.phase,
    toolName: input.toolName,
    capabilityName: input.capabilityName,
    reason: resolution.reason,
    correlation: input.correlation,
  });
  return {
    status: 'unavailable',
    capabilityName: input.capabilityName,
    reason: resolution.reason,
  };
}

// Verificación puntual: el target exacto sigue disponible y usable.
export async function verifyExecutionTarget(input: {
  readonly toolName: string;
  readonly capabilityName: CapabilityName | undefined;
  readonly targetDeviceId: string;
  readonly targetDeviceType: string;
  readonly resolver: CapabilityTargetResolver | undefined;
  readonly correlation?: TargetCorrelation;
}): Promise<{
  readonly status: 'available' | 'unavailable';
  readonly reason?: CapabilityUnavailableReason;
}> {
  if (input.resolver === undefined || input.capabilityName === undefined) {
    return { status: 'available' };
  }
  const verification = await resolveExecutionTarget({
    toolName: input.toolName,
    capabilityName: input.capabilityName,
    targetPreference: { kind: 'device', deviceId: input.targetDeviceId },
    resolver: input.resolver,
    phase: 'revalidation',
    correlation: input.correlation,
  });
  if (verification.status !== 'resolved') {
    return {
      status: 'unavailable',
      reason:
        verification.status === 'unavailable'
          ? verification.reason
          : 'target_unavailable',
    };
  }
  return verification.target.presence === 'online' ||
    verification.target.presence === 'degraded'
    ? { status: 'available' }
    : { status: 'unavailable', reason: 'target_offline' };
}

export type ToolPipelineOutcome =
  | {
      readonly status: 'done';
      readonly result: ToolExecutionResult;
      readonly capabilityName: CapabilityName | undefined;
      readonly target: ResolvedCapabilityTarget | undefined;
    }
  | {
      readonly status: 'needs_confirm';
      readonly pending: import('@/tools/types').PendingToolConfirmation;
      readonly capabilityName: CapabilityName | undefined;
      readonly target: ResolvedCapabilityTarget | undefined;
    }
  | {
      readonly status: 'skipped';
      readonly cancellation: CancellationResult;
      readonly capabilityName: CapabilityName | undefined;
    };

// El pipeline completo. Deterministic y LLM llaman SOLO esto.
export async function executeToolWithTargetResolution(input: {
  readonly toolName: string;
  readonly args: JsonSerializableValue | undefined;
  readonly origin: ToolExecutionOrigin;
  readonly toolDefinitionMap: ReadonlyMap<string, ToolDefinition>;
  readonly context: ToolExecutionContext;
  readonly resolver: CapabilityTargetResolver | undefined;
  readonly targetPreference?: TargetPreference;
  readonly correlation?: TargetCorrelation;
  readonly createConfirmationId?: () => string;
  readonly onTiming?: (timing: {
    readonly capabilityResolutionMs: number;
    readonly authorizationMs: number;
    readonly executionMs: number;
  }) => void;
}): Promise<ToolPipelineOutcome> {
  const capabilityName = resolveCapabilityForToolName(
    input.toolDefinitionMap,
    input.toolName,
  );
  const capabilityStartMs = Date.now();
  const targetResolution = await resolveExecutionTarget({
    toolName: input.toolName,
    capabilityName,
    targetPreference: input.targetPreference,
    resolver: input.resolver,
    phase: 'initial',
    correlation: input.correlation,
  });
  const capabilityResolutionMs = Date.now() - capabilityStartMs;

  if (targetResolution.status === 'unavailable') {
    emitPipelineEvent({
      event: 'execution_skipped',
      toolName: input.toolName,
      capabilityName: capabilityName ?? null,
      reason: targetResolution.reason,
      correlation: input.correlation,
    });
    return {
      status: 'skipped',
      cancellation: buildCancellationResult(
        toCancellationReason(targetResolution.reason),
      ),
      capabilityName,
    };
  }

  const resolvedTarget =
    targetResolution.status === 'resolved' ? targetResolution.target : undefined;

  const authorizationStartMs = Date.now();
  const authorization = authorizeToolExecution({
    toolName: input.toolName,
    args: input.args,
    origin: input.origin,
    toolDefinitionMap: input.toolDefinitionMap,
    context: input.context,
    ...(input.createConfirmationId === undefined
      ? {}
      : { createConfirmationId: input.createConfirmationId }),
    ...(resolvedTarget === undefined
      ? {}
      : {
          target: {
            deviceId: resolvedTarget.deviceId,
            deviceType: resolvedTarget.deviceType,
          },
        }),
  });
  const authorizationMs = Date.now() - authorizationStartMs;
  const effectiveCapabilityName = targetResolution.capabilityName ?? capabilityName;

  if (authorization.status === 'refused') {
    emitPipelineEvent({
      event: 'execution_authorized',
      toolName: input.toolName,
      capabilityName: effectiveCapabilityName ?? null,
      targetDeviceId: resolvedTarget?.deviceId,
      targetDeviceType: resolvedTarget?.deviceType,
      decision: 'refused',
      correlation: input.correlation,
    });
    return {
      status: 'done',
      result: authorization.result,
      capabilityName: effectiveCapabilityName,
      target: resolvedTarget,
    };
  }

  if (authorization.status === 'needs_confirm') {
    emitPipelineEvent({
      event: 'execution_confirmation_pending',
      toolName: input.toolName,
      capabilityName: effectiveCapabilityName ?? null,
      targetDeviceId: resolvedTarget?.deviceId,
      targetDeviceType: resolvedTarget?.deviceType,
      correlation: input.correlation,
    });
    return {
      status: 'needs_confirm',
      pending: authorization.pending,
      capabilityName: effectiveCapabilityName,
      target: resolvedTarget,
    };
  }

  emitPipelineEvent({
    event: 'execution_authorized',
    toolName: input.toolName,
    capabilityName: effectiveCapabilityName ?? null,
    targetDeviceId: resolvedTarget?.deviceId,
    targetDeviceType: resolvedTarget?.deviceType,
    decision: 'authorized',
    correlation: input.correlation,
  });

  // El target se resolvió antes de autorizar: no puede ejecutarse sin reverificar.
  if (resolvedTarget !== undefined) {
    const verification = await verifyExecutionTarget({
      toolName: input.toolName,
      capabilityName: effectiveCapabilityName,
      targetDeviceId: resolvedTarget.deviceId,
      targetDeviceType: resolvedTarget.deviceType,
      resolver: input.resolver,
      correlation: input.correlation,
    });
    if (verification.status === 'unavailable') {
      const reason = verification.reason ?? 'target_offline';
      emitPipelineEvent({
        event: 'execution_skipped',
        toolName: input.toolName,
        capabilityName: effectiveCapabilityName ?? null,
        targetDeviceId: resolvedTarget.deviceId,
        targetDeviceType: resolvedTarget.deviceType,
        reason,
        correlation: input.correlation,
      });
      return {
        status: 'skipped',
        cancellation: buildCancellationResult(toCancellationReason(reason)),
        capabilityName: effectiveCapabilityName,
      };
    }
  }

  const executionStartMs = Date.now();
  const result = await executeAuthorizedTool({
    toolName: input.toolName,
    args: input.args,
    toolDefinitionMap: input.toolDefinitionMap,
    // La correlación del turno y el device resuelto llegan al handler: es lo que
    // permite atar el comando al device correcto y devolver el resultado al
    // turno correcto. El handler NUNCA vuelve a resolver target.
    context: {
      ...input.context,
      correlation: input.correlation,
      ...(resolvedTarget === undefined
        ? {}
        : {
            targetDeviceId: resolvedTarget.deviceId,
            targetDeviceType: resolvedTarget.deviceType,
          }),
    },
  });
  const executionMs = Date.now() - executionStartMs;
  input.onTiming?.({ capabilityResolutionMs, authorizationMs, executionMs });
  return {
    status: 'done',
    result,
    capabilityName: effectiveCapabilityName,
    target: resolvedTarget,
  };
}

export function emitPipelineEvent(event: ExecutionPipelineEvent): void {
  console.log(buildExecutionPipelineEventLogLine(event));
}
