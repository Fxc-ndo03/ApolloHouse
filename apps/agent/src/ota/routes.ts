import { isDeviceSharedSecretValid, readDeviceTokenFromRequestUrl } from '@/auth/token';
import { readFirmwareManifest } from '@/ota/manifest';
import type { StorageBucket } from '@/storage/local';

async function getGlobalFirmwareManifest(
  environment: Env,
  storageBucketOverride?: StorageBucket,
) {
  if (storageBucketOverride !== undefined) {
    return readFirmwareManifest(storageBucketOverride);
  }
  const { getAgentByName } = await import('agents');
  const apollo = await getAgentByName(environment.Apollo, 'global-ota');
  return apollo.readFirmwareManifestRpc();
}

async function getGlobalFirmwareObject(
  environment: Env,
  key: string,
  storageBucketOverride?: StorageBucket,
): Promise<{ arrayBuffer(): Promise<ArrayBuffer>; size: number } | null> {
  if (storageBucketOverride !== undefined) {
    return storageBucketOverride.get(key);
  }
  const { getAgentByName } = await import('agents');
  const apollo = await getAgentByName(environment.Apollo, 'global-ota');
  const result = await apollo.readFirmwareObjectRpc({ key });
  if (result === null) return null;
  const buffer = new TextEncoder().encode(result.content).buffer as ArrayBuffer;
  return {
    size: result.size,
    async arrayBuffer(): Promise<ArrayBuffer> {
      return buffer;
    },
  };
}

export async function handleOtaRequest(
  request: Request,
  requestUrl: URL,
  environment: Env,
  storageBucketOverride?: StorageBucket,
): Promise<Response> {
  const presentedToken = readDeviceTokenFromRequestUrl(requestUrl);
  const isAuthorized = await isDeviceSharedSecretValid(
    presentedToken,
    environment.DEVICE_SHARED_SECRET,
  );
  if (!isAuthorized || presentedToken === null) {
    return new Response('Unauthorized', { status: 401 });
  }

  // The device POSTs its system-info JSON on the check; the body is irrelevant
  // to the answer, so both methods are accepted and the body is ignored.
  if (requestUrl.pathname === '/ota/check') {
    return respondWithVersionCheck(
      requestUrl,
      presentedToken,
      environment,
      storageBucketOverride,
    );
  }
  if (requestUrl.pathname === '/ota/firmware.bin' && request.method === 'GET') {
    return respondWithFirmwareBinary(environment, storageBucketOverride);
  }
  return new Response('Not found', { status: 404 });
}

async function respondWithVersionCheck(
  requestUrl: URL,
  presentedToken: string,
  environment: Env,
  storageBucketOverride?: StorageBucket,
): Promise<Response> {
  const firmwareManifest = await getGlobalFirmwareManifest(
    environment,
    storageBucketOverride,
  );
  if (firmwareManifest === undefined) {
    return Response.json({});
  }
  // The device fetches this URL verbatim with a bare HTTP client (no auth
  // seam), so the token rides in the query like the websocket URL does.
  const firmwareBinaryUrl = new URL('/ota/firmware.bin', requestUrl.origin);
  firmwareBinaryUrl.searchParams.set('token', presentedToken);
  return Response.json({
    firmware: {
      version: firmwareManifest.version,
      url: firmwareBinaryUrl.toString(),
      force: 0,
    },
  });
}

async function respondWithFirmwareBinary(
  environment: Env,
  storageBucketOverride?: StorageBucket,
): Promise<Response> {
  const firmwareManifest = await getGlobalFirmwareManifest(
    environment,
    storageBucketOverride,
  );
  if (firmwareManifest === undefined) {
    return new Response('No firmware published', { status: 404 });
  }
  const firmwareObject = await getGlobalFirmwareObject(
    environment,
    firmwareManifest.key,
    storageBucketOverride,
  );
  if (firmwareObject === null) {
    return new Response('Firmware binary missing', { status: 404 });
  }
  // The device's Ota::Upgrade aborts on a missing Content-Length and uses it
  // for download progress, so the size header is mandatory.
  const arrayBuffer = await firmwareObject.arrayBuffer();
  return new Response(arrayBuffer, {
    headers: {
      'Content-Length': String(firmwareObject.size),
      'Content-Type': 'application/octet-stream',
    },
  });
}
