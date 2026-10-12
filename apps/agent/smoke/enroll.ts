// ─────────────────────────────────────────────────────────────────────────────
// BLOCK 12.1: enrolar un teléfono de smoke por el flujo real.
//
// Los smokes de Block 10 conectaban con `?token=DEVICE_SHARED_SECRET`. Desde
// BLOCK 12.1 §3 una identidad mobile no enrolada ya no puede entrar por ese
// camino, así que los smokes hacen enrollment de verdad: piden un desafío atado a
// su deviceId, lo canjean, y abren el socket con `Authorization: Bearer`.
//
// Esto NO reemplaza la autenticación de producción por un atajo: usa los mismos
// endpoints HTTP, el mismo código de verificación y el mismo registro que un
// teléfono real. Lo único que se evita es el paso manual de pegar el desafío.
//
// Lo que NO cambia: las llamadas que no son un dispositivo -- el RPC del bridge,
// el inspector y el harness -- siguen usando `?token=`, porque no mandan `hello`
// y no son una identidad mobile.
// ─────────────────────────────────────────────────────────────────────────────

const BRIDGE_PATH = '/agents/mobile-bridge/mobile';

export const SMOKE_DASHBOARD_SHARED_SECRET =
  process.env['DASHBOARD_SHARED_SECRET'] ?? 'block-8-2-smoke-dashboard-secret';

export type EnrolledSmokeDevice = {
  readonly deviceId: string;
  readonly credential: string;
};

/**
 * Enrola un deviceId de smoke. El desafío lo pide el "dueño" con el rol dashboard,
 * que es exactamente el paso que un operador hace a mano.
 */
export async function enrollSmokeDevice(input: {
  readonly workerBaseUrl: string;
  readonly deviceId: string;
}): Promise<EnrolledSmokeDevice> {
  const httpBase = input.workerBaseUrl.replace(/^ws/, 'http');
  const challengeResponse = await fetch(
    `${httpBase}${BRIDGE_PATH}/enrollment/challenge`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${SMOKE_DASHBOARD_SHARED_SECRET}`,
      },
      body: JSON.stringify({ deviceId: input.deviceId }),
    },
  );
  if (!challengeResponse.ok) {
    throw new Error(
      `no se pudo pedir el desafio de ${input.deviceId}: ${challengeResponse.status}`,
    );
  }
  const { challenge } = (await challengeResponse.json()) as { challenge: string };

  const claimResponse = await fetch(`${httpBase}${BRIDGE_PATH}/enrollment/claim`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ challenge, deviceId: input.deviceId }),
  });
  const claim = (await claimResponse.json()) as {
    status: string;
    credential?: string;
    reason?: string;
  };
  if (claim.status !== 'enrolled' || typeof claim.credential !== 'string') {
    throw new Error(
      `no se pudo enrolar ${input.deviceId}: ${claim.status}/${String(claim.reason)}`,
    );
  }
  return { deviceId: input.deviceId, credential: claim.credential };
}

/** El header del socket de dispositivo. La credencial nunca va en la URL. */
export function buildDeviceAuthorizationHeader(
  credential: string,
): Record<string, string> {
  return { Authorization: `Bearer ${credential}` };
}
