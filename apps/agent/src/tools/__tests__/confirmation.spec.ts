import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { createFakeApolloEnvironment } from '@/configuration/testing';
import { createInMemoryPendingConfirmationSqlExecutor } from '@/configuration/testing';
import { resolveToolExecution } from '@/tools/execution';
import {
  deletePendingToolConfirmations,
  isPendingConfirmationOrphaned,
  readPendingToolConfirmation,
  savePendingToolConfirmation,
} from '@/tools/pending';
import {
  buildToolDefinitionMap,
  executeToolByName,
  isPendingConfirmationExpired,
  resolvePendingToolConfirmation,
} from '@/tools/router';
import type { JsonSerializableValue, ToolDefinition } from '@/tools/types';

const fakeEnvironment = createFakeApolloEnvironment();

// Reproduce el cierre de app y el sandbox: las tools que el router determinista
// puede pedir y que NO pueden ejecutarse sin confirmacion.
function buildUnsafeTool(
  name: string,
  callList: JsonSerializableValue[],
): ToolDefinition {
  return {
    name,
    safety: 'unsafe',
    description: name,
    parameters: { type: 'object', properties: {} },
    buildConfirmSummary: (args) => {
      const parsedArgumentRecord = z.object({ appName: z.string().min(1) }).parse(args);
      return `Cerrar ${parsedArgumentRecord.appName}`;
    },
    async handler(args) {
      callList.push(args ?? null);
      return { ok: true, summary: `cerrado ${name}` };
    },
  };
}

function buildUnsafeToolWithoutArguments(
  name: string,
  callList: string[],
): ToolDefinition {
  return {
    name,
    safety: 'unsafe',
    description: name,
    parameters: { type: 'object', properties: {} },
    async handler() {
      callList.push(name);
      return { ok: true, summary: `ejecutado ${name}` };
    },
  };
}

describe('unsafe deterministic tool goes through confirmation', () => {
  const closeCallList: JsonSerializableValue[] = [];
  const lockCallList: string[] = [];
  const toolDefinitionMap = buildToolDefinitionMap([
    buildUnsafeTool('close_pc_app', closeCallList),
    buildUnsafeToolWithoutArguments('lock_pc_screen', lockCallList),
  ]);
  const context = {
    environment: fakeEnvironment,
    nowMilliseconds: 1000,
    deviceId: 'device-test',
  };

  it('1. does not execute immediately and 2. creates a confirmation', async () => {
    const outcome = await resolveToolExecution({
      toolName: 'close_pc_app',
      args: { appName: 'chrome' },
      origin: 'deterministic_router',
      toolDefinitionMap,
      context,
      createConfirmationId: () => 'confirm-close',
    });
    expect(outcome.status).toBe('needs_confirm');
    if (outcome.status !== 'needs_confirm') {
      throw new Error('expected needs_confirm');
    }
    expect(closeCallList).toEqual([]);
    expect(outcome.pending.id).toBe('confirm-close');
    expect(outcome.pending.toolName).toBe('close_pc_app');
    expect(outcome.pending.args).toEqual({ appName: 'chrome' });
    expect(outcome.pending.expiresAt).toBe(31_000);
  });

  it('3. executes exactly once after approval', async () => {
    const outcome = await resolveToolExecution({
      toolName: 'close_pc_app',
      args: { appName: 'chrome' },
      origin: 'deterministic_router',
      toolDefinitionMap,
      context,
      createConfirmationId: () => 'confirm-close',
    });
    if (outcome.status !== 'needs_confirm') {
      throw new Error('expected needs_confirm');
    }
    const resolved = await resolvePendingToolConfirmation(
      toolDefinitionMap,
      outcome.pending,
      true,
      { ...context, nowMilliseconds: 2000 },
    );
    expect(resolved).toMatchObject({ ok: true });
    expect(closeCallList).toEqual([{ appName: 'chrome' }]);
  });

  it('4. does not execute when rejected', async () => {
    const outcome = await resolveToolExecution({
      toolName: 'close_pc_app',
      args: { appName: 'firefox' },
      origin: 'deterministic_router',
      toolDefinitionMap,
      context,
      createConfirmationId: () => 'confirm-reject',
    });
    if (outcome.status !== 'needs_confirm') {
      throw new Error('expected needs_confirm');
    }
    const resolved = await resolvePendingToolConfirmation(
      toolDefinitionMap,
      outcome.pending,
      false,
      { ...context, nowMilliseconds: 2000 },
    );
    expect(resolved).toEqual({ cancelled: true, reason: 'rejected' });
    expect(closeCallList).toEqual([{ appName: 'chrome' }]);
  });

  it('5. does not execute when expired', async () => {
    const outcome = await resolveToolExecution({
      toolName: 'close_pc_app',
      args: { appName: 'edge' },
      origin: 'deterministic_router',
      toolDefinitionMap,
      context,
      createConfirmationId: () => 'confirm-expire',
    });
    if (outcome.status !== 'needs_confirm') {
      throw new Error('expected needs_confirm');
    }
    expect(isPendingConfirmationExpired(outcome.pending, outcome.pending.expiresAt)).toBe(
      true,
    );
    const resolved = await resolvePendingToolConfirmation(
      toolDefinitionMap,
      outcome.pending,
      true,
      { ...context, nowMilliseconds: outcome.pending.expiresAt },
    );
    expect(resolved).toEqual({ cancelled: true, reason: 'expired' });
    expect(closeCallList).toEqual([{ appName: 'chrome' }]);
  });

  it('6. a duplicate confirmation cannot execute twice', async () => {
    const sqlExecutor = createInMemoryPendingConfirmationSqlExecutor();
    const outcome = await resolveToolExecution({
      toolName: 'close_pc_app',
      args: { appName: 'brave' },
      origin: 'deterministic_router',
      toolDefinitionMap,
      context,
      createConfirmationId: () => 'confirm-duplicate',
    });
    if (outcome.status !== 'needs_confirm') {
      throw new Error('expected needs_confirm');
    }
    await savePendingToolConfirmation(sqlExecutor, outcome.pending);

    // First answer: the row is consumed before the tool runs (#resolveConfirm).
    const storedConfirmation = await readPendingToolConfirmation(sqlExecutor);
    if (storedConfirmation === undefined) {
      throw new Error('expected a stored confirmation');
    }
    await deletePendingToolConfirmations(sqlExecutor);
    const firstResolution = await resolvePendingToolConfirmation(
      toolDefinitionMap,
      storedConfirmation,
      true,
      { ...context, nowMilliseconds: 2000 },
    );
    expect(firstResolution).toMatchObject({ ok: true });

    // Second answer (device retry / double tap): nothing left to restore, so the
    // turn can never reach the tool again.
    const secondStoredConfirmation = await readPendingToolConfirmation(sqlExecutor);
    expect(secondStoredConfirmation).toBeUndefined();
    expect(
      isPendingConfirmationOrphaned({
        restoredConfirmation: secondStoredConfirmation,
        pendingConfirmIdInState: 'confirm-duplicate',
      }),
    ).toBe(true);
    expect(closeCallList).toEqual([{ appName: 'chrome' }, { appName: 'brave' }]);
  });

  it('gates lock_pc_screen the same way', async () => {
    const outcome = await executeToolByName(
      toolDefinitionMap,
      'lock_pc_screen',
      undefined,
      context,
      () => 'confirm-lock',
      'deterministic_router',
    );
    expect(outcome.status).toBe('needs_confirm');
    expect(lockCallList).toEqual([]);
  });
});
