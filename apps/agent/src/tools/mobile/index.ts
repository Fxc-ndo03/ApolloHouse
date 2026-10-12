import { setMobileAlarmTool, cancelMobileAlarmTool } from '@/tools/mobile/alarm';
import {
  createMobileCalendarEventTool,
  listMobileCalendarEventsTool,
  cancelMobileCalendarEventTool,
} from '@/tools/mobile/calendar';
import {
  nextMobileMediaTool,
  pauseMobileMediaTool,
  playMobileMediaTool,
  previousMobileMediaTool,
} from '@/tools/mobile/media';
import { sendMobileNotificationTool } from '@/tools/mobile/notification';
import { openMobileAppTool } from '@/tools/mobile/open';
import { getMobileVolumeTool, setMobileVolumeTool } from '@/tools/mobile/volume';
import type { ToolDefinition } from '@/tools/types';

// Catálogo mobile (BLOCK 11 §3). El orden es estable a propósito: las pruebas y
// el filtro de dominio dependen de nombres, no de posiciones, pero un orden
// estable hace los diffs legibles.
export function listMobileToolDefinitionList(): readonly ToolDefinition[] {
  return [
    sendMobileNotificationTool,
    setMobileAlarmTool,
    cancelMobileAlarmTool,
    createMobileCalendarEventTool,
    listMobileCalendarEventsTool,
    cancelMobileCalendarEventTool,
    playMobileMediaTool,
    pauseMobileMediaTool,
    nextMobileMediaTool,
    previousMobileMediaTool,
    setMobileVolumeTool,
    getMobileVolumeTool,
    openMobileAppTool,
  ];
}
