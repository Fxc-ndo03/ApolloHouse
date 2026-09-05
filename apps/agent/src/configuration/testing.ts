import type { StorageBucket } from '@/storage/local';
import type { MemorySqlExecutor } from '@/memory/store';
import type { DeskToolEffects } from '@/tools/types';

type PendingConfirmationRow = {
  readonly id: string;
  readonly tool_name: string;
  readonly args_json: string;
  readonly summary: string;
  readonly expires_at: number;
};

type McpToolSettingRow = {
  readonly namespaced_name: string;
  readonly server_id: string;
  readonly tool_name: string;
  readonly is_enabled: number;
  readonly safety: string;
};

export function createInMemoryPendingConfirmationSqlExecutor(): MemorySqlExecutor {
  let rowList: readonly PendingConfirmationRow[] = [];
  const fakeExecutor = {
    execute(query: string, ...bindValues: unknown[]): readonly PendingConfirmationRow[] {
      if (query.startsWith('DELETE FROM pending_confirmations')) {
        rowList = [];
        return [];
      }
      if (query.startsWith('INSERT INTO pending_confirmations')) {
        rowList = [
          ...rowList,
          {
            id: String(bindValues[0]),
            tool_name: String(bindValues[1]),
            args_json: String(bindValues[2]),
            summary: String(bindValues[3]),
            expires_at: Number(bindValues[4]),
          },
        ];
        return [];
      }
      if (query.includes('FROM pending_confirmations')) {
        return rowList.slice(0, 1);
      }
      return [];
    },
  };
  // SAFETY: the fake only ever serves pending_confirmations columns, which is
  // exactly the Row shape every query against this table selects.
  return fakeExecutor as MemorySqlExecutor;
}

export function createInMemoryMcpToolSettingsSqlExecutor(
  initialRowList: readonly McpToolSettingRow[] = [],
): MemorySqlExecutor {
  let rowList: readonly McpToolSettingRow[] = [...initialRowList];
  const fakeExecutor = {
    execute(query: string, ...bindValues: unknown[]): readonly McpToolSettingRow[] {
      if (query.startsWith('DELETE FROM mcp_tool_settings')) {
        const removedServerId = String(bindValues[0]);
        rowList = rowList.filter((row) => row.server_id !== removedServerId);
        return [];
      }
      if (query.startsWith('INSERT INTO mcp_tool_settings')) {
        const insertedRow = {
          namespaced_name: String(bindValues[0]),
          server_id: String(bindValues[1]),
          tool_name: String(bindValues[2]),
          is_enabled: Number(bindValues[3]),
          safety: String(bindValues[4]),
        };
        rowList = [
          ...rowList.filter((row) => row.namespaced_name !== insertedRow.namespaced_name),
          insertedRow,
        ];
        return [];
      }
      if (query.includes('FROM mcp_tool_settings')) {
        return rowList;
      }
      return [];
    },
  };
  // SAFETY: the fake only ever serves mcp_tool_settings columns, which is
  // exactly the Row shape every query against this table selects.
  return fakeExecutor as MemorySqlExecutor;
}

export function createFakeStorageBucket(
  initialObjectMap: Record<string, string | Uint8Array> = {},
): StorageBucket {
  const storedObjectMap = new Map<string, Uint8Array>(
    Object.entries(initialObjectMap).map(([objectKey, content]) => [
      objectKey,
      content instanceof Uint8Array ? content : new TextEncoder().encode(content),
    ]),
  );
  const bucket: StorageBucket = {
    async get(objectKey: string) {
      const storedBytes = storedObjectMap.get(objectKey);
      if (storedBytes === undefined) {
        return null;
      }
      return {
        size: storedBytes.byteLength,
        httpMetadata: { contentType: 'application/octet-stream' },
        async arrayBuffer() {
          return storedBytes.buffer.slice(
            storedBytes.byteOffset,
            storedBytes.byteOffset + storedBytes.byteLength,
          ) as ArrayBuffer;
        },
      };
    },
    async put(
      objectKey: string,
      content: ReadableStream | ArrayBuffer | ArrayBufferView | string,
      _options?: { httpMetadata?: { contentType?: string } },
    ) {
      let contentBytes: Uint8Array;
      if (content instanceof ReadableStream) {
        const chunks: Uint8Array[] = [];
        const reader = content.getReader();
        while (true) {
          const { done, value: chunk } = await reader.read();
          if (done) break;
          chunks.push(chunk as Uint8Array);
        }
        const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
        const combined = new Uint8Array(totalLength);
        let offset = 0;
        for (const chunk of chunks) {
          combined.set(chunk, offset);
          offset += chunk.length;
        }
        contentBytes = combined;
      } else if (content instanceof ArrayBuffer) {
        contentBytes = new Uint8Array(content);
      } else if (
        content !== null &&
        typeof content === 'object' &&
        'buffer' in content &&
        'byteOffset' in content &&
        'byteLength' in content
      ) {
        contentBytes = new Uint8Array(
          (content as ArrayBufferView).buffer,
          (content as ArrayBufferView).byteOffset,
          (content as ArrayBufferView).byteLength,
        );
      } else {
        contentBytes = new TextEncoder().encode(content as string);
      }
      storedObjectMap.set(objectKey, contentBytes);
    },
    async delete(objectKey: string) {
      storedObjectMap.delete(objectKey);
    },
    async list(options?: { prefix?: string }) {
      const prefix = options?.prefix ?? '';
      const keys = Array.from(storedObjectMap.keys()).filter((key) =>
        key.startsWith(prefix),
      );
      return {
        objects: keys.map((key) => ({
          key,
          size: storedObjectMap.get(key)?.byteLength ?? 0,
          uploaded: new Date(),
        })),
        truncated: false,
      };
    },
  };
  return bucket;
}

export async function buildTestRsaPrivateKeyPem(): Promise<string> {
  const generatedKey = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  );
  if (!('privateKey' in generatedKey)) {
    throw new Error('generateKey did not return a key pair');
  }
  const exportedKey = await crypto.subtle.exportKey('pkcs8', generatedKey.privateKey);
  if (!(exportedKey instanceof ArrayBuffer)) {
    throw new Error('exportKey did not return pkcs8 bytes');
  }
  const pkcs8Bytes = new Uint8Array(exportedKey);
  let binaryText = '';
  for (const byte of pkcs8Bytes) {
    binaryText += String.fromCharCode(byte);
  }
  const base64Body = btoa(binaryText).replaceAll(/(.{64})/g, '$1\n');
  return `-----BEGIN PRIVATE KEY-----\n${base64Body}\n-----END PRIVATE KEY-----`;
}

export function createFakeApolloEnvironment(overrides: Partial<Env> = {}): Env {
  // SAFETY: specs read only the vars, secrets, and owner email above the
  // binding stubs; the empty binding objects exist to satisfy Env's shape and
  // are never invoked unless a test overrides them with a working fake.
  return {
    GEMINI_MODEL: 'models/gemini-3.6-flash',
    GEMINI_STT_MODEL: 'models/gemini-3.6-flash',
    GEMINI_LIVE_MODEL: 'models/gemini-3.6-flash-preview-native-audio-dialog',
    GEMINI_TTS_MODEL: 'models/gemini-2.5-flash-preview-tts',
    GEMINI_EMBEDDING_MODEL: 'text-embedding-004',
    DEVICE_SHARED_SECRET: 'secret',
    DASHBOARD_SHARED_SECRET: 'dashboard-secret',
    GEMINI_API_KEY: '',
    ELEVENLABS_API_KEY: '',
    TAVILY_API_KEY: '',
    RESEND_API_KEY: '',
    GITHUB_APP_ID: '',
    GITHUB_APP_PRIVATE_KEY: '',
    APOLLO_OWNER_EMAIL: 'owner@example.com',
    Apollo: {} as Env['Apollo'],
    VECTORIZE: {} as Env['VECTORIZE'],
    APOLLO_QUEUE: {} as Env['APOLLO_QUEUE'],
    BACKGROUND: {} as Env['BACKGROUND'],
    CODING: {} as Env['CODING'],
    Sandbox: {} as Env['Sandbox'],
    PC_BRIDGE_SECRET: 'test-secret',
    SPOTIFY_CLIENT_ID: 'test-client-id',
    SPOTIFY_CLIENT_SECRET: 'test-client-secret',
    SPOTIFY_REDIRECT_URI: 'http://127.0.0.1:8888/callback',
    ...overrides,
  };
}

// A complete no-op DeskToolEffects so a test can override just the handful of
// effects it exercises, instead of casting a partial object into the type.
export function createStubDeskToolEffects(
  overrides: Partial<DeskToolEffects> = {},
): DeskToolEffects {
  return {
    persistMemory: async (content) => ({ memoryId: 'stub-memory', content }),
    applyFocusMinutes: async () => {},
    clearFocus: async () => {},
    enqueueResearch: async () => {},
    enqueueCodingTask: async () => {},
    scheduleReminder: async () => {},
    scheduleAlarm: async () => {},
    broadcastTimerProgress: async () => {},
    listReminders: async () => [],
    cancelReminders: async () => ({ cancelledCount: 0, cancelledMessageList: [] }),
    resolveWeatherLocation: async () => ({
      latitude: -34.6,
      longitude: -58.38,
      locationLabel: 'Buenos Aires',
      timezone: 'America/Argentina/Buenos_Aires',
    }),
    persistWeatherLocation: async () => {},
    searchThreadHistory: async () => [],
    resumeConversationThread: async () => undefined,
    addListItem: async ({ listName, content }) => ({
      id: 'stub-item',
      listName,
      content,
      createdAt: 0,
    }),
    listListItems: async () => [],
    removeListItems: async () => ({ removedCount: 0, removedContentList: [] }),
    callDeviceTool: async () => ({ ok: false, summary: 'stub' }),
    callInstalledMcpTool: async () => ({ ok: false, summary: 'stub' }),
    ...overrides,
  };
}
