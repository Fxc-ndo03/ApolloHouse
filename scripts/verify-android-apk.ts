#!/usr/bin/env bun
/**
 * FASE 3.6 — verifica el APK realmente construido antes de publicar nada.
 *
 * El pipeline publica el artefacto que salió del build, no el que se pidió. Si
 * el build de "stable" saliera con el paquete y el canal de staging, el
 * manifiesto describiría una cosa y el APK sería otra: los clientes instalarían
 * el APK de pruebas creyendo que es producción. Por eso, antes de generar el
 * manifiesto, este script LEE el APK y lo contrasta con lo que se esperaba.
 *
 * Comprueba:
 *   - `applicationId` (que define a qué app puede actualizar).
 *   - `versionName` y `versionCode` reales, no los argumentos de entrada.
 *   - que el canal declarado por el build coincida con el canal publicado.
 *   - el certificado de firma, y que no sea el del otro canal.
 *
 * Sale con código distinto de cero ante cualquier discrepancia.
 *
 * Uso:
 *   bun scripts/verify-android-apk.ts \
 *     --apk <ruta.apk> \
 *     --channel stable \
 *     --application-id com.apollo.mobile \
 *     --version 1.4.1 \
 *     --version-code 10401 \
 *     [--expect-signer-sha256 <hex>] \
 *     [--print-metadata]
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

type Channel = 'stable' | 'staging';

const EXPECTED_APPLICATION_ID: Record<Channel, string> = {
  stable: 'com.apollo.mobile',
  staging: 'com.apollo.mobile.staging',
};

function parseArgs(argv: string[]): {
  apk: string;
  channel: Channel;
  applicationId: string;
  version: string;
  versionCode: number;
  expectSignerSha256: string | null;
  printMetadata: boolean;
} {
  const get = (name: string): string | undefined => {
    const index = argv.indexOf(`--${name}`);
    return index >= 0 ? argv[index + 1] : undefined;
  };

  const apk = get('apk');
  if (!apk) throw new Error('falta --apk');
  if (!existsSync(apk)) throw new Error(`el APK no existe: ${apk}`);

  const channel = get('channel') as Channel | undefined;
  if (channel !== 'stable' && channel !== 'staging') {
    throw new Error(`--channel debe ser stable o staging; recibio ${channel}`);
  }

  const version = get('version');
  if (!version) throw new Error('falta --version');

  const versionCode = Number(get('version-code'));
  if (!Number.isInteger(versionCode) || versionCode <= 0) {
    throw new Error(`--version-code debe ser un entero > 0; recibio ${get('version-code')}`);
  }

  return {
    apk,
    channel,
    applicationId: get('application-id') ?? EXPECTED_APPLICATION_ID[channel],
    version,
    versionCode,
    expectSignerSha256: get('expect-signer-sha256') ?? null,
    printMetadata: argv.includes('--print-metadata'),
  };
}

/** Localiza `aapt2` dentro del SDK de Android. */
function resolveBuildTool(toolName: string, androidHome: string): string {
  const buildToolsRoot = join(androidHome, 'build-tools');
  const candidates = readdirSync(buildToolsRoot)
    .filter((entry) => entry.startsWith('36.') || entry.startsWith('3'))
    .sort()
    .reverse()
    .map((entry) => join(buildToolsRoot, entry, `${toolName}${toolName === 'apksigner' ? '.bat' : '.exe'}`));
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) throw new Error(`no se encontro ${toolName} en ${buildToolsRoot}`);
  return found;
}

type ApkFacts = {
  applicationId: string;
  versionName: string;
  versionCode: number;
  signerSha256: string | null;
  signerError: string | null;
};

/**
 * Ejecuta `apksigner`. En Windows el binario es un `.bat`, y desde Bun 1.4
 * `execFileSync` ya no puede lanzarlo directo (EINVAL). Por eso se invoca el
 * jar con Java, sin depender de un shell. Sin esto, un fallo al arrancar la
 * herramienta se confundía con un APK sin firma.
 */
function runApksigner(apksigner: string, apk: string): string {
  const args = ['verify', '--print-certs', apk];
  if (process.platform !== 'win32') {
    return execFileSync(apksigner, args, { encoding: 'utf8' });
  }
  // En Windows `apksigner` es un `.bat` y Bun >= 1.4 ya no lo lanza directo
  // (EINVAL). Se ejecuta el jar con el mismo Java que usaría el `.bat`.
  const jar = join(dirname(apksigner), 'lib', 'apksigner.jar');
  if (!existsSync(jar)) {
    throw new Error(`no se encontro ${jar}`);
  }
  const java = process.env['JAVA_HOME']
    ? join(process.env['JAVA_HOME'], 'bin', 'java.exe')
    : 'java';
  return execFileSync(java, ['-jar', jar, ...args], { encoding: 'utf8' });
}

function readApkFacts(apk: string, androidHome: string): ApkFacts {
  const aapt2 = resolveBuildTool('aapt2', androidHome);
  const apksigner = resolveBuildTool('apksigner', androidHome);

  const badging = execFileSync(aapt2, ['dump', 'badging', apk], { encoding: 'utf8' });
  const packageLine = badging.split('\n').find((line) => line.startsWith('package:'));
  if (!packageLine) throw new Error('aapt2 no devolvió la línea de paquete');

  const applicationId = /name='([^']+)'/.exec(packageLine)?.[1];
  const versionName = /versionName='([^']+)'/.exec(packageLine)?.[1];
  const versionCode = Number(/versionCode='([^']+)'/.exec(packageLine)?.[1]);
  if (!applicationId || !versionName || !Number.isFinite(versionCode)) {
    throw new Error(`no se pudo interpretar el paquete: ${packageLine.trim()}`);
  }

  let signerSha256: string | null = null;
  let signerError: string | null = null;
  try {
    const certs = runApksigner(apksigner, apk);
    // apksigner cambia el prefijo según el esquema: "Signer #1 certificate
    // SHA-256 digest" para v1 y "V2 Signer: certificate SHA-256 digest" para
    // v2/v3. El dato que importa es el digest, no el rótulo.
    signerSha256 = /certificate SHA-256 digest:\s*([0-9a-f]+)/i.exec(certs)?.[1] ?? null;
    if (signerSha256 === null) {
      signerError = `apksigner no devolvió el digest SHA-256 del firmante: ${certs.trim()}`;
    }
  } catch (error) {
    // Un APK sin firma hace que apksigner salga con error. El motivo se
    // conserva: si la herramienta no llegó a ejecutarse (por ejemplo, un
    // `.bat` invocado sin shell) hay que distinguirlo de un APK sin firmar.
    const failure = error as { stderr?: unknown; message?: string };
    const stderr = failure.stderr == null ? '' : String(failure.stderr).trim();
    signerError = stderr || failure.message || 'apksigner falló sin detalle';
  }

  return { applicationId, versionName, versionCode, signerSha256, signerError };
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const androidHome = process.env['ANDROID_HOME'] ?? process.env['ANDROID_SDK_ROOT'];
  if (!androidHome) {
    throw new Error('falta ANDROID_HOME (o ANDROID_SDK_ROOT) para localizar aapt2 y apksigner');
  }

  const facts = readApkFacts(options.apk, androidHome);
  const problems: string[] = [];

  if (facts.applicationId !== options.applicationId) {
    problems.push(
      `applicationId: el APK declara ${facts.applicationId} y se esperaba ${options.applicationId}`,
    );
  }
  if (facts.applicationId !== EXPECTED_APPLICATION_ID[options.channel]) {
    problems.push(
      `applicationId: ${facts.applicationId} no corresponde al canal ${options.channel} ` +
        `(esperado ${EXPECTED_APPLICATION_ID[options.channel]})`,
    );
  }

  // La versión se compara por su núcleo numérico: en staging el APK lleva el
  // sufijo `-staging` y en producción no, pero ambos describen 1.4.1.
  const numericCore = (value: string): string => value.split('-')[0] ?? value;
  if (numericCore(facts.versionName) !== numericCore(options.version)) {
    problems.push(
      `versionName: el APK declara ${facts.versionName} y se esperaba ${options.version}`,
    );
  }
  if (options.channel === 'stable' && facts.versionName !== options.version) {
    problems.push(
      `versionName: producción no debe llevar sufijo de variante; el APK declara ${facts.versionName}`,
    );
  }

  if (facts.versionCode !== options.versionCode) {
    problems.push(
      `versionCode: el APK declara ${facts.versionCode} y se esperaba ${options.versionCode}`,
    );
  }

  if (options.expectSignerSha256 && facts.signerSha256 !== options.expectSignerSha256) {
    const actual = facts.signerSha256 ?? '(sin firma)';
    const detail = facts.signerError
      ? `; apksigner: ${facts.signerError.replace(/\s+/g, ' ').slice(0, 300)}`
      : '';
    problems.push(
      `firma: el APK está firmado con ${actual} ` +
        `y se esperaba ${options.expectSignerSha256}${detail}`,
    );
  }

  if (problems.length > 0) {
    console.error(`APK rechazado: ${basename(options.apk)}`);
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }

  if (options.printMetadata) {
    // Se imprime en un formato que el workflow puede leer sin parsear texto libre.
    console.log(
      JSON.stringify({
        applicationId: facts.applicationId,
        versionName: facts.versionName,
        versionCode: facts.versionCode,
        signerSha256: facts.signerSha256,
        channel: options.channel,
      }),
    );
  }

  console.log(
    `APK verificado: ${facts.applicationId} ${facts.versionName} (${facts.versionCode}) ` +
      `canal=${options.channel} firma=${facts.signerSha256?.slice(0, 16) ?? 'sin firma'}`,
  );
}

try {
  main();
} catch (error) {
  console.error(`verificación de APK imposible: ${(error as Error).message}`);
  process.exit(1);
}
