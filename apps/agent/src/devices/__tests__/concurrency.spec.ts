import { describe, expect, it } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { MobileDeviceEndpoint } from '@/devices/endpoint';
import { buildAuthenticatedDeviceProof } from '@/devices/registry';

// ─────────────────────────────────────────────────────────────────────────────
// Guard de concurrencia del bridge (Block 8.2).
//
// Falla si alguien reintroduce un patrón que_sobreevive_ mal: un singleton global
// de transports, una sola Connection por bridge, el cierre de la conexión
// anterior al aceptar otra, o un cleanup global que mate todas las sesiones
// cuando una se desconecta.
// ─────────────────────────────────────────────────────────────────────────────

const SOURCE_ROOT = join(import.meta.dir, '..', '..');
const BRIDGE_SOURCE_PATH = join(SOURCE_ROOT, 'agents', 'mobile-bridge.ts');

function stripComment(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function readBridgeSource(): string {
  return stripComment(readFileSync(BRIDGE_SOURCE_PATH, 'utf8'));
}

function listDeviceFilePathList(): string[] {
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
  walk(join(SOURCE_ROOT, 'devices'));
  filePathList.push(BRIDGE_SOURCE_PATH);
  return filePathList;
}

describe('B8.2 §guard: no previousConnection.close()', () => {
  it('the bridge never closes a previous connection when accepting a new one', () => {
    const source = readBridgeSource();
    // El patrón exacto que este guard existe para cazar, tolerando optional
    // chaining: previousConnection.close(), previousConnection?.close() y
    // lastConnection.close(1000, 'replaced') son el mismo bug.
    for (const variableName of [
      'previousConnection',
      'lastConnection',
      'existingConnection',
      'firstConnection',
      'oldConnection',
    ]) {
      expect(source).not.toMatch(new RegExp(`${variableName}\\s*\\??\\.\\s*close`));
    }
    // Y cualquier variante de "cerrar algo justo antes de aceptar otra".
    expect(source).not.toMatch(/\.close\([^)]*\)[\s\S]{0,160}onConnect/);
  });

  it('the bridge keeps a collection of connections, not a single one', () => {
    const source = readBridgeSource();
    expect(source).not.toMatch(/#connection\s*:\s*Connection\s*\|/);
    expect(source).not.toMatch(/#transport\s*:\s*MobilePeerTransport\s*\|/);
    expect(source).toContain('new Map<Connection, string>()');
  });

  it('no module keeps a module-level singleton of session state', () => {
    // Un singleton a nivel de módulo significa que dos Workers, dos bridges o
    // dos endpoints comparten estado de sesión. Los catálogos constantes
    // (Map de capabilities, de tools) son datos inmutables y están permitidos;
    // lo prohibido es estado mutable de sesión en columna 0.
    const stateHolderNameList = [
      'MobilePeerTransport',
      'MobileDeviceEndpoint',
      'DeviceSessionLifecycle',
      'CapabilityRegistry',
      'HeartbeatScheduler',
    ];
    const moduleLevelDeclarationPattern = /^(?:export\s+)?(?:const|let|var)\s+\w+/gm;
    const offenderList: string[] = [];
    for (const filePath of listDeviceFilePathList()) {
      const source = stripComment(readFileSync(filePath, 'utf8'));
      for (const declaration of source.matchAll(moduleLevelDeclarationPattern)) {
        const declarationStart = declaration.index ?? 0;
        const declarationEnd = source.indexOf(';', declarationStart);
        const declarationText = source.slice(
          declarationStart,
          declarationEnd === -1 ? undefined : declarationEnd,
        );
        if (stateHolderNameList.some((name) => declarationText.includes(name))) {
          const lineNumber = source.slice(0, declarationStart).split('\n').length;
          offenderList.push(`${filePath}:${lineNumber}`);
        }
      }
    }
    expect(offenderList).toEqual([]);
  });

  it('the endpoint cleanup is per connection, never global', () => {
    const source = stripComment(
      readFileSync(join(SOURCE_ROOT, 'devices', 'endpoint.ts'), 'utf8'),
    );
    // handleClose libera una conexión por su id; no puede tocar el resto.
    const closeBody = source.slice(source.indexOf('handleClose(connectionId: string)'));
    const closeMethod = closeBody.slice(0, closeBody.indexOf('inspectSessionSnapshot()'));
    expect(closeMethod).toContain('this.#transportMap.delete(connectionId)');
    expect(closeMethod).not.toContain('this.#transportMap.clear()');
    expect(closeMethod).not.toContain('for (const');
  });

  it('disconnecting one device leaves the other device intact (real behaviour)', () => {
    // Dos devices en un mismo endpoint: el cierre de uno no puede tocar al otro.
    const endpoint = new MobileDeviceEndpoint({ nowMilliseconds: () => 1_000 });
    for (const [connectionId, deviceId] of [
      ['mobile-1', 'mobile:test-a'],
      ['mobile-2', 'mobile:test-b'],
    ] as const) {
      endpoint.handleConnect({
        connectionId,
        port: { send: () => undefined, close: () => undefined },
        proof: buildAuthenticatedDeviceProof('device'),
      });
      endpoint.handleMessage(
        connectionId,
        JSON.stringify({
          type: 'hello',
          deviceId,
          deviceType: 'mobile',
          protocolVersion: 1,
          capabilities: ['mobile.notifications'],
          ts: 1_000,
        }),
      );
    }
    const before = endpoint.inspectSessionSnapshot();
    expect(before.sessionCount).toBe(2);
    expect(before.connectedCount).toBe(2);
    expect(before.heartbeatSchedulerCount).toBe(2);
    // connectionId distinto por socket.
    expect(before.sessionList.map((session) => session.connectionId).toSorted()).toEqual([
      'mobile-1',
      'mobile-2',
    ]);

    endpoint.handleClose('mobile-1');
    const after = endpoint.inspectSessionSnapshot();
    expect(after.sessionCount).toBe(2);
    expect(after.connectedCount).toBe(1);
    expect(after.runningHeartbeatTimerCount).toBe(1);
    expect(
      after.sessionList.find((session) => session.deviceId === 'mobile:test-a')?.presence,
    ).toBe('offline');
    expect(
      after.sessionList.find((session) => session.deviceId === 'mobile:test-b')?.presence,
    ).toBe('online');
  });

  it('the snapshot exposes no secrets', () => {
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
        capabilities: [],
        ts: 1_000,
      }),
    );
    const serialized = JSON.stringify(endpoint.inspectSessionSnapshot());
    for (const forbidden of ['token', 'secret', 'proof', 'password']) {
      expect(serialized.toLowerCase()).not.toContain(forbidden);
    }
  });
});
