import { describe, expect, it } from 'bun:test';

import { authorizeDesktopHello } from '@/devices/desktop-authorization';

const ACCOUNT_A = 'acc_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const ACCOUNT_B = 'acc_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const PC_A = 'desktop:11111111-2222-3333-4444-555555555555';
const PC_B = 'desktop:99999999-8888-7777-6666-555555555555';

describe('autorización del hello de desktop (PcBridge)', () => {
  it('sesión de cuenta + dispositivo de esa cuenta → account_bound', () => {
    const identity = authorizeDesktopHello({
      sessionAccount: ACCOUNT_A,
      helloDeviceId: PC_A,
      deviceBinding: { accountId: ACCOUNT_A, isRevoked: false },
    });
    expect(identity).toEqual({
      status: 'account_bound',
      accountId: ACCOUNT_A,
      deviceId: PC_A,
    });
  });

  it('un dispositivo revocado se rechaza y no cae a legacy', () => {
    const identity = authorizeDesktopHello({
      sessionAccount: ACCOUNT_A,
      helloDeviceId: PC_A,
      deviceBinding: { accountId: ACCOUNT_A, isRevoked: true },
    });
    expect(identity).toEqual({ status: 'rejected', reason: 'device_revoked' });
  });

  it('el deviceId de OTRA cuenta se rechaza (suplantación)', () => {
    const identity = authorizeDesktopHello({
      sessionAccount: ACCOUNT_A,
      helloDeviceId: PC_B,
      deviceBinding: { accountId: ACCOUNT_B, isRevoked: false },
    });
    expect(identity).toEqual({ status: 'rejected', reason: 'device_of_other_account' });
  });

  it('un deviceId con formato inválido se rechaza, nunca se acepta como legacy con cuenta', () => {
    const identity = authorizeDesktopHello({
      sessionAccount: ACCOUNT_A,
      helloDeviceId: 'COMPUTERNAME',
      deviceBinding: null,
    });
    expect(identity).toEqual({ status: 'rejected', reason: 'device_id_invalid' });
  });

  it('sin sesión de cuenta → legacy explícito, sin binding de cuenta', () => {
    expect(
      authorizeDesktopHello({
        sessionAccount: null,
        helloDeviceId: PC_A,
        deviceBinding: { accountId: ACCOUNT_A, isRevoked: false },
      }),
    ).toEqual({ status: 'legacy', reason: 'no_session' });
    // Sesión válida pero dispositivo no enrolado en el registro → legacy, no
    // binding: el cliente no crea autoridad declarando un deviceId.
    expect(
      authorizeDesktopHello({
        sessionAccount: ACCOUNT_A,
        helloDeviceId: PC_A,
        deviceBinding: null,
      }),
    ).toEqual({ status: 'legacy', reason: 'device_unbound' });
  });

  it('legacy jamás queda asociado a una cuenta', () => {
    for (const reason of ['no_session', 'device_unbound'] as const) {
      const identity = authorizeDesktopHello({
        sessionAccount: reason === 'no_session' ? null : ACCOUNT_A,
        helloDeviceId: PC_A,
        deviceBinding: null,
      });
      expect(identity.status).toBe('legacy');
      expect('accountId' in identity).toBe(false);
    }
  });
});
