import type { AccountRegistryStore } from '@/accounts/registry';
import { sha256Hex } from '@/accounts/session';

export type AuthenticatedAccount = {
  readonly accountId: string;
  readonly sessionId: string;
};

export type AccountAuthority = {
  readonly store: AccountRegistryStore;
  resolveSessionToken(
    token: string,
    atMilliseconds: number,
  ): Promise<AuthenticatedAccount | null>;
  resolveSessionTokenHash(
    tokenHash: string,
    atMilliseconds: number,
  ): AuthenticatedAccount | null;
};

export function createAccountAuthority(store: AccountRegistryStore): AccountAuthority {
  return {
    store,
    async resolveSessionToken(token, atMilliseconds) {
      if (token.length < 32) {
        return null;
      }
      const tokenHash = await sha256Hex(token);
      return store.resolveSessionByTokenHash(tokenHash, atMilliseconds);
    },
    resolveSessionTokenHash(tokenHash, atMilliseconds) {
      return store.resolveSessionByTokenHash(tokenHash, atMilliseconds);
    },
  };
}
