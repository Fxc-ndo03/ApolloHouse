import { describe, expect, it, mock } from 'bun:test';

import { createFakeApolloEnvironment } from '@/configuration/testing';
import { braveSearchTool, listPcToolDefinitionList } from '@/tools/pc';
import type { ToolExecutionContext } from '@/tools/types';

type CapturedPcCommand = {
  commandType: string;
  extra: unknown;
};

const capturedPcCommandList: CapturedPcCommand[] = [];
let nextCommandResult: unknown = { ok: true };

mock.module('agents', () => ({
  getAgentByName: (_namespace: unknown, _name: string) => ({
    sendCommand: async (commandType: string, extra: unknown) => {
      capturedPcCommandList.push({ commandType, extra });
      return nextCommandResult;
    },
  }),
}));

const fakeContext: ToolExecutionContext = {
  environment: createFakeApolloEnvironment(),
  nowMilliseconds: 1000,
};

describe('brave_search', () => {
  it('opens Brave with the encoded search URL', async () => {
    capturedPcCommandList.length = 0;
    nextCommandResult = { ok: true };

    const result = await braveSearchTool.handler(
      { query: 'clima en Rosario' },
      fakeContext,
    );

    expect(capturedPcCommandList).toEqual([
      {
        commandType: 'apps_open',
        extra: {
          appName: 'brave',
          args: 'https://search.brave.com/search?q=clima%20en%20Rosario',
        },
      },
    ]);
    expect(result.ok).toBe(true);
    expect(result.summary).toContain('clima en Rosario');
  });

  it('fails with a clear message when Brave is missing', async () => {
    capturedPcCommandList.length = 0;
    nextCommandResult = { ok: false, error: 'Start-Process: no se encontró brave' };

    const result = await braveSearchTool.handler({ query: 'gatos' }, fakeContext);

    expect(result.ok).toBe(false);
    expect(result.summary).toContain('Brave');
    expect(result.summary).toContain('instalado');
  });

  it('rejects an empty query', async () => {
    await expect(braveSearchTool.handler({ query: '' }, fakeContext)).rejects.toThrow();
  });
});

describe('listPcToolDefinitionList', () => {
  it('includes brave_search', () => {
    const toolNameList = listPcToolDefinitionList().map((tool) => tool.name);
    expect(toolNameList).toContain('brave_search');
    expect(toolNameList).toContain('open_pc_app');
  });
});
