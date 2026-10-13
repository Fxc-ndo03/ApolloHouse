import { describe, expect, it } from 'bun:test';

import { selectDesktopTarget } from '@/devices/desktop-target';

const ACCOUNT_A = 'acc_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const ACCOUNT_B = 'acc_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const A1 = 'desktop:11111111-1111-4111-8111-111111111111';
const A2 = 'desktop:22222222-2222-4222-8222-222222222222';
const B1 = 'desktop:33333333-3333-4333-8333-333333333333';

const ONLINE = () => true;

describe('PcBridge multidispositivo — selección de destino', () => {
  it('A1 y A2 pertenecen a la misma cuenta y `any` elige UNA', () => {
    const selection = selectDesktopTarget({
      requestingAccountId: ACCOUNT_A,
      targetPreference: { kind: 'any' },
      accountDesktopList: [
        { deviceId: A1, isRevoked: false },
        { deviceId: A2, isRevoked: false },
      ],
      isDesktopOnline: ONLINE,
    });
    expect(selection).toEqual({ status: 'resolved', deviceId: A1 });
  });

  it('una solicitud para A1 termina en A1 y una para A2 en A2', () => {
    const list = [
      { deviceId: A1, isRevoked: false },
      { deviceId: A2, isRevoked: false },
    ];
    const toA1 = selectDesktopTarget({
      requestingAccountId: ACCOUNT_A,
      targetPreference: { kind: 'specific', deviceId: A1 },
      accountDesktopList: list,
      isDesktopOnline: ONLINE,
    });
    const toA2 = selectDesktopTarget({
      requestingAccountId: ACCOUNT_A,
      targetPreference: { kind: 'specific', deviceId: A2 },
      accountDesktopList: list,
      isDesktopOnline: ONLINE,
    });
    expect(toA1).toEqual({ status: 'resolved', deviceId: A1 });
    expect(toA2).toEqual({ status: 'resolved', deviceId: A2 });
  });

  it('la cuenta B no puede invocar capacidades de A1 aunque conozca el id', () => {
    const selection = selectDesktopTarget({
      requestingAccountId: ACCOUNT_B,
      targetPreference: { kind: 'specific', deviceId: A1 },
      accountDesktopList: [{ deviceId: B1, isRevoked: false }],
      isDesktopOnline: ONLINE,
    });
    expect(selection).toEqual({ status: 'unavailable', reason: 'device_of_other_account' });
  });

  it('revocar A1 no revoca A2 y A1 revocado nunca es destino', () => {
    const list = [
      { deviceId: A1, isRevoked: true },
      { deviceId: A2, isRevoked: false },
    ];
    // `any` salta la revocada y usa la otra.
    const anySelection = selectDesktopTarget({
      requestingAccountId: ACCOUNT_A,
      targetPreference: { kind: 'any' },
      accountDesktopList: list,
      isDesktopOnline: ONLINE,
    });
    expect(anySelection).toEqual({ status: 'resolved', deviceId: A2 });
    // Pedir A1 revocada por id → rechazo explícito, no fallback.
    const revoked = selectDesktopTarget({
      requestingAccountId: ACCOUNT_A,
      targetPreference: { kind: 'specific', deviceId: A1 },
      accountDesktopList: list,
      isDesktopOnline: ONLINE,
    });
    expect(revoked).toEqual({ status: 'unavailable', reason: 'device_revoked' });
  });

  it('revocar A1 bloquea su reconexión como destino aunque vuelva a estar en línea', () => {
    const selection = selectDesktopTarget({
      requestingAccountId: ACCOUNT_A,
      targetPreference: { kind: 'specific', deviceId: A1 },
      accountDesktopList: [{ deviceId: A1, isRevoked: true }],
      isDesktopOnline: ONLINE,
    });
    expect(selection.status).toBe('unavailable');
    expect((selection as { reason: string }).reason).toBe('device_revoked');
  });

  it('una PC fuera de línea no recibe falsamente un resultado exitoso ni cae a otra PC', () => {
    const selection = selectDesktopTarget({
      requestingAccountId: ACCOUNT_A,
      targetPreference: { kind: 'specific', deviceId: A1 },
      accountDesktopList: [
        { deviceId: A1, isRevoked: false },
        { deviceId: A2, isRevoked: false },
      ],
      isDesktopOnline: (deviceId) => deviceId === A2,
    });
    expect(selection).toEqual({ status: 'unavailable', reason: 'target_unavailable' });
  });

  it('sin desktops de la cuenta no hay fallback a otra cuenta ni a producción', () => {
    const empty = selectDesktopTarget({
      requestingAccountId: ACCOUNT_B,
      targetPreference: { kind: 'any' },
      accountDesktopList: [],
      isDesktopOnline: ONLINE,
    });
    expect(empty).toEqual({ status: 'unavailable', reason: 'no_device' });
    // Con desktops pero todos desconectados → target_unavailable.
    const offline = selectDesktopTarget({
      requestingAccountId: ACCOUNT_A,
      targetPreference: { kind: 'any' },
      accountDesktopList: [{ deviceId: A1, isRevoked: false }],
      isDesktopOnline: () => false,
    });
    expect(offline).toEqual({ status: 'unavailable', reason: 'target_unavailable' });
  });
});
