import { describe, expect, it } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import {
  buildMobileSessionInspectorResponse,
  isMobileSessionInspectorEnabled,
  isMobileSessionInspectorRequest,
  MOBILE_SESSION_INSPECTOR_PATH,
} from '@/devices/inspector';
import { isInspectorRequestDenied } from '@/devices/inspector';
import { MobileDeviceEndpoint } from '@/devices/endpoint';
import { buildAuthenticatedDeviceProof } from '@/devices/registry';

// ─────────────────────────────────────────────────────────────────────────────
// El inspector de sesiones no es superficie de producto (Block 8.2.1).
// ─────────────────────────────────────────────────────────────────────────────

const SOURCE_ROOT = join(import.meta.dir, '..', '..');

function stripComment(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function readSource(relativePath: string): string {
  return stripComment(readFileSync(join(SOURCE_ROOT, relativePath), 'utf8'));
}

function listSourceFilePathList(): string[] {
  const filePathList: string[] = [];
  const walk = (directoryPath: string): void => {
    for (const entryName of readdirSync(directoryPath)) {
      const entryPath = join(directoryPath, entryName);
      if (statSync(entryPath).isDirectory()) {
        walk(entryPath);
        continue;
      }
      if (entryName.endsWith('.ts') && !entryName.endsWith('.spec.ts')) {
        filePathList.push(entryPath);
      }
    }
  };
  walk(SOURCE_ROOT);
  return filePathList;
}

const INSPECTOR_ENABLED_ENV = { MOBILE_SESSION_INSPECTOR: 'enabled' } as unknown as Env;
const INSPECTOR_ABSENT_ENV = {} as Env;

function buildSnapshotEnvironment(): {
  readonly endpoint: MobileDeviceEndpoint;
} {
  const endpoint = new MobileDeviceEndpoint({ nowMilliseconds: () => 1_000 });
  endpoint.handleConnect({
    connectionId: 'mobile-1',
    port: { send: () => undefined, close: () => undefined },
    proof: buildAuthenticatedDeviceProof('device'),
  });
  endpoint.handleMessage(
    'mobile-1',
    JSON.stringify({
      type: 'hello',
      deviceId: 'mobile:test-a',
      deviceType: 'mobile',
      protocolVersion: 1,
      capabilities: ['mobile.notifications'],
      ts: 1_000,
    }),
  );
  return { endpoint };
}

describe('B8.2.1 §1: a normal authenticated device cannot inspect sessions', () => {
  it('the inspector is disabled unless the server env enables it', () => {
    expect(isMobileSessionInspectorEnabled(INSPECTOR_ABSENT_ENV)).toBe(false);
    expect(isMobileSessionInspectorEnabled({} as Env)).toBe(false);
    expect(isMobileSessionInspectorEnabled(INSPECTOR_ENABLED_ENV)).toBe(true);
  });

  it('an inspector request is refused when the env flag is absent', () => {
    // Esto es el caso de toda deployment real: el inspector no existe.
    expect(
      isMobileSessionInspectorRequest({
        pathname: `/agents/mobile-bridge/mobile/${MOBILE_SESSION_INSPECTOR_PATH}`,
        upgradeHeader: null,
        environment: INSPECTOR_ABSENT_ENV,
      }),
    ).toBe(false);
  });

  it('the gate never depends on anything the device provides', () => {
    const requestWithoutClientData = {
      pathname: `/agents/mobile-bridge/mobile/${MOBILE_SESSION_INSPECTOR_PATH}`,
      upgradeHeader: null,
    };
    // Token, deviceId, deviceType o flags del cliente no pueden abrirlo: la
    // decisión sale sólo del env.
    expect(
      isMobileSessionInspectorRequest({
        ...requestWithoutClientData,
        environment: INSPECTOR_ABSENT_ENV,
      }),
    ).toBe(false);
    expect(
      isMobileSessionInspectorRequest({
        ...requestWithoutClientData,
        environment: INSPECTOR_ENABLED_ENV,
      }),
    ).toBe(true);
  });

  it('device-provided values embedded in the path never open the gate', () => {
    // Aunque el flag esté prendido, sólo el subpath exacto del inspector abre.
    // Un device que meta su propio deviceId, deviceType o flags en el path no
    // cambia la decisión.
    for (const pathname of [
      `/agents/mobile-bridge/mobile/deviceType=mobile`,
      `/agents/mobile-bridge/mobile/deviceId=mobile:test-a`,
      `/agents/mobile-bridge/mobile?inspect=1`,
      `/agents/mobile-bridge/mobile/debug?deviceId=mobile:test-a`,
      `/agents/mobile-bridge/mobile/${MOBILE_SESSION_INSPECTOR_PATH}/extra?debug=true`,
    ]) {
      expect(
        isMobileSessionInspectorRequest({
          pathname,
          upgradeHeader: null,
          environment: INSPECTOR_ENABLED_ENV,
        }),
      ).toBe(false);
    }
    // Y el subpath exacto sí abre con el flag prendido.
    expect(
      isMobileSessionInspectorRequest({
        pathname: `/agents/mobile-bridge/mobile/${MOBILE_SESSION_INSPECTOR_PATH}`,
        upgradeHeader: null,
        environment: INSPECTOR_ENABLED_ENV,
      }),
    ).toBe(true);
  });

  it('the gate is a pure function of the server env, path and upgrade only', () => {
    const source = readSource('devices/inspector.ts');
    // Si el gate empieza a inspeccionar el path en busca de valores del device,
    // el control pasa al cliente.
    expect(source).not.toContain('pathname.includes');
    expect(source).not.toContain('pathname.match');
    expect(source).not.toContain('pathname.split');
    expect(source).not.toContain('searchParams');
    expect(source).not.toContain('Authorization');
    expect(source).not.toContain('deviceType ===');
    expect(source).not.toContain('deviceId ===');
    expect(source).not.toContain('token');
  });

  it('the inspector module reads nothing from the request beyond path and upgrade', () => {
    const source = readSource('devices/inspector.ts');
    // Si aparece un searchParam, un header de auth propio o un deviceType como
    // condición, la gate se vuelve controlable por el cliente.
    expect(source).not.toContain('searchParams');
    expect(source).not.toContain('Authorization');
    expect(source).not.toContain('deviceType ===');
    expect(source).not.toContain('deviceId ===');
    expect(source).not.toContain('token');
  });
});

describe('B8.2.1 §2: no productive callable for inspectMobileSessions', () => {
  it('the bridge does not register inspectMobileSessions as a callable', () => {
    const source = readSource('agents/mobile-bridge.ts');
    // BLOCK 9 agregó callables de producto (discovery + envío de notification),
    // así que la invariante ya no es "sin @callable" sino "el inspector nunca es
    // un callable".
    expect(source).not.toContain('inspectMobileSessions');
    expect(source).not.toMatch(/@callable\(\)\s*async\s+inspect/);
    // Y los únicos callables de producto son los del flujo de capability.
    // BLOCK 11: sendMobileCommand (dispatch genérico por capability) y
    // listReachableCapabilityList (qué se puede exponer/filtrar).
    const callableNameList = [...source.matchAll(/@callable\(\)\s*async\s+(\w+)/g)].map(
      (match) => match[1],
    );
    expect(callableNameList.toSorted()).toEqual([
      'listReachableCapabilityList',
      'resolveCapabilityTarget',
      'sendMobileCommand',
      'sendNotificationCommand',
    ]);
  });

  it('no source file mentions inspectMobileSessions outside the smoke test', () => {
    const offenderList = listSourceFilePathList()
      .filter((filePath) => !filePath.replace(/\\/g, '/').includes('/smoke/'))
      .filter((filePath) => !filePath.endsWith('inspector.spec.ts'))
      .filter((filePath) =>
        stripComment(readFileSync(filePath, 'utf8')).includes('inspectMobileSessions'),
      );
    expect(offenderList).toEqual([]);
  });

  it('the inspector is not an RPC: it is a fetch handler behind the env flag', () => {
    const source = readSource('agents/mobile-bridge.ts');
    expect(source).toContain('override async fetch(request: Request)');
    expect(source).toContain('isMobileSessionInspectorRequest');
    expect(source).toContain('super.fetch(request)');
  });
});

describe('B8.2.1 §3+4: the snapshot keeps what the smoke test needs', () => {
  it('the snapshot still exposes sessions, connectionIds, presence and schedulers', async () => {
    const { endpoint } = buildSnapshotEnvironment();
    const response = buildMobileSessionInspectorResponse(
      endpoint.inspectSessionSnapshot(),
    );
    expect(response.status).toBe(200);
    const snapshot = (await response.json()) as {
      sessionCount: number;
      heartbeatSchedulerCount: number;
      runningHeartbeatTimerCount: number;
      handshakenConnectionCount: number;
      sessionList: {
        deviceId: string;
        connectionId: string;
        presence: string;
        declaredCapabilities: string[];
        availableCapabilities: string[];
      }[];
    };
    expect(snapshot.sessionCount).toBe(1);
    expect(snapshot.heartbeatSchedulerCount).toBe(1);
    expect(snapshot.runningHeartbeatTimerCount).toBe(1);
    expect(snapshot.handshakenConnectionCount).toBe(1);
    expect(snapshot.sessionList[0]?.deviceId).toBe('mobile:test-a');
    expect(snapshot.sessionList[0]?.connectionId).toBe('mobile-1');
    expect(snapshot.sessionList[0]?.presence).toBe('online');
    expect(snapshot.sessionList[0]?.declaredCapabilities).toEqual([
      'mobile.notifications',
    ]);
    // BLOCK 9: notifications tiene implementacion, asi que tambien esta
    // disponible en el snapshot.
    expect(snapshot.sessionList[0]?.availableCapabilities).toEqual([
      'mobile.notifications',
    ]);
  });
});

describe('B8.2.1 §7: the snapshot leaks nothing', () => {
  it('no secrets, proofs or tokens appear in the snapshot', async () => {
    const { endpoint } = buildSnapshotEnvironment();
    const response = buildMobileSessionInspectorResponse(
      endpoint.inspectSessionSnapshot(),
    );
    const serialized = await response.text();
    for (const forbidden of ['secret', 'token', 'proof', 'password', 'authorization']) {
      expect(serialized.toLowerCase()).not.toContain(forbidden);
    }
  });

  it('the inspector refuses to publish a snapshot with unexpected fields', () => {
    const { endpoint } = buildSnapshotEnvironment();
    const snapshot = endpoint.inspectSessionSnapshot();
    const withLeak = {
      ...snapshot,
      sessionList: snapshot.sessionList.map((session) => ({
        ...session,
        deviceSharedSecret: 'nope',
      })),
    };
    // strict() hace que un campo nuevo rompa el parse en vez de filtrarse.
    const response = buildMobileSessionInspectorResponse(
      withLeak as ReturnType<typeof endpoint.inspectSessionSnapshot>,
    );
    expect(response.status).toBe(503);
  });
});

describe('B8.2.1 §guards: source level', () => {
  it('no alternative public route reaches the inspector', () => {
    const indexSource = readSource('index.ts');
    // El inspector se resuelve dentro del DO; index.ts no lo menciona ni
    // registra una ruta para él.
    expect(indexSource).not.toContain('inspect');
    expect(indexSource).not.toContain('__inspect');
    const routeSource = readSource('devices/route.ts');
    expect(routeSource).not.toContain('__inspect');
    expect(routeSource).not.toContain('inspect');
  });

  it('the env flag is optional, so the starter degrades without it', () => {
    const environmentSource = stripComment(
      readFileSync(join(SOURCE_ROOT, 'configuration', 'environment.d.ts'), 'utf8'),
    );
    expect(environmentSource).toContain('MOBILE_SESSION_INSPECTOR?: string;');
  });

  it('the flag is not a secret and not a token', () => {
    const environmentSource = readSource('configuration/environment.d.ts');
    // Opcional y de tipo string: es config del servidor, no una credencial.
    expect(environmentSource).toContain('MOBILE_SESSION_INSPECTOR?: string;');
    expect(environmentSource).not.toContain('MOBILE_SESSION_INSPECTOR_TOKEN');
    expect(environmentSource).not.toContain('MOBILE_SESSION_INSPECTOR_SECRET');
  });

  it('a WebSocket is never treated as an inspector request', () => {
    expect(
      isMobileSessionInspectorRequest({
        pathname: `/agents/mobile-bridge/mobile/${MOBILE_SESSION_INSPECTOR_PATH}`,
        upgradeHeader: 'websocket',
        environment: INSPECTOR_ENABLED_ENV,
      }),
    ).toBe(false);
  });

  it('the desktop path is untouched by the inspector', () => {
    const routeSource = readSource('devices/route.ts');
    expect(routeSource).toContain('MOBILE_BRIDGE_ROUTE_PREFIX');
    // El prefijo del inspector es un subpath del bridge mobile, no del desktop.
    expect(MOBILE_SESSION_INSPECTOR_PATH).not.toContain('pc-bridge');
    expect(MOBILE_SESSION_INSPECTOR_PATH).not.toContain('apollo');
  });
});

describe('B12.2 §1: el roster de sesiones no se abre con una credencial de telefono', () => {
  it('una credencial enrolada queda fuera y el camino del operador sigue abierto', () => {
    // El caso que se comprobo sobre workerd: un telefono con su propia credencial
    // recibia 200 y la lista de los telefonos de los demas.
    expect(isInspectorRequestDenied('apollo_dev_credencial-de-un-telefono')).toBe(true);
    // El operador entra con `?token=`, que no es un bearer.
    expect(isInspectorRequestDenied(null)).toBe(false);
  });

  it('cualquier bearer queda fuera, sin preguntar por el store', () => {
    // A proposito mas ancho que «bearer enrolado»: no consultar el store para
    // decidir significa que la respuesta no depende de ninguna lectura, y que un
    // bearer raro no se cuela por un store que respondio algo inesperado.
    expect(isInspectorRequestDenied('')).toBe(true);
    expect(isInspectorRequestDenied('cualquier-cosa')).toBe(true);
  });

  it('el DO consulta la politica ANTES de publicar el snapshot', () => {
    const source = readSource('agents/mobile-bridge.ts');
    const denyIndex = source.indexOf('isInspectorRequestDenied(');
    const respondIndex = source.indexOf(
      'buildMobileSessionInspectorResponse(this.#endpoint.inspectSessionSnapshot())',
    );
    expect(denyIndex).toBeGreaterThan(-1);
    expect(respondIndex).toBeGreaterThan(-1);
    // El orden importa: al reves, la comprobacion seria decorativa.
    expect(denyIndex).toBeLessThan(respondIndex);
  });

  it('el guard que prohibe que el borde conozca el inspector sigue en pie', () => {
    // La correccion va en el DO justamente para poder mantener esto: si el borde
    // supiera que el inspector existe, el guard de abajo habria que relajarlo.
    const indexSource = readSource('index.ts');
    expect(indexSource).not.toContain('inspect');
  });
});

describe('B12.2 §4: los diagnosticos no se activan solos', () => {
  function readWorkerConfiguration(): string {
    return readFileSync(join(SOURCE_ROOT, '..', 'wrangler.jsonc'), 'utf8');
  }

  it('ninguna configuracion de deploy prende un diagnostico', () => {
    // La bandera vive fuera del repo, en un secret o en un .dev.vars local. Si
    // aparece en `vars`, queda prendida para cualquiera que despliegue el
    // archivo, y para el starter que este app genera.
    const configurationSource = readWorkerConfiguration();
    for (const flagName of [
      'MOBILE_SESSION_INSPECTOR',
      'APOLLO_TOOL_HARNESS',
      'MOCK_VOICE',
      'INTERNAL_CORE_TOKEN',
    ]) {
      expect(configurationSource).not.toContain(flagName);
    }
  });

  it('la bandera sigue siendo un opt-in explicito, no un valor por defecto', () => {
    // El ejemplo que se reparte tiene que enseñar a prenderla a mano.
    const exampleSource = readFileSync(
      join(SOURCE_ROOT, '..', '.dev.vars.example'),
      'utf8',
    );
    expect(exampleSource).toContain('MOBILE_SESSION_INSPECTOR');
    expect(exampleSource).toContain('APOLLO_TOOL_HARNESS');
    // Y ningun valor real: los ejemplos viajan al starter.
    for (const flagName of ['MOBILE_SESSION_INSPECTOR', 'APOLLO_TOOL_HARNESS']) {
      const flagLine = exampleSource
        .split(/\r?\n/)
        .find((line) => line.startsWith(`${flagName}=`));
      expect(flagLine).toBeDefined();
      // trim() porque el ejemplo se versiona con CRLF y sin él el valor rightful
      // sería un \r.
      expect(flagLine?.slice(flagName.length + 1).trim()).toBe('');
    }
  });

  it('el ejemplo documenta por qué el roster no se abre con un teléfono', () => {
    // La documentación es la que evita que alguien lo prenda creyendo que es un
    // diagnóstico inocuo, así que la documentación va con el guard.
    const exampleSource = readFileSync(
      join(SOURCE_ROOT, '..', '.dev.vars.example'),
      'utf8',
    );
    expect(exampleSource).toContain('deviceId');
    expect(exampleSource).toContain('NO lo abre');
  });
});
