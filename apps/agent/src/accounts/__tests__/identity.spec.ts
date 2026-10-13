import { describe, expect, it } from 'bun:test';

import {
  InvalidAccountIdError,
  InvalidDeviceIdError,
  LEGACY_ACCOUNT_ID,
  accountIdFromApolloObjectName,
  accountIdFromMemoryNamespace,
  apolloObjectNameForAccount,
  defaultScopesForDeviceType,
  hasScope,
  isImplementedDeviceType,
  isValidAccountId,
  isValidDeviceId,
  memoryNamespaceForAccount,
  requireAccountId,
  requireDeviceId,
} from '@/accounts/identity';

const ACCOUNT_A = 'acc_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const ACCOUNT_B = 'acc_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

describe('account identity', () => {
  it('accepts a well formed account id and rejects everything else', () => {
    expect(isValidAccountId('acc_0123456789abcdef0123456789abcdef')).toBe(true);
    expect(isValidAccountId('default')).toBe(false);
    expect(isValidAccountId('acc_')).toBe(false);
    expect(isValidAccountId('acc_0123456789ABCDEF0123456789ABCDEF')).toBe(false);
    expect(isValidAccountId('user@example.com')).toBe(false);
    expect(isValidAccountId(undefined)).toBe(false);
    expect(isValidAccountId(42)).toBe(false);
  });

  it('rejects mutable identities as account ids', () => {
    for (const mutableValue of ['DESKTOP-ABC123', 'mobile:8e028c54-9a53-433a-bb78-8a5ea61de137', 'Apollo/default']) {
      expect(() => requireAccountId(mutableValue)).toThrow(InvalidAccountIdError);
    }
  });

  it('requires a namespaced device id', () => {
    expect(isValidDeviceId('desktop:11111111-2222-3333-4444-555555555555')).toBe(true);
    expect(isValidDeviceId('mobile:11111111-2222-3333-4444-555555555555')).toBe(true);
    expect(isValidDeviceId('DESKTOP-ABC123')).toBe(false);
    expect(isValidDeviceId('desktop')).toBe(false);
    expect(() => requireDeviceId('COMPUTERNAME')).toThrow(InvalidDeviceIdError);
  });

  it('derives one Durable Object name per account and never mixes accounts', () => {
    const objectNameA = apolloObjectNameForAccount(ACCOUNT_A);
    const objectNameB = apolloObjectNameForAccount(ACCOUNT_B);

    expect(objectNameA).toBe(`acct-${ACCOUNT_A}`);
    expect(objectNameA).not.toBe(objectNameB);
    expect(accountIdFromApolloObjectName(objectNameA)).toBe(ACCOUNT_A);
    expect(accountIdFromApolloObjectName(objectNameB)).toBe(ACCOUNT_B);
    expect(accountIdFromApolloObjectName('default')).toBeNull();
    expect(accountIdFromApolloObjectName('acct:not-an-account')).toBeNull();
  });

  it('derives one memory namespace per account and never mixes accounts', () => {
    const namespaceA = memoryNamespaceForAccount(ACCOUNT_A);
    const namespaceB = memoryNamespaceForAccount(ACCOUNT_B);

    expect(namespaceA).toBe(`mem:${ACCOUNT_A}`);
    expect(namespaceA).not.toBe(namespaceB);
    expect(accountIdFromMemoryNamespace(namespaceA)).toBe(ACCOUNT_A);
    expect(accountIdFromMemoryNamespace('default')).toBeNull();
    expect(accountIdFromMemoryNamespace('mem:default')).toBeNull();
  });

  it('keeps the legacy account namespace separate from every real account', () => {
    expect(isValidAccountId(LEGACY_ACCOUNT_ID)).toBe(true);
    expect(memoryNamespaceForAccount(LEGACY_ACCOUNT_ID)).not.toBe(
      memoryNamespaceForAccount(ACCOUNT_A),
    );
    expect(memoryNamespaceForAccount(LEGACY_ACCOUNT_ID)).not.toBe(
      memoryNamespaceForAccount(ACCOUNT_B),
    );
    expect(apolloObjectNameForAccount(LEGACY_ACCOUNT_ID)).not.toBe('default');
  });

  it('refuses to build scopes from an invalid account', () => {
    expect(() => memoryNamespaceForAccount('default')).toThrow(InvalidAccountIdError);
    expect(() => apolloObjectNameForAccount(undefined)).toThrow(InvalidAccountIdError);
  });

  it('only claims desktop and android as implemented device types', () => {
    expect(isImplementedDeviceType('desktop')).toBe(true);
    expect(isImplementedDeviceType('android')).toBe(true);
    expect(isImplementedDeviceType('physical')).toBe(false);
    expect(isImplementedDeviceType('home')).toBe(false);
    expect(isImplementedDeviceType('tablet')).toBe(false);
    expect(isImplementedDeviceType('web')).toBe(false);
  });

  it('grants enrolled devices the full capability scope set', () => {
    for (const deviceType of ['desktop', 'android'] as const) {
      const scopeList = defaultScopesForDeviceType(deviceType);
      expect(hasScope({ accountId: ACCOUNT_A, deviceId: 'desktop:x', deviceType, legacy: false }, 'device:execute')).toBe(true);
      expect(hasScope({ accountId: ACCOUNT_A, deviceId: 'mobile:x', deviceType, legacy: false }, 'memory:read')).toBe(true);
      expect(scopeList.length).toBeGreaterThan(0);
    }
  });
});
