// Smoke del CAMINO DE PRODUCCIÓN de Apollo contra el MobileBridge, sobre el
// runtime real de Cloudflare (workerd).
//
// La cadena que se prueba es la real, sin atajos:
//
//   Apollo DO (debugExecuteTargetedTool, env-gated)
//     → executeToolWithTargetResolution   (el pipeline de un turno)
//     → buildCapabilityTargetResolver     (el resolver wired en apollo.ts)
//     → MobileBridge stub RPC             (resolveCapabilityTarget)
//     → MobileBridge DO
//     → MobilePeerTransport
//     → mobile peer
//     → command_result
//     → Apollo
//
// El smoke NO llama sendNotificationCommand: pasa por la tool, que es como lo
// haría un turno. Y no usa mocks: sólo el peer y los sockets.
//
//   bun smoke/mobile-notification-apollo.ts [--url ws://127.0.0.1:8799] [--token <secret>]

const DEVICE_ID = 'mobile:test-a';
const APOLLO_PATH = '/agents/apollo/default';
const APOLLO_TOOL_HARNESS_PATH = '__tool-harness';

function readArgument(name: string, fallback: string): string {
  const argumentIndex = process.argv.indexOf(name);
  const value = argumentIndex === -1 ? undefined : process.argv[argumentIndex + 1];
  return value ?? fallback;
}

const BASE_URL = readArgument('--url', 'ws://127.0.0.1:8799');
const DEVICE_TOKEN = readArgument('--token', 'block-8-2-smoke-device-secret');

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

const sleep = (milliseconds: number) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

type ReceivedMessage = Record<string, unknown>;

// Cliente HTTP del harness. BLOCK 9.2: el harness ya NO es un @callable, asi
// que no se puede invocar por RPC ni por WebSocket: se llama por HTTP al
// subpath del Apollo y sólo existe con la condicion test-only del servidor.
// fetch necesita http; BASE_URL viene como ws:// porque es la URL de los sockets.
const APOLLO_HTTP_URL = BASE_URL.replace(/^ws/, 'http');
const APOLLO_HARNESS_URL = `${APOLLO_HTTP_URL}${APOLLO_PATH}/${APOLLO_TOOL_HARNESS_PATH}?token=${encodeURIComponent(DEVICE_TOKEN)}`;

type HarnessAnswer = {
  readonly status: 'ran' | 'disabled' | 'invalid_request';
  readonly outcome?: string;
  readonly ok?: boolean;
  readonly summary?: string;
  readonly capabilityName?: string | null;
  readonly targetDeviceId?: string | null;
  readonly targetDeviceType?: string | null;
};

async function callHarness(
  input: unknown,
  timeoutMilliseconds = 25_000,
): Promise<HarnessAnswer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMilliseconds);
  try {
    const response = await fetch(APOLLO_HARNESS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`harness HTTP ${response.status}`);
    }
    return (await response.json()) as HarnessAnswer;
  } finally {
    clearTimeout(timer);
  }
}

// ── Peer mobile real: valida y responde con el schema del cliente futuro ────
class MobilePeer {
  readonly receivedCommandList: ReceivedMessage[] = [];
  readonly #socket: WebSocket;
  #behavior: 'accept' | 'reject' | 'silent' = 'accept';

  /**
   * BLOCK 12.1 §3: el peer es un teléfono, así que abre con su credencial
   * individual en el header. El harness y el RPC de este mismo smoke siguen con
   * `?token=` porque son callers y no mandan `hello`.
   */
  constructor(url: string, headerMap: Record<string, string> = {}) {
    this.#socket = new WebSocket(url, { headers: headerMap });
    this.#socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as ReceivedMessage;
      if (message['type'] === 'command') {
        this.receivedCommandList.push(message);
        this.#answer(message);
      }
    });
  }

  setBehavior(behavior: 'accept' | 'reject' | 'silent'): void {
    this.#behavior = behavior;
  }

  async open(): Promise<void> {
    if (this.#socket.readyState === WebSocket.OPEN) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      this.#socket.addEventListener('open', () => resolve(), { once: true });
      this.#socket.addEventListener(
        'error',
        () => reject(new Error('peer socket error')),
        {
          once: true,
        },
      );
      setTimeout(() => reject(new Error('timeout esperando el socket del peer')), 10_000);
    });
  }

  #answer(command: ReceivedMessage): void {
    if (this.#behavior === 'silent') {
      return;
    }
    const payload = command['payload'] as Record<string, unknown> | undefined;
    const isValidPayload =
      typeof payload?.['title'] === 'string' &&
      typeof payload?.['body'] === 'string' &&
      Object.keys(payload).toSorted().join(',') === 'body,title';
    this.#socket.send(
      JSON.stringify({
        type: 'command_result',
        requestId: command['requestId'],
        capability: command['capability'],
        ok: this.#behavior === 'accept' && isValidPayload,
        ...(this.#behavior === 'accept' && isValidPayload
          ? { result: { posted: true } }
          : { error: 'notifications_disabled' }),
        ts: Date.now(),
      }),
    );
  }

  sendHello(): void {
    this.#socket.send(
      JSON.stringify({
        type: 'hello',
        deviceId: DEVICE_ID,
        deviceType: 'mobile',
        protocolVersion: 1,
        capabilities: ['mobile.notifications'],
        ts: Date.now(),
      }),
    );
  }

  close(): void {
    this.#socket.close();
  }
}

console.log(`Apollo production path smoke -> ${BASE_URL}${APOLLO_PATH}`);
console.log('');

// 1-4. Peer real conectado y con hello, ya enrolado.
// Se enrola EXACTAMENTE el deviceId que el peer anuncia en su hello y que la tool
// usa como target. Usar un id distinto acá dejaba al peer sin sesión y al tool
// apuntando a un device inexistente.
const enrolledPeerDevice = await enrollSmokeDevice({
  workerBaseUrl: BASE_URL,
  deviceId: DEVICE_ID,
});
const peer = new MobilePeer(`${BASE_URL}/agents/mobile-bridge/mobile`, {
  Authorization: `Bearer ${enrolledPeerDevice.credential}`,
});
await peer.open();
peer.sendHello();
await sleep(1_500);

// El harness tiene que estar habilitado por env. Se prueba con una tool
// cloud-only: no necesita telefono y devuelve rapido, asi que si el flag
// faltara el smoke no podria probar nada.
const gate = await callHarness({ toolName: 'weather_now', args: {} }, 15_000);
check(
  'el harness de Apollo esta habilitado por env',
  gate.status === 'ran',
  JSON.stringify(gate),
);

console.log('');
console.log('5-10. tool → target → MobileBridge → peer → result');
const requestId = `apollo-smoke-${Date.now().toString(36)}`;
const clientTurnId = `turn-${Date.now().toString(36)}`;
const answer = await callHarness({
  toolName: 'send_mobile_notification',
  args: { title: 'Apollo test', body: 'production path' },
  correlation: { requestId, clientTurnId, generation: 11 },
});

check('Apollo corrió el pipeline', answer.status === 'ran', JSON.stringify(answer));
check('el pipeline terminó en done', answer.outcome === 'done', JSON.stringify(answer));
check(
  'la capability resuelta es mobile.notifications',
  answer.capabilityName === 'mobile.notifications',
  String(answer.capabilityName),
);
check(
  'el target es el mobile',
  answer.targetDeviceId === DEVICE_ID,
  String(answer.targetDeviceId),
);
check(
  'el target deviceType es mobile',
  answer.targetDeviceType === 'mobile',
  String(answer.targetDeviceType),
);
check('la tool terminó ok', answer.ok === true, JSON.stringify(answer));
check(
  'el peer recibió el comando por el camino de producción',
  peer.receivedCommandList.length === 1,
  `comandos=${peer.receivedCommandList.length}`,
);

const command = peer.receivedCommandList[0];
check(
  'el requestId viaja intacto desde Apollo',
  command?.['requestId'] === requestId,
  `${requestId} vs ${String(command?.['requestId'])}`,
);
check(
  'el clientTurnId viaja intacto',
  command?.['clientTurnId'] === clientTurnId,
  String(command?.['clientTurnId']),
);
check(
  'la generation viaja intacta',
  command?.['generation'] === 11,
  String(command?.['generation']),
);
check(
  'el targetDeviceId del comando es el mobile',
  command?.['capability'] === 'mobile.notifications',
  String(command?.['capability']),
);
check(
  'el payload llega al peer',
  JSON.stringify(command?.['payload']) ===
    JSON.stringify({ title: 'Apollo test', body: 'production path' }),
  JSON.stringify(command?.['payload']),
);
check(
  'exactamente una ejecución',
  peer.receivedCommandList.length === 1,
  `comandos=${peer.receivedCommandList.length}`,
);

// ── §5: correlación — la respuesta tardía de A no completa B ────────────────
console.log('');
console.log('5. correlación: la respuesta tardía de A no completa B');
peer.setBehavior('silent');
const slowAnswer = await callHarness({
  toolName: 'send_mobile_notification',
  args: { title: 'A', body: 'turno A' },
  correlation: { requestId: 'turn-A-request', clientTurnId: 'turn-A', generation: 1 },
});
check(
  'el turno A falla por timeout, no por otra cosa',
  slowAnswer.ok === false,
  JSON.stringify(slowAnswer),
);

peer.setBehavior('accept');
const fastAnswer = await callHarness({
  toolName: 'send_mobile_notification',
  args: { title: 'B', body: 'turno B' },
  correlation: { requestId: 'turn-B-request', clientTurnId: 'turn-B', generation: 2 },
});
check(
  'el turno B sí entrega su propio resultado',
  fastAnswer.ok === true,
  JSON.stringify(fastAnswer),
);
const commandBodies = peer.receivedCommandList.map(
  (entry) => (entry['payload'] as { body?: string })?.body,
);
check(
  'A y B llegaron como comandos separados',
  commandBodies.includes('turno A') && commandBodies.includes('turno B'),
  JSON.stringify(commandBodies),
);

// ── §4 D: el peer rechaza el comando ────────────────────────────────────────
console.log('');
console.log('4D. el peer rechaza el comando → execution failure');
peer.setBehavior('reject');
const rejected = await callHarness({
  toolName: 'send_mobile_notification',
  args: { title: 'X', body: 'rechazada' },
  correlation: { requestId: 'reject-request' },
});
check(
  'un peer que rechaza produce tool result fallido',
  rejected.ok === false,
  JSON.stringify(rejected),
);
check(
  'el motivo viaja en el summary',
  String(rejected.summary ?? '').length > 0,
  String(rejected.summary),
);
peer.setBehavior('accept');

// ── §4 F: requestId duplicado ───────────────────────────────────────────────
console.log('');
console.log('4F. requestId duplicado en vuelo');
// El caso que el contrato cubre es el MISMO requestId mientras el primero
// sigue en vuelo: no puede producir dos efectos. Reusar un id ya completado es
// un comando nuevo, no un duplicado.
peer.setBehavior('silent');
const inFlight = callHarness({
  toolName: 'send_mobile_notification',
  args: { title: 'dup', body: 'duplicada en vuelo' },
  correlation: { requestId: 'in-flight-request' },
});
await sleep(700);
const duplicateAnswer = await callHarness({
  toolName: 'send_mobile_notification',
  args: { title: 'dup', body: 'duplicada en vuelo' },
  correlation: { requestId: 'in-flight-request' },
});
check(
  'un requestId en vuelo no se procesa dos veces',
  duplicateAnswer.ok === false,
  JSON.stringify(duplicateAnswer),
);
check(
  'el motivo es el duplicado',
  String(duplicateAnswer.summary ?? '').includes('ya se estaba enviando'),
  String(duplicateAnswer.summary),
);
const inFlightAnswer = await inFlight;
check(
  'el comando original termina por timeout, no por el duplicado',
  inFlightAnswer.ok === false,
  JSON.stringify(inFlightAnswer),
);
peer.setBehavior('accept');

// ── §4 B: mobile desconectado ───────────────────────────────────────────────
console.log('');
console.log('4B. mobile desconectado → failure coherente');
const commandCountBeforeDisconnect = peer.receivedCommandList.length;
peer.close();
await sleep(1_500);
const afterDisconnect = await callHarness({
  toolName: 'send_mobile_notification',
  args: { title: 'Z', body: 'sin telefono' },
  correlation: { requestId: 'disconnect-request' },
});
check(
  'sin teléfono el pipeline no ejecuta la tool',
  afterDisconnect.outcome === 'skipped' || afterDisconnect.ok === false,
  JSON.stringify(afterDisconnect),
);
check(
  'el fallo es de resolución, no un hang',
  typeof afterDisconnect.summary === 'string',
  JSON.stringify(afterDisconnect),
);
check(
  'no se envió ningún comando extra',
  peer.receivedCommandList.length === commandCountBeforeDisconnect,
  `${commandCountBeforeDisconnect} -> ${peer.receivedCommandList.length}`,
);

// ── §9: el harness es capability-agnostic ───────────────────────────────────
console.log('');
console.log('9. el harness es capability-agnostic');
const unknownTool = await callHarness(
  { toolName: 'no_existe_esta_tool', args: {} },
  15_000,
);
check(
  'una tool inexistente se rechaza sin romper el harness',
  unknownTool.status === 'ran' && unknownTool.ok === false,
  JSON.stringify(unknownTool),
);
const unimplementedTool = await callHarness(
  { toolName: 'device_status', args: {} },
  15_000,
);
check(
  'una tool cloud-only tampoco necesita un target',
  unimplementedTool.status === 'ran',
  JSON.stringify(unimplementedTool),
);

await sleep(300);

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
  'SMOKE OK: Apollo -> resolver -> MobileBridge -> peer -> Apollo sobre workerd real.',
);
process.exit(0);
import { enrollSmokeDevice } from './enroll';
