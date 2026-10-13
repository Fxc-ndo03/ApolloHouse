import { describe, expect, it } from 'bun:test';

import {
  DEFAULT_USAGE_POLICY_BY_TIER,
  USAGE_TABLE_NAME,
  createUsageTableStatement,
  evaluateUsageQuota,
  listUsageTotalsWithinWindow,
  recordUsageEvent,
  resolveUsagePolicy,
  startOfUtcDayMilliseconds,
  startOfUtcMonthMilliseconds,
} from '@/usage/usage';

const ACCOUNT_A = 'acc_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const ACCOUNT_B = 'acc_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

type RecordedStatement = { readonly query: string; readonly params: unknown[] };

function createFakeExecutor(
  selectResults: unknown[] = [],
): { readonly executor: import('@/usage/usage').UsageSqlExecutor; readonly statements: RecordedStatement[] } {
  const statements: RecordedStatement[] = [];
  const executor = {
    execute(query: string, ...bindValues: unknown[]) {
      statements.push({ query, params: bindValues });
      return selectResults;
    },
  };
  return { executor, statements };
}

describe('usage accounting', () => {
  it('keeps commercial limits in configuration, not in the type', () => {
    const freePolicy = resolveUsagePolicy('free');
    expect(freePolicy.dailyTokens).toBeGreaterThan(0);
    expect(freePolicy.tier).toBe('free');

    const tunedPolicy = resolveUsagePolicy('free', { dailyTokens: 5 });
    expect(tunedPolicy.dailyTokens).toBe(5);
    expect(tunedPolicy.monthlyTokens).toBe(freePolicy.monthlyTokens);

    const unknownTierPolicy = resolveUsagePolicy('platinum');
    expect(unknownTierPolicy.tier).toBe('free');
  });

  it('blocks anonymous usage at the first token and never blocks admin', () => {
    const emptyWindow = { tokens: 0, requests: 0, voiceSeconds: 0 };
    const firstToken = { tokens: 1, requests: 0, voiceSeconds: 0 };
    // anonymous tiene TODOS los límites en 0: la primera request ya está
    // bloqueada (por tasa) y cualquier consumo por tokens también.
    expect(evaluateUsageQuota(resolveUsagePolicy('anonymous'), firstToken, emptyWindow, 0).allowed).toBe(false);
    expect(
      evaluateUsageQuota(resolveUsagePolicy('anonymous'), emptyWindow, firstToken, 0).exceededLimit,
    ).toBe('requestsPerMinute');
    expect(
      evaluateUsageQuota(
        resolveUsagePolicy('anonymous', { requestsPerMinute: 99 }),
        emptyWindow,
        firstToken,
        0,
      ).exceededLimit,
    ).toBe('monthlyTokens');
    expect(evaluateUsageQuota(resolveUsagePolicy('admin'), firstToken, firstToken, 999_999).allowed).toBe(true);
  });

  it('detects each exceeded limit independently', () => {
    const policy = resolveUsagePolicy('free', {
      dailyTokens: 100,
      monthlyTokens: 1000,
      dailyVoiceSeconds: 10,
      monthlyVoiceSeconds: 100,
      requestsPerMinute: 5,
    });
    const within = { tokens: 0, requests: 0, voiceSeconds: 0 };

    expect(evaluateUsageQuota(policy, { tokens: 101, requests: 0, voiceSeconds: 0 }, within, 0).exceededLimit).toBe('dailyTokens');
    expect(evaluateUsageQuota(policy, { tokens: 0, requests: 0, voiceSeconds: 0 }, { tokens: 1001, requests: 0, voiceSeconds: 0 }, 0).exceededLimit).toBe('monthlyTokens');
    expect(evaluateUsageQuota(policy, { tokens: 0, requests: 0, voiceSeconds: 11 }, within, 0).exceededLimit).toBe('dailyVoiceSeconds');
    expect(evaluateUsageQuota(policy, { tokens: 0, requests: 0, voiceSeconds: 0 }, { tokens: 0, requests: 0, voiceSeconds: 101 }, 0).exceededLimit).toBe('monthlyVoiceSeconds');
    expect(evaluateUsageQuota(policy, within, within, 5).exceededLimit).toBe('requestsPerMinute');
    expect(evaluateUsageQuota(policy, { tokens: 100, requests: 0, voiceSeconds: 10 }, { tokens: 1000, requests: 0, voiceSeconds: 100 }, 4).allowed).toBe(true);
  });

  it('records usage rows scoped to the calling account', () => {
    const { executor, statements } = createFakeExecutor();

    recordUsageEvent(executor, {
      accountId: ACCOUNT_A,
      tokens: 120,
      requests: 1,
      voiceSeconds: 30,
      atMilliseconds: 1_700_000_000_000,
    });

    expect(statements.length).toBe(1);
    expect(statements[0].query).toContain(USAGE_TABLE_NAME);
    expect(statements[0].params[1]).toBe(ACCOUNT_A);
    expect(statements[0].params[2]).toBe(120);
  });

  it('sums totals only for the requested account and window', () => {
    const { executor, statements } = createFakeExecutor([
      { tokens: 250, requests: 3, voice_seconds: 45 },
    ]);

    const totals = listUsageTotalsWithinWindow(executor, ACCOUNT_A, 0, 1000);

    expect(totals).toEqual({ tokens: 250, requests: 3, voiceSeconds: 45 });
    expect(statements[0].params).toEqual([ACCOUNT_A, 0, 1000]);
    expect(statements[0].query).toContain('account_id = ?');
  });

  it('isolates accounts by construction of the query parameters', () => {
    const { executor, statements } = createFakeExecutor([]);
    listUsageTotalsWithinWindow(executor, ACCOUNT_B, 0, 1000);
    expect(statements[0].params[0]).toBe(ACCOUNT_B);
    expect(statements[0].params[0]).not.toBe(ACCOUNT_A);
  });

  it('computes UTC day and month windows that never cross accounts', () => {
    const instant = Date.UTC(2026, 9, 12, 21, 30, 0);
    expect(startOfUtcDayMilliseconds(instant)).toBe(Date.UTC(2026, 9, 12, 0, 0, 0));
    expect(startOfUtcMonthMilliseconds(instant)).toBe(Date.UTC(2026, 9, 1, 0, 0, 0));
  });

  it('declares an account-scoped table with an index for window queries', () => {
    expect(createUsageTableStatement).toContain('CREATE TABLE IF NOT EXISTS usage_events');
    expect(createUsageTableStatement).toContain('account_id TEXT NOT NULL');
    expect(createUsageTableStatement).toContain('(account_id, created_at)');
    expect(DEFAULT_USAGE_POLICY_BY_TIER.free.tier).toBe('free');
  });
});
