import { describe, expect, it } from 'bun:test';

import { browseConsoleMemory, deleteConsoleMemory } from '@/console/memory';

const TEST_ACCOUNT_ID = 'acc_1111111111111111111111111111test';
import { addMemoryRecord, setSessionPreference } from '@/memory/store';
import type { MemorySqlExecutor, MemorySqlRow } from '@/memory/store';

type StoredMemoryRow = {
  readonly id: string;
  readonly content: string;
  readonly created_at: number;
  readonly account_id: string;
};

type StoredPreferenceRow = {
  readonly value: string;
};

function createInMemoryConsoleSqlExecutor(): MemorySqlExecutor {
  const memoryRowList: StoredMemoryRow[] = [];
  const preferenceMap = new Map<string, string>();
  function executeConsoleQuery<Row extends MemorySqlRow>(
    query: string,
    ...bindValues: unknown[]
  ): readonly Row[] {
    if (query.startsWith('INSERT INTO memories')) {
      memoryRowList.push({
        id: String(bindValues[0]),
        content: String(bindValues[1]),
        created_at: Number(bindValues[2]),
        account_id: String(bindValues[3]),
      });
      return [];
    }
    if (query.startsWith('DELETE FROM memories')) {
      const targetId = String(bindValues[0]);
      const targetIndex = memoryRowList.findIndex((row) => row.id === targetId);
      if (targetIndex >= 0) {
        memoryRowList.splice(targetIndex, 1);
      }
      return [];
    }
    if (query.startsWith('INSERT INTO session_prefs')) {
      preferenceMap.set(String(bindValues[0]), String(bindValues[1]));
      return [];
    }
    if (query.startsWith('SELECT value FROM session_prefs')) {
      const storedValue = preferenceMap.get(String(bindValues[0]));
      const preferenceRowList: readonly MemorySqlRow[] =
        storedValue === undefined
          ? []
          : [{ value: storedValue } satisfies StoredPreferenceRow];
      // SAFETY: the session_prefs SELECT is only issued by getSessionPreference,
      // which requests rows shaped StoredPreferenceRow — exactly what this
      // branch returns.
      return preferenceRowList as readonly Row[];
    }
    if (query.includes('WHERE content LIKE')) {
      const likePattern = String(bindValues[0]).replaceAll('%', '').toLowerCase();
      const limit = Number(bindValues[2]);
      const matchingRowList: readonly MemorySqlRow[] = memoryRowList
        .filter((row) => row.content.toLowerCase().includes(likePattern))
        .toSorted((left, right) => right.created_at - left.created_at)
        .slice(0, limit);
      // SAFETY: the LIKE recall query is only issued by recallMemoryRecords,
      // which requests rows shaped StoredMemoryRow — exactly what this branch
      // returns.
      return matchingRowList as readonly Row[];
    }
    const limit = Number(bindValues[1]);
    const recentRowList: readonly MemorySqlRow[] = memoryRowList
      .toSorted((left, right) => right.created_at - left.created_at)
      .slice(0, limit);
    // SAFETY: the remaining query is the recent-memories listing issued by
    // listRecentMemoryRecords, which requests rows shaped StoredMemoryRow —
    // exactly what this branch returns.
    return recentRowList as readonly Row[];
  }
  return { execute: executeConsoleQuery };
}

describe('console memory browse', () => {
  it('lists recent memories newest-first when no query is given', async () => {
    const sqlExecutor = createInMemoryConsoleSqlExecutor();
    await addMemoryRecord(sqlExecutor, 'older fact', TEST_ACCOUNT_ID, 1);
    await addMemoryRecord(sqlExecutor, 'newer fact', TEST_ACCOUNT_ID, 2);

    const browseResult = await browseConsoleMemory(sqlExecutor, TEST_ACCOUNT_ID, {});

    expect(browseResult.memoryList.map((record) => record.content)).toEqual([
      'newer fact',
      'older fact',
    ]);
    expect(browseResult.ownerFactList).toEqual([]);
    expect(browseResult.lastConsolidatedAtMilliseconds).toBeNull();
  });

  it('filters by keyword when a query is given', async () => {
    const sqlExecutor = createInMemoryConsoleSqlExecutor();
    await addMemoryRecord(sqlExecutor, 'prefers yerba mate in the morning', TEST_ACCOUNT_ID, 1);
    await addMemoryRecord(sqlExecutor, 'works from home on fridays', TEST_ACCOUNT_ID, 2);

    const browseResult = await browseConsoleMemory(sqlExecutor, TEST_ACCOUNT_ID, { query: 'yerba' });

    expect(browseResult.memoryList.map((record) => record.content)).toEqual([
      'prefers yerba mate in the morning',
    ]);
  });

  it('surfaces the consolidated owner-memory block when stored', async () => {
    const sqlExecutor = createInMemoryConsoleSqlExecutor();
    await setSessionPreference(
      sqlExecutor,
      'ownerMemoryState',
      JSON.stringify({
        factList: [
          {
            id: 'fact-1',
            content: 'lives in Buenos Aires',
            category: 'fact',
            lastConfirmedAtMilliseconds: 10,
            sourceCount: 2,
          },
        ],
        lastConsolidatedAtMilliseconds: 99,
      }),
    );

    const browseResult = await browseConsoleMemory(sqlExecutor, TEST_ACCOUNT_ID, {});

    expect(browseResult.ownerFactList).toHaveLength(1);
    expect(browseResult.ownerFactList[0]?.content).toBe('lives in Buenos Aires');
    expect(browseResult.lastConsolidatedAtMilliseconds).toBe(99);
  });

  it('deletes a memory from sql and its vector together', async () => {
    const sqlExecutor = createInMemoryConsoleSqlExecutor();
    const addedRecord = await addMemoryRecord(sqlExecutor, 'fact to forget', TEST_ACCOUNT_ID, 1);
    const deletedVectorIdList: string[] = [];

    await deleteConsoleMemory(
      sqlExecutor,
      {
        deleteByIds: async (idList) => {
          deletedVectorIdList.push(...idList);
          return { ids: idList, count: idList.length };
        },
      },
      addedRecord.id,
    );

    const browseResult = await browseConsoleMemory(sqlExecutor, TEST_ACCOUNT_ID, {});
    expect(browseResult.memoryList).toEqual([]);
    expect(deletedVectorIdList).toEqual([addedRecord.id]);
  });

  it('treats a corrupt stored owner-memory state as absent', async () => {
    const sqlExecutor = createInMemoryConsoleSqlExecutor();
    await setSessionPreference(sqlExecutor, 'ownerMemoryState', 'not-json');

    const browseResult = await browseConsoleMemory(sqlExecutor, TEST_ACCOUNT_ID, {});

    expect(browseResult.ownerFactList).toEqual([]);
    expect(browseResult.lastConsolidatedAtMilliseconds).toBeNull();
  });
});
