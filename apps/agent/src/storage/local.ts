export type StorageObject = {
  readonly key: string;
  readonly value: ArrayBuffer;
  readonly contentType?: string;
  readonly uploadedAt: number;
};

export type StorageBucket = {
  get(key: string): Promise<{
    arrayBuffer(): Promise<ArrayBuffer>;
    size: number;
    httpMetadata?: { contentType?: string };
  } | null>;
  put(
    key: string,
    value: ArrayBuffer | ArrayBufferView | string | ReadableStream,
    options?: { httpMetadata?: { contentType?: string } },
  ): Promise<void>;
  delete(key: string): Promise<void>;
  list(options?: { prefix?: string }): Promise<{
    objects: Array<{ key: string; size: number; uploaded: Date }>;
    truncated: boolean;
    cursor?: string;
  }>;
};

export function createStorageBucket(sql: SqlStorage): StorageBucket {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS storage_objects (
      key TEXT PRIMARY KEY,
      value BLOB NOT NULL,
      content_type TEXT,
      uploaded_at INTEGER NOT NULL
    )
  `);

  return {
    async get(key: string) {
      const cursor = sql.exec(
        `SELECT key, value, content_type, uploaded_at FROM storage_objects WHERE key = ?`,
        key,
      );
      const row = cursor.toArray()[0] as
        | {
            key: string;
            value: ArrayBuffer;
            content_type: string | null;
            uploaded_at: number;
          }
        | undefined;
      if (row === undefined) {
        return null;
      }
      const storedValue = row.value;
      const contentType = row.content_type ?? undefined;
      return {
        size: (storedValue as ArrayBuffer).byteLength,
        httpMetadata: contentType === undefined ? undefined : { contentType },
        async arrayBuffer() {
          return storedValue as ArrayBuffer;
        },
      };
    },

    async put(
      key: string,
      value: ArrayBuffer | ArrayBufferView | string | ReadableStream,
      options?: { httpMetadata?: { contentType?: string } },
    ) {
      let arrayBuffer: ArrayBuffer;
      if (value instanceof ReadableStream) {
        const chunks: Uint8Array[] = [];
        const reader = value.getReader();
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
        arrayBuffer = combined.buffer as ArrayBuffer;
      } else if (value instanceof ArrayBuffer) {
        arrayBuffer = value;
      } else if (ArrayBuffer.isView(value)) {
        const view = value as ArrayBufferView;
        arrayBuffer = view.buffer.slice(
          view.byteOffset,
          view.byteOffset + view.byteLength,
        ) as ArrayBuffer;
      } else {
        arrayBuffer = new TextEncoder().encode(value as string).buffer as ArrayBuffer;
      }
      const contentType =
        options?.httpMetadata?.contentType ?? 'application/octet-stream';
      sql.exec(
        `INSERT OR REPLACE INTO storage_objects (key, value, content_type, uploaded_at) VALUES (?, ?, ?, ?)`,
        key,
        arrayBuffer,
        contentType,
        Date.now(),
      );
    },

    async delete(key: string) {
      sql.exec(`DELETE FROM storage_objects WHERE key = ?`, key);
    },

    async list(options?: { prefix?: string }) {
      const prefix = options?.prefix ?? '';
      const cursor = sql.exec(
        `SELECT key FROM storage_objects WHERE key LIKE ? || '%' ORDER BY key`,
        prefix,
      );
      const rowList = cursor.toArray() as Array<{ key: string }>;
      return {
        objects: rowList.map((row) => ({ key: row.key, size: 0, uploaded: new Date() })),
        truncated: false,
      };
    },
  };
}

export type ConsoleDocumentBucket = {
  list(options: { prefix: string; limit?: number; cursor?: string }): Promise<{
    objects: Array<{ key: string; uploaded: Date; size: number }>;
    truncated: boolean;
    cursor?: string;
  }>;
  get(key: string): Promise<{ text(): Promise<string> } | null>;
};

export function asConsoleDocumentBucket(bucket: StorageBucket): ConsoleDocumentBucket {
  return {
    async list(options) {
      const result = await bucket.list({ prefix: options.prefix });
      return {
        objects: result.objects.map((obj) => ({
          key: obj.key,
          uploaded: obj.uploaded,
          size: obj.size,
        })),
        truncated: result.truncated,
        cursor: result.cursor,
      };
    },
    async get(key: string) {
      const obj = await bucket.get(key);
      if (obj === null) return null;
      return {
        async text() {
          const buffer = await obj.arrayBuffer();
          return new TextDecoder().decode(buffer);
        },
      };
    },
  };
}
