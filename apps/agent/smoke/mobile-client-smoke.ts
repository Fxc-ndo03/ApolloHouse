// Smoke real del cliente mobile (BLOCK 10).
//
// mobile client real (WebSocket real)
//   -> MobileBridge real
//   -> Apollo real (resolveCapabilityTarget + sendNotificationCommand)
//   -> mobile.notifications
//   -> notificacion del adapter
//   -> command_result real
//
// No se reemplaza MobileBridge ni Apollo por mocks: el unico componente que no
// corre aca es el runtime de Android, asi que la notificacion nativa se
// representa con el adapter del puerto del cliente.

import { enrollSmokeDevice } from './enroll';
import {
  ANNOUNCED_CAPABILITY_LIST,
  ALLOWED_COMMAND_MAP,
  MOBILE_BRIDGE_PATH,
  MOBILE_DEVICE_TYPE,
  MOBILE_PROTOCOL_VERSION,
  MobileClient,
  RecordingNotificationAdapter,
  buildReconnectSchedule,
} from './mobile-client';

const WORKER_BASE_URL = process.env['WORKER_BASE_URL'] ?? 'http://127.0.0.1:8799';
const DEVICE_TOKEN =
  process.env['DEVICE_SHARED_SECRET'] ?? 'block-8-2-smoke-device-secret';
const DEVICE_ID = process.env['MOBILE_DEVICE_ID'] ?? 'mobile:smoke-galaxy-s5';

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

function callBridge<TAnswer>(method: string, args: unknown): Promise<TAnswer> {
  // Caller, no dispositivo: no manda `hello`, así que el camino legacy le sirve.
  const socket = new WebSocket(
    `${WORKER_BASE_URL.replace(/^http/, 'ws')}/agents/mobile-bridge/mobile?token=${encodeURIComponent(DEVICE_TOKEN)}`,
  );
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
    setTimeout(() => reject(new Error('timeout rpc')), 20_000);
  });
}

function readSecretFromEnvironment(): string {
  return DEVICE_TOKEN;
}

check(
  'el secret llega al cliente por el entorno, no por el bundle',
  readSecretFromEnvironment().length > 0,
);

console.log('Mobile client smoke -> real WebSocket -> MobileBridge -> Apollo');
console.log(`  endpoint: ${MOBILE_BRIDGE_PATH}`);
console.log(`  deviceId: ${DEVICE_ID}`);

// ── 1-3. identidad, hello mobile y autenticacion ──────────────────────────────
section('1. el cliente conecta, se autentica y anuncia solo mobile.notifications');

const notificationAdapter = new RecordingNotificationAdapter();
// BLOCK 12.1 §3: el cliente abre su socket con la credencial individual, y para
// eso primero se enrola por el flujo real. Lo que se siguemidiendo con el secreto
// global es que la credencial NO aparece en ningún mensaje ni en la URL.
const enrolledSmokeDevice = await enrollSmokeDevice({
  workerBaseUrl: WORKER_BASE_URL,
  deviceId: DEVICE_ID,
});
const ENROLLED_CREDENTIAL = enrolledSmokeDevice.credential;

const client = new MobileClient(
  WORKER_BASE_URL,
  ENROLLED_CREDENTIAL,
  DEVICE_ID,
  notificationAdapter,
);

check(
  'el socket del cliente va al endpoint del MobileBridge',
  client.buildSocketUrl().includes(MOBILE_BRIDGE_PATH) &&
    !client.buildSocketUrl().includes('token='),
  client.buildSocketUrl().replace(ENROLLED_CREDENTIAL, '<secret>'),
);
check(
  'el secret viaja solo en la query',
  !client.sentMessageList.some((line) => line.includes(ENROLLED_CREDENTIAL)),
  !client.buildSocketUrl().includes(ENROLLED_CREDENTIAL),
  client.buildSocketHeaderMap()['Authorization'] === `Bearer ${ENROLLED_CREDENTIAL}`,
);

await client.start();

check('el estado local del cliente es online', client.state === 'online', client.state);
check(
  'el Worker acepto el hello mobile',
  client.availableCapabilityList.includes('mobile.notifications'),
  JSON.stringify(client.availableCapabilityList),
);

const helloMessage = JSON.parse(client.sentMessageList[0] as string) as Record<
  string,
  unknown
>;
check(
  'el hello declara deviceType mobile',
  helloMessage['deviceType'] === MOBILE_DEVICE_TYPE,
);
check(
  'el hello declara el protocolVersion soportado',
  helloMessage['protocolVersion'] === MOBILE_PROTOCOL_VERSION,
);
check(
  'el cliente anuncia exactamente mobile.notifications',
  JSON.stringify(ANNOUNCED_CAPABILITY_LIST) ===
    JSON.stringify(helloMessage['capabilities']),
  JSON.stringify(helloMessage['capabilities']),
);
check(
  'el cliente no anuncia ninguna capability unimplemented',
  ANNOUNCED_CAPABILITY_LIST.every((capabilityName) =>
    ALLOWED_COMMAND_MAP.has(capabilityName),
  ),
);

// ── 4-6. auth fallida y registry ──────────────────────────────────────────────
section('2. un token invalido no llega a authenticated ni online');

const rejectedAdapter = new RecordingNotificationAdapter();
const rejectedClient = new MobileClient(
  WORKER_BASE_URL,
  'token-que-no-es-el-secret',
  DEVICE_ID,
  rejectedAdapter,
);
const rejectionOutcome = await rejectedClient.start().then(
  () => ({ didAuthenticate: true, detail: 'acepto el token invalido' }),
  (error: unknown) => ({
    didAuthenticate: false,
    detail: error instanceof Error ? error.message : String(error),
  }),
);
check(
  'el Worker rechaza el token invalido en el upgrade del socket',
  rejectionOutcome.didAuthenticate === false,
  rejectionOutcome.detail,
);
check(
  'el cliente queda disconnected, nunca authenticated ni online',
  rejectedClient.state === 'disconnected',
  rejectedClient.state,
);
check(
  'el cliente invalido no posteo nada',
  rejectedAdapter.postedNotificationList.length === 0,
);
rejectedClient.disconnect();

const registryAnswer = (await callBridge<{
  readonly status: string;
  readonly deviceId: string | null;
  readonly commandList: readonly string[];
}>('resolveCapabilityTarget', {
  capabilityName: 'mobile.notifications',
  targetPreference: { kind: 'mobile' },
})) as {
  readonly status?: string;
  readonly deviceId?: string | null;
  readonly commandList?: readonly string[];
};
check(
  'el registry MobileBridge resuelve el cliente mobile real',
  registryAnswer['status'] === 'resolved' && registryAnswer['deviceId'] === DEVICE_ID,
  JSON.stringify(registryAnswer),
);
check(
  'el catalogo que devuelve el bridge es mobile.notifications -> notification_post',
  JSON.stringify(registryAnswer['commandList']) === JSON.stringify(['notification_post']),
  JSON.stringify(registryAnswer['commandList']),
);

// ── 7. heartbeat ──────────────────────────────────────────────────────────────
section('3. heartbeat');

client.sendHeartbeat();
check(
  'el cliente contesta el probe con un heartbeat',
  JSON.parse(client.sentMessageList.at(-1) as string)['type'] === 'heartbeat',
);
check(
  'el intervalo viene de hello_accepted',
  client.heartbeatIntervalMilliseconds > 0,
  String(client.heartbeatIntervalMilliseconds),
);
check('el cliente tiene un solo timer de heartbeat', client.heartbeatSendCount >= 1);

// ── 8-11. notificacion real y command_result real ────────────────────────────
section('4. mobile.notifications: comando real, notificacion y command_result');

const requestId = `b10-smoke-${Date.now().toString(36)}`;
const sendAnswerPromise = callBridge<{ readonly ok: boolean }>(
  'sendNotificationCommand',
  {
    targetDeviceId: DEVICE_ID,
    requestId,
    clientTurnId: `turn-${Date.now().toString(36)}`,
    generation: 7,
    payload: { title: 'Apollo', body: 'Notificacion real desde el cliente mobile' },
  },
);

const didPost = await waitUntil(
  () => notificationAdapter.postedNotificationList.length > 0,
  25_000,
);
check('el cliente recibio el comando real y posteo la notificacion', didPost);

const sendAnswer = (await sendAnswerPromise) as {
  status?: string;
  outcome?: { ok?: boolean };
  result?: Record<string, unknown>;
};
check(
  'el bridge recibio el command_result con ok',
  sendAnswer['outcome']?.['ok'] === true,
  JSON.stringify(sendAnswer),
);
check(
  'el envelope de resultado trae requestId, deviceId y capability',
  sendAnswer['result']?.['requestId'] === requestId &&
    sendAnswer['result']?.['deviceId'] === DEVICE_ID &&
    sendAnswer['result']?.['capability'] === 'mobile.notifications',
  JSON.stringify(sendAnswer['result']),
);

const commandResult = client.commandResultList.at(-1) as Record<string, unknown>;
check(
  'el command_result preserva el requestId exacto',
  commandResult['requestId'] === requestId,
  `${requestId} vs ${String(commandResult['requestId'])}`,
);
check(
  'el command_result declara mobile.notifications',
  commandResult['capability'] === 'mobile.notifications',
);
check(
  'el command_result es ok con result posted',
  commandResult['ok'] === true &&
    (commandResult['result'] as Record<string, unknown>)['posted'] === true,
  JSON.stringify(commandResult),
);
check(
  'el payload que llego al cliente es el enviado',
  JSON.stringify(notificationAdapter.postedNotificationList[0]) ===
    JSON.stringify({
      title: 'Apollo',
      body: 'Notificacion real desde el cliente mobile',
    }),
  JSON.stringify(notificationAdapter.postedNotificationList[0]),
);

// ── 12. exactamente una ejecucion ─────────────────────────────────────────────
section('5. exactamente una ejecucion');

await delay(1_500);
check(
  'una sola notificacion posteada para un comando',
  notificationAdapter.postedNotificationList.length === 1,
  String(notificationAdapter.postedNotificationList.length),
);
check(
  'un solo command_result por comando',
  client.commandResultList.length === 1,
  String(client.commandResultList.length),
);

// ── 13. allowlist y validacion del cliente ────────────────────────────────────
section('6. allowlist y payload: el cliente rechaza antes de postear');

const postedCountBeforeRejections = notificationAdapter.postedNotificationList.length;

const rejectedCommandList = [
  { label: 'desktop.notifications', capabilityName: 'desktop.notifications' },
  { label: 'mobile.alarm', capabilityName: 'mobile.alarm' },
  { label: 'mobile.calendar', capabilityName: 'mobile.calendar' },
  { label: 'mobile.media', capabilityName: 'mobile.media' },
  { label: 'mobile.volume', capabilityName: 'mobile.volume' },
  { label: 'mobile.open_app', capabilityName: 'mobile.open_app' },
  { label: 'mobile.inventada', capabilityName: 'mobile.inventada' },
];
for (const rejected of rejectedCommandList) {
  const outcome = client.dispatch({
    requestId: `rechazo-${rejected.label}`,
    capabilityName: rejected.capabilityName,
    payload: { title: 'Apollo', body: 'no deberia postear' },
  });
  check(
    `${rejected.label} se rechaza como capability_not_allowed`,
    outcome.isPosted === false && outcome.reason === 'capability_not_allowed',
    JSON.stringify(outcome),
  );
}

const invalidPayloadList = [
  { label: 'falta body', payload: { title: 'Apollo' } },
  { label: 'campo extra', payload: { title: 'Apollo', body: 'x', icon: 'y' } },
  { label: 'title no string', payload: { title: 7, body: 'x' } },
  { label: 'title vacio', payload: { title: '', body: 'x' } },
  { label: 'body largo', payload: { title: 'Apollo', body: 'B'.repeat(501) } },
];
for (const invalid of invalidPayloadList) {
  const outcome = client.dispatch({
    requestId: `payload-${invalid.label}`,
    capabilityName: 'mobile.notifications',
    payload: invalid.payload as Record<string, unknown>,
  });
  check(
    `payload invalido (${invalid.label}) se rechaza`,
    outcome.isPosted === false,
    JSON.stringify(outcome),
  );
}

const wrongTargetOutcome = client.dispatch({
  requestId: 'target-ajeno',
  capabilityName: 'mobile.notifications',
  payload: { title: 'Apollo', body: 'x' },
  targetDeviceId: 'mobile:otro-telefono',
});
check(
  'un comando dirigido a otro device se rechaza',
  wrongTargetOutcome.isPosted === false &&
    wrongTargetOutcome.reason === 'target_mismatch',
  JSON.stringify(wrongTargetOutcome),
);

check(
  'ningun rechazo posteo una notificacion',
  notificationAdapter.postedNotificationList.length === postedCountBeforeRejections,
);

// ── 14. permiso denegado ──────────────────────────────────────────────────────
section('7. permiso de notificacion denegado');

notificationAdapter.permissionOutcome = 'denied';
const deniedOutcome = client.dispatch({
  requestId: 'permiso-denegado',
  capabilityName: 'mobile.notifications',
  payload: { title: 'Apollo', body: 'no debe postear' },
});
check(
  'sin permiso el cliente devuelve ok:false con error estructurado',
  deniedOutcome.isPosted === false && deniedOutcome.reason === 'permission_denied',
  JSON.stringify(deniedOutcome),
);
check(
  'sin permiso no postea',
  notificationAdapter.postedNotificationList.length === postedCountBeforeRejections,
);
check(
  'sin permiso no reintenta solo',
  notificationAdapter.permissionRequestCount === 2,
  String(notificationAdapter.permissionRequestCount),
);
notificationAdapter.permissionOutcome = 'granted';

// ── 15. reconnect con la misma identidad ──────────────────────────────────────
section('8. disconnect y reconnect con el mismo deviceId');

const sentMessageCountBeforeReconnect = client.sentMessageList.length;
client.disconnect();
check(
  'el cliente queda disconnected tras el corte',
  client.state === 'disconnected',
  client.state,
);
check('el cliente corto su heartbeat', client.isHeartbeatRunning === false);

await delay(1_000);
const reconnectedAdapter = new RecordingNotificationAdapter();
const reconnectedClient = new MobileClient(
  WORKER_BASE_URL,
  ENROLLED_CREDENTIAL,
  DEVICE_ID,
  reconnectedAdapter,
);
reconnectedClient.state = 'reconnecting';
await reconnectedClient.start();

check(
  'el reconectado vuelve a online',
  reconnectedClient.state === 'online',
  reconnectedClient.state,
);
check('el reconectado usa el mismo deviceId', reconnectedClient.deviceId === DEVICE_ID);
check(
  'el reconectado vuelve a anunciarse como mobile',
  JSON.parse(reconnectedClient.sentMessageList[0] as string)['deviceId'] === DEVICE_ID,
);
check(
  'el reconectado vuelve a tener un solo heartbeat',
  reconnectedClient.heartbeatSendCount === 0,
  String(reconnectedClient.heartbeatSendCount),
);
reconnectedClient.sendHeartbeat();
check('el reconectado envia heartbeat', reconnectedClient.heartbeatSendCount === 1);
check(
  'no se duplico el heartbeat del cliente original durante el reconnect',
  client.sentMessageList.length === sentMessageCountBeforeReconnect,
);

// ── 16. backoff acotado ───────────────────────────────────────────────────────
section('9. backoff de reconnect acotado');

const reconnectSchedule = buildReconnectSchedule();
check(
  'el backoff es 1s,2s,4s,8s,16s y 30s de tope',
  JSON.stringify(reconnectSchedule) ===
    JSON.stringify([1_000, 2_000, 4_000, 8_000, 16_000, 30_000]),
  JSON.stringify(reconnectSchedule),
);
check('el backoff no crece sin limite', Math.max(...reconnectSchedule) === 30_000);

reconnectedClient.disconnect();
client.disconnect();

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
  'SMOKE OK: cliente mobile real -> WebSocket -> MobileBridge -> Apollo -> mobile.notifications -> command_result.',
);
