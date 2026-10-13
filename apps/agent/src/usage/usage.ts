export type UsageTier = 'anonymous' | 'free' | 'paid' | 'admin';

/**
 * Configurable consumption limits. Values are intentionally conservative
 * placeholders for the free tier; commercial numbers are a product decision
 * and live in configuration, never in this type.
 */
export type UsagePolicy = {
  readonly tier: UsageTier;
  readonly dailyTokens: number;
  readonly monthlyTokens: number;
  readonly dailyVoiceSeconds: number;
  readonly monthlyVoiceSeconds: number;
  readonly requestsPerMinute: number;
};

export type UsageWindowTotals = {
  readonly tokens: number;
  readonly requests: number;
  readonly voiceSeconds: number;
};

export type UsageDecision = {
  readonly allowed: boolean;
  readonly exceededLimit: string | null;
};

export const DEFAULT_USAGE_POLICY_BY_TIER: Readonly<
  Record<UsageTier, UsagePolicy>
> = {
  anonymous: {
    tier: 'anonymous',
    dailyTokens: 0,
    monthlyTokens: 0,
    dailyVoiceSeconds: 0,
    monthlyVoiceSeconds: 0,
    requestsPerMinute: 0,
  },
  free: {
    tier: 'free',
    dailyTokens: 200_000,
    monthlyTokens: 2_000_000,
    dailyVoiceSeconds: 600,
    monthlyVoiceSeconds: 6_000,
    requestsPerMinute: 20,
  },
  paid: {
    tier: 'paid',
    dailyTokens: 2_000_000,
    monthlyTokens: 20_000_000,
    dailyVoiceSeconds: 3_600,
    monthlyVoiceSeconds: 36_000,
    requestsPerMinute: 120,
  },
  admin: {
    tier: 'admin',
    dailyTokens: Number.MAX_SAFE_INTEGER,
    monthlyTokens: Number.MAX_SAFE_INTEGER,
    dailyVoiceSeconds: Number.MAX_SAFE_INTEGER,
    monthlyVoiceSeconds: Number.MAX_SAFE_INTEGER,
    requestsPerMinute: Number.MAX_SAFE_INTEGER,
  },
};

export function resolveUsagePolicy(
  tier: unknown,
  overrides: Partial<Omit<UsagePolicy, 'tier'>> = {},
): UsagePolicy {
  const basePolicy =
    typeof tier === 'string' && tier in DEFAULT_USAGE_POLICY_BY_TIER
      ? DEFAULT_USAGE_POLICY_BY_TIER[tier as UsageTier]
      : DEFAULT_USAGE_POLICY_BY_TIER.free;
  return { ...basePolicy, ...overrides };
}

/**
 * FASE 2.5: límites numéricos sobreescribibles por entorno (staging prueba
 * enforcement con límites chicos; producción usa los defaults del tier).
 * Un valor inválido o no positivo se ignora — no rompe el tier base.
 */
export function resolveUsagePolicyFromEnvironment(
  tier: unknown,
  environment: {
    readonly APOLLO_USAGE_TIER?: string;
    readonly APOLLO_DAILY_TOKEN_LIMIT?: string;
    readonly APOLLO_REQUESTS_PER_MINUTE?: string;
  },
): UsagePolicy {
  const dailyTokenOverride = Number(environment.APOLLO_DAILY_TOKEN_LIMIT);
  const requestsPerMinuteOverride = Number(environment.APOLLO_REQUESTS_PER_MINUTE);
  const overrides: Partial<Omit<UsagePolicy, 'tier'>> = {
    ...(Number.isFinite(dailyTokenOverride) && dailyTokenOverride > 0
      ? { dailyTokens: Math.round(dailyTokenOverride) }
      : {}),
    ...(Number.isFinite(requestsPerMinuteOverride) && requestsPerMinuteOverride > 0
      ? { requestsPerMinute: Math.round(requestsPerMinuteOverride) }
      : {}),
  };
  return resolveUsagePolicy(tier, overrides);
}

export function evaluateUsageQuota(
  policy: UsagePolicy,
  dailyUsage: UsageWindowTotals,
  monthlyUsage: UsageWindowTotals,
  requestsInCurrentMinute: number,
): UsageDecision {
  // Tasa por minuto: el chequeo se hace ANTES del request, así que con
  // `consumed >= límite` el siguiente no entra (límite 1 = un turno por
  // minuto; el segundo se bloquea — verificado en staging, FASE 2.5).
  if (requestsInCurrentMinute >= policy.requestsPerMinute) {
    return { allowed: false, exceededLimit: 'requestsPerMinute' };
  }
  const limitList: readonly [string, number, number][] = [
    ['dailyTokens', dailyUsage.tokens, policy.dailyTokens],
    ['monthlyTokens', monthlyUsage.tokens, policy.monthlyTokens],
    ['dailyVoiceSeconds', dailyUsage.voiceSeconds, policy.dailyVoiceSeconds],
    ['monthlyVoiceSeconds', monthlyUsage.voiceSeconds, policy.monthlyVoiceSeconds],
  ];
  for (const [limitName, consumed, allowed] of limitList) {
    if (consumed > allowed) {
      return { allowed: false, exceededLimit: limitName };
    }
  }
  return { allowed: true, exceededLimit: null };
}

export type UsageSqlExecutor = {
  execute(query: string, ...bindValues: unknown[]): readonly unknown[];
};

export type UsageEventInput = {
  readonly accountId: string;
  readonly tokens: number;
  readonly requests: number;
  readonly voiceSeconds: number;
  readonly atMilliseconds: number;
};

export const USAGE_TABLE_NAME = 'usage_events';

export const createUsageTableStatement = `
  CREATE TABLE IF NOT EXISTS usage_events (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    tokens INTEGER NOT NULL,
    requests INTEGER NOT NULL,
    voice_seconds INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS usage_events_account_time
    ON usage_events (account_id, created_at);
`;

export function recordUsageEvent(
  executor: UsageSqlExecutor,
  input: UsageEventInput,
): void {
  executor.execute(
    `INSERT INTO ${USAGE_TABLE_NAME}
       (id, account_id, tokens, requests, voice_seconds, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    crypto.randomUUID(),
    input.accountId,
    Math.max(0, Math.round(input.tokens)),
    Math.max(0, Math.round(input.requests)),
    Math.max(0, Math.round(input.voiceSeconds)),
    input.atMilliseconds,
  );
}

export function listUsageTotalsWithinWindow(
  executor: UsageSqlExecutor,
  accountId: string,
  fromMillisecondsInclusive: number,
  toMillisecondsInclusive: number,
): UsageWindowTotals {
  const results = executor.execute(
    `SELECT
       COALESCE(SUM(tokens), 0) AS tokens,
       COALESCE(SUM(requests), 0) AS requests,
       COALESCE(SUM(voice_seconds), 0) AS voice_seconds
     FROM ${USAGE_TABLE_NAME}
     WHERE account_id = ? AND created_at BETWEEN ? AND ?`,
    accountId,
    fromMillisecondsInclusive,
    toMillisecondsInclusive,
  );
  const row = (results[0] ?? {}) as Record<string, unknown>;
  return {
    tokens: Number(row.tokens ?? 0),
    requests: Number(row.requests ?? 0),
    voiceSeconds: Number(row.voice_seconds ?? 0),
  };
}

export function startOfUtcDayMilliseconds(atMilliseconds: number): number {
  const utcMidnight = new Date(atMilliseconds);
  utcMidnight.setUTCHours(0, 0, 0, 0);
  return utcMidnight.getTime();
}

export function startOfUtcMonthMilliseconds(atMilliseconds: number): number {
  const utcMonthStart = new Date(atMilliseconds);
  utcMonthStart.setUTCDate(1);
  utcMonthStart.setUTCHours(0, 0, 0, 0);
  return utcMonthStart.getTime();
}
