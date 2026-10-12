import {
  CONFIRM_TIMEOUT_MILLISECONDS,
  type JsonSerializableValue,
  type PendingToolConfirmation,
  type ToolDefinition,
  type ToolExecutionContext,
  type ToolExecutionResult,
} from '@/tools/types';

// Única ruta de ejecución de tools del Worker: routing → selección →
// autorización → ejecución. El handler de una tool solo se invoca desde
// `executeAuthorizedTool`, así que ninguna ruta (LLM, router determinista,
//Gemini Live, MCP) puede esquivar safety/confirmation.

export type ToolExecutionOrigin = 'llm' | 'deterministic_router';

export type ToolAuthorizationOutcome =
  | { readonly status: 'authorized'; readonly toolDefinition: ToolDefinition }
  | { readonly status: 'needs_confirm'; readonly pending: PendingToolConfirmation }
  | { readonly status: 'refused'; readonly result: ToolExecutionResult };

export type ToolExecutionOutcome =
  | { readonly status: 'done'; readonly result: ToolExecutionResult }
  | { readonly status: 'needs_confirm'; readonly pending: PendingToolConfirmation };

// El target es un dato de la confirmación, no una decisión de seguridad: lo
// elige el registry antes y viaja hasta la aprobación para poder revalidarlo.
export type ToolExecutionTarget = {
  readonly deviceId: string;
  readonly deviceType: string;
};

export type ToolExecutionRequest = {
  readonly toolName: string;
  readonly args: JsonSerializableValue | undefined;
  readonly origin: ToolExecutionOrigin;
  readonly toolDefinitionMap: ReadonlyMap<string, ToolDefinition>;
  readonly context: ToolExecutionContext;
  readonly createConfirmationId?: () => string;
  readonly target?: ToolExecutionTarget;
};

export function authorizeToolExecution(
  request: ToolExecutionRequest,
): ToolAuthorizationOutcome {
  const toolDefinition = request.toolDefinitionMap.get(request.toolName);
  if (toolDefinition === undefined) {
    return {
      status: 'refused',
      result: { ok: false, summary: `Herramienta desconocida: ${request.toolName}` },
    };
  }

  if (toolDefinition.safety !== 'unsafe') {
    return { status: 'authorized', toolDefinition };
  }

  // Building the summary is also the gate on the arguments: it parses them
  // with the tool's own schema, so no confirmation is ever created — or
  // persisted, or shown to the user — for a call that could not run. Letting
  // the parse failure escape would fail the whole turn; the model sending
  // arguments a tool cannot accept is an ordinary tool error it can retry.
  let summary: string;
  try {
    summary =
      toolDefinition.buildConfirmSummary?.(request.args) ??
      `Confirmar ${request.toolName}`;
  } catch {
    return {
      status: 'refused',
      result: {
        ok: false,
        summary: `No pude preparar la confirmación de ${request.toolName}: argumentos inválidos`,
      },
    };
  }

  return {
    status: 'needs_confirm',
    pending: {
      id: (request.createConfirmationId ?? (() => crypto.randomUUID()))(),
      toolName: request.toolName,
      args: request.args,
      summary,
      expiresAt: request.context.nowMilliseconds + CONFIRM_TIMEOUT_MILLISECONDS,
      ...(request.target === undefined
        ? {}
        : {
            targetDeviceId: request.target.deviceId,
            targetDeviceType: request.target.deviceType,
          }),
    },
  };
}

export async function executeAuthorizedTool(input: {
  readonly toolName: string;
  readonly args: JsonSerializableValue | undefined;
  readonly toolDefinitionMap: ReadonlyMap<string, ToolDefinition>;
  readonly context: ToolExecutionContext;
}): Promise<ToolExecutionResult> {
  const toolDefinition = input.toolDefinitionMap.get(input.toolName);
  if (toolDefinition === undefined) {
    return { ok: false, summary: `Herramienta desconocida: ${input.toolName}` };
  }
  return toolDefinition.handler(input.args, input.context);
}

export async function resolveToolExecution(
  request: ToolExecutionRequest,
): Promise<ToolExecutionOutcome> {
  const authorization = authorizeToolExecution(request);
  if (authorization.status === 'needs_confirm') {
    return { status: 'needs_confirm', pending: authorization.pending };
  }
  if (authorization.status === 'refused') {
    return { status: 'done', result: authorization.result };
  }
  const result = await executeAuthorizedTool({
    toolName: request.toolName,
    args: request.args,
    toolDefinitionMap: request.toolDefinitionMap,
    context: request.context,
  });
  return { status: 'done', result };
}
