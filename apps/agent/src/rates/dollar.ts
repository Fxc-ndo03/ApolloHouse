import { z } from 'zod';

import { fetchWithTimeout } from '@/http/fetch';

// dolarapi.com is free and keyless — a dedicated client keeps the daily "¿a
// cuánto está el blue?" instant and off the Tavily search quota.
const DOLLAR_API_BASE_URL = 'https://dolarapi.com/v1/dolares';

const DOLLAR_FETCH_TIMEOUT_MILLISECONDS = 15_000;

export const DOLLAR_RATE_TYPE_LIST = [
  'oficial',
  'blue',
  'bolsa',
  'contadoconliqui',
  'tarjeta',
  'cripto',
] as const;

export type DollarRateType = (typeof DOLLAR_RATE_TYPE_LIST)[number];

export type DollarHttpFetchImplementation = (url: string) => Promise<Response>;

const dollarRateSchema = z.object({
  casa: z.string(),
  nombre: z.string(),
  compra: z.number().nullable(),
  venta: z.number().nullable(),
  fechaActualizacion: z.string(),
});

export type DollarRate = z.infer<typeof dollarRateSchema>;

async function requestDollarApi<ParsedPayload>(
  requestUrl: string,
  payloadSchema: z.ZodType<ParsedPayload>,
  fetchImpl: DollarHttpFetchImplementation | undefined,
  timeoutMilliseconds: number,
): Promise<ParsedPayload> {
  const fetchImplementation: typeof fetch =
    fetchImpl === undefined
      ? globalThis.fetch
      : (url: string | URL | Request, init?: RequestInit) => fetchImpl(String(url));
  const response = await fetchWithTimeout({
    url: requestUrl,
    timeoutMilliseconds,
    fetchImplementation,
  });

  if (!response.ok) {
    throw new Error(`dolarapi request failed with status ${response.status}`);
  }

  const rawPayload: unknown = await response.json();
  return payloadSchema.parse(rawPayload);
}

export async function fetchDollarRate(input: {
  readonly type: DollarRateType;
  readonly fetchImpl?: DollarHttpFetchImplementation;
  readonly timeoutMilliseconds?: number;
}): Promise<DollarRate> {
  return requestDollarApi(
    `${DOLLAR_API_BASE_URL}/${input.type}`,
    dollarRateSchema,
    input.fetchImpl,
    input.timeoutMilliseconds ?? DOLLAR_FETCH_TIMEOUT_MILLISECONDS,
  );
}

export async function fetchDollarRateList(
  input: {
    readonly fetchImpl?: DollarHttpFetchImplementation;
    readonly timeoutMilliseconds?: number;
  } = {},
): Promise<readonly DollarRate[]> {
  return requestDollarApi(
    DOLLAR_API_BASE_URL,
    z.array(dollarRateSchema),
    input.fetchImpl,
    input.timeoutMilliseconds ?? DOLLAR_FETCH_TIMEOUT_MILLISECONDS,
  );
}
