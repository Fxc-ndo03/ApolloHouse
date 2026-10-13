import { describe, expect, it } from 'bun:test';

import { Database } from 'bun:sqlite';

import {
  createUsageTableStatement,
  evaluateUsageQuota,
  listUsageTotalsWithinWindow,
  recordUsageEvent,
  resolveUsagePolicyFromEnvironment,
  startOfUtcDayMilliseconds,
  startOfUtcMonthMilliseconds,
} from '@/usage/usage';

const ACCOUNT = 'acc_11111111111111111111111111111111';

function createSqlExecutor() {
  const database = new Database(':memory:');
  database.run(createUsageTableStatement);
  return {
    execute(query: string, ...bindValues: unknown[]) {
      return database.prepare(query).all(...(bindValues as never[])) as Record<
        string,
        string | number | boolean | null
      >[];
    },
  };
}

describe('repro de la cuota remota (reserva → check)', () => {
  it('reserva 1 request → el segundo turno del mismo minuto se bloquea', async () => {
    const executor = createSqlExecutor();
    const now = Date.UTC(2026, 9, 12, 15, 0, 0);
    const policy = resolveUsagePolicyFromEnvironment('free', { APOLLO_REQUESTS_PER_MINUTE: '1' });

    const recent1 = listUsageTotalsWithinWindow(executor, ACCOUNT, now - 60_000, now);
    const decision1 = evaluateUsageQuota(
      policy,
      listUsageTotalsWithinWindow(executor, ACCOUNT, startOfUtcDayMilliseconds(now), now),
      listUsageTotalsWithinWindow(executor, ACCOUNT, startOfUtcMonthMilliseconds(now), now),
      recent1.requests,
    );
    expect(decision1.allowed).toBe(true);

    recordUsageEvent(executor, { accountId: ACCOUNT, tokens: 0, requests: 1, voiceSeconds: 0, atMilliseconds: now });

    const now2 = now + 2_000;
    const recent2 = listUsageTotalsWithinWindow(executor, ACCOUNT, now2 - 60_000, now2);
    expect(recent2.requests).toBe(1);
    const decision2 = evaluateUsageQuota(
      policy,
      listUsageTotalsWithinWindow(executor, ACCOUNT, startOfUtcDayMilliseconds(now2), now2),
      listUsageTotalsWithinWindow(executor, ACCOUNT, startOfUtcMonthMilliseconds(now2), now2),
      recent2.requests,
    );
    expect(decision2.allowed).toBe(false);
    expect(decision2.exceededLimit).toBe('requestsPerMinute');
  });
});
