import { describe, expect, it } from 'bun:test';

import { memoryNamespaceForAccount } from '@/accounts/identity';
import { queryMemoryVectors, upsertMemoryVector } from '@/memory/vector';

const ACCOUNT_A = 'acc_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const ACCOUNT_B = 'acc_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

type CapturedCall = { readonly namespace: string; readonly id: string };

function createCapturingVectorizeIndex(): {
  readonly index: VectorizeIndex;
  readonly upsertCalls: CapturedCall[];
  readonly queryNamespaces: string[];
} {
  const upsertCalls: CapturedCall[] = [];
  const queryNamespaces: string[] = [];
  const index = {
    async upsert(vectorList: VectorizeVector[]): Promise<void> {
      for (const vector of vectorList) {
        upsertCalls.push({ namespace: vector.namespace ?? '', id: vector.id });
      }
    },
    async query(
      _values: number[],
      options: { namespace?: string; topK?: number },
    ): Promise<VectorizeMatches> {
      queryNamespaces.push(options.namespace ?? '');
      return { matches: [], count: 0 };
    },
    async describe(): Promise<unknown> {
      return {};
    },
    async getByIds(): Promise<unknown> {
      return [];
    },
    async deleteByIds(): Promise<void> {},
  } as unknown as VectorizeIndex;
  return { index, upsertCalls, queryNamespaces };
}

describe('memory vector isolation', () => {
  it('writes each account into its own namespace', async () => {
    const { index, upsertCalls } = createCapturingVectorizeIndex();

    await upsertMemoryVector({
      vectorizeIndex: index,
      memoryId: 'mem-1',
      content: 'tengo médico mañana',
      values: [0.1, 0.2],
      accountId: ACCOUNT_A,
    });
    await upsertMemoryVector({
      vectorizeIndex: index,
      memoryId: 'mem-2',
      content: 'equipo de fútbol B',
      values: [0.3, 0.4],
      accountId: ACCOUNT_B,
    });

    expect(upsertCalls.map((call) => call.namespace)).toEqual([
      memoryNamespaceForAccount(ACCOUNT_A),
      memoryNamespaceForAccount(ACCOUNT_B),
    ]);
    expect(upsertCalls[0].namespace).not.toBe(upsertCalls[1].namespace);
  });

  it('queries only inside the caller account namespace', async () => {
    const { index, queryNamespaces } = createCapturingVectorizeIndex();

    await queryMemoryVectors({ vectorizeIndex: index, values: [0.5], accountId: ACCOUNT_A });
    await queryMemoryVectors({ vectorizeIndex: index, values: [0.5], accountId: ACCOUNT_B });

    expect(queryNamespaces).toEqual([
      memoryNamespaceForAccount(ACCOUNT_A),
      memoryNamespaceForAccount(ACCOUNT_B),
    ]);
  });

  it('refuses to write or query without a valid account', async () => {
    const { index } = createCapturingVectorizeIndex();

    expect(() =>
      upsertMemoryVector({
        vectorizeIndex: index,
        memoryId: 'mem-x',
        content: 'sin cuenta',
        values: [0.1],
        accountId: undefined as unknown as string,
      }),
    ).toThrow();

    expect(() =>
      queryMemoryVectors({
        vectorizeIndex: index,
        values: [0.1],
        accountId: 'default',
      }),
    ).toThrow();
  });

  it('refuses to treat a device id as an account namespace', async () => {
    const { index, upsertCalls } = createCapturingVectorizeIndex();
    const legacyDeviceId = 'desktop:11111111-2222-3333-4444-555555555555';

    expect(() =>
      upsertMemoryVector({
        vectorizeIndex: index,
        memoryId: 'mem-d',
        content: 'memoria del dispositivo',
        values: [0.1],
        accountId: legacyDeviceId as unknown as string,
      }),
    ).toThrow();

    expect(upsertCalls.length).toBe(0);
  });
});
