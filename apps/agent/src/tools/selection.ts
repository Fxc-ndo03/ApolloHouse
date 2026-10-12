import type { JsonSerializableValue } from '@/tools/types';
import type { RouterOutcome } from '@/voice/router';

// Paso 2 del pipeline: el router decide la INTENCIÓN (qué pidió el usuario),
// esta tabla decide la TOOL. La autorización es un paso aparte: elegir una tool
// no significa que esté autorizada.

const ROUTER_COMMAND_TOOL_NAME_MAP: ReadonlyMap<string, string> = new Map([
  ['apps_open', 'open_pc_app'],
  ['apps_close', 'close_pc_app'],
  ['apps_focus', 'focus_pc_app'],
  ['lock_screen', 'lock_pc_screen'],
  ['spotify_play', 'spotify_play'],
  ['spotify_pause', 'spotify_pause'],
  ['spotify_next', 'spotify_next'],
  ['spotify_previous', 'spotify_previous'],
]);

// BLOCK 11 §12: la tool mobile que corresponde a cada commandType del router
// mobile. Igual que el mapa de PC: el router decide intención, esta tabla decide
// tool, y `devices/intent.ts` decide capability + target. Los tres son datos.
const ROUTER_MOBILE_COMMAND_TO_TOOL_NAME_MAP: ReadonlyMap<string, string> = new Map([
  ['notification_post', 'send_mobile_notification'],
  ['alarm_set', 'set_mobile_alarm'],
  ['calendar_create', 'create_mobile_calendar_event'],
  ['media_play', 'play_mobile_media'],
  ['volume_set', 'set_mobile_volume'],
  ['app_open', 'open_mobile_app'],
]);

const MEMORY_WRITE_TOOL_NAME = 'remember_fact';

export type SelectedToolRequest = {
  readonly toolName: string;
  readonly args: JsonSerializableValue | undefined;
};

export function mapRouterCommandToToolName(commandType: string): string {
  return ROUTER_COMMAND_TOOL_NAME_MAP.get(commandType) ?? commandType;
}

export function selectRouterToolRequest(
  routerOutcome: Extract<
    RouterOutcome,
    { kind: 'pc_command' | 'mobile_command' | 'memory_write' }
  >,
): SelectedToolRequest {
  if (routerOutcome.kind === 'memory_write') {
    return { toolName: MEMORY_WRITE_TOOL_NAME, args: { content: routerOutcome.fact } };
  }
  if (routerOutcome.kind === 'mobile_command') {
    const toolName = ROUTER_MOBILE_COMMAND_TO_TOOL_NAME_MAP.get(
      routerOutcome.commandType,
    );
    if (toolName === undefined) {
      throw new Error(`Comando mobile sin tool: ${routerOutcome.commandType}`);
    }
    return { toolName, args: routerOutcome.args };
  }
  return {
    toolName: mapRouterCommandToToolName(routerOutcome.commandType),
    args: routerOutcome.args,
  };
}

export function listRouterReachableToolNameList(): readonly string[] {
  return [
    ...ROUTER_COMMAND_TOOL_NAME_MAP.values(),
    ...ROUTER_MOBILE_COMMAND_TO_TOOL_NAME_MAP.values(),
    MEMORY_WRITE_TOOL_NAME,
  ];
}
