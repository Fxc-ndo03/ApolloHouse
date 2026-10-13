import { requireAccountId } from '@/accounts/identity';

export type DesktopCandidate = {
  readonly deviceId: string;
  readonly isRevoked: boolean;
};

export type DesktopTargetPreference =
  | { readonly kind: 'any' }
  | { readonly kind: 'specific'; readonly deviceId: string };

export type DesktopTargetSelection =
  | { readonly status: 'resolved'; readonly deviceId: string }
  | {
      readonly status: 'unavailable';
      readonly reason: 'no_device' | 'device_revoked' | 'device_of_other_account' | 'target_unavailable';
    };

/**
 * Selección de la PC destino dentro de UNA cuenta (FASE 2.5).
 *
 * Reglas:
 *  - Sólo se consideran desktops del registro de ESA cuenta.
 *  - Un dispositivo revocado nunca es destino, ni siquiera pedido por id.
 *  - Un deviceId ajeno a la cuenta se RECHAZA (no se "encuentra otro").
 *  - `any` elige la PRIMERA candidata con conexión activa — nunca se ejecuta
 *    en todas las PC a la vez.
 *  - Si la candidata pedida existe pero no está en línea, el resultado es
 *    `target_unavailable` — nunca un éxito fingido ni un fallback a otra PC.
 */
export function selectDesktopTarget(input: {
  readonly requestingAccountId: string;
  readonly targetPreference: DesktopTargetPreference;
  readonly accountDesktopList: readonly DesktopCandidate[];
  readonly isDesktopOnline: (deviceId: string) => boolean;
}): DesktopTargetSelection {
  const requestingAccountId = requireAccountId(input.requestingAccountId);
  const ownedDesktopList = input.accountDesktopList.filter(
    (candidate) => !candidate.isRevoked,
  );

  if (input.targetPreference.kind === 'specific') {
    const requestedDeviceId = input.targetPreference.deviceId;
    const requested = input.accountDesktopList.find(
      (candidate) => candidate.deviceId === requestedDeviceId,
    );
    if (requested === undefined) {
      // Existe un deviceId pero NO pertenece a esta cuenta.
      return { status: 'unavailable', reason: 'device_of_other_account' };
    }
    if (requested.isRevoked) {
      return { status: 'unavailable', reason: 'device_revoked' };
    }
    if (!input.isDesktopOnline(requested.deviceId)) {
      return { status: 'unavailable', reason: 'target_unavailable' };
    }
    return { status: 'resolved', deviceId: requested.deviceId };
  }

  for (const candidate of ownedDesktopList) {
    if (input.isDesktopOnline(candidate.deviceId)) {
      return { status: 'resolved', deviceId: candidate.deviceId };
    }
  }
  return { status: 'unavailable', reason: ownedDesktopList.length === 0 ? 'no_device' : 'target_unavailable' };
}
