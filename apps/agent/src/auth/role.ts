import { isDeviceSharedSecretValid, readDeviceTokenFromRequestUrl } from '@/auth/token';

export type ApolloConnectionRole = 'device' | 'dashboard' | 'pc_visual';

export const DEVICE_CONNECTION_TAG: ApolloConnectionRole = 'device';
export const PC_VISUAL_CONNECTION_TAG: ApolloConnectionRole = 'pc_visual';

/**
 * Tag de un nodo que se identifica con credencial individual y resulto ser el
 * dueno de la instancia a la que se conecto.
 *
 * Lo exporta `auth/role.ts` y no `agents/apollo.ts` porque es un valor de
 * autorizacion compartido: el que lo emite y el que lo consume tienen que
 * poder compararlo sin importar de donde viene.
 */
export const ENROLLED_DEVICE_CONNECTION_TAG = 'enrolled_device';

export function hasDeviceConnectionTag(connectionTagList: readonly string[]): boolean {
  return connectionTagList.includes(DEVICE_CONNECTION_TAG);
}

export function hasEnrolledDeviceConnectionTag(connectionTagList: readonly string[]): boolean {
  return connectionTagList.includes(ENROLLED_DEVICE_CONNECTION_TAG);
}

export function hasPcVisualConnectionTag(connectionTagList: readonly string[]): boolean {
  return connectionTagList.includes(PC_VISUAL_CONNECTION_TAG);
}

export async function resolveApolloConnectionRole(
  requestUrl: URL,
  environment: Env,
): Promise<ApolloConnectionRole | null> {
  const presentedToken = readDeviceTokenFromRequestUrl(requestUrl);
  if (await isDeviceSharedSecretValid(presentedToken, environment.DEVICE_SHARED_SECRET)) {
    return 'device';
  }
  if (
    await isDeviceSharedSecretValid(presentedToken, environment.DASHBOARD_SHARED_SECRET)
  ) {
    return 'dashboard';
  }
  return null;
}
