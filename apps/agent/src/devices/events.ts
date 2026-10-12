import type { CapabilityName } from '@/devices/capability';
import type { DeviceType, PresenceState } from '@/devices/schema';

// Eventos de presencia/capability. Sin secretos: sólo identidad de dispositivo,
// capability, presencia y correlación de turno.

export type DeviceEventName =
  | 'device_registered'
  | 'device_presence_changed'
  | 'device_capabilities_updated'
  | 'capability_resolution'
  | 'capability_unavailable'
  | 'presence_online'
  | 'presence_degraded'
  | 'presence_offline'
  | 'capability_resolution'
  | 'capability_execution';

// Heartbeats individuales: debug-only para no llenar el log. Los eventos de
// transición de presencia son level info y sólo ocurren cuando el estado cambia.
export type DeviceHeartbeatEventName = 'heartbeat_sent' | 'heartbeat_received';

export type DeviceEventCorrelation = {
  readonly requestId?: string | null;
  readonly clientTurnId?: string | null;
  readonly generation?: number | null;
};

export type DeviceEvent = DeviceEventCorrelation & {
  readonly event: DeviceEventName;
  readonly deviceId: string;
  readonly deviceType: DeviceType;
  readonly capabilityName?: CapabilityName;
  readonly presence?: PresenceState;
  readonly protocolVersion?: number;
  readonly detail?: string;
};

export function buildDeviceEventLogLine(event: DeviceEvent): string {
  return JSON.stringify({
    level: 'info',
    message: `device_${event.event}`,
    device_id: event.deviceId,
    device_type: event.deviceType,
    capability: event.capabilityName ?? null,
    presence: event.presence ?? null,
    protocol_version: event.protocolVersion ?? null,
    request_id: event.requestId ?? null,
    client_turn_id: event.clientTurnId ?? null,
    generation: event.generation ?? null,
    detail: event.detail ?? null,
  });
}

export function emitDeviceEvent(event: DeviceEvent): void {
  console.log(buildDeviceEventLogLine(event));
}

export type DeviceHeartbeatEvent = DeviceEventCorrelation & {
  readonly event: DeviceHeartbeatEventName;
  readonly deviceId: string;
  readonly deviceType: DeviceType;
  readonly protocolVersion?: number;
  readonly atMilliseconds: number;
};

export function buildDeviceHeartbeatEventLogLine(event: DeviceHeartbeatEvent): string {
  return JSON.stringify({
    level: 'debug',
    message: `device_${event.event}`,
    device_id: event.deviceId,
    device_type: event.deviceType,
    protocol_version: event.protocolVersion ?? null,
    heartbeat_at: event.atMilliseconds,
    request_id: event.requestId ?? null,
    client_turn_id: event.clientTurnId ?? null,
    generation: event.generation ?? null,
  });
}

export function emitDeviceHeartbeatEvent(event: DeviceHeartbeatEvent): void {
  console.log(buildDeviceHeartbeatEventLogLine(event));
}

export type CapabilityResolutionEvent = DeviceEventCorrelation & {
  readonly event: 'capability_resolution';
  readonly capabilityName: CapabilityName | null;
  readonly targetPreferenceKind: string;
  readonly resolvedDeviceId: string | null;
  readonly resolvedDeviceType: string | null;
  readonly presence: string | null;
  readonly resolutionStatus: 'resolved' | 'unavailable';
  readonly unavailableReason: string | null;
  readonly capabilityResolutionMs: number;
  readonly routingDurationMs: number | null;
  readonly turnId?: string | null;
  readonly generation?: number | null;
};

export function buildCapabilityResolutionLogLine(
  event: CapabilityResolutionEvent,
): string {
  return JSON.stringify({
    level: 'info',
    message: 'device_capability_resolution',
    capability: event.capabilityName,
    target_preference: event.targetPreferenceKind,
    resolved_device_id: event.resolvedDeviceId,
    resolved_device_type: event.resolvedDeviceType,
    presence: event.presence,
    resolution_status: event.resolutionStatus,
    unavailable_reason: event.unavailableReason,
    capability_resolution_ms: event.capabilityResolutionMs,
    routing_duration_ms: event.routingDurationMs,
    request_id: event.requestId ?? null,
    client_turn_id: event.clientTurnId ?? null,
    turn_id: event.turnId ?? null,
    generation: event.generation ?? null,
  });
}

export type CapabilityExecutionEvent = DeviceEventCorrelation & {
  readonly event: 'capability_execution';
  readonly capabilityName: CapabilityName | null;
  readonly targetDeviceId: string;
  readonly targetDeviceType: string;
  readonly toolName: string;
  readonly executionDurationMs: number;
  readonly authorizationDurationMs: number | null;
  readonly totalActionDurationMs: number | null;
  readonly result: 'ok' | 'error' | 'skipped';
  readonly turnId?: string | null;
  readonly generation?: number | null;
};

export function buildCapabilityExecutionLogLine(event: CapabilityExecutionEvent): string {
  return JSON.stringify({
    level: 'info',
    message: 'device_capability_execution',
    capability: event.capabilityName,
    target_device_id: event.targetDeviceId,
    target_device_type: event.targetDeviceType,
    tool_name: event.toolName,
    execution_duration_ms: event.executionDurationMs,
    authorization_duration_ms: event.authorizationDurationMs,
    total_action_duration_ms: event.totalActionDurationMs,
    result: event.result,
    request_id: event.requestId ?? null,
    client_turn_id: event.clientTurnId ?? null,
    turn_id: event.turnId ?? null,
    generation: event.generation ?? null,
  });
}

// ── BLOCK 6.1: un solo juego de eventos para el pipeline de ejecución ──────
export type ExecutionPipelineEventName =
  | 'execution_target_resolved'
  | 'execution_target_unavailable'
  | 'execution_authorized'
  | 'execution_confirmation_pending'
  | 'execution_confirmation_resolved'
  | 'execution_skipped';

export type ExecutionPipelineEvent = {
  readonly event: ExecutionPipelineEventName;
  readonly toolName: string;
  readonly capabilityName: CapabilityName | null;
  readonly targetDeviceId?: string | null;
  readonly targetDeviceType?: string | null;
  readonly presence?: string | null;
  readonly reason?: string | null;
  readonly decision?: string | null;
  readonly phase?: string | null;
  readonly correlation?: {
    readonly requestId?: string | null;
    readonly clientTurnId?: string | null;
    readonly generation?: number | null;
  };
};

export function buildExecutionPipelineEventLogLine(
  event: ExecutionPipelineEvent,
): string {
  return JSON.stringify({
    level: 'info',
    message: `device_${event.event}`,
    // 'initial' distingue la resolución de la revalidación posterior.
    phase: event.phase ?? null,
    tool_name: event.toolName,
    capability: event.capabilityName,
    target_device_id: event.targetDeviceId ?? null,
    target_device_type: event.targetDeviceType ?? null,
    presence: event.presence ?? null,
    reason: event.reason ?? null,
    decision: event.decision ?? null,
    request_id: event.correlation?.requestId ?? null,
    client_turn_id: event.correlation?.clientTurnId ?? null,
    generation: event.correlation?.generation ?? null,
  });
}

// BLOCK 6.1: una sola línea con los tiempos de la acción, para no duplicar
// resolved/revalidation (que ya emiten su propio evento).
export type CapabilityTimingLogInput = {
  readonly requestId: string | null;
  readonly clientTurnId: string | null;
  readonly generation: number | null | undefined;
  readonly toolName: string;
  readonly capabilityName: CapabilityName | null;
  readonly timing: {
    readonly capabilityResolutionMs: number;
    readonly authorizationMs: number;
    readonly executionMs: number;
  };
  readonly routingMs: number;
  readonly totalActionMs: number;
};

export function buildCapabilityTimingLogLine(input: CapabilityTimingLogInput): string {
  return JSON.stringify({
    level: 'info',
    message: 'device_capability_timing',
    tool_name: input.toolName,
    capability: input.capabilityName,
    routing_duration_ms: input.routingMs,
    capability_resolution_ms: input.timing.capabilityResolutionMs,
    authorization_duration_ms: input.timing.authorizationMs,
    execution_duration_ms: input.timing.executionMs,
    total_action_duration_ms: input.totalActionMs,
    request_id: input.requestId,
    client_turn_id: input.clientTurnId,
    generation: input.generation ?? null,
  });
}
