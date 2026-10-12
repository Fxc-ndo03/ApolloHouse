import { z } from 'zod';

import type { ToolExecutionTarget } from '@/tools/execution-target';
import type { ListItemRecord } from '@/lists/store';
import type { ScheduledReminderRow } from '@/reminders/logic';

export type ToolSafetyLevel = 'safe' | 'unsafe';

export type JsonSerializableValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonSerializableValue[]
  | { readonly [propertyName: string]: JsonSerializableValue };

export type ToolArgumentRecord = {
  readonly [argumentName: string]: JsonSerializableValue;
};

export const jsonSerializableValueSchema: z.ZodType<JsonSerializableValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonSerializableValueSchema),
    z.record(jsonSerializableValueSchema),
  ]),
);

export type ToolExecutionResult = {
  readonly ok: boolean;
  readonly summary: string;
  readonly data?: unknown;
};

export type PendingToolConfirmation = {
  readonly id: string;
  readonly toolName: string;
  readonly args: JsonSerializableValue | undefined;
  readonly summary: string;
  readonly expiresAt: number;
  // BLOCK 6: el device que el registry eligió para esta acción. Opcionales
  // para que las confirmaciones ya guardadas (y las del camino LLM, que no
  // pasan por el registry) sigan siendo válidas.
  readonly targetDeviceId?: string;
  readonly targetDeviceType?: string;
};

export type DeskToolEffects = {
  readonly persistMemory: (
    content: string,
  ) => Promise<{ readonly memoryId: string; readonly content: string }>;
  readonly applyFocusMinutes: (minutes: number) => Promise<void>;
  readonly clearFocus: () => Promise<void>;
  readonly enqueueResearch: (prompt: string) => Promise<void>;
  readonly enqueueCodingTask: (input: {
    readonly repository: string;
    readonly task: string;
  }) => Promise<void>;
  readonly scheduleReminder: (input: {
    readonly delaySeconds: number;
    readonly message: string;
  }) => Promise<void>;
  readonly scheduleAlarm: (input: {
    readonly triggerAt: Date;
    readonly label: string | null;
  }) => Promise<void>;
  readonly broadcastTimerProgress: (input: {
    readonly durationSeconds: number;
  }) => Promise<void>;
  readonly listReminders: () => Promise<readonly ScheduledReminderRow[]>;
  readonly cancelReminders: (input: {
    readonly message?: string;
    readonly cancelAll: boolean;
  }) => Promise<{
    readonly cancelledCount: number;
    readonly cancelledMessageList: readonly string[];
  }>;
  readonly resolveWeatherLocation: () => Promise<{
    readonly latitude: number;
    readonly longitude: number;
    readonly locationLabel: string;
    readonly timezone: string;
  }>;
  readonly persistWeatherLocation: (location: {
    readonly locationLabel: string;
    readonly latitude: number;
    readonly longitude: number;
    readonly timezone: string;
  }) => Promise<void>;
  readonly addListItem: (input: {
    readonly listName: string;
    readonly content: string;
  }) => Promise<ListItemRecord>;
  readonly listListItems: (listName?: string) => Promise<readonly ListItemRecord[]>;
  readonly removeListItems: (input: {
    readonly listName: string;
    readonly contentQuery?: string;
    readonly clearAll: boolean;
  }) => Promise<{
    readonly removedCount: number;
    readonly removedContentList: readonly string[];
  }>;
  readonly searchThreadHistory: (input: {
    readonly query: string;
    readonly limit: number;
  }) => Promise<
    readonly {
      readonly id: string;
      readonly role: string;
      readonly content: string;
    }[]
  >;
  readonly resumeConversationThread: (input: { readonly query: string }) => Promise<
    | {
        readonly title: string;
        readonly summary: string | null;
      }
    | undefined
  >;
  readonly callDeviceTool: (input: {
    readonly deviceToolName: string;
    readonly argumentRecord: ToolArgumentRecord;
  }) => Promise<ToolExecutionResult>;
  readonly callInstalledMcpTool: (input: {
    readonly serverId: string;
    readonly toolName: string;
    readonly argumentRecord: ToolArgumentRecord;
  }) => Promise<ToolExecutionResult>;
};

// BLOCK 9: la correlación del turno viaja hasta el handler, para que un comando
// a un device pueda llevar requestId, clientTurnId y generation sin estado
// global. Antes vivía sólo en los eventos del pipeline.
export type ToolCorrelation = {
  readonly requestId?: string | null;
  readonly clientTurnId?: string | null;
  readonly generation?: number | null;
};

export type ToolExecutionContext = {
  readonly environment: Env;
  readonly nowMilliseconds: number;
  readonly deviceId?: string;
  readonly effects?: DeskToolEffects;
  readonly correlation?: ToolCorrelation;
  // BLOCK 9.1: el device que el pipeline resolvió para ESTA ejecución. Sin
  // esto el handler no sabe a quién enviar y tendría que resolver otra vez (o
  // adivinar), que es justo lo que el bloque de target resolution evita.
  readonly targetDeviceId?: string;
  readonly targetDeviceType?: string;
};

export type ToolHandler = (
  args: JsonSerializableValue | undefined,
  context: ToolExecutionContext,
) => Promise<ToolExecutionResult>;

export type ToolDefinition = {
  readonly name: string;
  readonly safety: ToolSafetyLevel;
  readonly description: string;
  readonly parameters: ToolArgumentRecord;
  readonly handler: ToolHandler;
  readonly buildConfirmSummary?: (args: JsonSerializableValue | undefined) => string;
  // BLOCK 6.2: clasificación declarativa. Ausente = cloud-only (no necesita
  // device). Las tools de @/tools/pc la declaran y el guard lo exige.
  readonly executionTarget?: ToolExecutionTarget;
};

export const CONFIRM_TIMEOUT_MILLISECONDS = 30_000;
