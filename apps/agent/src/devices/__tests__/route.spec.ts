import { describe, expect, it } from 'bun:test';

import {
  authorizeMobileDeviceRequest,
  MOBILE_BRIDGE_AGENT_NAME,
  MOBILE_BRIDGE_ROUTE_PREFIX,
  resolveMobileBridgeRoute,
  resolveMobileBridgeStub,
} from '@/devices/route';

// BLOCK 12: `authorizeMobileDeviceRequest` ahora recibe la autoridad de
// credenciales, porque el ámbito se decide antes de tocar nada. Estos casos de
// Block 8.1 probaban todos el camino legacy (`?token=`), que no la necesita, así
// que el doble devuelve un deviceId cualquiera. Los casos per-device viven en
// `enrollment.spec.ts` y `revocation.spec.ts`.
async function authorize(request: Request): Promise<Response | undefined> {
  const decision = await authorizeMobileDeviceRequest({
    request,
    environment: ENVIRONMENT,
  });
  return decision.isAuthorized ? undefined : decision.response;
}
import { MOBILE_BRIDGE_INSTANCE_NAME } from '@/devices/bridge-client';

// ─────────────────────────────────────────────────────────────────────────────
// Route + upgrade (§2, §3, §11).
//
// El módulo de ruta es puro: no importa el SDK de agents, así que la decisión
// "esto es una conexión mobile" y el límite de autenticación se testean sin
// workerd. Lo que NO se puede probar bajo bun es el upgrade real del Durable
// Object, porque la clase del DO importa `cloudflare:` a través del SDK.
// ─────────────────────────────────────────────────────────────────────────────

// Los secrets son bindings del Worker (`wrangler secret put`), no valores del
// repo: el test define los suyos y los pasa por Env.
const TEST_DEVICE_SHARED_SECRET = 'test-device-shared-secret';
const TEST_DASHBOARD_SHARED_SECRET = 'test-dashboard-shared-secret';

const ENVIRONMENT = {
  DEVICE_SHARED_SECRET: TEST_DEVICE_SHARED_SECRET,
  DASHBOARD_SHARED_SECRET: TEST_DASHBOARD_SHARED_SECRET,
} as unknown as Env;

function buildUpgradeRequest(pathname: string, token?: string): Request {
  const url = new URL(`https://apollo.example${pathname}`);
  if (token !== undefined) {
    url.searchParams.set('token', token);
  }
  return new Request(url.toString(), { headers: { Upgrade: 'websocket' } });
}

describe('B8.1 §1: route resolution', () => {
  it('a websocket upgrade on the mobile route is a mobile connection', () => {
    const decision = resolveMobileBridgeRoute({
      pathname: `${MOBILE_BRIDGE_ROUTE_PREFIX}/${MOBILE_BRIDGE_INSTANCE_NAME}`,
      upgradeHeader: 'websocket',
    });
    expect(decision).toEqual({
      isMobileBridgeRoute: true,
      instanceName: MOBILE_BRIDGE_INSTANCE_NAME,
    });
  });

  it('the upgrade header is matched case-insensitively', () => {
    expect(
      resolveMobileBridgeRoute({
        pathname: `${MOBILE_BRIDGE_ROUTE_PREFIX}/mobile`,
        upgradeHeader: 'WebSocket',
      }).isMobileBridgeRoute,
    ).toBe(true);
  });

  it('a plain HTTP request on the mobile route is not a device connection', () => {
    expect(
      resolveMobileBridgeRoute({
        pathname: `${MOBILE_BRIDGE_ROUTE_PREFIX}/mobile`,
        upgradeHeader: null,
      }),
    ).toEqual({ isMobileBridgeRoute: false });
    expect(
      resolveMobileBridgeRoute({
        pathname: `${MOBILE_BRIDGE_ROUTE_PREFIX}/mobile`,
        upgradeHeader: 'h2c',
      }).isMobileBridgeRoute,
    ).toBe(false);
  });

  it('the desktop routes are NOT mobile routes', () => {
    // PcBridge y Apollo deben seguir yendo por routeAgentRequest, sin tocar.
    for (const pathname of [
      '/agents/apollo/default',
      '/agents/apollo/desk',
      '/agents/pc-bridge/pc-bridge',
      '/health',
      '/ota/',
    ]) {
      expect(resolveMobileBridgeRoute({ pathname, upgradeHeader: 'websocket' })).toEqual({
        isMobileBridgeRoute: false,
      });
    }
  });

  it('a mobile route without an instance name is not routable', () => {
    expect(
      resolveMobileBridgeRoute({
        pathname: MOBILE_BRIDGE_ROUTE_PREFIX,
        upgradeHeader: 'websocket',
      }),
    ).toEqual({ isMobileBridgeRoute: false });
    expect(
      resolveMobileBridgeRoute({
        pathname: `${MOBILE_BRIDGE_ROUTE_PREFIX}/`,
        upgradeHeader: 'websocket',
      }),
    ).toEqual({ isMobileBridgeRoute: false });
  });

  it('a lookalike route does not match', () => {
    expect(
      resolveMobileBridgeRoute({
        pathname: `/agents/${MOBILE_BRIDGE_AGENT_NAME}-evil/mobile`,
        upgradeHeader: 'websocket',
      }),
    ).toEqual({ isMobileBridgeRoute: false });
  });

  it('the bridge stub is a single shared instance, not one per device', () => {
    const requestedNameList: string[] = [];
    const environment = {
      MobileBridge: {
        idFromName: (name: string) => {
          requestedNameList.push(name);
          return { name: 'id' };
        },
        get: (id: unknown) => ({ fetch: () => new Response('stub'), id }),
      },
    } as unknown as Env;
    resolveMobileBridgeStub(environment);
    resolveMobileBridgeStub(environment);
    // Ambas veces el mismo nombre de instancia: una sola identidad lógica.
    expect(requestedNameList).toEqual([
      MOBILE_BRIDGE_INSTANCE_NAME,
      MOBILE_BRIDGE_INSTANCE_NAME,
    ]);
  });
});

describe('B8.1 §3: authentication boundary', () => {
  it('a device token authorizes the mobile endpoint', async () => {
    const response = await authorize(
      buildUpgradeRequest(
        `${MOBILE_BRIDGE_ROUTE_PREFIX}/mobile`,
        TEST_DEVICE_SHARED_SECRET,
      ),
    );
    expect(response).toBeUndefined();
  });

  it('a missing token is rejected with 401', async () => {
    const response = await authorize(
      buildUpgradeRequest(`${MOBILE_BRIDGE_ROUTE_PREFIX}/mobile`),
    );
    expect(response?.status).toBe(401);
  });

  it('a wrong token is rejected with 401', async () => {
    const response = await authorize(
      buildUpgradeRequest(`${MOBILE_BRIDGE_ROUTE_PREFIX}/mobile`, 'not-the-secret'),
    );
    expect(response?.status).toBe(401);
  });

  it('a dashboard token does NOT open a device socket', async () => {
    // El dashboard abre la consola, no un dispositivo. Mobile exige 'device'.
    const response = await authorize(
      buildUpgradeRequest(
        `${MOBILE_BRIDGE_ROUTE_PREFIX}/mobile`,
        TEST_DASHBOARD_SHARED_SECRET,
      ),
    );
    expect(response?.status).toBe(401);
  });

  it('a deviceId in the query does not authenticate anything', async () => {
    const url = new URL(
      `https://apollo.example${MOBILE_BRIDGE_ROUTE_PREFIX}/mobile?deviceId=mobile:phone-123`,
    );
    const response = await authorize(
      new Request(url.toString(), { headers: { Upgrade: 'websocket' } }),
    );
    expect(response?.status).toBe(401);
  });

  it('the auth decision never echoes the presented secret', async () => {
    const response = await authorize(
      buildUpgradeRequest(`${MOBILE_BRIDGE_ROUTE_PREFIX}/mobile`, 'leaked-secret-value'),
    );
    expect(response?.status).toBe(401);
    expect(await response?.text()).toBe('Unauthorized');
    expect(JSON.stringify([...(response?.headers ?? [])])).not.toContain(
      'leaked-secret-value',
    );
  });
});
