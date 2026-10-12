// ─────────────────────────────────────────────────────────────────────────────
// BLOCK 12 §8: smoke de enrollment y revocación sobre workerd REAL.
//
// Esto NO es un doble del mecanismo de autenticación: usa el mismo Worker, el
// mismo MobileBridge, el mismo SQLite del DO y el mismo código de verificación
// que producción. Lo único simulado es el teléfono, que es un cliente
// HTTP/WebSocket y no parte de la seguridad del servidor.
//
//   1. El dueño pide desafíos (rol dashboard) y A y B canjean los suyos.
//   2. A y B abren WebSocket con `Authorization: Bearer` y completan hello.
//   3. Una notificación real llega a A y a B por el callable del bridge.
//   4. El dueño revoca A: se cierra su socket vivo.
//   5. A no reconecta con su credencial, ni por el camino legacy `?token=`.
//   6. B sigue online y sigue recibiendo notificaciones.
//   7. No hay sesiones duplicadas, y un teléfono nunca enrolado sigue por legacy.
//
// Uso:  bun smoke/enrollment-revocation.ts [--url http://127.0.0.1:8799]
// ─────────────────────────────────────────────────────────────────────────────

const BRIDGE_PATH = '/agents/mobile-bridge/mobile';
const INSPECTOR_PATH = `${BRIDGE_PATH}/__inspect`;

const DEVICE_SHARED_SECRET =
  process.env['DEVICE_SHARED_SECRET'] ?? 'block-8-2-smoke-device-secret';
const DASHBOARD_SHARED_SECRET =
  process.env['DASHBOARD_SHARED_SECRET'] ?? 'block-8-2-smoke-dashboard-secret';

const DEVICE_A = 'mobile:smoke-enroll-a';
const DEVICE_B = 'mobile:smoke-enroll-b';
const LEGACY_DEVICE_ID = 'mobile:smoke-legacy-nunca-enrolado';
const MOBILE_PROTOCOL_VERSION = 1;

function readArgument(flag: string, fallback: string): string {
  const index = process.argv.indexOf(flag);
  if (index === -1 || index + 1 >= process.argv.length) {
    return fallback;
  }
  return process.argv[index + 1] as string;
}

const HTTP_BASE = readArgument('--url', 'http://127.0.0.1:8799');

let passedCount = 0;
const failureList: string[] = [];

function check(label: string, didPass: boolean, detail = ''): void {
  if (didPass) {
    passedCount += 1;
    console.log(`  ok  ${label}`);
    return;
  }
  failureList.push(`${label}${detail === '' ? '' : ` (${detail})`}`);
  console.log(`  FAIL ${label}${detail === '' ? '' : ` -> ${detail}`}`);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

// ── Superficie HTTP de enrollment ───────────────────────────────────────────

/**
 * BLOCK 12.1 §4: el token del dashboard viaja en `Authorization: Bearer`, no en la
 * URL, así que no queda en ningún access log.
 *
 * BLOCK 12.1 §2.3: el desafío declara QUÉ teléfono autoriza, y queda atado a ese
 * deviceId.
 */
async function requestChallenge(deviceId: string): Promise<{
  status: number;
  challenge: string;
}> {
  const response = await fetch(`${HTTP_BASE}${BRIDGE_PATH}/enrollment/challenge`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${DASHBOARD_SHARED_SECRET}`,
    },
    body: JSON.stringify({ deviceId }),
  });
  if (!response.ok) {
    return { status: response.status, challenge: '' };
  }
  const body = (await response.json()) as { challenge: string };
  return { status: response.status, challenge: body.challenge };
}

async function claimChallenge(
  challenge: string,
  deviceId: string,
): Promise<{ status: string; credential?: string; reason?: string }> {
  const response = await fetch(`${HTTP_BASE}${BRIDGE_PATH}/enrollment/claim`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ challenge, deviceId }),
  });
  return (await response.json()) as {
    status: string;
    credential?: string;
    reason?: string;
  };
}

async function revokeDevice(
  deviceId: string,
): Promise<{ status: string; socketOutcome: string; httpStatus: number }> {
  const response = await fetch(`${HTTP_BASE}${BRIDGE_PATH}/enrollment/revoke`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${DASHBOARD_SHARED_SECRET}`,
    },
    body: JSON.stringify({ deviceId }),
  });
  const body = (await response.json()) as { status: string; socketOutcome: string };
  return { ...body, httpStatus: response.status };
}

// ── El teléfono mínimo ──────────────────────────────────────────────────────

type PhoneOutcome = {
  readonly didGetHelloAccepted: boolean;
  readonly helloRejectedReason: string | null;
  readonly closeCode: number | null;
  readonly serverCloseReason: string | null;
};

/**
 * Un teléfono con su credencial en el header `Authorization`. Reproduce lo que
 * hace el cliente Kotlin: bearer, `hello`, y leer `hello_accepted` o el cierre.
 */
class SmokePhone {
  readonly #socket: WebSocket;
  readonly #outcome: PhoneOutcome = {
    didGetHelloAccepted: false,
    helloRejectedReason: null,
    closeCode: null,
    serverCloseReason: null,
  };

  private constructor(socket: WebSocket) {
    this.#socket = socket;
  }

  static async connect(input: {
    readonly deviceId: string;
    readonly bearerCredential: string | null;
    readonly legacyToken: string | null;
  }): Promise<SmokePhone> {
    const url = new URL(`${HTTP_BASE}${BRIDGE_PATH}`);
    if (input.legacyToken !== null) {
      url.searchParams.set('token', input.legacyToken);
    }
    const headers: Record<string, string> = {};
    if (input.bearerCredential !== null) {
      headers['Authorization'] = `Bearer ${input.bearerCredential}`;
    }
    const socket = new WebSocket(url.toString(), { headers });
    const phone = new SmokePhone(socket);
    phone.deviceId = input.deviceId;

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`${input.deviceId}: el socket no abrio`));
      }, 10_000);
      socket.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      });
      socket.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error(`${input.deviceId}: fallo el upgrade`));
      });
    });

    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as Record<string, unknown>;
      if (message['type'] === 'hello_accepted') {
        phone.#outcome.didGetHelloAccepted = true;
        return;
      }
      if (message['type'] === 'hello_rejected') {
        phone.#outcome.helloRejectedReason = String(message['reason']);
        return;
      }
      // El teléfono responde el comando, como haría el peer Kotlin. Sin esto el
      // `sendMobileCommand` expira por timeout y el smoke no probaría nada de la
      // ruta de notificación.
      if (message['type'] === 'command') {
        phone.#socket.send(
          JSON.stringify({
            type: 'command_result',
            requestId: message['requestId'],
            capability: message['capability'],
            ok: true,
            result: { posted: true },
            ts: Date.now(),
          }),
        );
      }
    });
    socket.addEventListener('close', (event) => {
      phone.#outcome.closeCode = event.code;
      phone.#outcome.serverCloseReason = event.reason === '' ? null : event.reason;
    });
    return phone;
  }

  deviceId = '';

  sendHello(): void {
    this.#socket.send(
      JSON.stringify({
        type: 'hello',
        deviceId: this.deviceId,
        deviceType: 'mobile',
        protocolVersion: MOBILE_PROTOCOL_VERSION,
        capabilities: ['mobile.notifications'],
        ts: Date.now(),
      }),
    );
  }

  async waitFor(withinMilliseconds: number): Promise<PhoneOutcome> {
    const deadline = Date.now() + withinMilliseconds;
    while (Date.now() < deadline) {
      if (
        this.#outcome.didGetHelloAccepted ||
        this.#outcome.helloRejectedReason !== null ||
        this.#outcome.closeCode !== null
      ) {
        return { ...this.#outcome };
      }
      await delay(80);
    }
    return { ...this.#outcome };
  }

  close(): void {
    try {
      this.#socket.close();
    } catch {
      // Un socket ya cerrado no es un fallo del smoke.
    }
  }

  get outcome(): PhoneOutcome {
    return { ...this.#outcome };
  }
}

// ── El callable del bridge, por el mismo camino que usa la tool ─────────────

/**
 * El RPC va por un socket aparte autenticado con el secreto global, igual que
 * en el resto de los smokes. Ese socket nunca manda `hello`, así que no es un
 * dispositivo y no atraviesa la regla anti-bypass: es el caller, no el teléfono.
 */
async function callBridge(
  method: string,
  args: unknown,
): Promise<Record<string, unknown>> {
  const socket = new WebSocket(
    `${HTTP_BASE.replace(/^http/, 'ws')}${BRIDGE_PATH}?token=${encodeURIComponent(
      DEVICE_SHARED_SECRET,
    )}`,
  );
  return new Promise((resolve, reject) => {
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
        resolve(message['result'] as Record<string, unknown>);
        return;
      }
      reject(new Error(JSON.stringify(message['error'])));
    });
    socket.addEventListener('error', () => reject(new Error('socket_error')));
    setTimeout(() => reject(new Error('timeout rpc')), 20_000);
  });
}

/** `mobile.notifications` de punta a punta: tool -> bridge -> peer -> result. */
async function sendNotification(
  targetDeviceId: string,
  title: string,
): Promise<{ status: string; reason: string | null }> {
  const answer = await callBridge('sendMobileCommand', {
    targetDeviceId,
    capabilityName: 'mobile.notifications',
    requestId: `b12-smoke-${title}-${Date.now().toString(36)}`,
    payload: { title, body: 'hola' },
  });
  return {
    status: String(answer['status'] ?? ''),
    reason: typeof answer['reason'] === 'string' ? answer['reason'] : null,
  };
}

type SessionSnapshot = {
  connectedCount: number;
  sessionList: { deviceId: string; presence: string }[];
};

async function readSessionSnapshot(): Promise<SessionSnapshot | null> {
  // El inspector pasa por la MISMA auth de rol 'device' que el socket, así que
  // lleva el secreto global, no el de dashboard.
  const response = await fetch(
    `${HTTP_BASE}${INSPECTOR_PATH}?token=${DEVICE_SHARED_SECRET}`,
  );
  if (!response.ok) {
    return null;
  }
  return (await response.json()) as SessionSnapshot;
}

async function main(): Promise<void> {
  console.log(`Enrollment smoke -> ${HTTP_BASE}`);
  console.log(`  endpoint: ${BRIDGE_PATH}`);

  // ── 1. El dueño emite desafíos ─────────────────────────────────────────────
  console.log('\n1. El dueño pide desafíos');

  const challengeA = await requestChallenge(DEVICE_A);
  const challengeB = await requestChallenge(DEVICE_B);
  check(
    'el desafío A tiene el prefijo propio',
    challengeA.challenge.startsWith('apollo_enr_'),
  );
  check(
    'el desafío B tiene el prefijo propio',
    challengeB.challenge.startsWith('apollo_enr_'),
  );
  check('los desafíos son distintos', challengeA.challenge !== challengeB.challenge);

  const unauthorized = await fetch(`${HTTP_BASE}${BRIDGE_PATH}/enrollment/challenge`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer not-the-secret',
    },
    body: JSON.stringify({ deviceId: DEVICE_A }),
  });
  check('sin el rol dashboard no se emiten desafíos', unauthorized.status === 401);

  // Un token de DISPOSITIVO no puede administrar enrollment: son ámbitos
  // separados, y el secreto global tampoco sirve para esto.
  const deviceTokenAsOwner = await fetch(
    `${HTTP_BASE}${BRIDGE_PATH}/enrollment/challenge`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${DEVICE_SHARED_SECRET}`,
      },
      body: JSON.stringify({ deviceId: DEVICE_A }),
    },
  );
  check(
    'el secreto global de device no puede emitir desafíos',
    deviceTokenAsOwner.status === 401,
    `status=${deviceTokenAsOwner.status}`,
  );

  // ── 2. Canje ──────────────────────────────────────────────────────────────
  console.log('\n2. A y B canjean sus desafíos');

  const claimA = await claimChallenge(challengeA.challenge, DEVICE_A);
  const claimB = await claimChallenge(challengeB.challenge, DEVICE_B);
  check('A queda enrolado', claimA.status === 'enrolled');
  check('B queda enrolado', claimB.status === 'enrolled');
  const credentialA = claimA.credential ?? '';
  const credentialB = claimB.credential ?? '';
  check('A recibe credencial individual', credentialA.startsWith('apollo_dev_'));
  check('B recibe credencial individual', credentialB.startsWith('apollo_dev_'));
  check('las credenciales son distintas', credentialA !== credentialB);

  const reused = await claimChallenge(challengeA.challenge, DEVICE_A);
  check('el desafío es de un solo uso', reused.status === 'rejected', reused.reason);

  const invented = await claimChallenge('apollo_enr_inventado-para-el-smoke', DEVICE_A);
  check(
    'un desafío inventado no registra',
    invented.status === 'rejected',
    invented.reason,
  );

  // BLOCK 12.1 §2: un desafío de C no sirve para A, y el intento no lo gasta.
  //
  // Van sobre teléfonos aparte de A y B a propósito, por dos razones:
  //   - el desafío de arriba ya se canjeó, así que probarlo daría
  //     `challenge_consumed` y no mediría el vínculo;
  //   - canjear un desafío NUEVO de B rotaría su credencial, y `credentialB` se
  //     usa más abajo para el handshake. Romper el propio smoke con una rotación
  //     legítima del servidor sería un falso negativo.
  const DEVICE_C = 'mobile:smoke-enroll-c';
  const challengeForC = await requestChallenge(DEVICE_C);
  const stolenTry = await claimChallenge(challengeForC.challenge, DEVICE_A);
  check(
    'el desafío de C no sirve para A',
    stolenTry.status === 'rejected' && stolenTry.reason === 'device_id_mismatch',
    `${stolenTry.status}/${String(stolenTry.reason)}`,
  );
  const cStillCanClaim = await claimChallenge(challengeForC.challenge, DEVICE_C);
  check(
    'el intento fallido de A no consumió el desafío de C',
    cStillCanClaim.status === 'enrolled',
    `${cStillCanClaim.status}/${String(cStillCanClaim.reason)}`,
  );

  // BLOCK 12.1 §5: dos claims concurrentes del mismo desafío.
  //
  // Van sobre un TERCER teléfono a propósito: un re-enrollment exitoso rota la
  // credencial del deviceId, así que hacerlo sobre A invalidaría `credentialA` y
  // las comprobaciones de más abajo fallarían por una razón que no es la que
  // este check quiere medir.
  const CONCURRENCY_DEVICE_ID = 'mobile:smoke-enroll-concurrencia';
  const concurrentChallenge = await requestChallenge(CONCURRENCY_DEVICE_ID);
  const [firstClaim, secondClaim] = await Promise.all([
    claimChallenge(concurrentChallenge.challenge, CONCURRENCY_DEVICE_ID),
    claimChallenge(concurrentChallenge.challenge, CONCURRENCY_DEVICE_ID),
  ]);
  const enrolledCount = [firstClaim, secondClaim].filter(
    (entry) => entry.status === 'enrolled',
  ).length;
  check(
    'dos claims simultáneos producen una sola credencial',
    enrolledCount === 1,
    `enrolled=${enrolledCount}`,
  );

  // ── 3. Autenticación real ────────────────────────────────────────────────
  console.log('\n3. A y B se autentican con su credencial individual');

  const phoneA = await SmokePhone.connect({
    deviceId: DEVICE_A,
    bearerCredential: credentialA,
    legacyToken: null,
  });
  phoneA.sendHello();
  const helloA = await phoneA.waitFor(8_000);
  check('A completa el handshake con su credencial', helloA.didGetHelloAccepted);
  check('el socket de A sigue abierto', helloA.closeCode === null);

  const phoneB = await SmokePhone.connect({
    deviceId: DEVICE_B,
    bearerCredential: credentialB,
    legacyToken: null,
  });
  phoneB.sendHello();
  const helloB = await phoneB.waitFor(8_000);
  check('B completa el handshake con su credencial', helloB.didGetHelloAccepted);

  // ── 4. Notificaciones antes de revocar ───────────────────────────────────
  console.log('\n4. mobile.notifications funciona con credencial per-device');

  const notificationA = await sendNotification(DEVICE_A, 'antes-de-revocar');
  const notificationB = await sendNotification(DEVICE_B, 'antes-de-revocar');
  check(
    'A recibe la notificación',
    notificationA.status === 'completed',
    notificationA.reason,
  );
  check(
    'B recibe la notificación',
    notificationB.status === 'completed',
    notificationB.reason,
  );

  // ── 5. Revocación ────────────────────────────────────────────────────────
  console.log('\n5. El dueño revoca A');

  const revocation = await revokeDevice(DEVICE_A);
  check('la revocación responde revoked', revocation.status === 'revoked');
  check(
    'la revocación cerró el socket vivo',
    revocation.socketOutcome === 'closed_socket',
  );

  const closedA = await phoneA.waitFor(6_000);
  check(
    'el socket de A se cerró',
    closedA.closeCode !== null,
    `code=${String(closedA.closeCode)}`,
  );

  // ── 6. A no recupera acceso ──────────────────────────────────────────────
  console.log('\n6. A no recupera acceso');

  const retryA = await SmokePhone.connect({
    deviceId: DEVICE_A,
    bearerCredential: credentialA,
    legacyToken: null,
  });
  retryA.sendHello();
  const retryOutcome = await retryA.waitFor(6_000);
  check(
    'A no puede reconectar con la credencial revocada',
    retryOutcome.closeCode !== null,
    `code=${String(retryOutcome.closeCode)} reason=${String(retryOutcome.serverCloseReason)}`,
  );
  check(
    'el servidor le dice credential_revoked',
    retryOutcome.serverCloseReason === 'credential_revoked',
    String(retryOutcome.serverCloseReason),
  );
  check('A no completa handshake tras revocarse', !retryOutcome.didGetHelloAccepted);
  retryA.close();

  // El bypass: la credencial global NO revive a A, aunque siga siendo válida.
  const legacyA = await SmokePhone.connect({
    deviceId: DEVICE_A,
    bearerCredential: null,
    legacyToken: DEVICE_SHARED_SECRET,
  });
  legacyA.sendHello();
  const legacyOutcome = await legacyA.waitFor(6_000);
  check(
    'A tampoco entra por el camino legacy ?token=',
    !legacyOutcome.didGetHelloAccepted &&
      legacyOutcome.helloRejectedReason === 'device_is_enrolled_or_revoked',
    `accepted=${String(legacyOutcome.didGetHelloAccepted)} reason=${String(
      legacyOutcome.helloRejectedReason,
    )}`,
  );
  legacyA.close();

  // ── 7. B no se ve afectado ───────────────────────────────────────────────
  console.log('\n7. B sigue funcionando');

  const notificationB2 = await sendNotification(DEVICE_B, 'despues-de-revocar');
  check(
    'B sigue recibiendo notificaciones',
    notificationB2.status === 'completed',
    notificationB2.reason,
  );

  const snapshot = await readSessionSnapshot();
  if (snapshot === null) {
    check('el inspector de sesiones responde', false, 'sin respuesta');
  } else {
    const bPresence = snapshot.sessionList.find(
      (entry) => entry.deviceId === DEVICE_B,
    )?.presence;
    const aPresence = snapshot.sessionList.find(
      (entry) => entry.deviceId === DEVICE_A,
    )?.presence;
    check('B sigue online', bPresence === 'online', String(bPresence));
    check('A no está online', aPresence !== 'online', String(aPresence));
    check(
      'no hay sesión duplicada de B',
      snapshot.sessionList.filter((entry) => entry.deviceId === DEVICE_B).length === 1,
    );
    check(
      'A no dejó una sesión seleccionable',
      snapshot.sessionList.filter((entry) => entry.deviceId === DEVICE_A).length <= 1,
    );
  }
  phoneB.close();

  // ── 8. El legacy queda cerrado para identidades mobile (§3) ──────────────
  console.log('\n8. Una identidad mobile no enrolada ya no entra por el secreto global');

  const legacyPhone = await SmokePhone.connect({
    deviceId: LEGACY_DEVICE_ID,
    bearerCredential: null,
    legacyToken: DEVICE_SHARED_SECRET,
  });
  legacyPhone.sendHello();
  const legacyHandshake = await legacyPhone.waitFor(8_000);
  check(
    'el camino legacy rechaza a un teléfono no enrolado',
    !legacyHandshake.didGetHelloAccepted &&
      legacyHandshake.helloRejectedReason === 'device_not_enrolled',
    `accepted=${String(legacyHandshake.didGetHelloAccepted)} reason=${String(
      legacyHandshake.helloRejectedReason,
    )}`,
  );
  const legacyNotification = await sendNotification(LEGACY_DEVICE_ID, 'legacy-funciona');
  check(
    'y no puede recibir comandos como dispositivo',
    legacyNotification.status !== 'completed',
    legacyNotification.reason ?? legacyNotification.status,
  );
  legacyPhone.close();

  console.log(
    `\n${failureList.length === 0 ? 'SMOKE OK' : 'SMOKE FAIL'}: ${passedCount} checks pasaron, ${failureList.length} fallaron`,
  );
  for (const failure of failureList) {
    console.log(`  - ${failure}`);
  }
  if (failureList.length > 0) {
    process.exit(1);
  }
}

await main();
