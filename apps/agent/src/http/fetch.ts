export async function fetchWithTimeout(input: {
  readonly url: string;
  readonly init?: RequestInit;
  readonly timeoutMilliseconds: number;
  readonly fetchImplementation?: typeof fetch;
}): Promise<Response> {
  const abortController = new AbortController();
  const timeoutHandle = setTimeout(
    () => abortController.abort(),
    input.timeoutMilliseconds,
  );
  try {
    const fetchImpl = input.fetchImplementation ?? globalThis.fetch;
    return await fetchImpl(input.url, {
      ...input.init,
      signal: abortController.signal,
    });
  } finally {
    clearTimeout(timeoutHandle);
  }
}
