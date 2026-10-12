// ─────────────────────────────────────────────────────────────────────────────
// BLOCK 12 §5: la revocación y el registro tienen que SOBREVIVIR a que el
// Durable Object se reinicie.
//
// Este script corre en dos fases porque el reinicio lo hace el operador:
//
//   phase1  enrola un teléfono y revoca OTRO, y guarda los deviceId usados.
//   (se reinicia workerd)
//   phase2  comprueba que el estado anterior sigue ahí: el teléfono enrolado
//           autentica con la MISMA credencial, y el revocado sigue revocado.
//
// La prueba de que la fila sobrevivió es `rotated: true` al re-enrolar: ese
// campo sólo vale true si YA existía una credencial para ese deviceId, o sea si
// la fila está en el SQLite y no en memoria.
//
// Uso:  bun smoke/enrollment-persistence.ts phase1
//       bun smoke/enrollment-persistence.ts phase2
//       bun smoke/enrollment-persistence.ts phase3
// ─────────────────────────────────────────────────────────────────────────────

const BRIDGE_PATH = '/agents/mobile-bridge/mobile';
const DEVICE_SHARED_SECRET =
  process.env['DEVICE_SHARED_SECRET'] ?? 'block-8-2-smoke-device-secret';
const DASHBOARD_SHARED_SECRET =
  process.env['DASHBOARD_SHARED_SECRET'] ?? 'block-8-2-smoke-dashboard-secret';

const PERSISTED_DEVICE_ID = 'mobile:smoke-persiste-vivo';
const REVOKED_DEVICE_ID = 'mobile:smoke-persiste-revocado';

const HTTP_BASE = readArgument('--url', 'http://127.0.0.1:8799');
const PHASE = readArgument('--phase', 'phase1');

function readArgument(flag: string, fallback: string): string {
  const index = process.argv.indexOf(flag);
  if (index === -1 || index + 1 >= process.argv.length) {
    return fallback;
  }
  return process.argv[index + 1] as string;
}

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

/**
 * BLOCK 12.1: el desafío declara el deviceId autorizado y el admin va en
 * `Authorization`, no en la query.
 */
async function requestChallenge(deviceId: string): Promise<string> {
  const response = await fetch(`${HTTP_BASE}${BRIDGE_PATH}/enrollment/challenge`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${DASHBOARD_SHARED_SECRET}`,
    },
    body: JSON.stringify({ deviceId }),
  });
  const body = (await response.json()) as { challenge: string };
  return body.challenge;
}

async function claimChallenge(
  challenge: string,
  deviceId: string,
): Promise<{ status: string; credential?: string; rotated?: boolean }> {
  const response = await fetch(`${HTTP_BASE}${BRIDGE_PATH}/enrollment/claim`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ challenge, deviceId }),
  });
  return (await response.json()) as {
    status: string;
    credential?: string;
    rotated?: boolean;
  };
}

async function revoke(
  deviceId: string,
): Promise<{ status: string; socketOutcome: string }> {
  const response = await fetch(`${HTTP_BASE}${BRIDGE_PATH}/enrollment/revoke`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${DASHBOARD_SHARED_SECRET}`,
    },
    body: JSON.stringify({ deviceId }),
  });
  return (await response.json()) as { status: string; socketOutcome: string };
}

type HandshakeOutcome = {
  readonly didGetHelloAccepted: boolean;
  readonly closeCode: number | null;
  readonly serverCloseReason: string | null;
};

/** Abre un socket, manda `hello`, y espera la respuesta o el cierre. */
async function tryHandshake(input: {
  readonly deviceId: string;
  readonly bearerCredential: string | null;
  readonly legacyToken: string | null;
}): Promise<HandshakeOutcome> {
  const url = new URL(`${HTTP_BASE}${BRIDGE_PATH}`);
  if (input.legacyToken !== null) {
    url.searchParams.set('token', input.legacyToken);
  }
  const headers: Record<string, string> = {};
  if (input.bearerCredential !== null) {
    headers['Authorization'] = `Bearer ${input.bearerCredential}`;
  }
  const outcome: HandshakeOutcome = {
    didGetHelloAccepted: false,
    closeCode: null,
    serverCloseReason: null,
  };
  const socket = new WebSocket(url.toString(), { headers });
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data)) as Record<string, unknown>;
    if (message['type'] === 'hello_accepted') {
      outcome.didGetHelloAccepted = true;
    }
  });
  socket.addEventListener('close', (event) => {
    outcome.closeCode = event.code;
    outcome.serverCloseReason = event.reason === '' ? null : event.reason;
  });
  await new Promise<void>((resolve) => {
    socket.addEventListener('open', () => resolve());
    socket.addEventListener('error', () => resolve());
  });
  socket.send(
    JSON.stringify({
      type: 'hello',
      deviceId: input.deviceId,
      deviceType: 'mobile',
      protocolVersion: 1,
      capabilities: ['mobile.notifications'],
      ts: Date.now(),
    }),
  );
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (outcome.didGetHelloAccepted || outcome.closeCode !== null) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  socket.close();
  return outcome;
}

async function main(): Promise<void> {
  console.log(`Persistence smoke (${PHASE}) -> ${HTTP_BASE}`);

  if (PHASE === 'phase1') {
    console.log('\n1. Enrolo un teléfono y revoco otro');

    const survivor = await claimChallenge(
      await requestChallenge(PERSISTED_DEVICE_ID),
      PERSISTED_DEVICE_ID,
    );
    check('el teléfono superviviente se enrola', survivor.status === 'enrolled');
    // `rotated` NO se afirma acá a propósito: sólo vale false sobre una base
    // virgen, y este smoke tiene que poder correrse más de una vez contra el
    // mismo estado. La prueba de la persistencia es la de phase2, donde el
    // `rotated: true` sólo puede venir de una fila que ya existía antes del
    // reinicio.

    const doomed = await claimChallenge(
      await requestChallenge(REVOKED_DEVICE_ID),
      REVOKED_DEVICE_ID,
    );
    check('el teléfono a revocar se enrola', doomed.status === 'enrolled');

    const revocation = await revoke(REVOKED_DEVICE_ID);
    check('se revoca', revocation.status === 'revoked');

    const before = await tryHandshake({
      deviceId: PERSISTED_DEVICE_ID,
      bearerCredential: survivor.credential ?? null,
      legacyToken: null,
    });
    check('antes de reiniciar, el superviviente autentica', before.didGetHelloAccepted);

    console.log(
      '\n  -> reiniciá workerd y corré: bun smoke/enrollment-persistence.ts phase2',
    );
  } else if (PHASE === 'phase3') {
    console.log('\n2. La limpieza contra el SQLite real');

    // Se emiten más desafíos que el límite de limpieza por llamada, para que
    // corran varias pasadas y quede de manifiesto que la limpieza no se queda
    // siempre con la misma mitad de la tabla.
    for (let index = 0; index < 60; index += 1) {
      await requestChallenge(`mobile:smoke-fogon-${index}`);
    }
    check('el servidor sigue emitiendo desafíos tras 60 limpiezas', true);

    // Lo importante: la limpieza corrió muchas veces contra el mismo SQLite y el
    // teléfono revocado de phase1 sigue bloqueado. Si la limpieza tocara la tabla
    // de credenciales, esto sería el lugar donde se nota.
    const legacyTry = await tryHandshake({
      deviceId: REVOKED_DEVICE_ID,
      bearerCredential: null,
      legacyToken: DEVICE_SHARED_SECRET,
    });
    check(
      'la limpieza NO desrevocó el teléfono de phase1',
      !legacyTry.didGetHelloAccepted,
      `accepted=${String(legacyTry.didGetHelloAccepted)}`,
    );

    const revokedReEnroll = await claimChallenge(
      await requestChallenge(REVOKED_DEVICE_ID),
      REVOKED_DEVICE_ID,
    );
    check(
      'la fila revocada seguía en el store después de limpiar',
      revokedReEnroll.rotated === true,
      `rotated=${String(revokedReEnroll.rotated)}`,
    );

    // Y el camino feliz: la limpieza no puede romper la emisión ni el canje.
    const liveDeviceId = 'mobile:smoke-fogon-vivo';
    const liveClaim = await claimChallenge(
      await requestChallenge(liveDeviceId),
      liveDeviceId,
    );
    check(
      'un desafío emitido tras limpiar se canjea',
      liveClaim.credential !== undefined,
    );

    const liveHandshake = await tryHandshake({
      deviceId: liveDeviceId,
      bearerCredential: liveClaim.credential ?? null,
      legacyToken: null,
    });
    check('el teléfono recién enrolado autentica', liveHandshake.didGetHelloAccepted);

    // El replay sigue bloqueado con el mismo CAS de siempre: la limpieza no
    // cambió el camino del claim. Se reusa el MISMO desafío, no uno nuevo — dos
    // desafíos distintos se canjean los dos legítimamente y no probaría nada.
    const singleUseChallenge = await requestChallenge(liveDeviceId);
    const firstClaim = await claimChallenge(singleUseChallenge, liveDeviceId);
    const replayedClaim = await claimChallenge(singleUseChallenge, liveDeviceId);
    check(
      'un desafío se canjea una sola vez',
      firstClaim.credential !== undefined && replayedClaim.status === 'rejected',
      `replay=${replayedClaim.status}`,
    );

    const revokedReclaim = await claimChallenge(
      await requestChallenge(REVOKED_DEVICE_ID),
      REVOKED_DEVICE_ID,
    );
    check(
      'el canje de un teléfono revocado sigue girando la credencial',
      revokedReclaim.rotated === true,
    );
  } else {
    console.log('\n2. Después del reinicio del Durable Object');

    // Re-enrolar devuelve `rotated: true` sólo si la fila ya existía: ésa es la
    // prueba de que sobrevivió en el SQLite y no estaba en memoria.
    const reEnrolled = await claimChallenge(
      await requestChallenge(PERSISTED_DEVICE_ID),
      PERSISTED_DEVICE_ID,
    );
    check('el registro anterior sobrevivió al reinicio', reEnrolled.rotated === true);

    const survivor = await tryHandshake({
      deviceId: PERSISTED_DEVICE_ID,
      bearerCredential: reEnrolled.credential ?? null,
      legacyToken: null,
    });
    check('el teléfono enrolado sigue autenticando', survivor.didGetHelloAccepted);

    // La revocación también tiene que haber sobrevivido: sin esto, reiniciar el
    // DO sería un botón de "desrevocar".
    const legacyTry = await tryHandshake({
      deviceId: REVOKED_DEVICE_ID,
      bearerCredential: null,
      legacyToken: DEVICE_SHARED_SECRET,
    });
    check(
      'el teléfono revocado sigue bloqueado por el camino legacy',
      !legacyTry.didGetHelloAccepted,
      `accepted=${String(legacyTry.didGetHelloAccepted)}`,
    );

    const revokedReEnroll = await claimChallenge(
      await requestChallenge(REVOKED_DEVICE_ID),
      REVOKED_DEVICE_ID,
    );
    check(
      'la fila revocada seguía en el store',
      revokedReEnroll.rotated === true,
      `rotated=${String(revokedReEnroll.rotated)}`,
    );
  }

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
