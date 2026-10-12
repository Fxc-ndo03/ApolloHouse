import { describe, expect, it } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { MobileDeviceEndpoint } from '@/devices/endpoint';
import { buildAuthenticatedDeviceProof } from '@/devices/registry';

// ─────────────────────────────────────────────────────────────────────────────
// Guards de seguridad del endpoint (§13).
//
// Estas pruebas leen el código fuente: no reachedan con un mock, fallan si
// alguien reintroduce un atajo en el endpoint.
// ─────────────────────────────────────────────────────────────────────────────

const SOURCE_ROOT = join(import.meta.dir, '..', '..');

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

function stripComment(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * El cuerpo de una función o método, desde su firma hasta la llave que la cierra.
 * Lo usan los guards que necesitan afirmar sobre UNA parte del archivo: cuando
 * un módulo gana rutas legítimas que no toca el camino que se quiere proteger,
 * un `not.toContain` sobre el archivo entero empieza a mentir.
 */
function readFunctionBody(source: string, signatureFragment: string): string {
  // Un fragmento puede aparecer primero como LUGAR DE LLAMADA y después como
  // declaración (`this.#buildHelloAuthorizer(auth);` vs `#buildHelloAuthorizer(
  // auth: ...)`). La llamada termina en `;` y no tiene cuerpo, así que se prueban
  // todas las apariciones y se toma la primera que tenga cuerpo real.
  let searchFrom = 0;
  while (searchFrom < source.length) {
    const signatureIndex = source.indexOf(signatureFragment, searchFrom);
    if (signatureIndex === -1) {
      break;
    }
    const bodyBraceIndex = findBodyBraceIndex(source, signatureIndex);
    if (bodyBraceIndex !== -1) {
      return readBraceBlock(source, bodyBraceIndex, signatureFragment);
    }
    searchFrom = signatureIndex + signatureFragment.length;
  }
  throw new Error(`no se encontro el cuerpo de ${signatureFragment}`);
}

/**
 * La llave del CUERPO, no la de un tipo. Hay que saltar la lista de parámetros:
 * un input tipado como `{ readonly request: Request }` abre una llave que no es
 * la del cuerpo y el balance arrancaría desde el lugar equivocado.
 */
function findBodyBraceIndex(source: string, signatureIndex: number): number {
  let parenDepth = 0;
  for (let index = signatureIndex; index < source.length; index += 1) {
    const character = source[index];
    if (character === '(') {
      parenDepth += 1;
      continue;
    }
    if (character === ')') {
      parenDepth -= 1;
      continue;
    }
    if (parenDepth !== 0) {
      continue;
    }
    if (character === '{') {
      return index;
    }
    if (character === ';') {
      return -1;
    }
  }
  return -1;
}

function readBraceBlock(
  source: string,
  openBraceIndex: number,
  signatureFragment: string,
): string {
  let depth = 0;
  for (let index = openBraceIndex; index < source.length; index += 1) {
    if (source[index] === '{') {
      depth += 1;
      continue;
    }
    if (source[index] !== '}') {
      continue;
    }
    depth -= 1;
    if (depth === 0) {
      return source.slice(openBraceIndex, index + 1);
    }
  }
  throw new Error(`el cuerpo de ${signatureFragment} no cierra`);
}

function readSource(relativePath: string): string {
  return stripComment(readFileSync(join(SOURCE_ROOT, relativePath), 'utf8'));
}

const ENDPOINT_MODULE_LIST = [
  'devices/endpoint.ts',
  'devices/route.ts',
  'devices/mobile.ts',
  'devices/connection.ts',
  'agents/mobile-bridge.ts',
];

describe('B8.1 §13: security guards', () => {
  it('the endpoint never executes tools', () => {
    for (const moduleName of ENDPOINT_MODULE_LIST) {
      const source = readSource(moduleName);
      expect(source).not.toContain('@/tools/execution');
      expect(source).not.toContain('@/tools/router');
      expect(source).not.toContain('.handler(');
      expect(source).not.toContain('executeAuthorizedTool');
      expect(source).not.toContain('executeToolWithTargetResolution');
    }
  });

  it('the endpoint never imports PcBridge', () => {
    for (const moduleName of ENDPOINT_MODULE_LIST) {
      const source = readSource(moduleName);
      expect(source).not.toContain('getAgentByName');
      expect(source).not.toContain('@/devices/desktop');
      expect(source).not.toContain('PcBridge');
    }
  });

  it('the transport and session layers do no target resolution', () => {
    // BLOCK 9: el bridge tiene el RPC de discovery (espejo de PcBridge) pero
    // delega en el registry. La política de selección tiene un solo dueño, así
    // que ninguna capa de devices/selecciona targets por su cuenta.
    for (const moduleName of [
      'devices/endpoint.ts',
      'devices/route.ts',
      'devices/mobile.ts',
      'devices/connection.ts',
      'devices/session.ts',
      'devices/dispatch.ts',
      'devices/envelope.ts',
      'devices/inspector.ts',
    ]) {
      const source = readSource(moduleName);
      expect(source).not.toContain('resolveTarget');
      expect(source).not.toContain('resolveCapabilityTarget');
    }
    const bridgeSource = readSource('agents/mobile-bridge.ts');
    expect(bridgeSource).toContain('registry.resolveTarget');
    expect(bridgeSource).not.toContain('doesSessionMatchSnapshot');
  });

  it('a deviceId alone never authenticates', () => {
    // El único lugar que puede fabricar un proof es el registry, con el mismo
    // helper que usa el desktop. El endpoint lo pide, no lo crea por deviceId.
    const mintModuleList = listSourceFilePathList()
      .filter((filePath) =>
        stripComment(readFileSync(filePath, 'utf8')).includes(
          'buildAuthenticatedDeviceProof(',
        ),
      )
      .map((filePath) =>
        filePath.replace(SOURCE_ROOT, '').replace(/\\/g, '/').replace(/^\//, ''),
      );
    expect(mintModuleList).not.toContain('devices/endpoint.ts');
    expect(mintModuleList).not.toContain('devices/route.ts');
    expect(mintModuleList).not.toContain('devices/mobile.ts');

    // BLOCK 12: la FUNCIÓN que autoriza el WebSocket no puede mirar un deviceId.
    // Antes el guard cubría `route.ts` entero; ahora route.ts también tiene las
    // rutas HTTP de enrollment, que sí reciben un deviceId en el body pero NO
    // autentican un socket. Por eso el guard se.apply sobre el cuerpo de
    // `authorizeMobileDeviceRequest`, que es la única parte que decide si un
    // socket entra.
    const routeSource = readSource('devices/route.ts');
    const websocketAuthorizerBody = readFunctionBody(
      routeSource,
      'export async function authorizeMobileDeviceRequest',
    );
    expect(websocketAuthorizerBody).not.toContain('deviceId');
    expect(websocketAuthorizerBody).not.toContain('device_id');
    // ...y decide el ámbito antes de dejar pasar, leyendo el header, no la URL.
    expect(websocketAuthorizerBody).toContain('readBearerCredentialFromRequest');

    // La ruta legacy conserva su regla: rol 'device' por el secreto global.
    expect(routeSource).toContain('isDeviceSharedSecretValid');
    expect(routeSource).toContain('environment.DEVICE_SHARED_SECRET');
  });

  it('BLOCK 12 §1: the enrolled scope binds the deviceId from the credential', () => {
    // La identidad atada sale del hash verificado en el servidor. Un `?deviceId=`
    // en la URL no puede cambiar quién es la conexión, así que el scope
    // enrolado no lee deviceId de ningún lado de la petición.
    const endpointSource = readSource('devices/endpoint.ts');
    const authorizerBody = readFunctionBody(endpointSource, '#buildHelloAuthorizer(');
    expect(authorizerBody).toContain("auth.scope === 'enrolled_android'");
    expect(authorizerBody).toContain('helloDeviceId !== boundDeviceId');
    expect(authorizerBody).toContain('credential_device_mismatch');
    expect(authorizerBody).not.toContain('searchParams');
    expect(authorizerBody).not.toContain('headers.get');

    // Y el camino legacy consulta el store, que es el cierre del bypass.
    expect(authorizerBody).toContain('#enrolledDeviceIdSet.has(helloDeviceId)');
    expect(authorizerBody).toContain('device_is_enrolled_or_revoked');
  });

  it('an unauthenticated socket cannot enter the registry', () => {
    const endpoint = new MobileDeviceEndpoint({ nowMilliseconds: () => 1_000 });
    endpoint.handleConnect({
      connectionId: 'mobile-1',
      port: { send: () => undefined, close: () => undefined },
      proof: null,
    });
    endpoint.handleMessage(
      'mobile-1',
      JSON.stringify({
        type: 'hello',
        deviceId: 'mobile:phone-123',
        deviceType: 'mobile',
        protocolVersion: 1,
        capabilities: ['mobile.notifications'],
        ts: 1_000,
      }),
    );
    expect(endpoint.registry.listDeviceList()).toHaveLength(0);
    expect(endpoint.registry.listSelectableSessionList()).toHaveLength(0);
    expect(endpoint.lifecycle.listHeartbeatSchedulerCount()).toBe(0);
  });

  it('a partially negotiated session is not selectable', () => {
    const endpoint = new MobileDeviceEndpoint({ nowMilliseconds: () => 1_000 });
    // Proof válido pero hello que nunca llega: hay conexión, no hay sesión.
    endpoint.handleConnect({
      connectionId: 'mobile-1',
      port: { send: () => undefined, close: () => undefined },
      proof: buildAuthenticatedDeviceProof('device'),
    });
    expect(endpoint.registry.listDeviceList()).toHaveLength(0);
    expect(endpoint.registry.listSelectableSessionList()).toHaveLength(0);
    expect(endpoint.getTransport('mobile-1')?.getDeviceId()).toBeNull();
    // Tampoco hay scheduler antes del hello.
    expect(endpoint.lifecycle.listHeartbeatSchedulerCount()).toBe(0);
  });

  it('mobile sessions carry no secrets', () => {
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
        deviceId: 'mobile:phone-123',
        deviceType: 'mobile',
        protocolVersion: 1,
        capabilities: [],
        ts: 1_000,
      }),
    );
    const session = endpoint.registry.getDevice('mobile:phone-123');
    expect(session).toBeDefined();
    const serialized = JSON.stringify(session);
    for (const forbidden of ['token', 'secret', 'proof', 'password', 'authorization']) {
      expect(serialized.toLowerCase()).not.toContain(forbidden);
    }
  });

  it('the DO owns exactly one endpoint, so no state is duplicated per socket', () => {
    // La clase del DO no se puede instanciar bajo bun (importa cloudflare:), así
    // que esta invariante se verifica sobre el fuente: un solo
    // `new MobileDeviceEndpoint()` y ningún get/setter que lo fabrique por
    // conexión.
    const source = readSource('agents/mobile-bridge.ts');
    const constructionCount = source.split('new MobileDeviceEndpoint(').length - 1;
    expect(constructionCount).toBe(1);
    expect(source).toMatch(/readonly #endpoint = new MobileDeviceEndpoint\(\);/);
    expect(source).not.toContain('get #endpoint');
  });

  it('the DO adapter has no device logic of its own', () => {
    // El DO debe delegar: si aparece lógica de sesión acá, el endpoint real deja
    // de estar cubierto por los tests.
    const source = readSource('agents/mobile-bridge.ts');
    expect(source).toContain('MobileDeviceEndpoint');
    expect(source).not.toContain('deviceSessionSchema');
    expect(source).not.toContain('splitDeclaredCapabilityList');
    expect(source).not.toContain('resolveAvailableCapabilityList');
    expect(source).not.toContain('HeartbeatScheduler');
  });

  it('no endpoint module builds its own device identity from a hostname', () => {
    for (const moduleName of ENDPOINT_MODULE_LIST) {
      expect(readSource(moduleName)).not.toContain('buildDesktopDeviceIdFromHostname');
    }
  });
});

it('BLOCK 12 §5: the DO really attaches the enrollment store to the endpoint', () => {
  // Regression de un bug real: el endpoint se construía como campo de clase,
  // cuando `ctx` todavía no existe, así que nunca recibía el store. El
  // authorizer quedaba `null`, la regla anti-bypass no corría, y un teléfono
  // revocado entraba igual por `?token=`. El smoke lo detectó; este guard lo
  // deja cerrado en `bun run test`.
  const bridgeSource = readSource('agents/mobile-bridge.ts');
  expect(bridgeSource).toContain('this.#endpoint.attachEnrollmentStore(store)');
  expect(bridgeSource).toContain('createSqliteEnrollmentStore');

  // Y el endpoint tiene que tener la forma de adjuntarlo, no un campo readonly
  // que sólo se pueda setear en el constructor.
  const endpointSource = readSource('devices/endpoint.ts');
  expect(endpointSource).toContain('attachEnrollmentStore(store: EnrollmentStore)');
  expect(endpointSource).not.toContain('readonly #enrollmentStore');
  // Un authorizer `null` significa "no hay anti-bypass", así que tiene que
  // quedar explícito que sin store NO se filtran tools.
  const buildBody = readFunctionBody(endpointSource, '#buildHelloAuthorizer(');
  expect(buildBody).toContain('if (store === null)');
  expect(buildBody).toContain('return null');
});
