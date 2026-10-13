import { requireAccountId, requireDeviceId } from '@/accounts/identity';
import { isDeviceCredentialToken } from '@/accounts/session';

export type DesktopDeviceBinding = {
  readonly accountId: string | null;
  readonly isRevoked: boolean;
};

export type DesktopHelloIdentity =
  | {
      readonly status: 'account_bound';
      readonly accountId: string;
      readonly deviceId: string;
    }
  | {
      readonly status: 'legacy';
      readonly reason: 'no_session' | 'device_unbound';
    }
  | {
      readonly status: 'rejected';
      readonly reason: 'device_revoked' | 'device_of_other_account' | 'device_id_invalid';
    };

/**
 * Autorización del `hello` de una PC contra el PcBridge.
 *
 * Regla única: la sesión representa a la cuenta; el `deviceId` que la PC
 * declara es una afirmación del cliente y sólo vale si el binding del
 * registro dice que ese dispositivo pertenece a esa cuenta y no está
 * revocado. Sin sesión de cuenta no hay binding: el camino legacy sigue
 * existiendo pero jamás queda asociado a una cuenta.
 */
export function authorizeDesktopHello(input: {
  readonly sessionAccount: string | null;
  readonly helloDeviceId: string | null;
  readonly deviceBinding: DesktopDeviceBinding | null;
}): DesktopHelloIdentity {
  if (input.sessionAccount === null) {
    return { status: 'legacy', reason: 'no_session' };
  }
  const accountId = requireAccountId(input.sessionAccount);
  if (input.helloDeviceId === null) {
    return { status: 'legacy', reason: 'device_unbound' };
  }
  let deviceId: string;
  try {
    deviceId = requireDeviceId(input.helloDeviceId);
  } catch {
    return { status: 'rejected', reason: 'device_id_invalid' };
  }
  if (input.deviceBinding === null) {
    return { status: 'legacy', reason: 'device_unbound' };
  }
  if (input.deviceBinding.isRevoked) {
    return { status: 'rejected', reason: 'device_revoked' };
  }
  if (input.deviceBinding.accountId === null) {
    return { status: 'legacy', reason: 'device_unbound' };
  }
  if (input.deviceBinding.accountId !== accountId) {
    return { status: 'rejected', reason: 'device_of_other_account' };
  }
  return { status: 'account_bound', accountId, deviceId };
}

/** El bearer de sesión nunca es una credencial de dispositivo y viceversa. */
export function isSessionShapedBearer(bearer: string | null): boolean {
  return bearer !== null && bearer.length >= 32 && !isDeviceCredentialToken(bearer);
}
