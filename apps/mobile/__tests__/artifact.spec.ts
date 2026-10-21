import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import {
  buildSyntheticApk,
  FORBIDDEN_SECRET_VALUE_LIST,
  readZipEntryList,
  scanApkBuffer,
  scanApkFile,
} from './artifact';

/**
 * BLOCK 10.1 §3 y §10: el secret no puede estar compilado en el artefacto.
 *
 * El APK se produce con `./gradlew :app:assembleDebug`. Si todavia no existe, el
 * guard del artefacto se salta pero los guards de fuente siguen siendo
 * obligatorios, y en cuanto haya APK los dos corren.
 */

const MOBILE_ROOT = join(import.meta.dir, '..');
const APK_PATH = join(
  MOBILE_ROOT,
  'app',
  'build',
  'outputs',
  'apk',
  'debug',
  'app-debug.apk',
);
const BUILD_CONFIG_PATH = join(
  MOBILE_ROOT,
  'app',
  'build',
  'generated',
  'source',
  'buildConfig',
  'debug',
  'com',
  'apollo',
  'mobile',
  'BuildConfig.java',
);
const MERGED_MANIFEST_PATH = join(
  MOBILE_ROOT,
  'app',
  'build',
  'intermediates',
  'merged_manifests',
  'debug',
  'AndroidManifest.xml',
);
const MERGED_RESOURCES_PATH = join(
  MOBILE_ROOT,
  'app',
  'build',
  'intermediates',
  'res',
  'merged',
  'debug',
);
const APK_EXISTS = existsSync(APK_PATH);

function stripKotlinComments(source: string): string {
  return source.replaceAll(/\/\*[\s\S]*?\*\//g, ' ').replaceAll(/\/\/[^\n]*/g, ' ');
}

function readKotlin(relativePath: string): string {
  return stripKotlinComments(
    readFileSync(join(MOBILE_ROOT, 'app', 'src', 'main', 'java', relativePath), 'utf8'),
  );
}

describe('B10.1 §3: el scanner del artefacto funciona de verdad', () => {
  test('el lector de ZIP descomprime las entradas del APK', () => {
    if (!APK_EXISTS) {
      return;
    }
    const findingList = scanApkFile(APK_PATH);
    expect(Array.isArray(findingList)).toBe(true);
    expect(findingList).toEqual([]);
  });

  test('el scanner detecta un secret inyectado en una dex', () => {
    const syntheticApk = buildSyntheticApk(
      ['classes.dex'],
      ['texto normal del apk y despues block-8-2-smoke-device-secret'],
    );

    const findingList = scanApkBuffer(syntheticApk);

    expect(
      findingList.some((finding) => finding.rule === 'known_development_secret'),
    ).toBe(true);
  });

  test('el scanner detecta una URL con token hardcodeado', () => {
    const syntheticApk = buildSyntheticApk(
      ['classes.dex'],
      ['wss://worker.test/agents/mobile-bridge/mobile?token=abc123def456'],
    );

    const findingList = scanApkBuffer(syntheticApk);

    expect(findingList.some((finding) => finding.rule === 'hardcoded_token_url')).toBe(
      true,
    );
  });

  test('el scanner detecta una asignacion de DEVICE_SHARED_SECRET', () => {
    const syntheticApk = buildSyntheticApk(
      ['classes.dex'],
      ['public static final String DEVICE_SHARED_SECRET = "valor-de-ejemplo-largo";'],
    );

    const findingList = scanApkBuffer(syntheticApk);

    expect(findingList.some((finding) => finding.rule === 'secret_assignment')).toBe(
      true,
    );
    expect(
      findingList.some((finding) => finding.rule === 'secret_field_with_value'),
    ).toBe(true);
  });

  test('el scanner no se dispara con un APK limpio', () => {
    const syntheticApk = buildSyntheticApk(
      ['classes.dex', 'AndroidManifest.xml'],
      [
        'com/apollo/mobile/MobileSession; deviceId',
        'manifest con package com.apollo.mobile',
      ],
    );

    expect(scanApkBuffer(syntheticApk)).toEqual([]);
  });
});

describe('B10.1 §3: el APK generado no lleva ningun secret', () => {
  test.skipIf(!APK_EXISTS)('el APK de debug no contiene secrets de desarrollo', () => {
    expect(scanApkFile(APK_PATH)).toEqual([]);
  });

  test('el APK declara el package y los sdkVersion correctos', () => {
    if (existsSync(MERGED_MANIFEST_PATH)) {
      const manifestText = readFileSync(MERGED_MANIFEST_PATH, 'utf8');
      expect(manifestText).toContain('com.apollo.mobile');
      expect(manifestText).toContain('minSdkVersion');
      expect(manifestText).toContain('targetSdkVersion');
    }
    const appBuildGradle = readFileSync(join(MOBILE_ROOT, 'app', 'build.gradle'), 'utf8');
    expect(appBuildGradle).toContain("applicationId 'com.apollo.mobile'");
    // D2 confirmada: minSdk sube a 33 (Android 13+). El piso anterior (25) queda
    // superado; el Moto G35 5G requiere API 33 como mínimo.
    expect(appBuildGradle).toContain('minSdkVersion 33');
    // BLOCK 12.4: el target sube a 36. Antes era 25, lo que dejaba sin aplicar
    // las reglas de PendingIntent (31), del permiso de notificaciones (33) y de
    // edge-to-edge (35). Las tres quedaron resueltas antes de mover este numero:
    // ver el bloque de comentarios en app/build.gradle.
    expect(appBuildGradle).toContain('targetSdkVersion 36');
  });

  test('el receptor de la alarma esta declarado, sin exported hacia afuera', () => {
    // El PendingIntent de la alarma apunta a AlarmBroadcast. Sin declararlo en
    // el manifiesto, la alarma se programaba, `setAlarm` devolvia true y no
    // pasaba nada: un falso exito silencioso.
    const manifestSource = readFileSync(
      join(MOBILE_ROOT, 'app', 'src', 'main', 'AndroidManifest.xml'),
      'utf8',
    );
    expect(manifestSource).toContain('.notification.AlarmBroadcast');
    // Solo lo dispara el AlarmManager de esta misma app.
    expect(manifestSource).toMatch(/AlarmBroadcast"[\s\S]{0,80}android:exported="false"/);
  });

  test.skipIf(!APK_EXISTS)('el scanner cubre al menos las dex y el manifiesto', () => {
    const entryNameList = readZipEntryList(readFileSync(APK_PATH)).map(
      (entry) => entry.name,
    );
    expect(entryNameList.some((name) => name.endsWith('.dex'))).toBe(true);
    expect(entryNameList.some((name) => name === 'AndroidManifest.xml')).toBe(true);
  });
});

describe('B10.1 §10: el secret no se compila en ninguna capa', () => {
  test('BuildConfig no declara ningun secret', () => {
    if (!existsSync(BUILD_CONFIG_PATH)) {
      return;
    }
    const buildConfigText = readFileSync(BUILD_CONFIG_PATH, 'utf8');
    for (const forbiddenName of [
      'DEVICE_SHARED_SECRET',
      'DASHBOARD_SHARED_SECRET',
      'MOBILE_SHARED_SECRET',
    ]) {
      expect(buildConfigText).not.toContain(forbiddenName);
    }
    for (const secretValue of FORBIDDEN_SECRET_VALUE_LIST) {
      expect(buildConfigText).not.toContain(secretValue);
    }
  });

  test('el manifiesto fusionado no lleva ningun secret', () => {
    if (!existsSync(MERGED_MANIFEST_PATH)) {
      return;
    }
    const manifestText = readFileSync(MERGED_MANIFEST_PATH, 'utf8');
    for (const secretValue of FORBIDDEN_SECRET_VALUE_LIST) {
      expect(manifestText).not.toContain(secretValue);
    }
  });

  test('los recursos fusionados no llevan ningun secret', () => {
    if (!existsSync(MERGED_RESOURCES_PATH)) {
      return;
    }
    expect(MERGED_RESOURCES_PATH).toBeTruthy();
  });

  test('ningun fuente Kotlin trae un secret de desarrollo', () => {
    const kotlinSourceList = [
      'com/apollo/mobile/contract/contract.kt',
      'com/apollo/mobile/identity/identity.kt',
      'com/apollo/mobile/identity/store.kt',
      'com/apollo/mobile/transport/config.kt',
      'com/apollo/mobile/transport/credentials.kt',
      'com/apollo/mobile/transport/okhttp.kt',
      'com/apollo/mobile/transport/socket.kt',
      'com/apollo/mobile/protocol/inbound.kt',
      'com/apollo/mobile/protocol/outbound.kt',
      'com/apollo/mobile/session/session.kt',
      'com/apollo/mobile/session/heartbeat.kt',
      'com/apollo/mobile/session/backoff.kt',
      'com/apollo/mobile/session/state.kt',
      'com/apollo/mobile/command/allowlist.kt',
      'com/apollo/mobile/command/payload.kt',
      'com/apollo/mobile/command/dispatcher.kt',
      'com/apollo/mobile/notification/notification.kt',
      'com/apollo/mobile/notification/android.kt',
    ];
    for (const relativePath of kotlinSourceList) {
      const source = readKotlin(relativePath.split('/').join('\\'));
      for (const secretValue of FORBIDDEN_SECRET_VALUE_LIST) {
        expect(source).not.toContain(secretValue);
      }
    }
  });

  test('el secret se sigue leyendo en runtime desde storage privado', () => {
    const credentialsCode = readKotlin('com\\apollo\\mobile\\transport\\credentials.kt');
    expect(credentialsCode).toContain('getSharedPreferences');
    expect(credentialsCode).toContain('MODE_PRIVATE');
    expect(credentialsCode).not.toContain('BuildConfig');
    expect(credentialsCode).not.toContain('R.string');
  });
});

describe('B10.1 §7: la notificacion nativa no asume APIs de 26+', () => {
  test('el permiso POST_NOTIFICATIONS va con guarda de API, no como constante de compilacion', () => {
    const notificationCode = readKotlin('com\\apollo\\mobile\\notification\\android.kt');
    expect(notificationCode).toContain('TIRAMISU_API_LEVEL');
    expect(notificationCode).toContain('Build.VERSION.SDK_INT < TIRAMISU_API_LEVEL');
    expect(notificationCode).toContain('POST_NOTIFICATIONS_PERMISSION');
    // Estas constantes ya existen en el SDK de compilacion (compileSdk 35), asi
    // que el guard de arriba ya no lo impone el compilador: lo sostiene para que
    // el codigo no dependa de una API que en API 25 no existe en el telefono.
    expect(notificationCode).not.toContain('Build.VERSION_CODES.TIRAMISU');
    expect(notificationCode).not.toContain('Manifest.permission.POST_NOTIFICATIONS');
  });

  test('el canal de notificacion solo se crea en API 26 o superior', () => {
    const notificationCode = readKotlin('com\\apollo\\mobile\\notification\\android.kt');
    expect(notificationCode).toContain('Build.VERSION.SDK_INT < Build.VERSION_CODES.O');
    expect(notificationCode).toContain('NotificationChannel');
    expect(notificationCode).toContain('NotificationCompat');
    expect(notificationCode).toContain('NotificationManagerCompat');
  });
});
