import { describe, expect, it } from 'bun:test';

import { MobileDeviceEndpoint } from '@/devices/endpoint';
import {
  authorizeMobileDeviceRequest,
  MOBILE_BRIDGE_ROUTE_PREFIX,
  resolveMobileBridgeRoute,
} from '@/devices/route';
import { MOBILE_BRIDGE_INSTANCE_NAME } from '@/devices/bridge-client';
import { buildAuthenticatedDeviceProof } from '@/devices/registry';
import { PRESENCE_OFFLINE_AFTER_MILLISECONDS } from '@/devices/presence';
import type { HeartbeatTimerHandle, HeartbeatTimerPort } from '@/devices/heartbeat';

// ─────────────────────────────────────────────────────────────────────────────
// Integration del endpoint mobile (§10, §11).
//
// Recorre el camino completo: request HTTP -> decisión de ruta -> upgrade ->
// auth boundary -> MobilePeerTransport -> DeviceSessionLifecycle -> Registry.
// Lo único inyectado es el socket (una primitiva de la plataforma) y el timer;
// el registry, el lifecycle, el transport y la ruta son los de producción.
//
// Lo que NO entra acá es el upgrade real del Durable Object: la clase del DO
// importa `cloudflare:` a través del SDK de agents y no se puede cargar bajo
// bun. route.spec.ts cubre la decisión de ruta y esta spec cubre el endpoint.
// ─────────────────────────────────────────────────────────────────────────────

const TEST_DEVICE_SHARED_SECRET = 'test-device-shared-secret';
const TEST_DASHBOARD_SHARED_SECRET = 'test-dashboard-shared-secret';
const START = 1_700_000_000_000;

const ENVIRONMENT = {
  DEVICE_SHARED_SECRET: TEST_DEVICE_SHARED_SECRET,
  DASHBOARD_SHARED_SECRET: TEST_DASHBOARD_SHARED_SECRET,
} as unknown as Env;

class FakeWebSocket {
  readonly sentMessageList: string[] = [];
  closeCallCount = 0;

  send(messageText: string): void {
    this.sentMessageList.push(messageText);
  }

  close(): void {
    this.closeCallCount += 1;
  }

  listParsedMessageList(): Record<string, unknown>[] {
    return this.sentMessageList.map(
      (messageText) => JSON.parse(messageText) as Record<string, unknown>,
    );
  }
}

class CountingTimerPort implements HeartbeatTimerPort {
  #nextHandle = 1;
  readonly #activeHandleSet = new Set<number>();
  createdCount = 0;

  setInterval(): HeartbeatTimerHandle {
    this.createdCount += 1;
    const handle = this.#nextHandle;
    this.#nextHandle += 1;
    this.#activeHandleSet.add(handle);
    return handle;
  }

  clearInterval(handle: HeartbeatTimerHandle): void {
    this.#activeHandleSet.delete(handle as number);
  }

  get activeCount(): number {
    return this.#activeHandleSet.size;
  }
}

function buildHello(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'hello',
    deviceId: 'mobile:phone-123',
    deviceType: 'mobile',
    protocolVersion: 1,
    capabilities: ['mobile.notifications'],
    ts: START,
    ...overrides,
  });
}

type Harness = {
  readonly endpoint: MobileDeviceEndpoint;
  readonly timerPort: CountingTimerPort;
  readonly setNow: (value: number) => void;
};

function buildEndpoint(now: number = START): Harness {
  let current = now;
  const timerPort = new CountingTimerPort();
  const endpoint = new MobileDeviceEndpoint({
    nowMilliseconds: () => current,
    timerPort,
  });
  return { endpoint, timerPort, setNow: (value: number) => (current = value) };
}

// El request real que haría el teléfono, pasado por la decisión de ruta y por el
// límite de autenticación, antes de tocar el endpoint.
async function authorizeUpgrade(
  pathname: string,
  token: string | null,
): Promise<Response | undefined> {
  const routeDecision = resolveMobileBridgeRoute({
    pathname,
    upgradeHeader: 'websocket',
  });
  if (!routeDecision.isMobileBridgeRoute) {
    return new Response('Not a mobile route', { status: 404 });
  }
  const url = new URL(`https://apollo.example${pathname}`);
  if (token !== null) {
    url.searchParams.set('token', token);
  }
  const authDecision = await authorizeMobileDeviceRequest({
    request: new Request(url.toString(), { headers: { Upgrade: 'websocket' } }),
    environment: ENVIRONMENT,
  });
  return authDecision.isAuthorized ? undefined : authDecision.response;
}

function connectAuthorized(
  endpoint: MobileDeviceEndpoint,
  connectionId: string,
): FakeWebSocket {
  const socket = new FakeWebSocket();
  endpoint.handleConnect({
    connectionId,
    port: socket,
    proof: buildAuthenticatedDeviceProof('device'),
  });
  return socket;
}

describe('B8.1 §2+§11: request -> route -> upgrade -> session -> registry', () => {
  it('the full happy path registers an authenticated session', async () => {
    // 1. request + route
    expect(
      await authorizeUpgrade(
        `${MOBILE_BRIDGE_ROUTE_PREFIX}/${MOBILE_BRIDGE_INSTANCE_NAME}`,
        TEST_DEVICE_SHARED_SECRET,
      ),
    ).toBeUndefined();

    // 2. upgrade: el socket aparece y todavía NO es un dispositivo.
    const harness = buildEndpoint();
    const socket = connectAuthorized(harness.endpoint, 'mobile-1');
    expect(harness.endpoint.listConnectedCount()).toBe(1);
    expect(harness.endpoint.registry.listDeviceList()).toHaveLength(0);

    // 3. mobile hello autenticado
    harness.endpoint.handleMessage('mobile-1', buildHello());
    const accepted = socket.listParsedMessageList()[0];
    expect(accepted?.['type']).toBe('hello_accepted');

    // 4. sesión en el registry
    const session = harness.endpoint.registry.getDevice('mobile:phone-123');
    expect(session?.authenticated).toBe(true);
    expect(session?.transport.transportKind).toBe('mobile_websocket');
    expect(session?.transport.connectionId).toBe('mobile-1');
    expect(session?.presence).toBe('online');
    expect(session?.connectedAt).toBe(START);

    // 5. heartbeat scheduler por sesión
    expect(harness.timerPort.activeCount).toBe(1);
  });

  it('7. invalid auth never produces a session', async () => {
    // Sin token el borde corta antes del upgrade.
    expect(
      (await authorizeUpgrade(`${MOBILE_BRIDGE_ROUTE_PREFIX}/mobile`, null))?.status,
    ).toBe(401);

    // Y si el socket llegara sin proof igual, el handshake no registra nada.
    const harness = buildEndpoint();
    const socket = new FakeWebSocket();
    harness.endpoint.handleConnect({
      connectionId: 'mobile-1',
      port: socket,
      proof: null,
    });
    harness.endpoint.handleMessage('mobile-1', buildHello());
    expect(harness.endpoint.registry.listDeviceList()).toHaveLength(0);
    expect(socket.listParsedMessageList()[0]?.['type']).toBe('hello_rejected');
    expect(harness.timerPort.activeCount).toBe(0);
  });

  it('8. a malformed hello is rejected without a session', async () => {
    const harness = buildEndpoint();
    const socket = connectAuthorized(harness.endpoint, 'mobile-1');
    for (const malformed of [
      JSON.stringify({ type: 'hello' }),
      JSON.stringify({ type: 'hello', deviceId: 'mobile:x', ts: START }),
    ]) {
      harness.endpoint.handleMessage('mobile-1', malformed);
    }
    expect(harness.endpoint.registry.listDeviceList()).toHaveLength(0);
    expect(harness.timerPort.activeCount).toBe(0);
    // El socket sigue vivo: un mensaje malo no cierra la conexión.
    expect(harness.endpoint.listConnectedCount()).toBe(1);
    // Los dos hellos inválidos reciben el motivo.
    expect(socket.listParsedMessageList()).toHaveLength(2);
    expect(
      socket
        .listParsedMessageList()
        .every((message) => message['type'] === 'hello_rejected'),
    ).toBe(true);
  });

  it('a non-hello malformed message is ignored in silence', () => {
    const harness = buildEndpoint();
    const socket = connectAuthorized(harness.endpoint, 'mobile-1');
    harness.endpoint.handleMessage('mobile-1', 'not json at all');
    harness.endpoint.handleMessage('mobile-1', JSON.stringify({ type: 'garbage' }));
    expect(harness.endpoint.registry.listDeviceList()).toHaveLength(0);
    expect(harness.endpoint.listConnectedCount()).toBe(1);
    expect(socket.sentMessageList).toHaveLength(0);
  });

  it('9. a wrong deviceType is rejected', () => {
    const harness = buildEndpoint();
    const socket = connectAuthorized(harness.endpoint, 'mobile-1');
    // El hello mobile exige deviceType 'mobile' literal: 'desktop' no entra al
    // contrato y el device recibe hello_rejected.
    harness.endpoint.handleMessage('mobile-1', buildHello({ deviceType: 'desktop' }));
    expect(harness.endpoint.registry.listDeviceList()).toHaveLength(0);
    expect(socket.listParsedMessageList()[0]?.['type']).toBe('hello_rejected');
    expect(socket.listParsedMessageList()[0]?.['reason']).toBe('malformed_hello');

    // Y un deviceId de desktop con deviceType mobile cae en la validación de
    // identidad, con su propio motivo.
    harness.endpoint.handleMessage('mobile-1', buildHello({ deviceId: 'desktop:pc' }));
    expect(harness.endpoint.registry.listDeviceList()).toHaveLength(0);
    expect(String(socket.listParsedMessageList()[1]?.['reason'])).toContain(
      'device_id_type_mismatch',
    );
  });

  it('10. a hostname-derived mobile identity is rejected', async () => {
    const harness = buildEndpoint();
    connectAuthorized(harness.endpoint, 'mobile-1');
    // El endpoint nunca fabrica una identidad legacy: el hello mobile no puede
    // declararla, y el registry la rechaza si alguien lo intenta por abajo.
    const hello = JSON.parse(buildHello()) as Record<string, unknown>;
    hello['hostname'] = 'PC-ESTUDIO';
    harness.endpoint.handleMessage('mobile-1', JSON.stringify(hello));
    expect(harness.endpoint.registry.getDevice('mobile:phone-123')?.identitySource).toBe(
      'client_provided',
    );

    const legacy = harness.endpoint.registry.register({
      proof: buildAuthenticatedDeviceProof('device'),
      deviceId: 'mobile:PC-ESTUDIO',
      deviceType: 'mobile',
      capabilityNameList: ['mobile.alarm'],
      protocolVersion: 1,
      identitySource: 'desktop_hostname_legacy',
      transport: { transportKind: 'mobile_websocket', connectionId: 'mobile-9' },
    });
    expect(legacy.status).toBe('rejected');
  });

  it('11. an unsupported protocol version never negotiates a partial session', async () => {
    const harness = buildEndpoint();
    const socket = connectAuthorized(harness.endpoint, 'mobile-1');
    harness.endpoint.handleMessage('mobile-1', buildHello({ protocolVersion: 999 }));
    expect(harness.endpoint.registry.listDeviceList()).toHaveLength(0);
    const rejection = socket.listParsedMessageList()[0];
    expect(rejection?.['type']).toBe('hello_rejected');
    expect(String(rejection?.['reason'])).toContain('protocolVersion incompatible');
    // Ni scheduler, ni presencia: una negociación fallida no deja rastro.
    expect(harness.timerPort.activeCount).toBe(0);
    expect(harness.endpoint.lifecycle.listHeartbeatSchedulerCount()).toBe(0);
  });

  it('4. a heartbeat from a connected mobile updates lastSeenAt', async () => {
    const harness = buildEndpoint();
    connectAuthorized(harness.endpoint, 'mobile-1');
    harness.endpoint.handleMessage('mobile-1', buildHello());
    harness.endpoint.handleMessage(
      'mobile-1',
      JSON.stringify({ type: 'heartbeat', ts: START + 30_000 }),
    );
    expect(harness.endpoint.registry.getDevice('mobile:phone-123')?.lastSeenAt).toBe(
      START + 30_000,
    );
  });

  it('a heartbeat before the hello does not create anything', async () => {
    const harness = buildEndpoint();
    connectAuthorized(harness.endpoint, 'mobile-1');
    harness.endpoint.handleMessage(
      'mobile-1',
      JSON.stringify({ type: 'heartbeat', ts: START + 1000 }),
    );
    expect(harness.endpoint.registry.listDeviceList()).toHaveLength(0);
  });

  it('5. closing the socket stops the heartbeat and takes the device offline', async () => {
    const harness = buildEndpoint();
    connectAuthorized(harness.endpoint, 'mobile-1');
    harness.endpoint.handleMessage('mobile-1', buildHello());
    expect(harness.timerPort.activeCount).toBe(1);

    harness.endpoint.handleClose('mobile-1');

    expect(harness.timerPort.activeCount).toBe(0);
    expect(harness.endpoint.registry.getDevice('mobile:phone-123')?.presence).toBe(
      'offline',
    );
    expect(harness.endpoint.listConnectedCount()).toBe(0);
    // Un cierre no deja sesión seleccionable.
    expect(harness.endpoint.registry.listSelectableSessionList()).toHaveLength(0);
  });

  it('closing an unknown connection is a no-op', () => {
    const harness = buildEndpoint();
    expect(harness.endpoint.handleClose('nope')).toBe(false);
  });

  it('9(heartbeat). a heartbeat timeout takes the device offline', async () => {
    const harness = buildEndpoint();
    connectAuthorized(harness.endpoint, 'mobile-1');
    harness.endpoint.handleMessage('mobile-1', buildHello());
    harness.setNow(START + PRESENCE_OFFLINE_AFTER_MILLISECONDS + 1);
    expect(harness.endpoint.registry.resolvePresence('mobile:phone-123')).toBe('offline');
    expect(harness.endpoint.registry.listSelectableSessionList()).toHaveLength(0);
  });

  it('6+14. a reconnect is one logical device with one heartbeat scheduler', async () => {
    const harness = buildEndpoint();
    const firstSocket = connectAuthorized(harness.endpoint, 'mobile-1');
    harness.endpoint.handleMessage(
      'mobile-1',
      buildHello({ capabilities: ['mobile.alarm'] }),
    );
    harness.endpoint.handleClose('mobile-1');
    expect(harness.timerPort.activeCount).toBe(0);

    const secondSocket = connectAuthorized(harness.endpoint, 'mobile-2');
    harness.endpoint.handleMessage(
      'mobile-2',
      buildHello({ capabilities: ['mobile.alarm', 'mobile.calendar'] }),
    );

    // Un solo dispositivo lógico.
    expect(harness.endpoint.registry.listDeviceList()).toHaveLength(1);
    const session = harness.endpoint.registry.getDevice('mobile:phone-123');
    expect(session?.transport.connectionId).toBe('mobile-2');
    expect(session?.presence).toBe('online');
    expect(session?.declaredCapabilities).toEqual(['mobile.alarm', 'mobile.calendar']);
    // Block 11: ambas tienen comando real, así que declarado == disponible.
    expect(session?.availableCapabilities).toEqual(['mobile.alarm', 'mobile.calendar']);

    // Un solo scheduler: el reconnect reutiliza la instancia por deviceId.
    expect(harness.endpoint.lifecycle.listHeartbeatSchedulerCount()).toBe(1);
    expect(harness.timerPort.activeCount).toBe(1);
    expect(harness.timerPort.createdCount).toBe(2);
    expect(firstSocket.sentMessageList.length).toBeGreaterThan(0);
    expect(secondSocket.listParsedMessageList()[0]?.['type']).toBe('hello_accepted');
  });

  it('12. a duplicate connection keeps one entry and one session per device', async () => {
    const harness = buildEndpoint();
    connectAuthorized(harness.endpoint, 'mobile-1');
    harness.endpoint.handleMessage('mobile-1', buildHello());
    // El mismo socket reenvía el hello (p. ej. un retry del cliente).
    harness.endpoint.handleMessage('mobile-1', buildHello());
    expect(harness.endpoint.registry.listDeviceList()).toHaveLength(1);
    expect(harness.endpoint.lifecycle.listHeartbeatSchedulerCount()).toBe(1);
    expect(harness.timerPort.activeCount).toBe(1);
    expect(harness.timerPort.createdCount).toBe(1);
    expect(harness.endpoint.listConnectedCount()).toBe(1);
  });

  it('13. two different devices coexist as two sessions on one endpoint', async () => {
    const harness = buildEndpoint();
    connectAuthorized(harness.endpoint, 'mobile-1');
    connectAuthorized(harness.endpoint, 'mobile-2');
    harness.endpoint.handleMessage(
      'mobile-1',
      buildHello({ deviceId: 'mobile:phone-123' }),
    );
    harness.endpoint.handleMessage(
      'mobile-2',
      buildHello({ deviceId: 'mobile:tablet-9' }),
    );

    expect(harness.endpoint.registry.listDeviceList()).toHaveLength(2);
    expect(harness.endpoint.listConnectedCount()).toBe(2);
    // Un scheduler por device: dos devices, dos timers.
    expect(harness.endpoint.lifecycle.listHeartbeatSchedulerCount()).toBe(2);
    expect(harness.timerPort.activeCount).toBe(2);
  });

  it('a message for an unknown connection is ignored', () => {
    const harness = buildEndpoint();
    harness.endpoint.handleMessage('nope', buildHello());
    expect(harness.endpoint.registry.listDeviceList()).toHaveLength(0);
  });

  it('a non-string socket message is ignored', () => {
    const harness = buildEndpoint();
    const socket = connectAuthorized(harness.endpoint, 'mobile-1');
    harness.endpoint.handleRawMessage('mobile-1', new Uint8Array([1, 2, 3]));
    harness.endpoint.handleRawMessage('mobile-1', { type: 'hello' });
    expect(harness.endpoint.registry.listDeviceList()).toHaveLength(0);
    expect(socket.sentMessageList).toHaveLength(0);
  });

  it('15. the desktop path is unaffected by the mobile endpoint', () => {
    const harness = buildEndpoint();
    // Registrar un desktop en el mismo registry no interactúa con mobile.
    const outcome = harness.endpoint.registry.register({
      proof: buildAuthenticatedDeviceProof('device'),
      deviceId: 'desktop:PC-ESTUDIO',
      deviceType: 'desktop',
      capabilityNameList: ['desktop.open_app'],
      protocolVersion: 1,
      lastSeenAt: START,
      transport: { transportKind: 'pc_bridge', connectionId: 'desktop:PC-ESTUDIO' },
    });
    expect(outcome.status).toBe('registered');

    connectAuthorized(harness.endpoint, 'mobile-1');
    harness.endpoint.handleMessage('mobile-1', buildHello());
    expect(harness.endpoint.registry.listDeviceList()).toHaveLength(2);

    const desktopResolution = harness.endpoint.registry.resolveTarget({
      capabilityName: 'desktop.open_app',
      targetPreference: { kind: 'device_type', deviceType: 'desktop' },
    });
    expect(desktopResolution.status).toBe('resolved');
    if (desktopResolution.status === 'resolved') {
      expect(desktopResolution.device.deviceId).toBe('desktop:PC-ESTUDIO');
    }
    // BLOCK 9: mobile.notifications ahora tiene implementación, así que el
    // mobile la resuelve y el desktop nunca puede ser su target.
    const mobileResolution = harness.endpoint.registry.resolveTarget({
      capabilityName: 'mobile.notifications',
      targetPreference: { kind: 'device_type', deviceType: 'mobile' },
    });
    expect(mobileResolution.status).toBe('resolved');
    if (mobileResolution.status === 'resolved') {
      expect(mobileResolution.device.deviceId).toBe('mobile:phone-123');
      expect(mobileResolution.device.deviceType).toBe('mobile');
    }
    // Con preferencia 'any', la capability mobile sigue yendo al mobile: jamás
    // al desktop aunque esté online.
    const anyResolution = harness.endpoint.registry.resolveTarget({
      capabilityName: 'mobile.notifications',
      targetPreference: { kind: 'any' },
    });
    expect(anyResolution.status).toBe('resolved');
    if (anyResolution.status === 'resolved') {
      expect(anyResolution.device.deviceType).toBe('mobile');
    }
    // Y una capability unimplemented sigue sin target. Block 11 dejó todas las
    // mobile con comando real, así que la unimplemented de ejemplo es desktop.
    const unimplementedResolution = harness.endpoint.registry.resolveTarget({
      capabilityName: 'desktop.files',
      targetPreference: { kind: 'any' },
    });
    expect(unimplementedResolution.status).toBe('unavailable');
    if (unimplementedResolution.status === 'unavailable') {
      expect(unimplementedResolution.reason).toBe('unimplemented');
    }
  });
});
