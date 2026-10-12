import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { createFakeApolloEnvironment } from '@/configuration/testing';
import {
  authorizeToolExecution,
  executeAuthorizedTool,
  resolveToolExecution,
} from '@/tools/execution';
import { buildToolDefinitionMap } from '@/tools/router';
import type { JsonSerializableValue, ToolDefinition } from '@/tools/types';

const fakeEnvironment = createFakeApolloEnvironment();
const executionContext = {
  environment: fakeEnvironment,
  nowMilliseconds: 1000,
  deviceId: 'device-test',
};

function buildCountingTool(input: {
  readonly name: string;
  readonly safety: 'safe' | 'unsafe';
  readonly argumentSchema?: z.ZodType<Record<string, string>>;
}): { readonly tool: ToolDefinition; readonly callList: JsonSerializableValue[] } {
  const callList: JsonSerializableValue[] = [];
  const tool: ToolDefinition = {
    name: input.name,
    safety: input.safety,
    description: input.name,
    parameters: { type: 'object', properties: {} },
    ...(input.argumentSchema === undefined
      ? {}
      : {
          buildConfirmSummary: (args) => {
            const parsedArgumentRecord = input.argumentSchema?.parse(args) ?? {};
            return `Confirmar ${Object.values(parsedArgumentRecord).join(' ')}`;
          },
        }),
    async handler(args) {
      callList.push(args ?? null);
      return { ok: true, summary: `ejecutado ${input.name}` };
    },
  };
  return { tool, callList };
}

const safeToolBundle = buildCountingTool({ name: 'open_pc_app', safety: 'safe' });
const unsafeToolBundle = buildCountingTool({
  name: 'close_pc_app',
  safety: 'unsafe',
  argumentSchema: z.object({ appName: z.string().min(1) }),
});
const otherUnsafeToolBundle = buildCountingTool({
  name: 'lock_pc_screen',
  safety: 'unsafe',
  argumentSchema: z.object({ appName: z.string().min(1) }),
});
const strictUnsafeToolBundle = buildCountingTool({
  name: 'sandbox_run_code',
  safety: 'unsafe',
  argumentSchema: z.object({ code: z.string().min(1) }),
});

const toolDefinitionMap = buildToolDefinitionMap([
  safeToolBundle.tool,
  unsafeToolBundle.tool,
  otherUnsafeToolBundle.tool,
  strictUnsafeToolBundle.tool,
]);

describe('central tool execution route', () => {
  it('executes a safe tool without confirmation (deterministic origin)', async () => {
    const outcome = await resolveToolExecution({
      toolName: 'open_pc_app',
      args: { appName: 'chrome' },
      origin: 'deterministic_router',
      toolDefinitionMap,
      context: executionContext,
    });
    expect(outcome.status).toBe('done');
    expect(safeToolBundle.callList).toEqual([{ appName: 'chrome' }]);
  });

  it('never executes an unsafe tool: it returns needs_confirm instead', async () => {
    const outcome = await resolveToolExecution({
      toolName: 'close_pc_app',
      args: { appName: 'chrome' },
      origin: 'deterministic_router',
      toolDefinitionMap,
      context: executionContext,
      createConfirmationId: () => 'confirm-close',
    });
    expect(outcome.status).toBe('needs_confirm');
    if (outcome.status === 'needs_confirm') {
      expect(outcome.pending.toolName).toBe('close_pc_app');
      expect(outcome.pending.summary).toBe('Confirmar chrome');
      expect(outcome.pending.expiresAt).toBe(31_000);
    }
    expect(unsafeToolBundle.callList).toEqual([]);
  });

  it('gates every unsafe tool the router can reach, not just one', async () => {
    for (const [toolName, callList] of [
      ['close_pc_app', unsafeToolBundle.callList],
      ['lock_pc_screen', otherUnsafeToolBundle.callList],
      ['sandbox_run_code', strictUnsafeToolBundle.callList],
    ] as const) {
      const outcome = await resolveToolExecution({
        toolName,
        args:
          toolName === 'sandbox_run_code' ? { code: 'rm -rf /' } : { appName: 'chrome' },
        origin: 'deterministic_router',
        toolDefinitionMap,
        context: executionContext,
      });
      expect(outcome.status).toBe('needs_confirm');
      expect(callList).toEqual([]);
    }
  });

  it('refuses invalid unsafe arguments without opening a confirmation', async () => {
    const outcome = await resolveToolExecution({
      toolName: 'close_pc_app',
      args: { appName: '' },
      origin: 'deterministic_router',
      toolDefinitionMap,
      context: executionContext,
    });
    expect(outcome.status).toBe('done');
    if (outcome.status === 'done') {
      expect(outcome.result.ok).toBe(false);
      expect(outcome.result.summary).toContain('argumentos inválidos');
    }
    expect(unsafeToolBundle.callList).toEqual([]);
  });

  it('refuses an unknown tool name without throwing', async () => {
    const outcome = await resolveToolExecution({
      toolName: 'no_existe',
      args: undefined,
      origin: 'deterministic_router',
      toolDefinitionMap,
      context: executionContext,
    });
    expect(outcome.status).toBe('done');
    if (outcome.status === 'done') {
      expect(outcome.result.summary).toContain('Herramienta desconocida');
    }
  });
});

describe('authorization is independent from the caller', () => {
  it('authorizes identically for the llm and the deterministic router', () => {
    const forLlm = authorizeToolExecution({
      toolName: 'close_pc_app',
      args: { appName: 'chrome' },
      origin: 'llm',
      toolDefinitionMap,
      context: executionContext,
      createConfirmationId: () => 'same-id',
    });
    const forRouter = authorizeToolExecution({
      toolName: 'close_pc_app',
      args: { appName: 'chrome' },
      origin: 'deterministic_router',
      toolDefinitionMap,
      context: executionContext,
      createConfirmationId: () => 'same-id',
    });
    expect(forLlm).toEqual(forRouter);
    expect(forRouter.status).toBe('needs_confirm');
  });

  it('executes exactly once after an explicit authorization', async () => {
    const authorization = authorizeToolExecution({
      toolName: 'close_pc_app',
      args: { appName: 'chrome' },
      origin: 'deterministic_router',
      toolDefinitionMap,
      context: executionContext,
    });
    expect(authorization.status).toBe('needs_confirm');
    const result = await executeAuthorizedTool({
      toolName: 'close_pc_app',
      args: { appName: 'chrome' },
      toolDefinitionMap,
      context: executionContext,
    });
    expect(result.ok).toBe(true);
    expect(unsafeToolBundle.callList).toEqual([{ appName: 'chrome' }]);
  });
});
