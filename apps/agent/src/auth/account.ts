import type { AccountAuthority, AuthenticatedAccount } from '@/accounts/authority';
import { isDeviceCredentialToken } from '@/accounts/session';

export type { AuthenticatedAccount };

/**
 * THE authority for account identity on HTTP routes.
 *
 * The account comes exclusively from the session store — never from a body
 * field, query string or header the client controls. A client-sent
 * `accountId` is ignored by every endpoint that uses this function.
 */
export async function requireAuthenticatedAccount(
  request: Request,
  authority: AccountAuthority,
): Promise<AuthenticatedAccount | null> {
  const headerValue = request.headers.get('Authorization');
  if (headerValue === null || !headerValue.startsWith('Bearer ')) {
    return null;
  }
  const token = headerValue.slice('Bearer '.length).trim();
  if (token.length === 0 || isDeviceCredentialToken(token)) {
    return null;
  }
  return authority.resolveSessionToken(token, Date.now());
}
