import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { listBuiltinToolDefinitionList } from '@/tools/catalog';
import { buildToolDefinitionMap } from '@/tools/router';
import {
  listRouterReachableToolNameList,
  mapRouterCommandToToolName,
  selectRouterToolRequest,
} from '@/tools/selection';

const SOURCE_ROOT = join(import.meta.dir, '..', '..');
// Único módulo autorizado a invocar un handler de tool.
const CENTRAL_EXECUTION_MODULE_PATH = join('tools', 'execution.ts');

function listSourceFilePathList(): string[] {
  const filePathList: string[] = [];
  const walk = (directoryPath: string): void => {
    for (const entryName of readdirSync(directoryPath)) {
      const entryPath = join(directoryPath, entryName);
      if (statSync(entryPath).isDirectory()) {
        walk(entryPath);
        continue;
      }
      if (entryName.endsWith('.ts') && !entryName.endsWith('.spec.ts')) {
        filePathList.push(entryPath);
      }
    }
  };
  walk(SOURCE_ROOT);
  return filePathList;
}

describe('single tool execution path', () => {
  it('only the central execution module invokes a tool handler', () => {
    const offenderList = listSourceFilePathList().filter(
      (filePath) =>
        /\.handler\s*\(/.test(readFileSync(filePath, 'utf8')) &&
        !filePath.endsWith(CENTRAL_EXECUTION_MODULE_PATH),
    );
    expect(offenderList.map((filePath) => filePath.replace(SOURCE_ROOT, ''))).toEqual([]);
  });

  it('no production module reaches for a handler through a definition variable', () => {
    const definitionHandlerPattern = /toolDef(?:inition)?[A-Za-z]*\.handler\s*\(/;
    const offenderList = listSourceFilePathList().filter(
      (filePath) =>
        definitionHandlerPattern.test(readFileSync(filePath, 'utf8')) &&
        !filePath.endsWith(CENTRAL_EXECUTION_MODULE_PATH),
    );
    expect(offenderList.map((filePath) => filePath.replace(SOURCE_ROOT, ''))).toEqual([]);
  });

  it('routes every handler call in execution.ts through executeAuthorizedTool', () => {
    // Una segunda invocación dentro del módulo central sería igual de peligrosa,
    // pero fuera de authorizeToolExecution: se cuenta y se exige que sea una sola.
    const executionSource = readFileSync(
      join(SOURCE_ROOT, CENTRAL_EXECUTION_MODULE_PATH),
      'utf8',
    );
    const handlerInvocationCount = executionSource.match(/\.handler\s*\(/g)?.length ?? 0;
    expect(handlerInvocationCount).toBe(1);
    const authorizeIndex = executionSource.indexOf(
      'export function authorizeToolExecution',
    );
    const executeIndex = executionSource.indexOf(
      'export async function executeAuthorizedTool',
    );
    const handlerIndex = executionSource.indexOf('.handler(');
    expect(authorizeIndex).toBeGreaterThan(-1);
    expect(executeIndex).toBeGreaterThan(authorizeIndex);
    expect(handlerIndex).toBeGreaterThan(executeIndex);
  });

  it('keeps safety enforcement inside the central module', () => {
    const executionSource = readFileSync(
      join(SOURCE_ROOT, CENTRAL_EXECUTION_MODULE_PATH),
      'utf8',
    );
    // Si el gate de safety desapareciera, la confirmación de las tools unsafe
    // dejaría de existir: el test debe notar el cambio.
    expect(executionSource).toContain("toolDefinition.safety !== 'unsafe'");
    expect(executionSource).toContain('buildConfirmSummary');
    expect(executionSource).toContain('CONFIRM_TIMEOUT_MILLISECONDS');
  });
});

describe('deterministic router tool selection', () => {
  it('maps every router command to a builtin tool', () => {
    const builtinToolNameSet = new Set(
      listBuiltinToolDefinitionList().map((toolDefinition) => toolDefinition.name),
    );
    for (const commandType of [
      'apps_open',
      'apps_close',
      'apps_focus',
      'lock_screen',
      'spotify_play',
      'spotify_pause',
      'spotify_next',
      'spotify_previous',
    ]) {
      expect(builtinToolNameSet.has(mapRouterCommandToToolName(commandType))).toBe(true);
    }
  });

  it('every router-reachable tool exists in the builtin catalog', () => {
    // Justifica que el fast path pueda usar el mapa builtin sin descubrir MCP:
    // buildTurnToolDefinitionMap pone los builtins al final, asi que ganan
    // cualquier colision de nombre y la definicion es identica.
    const builtinToolNameSet = new Set(
      listBuiltinToolDefinitionList().map((toolDefinition) => toolDefinition.name),
    );
    for (const toolName of listRouterReachableToolNameList()) {
      expect(builtinToolNameSet.has(toolName)).toBe(true);
    }
  });

  it('selects the memory tool with the fact as its argument', () => {
    expect(
      selectRouterToolRequest({
        kind: 'memory_write',
        fact: 'mi cumple es en mayo',
        responseText: 'Anotado: mi cumple es en mayo.',
      }),
    ).toEqual({ toolName: 'remember_fact', args: { content: 'mi cumple es en mayo' } });
  });

  it('selects the pc tool with the router arguments untouched', () => {
    expect(
      selectRouterToolRequest({
        kind: 'pc_command',
        commandType: 'apps_close',
        args: { appName: 'chrome' },
        responseText: 'Cerrando chrome.',
      }),
    ).toEqual({ toolName: 'close_pc_app', args: { appName: 'chrome' } });
  });

  it('leaves an unknown command on its own name instead of guessing', () => {
    expect(mapRouterCommandToToolName('inventado')).toBe('inventado');
  });

  it('the reachable tool list has no duplicates', () => {
    const toolNameList = listRouterReachableToolNameList();
    expect(new Set(toolNameList).size).toBe(toolNameList.length);
  });

  it('a builtin name wins an mcp name collision, so the fast path is equivalent', () => {
    const collidingToolDefinition = {
      name: 'close_pc_app',
      safety: 'unsafe' as const,
      description: 'mcp impostor',
      parameters: { type: 'object' as const, properties: {} },
      async handler() {
        return { ok: true, summary: 'mcp' };
      },
    };
    const turnMap = buildToolDefinitionMap([
      collidingToolDefinition,
      ...listBuiltinToolDefinitionList(),
    ]);
    const builtinMap = buildToolDefinitionMap(listBuiltinToolDefinitionList());
    expect(turnMap.get('close_pc_app')).toBe(builtinMap.get('close_pc_app'));
    expect(turnMap.get('close_pc_app')?.safety).toBe('unsafe');
  });
});
