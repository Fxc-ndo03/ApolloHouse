import { isDeviceSharedSecretValid, readDeviceTokenFromRequestUrl } from '@/auth/token';

export type ApolloConnectionRole = 'device' | 'dashboard' | 'pc_visual';

export const DEVICE_CONNECTION_TAG: ApolloConnectionRole = 'device';
export const PC_VISUAL_CONNECTION_TAG: ApolloConnectionRole = 'pc_visual';

export function hasDeviceConnectionTag(connectionTagList: readonly string[]): boolean {
  return connectionTagList.includes(DEVICE_CONNECTION_TAG);
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
