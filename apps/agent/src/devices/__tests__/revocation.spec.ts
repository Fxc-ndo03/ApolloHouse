import { beforeEach, describe, expect, it } from 'bun:test';

import { MobileDeviceEndpoint } from '@/devices/endpoint';
import { buildAuthenticatedDeviceProof } from '@/devices/registry';
import { createInMemoryEnrollmentStore } from '@/devices/credential-store';
import {
  claimEnrollmentChallenge,
  issueEnrollmentChallenge,
  revokeDeviceCredential,
  type EnrollmentStore,
} from '@/devices/enrollment';
import { isEnrollableMobileDeviceId } from '@/devices/route';
import type { HeartbeatTimerHandle, HeartbeatTimerPort } from '@/devices/heartbeat';

// ─────────────────────────────────────────────────────────────────────────────
// BLOCK 12 §7: autorización por conexión, con sockets y sesiones de verdad.
//
// Estos tests usan el endpoint de producción: el mismo registry, el mismo
// lifecycle y el mismo transport que el DO. Lo único inyectado es el socket (una
// primitiva de plataforma) y el store de enrollment.
//
// El transporte real, el DO y WebSockets reales se prueban en el smoke con
// workerd. Lo que no se puede hacer acá es levantar la clase del DO: importa
// `cloudflare:` a través del SDK de agents.
// ─────────────────────────────────────────────────────────────────────────────

const START = 1_700_000_000_000;
const PHONE_A = 'mobile:phone-a';
const PHONE_B = 'mobile:phone-b';

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

  listRejectionReasonList(): string[] {
    return this.listParsedMessageList()
      .filter((message) => message['type'] === 'hello_rejected')
      .map((message) => String(message['reason']));
  }
}

class CountingTimerPort implements HeartbeatTimerPort {
  #nextHandle = 1;
  readonly #activeHandleSet = new Set<number>();

  setInterval(): HeartbeatTimerHandle {
    const handle = this.#nextHandle;
    this.#nextHandle += 1;
    this.#activeHandleSet.add(handle);
    return handle;
  }

  clearInterval(handle: HeartbeatTimerHandle): void {
    this.#activeHandleSet.delete(handle as number);
  }
}

function buildHello(deviceId: string): string {
  return JSON.stringify({
    type: 'hello',
    deviceId,
    deviceType: 'mobile',
    protocolVersion: 1,
    capabilities: ['mobile.notifications'],
    ts: START,
  });
}

type Harness = {
  readonly endpoint: MobileDeviceEndpoint;
  readonly timerPort: CountingTimerPort;
  readonly store: EnrollmentStore;
  readonly connect: (input: {
    readonly connectionId: string;
    readonly auth?: {
      scope: 'enrolled_android' | 'legacy_shared_secret';
      boundDeviceId: string | null;
    };
    readonly proof?: boolean;
  }) => FakeWebSocket;
  readonly setNow: (value: number) => void;
};

async function buildHarness(): Promise<Harness> {
  const store = createInMemoryEnrollmentStore();
  const timerPort = new CountingTimerPort();
  let current = START;
  const endpoint = new MobileDeviceEndpoint({
    nowMilliseconds: () => current,
    timerPort,
    enrollmentStore: store,
  });
  await endpoint.refreshEnrollmentSnapshot();

  const socketMap = new Map<string, FakeWebSocket>();
  return {
    endpoint,
    timerPort,
    store,
    setNow: (value: number) => {
      current = value;
    },
    connect: ({ connectionId, auth, proof = true }) => {
      const socket = new FakeWebSocket();
      socketMap.set(connectionId, socket);
      endpoint.handleConnect({
        connectionId,
        port: {
          send: (messageText) => socket.send(messageText),
          close: () => socket.close(),
        },
        proof: proof ? buildAuthenticatedDeviceProof('device') : null,
        ...(auth === undefined
          ? {}
          : { auth: { scope: auth.scope, boundDeviceId: auth.boundDeviceId } }),
      });
      return socket;
    },
  };
}

async function enrollPhone(store: EnrollmentStore, deviceId: string): Promise<string> {
  const issued = await issueEnrollmentChallenge({
    store,
    nowMilliseconds: START,
    boundDeviceId: deviceId,
  });
  const claim = await claimEnrollmentChallenge({
    store,
    nowMilliseconds: START + 1,
    challenge: issued.challenge,
    deviceId,
    isDeviceIdValid: isEnrollableMobileDeviceId,
  });
  if (claim.status !== 'enrolled') {
    throw new Error(`no se pudo enrolar ${deviceId}`);
  }
  return claim.credential;
}

describe('B12 §7.6-7.8: una credencial válida abre sesión y no abre otra', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await buildHarness();
    await enrollPhone(harness.store, PHONE_A);
    await harness.endpoint.refreshEnrollmentSnapshot();
  });

  it('el ámbito enrolled autentica a su propio deviceId', () => {
    const socket = harness.connect({
      connectionId: 'c1',
      auth: { scope: 'enrolled_android', boundDeviceId: PHONE_A },
    });
    harness.endpoint.handleMessage('c1', buildHello(PHONE_A));

    const messageList = socket.listParsedMessageList();
    expect(messageList[0]?.['type']).toBe('hello_accepted');
    expect(harness.endpoint.registry.resolvePresence(PHONE_A)).toBe('online');
  });

  it('la credencial de A NO puede abrir una sesión declarando ser B', () => {
    // §3: la autenticación se comprueba en el servidor, no se confía en el
    // deviceId que manda el cliente. La credencial de A está atada a A.
    const socket = harness.connect({
      connectionId: 'c1',
      auth: { scope: 'enrolled_android', boundDeviceId: PHONE_A },
    });
    harness.endpoint.handleMessage('c1', buildHello(PHONE_B));

    expect(socket.listRejectionReasonList()).toEqual(['credential_device_mismatch']);
    // B no llega a existir como sesión.
    expect(harness.endpoint.registry.resolvePresence(PHONE_B)).toBeNull();
    expect(harness.endpoint.registry.listDeviceList()).toHaveLength(0);
  });

  it('un ámbito enrolled sin deviceId atado no autentica a nadie', () => {
    const socket = harness.connect({
      connectionId: 'c1',
      auth: { scope: 'enrolled_android', boundDeviceId: null },
    });
    harness.endpoint.handleMessage('c1', buildHello(PHONE_A));
    expect(socket.listRejectionReasonList()).toEqual(['credential_device_mismatch']);
  });
});

describe('B12 §7.9-7.11: revocación con socket activo y reconexión', () => {
  it('revocar cierra el socket vivo y saca la sesión', async () => {
    const harness = await buildHarness();
    await enrollPhone(harness.store, PHONE_A);
    await harness.endpoint.refreshEnrollmentSnapshot();

    const socket = harness.connect({
      connectionId: 'c1',
      auth: { scope: 'enrolled_android', boundDeviceId: PHONE_A },
    });
    harness.endpoint.handleMessage('c1', buildHello(PHONE_A));
    expect(harness.endpoint.registry.resolvePresence(PHONE_A)).toBe('online');

    await revokeDeviceCredential({
      store: harness.store,
      deviceId: PHONE_A,
      nowMilliseconds: START + 10,
    });
    await harness.endpoint.refreshEnrollmentSnapshot();

    expect(harness.endpoint.closeConnectionsForDeviceId(PHONE_A)).toBe(1);
    expect(socket.closeCallCount).toBe(1);
    // La sesión no se borra: queda offline, y en el registry no es seleccionable.
    // Por eso el assert es 'offline' y no null (mismo criterio que Block 8.1).
    expect(harness.endpoint.registry.resolvePresence(PHONE_A)).toBe('offline');
    expect(harness.endpoint.registry.listSelectableSessionList()).toHaveLength(0);
  });

  it('tras revocar, la misma credencial no vuelve a autenticar', async () => {
    const harness = await buildHarness();
    const credential = await enrollPhone(harness.store, PHONE_A);
    await harness.endpoint.refreshEnrollmentSnapshot();
    await revokeDeviceCredential({
      store: harness.store,
      deviceId: PHONE_A,
      nowMilliseconds: START + 10,
    });
    await harness.endpoint.refreshEnrollmentSnapshot();

    const socket = harness.connect({
      connectionId: 'c2',
      auth: { scope: 'enrolled_android', boundDeviceId: PHONE_A },
    });
    harness.endpoint.handleMessage('c2', buildHello(PHONE_A));

    // Ni la credencial ni el deviceId.atado alcanzan: la fila está revocada y el
    // authorizer lo ve. El DO además cierra el socket en onConnect, así que el
    // teléfono recibe un motivo y deja de reintentar.
    expect(socket.listRejectionReasonList()).toEqual(['credential_revoked']);
    expect(harness.endpoint.registry.resolvePresence(PHONE_A)).toBeNull();
    expect(credential.length).toBeGreaterThan(0);
  });

  it('el heartbeat de un teléfono revocado ya no registra presencia', async () => {
    const harness = await buildHarness();
    await enrollPhone(harness.store, PHONE_A);
    await harness.endpoint.refreshEnrollmentSnapshot();
    harness.connect({
      connectionId: 'c1',
      auth: { scope: 'enrolled_android', boundDeviceId: PHONE_A },
    });
    harness.endpoint.handleMessage('c1', buildHello(PHONE_A));

    await revokeDeviceCredential({
      store: harness.store,
      deviceId: PHONE_A,
      nowMilliseconds: START + 10,
    });
    harness.endpoint.closeConnectionsForDeviceId(PHONE_A);
    harness.endpoint.handleMessage(
      'c1',
      JSON.stringify({ type: 'heartbeat', deviceId: PHONE_A, ts: START + 20 }),
    );
    // handleMessage sobre una conexión cerrada no revive nada.
    expect(harness.endpoint.registry.resolvePresence(PHONE_A)).toBe('offline');
  });
});

describe('B12 §7.12: aislamiento entre dos teléfonos', () => {
  it('revocar A no toca la sesión de B', async () => {
    const harness = await buildHarness();
    await enrollPhone(harness.store, PHONE_A);
    const credentialOfB = await enrollPhone(harness.store, PHONE_B);
    await harness.endpoint.refreshEnrollmentSnapshot();

    harness.connect({
      connectionId: 'c-a',
      auth: { scope: 'enrolled_android', boundDeviceId: PHONE_A },
    });
    const socketB = harness.connect({
      connectionId: 'c-b',
      auth: { scope: 'enrolled_android', boundDeviceId: PHONE_B },
    });
    harness.endpoint.handleMessage('c-a', buildHello(PHONE_A));
    harness.endpoint.handleMessage('c-b', buildHello(PHONE_B));
    expect(harness.endpoint.registry.listDeviceList()).toHaveLength(2);

    await revokeDeviceCredential({
      store: harness.store,
      deviceId: PHONE_A,
      nowMilliseconds: START + 10,
    });
    await harness.endpoint.refreshEnrollmentSnapshot();

    expect(harness.endpoint.closeConnectionsForDeviceId(PHONE_A)).toBe(1);
    expect(harness.endpoint.registry.resolvePresence(PHONE_A)).toBe('offline');
    expect(harness.endpoint.registry.resolvePresence(PHONE_B)).toBe('online');
    expect(socketB.closeCallCount).toBe(0);

    // Y B sigue autenticando con SU credencial, que no se vio afectada.
    const socketB2 = harness.connect({
      connectionId: 'c-b2',
      auth: { scope: 'enrolled_android', boundDeviceId: PHONE_B },
    });
    harness.endpoint.handleMessage('c-b2', buildHello(PHONE_B));
    expect(socketB2.listParsedMessageList()[0]?.['type']).toBe('hello_accepted');
    expect(credentialOfB.length).toBeGreaterThan(0);
  });

  it('no hay sesión duplicada: un revoke cierra sólo la de su deviceId', async () => {
    const harness = await buildHarness();
    await enrollPhone(harness.store, PHONE_A);
    await enrollPhone(harness.store, PHONE_B);
    await harness.endpoint.refreshEnrollmentSnapshot();
    harness.connect({
      connectionId: 'c-a',
      auth: { scope: 'enrolled_android', boundDeviceId: PHONE_A },
    });
    harness.connect({
      connectionId: 'c-b',
      auth: { scope: 'enrolled_android', boundDeviceId: PHONE_B },
    });
    harness.endpoint.handleMessage('c-a', buildHello(PHONE_A));
    harness.endpoint.handleMessage('c-b', buildHello(PHONE_B));

    expect(harness.endpoint.closeConnectionsForDeviceId(PHONE_A)).toBe(1);
    // Sólo queda el socket de B.
    expect(harness.endpoint.inspectSessionSnapshot().connectedCount).toBe(1);
    expect(harness.endpoint.inspectSessionSnapshot().handshakenConnectionCount).toBe(1);
    // Las dos sesiones siguen en el registry: una cerrada queda `offline`, no se
    // borra (así el heartbeat tardío todavía encuentra su sesión). Lo que no
    // puede pasar es que A siga siendo seleccionable.
    expect(harness.endpoint.inspectSessionSnapshot().sessionCount).toBe(2);
    expect(harness.endpoint.registry.listSelectableSessionList()).toHaveLength(1);
    expect(harness.endpoint.registry.listSelectableSessionList()[0]?.deviceId).toBe(
      PHONE_B,
    );
  });
});

describe('B12.1 §3: el camino legacy queda cerrado para identidades mobile', () => {
  it('un teléfono NO enrolado ya no entra por ?token= con el secreto global', async () => {
    // Este test daba `hello_accepted` en BLOCK 12 y ahora se rechaza. Es el
    // cambio pedido: el secreto global dejó de ser una alternativa al
    // enrollment individual, así que una identidad mobile nueva no puede
    // autenticarse con él.
    const harness = await buildHarness();
    const socket = harness.connect({
      connectionId: 'legacy-1',
      auth: { scope: 'legacy_shared_secret', boundDeviceId: null },
    });
    harness.endpoint.handleMessage('legacy-1', buildHello('mobile:telefono-legacy'));

    expect(socket.listRejectionReasonList()).toEqual(['device_not_enrolled']);
    expect(
      harness.endpoint.registry.resolvePresence('mobile:telefono-legacy'),
    ).toBeNull();
    expect(harness.endpoint.registry.listDeviceList()).toHaveLength(0);
  });

  it('el motivo distingue "enrolate" de "ya estabas enrolado"', async () => {
    // El teléfono necesita actionable: si está enrolado y usa el secreto global,
    // el problema es distinto que si nunca se enroló.
    const harness = await buildHarness();
    await enrollPhone(harness.store, PHONE_A);
    await harness.endpoint.refreshEnrollmentSnapshot();
    const socket = harness.connect({
      connectionId: 'legacy-enrolled',
      auth: { scope: 'legacy_shared_secret', boundDeviceId: null },
    });
    harness.endpoint.handleMessage('legacy-enrolled', buildHello(PHONE_A));

    expect(socket.listRejectionReasonList()).toEqual(['device_is_enrolled_or_revoked']);
  });

  it('un bearer inválido no cae al mecanismo legacy', async () => {
    // El borde rechaza el bearer con forma inválida y NO reintenta con
    // `?token=`. Acá se comprueba que aunque se presente el secreto global en el
    // scope legacy, la sesión sigue sin crearse.
    const harness = await buildHarness();
    const socket = harness.connect({
      connectionId: 'mixed-1',
      auth: { scope: 'legacy_shared_secret', boundDeviceId: null },
    });
    harness.endpoint.handleMessage('mixed-1', buildHello('mobile:sin-enrolar'));
    expect(socket.listRejectionReasonList()).toEqual(['device_not_enrolled']);
    expect(harness.endpoint.registry.listDeviceList()).toHaveLength(0);
  });

  it('sin store de enrollment el comportamiento legacy es idéntico', async () => {
    // Una deployment sin enrollment no puede bloquear a nadie por la regla
    // anti-bypass: el módulo degrada al comportamiento de siempre.
    const endpoint = new MobileDeviceEndpoint({ nowMilliseconds: () => START });
    const socket = new FakeWebSocket();
    endpoint.handleConnect({
      connectionId: 'legacy-no-store',
      port: {
        send: (messageText) => socket.send(messageText),
        close: () => socket.close(),
      },
      proof: buildAuthenticatedDeviceProof('device'),
    });
    endpoint.handleMessage('legacy-no-store', buildHello('mobile:sin-store'));
    expect(socket.listParsedMessageList()[0]?.['type']).toBe('hello_accepted');
  });
});

describe('B12 §7.1: el bypass del mecanismo legacy', () => {
  it('un teléfono ENROLADO no puede caer al camino legacy', async () => {
    // Esta es la razón de toda la regla: si no, la credencial individual es
    // opcional y revocar no significa nada, porque alcanza con ?token=.
    const harness = await buildHarness();
    await enrollPhone(harness.store, PHONE_A);
    await harness.endpoint.refreshEnrollmentSnapshot();

    const socket = harness.connect({
      connectionId: 'legacy-a',
      auth: { scope: 'legacy_shared_secret', boundDeviceId: null },
    });
    harness.endpoint.handleMessage('legacy-a', buildHello(PHONE_A));

    expect(socket.listRejectionReasonList()).toEqual(['device_is_enrolled_or_revoked']);
    expect(harness.endpoint.registry.resolvePresence(PHONE_A)).toBeNull();
  });

  it('un teléfono REVOCADO tampoco puede caer al camino legacy', async () => {
    const harness = await buildHarness();
    await enrollPhone(harness.store, PHONE_A);
    await harness.endpoint.refreshEnrollmentSnapshot();
    await revokeDeviceCredential({
      store: harness.store,
      deviceId: PHONE_A,
      nowMilliseconds: START + 10,
    });
    await harness.endpoint.refreshEnrollmentSnapshot();

    const socket = harness.connect({
      connectionId: 'legacy-a',
      auth: { scope: 'legacy_shared_secret', boundDeviceId: null },
    });
    harness.endpoint.handleMessage('legacy-a', buildHello(PHONE_A));

    expect(socket.listRejectionReasonList()).toEqual(['device_is_enrolled_or_revoked']);
    expect(harness.endpoint.registry.resolvePresence(PHONE_A)).toBeNull();
  });
});

describe('B12 §7.18: correlación y requestId intactos después de autenticar', () => {
  it('un comando conserva su requestId con credencial per-device', async () => {
    const harness = await buildHarness();
    await enrollPhone(harness.store, PHONE_A);
    await harness.endpoint.refreshEnrollmentSnapshot();
    harness.connect({
      connectionId: 'c1',
      auth: { scope: 'enrolled_android', boundDeviceId: PHONE_A },
    });
    harness.endpoint.handleMessage('c1', buildHello(PHONE_A));

    const requestId = 'req-correlacion-1';
    const pendingOutcome = harness.endpoint.dispatchCommand({
      deviceId: PHONE_A,
      capability: 'mobile.notifications',
      payload: { title: 'Apollo', body: 'Hola' },
      requestId,
    });

    // El command_result vuelve con ESE requestId, no con otro.
    harness.endpoint.handleMessage(
      'c1',
      JSON.stringify({
        type: 'command_result',
        requestId,
        capability: 'mobile.notifications',
        ok: true,
        result: { posted: true },
        ts: START,
      }),
    );

    const settled = await pendingOutcome;
    expect(settled.ok).toBe(true);
    expect(harness.endpoint.pendingCommandCount).toBe(0);
  });
});
