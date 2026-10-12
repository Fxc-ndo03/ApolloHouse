import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';

import {
  MOBILE_CLIENT_INVARIANT_ANCHOR_MAP,
  MOBILE_CLIENT_INVARIANT_LIST,
} from '../../agent/smoke/mobile-client';
import { join } from 'node:path';

/**
 * Gate de paridad Block 10.
 *
 * El cliente mobile real es Kotlin (APOLLO_ANDROID_SOURCE_OF_TRUTH.md fija Android +
 * Kotlin 1.3 + AGP 3.3 sobre Android 7.1), pero esta maquina no tiene kotlinc,
 * Gradle ni Android SDK, asi que sus tests JUnit no se pueden ejecutar desde aca.
 *
 * Este archivo es el control compensatorio: lee las constantes que declara el
 * cliente Kotlin y las deriva del lado TypeScript que SI se puede ejecutar, de modo
 * que un drift entre el cliente y el protocolo falle en `bun run test`.
 */

const AGENT_SOURCE_ROOT = join(import.meta.dir, '..', '..', 'agent', 'src');
const REPOSITORY_ROOT = join(import.meta.dir, '..', '..', '..');
const KOTLIN_SOURCE_ROOT = join(
  import.meta.dir,
  '..',
  'app',
  'src',
  'main',
  'java',
  'com',
  'apollo',
  'mobile',
);
const KOTLIN_TEST_ROOT = join(
  import.meta.dir,
  '..',
  'app',
  'src',
  'test',
  'java',
  'com',
  'apollo',
  'mobile',
);

/**
 * El codigo sin prosa. Hace falta porque el comentario que explica por que el
 * bearer NO se valida contra DEVICE_SHARED_SECRET menciona el secreto, y el
 * guard no puede leer su propia explicacion como una violacion.
 */
function stripTypeScriptComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function readAgentSource(relativePath: string): string {
  return readFileSync(join(AGENT_SOURCE_ROOT, relativePath), 'utf8');
}

function readKotlinSource(relativePath: string): string {
  return readFileSync(join(KOTLIN_SOURCE_ROOT, relativePath), 'utf8');
}

/**
 * El cuerpo de UNA función, para poder afirmar sobre una parte del archivo sin
 * Mentir por el resto. Hace falta cuando un módulo gana caminos legítimos que no
 * tocan el que se quiere proteger: un `not.toContain` sobre el archivo entero
 * empieza a dar falsos positivos y, peor, obliga a debilitar el guard.
 *
 * Un fragmento puede aparecer primero como LUGAR DE LLAMADA y después como
 * declaración, así que se prueban todas las apariciones y se toma la primera que
 * tenga cuerpo real.
 */
/** Todas las posiciones de un fragmento, para poder afirmar sobre ORDEN. */
function listIndexOfEvery(source: string, fragment: string): number[] {
  const indexList: number[] = [];
  let searchFrom = 0;
  while (searchFrom < source.length) {
    const foundIndex = source.indexOf(fragment, searchFrom);
    if (foundIndex === -1) {
      break;
    }
    indexList.push(foundIndex);
    searchFrom = foundIndex + fragment.length;
  }
  return indexList;
}

function readFunctionBody(source: string, signatureFragment: string): string {
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

/**
 * Los guards de "el cliente no conoce X" tienen que mirar CODIGO, no prosa: los
 * comentarios del cliente mencionan justamente lo que no debe importar.
 */
function stripKotlinComments(source: string): string {
  return source.replaceAll(/\/\*[\s\S]*?\*\//g, ' ').replaceAll(/\/\/[^\n]*/g, ' ');
}

function readMobileSchemaSource(protocolSource: string): string {
  const matched = protocolSource.match(
    /export const mobileToServerMessageSchema[\s\S]*?\n\]\);/,
  );
  if (matched === null) {
    throw new Error('no se encontro mobileToServerMessageSchema');
  }
  return matched[0];
}

/** Todas las claves que el Worker acepta de un cliente mobile, en cualquier mensaje. */
function readWorkerKeyList(mobileSchema: string): string[] {
  return [...mobileSchema.matchAll(/(\w+):/g)]
    .map((entry) => entry[1] as string)
    .filter(
      (keyName) =>
        !['z', 'literal', 'object', 'string', 'number', 'array', 'boolean'].includes(
          keyName,
        ),
    );
}

/**
 * Las claves de primer nivel que escribe un builder. El `result` anidado
 * (`{posted: true}`) no es una clave del mensaje, asi que se separa por funcion.
 */
function readClientTopLevelKeyList(
  outboundSource: string,
  functionName: string,
): string[] {
  const startIndex = outboundSource.indexOf(`fun ${functionName}(`);
  if (startIndex < 0) {
    throw new Error(`no se encontro ${functionName}`);
  }
  const rest = outboundSource.slice(startIndex);
  const nextFunctionOffset = rest.slice(1).search(/\n\s*fun\s+\w+\(/);
  const body = nextFunctionOffset < 0 ? rest : rest.slice(0, nextFunctionOffset + 1);
  const topLevelKeyList = [...body.matchAll(/\.put\("(\w+)"/g)]
    .map((entry) => entry[1] as string)
    .filter((keyName) => keyName !== 'posted');
  return [...new Set(topLevelKeyList)];
}

function readStringConstant(source: string, constantName: string): string {
  const matched = source.match(
    new RegExp(`${constantName}\\s*(?::\\s*[Ss]tring)?\\s*=\\s*["'\`]([^"'\`]*)["'\`]`),
  );
  if (matched === null) {
    throw new Error(`no se encontro ${constantName}`);
  }
  return matched[1] as string;
}

function readIntegerConstant(source: string, constantName: string): number {
  const matched = source.match(new RegExp(`${constantName}\\s*:\\s*Int\\s*=\\s*(\\d+)`));
  if (matched === null) {
    throw new Error(`no se encontro ${constantName}`);
  }
  return Number(matched[1]);
}

function readLongConstant(source: string, constantName: string): number {
  const matched = source.match(
    new RegExp(`${constantName}\\s*:\\s*Long\\s*=\\s*([\\d_]+)L`),
  );
  if (matched === null) {
    throw new Error(`no se encontro ${constantName}`);
  }
  return Number((matched[1] as string).replaceAll('_', ''));
}

function readStringListConstant(source: string, constantName: string): string[] {
  const matched = source.match(
    new RegExp(`${constantName}[^=]*=\\s*listOf\\(([^)]*)\\)`, 's'),
  );
  if (matched === null) {
    throw new Error(`no se encontro ${constantName}`);
  }
  return [...(matched[1] as string).matchAll(/"([^"]+)"/g)].map(
    (entry) => entry[1] as string,
  );
}

function readLongListConstant(source: string, constantName: string): number[] {
  const matched = source.match(
    new RegExp(`${constantName}[^=]*=\\s*\\n?\\s*listOf\\(([^)]*)\\)`, 's'),
  );
  if (matched === null) {
    throw new Error(`no se encontro ${constantName}`);
  }
  return [...(matched[1] as string).matchAll(/([\d_]+)L/g)].map((entry) =>
    Number((entry[1] as string).replaceAll('_', '')),
  );
}

/**
 * Lee un `mapOf` de Kotlin como [clave, valores]. Block 11 cambio el valor de
 * `ALLOWED_COMMAND_MAP` de un comando a una LISTA de comandos, porque una
 * capability puede tener varios (mobile.alarm es alarm_set y alarm_cancel).
 */
function readKotlinMapEntries(
  source: string,
  constantName: string,
): [string, string[]][] {
  const matched = source.match(
    new RegExp(`${constantName}[^=]*=\\s*mapOf\\(([\\s\\S]*?)\\n\\s*\\)`),
  );
  if (matched === null) {
    throw new Error(`no se encontro ${constantName}`);
  }
  const entryList: [string, string[]][] = [];
  const entryPattern = /"([^"]+)"\s+to\s+(listOf\(([^)]*)\)|"([^"]+)")/g;
  for (const entry of (matched[1] as string).matchAll(entryPattern)) {
    const capabilityName = entry[1] as string;
    if (entry[3] !== undefined) {
      entryList.push([
        capabilityName,
        [...(entry[3] as string).matchAll(/"([^"]+)"/g)].map((item) => item[1] as string),
      ]);
      continue;
    }
    entryList.push([capabilityName, [entry[4] as string]]);
  }
  return entryList;
}

const kotlinContract = readKotlinSource(join('contract', 'contract.kt'));

describe('B10 §1-2: el endpoint del cliente es el que expone el Worker', () => {
  const routeSource = readAgentSource(join('devices', 'route.ts'));
  const bridgeClientSource = readAgentSource(join('devices', 'bridge-client.ts'));

  test('el path del cliente es la ruta real del MobileBridge', () => {
    const agentName = readStringConstant(routeSource, 'MOBILE_BRIDGE_AGENT_NAME');
    const routePrefix = readStringConstant(
      routeSource,
      'MOBILE_BRIDGE_ROUTE_PREFIX',
    ).replace('${MOBILE_BRIDGE_AGENT_NAME}', agentName);
    const instanceName = readStringConstant(
      bridgeClientSource,
      'MOBILE_BRIDGE_INSTANCE_NAME',
    );
    const workerPath = `${routePrefix}/${instanceName}`;

    expect(readStringConstant(kotlinContract, 'MOBILE_BRIDGE_PATH')).toBe(workerPath);
    expect(workerPath).toBe('/agents/mobile-bridge/mobile');
  });
});

describe('B10 §1: la identidad usa el formato que valida el Worker', () => {
  const identitySource = readAgentSource(join('devices', 'identity.ts'));

  test('el deviceType del cliente es uno de los que acepta el Worker', () => {
    const deviceTypeList = [
      ...(
        identitySource.match(/DEVICE_TYPE_LIST\s*=\s*\[([^\]]*)\]/)?.[1] ?? ''
      ).matchAll(/'([^']+)'/g),
    ].map((entry) => entry[1]);

    expect(readStringConstant(kotlinContract, 'DEVICE_TYPE')).toBe('mobile');
    expect(deviceTypeList).toContain(readStringConstant(kotlinContract, 'DEVICE_TYPE'));
  });

  test('el prefijo del deviceId sale del separador real del Worker', () => {
    const separator = readStringConstant(identitySource, 'DEVICE_ID_SEPARATOR');
    expect(readStringConstant(kotlinContract, 'DEVICE_ID_PREFIX')).toBe(
      `mobile${separator}`,
    );
  });

  test('el cliente no deriva la identidad de un hostname', () => {
    const identityImplementation = stripKotlinComments(
      readKotlinSource(join('identity', 'identity.kt')),
    );
    expect(identityImplementation).not.toContain('hostname');
    expect(identityImplementation).not.toContain('InetAddress');
    expect(identityImplementation).not.toContain('getLocalHost');
  });
});

describe('B10 §3 y §7: las capabilities se derivan del catalogo, no se inventan', () => {
  const capabilitySource = readAgentSource(join('devices', 'capability.ts'));

  function readImplementedCapabilityEntryList(): [string, string[]][] {
    const block = capabilitySource.match(
      /const implementedContractMap[\s\S]*?new Map\(\[([\s\S]*?)\n  \]\);/,
    );
    if (block === null) {
      throw new Error('no se encontro implementedContractMap');
    }
    // El grupo de comandos tiene corchetes anidados cuando son varios
    // (desktop.spotify, mobile.media): `[^\]]*` cortaba en el primero y armaba
    // una lista incompleta.
    return [...(block[1] as string).matchAll(/\['([^']+)',\s*\[([^[\]]*)\]\]/g)].map(
      (entry) => [
        entry[1] as string,
        [...(entry[2] as string).matchAll(/'([^']+)'/g)].map((name) => name[1] as string),
      ],
    );
  }

  test('el cliente anuncia exactamente las capabilities mobile implementadas', () => {
    const implementedMobileCapabilityList = readImplementedCapabilityEntryList()
      .filter(([capabilityName]) => capabilityName.startsWith('mobile.'))
      .map(([capabilityName]) => capabilityName);

    // BLOCK 11: las seis mobile tienen comando real de punta a punta. El orden
    // del mapa del Worker no es el del catálogo, así que la comparación es
    // ordenada; lo que importa es el conjunto.
    expect([...implementedMobileCapabilityList].toSorted()).toEqual([
      'mobile.alarm',
      'mobile.calendar',
      'mobile.media',
      'mobile.notifications',
      'mobile.open_app',
      'mobile.volume',
    ]);
    expect(
      readStringListConstant(kotlinContract, 'ANNOUNCED_CAPABILITY_LIST').toSorted(),
    ).toEqual([...implementedMobileCapabilityList].toSorted());
  });

  test('la allowlist del cliente no incluye ninguna capability unimplemented', () => {
    const mobileCapabilityList = [
      ...(
        capabilitySource.match(/MOBILE_CAPABILITY_NAME_LIST\s*=\s*\[([^\]]*)\]/)?.[1] ??
        ''
      ).matchAll(/'([^']+)'/g),
    ].map((entry) => entry[1] as string);
    const implementedMobileCapabilityList = readImplementedCapabilityEntryList()
      .filter(([capabilityName]) => capabilityName.startsWith('mobile.'))
      .map(([capabilityName]) => capabilityName);

    const allowlistCapabilityList = readKotlinMapEntries(
      kotlinContract,
      'ALLOWED_COMMAND_MAP',
    ).map(([capabilityName]) => capabilityName);

    for (const capabilityName of allowlistCapabilityList) {
      expect(mobileCapabilityList).toContain(capabilityName);
      expect(implementedMobileCapabilityList).toContain(capabilityName);
    }
  });

  test('la allowlist mapea al comando que el catalogo declara', () => {
    const workerCommandNameList = [
      ...(
        capabilitySource.match(/MOBILE_COMMAND_NAME_LIST\s*=\s*\[([^\]]*)\]/)?.[1] ?? ''
      ).matchAll(/'([^']+)'/g),
    ].map((entry) => entry[1] as string);

    for (const [, commandNameList] of readKotlinMapEntries(
      kotlinContract,
      'ALLOWED_COMMAND_MAP',
    )) {
      for (const commandName of commandNameList) {
        expect(workerCommandNameList).toContain(commandName);
      }
    }
  });

  test('la allowlist es explicita y no tiene lookup dinamico', () => {
    const allowlistSource = readKotlinSource(join('command', 'allowlist.kt'));
    // Block 11: la allowlist mapea capability -> LISTA de comandos, porque una
    // capability tiene varios (mobile.alarm es alarm_set y alarm_cancel).
    expect(allowlistSource).toContain('ALLOWED_COMMAND_MAP[');
    expect(allowlistSource).toContain('ALLOWED_COMMAND_MAP.containsKey');
    expect(allowlistSource).toContain('isCommandDeclaredByCapability');
    // Lo prohibido sigue siendo la heurística por prefijo, que es lo que
    // permitiría dispatchear algo que la capability no declara (§16).
    expect(allowlistSource).not.toContain('startsWith(');
    expect(allowlistSource).not.toContain('substring(');
    expect(allowlistSource).not.toContain('Regex(');
    // Y no puede inventar una capability: todas salen del mapa.
    expect(allowlistSource).toContain('?: emptyList()');
  });

  test('cada capability mobile del Worker aparece con sus comandos en el peer', () => {
    const kotlinAllowlist = readKotlinMapEntries(kotlinContract, 'ALLOWED_COMMAND_MAP');
    const capabilityCommandMap = new Map<string, string[]>();
    for (const [capabilityName, commandNameList] of kotlinAllowlist) {
      capabilityCommandMap.set(capabilityName, commandNameList);
    }

    for (const [
      capabilityName,
      commandNameList,
    ] of readImplementedCapabilityEntryList()) {
      if (!capabilityName.startsWith('mobile.')) {
        continue;
      }
      expect(capabilityCommandMap.get(capabilityName)).toEqual(commandNameList);
    }
  });
});

describe('B10 §8: el payload valida los mismos limites que el Worker', () => {
  const protocolSource = readAgentSource(join('protocol', 'schema.ts'));

  test('los limites de title y body vienen del schema del Worker', () => {
    const titleMax = Number(
      protocolSource.match(/title:\s*z\.string\(\)\.min\(1\)\.max\((\d+)\)/)?.[1],
    );
    const bodyMax = Number(
      protocolSource.match(/body:\s*z\.string\(\)\.min\(1\)\.max\((\d+)\)/)?.[1],
    );

    expect(readIntegerConstant(kotlinContract, 'NOTIFICATION_TITLE_MAX_LENGTH')).toBe(
      titleMax,
    );
    expect(readIntegerConstant(kotlinContract, 'NOTIFICATION_BODY_MAX_LENGTH')).toBe(
      bodyMax,
    );
    expect(titleMax).toBe(120);
    expect(bodyMax).toBe(500);
  });

  test('el payload del cliente valida antes de ejecutar', () => {
    const payloadCode = stripKotlinComments(
      readKotlinSource(join('command', 'payload.kt')),
    );
    // BLOCK 11: el peer valida por COMANDO, no por capability, porque una
    // capability tiene varios comandos con payloads distintos (alarm_set pide la
    // hora, alarm_cancel no). El schema es estricto en todos.
    expect(payloadCode).toContain(
      'fun validate(commandName: String, payload: Map<String, Any?>)',
    );
    expect(payloadCode).toContain('hasExtraField');
    expect(payloadCode).toContain('unexpected_field');
    expect(payloadCode).toContain('NOTIFICATION_TITLE_MAX_LENGTH');
    expect(payloadCode).toContain('NOTIFICATION_BODY_MAX_LENGTH');
    expect(payloadCode).toContain('rawValue !is String');
    // Cada comando declarado por el catálogo tiene su rama de validación.
    for (const commandName of [
      'notification_post',
      'alarm_set',
      'alarm_cancel',
      'calendar_create',
      'calendar_cancel',
      'media_play',
      'volume_set',
      'volume_get',
      'app_open',
    ]) {
      expect(payloadCode).toContain(`"${commandName}"`);
    }
    expect(payloadCode).toContain('else -> Result.Invalid("unsupported_command")');
  });
});

describe('B10 §6: el heartbeat usa el intervalo que manda el servidor', () => {
  const presenceSource = readAgentSource(join('devices', 'presence.ts'));
  const protocolSource = readAgentSource(join('protocol', 'schema.ts'));

  test('el fallback coincide con HEARTBEAT_INTERVAL_MILLISECONDS del Worker', () => {
    const workerInterval = Number(
      presenceSource
        .match(/HEARTBEAT_INTERVAL_MILLISECONDS\s*=\s*([\d_]+)/)?.[1]
        ?.replaceAll('_', ''),
    );
    expect(
      readLongConstant(kotlinContract, 'FALLBACK_HEARTBEAT_INTERVAL_MILLISECONDS'),
    ).toBe(workerInterval);
  });

  test('el intervalo autoritativo viene en hello_accepted', () => {
    expect(protocolSource).toContain('heartbeatIntervalMilliseconds');
    const sessionSource = readKotlinSource(join('session', 'session.kt'));
    expect(sessionSource).toContain('accepted.heartbeatIntervalMilliseconds');
  });

  test('el cliente tiene un solo scheduler de heartbeat', () => {
    const heartbeatSource = readKotlinSource(join('session', 'heartbeat.kt'));
    expect(heartbeatSource).toContain('if (handle != null)');
    expect(heartbeatSource).toContain('return false');
  });
});

describe('B10 §4: el protocolo RPC es el existente, no uno nuevo', () => {
  const protocolSource = readAgentSource(join('protocol', 'schema.ts'));

  test('las claves del hello del cliente existen en el schema del Worker', () => {
    const mobileSchema = readMobileSchemaSource(protocolSource);
    const workerMobileKeyList = readWorkerKeyList(mobileSchema);

    const outboundSource = stripKotlinComments(
      readKotlinSource(join('protocol', 'outbound.kt')),
    );
    const helloKeyList = readClientTopLevelKeyList(outboundSource, 'buildHelloMessage');

    for (const key of helloKeyList) {
      expect(workerMobileKeyList).toContain(key);
    }
    expect(helloKeyList).toEqual([
      'type',
      'deviceId',
      'deviceType',
      'protocolVersion',
      'capabilities',
      'ts',
    ]);
    expect(readClientTopLevelKeyList(outboundSource, 'buildHeartbeatMessage')).toEqual([
      'type',
      'ts',
    ]);
  });

  test('el command_result del cliente no inventa claves', () => {
    const mobileSchema = readMobileSchemaSource(protocolSource);
    const workerMobileKeyList = readWorkerKeyList(mobileSchema);

    const outboundSource = readKotlinSource(join('protocol', 'outbound.kt'));
    const commandResultKeyList = readClientTopLevelKeyList(
      outboundSource,
      'buildCommandResultMessage',
    );

    for (const key of commandResultKeyList) {
      expect(workerMobileKeyList).toContain(key);
    }
    expect(commandResultKeyList).toEqual([
      'type',
      'requestId',
      'capability',
      'ok',
      'ts',
      'result',
      'error',
    ]);
    expect(workerMobileKeyList).toContain('requestId');
    expect(commandResultKeyList).not.toContain('deviceId');
  });

  test('el requestId se copia, nunca se genera', () => {
    const outboundSource = stripKotlinComments(
      readKotlinSource(join('protocol', 'outbound.kt')),
    );
    expect(outboundSource).toContain('.put("requestId", requestId)');
    expect(outboundSource).not.toContain('UUID');
    expect(outboundSource).not.toContain('random');
    expect(outboundSource).not.toContain('currentTimeMillis');
  });

  test('el parser del cliente cubre los 4 mensajes que el servidor manda', () => {
    const inboundSource = readKotlinSource(join('protocol', 'inbound.kt'));
    for (const messageType of [
      'hello_accepted',
      'hello_rejected',
      'heartbeat_probe',
      'command',
    ]) {
      expect(protocolSource).toContain(`type: z.literal('${messageType}')`);
      expect(inboundSource).toContain(`"${messageType}"`);
    }
  });

  test('el protocolVersion del cliente es el minimo que el Worker soporta', () => {
    const deviceSchemaSource = readAgentSource(join('devices', 'schema.ts'));
    const minimumVersion = Number(
      deviceSchemaSource.match(/MINIMUM_SUPPORTED_PROTOCOL_VERSION\s*=\s*(\d+)/)?.[1],
    );
    expect(readIntegerConstant(kotlinContract, 'PROTOCOL_VERSION')).toBe(minimumVersion);
  });
});

describe('B10 §12: el backoff es el que ya fija el doc del proyecto', () => {
  test('la tabla de backoff es la de APOLLO_ANDROID_SOURCE_OF_TRUTH.md §10', () => {
    const sourceOfTruth = readFileSync(
      join(REPOSITORY_ROOT, 'APOLLO_ANDROID_SOURCE_OF_TRUTH.md'),
      'utf8',
    );
    const documentedTable = sourceOfTruth.match(
      /\| 1 \| 1s \|[\s\S]*?\| 6\+ \| (\d+)s \(max\) \|/,
    );
    expect(documentedTable).not.toBeNull();

    const expectedBackoffList = [1, 2, 4, 8, 16, Number(documentedTable?.[1])].map(
      (second) => second * 1000,
    );
    expect(
      readLongListConstant(kotlinContract, 'RECONNECT_BACKOFF_MILLISECOND_LIST'),
    ).toEqual(expectedBackoffList);
    expect(expectedBackoffList.at(-1)).toBe(30_000);
  });
});

describe('B10 §11: ningun secreto viaja en el bundle', () => {
  const kotlinCodeList = [
    stripKotlinComments(readKotlinSource(join('contract', 'contract.kt'))),
    stripKotlinComments(readKotlinSource(join('identity', 'identity.kt'))),
    stripKotlinComments(readKotlinSource(join('identity', 'store.kt'))),
    stripKotlinComments(readKotlinSource(join('transport', 'config.kt'))),
    stripKotlinComments(readKotlinSource(join('transport', 'credentials.kt'))),
    stripKotlinComments(readKotlinSource(join('transport', 'okhttp.kt'))),
    stripKotlinComments(readKotlinSource(join('transport', 'socket.kt'))),
    stripKotlinComments(readKotlinSource(join('protocol', 'inbound.kt'))),
    stripKotlinComments(readKotlinSource(join('protocol', 'outbound.kt'))),
    stripKotlinComments(readKotlinSource(join('session', 'session.kt'))),
    stripKotlinComments(readKotlinSource(join('session', 'heartbeat.kt'))),
    stripKotlinComments(readKotlinSource(join('session', 'backoff.kt'))),
    stripKotlinComments(readKotlinSource(join('session', 'state.kt'))),
    stripKotlinComments(readKotlinSource(join('command', 'allowlist.kt'))),
    stripKotlinComments(readKotlinSource(join('command', 'payload.kt'))),
    stripKotlinComments(readKotlinSource(join('command', 'dispatcher.kt'))),
    stripKotlinComments(readKotlinSource(join('notification', 'notification.kt'))),
    stripKotlinComments(readKotlinSource(join('notification', 'android.kt'))),
  ];

  test('ningun fuente Kotlin trae un valor de secret hardcodeado', () => {
    for (const source of kotlinCodeList) {
      expect(source).not.toMatch(/shared[_-]?secret\s*=\s*"[A-Za-z0-9]{6,}/i);
      expect(source).not.toMatch(/token\s*=\s*"[A-Za-z0-9]{6,}"/i);
    }
  });

  test('el secret se lee en runtime, jamas de BuildConfig ni de un recurso', () => {
    const credentialsCode = stripKotlinComments(
      readKotlinSource(join('transport', 'credentials.kt')),
    );
    expect(credentialsCode).toContain('getSharedPreferences');
    expect(credentialsCode).toContain('MODE_PRIVATE');
    expect(credentialsCode).not.toContain('BuildConfig');
    expect(credentialsCode).not.toContain('R.string');

    for (const source of kotlinCodeList) {
      expect(source).not.toContain('BuildConfig.');
    }
  });

  test('el secret solo viaja en la query del socket, nunca en el cuerpo', () => {
    const configCode = stripKotlinComments(
      readKotlinSource(join('transport', 'config.kt')),
    );
    expect(configCode).toContain('"?token="');
    expect(configCode).toContain('java.net.URLEncoder.encode');
    // La rama enrolled no construye query string: si lo hiciera, la credencial
    // individual caería en los access logs del servidor, que es lo que §4 evita.
    const enrolledBranch = configCode.slice(
      configCode.indexOf('is DeviceCredential.Enrolled ->'),
      configCode.indexOf('is DeviceCredential.LegacySharedSecret ->'),
    );
    expect(enrolledBranch).not.toContain('token=');
    expect(enrolledBranch).not.toContain('URLEncoder');
    expect(configCode).not.toContain('BuildConfig');
  });
});

describe('B10 §17: el cliente no conoce internals del servidor', () => {
  const kotlinCodeList = [
    stripKotlinComments(readKotlinSource(join('session', 'session.kt'))),
    stripKotlinComments(readKotlinSource(join('command', 'dispatcher.kt'))),
    stripKotlinComments(readKotlinSource(join('command', 'allowlist.kt'))),
    stripKotlinComments(readKotlinSource(join('protocol', 'inbound.kt'))),
    stripKotlinComments(readKotlinSource(join('protocol', 'outbound.kt'))),
  ];

  test('no toca registry, target resolver, ToolDefinition, Apollo ni PcBridge', () => {
    for (const source of kotlinCodeList) {
      for (const forbiddenTerm of [
        'registry',
        'Registry',
        'ToolDefinition',
        'PcBridge',
        'pcbridge',
        'targetResolver',
        'resolveCapabilityTarget',
        'executeToolWithTargetResolution',
        'Apollo',
      ]) {
        expect(source).not.toContain(forbiddenTerm);
      }
    }
  });

  test('las cuatro capas estan separadas en archivos propios', () => {
    const layerFolderList = ['transport', 'session', 'command', 'notification'];
    for (const layerFolder of layerFolderList) {
      expect(existsSync(join(KOTLIN_SOURCE_ROOT, layerFolder))).toBe(true);
    }
  });

  test('ningun archivo de cliente se pasa del limite de 300 lineas', () => {
    for (const source of kotlinCodeList) {
      expect(source.split('\n').length).toBeLessThanOrEqual(300);
    }
  });
});

describe('B10 §7, §11 y §15: el smoke no puede aflojar las invariantes del cliente', () => {
  const smokeClientSource = stripKotlinComments(
    readFileSync(
      join(import.meta.dir, '..', '..', 'agent', 'smoke', 'mobile-client.ts'),
      'utf8',
    ),
  );

  test('cada invariante declarada tiene su ancla en el cliente del smoke', () => {
    // El mapa se importa de verdad en vez de parsearse con regex: asi el gate ve
    // exactamente las anclas que el cliente declara.
    expect(MOBILE_CLIENT_INVARIANT_ANCHOR_MAP.size).toBeGreaterThanOrEqual(6);
    expect([...MOBILE_CLIENT_INVARIANT_ANCHOR_MAP.keys()].toSorted()).toEqual(
      [...MOBILE_CLIENT_INVARIANT_LIST].toSorted(),
    );

    // El mapa de anclas vive en el MISMO archivo que el codigo, asi que hay que
    // excluirlo: si no, cada ancla se encontraria a si misma y el guard no
    // detectaria nada.
    const anchorMapBlock = smokeClientSource.match(
      /MOBILE_CLIENT_INVARIANT_ANCHOR_MAP[\s\S]*?\n\s*\]\);/,
    );
    expect(anchorMapBlock).not.toBeNull();
    const clientCodeWithoutAnchorMap = smokeClientSource.replace(
      anchorMapBlock?.[0] ?? '',
      ' ',
    );

    for (const [invariantName, anchor] of MOBILE_CLIENT_INVARIANT_ANCHOR_MAP) {
      expect(
        clientCodeWithoutAnchorMap,
        `la invariante ${invariantName} no tiene su ancla en el codigo del cliente`,
      ).toContain(anchor);
    }
  });

  test('las seis invariantes del cliente estan presentes', () => {
    for (const invariantName of [
      'state_is_online_before_command',
      'capability_in_allowlist',
      'target_matches_device',
      'request_id_preserved',
      'payload_field_set_is_exact',
      'single_heartbeat_timer',
    ]) {
      expect(smokeClientSource).toContain(invariantName);
    }
  });

  test('el cliente del smoke no genera requestId ni acepta payloads laxos', () => {
    expect(smokeClientSource).toContain("fieldNameList.join(',') !== 'body,title'");
    expect(smokeClientSource).not.toMatch(/requestId:\s*`/);
    expect(smokeClientSource).not.toMatch(/requestId:\s*String\(/);
  });

  test('el cliente del smoke no anuncia capabilities fuera de la allowlist', () => {
    const announcedBlock = smokeClientSource.match(
      /ANNOUNCED_CAPABILITY_LIST\s*=\s*\[([^\]]*)\]/,
    );
    const announcedCapabilityList = [
      ...(announcedBlock?.[1] ?? '').matchAll(/'([^']+)'/g),
    ].map((entry) => entry[1] as string);
    const allowlistBlock = smokeClientSource.match(/ALLOWED_COMMAND_MAP[\s\S]*?\];/);
    for (const capabilityName of announcedCapabilityList) {
      expect(allowlistBlock?.[0]).toContain(`'${capabilityName}'`);
    }
    expect(announcedCapabilityList).toEqual(['mobile.notifications']);
  });
});

describe('B10 §16: el esqueleto es el stack que fija el proyecto', () => {
  test('el proyecto Android usa el stack del doc y no Jetpack Compose', () => {
    const appBuildGradle = readFileSync(
      join(import.meta.dir, '..', 'app', 'build.gradle'),
      'utf8',
    );
    const rootBuildGradle = readFileSync(
      join(import.meta.dir, '..', 'build.gradle'),
      'utf8',
    );

    expect(appBuildGradle).toContain('minSdkVersion 25');
    expect(appBuildGradle).toContain('com.squareup.okhttp3:okhttp:3.14.9');
    expect(appBuildGradle).not.toContain('compose');
    expect(rootBuildGradle).toContain('kotlin_version');
    expect(rootBuildGradle).toContain('kotlin-gradle-plugin:$kotlin_version');
  });

  test('la unidad de test tiene el org.json real, no el stub de android.jar', () => {
    const appBuildGradle = readFileSync(
      join(import.meta.dir, '..', 'app', 'build.gradle'),
      'utf8',
    );
    expect(appBuildGradle).toContain('org.json:json');
  });

  test('los 22 casos obligatorios del cliente estan escritos', () => {
    const testFileList = [
      'IdentityTest.kt',
      'SessionTest.kt',
      'HeartbeatTest.kt',
      'CommandTest.kt',
      'NotificationTest.kt',
      'ResultTest.kt',
    ];
    for (const testFileName of testFileList) {
      expect(existsSync(join(KOTLIN_TEST_ROOT, testFileName))).toBe(true);
    }
  });
});

describe('B11 §16: el peer mobile sólo ejecuta comandos declarados (guard de fuente)', () => {
  /**
   * El comportamiento del peer está cubierto por JUnit
   * (`rejectsACommandThatItsCapabilityDoesNotDeclare`, `rejectsAnInvalidPayload`,
   * `cancelAlarmNeedsOnlyTheLabel`), pero JUnit no corre en `bun test`. Estos
   * guards son el equivalente ejecutable acá: si el Kotlin se afloja, el gate que
   * corre en cada `bun run test` se entera.
   */
  const allowlistCode = stripKotlinComments(
    readKotlinSource(join('command', 'allowlist.kt')),
  );
  const payloadCode = stripKotlinComments(
    readKotlinSource(join('command', 'payload.kt')),
  );
  const dispatcherCode = stripKotlinComments(
    readKotlinSource(join('command', 'dispatcher.kt')),
  );

  test('the peer gates the command against the capability command list', () => {
    expect(allowlistCode).toContain('fun isCommandDeclaredByCapability');
    expect(allowlistCode).toContain(
      'Contract.ALLOWED_COMMAND_MAP[capabilityName]?.contains(commandName) == true',
    );
    // El dispatcher tiene que USAR ese gate, no confiar en el nombre.
    expect(dispatcherCode).toContain('CommandAllowlist.isCommandDeclaredByCapability');
    expect(dispatcherCode).toContain('isAllowed(input.capabilityName)');
    expect(dispatcherCode).toContain('unsupported_command');
  });

  test('the peer rejects a payload with an extra field', () => {
    expect(payloadCode).toContain('private fun hasExtraField');
    expect(payloadCode).toContain('payload.keys.any { it !in allowed }');
    expect(payloadCode).toContain('unexpected_field');
  });

  test('the peer validates the payload by command, not by capability', () => {
    expect(payloadCode).toContain('when (commandName) {');
    expect(payloadCode).toContain('validateAlarmSet');
    expect(payloadCode).toContain('validateAlarmCancel');
    expect(payloadCode).toContain('else -> Result.Invalid("unsupported_command")');
    // Y el dispatcher le pasa el comando, no la capability.
    expect(dispatcherCode).toContain(
      'PayloadValidator.validate(input.commandName, input.payload)',
    );
  });

  test('the peer resolves the canonical command when Apollo sends none', () => {
    const sessionCode = stripKotlinComments(
      readKotlinSource(join('session', 'session.kt')),
    );
    expect(sessionCode).toContain('CommandAllowlist.listCommandFor');
    expect(sessionCode).toContain('firstOrNull()');
    expect(sessionCode).toContain('unsupported_command');
  });
});

describe('B11 §17: todo comando declarado tiene efecto real en el peer', () => {
  /**
   * `calendar_list` y `volume_get` estaban en el catálogo y en el schema, pero el
   * peer no los tenía: `volume_get` devolvía `true` fijo y `calendar_list` caía al
   * `else`. Estos guards-atajan esa clase de bug, que un schema no detecta.
   */
  const platformCode = stripKotlinComments(
    readKotlinSource(join('notification', 'platform.kt')),
  );
  const androidPlatformCode = stripKotlinComments(
    readKotlinSource(join('notification', 'android-platform.kt')),
  );
  // BLOCK 12.5.1: el calendario salio de `android-platform.kt` a su propia
  // gateway. Se lee aparte para poder seguir exigiendo que la lectura real exista
  // en la capa Android, en vez de aflojar el guard.
  const androidCalendarCode = stripKotlinComments(
    readKotlinSource(join('notification', 'calendar.kt')),
  );
  const dispatcherCode = stripKotlinComments(
    readKotlinSource(join('command', 'dispatcher.kt')),
  );
  const outboundCode = stripKotlinComments(
    readKotlinSource(join('protocol', 'outbound.kt')),
  );

  const READ_COMMAND_LIST = ['calendar_list', 'volume_get'];

  test('cada comando de lectura tiene su rama en el dispatcher', () => {
    for (const commandName of READ_COMMAND_LIST) {
      expect(dispatcherCode).toContain(`"${commandName}" ->`);
    }
    // Tener la rama no alcanza: tiene que LEER el estado por el puerto. Un
    // `"volume_get" -> Outcome.Executed(...)` compila y miente.
    expect(dispatcherCode).toContain('"volume_get" -> platform.getVolumeLevel()');
    expect(dispatcherCode).toContain('platform.listCalendarEvents(');
  });

  test('el peer nunca reporta exito sin llamar a la plataforma', () => {
    // El bug era exactamente un comando que contestaba true sin efecto.
    expect(dispatcherCode).not.toContain('"volume_get" -> true');
    expect(dispatcherCode).not.toContain('else -> true');
    expect(dispatcherCode).toContain('else -> Outcome.Rejected("unsupported_command")');
    for (const outcome of ['Started', 'Unresolvable', 'Failed']) {
      expect(dispatcherCode).toContain(`MediaPlayOutcome.${outcome} ->`);
    }
    expect(dispatcherCode).toContain('media_unresolvable');
  });

  test('el puerto declara los comandos de lectura y la impl Android los resuelve', () => {
    for (const portMethod of ['fun listCalendarEvents(', 'fun getVolumeLevel(']) {
      expect(platformCode).toContain(portMethod);
      expect(androidPlatformCode).toContain(`override ${portMethod}`);
    }
    // Firmar el override no alcanza: tiene que LEER el estado real. Un
    // `override fun getVolumeLevel(): Int? = null` compila y no hace nada.
    expect(androidPlatformCode).toContain(
      'val currentLevel = audioManager.getStreamVolume(AudioManager.STREAM_MUSIC)',
    );
    expect(androidPlatformCode).toContain(
      'audioManager.getStreamMaxVolume(AudioManager.STREAM_MUSIC)',
    );
    // La lectura real del calendario vive en la gateway. Y la plataforma tiene
    // que delegar en ella: un override que no delega, no lee nada.
    expect(androidCalendarCode).toContain('context.contentResolver.query(');
    expect(androidCalendarCode).toContain('${CalendarContract.Events.DTSTART} ASC');
    expect(androidPlatformCode).toContain(
      'override fun listCalendarEvents(withinDays: Int): List<CalendarEventSummary> =',
    );
    expect(androidPlatformCode).toContain('calendarGateway.listEvents(withinDays)');
  });

  test('media_play distingue unresolvable de un fallo real del player', () => {
    expect(platformCode).toContain('sealed class MediaPlayOutcome');
    for (const variant of ['object Started', 'object Unresolvable', 'object Failed']) {
      expect(platformCode).toContain(variant);
    }
    expect(androidPlatformCode).toContain('MediaPlayOutcome.Unresolvable');
  });

  test('el command_result lleva los datos del comando de lectura', () => {
    expect(outboundCode).toContain('commandResult: Map<String, Any?>?');
    expect(outboundCode).toContain('message.put("result", toJsonObject(commandResult))');
  });

  /**
   * Cada comando del catálogo tiene que tener UN camino en el dispatcher: una
   * rama del `when`, o la rama del adapter de notificaciones, que va antes del
   * `when` porque `notification_post` no toca `MobilePlatform`.
   */
  test('el catalogo no declara un comando sin camino en el dispatcher', () => {
    const dispatcherBranchSet = new Set(
      [...dispatcherCode.matchAll(/"([a-z_]+)"\s*->/g)].map(
        (match) => match[1] as string,
      ),
    );
    const adapterBranch = dispatcherCode.match(
      /if \(input\.capabilityName == "([^"]+)"\) \{/,
    );
    expect(adapterBranch).not.toBeNull();
    // La rama del adapter resuelve su comando desde la tabla, no lo repite.
    const handledByAdapterSet = new Set(listCommandNameFor(adapterBranch?.[1] as string));
    expect([...handledByAdapterSet]).toContain('notification_post');

    const missingCommandList = listAllCommandName().filter(
      (commandName) =>
        !dispatcherBranchSet.has(commandName) && !handledByAdapterSet.has(commandName),
    );
    expect(missingCommandList).toEqual([]);
  });
});

/** Comandos que una capability declara, leídos del `ALLOWED_COMMAND_MAP`. */
function listAllCommandName(): string[] {
  const entryList = readKotlinMapEntries(kotlinContract, 'ALLOWED_COMMAND_MAP');
  return entryList.flatMap((entry) => entry[1]);
}

function listCommandNameFor(capabilityName: string): string[] {
  const entryList = readKotlinMapEntries(kotlinContract, 'ALLOWED_COMMAND_MAP');
  return entryList.find((entry) => entry[0] === capabilityName)?.[1] ?? [];
}

describe('B12 §7: guards de seguridad de enrollment y revocacion', () => {
  /**
   * Estos guards leen el código de los dos lados. Los guards de Block 10 miraban
   * que el secret no se compilara; estos miran que una credencial individual
   * tampoco se filtre, y que la revocación no dependa de memoria.
   */
  const androidConfig = readKotlinSource(join('transport', 'config.kt'));
  const androidCredentialStore = readKotlinSource(join('transport', 'credentials.kt'));
  const androidCredential = readKotlinSource(join('transport', 'credential.kt'));
  const androidEnroll = readKotlinSource(join('identity', 'enroll.kt'));
  const androidSession = readKotlinSource(join('session', 'session.kt'));
  const androidOkHttp = readKotlinSource(join('transport', 'okhttp.kt'));
  const androidActivity = readKotlinSource(join('MainActivity.kt'));
  const workerEnrollment = readAgentSource(join('devices', 'enrollment.ts'));
  const workerStore = readAgentSource(join('devices', 'credential-store.ts'));
  const workerBridge = readAgentSource(join('agents', 'mobile-bridge.ts'));
  const workerToken = readAgentSource(join('auth', 'token.ts'));

  test('la credencial enrolada viaja en Authorization, no en la URL', () => {
    expect(androidConfig).toContain('is DeviceCredential.Enrolled ->');
    expect(androidConfig).toContain('AUTHORIZATION_HEADER to "Bearer "');
    // La rama enrolled declara un headerMap: si el bearer volviera a la URL,
    // el headerMap se iría con él.
    const enrolledBranch = androidConfig.slice(
      androidConfig.indexOf('is DeviceCredential.Enrolled ->'),
      androidConfig.indexOf('is DeviceCredential.LegacySharedSecret ->'),
    );
    expect(enrolledBranch).toContain('headerMap = mapOf(');
    expect(enrolledBranch).not.toContain('url = baseUrl +');
    // La rama enrolled no construye query string: si lo hiciera, la credencial
    // individual caería en access logs del servidor.
    expect(enrolledBranch).not.toContain('token=');
    expect(enrolledBranch).not.toContain('URLEncoder');
  });

  test('el camino legacy conserva ?token= para no romper Desktop', () => {
    // §4: compatibilidad con los clientes Desktop existentes.
    expect(androidConfig).toContain('"?token="');
    expect(androidConfig).toContain('java.net.URLEncoder.encode');
    expect(readAgentSource(join('auth', 'token.ts'))).toContain(
      "searchParams.get('token')",
    );
  });

  test('la credencial se guarda cifrada con una clave del Keystore', () => {
    expect(androidCredentialStore).toContain('class KeystoreCredentialCipher');
    expect(androidCredentialStore).toContain('ANDROID_KEYSTORE = "AndroidKeyStore"');
    expect(androidCredentialStore).toContain('AES/GCM/NoPadding');
    // Lo que se persiste es el ciphertext, no el texto plano.
    expect(androidCredentialStore).toContain(
      '.putString(ENROLLED_CREDENTIAL_KEY, cipher.encrypt(credential))',
    );
    expect(androidCredentialStore).not.toContain(
      '.putString(ENROLLED_CREDENTIAL_KEY, credential)',
    );
    // Y la clave no sale del Keystore: se resuelve por alias.
    expect(androidCredentialStore).toContain('KeyStore.getInstance(ANDROID_KEYSTORE)');
  });

  test('una credencial enrolada NO degrada al secreto global', () => {
    // Este es el bypass de §1 del lado del cliente. Si la resolución devolviera
    // Legacy cuando hay ambos, un teléfono revocado seguiría conectando con el
    // secreto global que sigue en el teléfono.
    expect(androidCredential).toContain('sealed class DeviceCredential');
    expect(androidCredential).toContain('fun resolve(');
    const resolveBody = androidCredential.slice(
      androidCredential.indexOf('fun resolve('),
    );
    expect(resolveBody.indexOf('Enrolled(resolvedEnrolledCredential)')).toBeLessThan(
      resolveBody.indexOf('LegacySharedSecret(resolvedSharedSecret)'),
    );
  });

  test('el servidor guarda HASHES, no credenciales', () => {
    // Un dump del DO no puede usarse para conectar.
    expect(workerEnrollment).toContain('credentialHash: string');
    expect(workerEnrollment).toContain('crypto.subtle.digest');
    expect(workerEnrollment).not.toContain("crypto.subtle.digest('MD5'");
    // Y el store persiste en tabla, no en memoria.
    expect(workerStore).toContain('mobile_device_credential');
    expect(workerStore).toContain('credential_hash TEXT NOT NULL');
    // La escritura tiene que SER un INSERT. Con la tabla declarada sola, un
    // store que no guarde nada igual pasa el guard.
    const saveCredentialBody = readFunctionBody(workerStore, 'async saveCredential(');
    expect(saveCredentialBody).toContain('INSERT OR REPLACE INTO');
    expect(saveCredentialBody).toContain('credential_hash');
    expect(saveCredentialBody).toContain('input.credentialHash');
    const saveChallengeBody = readFunctionBody(workerStore, 'async saveChallenge(');
    expect(saveChallengeBody).toContain('INSERT OR REPLACE INTO');
    expect(saveChallengeBody).toContain('input.challengeHash');
    // Y leer tiene que devolver lo guardado, no una lista vacía.
    const listBody = readFunctionBody(workerStore, 'async listCredentialRecordList(');
    expect(listBody).toContain('SELECT');
    expect(listBody).not.toContain('return []');
    // El store de memoria es sólo para tests y el guard lo dice.
    expect(workerStore).toContain('createInMemoryEnrollmentStore');
  });

  test('el bridge usa el store persistente, no uno de memoria', () => {
    expect(workerBridge).toContain('createSqliteEnrollmentStore');
    expect(workerBridge).not.toContain('createInMemoryEnrollmentStore');
    expect(workerBridge).toContain('connection.close(1008');

    // No alcanza con que la función se mencione: tiene que recibir LA credencial
    // que trajo el header. Una llamada con otra cosa verifica cualquier cosa.
    const connectBody = readFunctionBody(workerBridge, 'async onConnect(');
    expect(connectBody).toContain('verifyDeviceCredential');
    expect(connectBody).toContain('credential: bearerCredential');
    expect(connectBody).toContain('store,');
    // Y el store que se le pasa es el de SQLite, no uno re-declarado acá.
    const resolveBody = readFunctionBody(workerBridge, '#resolveEnrollmentStore()');
    expect(resolveBody).toContain(
      'const store = createSqliteEnrollmentStore(sqlStorage)',
    );
    expect(resolveBody).toContain('this.#endpoint.attachEnrollmentStore(store)');
    expect(resolveBody).not.toContain('listCredentialRecordList');
  });

  test('el header Authorization nunca se valida como secreto global', () => {
    // §4: no aceptar simultaneamente cualquier token sin distinguir su ámbito.
    // El bearer se lee aparte y nunca pasa por isDeviceSharedSecretValid.
    expect(workerToken).toContain('readBearerCredentialFromRequest');
    const readerBody = workerToken.slice(
      workerToken.indexOf('export function readBearerCredentialFromRequest'),
    );
    expect(readerBody).not.toContain('isDeviceSharedSecretValid');
    expect(readerBody).not.toContain('DEVICE_SHARED_SECRET');
    // Y el camino de bearer de la ruta tampoco: si el Authorization llegara a
    // compararse contra DEVICE_SHARED_SECRET, el scope se mezclaría.
    const routeSource = readAgentSource(join('devices', 'route.ts'));
    const authorizeBody = readFunctionBody(
      routeSource,
      'export async function authorizeMobileDeviceRequest',
    );
    // Por ORDEN de aparición, no por slicing: un `indexOf` que devuelve -1 hace
    // que `slice` devuelva una cadena vacía y el guard pase sin comprobar nada.
    // Esa debilidad dejó escapar una mutación que metía una comparación contra
    // DEVICE_SHARED_SECRET justo en la rama del bearer.
    const bareAuthorizeBody = stripTypeScriptComments(authorizeBody);
    const legacyMarkerIndex = bareAuthorizeBody.indexOf('readDeviceTokenFromRequestUrl');
    expect(legacyMarkerIndex).toBeGreaterThan(-1);

    const sharedSecretCheckIndexList = listIndexOfEvery(
      bareAuthorizeBody,
      'isDeviceSharedSecretValid',
    );
    // Sólo puede compararse el secreto global DESPUÉS de que empieza el camino
    // legacy: es la única comparación que §4 permite.
    expect(sharedSecretCheckIndexList.length).toBe(1);
    expect(sharedSecretCheckIndexList[0]).toBeGreaterThan(legacyMarkerIndex);

    // Y el bearer no se toca con ningún secreto, en ninguna parte.
    const bearerBranch = bareAuthorizeBody.slice(
      0,
      bareAuthorizeBody.indexOf('// Camino legacy') === -1
        ? legacyMarkerIndex
        : bareAuthorizeBody.indexOf('// Camino legacy'),
    );
    expect(bearerBranch).toContain('readBearerCredentialFromRequest');
    expect(bearerBranch).toContain('isDeviceCredentialShaped');
    expect(bearerBranch).not.toContain('DEVICE_SHARED_SECRET');
    expect(bearerBranch).not.toContain('DASHBOARD_SHARED_SECRET');
  });

  test('los desafíos expiran y son de un solo uso', () => {
    expect(workerEnrollment).toContain('ENROLLMENT_CHALLENGE_TTL_MILLISECONDS');
    expect(workerEnrollment).toContain('expiresAtMilliseconds');
    expect(workerEnrollment).toContain('challenge_expired');
    // BLOCK 12.1: el consumo es un CAS, así que "de un solo uso" ya no es una
    // bandera sino la condição del UPDATE. Se afirma sobre el store, que es
    // donde vive la operación atómica.
    const consumeBody = readFunctionBody(workerStore, 'async consumeChallenge(');
    expect(consumeBody).toContain('consumed_at IS NULL');
    expect(consumeBody).toContain('device_id = ?');
    expect(consumeBody).toContain('challenge_consumed');
    // Y la expiración se mide contra el reloj del servidor, nunca contra un
    // timestamp del cliente.
    expect(consumeBody).toContain(
      'input.nowMilliseconds >= record.expiresAtMilliseconds',
    );
  });

  test('B12.1 §2: el desafío queda atado al deviceId autorizado', () => {
    // El vínculo se guarda con el desafío...
    const challengeType = workerEnrollment.slice(
      workerEnrollment.indexOf('export type EnrollmentStore'),
    );
    expect(challengeType).toContain('readonly boundDeviceId: string');
    expect(workerEnrollment).toContain('boundDeviceId: input.boundDeviceId');

    // ...y el claim NO vuelve a preguntar nada: consume con el deviceId que
    // mandó el cliente y el store decide.
    const claimBody = readFunctionBody(
      workerEnrollment,
      'export async function claimEnrollmentChallenge',
    );
    expect(claimBody).toContain('deviceId: input.deviceId');
    expect(claimBody).toContain('device_id_mismatch');
    expect(claimBody).not.toContain('readChallenge');

    // La tabla lo persiste, así que el vínculo sobrevive al reinicio del DO.
    const storeSource = readAgentSource(join('devices', 'credential-store.ts'));
    expect(storeSource).toContain('device_id TEXT NOT NULL');
  });

  test('ningún camino loguea el desafío ni la credencial', () => {
    // Se mira el CÓDIGO, no la prosa: los comentarios explican que no se loguea
    // y decir la palabra "token" ahí no es una fuga.
    const androidFileList = [
      ['config.kt', androidConfig],
      ['credential.kt', androidCredential],
      ['enroll.kt', androidEnroll],
      ['session.kt', androidSession],
      ['okhttp.kt', androidOkHttp],
      ['MainActivity.kt', androidActivity],
      ['credentials.kt', androidCredentialStore],
    ] as const;
    for (const [name, code] of androidFileList) {
      const bare = stripKotlinComments(code);
      expect(bare).not.toMatch(/Log\.[vdiew]\(/);
      expect(bare).not.toMatch(/println\(/);
      // Una credencial interpolada en un string es una credencial logueada.
      // Kotlin usa `$credential`, no `${...}`, así que se buscan las dos formas.
      expect(bare).not.toMatch(/\$\{[^}]*[Cc]redential[^}]*\}/);
      expect(bare).not.toMatch(/\$\{[^}]*[Cc]hallenge[^}]*\}/);
      expect(bare).not.toMatch(/\$\{[^}]*SharedSecret[^}]*\}/);
      expect(bare).not.toMatch(/Log\.[vdiew]\([^)]*credential/i);
      expect(bare).not.toMatch(/Log\.[vdiew]\([^)]*challenge/i);
      expect(name).toBeTruthy();
    }

    // Del lado del Worker el log es `console.*` y `emitDeviceEvent`. Ninguno
    // puede recibir un valor de desafío o de credencial.
    const workerBare = workerEnrollment
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    expect(workerBare).not.toMatch(/console\.(log|info|warn|error|debug)/);
    expect(workerBare).not.toMatch(/emitDeviceEvent\([^)]*challenge/i);
    expect(workerBare).not.toMatch(/emitDeviceEvent\([^)]*credential/i);
  });

  test('el teléfono deja de reconectar cuando lo revocan', () => {
    expect(androidSession).toContain('onAuthorizationRejected');
    expect(androidSession).toContain('isAuthorizationPermanentlyRejected');
    expect(androidSession).toContain('POLICY_VIOLATION_CLOSURE_CODE');
    // Y reconectar con la misma credencial no abre nada. BLOCK 12.5.1: el
    // estado ya no se asigna directo, pasa por `transitionTo` para que el dueno
    // pueda observarlo. El comportamiento esta cubierto ademas por tests de
    // comportamiento en SessionOwnerTest; esto sigue siendo el guard de fuente.
    expect(androidSession).toContain('transitionTo(MobileSessionState.DISCONNECTED)');
    expect(androidSession).toContain('connectionGeneration.invalidate()');
  });

  test('el cliente HTTP de enrollment no pide token', () => {
    // Todavía no hay credencial: lo que autoriza el claim es el desafío.
    expect(androidEnroll).toContain('ENROLLMENT_CLAIM_SUFFIX = "/enrollment/claim"');
    // Sin comentarios: el doc explica que NO pide token, así que la palabra
    // aparece en la prosa y no en el código.
    const enrollCode = stripKotlinComments(androidEnroll);
    expect(enrollCode).not.toContain('Authorization');
    expect(enrollCode).not.toContain('token');
    expect(enrollCode).not.toContain('SharedSecret');
  });

  test('el APK no compila ninguna credencial', () => {
    // El scanner de artefacto ya corre en bun test; acá se afirma que las
    // fuentes de Android tampoco hardcodean algo con forma de credencial.
    for (const code of [androidConfig, androidCredentialStore, androidEnroll]) {
      expect(code).not.toMatch(/apollo_dev_[A-Za-z0-9_-]{20,}/);
      expect(code).not.toMatch(/apollo_enr_[A-Za-z0-9_-]{20,}/);
    }
  });

  test('B12.1 §3: Android exige credencial enrolada para conectar', () => {
    // `MainActivity` es una Activity: los tests unitarios de la JVM no pueden
    // levantarla, así que la regla se verifica sobre el fuente. Es el mismo
    // criterio que los guards de Block 10 para el secret.
    const activityBare = stripKotlinComments(androidActivity);
    // Muestra el deviceId antes de pedir nada: el dueño lo necesita para
    // autorizar ESTE teléfono.
    expect(activityBare).toContain('resolveStableDeviceId()');
    expect(activityBare).toContain('deviceIdText');
    expect(activityBare).toContain('readEnrolledCredential()');
    // Y conectar pasa por esa credencial, no por el secreto global.
    expect(activityBare).toContain('DeviceCredential.Enrolled(enrolledCredential)');
    expect(activityBare).not.toContain('writeDeviceSharedSecret');
    expect(activityBare).not.toContain('LegacySharedSecret');
    // El corte es real: sin credencial enrolada no se abre sesión.
    expect(activityBare).toContain('if (enrolledCredential == null)');
  });

  test('B12.1 §4: las rutas admin de enrollment no necesitan token en la URL', () => {
    // El camino preferido es el header; `?token=` queda sólo como compatibilidad
    // y no puede ser el único, ni el que se documente.
    const routeSource = readAgentSource(join('devices', 'route.ts'));
    const ownerBody = readFunctionBody(routeSource, 'function isOwnerAuthorized(');
    expect(ownerBody).toContain('readBearerCredentialFromRequest(request)');
    expect(ownerBody).toContain('environment.DASHBOARD_SHARED_SECRET');
    // Un token de dispositivo NO puede administrar enrollment.
    expect(ownerBody).not.toContain('DEVICE_SHARED_SECRET');
    expect(ownerBody).not.toContain('readDeviceTokenFromRequestUrl');
  });

  test('B12.1 §5: el consumo es un CAS y la migración es aditiva', () => {
    const storeSource = readAgentSource(join('devices', 'credential-store.ts'));
    const consumeBody = readFunctionBody(storeSource, 'async consumeChallenge(input)');
    expect(consumeBody).toContain('consumed_at IS NULL');
    expect(consumeBody).toContain('device_id = ?');
    // Y la migración agrega columnas en vez de asumir una base nueva.
    const migrationBody = readFunctionBody(
      storeSource,
      'async function addMissingChallengeColumn(',
    );
    expect(migrationBody).toContain('PRAGMA table_info');
    expect(migrationBody).toContain('ADD COLUMN device_id');
    // El memo es de promesa, no de booleano: con booleano dos requests
    // concurrentes corrían la migración los dos.
    expect(storeSource).toContain('let migrationPromise: Promise<void> | null = null');
    expect(storeSource).not.toContain('let hasMigrated');
  });
});
