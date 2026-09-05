import { describe, expect, it } from 'bun:test';

import {
  createFakeApolloEnvironment,
  createFakeStorageBucket,
} from '@/configuration/testing';
import { FIRMWARE_MANIFEST_OBJECT_KEY } from '@/ota/manifest';
import { handleOtaRequest } from '@/ota/routes';
import type { StorageBucket } from '@/storage/local';

const FIRMWARE_BINARY_CONTENT = 'pretend-firmware-bytes';

function createEnvironmentWithFirmware(): Env & { STORAGE: StorageBucket } {
  return {
    ...createFakeApolloEnvironment(),
    STORAGE: createFakeStorageBucket({
      [FIRMWARE_MANIFEST_OBJECT_KEY]: JSON.stringify({
        version: '2.5.0',
        key: 'firmware/apollo-2.5.0.bin',
      }),
      'firmware/apollo-2.5.0.bin': FIRMWARE_BINARY_CONTENT,
    }),
  } as Env & { STORAGE: StorageBucket };
}

async function performOtaRequest(
  environment: Env & { STORAGE: StorageBucket },
  path: string,
  method = 'GET',
): Promise<Response> {
  const requestUrl = new URL(`https://apollo.example${path}`);
  return handleOtaRequest(
    new Request(requestUrl, { method }),
    requestUrl,
    environment,
    environment.STORAGE,
  );
}

describe('ota routes', () => {
  it('rejects a missing or wrong token on both paths', async () => {
    const environment = createEnvironmentWithFirmware();
    expect((await performOtaRequest(environment, '/ota/check')).status).toBe(401);
    expect((await performOtaRequest(environment, '/ota/check?token=wrong')).status).toBe(
      401,
    );
    expect(
      (await performOtaRequest(environment, '/ota/firmware.bin?token=wrong')).status,
    ).toBe(401);
  });

  it('answers the check with the manifest version and a tokenized binary url', async () => {
    const checkResponse = await performOtaRequest(
      createEnvironmentWithFirmware(),
      '/ota/check?token=secret',
      'POST',
    );
    expect(checkResponse.status).toBe(200);
    await expect(checkResponse.json()).resolves.toEqual({
      firmware: {
        version: '2.5.0',
        url: 'https://apollo.example/ota/firmware.bin?token=secret',
        force: 0,
      },
    });
  });

  it('answers the check with an empty object when no manifest is published', async () => {
    const environment = {
      ...createFakeApolloEnvironment(),
      STORAGE: createFakeStorageBucket(),
    } as Env & { STORAGE: StorageBucket };
    const checkResponse = await performOtaRequest(environment, '/ota/check?token=secret');
    expect(checkResponse.status).toBe(200);
    await expect(checkResponse.json()).resolves.toEqual({});
  });

  it('serves the firmware binary with an explicit content length', async () => {
    const binaryResponse = await performOtaRequest(
      createEnvironmentWithFirmware(),
      '/ota/firmware.bin?token=secret',
    );
    expect(binaryResponse.status).toBe(200);
    expect(binaryResponse.headers.get('Content-Length')).toBe(
      String(FIRMWARE_BINARY_CONTENT.length),
    );
    expect(binaryResponse.headers.get('Content-Type')).toBe('application/octet-stream');
    await expect(binaryResponse.text()).resolves.toBe(FIRMWARE_BINARY_CONTENT);
  });

  it('returns 404 when the manifest points at a missing binary', async () => {
    const environment = {
      ...createFakeApolloEnvironment(),
      STORAGE: createFakeStorageBucket({
        [FIRMWARE_MANIFEST_OBJECT_KEY]: JSON.stringify({
          version: '2.5.0',
          key: 'firmware/not-uploaded.bin',
        }),
      }),
    } as Env & { STORAGE: StorageBucket };
    expect(
      (await performOtaRequest(environment, '/ota/firmware.bin?token=secret')).status,
    ).toBe(404);
  });

  it('returns 404 for unknown ota paths', async () => {
    expect(
      (await performOtaRequest(createEnvironmentWithFirmware(), '/ota/nope?token=secret'))
        .status,
    ).toBe(404);
  });
});
