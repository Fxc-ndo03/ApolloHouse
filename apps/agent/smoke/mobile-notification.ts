// Smoke real de mobile.notifications contra el runtime real de Cloudflare
// (workerd) con el MobileBridge real, vía `wrangler dev`.
//
// No usa mocks: el socket es un WebSocket real, el bridge es el DO real y el
// comando sale por la misma ruta que usaría el runtime en producción
// (resolveCapabilityTarget → sendNotificationCommand).
//
//   bun smoke/mobile-notification.ts [--url ws://127.0.0.1:8799] [--token <secret>]

const DEVICE_ID = 'mobile:test-a';

function readArgument(name: string, fallback: string): string {
  const argumentIndex = process.argv.indexOf(name);
  const value = argumentIndex === -1 ? undefined : process.argv[argumentIndex + 1];
  return value ?? fallback;
}

const BASE_URL = readArgument('--url', 'ws://127.0.0.1:8799');
const DEVICE_TOKEN = readArgument('--token', 'block-8-2-smoke-device-secret');
const DEVICE_PATH = '/agents/mobile-bridge/mobile';
const BRIDGE_PATHNAME = DEVICE_PATH;
const BRIDGE_URL = `${BASE_URL}${BRIDGE_PATHNAME}`;
// BLOCK 12.1 §3: el socket de un dispositivo se autentica con su credencial
// individual en el header. El de los callers (RPC, inspector) sigue usando
// `?token=` porque no manda `hello` y no es una identidad mobile.
const BRIDGE_RPC_URL = `${BASE_URL}${BRIDGE_PATHNAME}?token=${encodeURIComponent(
  DEVICE_TOKEN,
)}`;

const failureList: string[] = [];
let checkCount = 0;

function check(label: string, condition: boolean, detail: string): void {
  checkCount += 1;
  if (condition) {
    console.log(`  ok   ${label}`);
    return;
  }
  failureList.push(`${label} -- ${detail}`);
  console.log(`  FAIL ${label} -- ${detail}`);
}

type ReceivedMessage = Record<string, unknown>;

const receivedMessageList: ReceivedMessage[] = [];
const enrolledDevice = await enrollSmokeDevice({
  workerBaseUrl: BASE_URL,
  deviceId: DEVICE_ID,
});
const socket = new WebSocket(BRIDGE_URL, {
  headers: { Authorization: `Bearer ${enrolledDevice.credential}` },
});

await new Promise<void>((resolve, reject) => {
  socket.addEventListener('open', () => resolve(), { once: true });
  socket.addEventListener('error', () => reject(new Error('socket error')), {
    once: true,
  });
  setTimeout(() => reject(new Error('timeout esperando open')), 10_000);
});
socket.addEventListener('message', (event) => {
  receivedMessageList.push(JSON.parse(String(event.data)) as ReceivedMessage);
});

const sleep = (milliseconds: number) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

function findMessage(type: string): ReceivedMessage | undefined {
  return receivedMessageList.filter((message) => message['type'] === type).at(-1);
}

// Cliente RPC sobre un WebSocket crudo. El protocolo RPC del DO es el mismo que
// usa el runtime; el cliente del SDK no se usa porque su handshake no termina
// contra este bridge (el bridge no pasa por routeAgentRequest).
type RawRpcAnswer = {
  readonly success: boolean;
  readonly result?: unknown;
  readonly error?: string;
};

class RawRpcBridge {
  readonly #socket: WebSocket;
  readonly #pendingMap = new Map<string, (answer: RawRpcAnswer) => void>();
  #counter = 0;

  constructor(url: string) {
    this.#socket = new WebSocket(url);
    this.#socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as Record<string, unknown>;
      if (message['type'] !== 'rpc') {
        return;
      }
      const id = String(message['id'] ?? '');
      const settle = this.#pendingMap.get(id);
      if (settle === undefined) {
        return;
      }
      this.#pendingMap.delete(id);
      settle(message as unknown as RawRpcAnswer);
    });
  }

  async open(): Promise<void> {
    if (this.#socket.readyState === WebSocket.OPEN) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      this.#socket.addEventListener('open', () => resolve(), { once: true });
      this.#socket.addEventListener(
        'error',
        () => reject(new Error('rpc socket error')),
        {
          once: true,
        },
      );
      setTimeout(() => reject(new Error('timeout esperando el socket RPC')), 10_000);
    });
  }

  async call(
    method: string,
    input: unknown,
    timeoutMilliseconds = 15_000,
  ): Promise<RawRpcAnswer> {
    this.#counter += 1;
    const id = `smoke-rpc-${this.#counter}`;
    const answer = new Promise<RawRpcAnswer>((resolve, reject) => {
      this.#pendingMap.set(id, resolve);
      setTimeout(() => {
        this.#pendingMap.delete(id);
        reject(new Error(`RPC ${method} sin respuesta`));
      }, timeoutMilliseconds);
    });
    this.#socket.send(JSON.stringify({ type: 'rpc', id, method, args: [input] }));
    return answer;
  }

  close(): void {
    this.#socket.close();
  }
}

const rpcBridge = new RawRpcBridge(BRIDGE_RPC_URL);
await rpcBridge.open();

async function callBridge<T>(method: string, input: unknown): Promise<T> {
  const answer = await rpcBridge.call(method, input);
  if (!answer.success) {
    throw new Error(`RPC ${method} falló: ${String(answer.error)}`);
  }
  return answer.result as T;
}

type TargetAnswer = {
  readonly status: 'resolved' | 'unavailable';
  readonly deviceId: string | null;
  readonly deviceType: string | null;
  readonly presence: string | null;
  readonly reason: string | null;
  readonly commandList: readonly string[];
};

type NotificationAnswer = {
  readonly status: 'completed' | 'failed';
  readonly reason?: string;
  readonly detail?: string;
  readonly result?: Record<string, unknown>;
};

const capabilityToolNameList = ['mobile.notifications'];

console.log(
  `mobile.notifications smoke -> ${BRIDGE_URL.replace(/token=[^&]*/, 'token=***')}`,
);
console.log('');

// 1-3. Conectar y completar hello declarando la capability.
socket.send(
  JSON.stringify({
    type: 'hello',
    deviceId: DEVICE_ID,
    deviceType: 'mobile',
    protocolVersion: 1,
    capabilities: capabilityToolNameList,
    ts: Date.now(),
  }),
);
await sleep(1_500);

const accepted = findMessage('hello_accepted');
check(
  'hello aceptado por el bridge real',
  accepted !== undefined,
  JSON.stringify(receivedMessageList),
);
check(
  'availableCapabilities incluye mobile.notifications',
  JSON.stringify(accepted?.['availableCapabilities']) ===
    JSON.stringify(capabilityToolNameList),
  JSON.stringify(accepted?.['availableCapabilities']),
);

// 4-5. El peer recibe el comando real y responde.
console.log('');
console.log('envio de la notification por el RPC de producto');
const requestId = `smoke-${Date.now().toString(36)}`;
const clientTurnId = `turn-${Date.now().toString(36)}`;
const notificationPromise = callBridge<NotificationAnswer>('sendNotificationCommand', {
  targetDeviceId: DEVICE_ID,
  requestId,
  clientTurnId,
  generation: 5,
  payload: { title: 'Apollo', body: 'Smoke real' },
});

// El peer real: recibe el comando, valida capability y payload con el mismo
// schema del cliente móvil, y responde con un command_result.
let resolveCommandResult: ((message: NotificationAnswer | null) => void) | null = null;
const answerPromise = new Promise<NotificationAnswer | null>((resolve) => {
  resolveCommandResult = resolve;
  setTimeout(() => resolve(null), 20_000);
});
socket.addEventListener('message', (event) => {
  const message = JSON.parse(String(event.data)) as ReceivedMessage;
  if (message['type'] !== 'command') {
    return;
  }
  const payload = message['payload'] as { title?: string; body?: string } | undefined;
  const payloadIsValid =
    typeof payload?.title === 'string' &&
    payload.title.length > 0 &&
    typeof payload?.body === 'string' &&
    payload.body.length > 0 &&
    Object.keys(payload).toSorted().join(',') === 'body,title';
  const reply = {
    type: 'command_result',
    requestId: message['requestId'],
    capability: message['capability'],
    ok: payloadIsValid,
    ...(payloadIsValid ? { result: { posted: true } } : { error: 'invalid_payload' }),
    ts: Date.now(),
  };
  socket.send(JSON.stringify(reply));
  resolveCommandResult?.(reply as unknown as NotificationAnswer);
  resolveCommandResult = null;
});

const answer = await answerPromise;
check('el peer real recibió el comando', answer !== null, 'no hubo command_result');
check(
  'el comando带来 la capability correcta',
  answer?.['capability'] === 'mobile.notifications',
  JSON.stringify(answer),
);
check(
  'el requestId se preserva en el peer',
  answer?.['requestId'] === requestId,
  `${requestId} vs ${String(answer?.['requestId'])}`,
);
check('el peer responde ok', answer?.['ok'] === true, JSON.stringify(answer));
// Exactamente una ejecucion: el peer recibio un solo comando. El command_result
// lo MANDA el peer, asi que lo que se cuenta aca es el comando recibido.
const receivedCommandCount = receivedMessageList.filter(
  (message) => message['type'] === 'command',
).length;
check(
  'exactamente una ejecucion (un comando al peer)',
  receivedCommandCount === 1,
  `comandos recibidos=${receivedCommandCount}`,
);

// 6-8. Apollo recibe el resultado por el RPC.
const notificationAnswer = await notificationPromise;
check(
  'el RPC reporta completed',
  notificationAnswer?.status === 'completed',
  JSON.stringify(notificationAnswer),
);
check(
  'el resultado conserva requestId/deviceId/capability',
  notificationAnswer?.result?.['requestId'] === requestId &&
    notificationAnswer?.result?.['deviceId'] === DEVICE_ID &&
    notificationAnswer?.result?.['capability'] === 'mobile.notifications',
  JSON.stringify(notificationAnswer?.result),
);

// 9. El target se resuelve contra el mobile real, nunca contra un desktop.
console.log('');
console.log('target resolution por el RPC de discovery');
const resolution = await callBridge<TargetAnswer>('resolveCapabilityTarget', {
  capabilityName: 'mobile.notifications',
  targetPreference: { kind: 'device_type', deviceType: 'mobile' },
});
check(
  'discovery resuelve el mobile',
  resolution?.status === 'resolved',
  JSON.stringify(resolution),
);
check(
  'discovery devuelve el deviceId correcto',
  resolution?.deviceId === DEVICE_ID,
  String(resolution?.deviceId),
);
check(
  'discovery devuelve deviceType mobile',
  resolution?.deviceType === 'mobile',
  String(resolution?.deviceType),
);
check(
  'discovery devuelve el comando del catálogo',
  JSON.stringify(resolution?.commandList) === JSON.stringify(['notification_post']),
  JSON.stringify(resolution?.commandList),
);

// BLOCK 11: mobile.alarm ya está implementada, así que el motivo correcto de
// "no resuelve" es que este peer NO la declara. La invariante que importa es
// que una capability que el device no declara nunca se vuelve target.
const undeclared = await callBridge<TargetAnswer>('resolveCapabilityTarget', {
  capabilityName: 'mobile.alarm',
  targetPreference: { kind: 'device_type', deviceType: 'mobile' },
});
check(
  'una capability que el peer no declara no resuelve',
  undeclared?.status === 'unavailable',
  JSON.stringify(undeclared),
);
check(
  'el motivo es capability_absent, no unimplemented',
  undeclared?.reason === 'capability_absent',
  String(undeclared?.reason),
);

// Y una capability que NO existe en el catálogo ni se puede implementar.
const unknownCapability = await callBridge<TargetAnswer>('resolveCapabilityTarget', {
  capabilityName: 'mobile.telepathy',
  targetPreference: { kind: 'device_type', deviceType: 'mobile' },
}).catch(() => null);
check(
  'una capability desconocida no resuelve',
  unknownCapability === null || unknownCapability.status === 'unavailable',
  JSON.stringify(unknownCapability),
);

// 10. Un deviceId explícito se respeta.
const byDeviceId = await callBridge<TargetAnswer>('resolveCapabilityTarget', {
  capabilityName: 'mobile.notifications',
  targetPreference: { kind: 'device', deviceId: DEVICE_ID },
});
check(
  'target por deviceId explícito',
  byDeviceId?.deviceId === DEVICE_ID,
  JSON.stringify(byDeviceId),
);

socket.close();
rpcBridge.close();
await sleep(500);

console.log('');
console.log(`checks: ${checkCount}, fallos: ${failureList.length}`);
if (failureList.length > 0) {
  for (const failure of failureList) {
    console.log(`FALLO: ${failure}`);
  }
  process.exit(1);
}
console.log('');
console.log(
  'SMOKE OK: mobile.notifications recorre tool -> target -> MobileBridge -> peer -> result sobre workerd real.',
);
process.exit(0);
import { enrollSmokeDevice } from './enroll';
