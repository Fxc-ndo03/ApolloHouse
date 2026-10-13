import type { AccountRegistry } from '@/accounts/do';
import { isDeviceCredentialToken } from '@/accounts/session';

type AccountAuthMethods = Pick<import('@/accounts/do').AccountRegistry, 'register' | 'login' | 'logout' | 'session' | 'enrollDevice' | 'listDevices' | 'revokeDevice'>;

const AUTH_PATH_PREFIX = '/api/auth/';

function bearerToken(request: Request): string | null {
  const headerValue = request.headers.get('Authorization');
  if (headerValue === null || !headerValue.startsWith('Bearer ')) {
    return null;
  }
  const token = headerValue.slice('Bearer '.length).trim();
  return token.length > 0 && !isDeviceCredentialToken(token) ? token : null;
}

async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = await request.json();
    return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function unauthorized(): Response {
  return Response.json({ error: 'unauthorized' }, { status: 401 });
}

/**
 * Session-based account endpoints. The account identity NEVER comes from the
 * client: it is derived from the session token stored in the AccountRegistry.
 */
export async function handleAccountAuthRequest(
  request: Request,
  pathname: string,
  registry: AccountAuthMethods,
): Promise<Response> {
  if (!pathname.startsWith(AUTH_PATH_PREFIX)) {
    return null as unknown as Response;
  }
  const route = pathname.slice(AUTH_PATH_PREFIX.length).replace(/\/+$/, '');
  const atMilliseconds = Date.now();

  if (route === 'register' && request.method === 'POST') {
    const body = await readJsonBody(request);
    const outcome = await registry.register({
      email: String(body['email'] ?? ''),
      password: String(body['password'] ?? ''),
      atMilliseconds,
    });
    if (outcome.status === 'ok') {
      return Response.json({
        accountId: outcome.accountId,
        sessionToken: outcome.token,
        expiresAt: outcome.expiresAtMilliseconds,
      });
    }
    return Response.json(
      { error: outcome.status === 'email_taken' ? 'email_taken' : 'invalid_input' },
      { status: outcome.status === 'email_taken' ? 409 : 400 },
    );
  }

  if (route === 'login' && request.method === 'POST') {
    const body = await readJsonBody(request);
    const outcome = await registry.login({
      email: String(body['email'] ?? ''),
      password: String(body['password'] ?? ''),
      atMilliseconds,
    });
    if (outcome.status === 'ok') {
      return Response.json({
        accountId: outcome.accountId,
        sessionToken: outcome.token,
        expiresAt: outcome.expiresAtMilliseconds,
      });
    }
    return Response.json({ error: 'invalid_credentials' }, { status: 401 });
  }

  if (route === 'logout' && request.method === 'POST') {
    const token = bearerToken(request);
    if (token === null) {
      return unauthorized();
    }
    const revoked = await registry.logout({ token, atMilliseconds });
    return Response.json({ ok: revoked });
  }

  if (route === 'session' && request.method === 'GET') {
    const token = bearerToken(request);
    if (token === null) {
      return unauthorized();
    }
    const outcome = await registry.session({ token, atMilliseconds });
    if (outcome.status !== 'ok') {
      return unauthorized();
    }
    return Response.json({ authenticated: true, accountId: outcome.accountId });
  }

  if (route === 'devices' && request.method === 'GET') {
    const token = bearerToken(request);
    if (token === null) {
      return unauthorized();
    }
    const outcome = await registry.listDevices({ token, atMilliseconds });
    if (outcome.status !== 'ok') {
      return unauthorized();
    }
    return Response.json({ devices: outcome.devices });
  }

  if (route === 'devices' && request.method === 'POST') {
    const token = bearerToken(request);
    if (token === null) {
      return unauthorized();
    }
    const body = await readJsonBody(request);
    const outcome = await registry.enrollDevice({
      token,
      deviceId: String(body['deviceId'] ?? ''),
      deviceType: String(body['deviceType'] ?? ''),
      deviceName: String(body['deviceName'] ?? ''),
      atMilliseconds,
    });
    if (outcome.status !== 'ok') {
      return unauthorized();
    }
    return Response.json({ ok: true, accountId: outcome.accountId });
  }

  if (route === 'devices/revoke' && request.method === 'POST') {
    const token = bearerToken(request);
    if (token === null) {
      return unauthorized();
    }
    const body = await readJsonBody(request);
    const outcome = await registry.revokeDevice({
      token,
      deviceId: String(body['deviceId'] ?? ''),
      atMilliseconds,
    });
    if (outcome.status !== 'ok') {
      return unauthorized();
    }
    return Response.json({ ok: true });
  }

  return Response.json({ error: 'not_found' }, { status: 404 });
}
