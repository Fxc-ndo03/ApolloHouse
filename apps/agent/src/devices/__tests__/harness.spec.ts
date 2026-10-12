import { describe, expect, it } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import {
  APOLLO_TOOL_HARNESS_PATH,
  apolloToolHarnessRequestSchema,
  buildApolloToolHarnessDisabledResponse,
  isApolloToolHarnessEnabled,
  isApolloToolHarnessRequest,
  readApolloToolHarnessRequest,
} from '@/devices/harness';
import { resolveMobileBridgeClient } from '@/devices/bridge-client';

// ─────────────────────────────────────────────────────────────────────────────
// BLOCK 9.2: el harness de Apollo no es superficie productiva.
//
// El harness existe para el smoke real del camino de producción, pero no es un
// @callable: no existe en el RPC ni por WebSocket, y en una deployment real —sin
// la condición test-only del servidor— no existe por ningún canal.
// ─────────────────────────────────────────────────────────────────────────────

const SOURCE_ROOT = join(import.meta.dir, '..', '..');
const APOLLO_SOURCE_PATH = join(SOURCE_ROOT, 'agents', 'apollo.ts');
const INDEX_SOURCE_PATH = join(SOURCE_ROOT, 'index.ts');

type HarnessEnvironment = Parameters<typeof isApolloToolHarnessEnabled>[0];

const ENABLED_ENVIRONMENT = {
  APOLLO_TOOL_HARNESS: 'enabled',
} as unknown as HarnessEnvironment;
const ABSENT_ENVIRONMENT = {} as unknown as HarnessEnvironment;
const HARNESS_PATH = `/agents/apollo/default/${APOLLO_TOOL_HARNESS_PATH}`;

function stripComment(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function readApolloSource(): string {
  return stripComment(readFileSync(APOLLO_SOURCE_PATH, 'utf8'));
}

function readIndexSource(): string {
  return stripComment(readFileSync(INDEX_SOURCE_PATH, 'utf8'));
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

/**
 * Extrae el cuerpo de un metodo contando llaves en vez de con una ventana fija.
 * La version anterior usaba `slice(start, start + 2000)` y fallo en Block 11 al
 * agregar el callback de timing: el guard dejaba de ver el codigo que vigilaba.
 */
function extractMethodBody(source: string, signature: string): string {
  const signatureIndex = source.indexOf(signature);
  if (signatureIndex < 0) {
    throw new Error(`no se encontro ${signature}`);
  }
  // El `{` del cuerpo es el primero que aparece fuera de la lista de parámetros
  // y del tipo de retorno. Sin este filtro se matchea el literal de tipo
  // `Promise<{...}>` en vez del cuerpo.
  let openBraceIndex = -1;
  let parenDepth = 0;
  let angleDepth = 0;
  // Empezar después del `)` que cierra la lista de parámetros: si se empieza
  // dentro, ese `)` lleva parenDepth a -1 y el `{` del cuerpo nunca calza.
  const afterParameterList = source.indexOf(')', signatureIndex + signature.length) + 1;
  for (let index = afterParameterList; index < source.length; index += 1) {
    const character = source[index];
    if (character === '(') {
      parenDepth += 1;
    } else if (character === ')') {
      parenDepth -= 1;
    } else if (character === '<') {
      angleDepth += 1;
    } else if (character === '>') {
      angleDepth -= 1;
    } else if (character === '{' && parenDepth === 0 && angleDepth === 0) {
      openBraceIndex = index;
      break;
    }
  }
  if (openBraceIndex < 0) {
    throw new Error(`no se encontro el cuerpo de ${signature}`);
  }
  let depth = 0;
  for (let index = openBraceIndex; index < source.length; index += 1) {
    const character = source[index];
    if (character === '{') {
      depth += 1;
    } else if (character === '}') {
      depth -= 1;
      if (depth === 0) {
        return source.slice(signatureIndex, index + 1);
      }
    }
  }
  throw new Error(`llaves sin cerrar en ${signature}`);
}

describe('B9.2 §1+9: Apollo production does not expose the harness', () => {
  it('1. the harness is not a productive callable', () => {
    const source = readApolloSource();
    expect(source).not.toContain('@callable()\n  async debugExecuteTargetedTool');
    expect(source).not.toContain('debugExecuteTargetedTool');
    // Ningún método público del harness quedó registrado como callable.
    const callableNameList = [...source.matchAll(/@callable\(\)\s*async\s+(\w+)/g)].map(
      (match) => match[1],
    );
    expect(callableNameList).not.toContain('debugExecuteTargetedTool');
  });

  it('9. there is no productive callable for the harness anywhere', () => {
    const offenderList = listSourceFilePathList().filter((filePath) =>
      stripComment(readFileSync(filePath, 'utf8')).includes('debugExecuteTargetedTool'),
    );
    expect(offenderList).toEqual([]);
  });

  it('the harness body lives in a private method, not in the RPC surface', () => {
    const source = readApolloSource();
    expect(source).toContain('async #runToolForHarness(');
    expect(source).toContain('override async fetch(request: Request)');
  });
});

describe('B9.2 §2+3: without the test-only config the surface does not exist', () => {
  it('3. the gate is closed when the server env is absent', () => {
    expect(isApolloToolHarnessEnabled(ABSENT_ENVIRONMENT)).toBe(false);
    expect(
      isApolloToolHarnessRequest({
        pathname: HARNESS_PATH,
        upgradeHeader: null,
        environment: ABSENT_ENVIRONMENT,
      }),
    ).toBe(false);
  });

  it('the disabled response is a 404, because the surface is not there', async () => {
    const response = buildApolloToolHarnessDisabledResponse();
    expect(response.status).toBe(404);
    expect(await response.text()).toBe('Not found');
  });

  it('2. an authenticated device cannot reach it over a WebSocket', () => {
    // Aunque el flag esté prendido, un WebSocket nunca es el harness: un device
    // con su sesión abierta no puede invocarlo.
    for (const upgradeHeader of ['websocket', 'WebSocket']) {
      expect(
        isApolloToolHarnessRequest({
          pathname: HARNESS_PATH,
          upgradeHeader,
          environment: ENABLED_ENVIRONMENT,
        }),
      ).toBe(false);
    }
  });

  it('2b. the gate never reads anything the client controls', () => {
    const harnessSource = stripComment(
      readFileSync(join(SOURCE_ROOT, 'devices', 'harness.ts'), 'utf8'),
    );
    for (const forbidden of [
      'searchParams',
      'deviceId',
      'deviceType',
      'token',
      'authorization',
      'globalThis',
      'process.env',
    ]) {
      expect(harnessSource.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
    // La única fuente es el env del servidor.
    expect(harnessSource).toContain('environment.APOLLO_TOOL_HARNESS');
  });

  it('the env flag is optional, so the starter ships without the surface', () => {
    const environmentSource = stripComment(
      readFileSync(join(SOURCE_ROOT, 'configuration', 'environment.d.ts'), 'utf8'),
    );
    expect(environmentSource).toContain('APOLLO_TOOL_HARNESS?: string;');
  });
});

describe('B9.2 §4+7: with the test-only config the smoke can use it', () => {
  it('4. with the flag the HTTP path is accepted', () => {
    expect(isApolloToolHarnessEnabled(ENABLED_ENVIRONMENT)).toBe(true);
    expect(
      isApolloToolHarnessRequest({
        pathname: HARNESS_PATH,
        upgradeHeader: null,
        environment: ENABLED_ENVIRONMENT,
      }),
    ).toBe(true);
  });

  it('7. the harness request carries correlation and a toolName, nothing else', () => {
    const parsed = apolloToolHarnessRequestSchema.safeParse({
      toolName: 'send_mobile_notification',
      args: { title: 'A', body: 'B' },
      correlation: { requestId: 'r-1', clientTurnId: 't-1', generation: 5 },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(Object.keys(parsed.data).toSorted()).toEqual([
        'args',
        'correlation',
        'toolName',
      ]);
      expect(parsed.data.correlation?.requestId).toBe('r-1');
      expect(parsed.data.correlation?.clientTurnId).toBe('t-1');
      expect(parsed.data.correlation?.generation).toBe(5);
    }
  });

  it('the request cannot carry a capability, un deviceId ni un target', () => {
    // strict() +形状 explícita: no hay por dónde inyectar un target propio.
    for (const injection of [
      { toolName: 'weather_now', capability: 'mobile.notifications' },
      { toolName: 'weather_now', targetDeviceId: 'mobile:phone-123' },
      { toolName: 'weather_now', resolver: 'ninguno' },
      { toolName: 'weather_now', skipAuthorization: true },
      { toolName: 'weather_now', correlation: { requestId: 'r', deviceId: 'mobile:x' } },
    ]) {
      expect(apolloToolHarnessRequestSchema.safeParse(injection).success).toBe(false);
    }
  });

  it('reads a JSON body defensively', () => {
    expect(readApolloToolHarnessRequest('no json').status).toBe('invalid');
    expect(readApolloToolHarnessRequest('{}').status).toBe('invalid');
    const parsed = readApolloToolHarnessRequest('{"toolName":"weather_now"}');
    expect(parsed.status).toBe('parsed');
    expect(parsed.request?.toolName).toBe('weather_now');
  });
});

describe('B9.2 §5+6: the harness cannot bypass the pipeline', () => {
  it('5. the harness cannot modify target resolution', () => {
    const source = readApolloSource();
    const harnessStart = source.indexOf('async #runToolForHarness(');
    const harnessBody = source.slice(harnessStart, harnessStart + 2_000);
    // Usa el resolver de producción, no uno propio.
    expect(harnessBody).toContain('buildCapabilityTargetResolver(this.env)');
    // Y no resuelve targets por su cuenta ni acepta un resolver del cliente.
    expect(harnessBody).not.toContain('resolveTarget(');
    expect(harnessBody).not.toContain('targetPreference');
  });

  it('6. the harness cannot execute handlers directly', () => {
    const source = readApolloSource();
    const harnessStart = source.indexOf('async #runToolForHarness(');
    const harnessBody = source.slice(harnessStart, harnessStart + 2_000);
    // Todo pasa por el pipeline: resolución → autorización → ejecución.
    expect(harnessBody).toContain('executeToolWithTargetResolution');
    expect(harnessBody).not.toContain('.handler(');
    expect(harnessBody).not.toContain('executeAuthorizedTool');
    expect(harnessBody).not.toContain('authorizeToolExecution');
  });

  it('the harness forwards the turn correlation into the pipeline', () => {
    const harnessBody = extractMethodBody(
      readApolloSource(),
      'async #runToolForHarness(',
    );
    // La correlación se arma desde el request del harness y se pasa al pipeline.
    expect(harnessBody).toContain('requestId:');
    expect(harnessBody).toContain('clientTurnId:');
    expect(harnessBody).toContain('generation:');
    expect(harnessBody).toMatch(/correlation,\s*onTiming|correlation,/);
  });

  it('the harness reports the target the PIPELINE resolved, it does not resolve it', () => {
    // El guard anterior buscaba 'targetDeviceId:' en una ventana fija y sólo
    // encontraba el literal de TIPO del return, nunca el cuerpo: era un falso
    // positivo. La invariante real es que el target venga del outcome.
    const harnessBody = extractMethodBody(
      readApolloSource(),
      'async #runToolForHarness(',
    );
    expect(harnessBody).toContain(
      'targetDeviceId: pipelineOutcome.target?.deviceId ?? null',
    );
    expect(harnessBody).toContain(
      'targetDeviceType: pipelineOutcome.target?.deviceType ?? null',
    );
    // Y el harness NO resuelve target por su cuenta.
    expect(harnessBody).not.toContain('resolveCapabilityTarget(');
    expect(harnessBody).not.toContain('resolveExecutionTarget(');
    expect(harnessBody).not.toContain('registry.resolveTarget');
  });

  it('the harness cannot resolve its own target outside the pipeline', () => {
    // El harness llama al MISMO pipeline que un turno de voz: no puede resolver
    // target por su cuenta ni ejecutar la tool sin pasar por autorización.
    const harnessBody = extractMethodBody(
      readApolloSource(),
      'async #runToolForHarness(',
    );
    expect(harnessBody).toContain('executeToolWithTargetResolution');
    expect(harnessBody).not.toContain('sendMobileCommand');
    expect(harnessBody).not.toContain('sendNotificationCommand');
    expect(harnessBody).not.toContain('getAgentByName');
  });
});

describe('B9.2 §8: no alternative route', () => {
  it('8. there is no HTTP or WebSocket route to the harness outside the Apollo DO', () => {
    // El index.ts no registra ninguna ruta para el harness.
    const indexSource = readIndexSource();
    expect(indexSource).not.toContain(APOLLO_TOOL_HARNESS_PATH);
    expect(indexSource).not.toContain('__tool-harness');
    // Y ningún módulo de producción lo menciona: sólo el harness, el Apollo DO y
    // el smoke (que tiene que conocer el path para poder probarlo).
    const offenderList = listSourceFilePathList()
      .filter((filePath) => filePath !== APOLLO_SOURCE_PATH)
      .filter((filePath) => {
        const relativePath = filePath
          .replace(SOURCE_ROOT, '')
          .replace(/\\/g, '/')
          .replace(/^\//, '');
        return (
          !relativePath.endsWith('devices/harness.ts') &&
          !relativePath.startsWith('smoke/') &&
          !relativePath.endsWith('__tests__/harness.spec.ts')
        );
      })
      .filter((filePath) =>
        stripComment(readFileSync(filePath, 'utf8')).includes(APOLLO_TOOL_HARNESS_PATH),
      );
    expect(offenderList).toEqual([]);
  });

  it('the harness does not create a new secret, token or authorization', () => {
    const harnessSource = stripComment(
      readFileSync(join(SOURCE_ROOT, 'devices', 'harness.ts'), 'utf8'),
    );
    expect(harnessSource).not.toContain('DEVICE_SHARED_SECRET');
    expect(harnessSource).not.toContain('DASHBOARD_SHARED_SECRET');
    expect(harnessSource).not.toContain('getAgentByName');
    expect(harnessSource).not.toContain('buildAuthenticatedDeviceProof');
  });

  it('the harness stays capability-agnostic', () => {
    const harnessSource = stripComment(
      readFileSync(join(SOURCE_ROOT, 'devices', 'harness.ts'), 'utf8'),
    );
    expect(harnessSource).toContain('toolName');
    expect(harnessSource).not.toContain('mobile.notifications');
    expect(harnessSource).not.toContain('sendNotificationCommand');
    // Tampoco se especializó en mobile dentro de Apollo.
    const apolloSource = readApolloSource();
    const harnessStart = apolloSource.indexOf('async #runToolForHarness(');
    expect(apolloSource.slice(harnessStart, harnessStart + 2_000)).not.toContain(
      'mobile.notifications',
    );
  });

  it('the harness does not open a second transport boundary', () => {
    // Apollo sigue hablando con MobileBridge por el resolver de producción, no
    // por un cliente propio del harness.
    const source = readApolloSource();
    const harnessStart = source.indexOf('async #runToolForHarness(');
    const harnessBody = source.slice(harnessStart, harnessStart + 2_000);
    expect(harnessBody).toContain('buildCapabilityTargetResolver(this.env)');
    expect(harnessBody).not.toContain('resolveMobileBridgeClient');
    expect(harnessBody).not.toContain('getAgentByName');
    // Y el cliente del bridge sigue siendo el único que nombra la instancia.
    expect(resolveMobileBridgeClient({} as never)).toBeUndefined();
  });
});
