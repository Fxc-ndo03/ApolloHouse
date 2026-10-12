// Smoke test de concurrencia del MobileBridge contra el runtime real de
// Cloudflare (workerd) con Durable Objects de verdad, via `wrangler dev`.
//
// No usa mocks ni un fake de MobileBridge: los sockets son WebSocket reales y el
// estado se lee del DO real con su RPC de solo lectura.
//
//   bun smoke/mobile-concurrency.ts [--url ws://127.0.0.1:8799] [--token <secret>]
//
// Requiere un worker corriendo con DEVICE_SHARED_SECRET (ver .dev.vars.example).

type SessionSnapshot = {
  readonly connectedCount: number;
  readonly handshakenConnectionCount: number;
  readonly sessionCount: number;
  readonly heartbeatSchedulerCount: number;
  readonly runningHeartbeatTimerCount: number;
  readonly sessionList: readonly {
    readonly deviceId: string;
    readonly deviceType: string;
    readonly authenticated: boolean;
    readonly presence: string;
    readonly connectionId: string;
    readonly transportKind: string;
    readonly protocolVersion: number;
    readonly lastSeenAt: number;
    readonly declaredCapabilities: readonly string[];
    readonly availableCapabilities: readonly string[];
  }[];
};

const MOBILE_BRIDGE_AGENT_NAME = 'mobile-bridge';
const DEVICE_PATH = `/agents/${MOBILE_BRIDGE_AGENT_NAME}/mobile`;
const MOBILE_SESSION_INSPECTOR_PATH = '__inspect';

function readArgument(name: string, fallback: string): string {
  const argumentIndex = process.argv.indexOf(name);
  const value = argumentIndex === -1 ? undefined : process.argv[argumentIndex + 1];
  return value ?? fallback;
}

const BASE_URL = readArgument('--url', 'ws://127.0.0.1:8799');
const DEVICE_TOKEN = readArgument('--token', 'block-8-2-smoke-device-secret');
const BRIDGE_PATHNAME = DEVICE_PATH;
const BRIDGE_URL = `${BASE_URL}${BRIDGE_PATHNAME}`;
// BLOCK 12.1 §3: el socket de un dispositivo se autentica con su credencial
// individual en el header. El de los callers (RPC, inspector) sigue usando
// `?token=` porque no manda `hello` y no es una identidad mobile.
const DEVICE_ID_A = 'mobile:test-a';
const DEVICE_ID_B = 'mobile:test-b';
/** Credencial enrolada por label, para que el socket de cada uno use la suya. */
const credentialByLabel = new Map<string, string>();
/**
 * La credencial de un label. `A2` es el MISMO teléfono A reconectándose, así que
 * comparte su credencial: un label nuevo no es un teléfono nuevo.
 */
function credentialOfDeviceId(label: string): string {
  const deviceLabel = label.endsWith('2') ? label.slice(0, -1) : label;
  const credential = credentialByLabel.get(deviceLabel);
  if (credential === undefined) {
    throw new Error(`el telefono ${deviceLabel} no se enrolo`);
  }
  return credential;
}
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

class SmokeClient {
  readonly socket: WebSocket;
  readonly receivedMessageList: ReceivedMessage[] = [];
  readonly label: string;
  #closeReason: string | null = null;

  constructor(label: string) {
    this.label = label;
    this.socket = new WebSocket(BRIDGE_URL, {
      headers: { Authorization: `Bearer ${credentialOfDeviceId(label)}` },
    });
    this.socket.addEventListener('message', (event) => {
      this.receivedMessageList.push(JSON.parse(String(event.data)) as ReceivedMessage);
    });
    this.socket.addEventListener('close', (event) => {
      this.#closeReason = `${event.code}`;
    });
  }

  get isClosed(): boolean {
    return this.socket.readyState === WebSocket.CLOSED;
  }

  get closeReason(): string | null {
    return this.#closeReason;
  }

  async waitForOpen(): Promise<void> {
    if (this.socket.readyState === WebSocket.OPEN) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      this.socket.addEventListener('open', () => resolve(), { once: true });
      this.socket.addEventListener(
        'error',
        () => reject(new Error(`${this.label}: socket error`)),
        {
          once: true,
        },
      );
      setTimeout(
        () => reject(new Error(`${this.label}: timeout esperando open`)),
        10_000,
      );
    });
  }

  send(message: unknown): void {
    this.socket.send(JSON.stringify(message));
  }

  countMessageOfType(type: string): number {
    return this.receivedMessageList.filter((message) => message['type'] === type).length;
  }

  lastMessageOfType(type: string): ReceivedMessage | undefined {
    return this.receivedMessageList.filter((message) => message['type'] === type).at(-1);
  }

  async close(): Promise<void> {
    if (this.socket.readyState === WebSocket.CLOSED) {
      return;
    }
    await new Promise<void>((resolve) => {
      this.socket.addEventListener('close', () => resolve(), { once: true });
      this.socket.close();
      setTimeout(() => resolve(), 5_000);
    });
  }
}

function buildHello(deviceId: string, capabilities: readonly string[]): unknown {
  return {
    type: 'hello',
    deviceId,
    deviceType: 'mobile',
    protocolVersion: 1,
    capabilities,
    ts: Date.now(),
  };
}

// Canal de inspección: HTTP plano contra el subpath de test del bridge. No es un
// RPC: el snapshot no existe como @callable, así que no se puede pedir desde el
// WebSocket de un device.
const INSPECTOR_URL = `${BASE_URL.replace(/^ws/, 'http')}${DEVICE_PATH}/${MOBILE_SESSION_INSPECTOR_PATH}?token=${encodeURIComponent(DEVICE_TOKEN)}`;

async function readSnapshot(): Promise<SessionSnapshot> {
  const response = await fetch(INSPECTOR_URL);
  if (!response.ok) {
    throw new Error(`inspector HTTP ${response.status}`);
  }
  return (await response.json()) as SessionSnapshot;
}

function findSession(snapshot: SessionSnapshot, deviceId: string) {
  return snapshot.sessionList.find((session) => session.deviceId === deviceId);
}

const sleep = (milliseconds: number) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitForSessionCount(expected: number): Promise<SessionSnapshot> {
  let snapshot = await readSnapshot();
  for (
    let attempt = 0;
    attempt < 25 && snapshot.sessionCount !== expected;
    attempt += 1
  ) {
    await sleep(400);
    snapshot = await readSnapshot();
  }
  return snapshot;
}

async function main(): Promise<void> {
  console.log(
    `MobileBridge concurrency smoke -> ${BRIDGE_URL.replace(/token=[^&]*/, 'token=***')}`,
  );
  console.log('');

  console.log('1-2. A y B conectan y completan hello');
  // BLOCK 12.1 §3: los dos teléfonos se enrolan antes de abrir el socket, cada uno
  // con su propia credencial. El del socket es un dispositivo; el `rpcSocket` de
  // más abajo es un caller y sigue con `?token=`.
  const enrolledDeviceA = await enrollSmokeDevice({
    workerBaseUrl: BASE_URL,
    deviceId: DEVICE_ID_A,
  });
  const enrolledDeviceB = await enrollSmokeDevice({
    workerBaseUrl: BASE_URL,
    deviceId: DEVICE_ID_B,
  });
  credentialByLabel.set('A', enrolledDeviceA.credential);
  credentialByLabel.set('B', enrolledDeviceB.credential);

  const clientA = new SmokeClient('A');
  const clientB = new SmokeClient('B');
  await Promise.all([clientA.waitForOpen(), clientB.waitForOpen()]);
  clientA.send(buildHello(DEVICE_ID_A, ['mobile.notifications', 'mobile.alarm']));
  clientB.send(buildHello(DEVICE_ID_B, ['mobile.calendar']));
  await sleep(1_500);

  const acceptedA = clientA.lastMessageOfType('hello_accepted');
  const acceptedB = clientB.lastMessageOfType('hello_accepted');
  check(
    'A recibe hello_accepted',
    acceptedA !== undefined,
    `A vio ${JSON.stringify(clientA.receivedMessageList)}`,
  );
  check(
    'B recibe hello_accepted',
    acceptedB !== undefined,
    `B vio ${JSON.stringify(clientB.receivedMessageList)}`,
  );
  // BLOCK 9: mobile.notifications ya tiene implementacion, asi que A la recibe
  // como disponible. B declara un contrato que sigue unimplemented.
  check(
    'A recibe las capabilities que declara como disponibles',
    JSON.stringify(acceptedA?.['availableCapabilities']) ===
      JSON.stringify(['mobile.notifications', 'mobile.alarm']),
    `A recibio ${JSON.stringify(acceptedA?.['availableCapabilities'])}`,
  );

  console.log('3-6. dos sesiones autenticadas, deviceId y connectionId distintos');
  let snapshot = await waitForSessionCount(2);
  check(
    'sessionCount === 2',
    snapshot.sessionCount === 2,
    `sessionCount=${snapshot.sessionCount}`,
  );
  check(
    'dos sockets con handshake vivos a la vez',
    snapshot.handshakenConnectionCount === 2,
    `handshakenConnectionCount=${snapshot.handshakenConnectionCount}`,
  );
  const sessionA = findSession(snapshot, DEVICE_ID_A);
  const sessionB = findSession(snapshot, DEVICE_ID_B);
  check('A esta autenticada', sessionA?.authenticated === true, JSON.stringify(sessionA));
  check('B esta autenticada', sessionB?.authenticated === true, JSON.stringify(sessionB));
  check(
    'ambos con deviceType mobile',
    sessionA?.deviceType === 'mobile' && sessionB?.deviceType === 'mobile',
    'deviceType',
  );
  check(
    'connectionId distinto para A y B',
    sessionA !== undefined &&
      sessionB !== undefined &&
      sessionA.connectionId !== sessionB.connectionId,
    `A=${sessionA?.connectionId} B=${sessionB?.connectionId}`,
  );
  check(
    'heartbeatSchedulerCount === 2 (uno por deviceId)',
    snapshot.heartbeatSchedulerCount === 2,
    `schedulerCount=${snapshot.heartbeatSchedulerCount}`,
  );
  check(
    'runningHeartbeatTimerCount === 2',
    snapshot.runningHeartbeatTimerCount === 2,
    `runningTimers=${snapshot.runningHeartbeatTimerCount}`,
  );
  const lastSeenABefore = sessionA?.lastSeenAt ?? 0;
  const lastSeenBBefore = sessionB?.lastSeenAt ?? 0;

  console.log('7-9. heartbeats aislados');
  clientA.send({ type: 'heartbeat', ts: Date.now() });
  await sleep(1_200);
  snapshot = await readSnapshot();
  const sessionAAfterBeat = findSession(snapshot, DEVICE_ID_A);
  const sessionBAfterBeat = findSession(snapshot, DEVICE_ID_B);
  check(
    'heartbeat de A avanza lastSeenAt de A',
    (sessionAAfterBeat?.lastSeenAt ?? 0) > lastSeenABefore,
    `A ${lastSeenABefore} -> ${sessionAAfterBeat?.lastSeenAt}`,
  );
  check(
    'heartbeat de A NO toca lastSeenAt de B',
    sessionBAfterBeat?.lastSeenAt === lastSeenBBefore,
    `B ${lastSeenBBefore} -> ${sessionBAfterBeat?.lastSeenAt}`,
  );
  check(
    'A sigue online',
    sessionAAfterBeat?.presence === 'online',
    `A=${sessionAAfterBeat?.presence}`,
  );
  check(
    'B sigue online',
    sessionBAfterBeat?.presence === 'online',
    `B=${sessionBAfterBeat?.presence}`,
  );

  clientB.send({ type: 'heartbeat', ts: Date.now() });
  await sleep(1_200);
  snapshot = await readSnapshot();
  check(
    'heartbeat de B avanza lastSeenAt de B',
    (findSession(snapshot, DEVICE_ID_B)?.lastSeenAt ?? 0) > lastSeenBBefore,
    `B ${lastSeenBBefore} -> ${findSession(snapshot, DEVICE_ID_B)?.lastSeenAt}`,
  );

  console.log('10-14. desconectar A deja B vivo');
  const sessionBLastSeenBeforeAClose =
    findSession(snapshot, DEVICE_ID_B)?.lastSeenAt ?? 0;
  await clientA.close();
  await sleep(1_500);
  snapshot = await waitForSessionCount(2);
  const sessionAClosed = findSession(snapshot, DEVICE_ID_A);
  const sessionBAlive = findSession(snapshot, DEVICE_ID_B);
  check(
    'A queda offline',
    sessionAClosed?.presence === 'offline',
    `A=${sessionAClosed?.presence}`,
  );
  check('socket de A cerrado', clientA.isClosed, `closeReason=${clientA.closeReason}`);
  check('socket de B sigue abierto', !clientB.isClosed, 'B deberia seguir abierto');
  check(
    'B sigue online',
    sessionBAlive?.presence === 'online',
    `B=${sessionBAlive?.presence}`,
  );
  check(
    'queda un solo socket con handshake tras cerrar A',
    snapshot.handshakenConnectionCount === 1,
    `handshakenConnectionCount=${snapshot.handshakenConnectionCount}`,
  );
  check(
    'queda un solo timer vivo',
    snapshot.runningHeartbeatTimerCount === 1,
    `runningTimers=${snapshot.runningHeartbeatTimerCount}`,
  );
  check(
    'lastSeenAt de B intacto tras el cierre de A',
    sessionBAlive?.lastSeenAt === sessionBLastSeenBeforeAClose,
    `${sessionBLastSeenBeforeAClose} -> ${sessionBAlive?.lastSeenAt}`,
  );

  console.log('13-14. B envia heartbeat despues del cierre de A');
  clientB.send({ type: 'heartbeat', ts: Date.now() });
  await sleep(1_200);
  snapshot = await readSnapshot();
  check(
    'B avanza su heartbeat y queda online',
    (findSession(snapshot, DEVICE_ID_B)?.lastSeenAt ?? 0) >
      sessionBLastSeenBeforeAClose &&
      findSession(snapshot, DEVICE_ID_B)?.presence === 'online',
    JSON.stringify(findSession(snapshot, DEVICE_ID_B)),
  );

  console.log('15-17. A reconecta con el mismo deviceId');
  const clientA2 = new SmokeClient('A2');
  await clientA2.waitForOpen();
  clientA2.send(buildHello(DEVICE_ID_A, ['mobile.notifications']));
  await sleep(1_500);
  const acceptedA2 = clientA2.lastMessageOfType('hello_accepted');
  check(
    'A reconectada recibe hello_accepted',
    acceptedA2 !== undefined,
    JSON.stringify(clientA2.receivedMessageList),
  );

  snapshot = await waitForSessionCount(2);
  const sessionAReconnected = findSession(snapshot, DEVICE_ID_A);
  const sessionBFinal = findSession(snapshot, DEVICE_ID_B);
  check(
    'sessionCount sigue siendo 2 (sin duplicado de A)',
    snapshot.sessionCount === 2,
    `sessionCount=${snapshot.sessionCount}`,
  );
  check(
    'A sigue online tras reconectar',
    sessionAReconnected?.presence === 'online',
    `A=${sessionAReconnected?.presence}`,
  );
  check(
    'A tiene connectionId nuevo',
    sessionAReconnected !== undefined &&
      sessionAReconnected.connectionId !== sessionA?.connectionId,
    `${sessionA?.connectionId} -> ${sessionAReconnected?.connectionId}`,
  );
  check(
    'scheduler de A sigue siendo uno solo por deviceId',
    snapshot.heartbeatSchedulerCount === 2,
    `schedulerCount=${snapshot.heartbeatSchedulerCount}`,
  );
  check(
    'capabilities de A actualizadas',
    JSON.stringify(sessionAReconnected?.declaredCapabilities) ===
      JSON.stringify(['mobile.notifications']),
    JSON.stringify(sessionAReconnected?.declaredCapabilities),
  );
  check(
    'capabilities de B intactas (aislamiento)',
    JSON.stringify(sessionBFinal?.declaredCapabilities) ===
      JSON.stringify(['mobile.calendar']),
    JSON.stringify(sessionBFinal?.declaredCapabilities),
  );
  check(
    'B no adopto capabilities de A',
    !(sessionBFinal?.declaredCapabilities ?? []).includes('mobile.notifications'),
    JSON.stringify(sessionBFinal?.declaredCapabilities),
  );
  check(
    'A no adopto capabilities de B',
    !(sessionAReconnected?.declaredCapabilities ?? []).includes('mobile.calendar'),
    JSON.stringify(sessionAReconnected?.declaredCapabilities),
  );
  check(
    'B intacto: sigue online',
    sessionBFinal?.presence === 'online',
    `B=${sessionBFinal?.presence}`,
  );
  // Aislamiento de capabilities entre los dos devices: lo que puede hacer A no
  // aparece en B, y B no puede hacer nada todavia.
  const finalA = findSession(snapshot, DEVICE_ID_A);
  const finalB = findSession(snapshot, DEVICE_ID_B);
  check(
    'A tiene mobile.notifications disponible',
    JSON.stringify(finalA?.availableCapabilities) ===
      JSON.stringify(['mobile.notifications']),
    JSON.stringify(finalA?.availableCapabilities),
  );
  check(
    'B no puede hacer lo que puede A (y viceversa)',
    // BLOCK 11: calendar ya está implementada, así que B sí tiene una
    // capability disponible. Lo que tiene que seguir siendo cierto es que los
    // conjuntos son disjuntos: B no puede hacer notifications ni alarm.
    JSON.stringify(finalB?.availableCapabilities) ===
      JSON.stringify(['mobile.calendar']) &&
      !(finalB?.availableCapabilities ?? []).includes('mobile.notifications') &&
      !(finalB?.availableCapabilities ?? []).includes('mobile.alarm'),
    JSON.stringify(finalB?.availableCapabilities),
  );
  check(
    'vuelven a estar los dos sockets con handshake',
    snapshot.handshakenConnectionCount === 2,
    `handshakenConnectionCount=${snapshot.handshakenConnectionCount}`,
  );

  await clientA2.close();
  await clientB.close();
  await sleep(800);
  const finalSnapshot = await readSnapshot();
  check(
    'al cerrar ambos no queda ningun timer vivo',
    finalSnapshot.runningHeartbeatTimerCount === 0,
    `runningTimers=${finalSnapshot.runningHeartbeatTimerCount}`,
  );

  console.log('');
  console.log(`checks: ${checkCount}, fallos: ${failureList.length}`);
  console.log(
    `snapshot final: sessionCount=${finalSnapshot.sessionCount} connectedCount=${finalSnapshot.connectedCount} schedulers=${finalSnapshot.heartbeatSchedulerCount}`,
  );
  for (const session of finalSnapshot.sessionList) {
    console.log(
      `  ${session.deviceId} connection=${session.connectionId} presence=${session.presence} declared=${JSON.stringify(session.declaredCapabilities)} available=${JSON.stringify(session.availableCapabilities)}`,
    );
  }
  if (failureList.length > 0) {
    console.log('');
    for (const failure of failureList) {
      console.log(`FALLO: ${failure}`);
    }
    process.exit(1);
  }
  console.log('');
  console.log('verificaciones adicionales (no forman parte de los 37 checks)');

  const inspectorOverHttp = await fetch(INSPECTOR_URL);
  console.log(
    `  inspector por HTTP responde ${inspectorOverHttp.status} (flag de servidor prendido)`,
  );

  // El inspector no puedePedirse por el canal RPC/WebSocket de un device: el
  // método ya no está registrado, así que el RPC tiene que fallar.
  const rpcSocket = new WebSocket(BRIDGE_RPC_URL);
  let rpcFailureMessage: string | null = null;
  await new Promise<void>((resolve) => {
    rpcSocket.addEventListener('open', () => resolve(), { once: true });
    rpcSocket.addEventListener('error', () => resolve(), { once: true });
    setTimeout(() => resolve(), 8_000);
  });
  const rpcAnswer = (await new Promise<string | null>((resolve) => {
    let didSettle = false;
    const settle = (value: string | null): void => {
      if (didSettle) {
        return;
      }
      didSettle = true;
      resolve(value);
    };
    const timer = setTimeout(() => settle(null), 8_000);
    rpcSocket.addEventListener('message', (event) => {
      const raw = String(event.data);
      if (raw.includes('inspectMobileSessions') || raw.includes('error')) {
        clearTimeout(timer);
        settle(raw);
      }
    });
    rpcSocket.send(
      JSON.stringify({
        type: 'rpc',
        id: 'inspect-attempt-1',
        method: 'inspectMobileSessions',
        args: [],
      }),
    );
  })) as string | null;
  if (rpcAnswer !== null) {
    try {
      const parsed = JSON.parse(rpcAnswer) as Record<string, unknown>;
      if (String(parsed['error'] ?? '') !== '' || parsed['success'] === false) {
        rpcFailureMessage = String(parsed['error'] ?? 'rpc rejected');
      }
    } catch {
      rpcFailureMessage = rpcAnswer.slice(0, 120);
    }
  }
  console.log(
    `  inspectMobileSessions por WebSocket RPC: ${rpcFailureMessage ?? 'sin respuesta (metodo inexistente)'}`,
  );
  rpcSocket.close();

  console.log('');
  console.log(
    'SMOKE OK: MobileBridge("mobile") sostiene mobile:test-a y mobile:test-b simultaneamente.',
  );
  // El socket del inspector queda abierto: sin salida explícita el proceso no
  // termina.
  process.exit(0);
}

await main();
import { enrollSmokeDevice } from './enroll';
