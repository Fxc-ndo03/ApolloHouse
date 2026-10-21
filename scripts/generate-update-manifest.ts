#!/usr/bin/env bun
/**
 * FASE 3.1 — genera el manifiesto de actualización desde los artefactos REALES.
 *
 * Nada se escribe a mano: versión, tamaño, SHA-256 y firma salen de los
 * archivos que se acaban de compilar y de la firma que Tauri acaba de hacer.
 * Escribir un hash a mano es exactamente cómo un updater termina sirviendo un
 * artefacto que no corresponde con lo que se probó.
 *
 * Uso:
 *   bun scripts/generate-update-manifest.ts \
 *     --channel stable \
 *     --version 1.4.0 \
 *     --android-version-code 140 \
 *     --min-sdk 33 \
 *     --windows-setup target/release/bundle/nsis/Apollo_Desktop_1.4.0_x64-setup.exe \
 *     --android-apk app/build/outputs/apk/release/app-release.apk \
 *     --min-client-version-code 130
 *
 * Imprime `latest.json` (canal estable) o `android.json` + `latest.json`
 * (staging). Sale por stdout para que el workflow lo adjunte a la release.
 */

import { createHash } from 'node:crypto';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';

type Channel = 'stable' | 'staging';

type Options = {
  channel: Channel;
  version: string;
  androidVersionCode: number;
  windowsSetup?: string;
  androidApk?: string;
  minClientVersionCode: number;
  minSdkInt: number;
  repo: string;
  notes: string;
  outLatest: string;
  outAndroid: string;
};

function parseArgs(argv: string[]): Options {
  const get = (name: string): string | undefined => {
    const index = argv.indexOf(`--${name}`);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const channel = (get('channel') ?? 'stable') as Channel;
  if (channel !== 'stable' && channel !== 'staging') {
    throw new Error(`canal invalido: ${channel}. Use stable o staging.`);
  }
  const version = get('version');
  if (!version) throw new Error('falta --version');
  const androidVersionCode = Number(get('android-version-code') ?? '0');
  if (!Number.isFinite(androidVersionCode) || androidVersionCode <= 0) {
    throw new Error('falta --android-version-code con un entero > 0');
  }
  const minSdkInt = Number(get('min-sdk') ?? '33');
  if (!Number.isInteger(minSdkInt) || minSdkInt < 1) {
    throw new Error('--min-sdk debe ser un entero positivo');
  }
  return {
    channel,
    version,
    androidVersionCode,
    windowsSetup: get('windows-setup'),
    androidApk: get('android-apk'),
    minClientVersionCode: Number(get('min-client-version-code') ?? '0'),
    minSdkInt,
    repo: get('repo') ?? 'Fxc-ndo03/ApolloHouse',
    notes: get('notes') ?? '',
    outLatest: get('out-latest') ?? 'latest.json',
    outAndroid: get('out-android') ?? 'android.json',
  };
}

function sha256Of(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));

  const platforms: Record<string, unknown> = {};
  if (options.windowsSetup) {
    platforms['windows-x86_64'] = {
      signature: readFileSync(`${options.windowsSetup}.sig`, 'utf8').trim(),
      url: downloadUrl(options, options.windowsSetup),
      hash: sha256Of(options.windowsSetup),
    };
  }

  const manifest = {
    version: options.version,
    versionCode: options.androidVersionCode,
    notes: options.notes,
    channel: options.channel,
    pub_date: new Date().toISOString(),
    minClientVersionCode: options.minClientVersionCode,
    minSdkInt: options.minSdkInt,
    platforms,
  };

  // Manifiesto de escritorio: lo que lee el plugin oficial de Tauri.
  // FASE 3.4: `minClientVersionCode` NO va aquí a propósito. Es un concepto de
  // Android: la app de escritorio no tiene `versionCode`, así que publicarlo en
  // latest.json haría que su propia auditoría rechazara toda actualización.
  // El gate de compatibilidad de Windows es la comparación de versión SemVer.
  const latestJson = {
    version: options.version,
    notes: options.notes,
    pub_date: manifest.pub_date,
    channel: options.channel,
    platforms,
  };
  writeFileSync(options.outLatest, JSON.stringify(latestJson, null, 2), 'utf8');
  console.log(`latest.json generado en ${options.outLatest}`);

  // Manifiesto de Android: lo que lee UpdateManifest.kt. Un APK siempre se
  // publica cuando hay variante de Android, y su hash se calcula del archivo.
  if (options.androidApk) {
    const androidManifest = {
      schemaVersion: 1,
      version: options.version,
      versionCode: options.androidVersionCode,
      channel: options.channel,
      notes: options.notes,
      publishedAt: manifest.pub_date,
      apkUrl: downloadUrl(options, options.androidApk),
      sizeBytes: statSync(options.androidApk).size,
      sha256: sha256Of(options.androidApk),
      minSdkInt: options.minSdkInt,
      minClientVersionCode: options.minClientVersionCode,
    };
    writeFileSync(options.outAndroid, JSON.stringify(androidManifest, null, 2), 'utf8');
    console.log(`android.json generado en ${options.outAndroid}`);
  }
}

function downloadUrl(options: Options, artifactPath: string): string {
  const fileName = basename(artifactPath);
  const base = options.channel === 'staging' ? 'staging' : `v${options.version}`;
  return `https://github.com/${options.repo}/releases/download/${base}/${fileName}`;
}

main();
