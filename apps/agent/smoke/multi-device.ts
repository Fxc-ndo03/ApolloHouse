// Smoke conceptual multi-device (BLOCK 11 §20).
//
// Un peer mobile real y un peer desktop (vía el harness de Apollo, que es el
// camino de producción para desktop) conviviendo en el mismo Worker, y Apollo
// orquestando entre los dos. No se reemplaza MobileBridge ni Apollo por mocks.
//
//   1. Apollo → desktop
//   2. Apollo → mobile
//   3. target explícito mobile
//   4. target explícito desktop
//   5. any
//   6. mobile offline
//   7. desktop offline
//   8. late response
//   9. duplicate request
//  10. reconnect

import { enrollSmokeDevice } from './enroll';
import { MOBILE_CLIENT_INVARIANT_LIST } from './mobile-client';

const WORKER_BASE_URL = process.env['WORKER_BASE_URL'] ?? 'http://127.0.0.1:8799';
const DEVICE_TOKEN =
  process.env['DEVICE_SHARED_SECRET'] ?? 'block-8-2-smoke-device-secret';
const MOBILE_DEVICE_ID = 'mobile:smoke-galaxy-s5';

let checkCount = 0;
let failureCount = 0;

function check(description: string, didPass: boolean, detail = ''): void {
  checkCount += 1;
  if (didPass) {
    console.log(`  ok   ${description}`);
    return;
  }
  failureCount += 1;
  console.log(`  FAIL ${description}${detail === '' ? '' : ` -> ${detail}`}`);
}

function section(title: string): void {
  console.log('');
  console.log(title);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * BLOCK 12.1 §3: hay dos URLs y son cosas distintas.
 *
 * `callerBridgeUrl` es el RPC: no manda `hello`, no es una identidad mobile, y
 * por eso el camino legacy le sigue sirviendo.
 *
 * `deviceSocketHeaderMap` es el teléfono: su credencial individual viaja en el
 * header `Authorization`, nunca en la URL.
 */
function callerBridgeUrl(): string {
  return `${WORKER_BASE_URL.replace(/^http/, 'ws')}/agents/mobile-bridge/mobile?token=${encodeURIComponent(
    DEVICE_TOKEN,
  )}`;
}

function deviceSocketUrl(): string {
  return `${WORKER_BASE_URL.replace(/^http/, 'ws')}/agents/mobile-bridge/mobile`;
}

let mobileCredential = '';

function deviceSocketHeaderMap(): Record<string, string> {
  return { Authorization: `Bearer ${mobileCredential}` };
}

function callBridge<TAnswer>(method: string, args: unknown): Promise<TAnswer> {
  const socket = new WebSocket(callerBridgeUrl());
  return new Promise<TAnswer>((resolve, reject) => {
    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({ type: 'rpc', id: method, method, args: [args] }));
    });
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as Record<string, unknown>;
      if (message['type'] !== 'rpc' || message['id'] !== method) {
        return;
      }
      socket.close();
      if (message['success'] === true) {
        resolve(message['result'] as TAnswer);
        return;
      }
      reject(new Error(JSON.stringify(message['error'])));
    });
    socket.addEventListener('error', () => reject(new Error('socket_error')));
    setTimeout(() => reject(new Error('timeout rpc')), 25_000);
  });
}

type TargetAnswer = {
  readonly status: string;
  readonly deviceId: string | null;
  readonly presence: string | null;
  readonly reason: string | null;
  readonly commandList: readonly string[];
};

type CommandAnswer = {
  readonly status: string;
  readonly reason?: string;
  readonly outcome?: { readonly ok: boolean; readonly reason?: string };
  readonly result?: Record<string, unknown>;
};

/** Peer mobile real: habla el protocolo contra MobileBridge. */
class MobilePeer {
  readonly commandList: Record<string, unknown>[] = [];
  #socket: WebSocket | null = null;
  #isOpen = false;

  connect(capabilities: readonly string[]): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(deviceSocketUrl(), {
        headers: deviceSocketHeaderMap(),
      });
      this.#socket = socket;
      socket.addEventListener('open', () => {
        this.#isOpen = true;
        socket.send(
          JSON.stringify({
            type: 'hello',
            deviceId: MOBILE_DEVICE_ID,
            deviceType: 'mobile',
            protocolVersion: 1,
            capabilities: [...capabilities],
            ts: Date.now(),
          }),
        );
      });
      socket.addEventListener('message', (event) => {
        const message = JSON.parse(String(event.data)) as Record<string, unknown>;
        if (message['type'] === 'hello_accepted') {
          resolve();
          return;
        }
        if (message['type'] === 'command') {
          this.commandList.push(message);
          this.#answer(message);
        }
      });
      socket.addEventListener('error', () => reject(new Error('peer socket error')));
      setTimeout(() => reject(new Error('timeout hello')), 20_000);
    });
  }

  heartbeat(): void {
    this.#socket?.send(JSON.stringify({ type: 'heartbeat', ts: Date.now() }));
  }

  #answer(command: Record<string, unknown>): void {
    // El peer valida como lo haría el cliente Kotlin: por CAPABILITY, con el
    // schema del comando. Un peer que sólo entendiera notifications rechazaría
    // cualquier comando nuevo, que no es el caso que queremos probar acá.
    const payload = (command['payload'] ?? {}) as Record<string, unknown>;
    const capabilityName = String(command['capability']);
    const commandName = String(command['command'] ?? '');
    const isValid =
      capabilityName === 'mobile.notifications'
        ? typeof payload['title'] === 'string' &&
          typeof payload['body'] === 'string' &&
          Object.keys(payload).toSorted().join(',') === 'body,title'
        : validateNonNotificationPayload(capabilityName, commandName, payload);
    this.#socket?.send(
      JSON.stringify({
        type: 'command_result',
        requestId: command['requestId'],
        capability: command['capability'],
        ok: isValid,
        ...(isValid ? { result: { posted: true } } : { error: 'invalid_payload' }),
        ts: Date.now(),
      }),
    );
  }

  sendRaw(rawMessageText: string): void {
    this.#socket?.send(rawMessageText);
  }

  get isOpen(): boolean {
    return this.#isOpen;
  }

  disconnect(): void {
    this.#isOpen = false;
    this.#socket?.close();
    this.#socket = null;
  }
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMilliseconds: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    if (predicate()) {
      return true;
    }
    await delay(100);
  }
  return false;
}

/** deviceId puede venir null cuando la resolución falló: eso NO es un mobile. */
function isDeviceId(deviceId: string | null, expectedPrefix: string): boolean {
  return deviceId !== null && deviceId.startsWith(`${expectedPrefix}:`);
}

/**
 * Validación mínima por capability para un peer que no es el cliente Kotlin real:
 * alcanza con replicar los límites duros (tipos y rangos) de cada comando.
 */
function validateNonNotificationPayload(
  capabilityName: string,
  commandName: string,
  payload: Record<string, unknown>,
): boolean {
  if (commandName === 'alarm_set') {
    return (
      typeof payload['hourMinute'] === 'string' &&
      typeof payload['label'] === 'string' &&
      payload['label'].length > 0
    );
  }
  if (commandName === 'alarm_cancel' || commandName === 'calendar_cancel') {
    const key = commandName === 'alarm_cancel' ? 'label' : 'title';
    return typeof payload[key] === 'string' && (payload[key] as string).length > 0;
  }
  if (commandName === 'calendar_create') {
    return (
      typeof payload['title'] === 'string' && typeof payload['startsAt'] === 'string'
    );
  }
  if (commandName === 'volume_set') {
    return (
      typeof payload['level'] === 'number' &&
      payload['level'] >= 0 &&
      payload['level'] <= 100
    );
  }
  if (commandName === 'app_open') {
    return typeof payload['appName'] === 'string' && payload['appName'].length > 0;
  }
  if (commandName.startsWith('media_')) {
    return payload['query'] === undefined || typeof payload['query'] === 'string';
  }
  return capabilityName.startsWith('mobile.');
}

console.log('Multi-device smoke -> Apollo <-> MobileBridge + PcBridge');
console.log(`  mobile deviceId: ${MOBILE_DEVICE_ID}`);
console.log(`  invariantes del cliente: ${MOBILE_CLIENT_INVARIANT_LIST.length}`);

// BLOCK 12.1: el teléfono se enrola con el flujo real antes de abrir el socket.
mobileCredential = (
  await enrollSmokeDevice({
    workerBaseUrl: WORKER_BASE_URL,
    deviceId: MOBILE_DEVICE_ID,
  })
).credential;

// ── 1. Apollo → desktop ───────────────────────────────────────────────────────
section('1. Apollo -> desktop');

const desktopAnswer = await callBridge<TargetAnswer>('resolveCapabilityTarget', {
  capabilityName: 'desktop.open_app',
  targetPreference: { kind: 'device_type', deviceType: 'desktop' },
});
check(
  'el desktop resuelve su propia capability a un device desktop',
  desktopAnswer.status === 'unavailable' ||
    desktopAnswer.deviceId?.startsWith('desktop:') === true,
  JSON.stringify(desktopAnswer),
);
check(
  'ningun device mobile se resuelve para una capability desktop',
  !isDeviceId(desktopAnswer.deviceId, 'mobile'),
  JSON.stringify(desktopAnswer),
);

// ── 2. Apollo → mobile ────────────────────────────────────────────────────────
section('2. Apollo -> mobile');

const peer = new MobilePeer();
await peer.connect(['mobile.notifications', 'mobile.alarm', 'mobile.media']);
await delay(300);

const mobileAnswer = await callBridge<TargetAnswer>('resolveCapabilityTarget', {
  capabilityName: 'mobile.notifications',
  targetPreference: { kind: 'device_type', deviceType: 'mobile' },
});
check(
  'el mobile resuelve su capability al teléfono real',
  mobileAnswer.status === 'resolved' && mobileAnswer.deviceId === MOBILE_DEVICE_ID,
  JSON.stringify(mobileAnswer),
);
check(
  'el catálogo que devuelve el bridge es mobile.notifications -> notification_post',
  JSON.stringify(mobileAnswer.commandList) === JSON.stringify(['notification_post']),
  JSON.stringify(mobileAnswer.commandList),
);

// ── 3. target explícito mobile ────────────────────────────────────────────────
section('3. target explicícito mobile');

const explicitMobile = await callBridge<TargetAnswer>('resolveCapabilityTarget', {
  capabilityName: 'mobile.alarm',
  targetPreference: { kind: 'device', deviceId: MOBILE_DEVICE_ID },
});
check(
  'un target explícito mobile resuelve al teléfono',
  explicitMobile.status === 'resolved' && explicitMobile.deviceId === MOBILE_DEVICE_ID,
  JSON.stringify(explicitMobile),
);

const unknownMobile = await callBridge<TargetAnswer>('resolveCapabilityTarget', {
  capabilityName: 'mobile.alarm',
  targetPreference: { kind: 'device', deviceId: 'mobile:no-existe' },
});
check(
  'un target explícito inexistente NO hace fallback a otro device',
  unknownMobile.status === 'unavailable',
  JSON.stringify(unknownMobile),
);

// ── 4. target explícito desktop ───────────────────────────────────────────────
section('4. target explicícito desktop');

const explicitDesktop = await callBridge<TargetAnswer>('resolveCapabilityTarget', {
  capabilityName: 'desktop.spotify',
  targetPreference: { kind: 'device', deviceId: 'desktop:PC-ESTUDIO' },
});
check(
  'un target explícito desktop nunca cae al teléfono',
  !isDeviceId(explicitDesktop.deviceId, 'mobile'),
  JSON.stringify(explicitDesktop),
);

// ── 5. any ────────────────────────────────────────────────────────────────────
section('5. target any');

const anyTarget = await callBridge<TargetAnswer>('resolveCapabilityTarget', {
  capabilityName: 'mobile.media',
  targetPreference: { kind: 'any' },
});
check(
  'any elige el device que puede cumplir la capability',
  anyTarget.status === 'resolved' && anyTarget.deviceId === MOBILE_DEVICE_ID,
  JSON.stringify(anyTarget),
);
check(
  'any con una capability mobile nunca elige un device desktop',
  isDeviceId(anyTarget.deviceId, 'mobile'),
  JSON.stringify(anyTarget),
);

// ── 6. mobile offline ─────────────────────────────────────────────────────────
section('6. mobile offline');

const disconnectPromise = new Promise<void>((resolve) => {
  const deadline = Date.now() + 20_000;
  const poll = async (): Promise<void> => {
    const answer = await callBridge<TargetAnswer>('resolveCapabilityTarget', {
      capabilityName: 'mobile.notifications',
      targetPreference: { kind: 'device_type', deviceType: 'mobile' },
    }).catch(() => ({ status: 'error' }) as TargetAnswer);
    if (answer.status === 'unavailable' || Date.now() > deadline) {
      resolve();
      return;
    }
    await delay(200);
    await poll();
  };
  void poll();
});
peer.disconnect();
await disconnectPromise;

const offlineMobile = await callBridge<TargetAnswer>('resolveCapabilityTarget', {
  capabilityName: 'mobile.notifications',
  targetPreference: { kind: 'device_type', deviceType: 'mobile' },
});
check(
  'con el teléfono desconectado la capability mobile queda unavailable',
  offlineMobile.status === 'unavailable',
  JSON.stringify(offlineMobile),
);
check(
  'el motivo NO es unimplemented: la capability existe, falta el device',
  offlineMobile.reason !== 'unimplemented',
  String(offlineMobile.reason),
);
check(
  'no se manda la notificación al desktop como fallback',
  !isDeviceId(offlineMobile.deviceId, 'desktop'),
  JSON.stringify(offlineMobile),
);

// ── 7. desktop offline ────────────────────────────────────────────────────────
section('7. desktop offline');

const offlineDesktop = await callBridge<TargetAnswer>('resolveCapabilityTarget', {
  capabilityName: 'desktop.open_app',
  targetPreference: { kind: 'device_type', deviceType: 'desktop' },
});
check(
  'sin PC la capability desktop queda unavailable',
  offlineDesktop.status === 'unavailable',
  JSON.stringify(offlineDesktop),
);
check(
  'la indisponibilidad de un cuerpo no afecta al otro',
  offlineMobile.status === 'unavailable' && offlineDesktop.status === 'unavailable',
);

// ── 10 (previo). reconnect ────────────────────────────────────────────────────
section('8. reconnect con la misma identidad');

const reconnectedPeer = new MobilePeer();
await reconnectedPeer.connect([
  'mobile.notifications',
  'mobile.alarm',
  'mobile.media',
  'mobile.volume',
]);
await delay(300);

const afterReconnect = await callBridge<TargetAnswer>('resolveCapabilityTarget', {
  capabilityName: 'mobile.volume',
  targetPreference: { kind: 'device_type', deviceType: 'mobile' },
});
check(
  'el reconectado vuelve a resolver con el mismo deviceId',
  afterReconnect.status === 'resolved' && afterReconnect.deviceId === MOBILE_DEVICE_ID,
  JSON.stringify(afterReconnect),
);

const deviceSummary = await callBridge<{
  readonly deviceSummaryList: readonly {
    readonly deviceId: string;
    readonly presence: string;
    readonly capabilityNameList: readonly string[];
  }[];
}>('listReachableCapabilityList', {});
check(
  'el reconectado no crea un segundo device en el registry',
  deviceSummary.deviceSummaryList.filter((device) => device.deviceId === MOBILE_DEVICE_ID)
    .length === 1,
  JSON.stringify(deviceSummary.deviceSummaryList),
);
check(
  'las capabilities se actualizan tras el reconnect',
  (deviceSummary.deviceSummaryList.find((device) => device.deviceId === MOBILE_DEVICE_ID)
    ?.capabilityNameList.length ?? 0) === 4,
  JSON.stringify(deviceSummary.deviceSummaryList),
);

// ── 9. duplicate request ──────────────────────────────────────────────────────
section('9. duplicate request');

const duplicateRequestId = `b11-dup-${Date.now().toString(36)}`;
const firstDuplicate = callBridge<CommandAnswer>('sendMobileCommand', {
  targetDeviceId: MOBILE_DEVICE_ID,
  capabilityName: 'mobile.notifications',
  commandName: 'notification_post',
  requestId: duplicateRequestId,
  payload: { title: 'Apollo', body: 'Duplicado' },
});
await delay(700);
const secondDuplicate = callBridge<CommandAnswer>('sendMobileCommand', {
  targetDeviceId: MOBILE_DEVICE_ID,
  capabilityName: 'mobile.notifications',
  commandName: 'notification_post',
  requestId: duplicateRequestId,
  payload: { title: 'Apollo', body: 'Duplicado' },
});
const [firstAnswer, secondAnswer] = await Promise.all([firstDuplicate, secondDuplicate]);
check(
  'el requestId duplicado no ejecuta un segundo efecto',
  reconnectedPeer.commandList.filter(
    (command) => command['requestId'] === duplicateRequestId,
  ).length === 1,
  String(reconnectedPeer.commandList.length),
);
check(
  'el duplicado devuelve el mismo resultado, no un error nuevo',
  JSON.stringify(firstAnswer.result) === JSON.stringify(secondAnswer.result),
  `${JSON.stringify(firstAnswer.result)} vs ${JSON.stringify(secondAnswer.result)}`,
);

// ── 8. late response ──────────────────────────────────────────────────────────
section('10. late response');

const lateRequestId = `b11-late-${Date.now().toString(36)}`;
const beforeLateCount = reconnectedPeer.commandList.length;
const lateResult = reconnectedPeer.sendRaw(
  JSON.stringify({
    type: 'command_result',
    requestId: lateRequestId,
    capability: 'mobile.notifications',
    ok: true,
    result: { posted: true },
    ts: Date.now(),
  }),
);
check('el peer acepta mandar un result tardío', lateResult === undefined);
await delay(600);
check(
  'un result tardío no ejecuta ni completa ningún comando',
  reconnectedPeer.commandList.length === beforeLateCount,
  String(reconnectedPeer.commandList.length),
);
const afterLate = await callBridge<TargetAnswer>('resolveCapabilityTarget', {
  capabilityName: 'mobile.notifications',
  targetPreference: { kind: 'device', deviceId: MOBILE_DEVICE_ID },
});
check(
  'el device sigue online después de un result tardío',
  afterLate.status === 'resolved',
  JSON.stringify(afterLate),
);

// ── 2b. comando real con correlación completa ────────────────────────────────
section('11. comando real end-to-end con correlación');

const correlatedRequestId = `b11-corr-${Date.now().toString(36)}`;
const clientTurnId = `turn-${Date.now().toString(36)}`;
const commandPromise = callBridge<CommandAnswer>('sendMobileCommand', {
  targetDeviceId: MOBILE_DEVICE_ID,
  capabilityName: 'mobile.media',
  commandName: 'media_play',
  requestId: correlatedRequestId,
  clientTurnId,
  generation: 3,
  payload: { query: 'album' },
});
const didReceive = await waitUntil(
  () =>
    reconnectedPeer.commandList.some(
      (command) => command['requestId'] === correlatedRequestId,
    ),
  25_000,
);
check('el peer recibió el comando mobile.media', didReceive);

const receivedCommand = reconnectedPeer.commandList.find(
  (command) => command['requestId'] === correlatedRequestId,
);
check(
  'el comando conserva requestId, clientTurnId y generation',
  receivedCommand?.['requestId'] === correlatedRequestId &&
    receivedCommand?.['clientTurnId'] === clientTurnId &&
    receivedCommand?.['generation'] === 3,
  JSON.stringify(receivedCommand),
);
check(
  'el comando lleva el command explícito que pidió el caller',
  receivedCommand?.['command'] === 'media_play',
  JSON.stringify(receivedCommand?.['command']),
);
const commandAnswer = await commandPromise;
check(
  'el command_result vuelve con el requestId intacto',
  commandAnswer.result?.['requestId'] === correlatedRequestId,
  JSON.stringify(commandAnswer),
);
check(
  'el command_result trae deviceId y capability',
  commandAnswer.result?.['deviceId'] === MOBILE_DEVICE_ID &&
    commandAnswer.result?.['capability'] === 'mobile.media',
  JSON.stringify(commandAnswer.result),
);

// ── 5b. command no declarado por su capability ────────────────────────────────
section('12. seguridad: un comando que su capability no declara');

const unsupportedCommand = await callBridge<CommandAnswer>('sendMobileCommand', {
  targetDeviceId: MOBILE_DEVICE_ID,
  capabilityName: 'mobile.media',
  commandName: 'media_stop',
  requestId: `b11-unsupported-${Date.now().toString(36)}`,
  payload: { query: 'album' },
});
check(
  'un comando no declarado se rechaza como unsupported_command',
  unsupportedCommand.status === 'failed' &&
    unsupportedCommand.reason === 'unsupported_command',
  JSON.stringify(unsupportedCommand),
);
const invalidPayload = await callBridge<CommandAnswer>('sendMobileCommand', {
  targetDeviceId: MOBILE_DEVICE_ID,
  capabilityName: 'mobile.alarm',
  commandName: 'alarm_cancel',
  requestId: `b11-invalid-${Date.now().toString(36)}`,
  payload: { hourMinute: '07:30' },
});
check(
  'un payload que no matchea el comando se rechaza como invalid_payload',
  invalidPayload.status === 'failed' && invalidPayload.reason === 'invalid_payload',
  JSON.stringify(invalidPayload),
);
const crossDevice = await callBridge<CommandAnswer>('sendMobileCommand', {
  targetDeviceId: 'desktop:PC-ESTUDIO',
  capabilityName: 'mobile.notifications',
  requestId: `b11-cross-${Date.now().toString(36)}`,
  payload: { title: 'Apollo', body: 'No debe llegar' },
});
check(
  'una capability mobile dirigida a un deviceId desktop no se ejecuta',
  crossDevice.status === 'failed' && crossDevice.reason === 'unknown_device',
  JSON.stringify(crossDevice),
);

reconnectedPeer.disconnect();
peer.disconnect();

// ── resultado ─────────────────────────────────────────────────────────────────
console.log('');
console.log(`checks: ${checkCount}, fallos: ${failureCount}`);
if (failureCount > 0) {
  console.log('');
  console.log('SMOKE FAIL');
  process.exit(1);
}
console.log('');
console.log(
  'SMOKE OK: Apollo orquestando desktop + mobile, failover, idempotencia y correlación.',
);
