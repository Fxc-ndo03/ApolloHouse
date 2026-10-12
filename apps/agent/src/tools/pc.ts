import { z } from 'zod';

import { buildCapabilityExecutionTarget } from '@/tools/execution-target';
import type {
  JsonSerializableValue,
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutionResult,
} from '@/tools/types';

const openAppArgsSchema = z.object({
  appName: z.string().min(1),
  args: z.string().optional(),
});

const appNameArgsSchema = z.object({
  appName: z.string().min(1),
});

const emptyArgsSchema = z.object({});

const braveSearchArgsSchema = z.object({
  query: z.string().min(1),
});

type PcBridgeCommandType =
  | 'apps_open'
  | 'apps_focus'
  | 'apps_close'
  | 'lock_screen'
  | 'apps_list'
  | 'spotify_play'
  | 'spotify_pause'
  | 'spotify_next'
  | 'spotify_previous'
  | 'spotify_get_state';

function readPcBridgeErrorDetail(rawResult: unknown): string | null {
  if (typeof rawResult !== 'object' || rawResult === null) {
    return null;
  }
  if (!('ok' in rawResult) || rawResult.ok !== false) {
    return null;
  }
  if (
    'error' in rawResult &&
    typeof rawResult.error === 'string' &&
    rawResult.error.length > 0
  ) {
    return rawResult.error;
  }
  return 'La PC reportó un error.';
}

async function callPcBridge(
  context: ToolExecutionContext,
  commandType: PcBridgeCommandType,
  extra: Record<string, JsonSerializableValue>,
  successSummary: string,
): Promise<ToolExecutionResult> {
  let rawResult: unknown;
  try {
    const { getAgentByName } = await import('agents');
    const pcBridge = await getAgentByName(context.environment.PcBridge, 'pc-bridge');
    rawResult = await pcBridge.sendCommand(commandType, extra);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, summary: `La PC no respondió (${detail}).` };
  }
  const errorDetail = readPcBridgeErrorDetail(rawResult);
  if (errorDetail !== null) {
    return { ok: false, summary: errorDetail };
  }
  return { ok: true, summary: successSummary, data: rawResult };
}

export const openPcAppTool: ToolDefinition = {
  executionTarget: buildCapabilityExecutionTarget('desktop.open_app'),
  name: 'open_pc_app',
  safety: 'safe',
  description:
    'Abre una aplicación en la PC principal (Windows). Usa esto cuando el usuario pida abrir programas como Chrome, Spotify, VS Code, etc. Acepta nombres en español ("bloc de notas", "navegador", "calculadora") o el ejecutable ("notepad", "msedge", "calc").',
  parameters: {
    type: 'object',
    properties: {
      appName: {
        type: 'string',
        description:
          'Nombre de la aplicación, en español o inglés (ej: "bloc de notas", "navegador", "notepad", "spotify")',
      },
      args: {
        type: 'string',
        description:
          'Argumentos opcionales para la aplicación (ej: una URL para el navegador)',
      },
    },
    required: ['appName'],
  },
  async handler(args, context) {
    const parsedArgs = openAppArgsSchema.parse(args);
    return callPcBridge(
      context,
      'apps_open',
      { appName: parsedArgs.appName, args: parsedArgs.args ?? '' },
      `Abriendo ${parsedArgs.appName}.`,
    );
  },
};

export const focusPcAppTool: ToolDefinition = {
  executionTarget: buildCapabilityExecutionTarget('desktop.focus_app'),
  name: 'focus_pc_app',
  safety: 'safe',
  description: 'Enfoca (trae al frente) una aplicación ya abierta en la PC principal.',
  parameters: {
    type: 'object',
    properties: {
      appName: { type: 'string', description: 'Nombre de la aplicación a enfocar' },
    },
    required: ['appName'],
  },
  async handler(args, context) {
    const parsedArgs = appNameArgsSchema.parse(args);
    return callPcBridge(
      context,
      'apps_focus',
      { appName: parsedArgs.appName },
      `Enfocando ${parsedArgs.appName}.`,
    );
  },
};

export const closePcAppTool: ToolDefinition = {
  executionTarget: buildCapabilityExecutionTarget('desktop.close_app'),
  name: 'close_pc_app',
  safety: 'unsafe',
  description: 'Cierra una aplicación en la PC principal.',
  parameters: {
    type: 'object',
    properties: {
      appName: { type: 'string', description: 'Nombre de la aplicación a cerrar' },
    },
    required: ['appName'],
  },
  buildConfirmSummary: (args) => {
    const parsedArgs = appNameArgsSchema.parse(args);
    return `Cerrar ${parsedArgs.appName} en la PC`;
  },
  async handler(args, context) {
    const parsedArgs = appNameArgsSchema.parse(args);
    return callPcBridge(
      context,
      'apps_close',
      { appName: parsedArgs.appName },
      `Cerrando ${parsedArgs.appName}.`,
    );
  },
};

export const lockPcScreenTool: ToolDefinition = {
  executionTarget: buildCapabilityExecutionTarget('desktop.lock'),
  name: 'lock_pc_screen',
  safety: 'unsafe',
  description: 'Bloquea la pantalla de la PC principal (Win+L).',
  parameters: {
    type: 'object',
    properties: {},
  },
  buildConfirmSummary: () => 'Bloquear la pantalla de la PC',
  async handler(args, context) {
    emptyArgsSchema.parse(args);
    return callPcBridge(context, 'lock_screen', {}, 'Bloqueando la pantalla.');
  },
};

export const listPcAppsTool: ToolDefinition = {
  executionTarget: buildCapabilityExecutionTarget('desktop.list_apps'),
  name: 'list_pc_apps',
  safety: 'safe',
  description: 'Lista las aplicaciones en ejecución en la PC principal.',
  parameters: {
    type: 'object',
    properties: {},
  },
  async handler(args, context) {
    emptyArgsSchema.parse(args);
    return callPcBridge(context, 'apps_list', {}, 'Aplicaciones listadas.');
  },
};

export const spotifyPlayTool: ToolDefinition = {
  executionTarget: buildCapabilityExecutionTarget('desktop.spotify'),
  name: 'spotify_play',
  safety: 'safe',
  description: 'Reproduce/pausa Spotify en la PC principal.',
  parameters: {
    type: 'object',
    properties: {},
  },
  async handler(args, context) {
    emptyArgsSchema.parse(args);
    return callPcBridge(context, 'spotify_play', {}, 'Spotify: reproducir/pausar.');
  },
};

export const spotifyPauseTool: ToolDefinition = {
  executionTarget: buildCapabilityExecutionTarget('desktop.spotify'),
  name: 'spotify_pause',
  safety: 'safe',
  description: 'Pausa Spotify en la PC principal.',
  parameters: {
    type: 'object',
    properties: {},
  },
  async handler(args, context) {
    emptyArgsSchema.parse(args);
    return callPcBridge(context, 'spotify_pause', {}, 'Spotify en pausa.');
  },
};

export const spotifyNextTool: ToolDefinition = {
  executionTarget: buildCapabilityExecutionTarget('desktop.spotify'),
  name: 'spotify_next',
  safety: 'safe',
  description: 'Pista siguiente en Spotify.',
  parameters: {
    type: 'object',
    properties: {},
  },
  async handler(args, context) {
    emptyArgsSchema.parse(args);
    return callPcBridge(context, 'spotify_next', {}, 'Spotify: siguiente pista.');
  },
};

export const spotifyPreviousTool: ToolDefinition = {
  executionTarget: buildCapabilityExecutionTarget('desktop.spotify'),
  name: 'spotify_previous',
  safety: 'safe',
  description: 'Pista anterior en Spotify.',
  parameters: {
    type: 'object',
    properties: {},
  },
  async handler(args, context) {
    emptyArgsSchema.parse(args);
    return callPcBridge(context, 'spotify_previous', {}, 'Spotify: pista anterior.');
  },
};

export const spotifyGetStateTool: ToolDefinition = {
  executionTarget: buildCapabilityExecutionTarget('desktop.spotify'),
  name: 'spotify_get_state',
  safety: 'safe',
  description: 'Obtiene el estado actual de Spotify (pista, artista, reproduciendo).',
  parameters: {
    type: 'object',
    properties: {},
  },
  async handler(args, context) {
    emptyArgsSchema.parse(args);
    return callPcBridge(context, 'spotify_get_state', {}, 'Estado de Spotify obtenido.');
  },
};

export const braveSearchTool: ToolDefinition = {
  executionTarget: buildCapabilityExecutionTarget('desktop.brave_search'),
  name: 'brave_search',
  safety: 'safe',
  description:
    'Busca en internet y abre los resultados en el navegador Brave de la PC. Usá esta tool cuando el usuario diga "buscar", "busca", "navegador" o mencione Brave. Arma la URL search.brave.com y la abre con brave.exe.',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Texto a buscar (lo que sigue a "buscar" o "navegador")',
      },
    },
    required: ['query'],
  },
  async handler(args, context) {
    const parsedArgs = braveSearchArgsSchema.parse(args);
    const searchUrl = `https://search.brave.com/search?q=${encodeURIComponent(parsedArgs.query)}`;
    const result = await callPcBridge(
      context,
      'apps_open',
      { appName: 'brave', args: searchUrl },
      `Buscando "${parsedArgs.query}" en Brave.`,
    );
    if (!result.ok) {
      return {
        ok: false,
        summary: `No pude abrir Brave (${result.summary}). ¿Está instalado Brave en la PC?`,
      };
    }
    return result;
  },
};

export function listPcToolDefinitionList(): readonly ToolDefinition[] {
  return [
    openPcAppTool,
    focusPcAppTool,
    closePcAppTool,
    lockPcScreenTool,
    listPcAppsTool,
    spotifyPlayTool,
    spotifyPauseTool,
    spotifyNextTool,
    spotifyPreviousTool,
    spotifyGetStateTool,
    braveSearchTool,
  ];
}
