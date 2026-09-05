import { z } from 'zod';

const GEMINI_CHAT_COMPLETIONS_URL =
  'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';

const proxyRequestBodySchema = z.object({ model: z.string() }).passthrough();
export const CODING_PROXY_PATH_PREFIX = '/coding-llm/v1';
export const CODING_PROXY_TOKEN_TTL_MILLISECONDS = 6 * 60 * 60 * 1000;

async function computeTokenSignature(
  geminiApiKey: string,
  payloadText: string,
): Promise<string> {
  const signingKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(geminiApiKey),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signatureBytes = await crypto.subtle.sign(
    'HMAC',
    signingKey,
    new TextEncoder().encode(payloadText),
  );
  return [...new Uint8Array(signatureBytes)]
    .map((byteValue) => byteValue.toString(16).padStart(2, '0'))
    .join('');
}

export async function mintCodingProxyToken(input: {
  readonly instanceId: string;
  readonly geminiApiKey: string;
  readonly nowMilliseconds: number;
}): Promise<string> {
  const expiresAtMilliseconds =
    input.nowMilliseconds + CODING_PROXY_TOKEN_TTL_MILLISECONDS;
  const payloadText = `${input.instanceId}.${expiresAtMilliseconds}`;
  const signature = await computeTokenSignature(input.geminiApiKey, payloadText);
  return `${payloadText}.${signature}`;
}

export async function verifyCodingProxyToken(input: {
  readonly token: string;
  readonly geminiApiKey: string;
  readonly nowMilliseconds: number;
}): Promise<boolean> {
  const lastSeparatorIndex = input.token.lastIndexOf('.');
  if (lastSeparatorIndex <= 0) {
    return false;
  }
  const payloadText = input.token.slice(0, lastSeparatorIndex);
  const presentedSignature = input.token.slice(lastSeparatorIndex + 1);
  const expiresAtMilliseconds = Number(
    payloadText.slice(payloadText.lastIndexOf('.') + 1),
  );
  if (!Number.isFinite(expiresAtMilliseconds)) {
    return false;
  }
  if (input.nowMilliseconds > expiresAtMilliseconds) {
    return false;
  }
  const expectedSignature = await computeTokenSignature(input.geminiApiKey, payloadText);
  if (presentedSignature.length !== expectedSignature.length) {
    return false;
  }
  let differenceBits = 0;
  for (
    let characterIndex = 0;
    characterIndex < expectedSignature.length;
    characterIndex += 1
  ) {
    differenceBits |=
      presentedSignature.charCodeAt(characterIndex) ^
      expectedSignature.charCodeAt(characterIndex);
  }
  return differenceBits === 0;
}

export async function handleCodingLlmProxyRequest(
  request: Request,
  requestUrl: URL,
  environment: Env,
  fetchImplementation: typeof fetch = globalThis.fetch,
): Promise<Response> {
  if (
    request.method !== 'POST' ||
    requestUrl.pathname !== `${CODING_PROXY_PATH_PREFIX}/chat/completions`
  ) {
    return new Response('Not found', { status: 404 });
  }
  const authorizationHeader = request.headers.get('authorization') ?? '';
  const presentedToken = authorizationHeader.replace(/^Bearer\s+/i, '');
  const geminiApiKey = environment.GEMINI_API_KEY ?? '';
  if (geminiApiKey.length === 0) {
    return new Response('Unauthorized', { status: 401 });
  }
  const isTokenValid = await verifyCodingProxyToken({
    token: presentedToken,
    geminiApiKey,
    nowMilliseconds: Date.now(),
  });
  if (!isTokenValid) {
    return new Response('Unauthorized', { status: 401 });
  }

  const requestBodyText = await request.text();
  let parsedBodyJson: unknown;
  try {
    parsedBodyJson = JSON.parse(requestBodyText);
  } catch {
    return new Response('Bad request', { status: 400 });
  }
  const parsedBody = proxyRequestBodySchema.safeParse(parsedBodyJson);
  if (!parsedBody.success) {
    return new Response('Bad request', { status: 400 });
  }
  const allowedModels = new Set([
    environment.GEMINI_MODEL,
    environment.GEMINI_LIVE_MODEL,
  ]);
  if (!allowedModels.has(parsedBody.data.model)) {
    return new Response('Model not allowed', { status: 403 });
  }

  return fetchImplementation(GEMINI_CHAT_COMPLETIONS_URL, {
    method: 'POST',
    headers: {
      'x-goog-api-key': geminiApiKey,
      'content-type': 'application/json',
    },
    body: requestBodyText,
  });
}
