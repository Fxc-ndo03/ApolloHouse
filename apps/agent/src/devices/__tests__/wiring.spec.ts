import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { listBuiltinToolDefinitionList } from '@/tools/catalog';
import {
  listCapabilityNameForToolName,
  listConnectedCapabilityNameList,
  listToolNameForCapability,
} from '@/devices/target';
import { listImplementedCapabilityNameList } from '@/devices/capability';
import { resolveCapabilityIntent } from '@/devices/intent';
import { routeDeterministic } from '@/voice/router';

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

function toRelativePath(filePath: string): string {
  return filePath.replace(SOURCE_ROOT, '').replace(/\\/g, '/').replace(/^\//, '');
}

function readModuleSource(moduleRelativePath: string): string {
  return readFileSync(join(SOURCE_ROOT, moduleRelativePath), 'utf8');
}

function listImportPathList(source: string): string[] {
  return [...source.matchAll(/from '(@\/[^']+)'/g)].map((match) => match[1] ?? '');
}

const FIXED_NOW = new Date('2026-10-04T12:00:00-03:00');

describe('B6 security: the registry cannot execute or authorize', () => {
  it('12. no device module imports authorization or execution', () => {
    const forbiddenImportList = ['@/tools/execution', '@/tools/router', '@/tools/types'];
    const offenderList = listSourceFilePathList()
      .filter((filePath) => filePath.replace(/\\/g, '/').includes('/devices/'))
      .filter((filePath) => {
        const importPathList = listImportPathList(readFileSync(filePath, 'utf8'));
        return importPathList.some((importPath) =>
          forbiddenImportList.includes(importPath),
        );
      });
    expect(offenderList.map(toRelativePath)).toEqual([]);
  });

  it('12b. no device module invokes a handler or a tool executor', () => {
    const offenderList = listSourceFilePathList()
      .filter((filePath) => filePath.replace(/\\/g, '/').includes('/devices/'))
      .filter((filePath) => {
        const source = readFileSync(filePath, 'utf8');
        return (
          /\.handler\s*\(/.test(source) ||
          source.includes('executeToolByName(') ||
          source.includes('resolveToolExecution(') ||
          source.includes('authorizeToolExecution(')
        );
      });
    expect(offenderList.map(toRelativePath)).toEqual([]);
  });

  it('12c. execution.ts is still the only module with a handler call', () => {
    const offenderList = listSourceFilePathList().filter(
      (filePath) =>
        /\.handler\s*\(/.test(readFileSync(filePath, 'utf8')) &&
        !filePath.endsWith(join('tools', 'execution.ts')),
    );
    expect(offenderList.map(toRelativePath)).toEqual([]);
  });
});

describe('B6 capability → tool mapping', () => {
  it('only connects implemented capabilities', () => {
    const implementedList = listImplementedCapabilityNameList();
    for (const capabilityName of listConnectedCapabilityNameList()) {
      expect(implementedList).toContain(capabilityName);
    }
  });

  it('every mapped tool exists in the builtin catalog', () => {
    const builtinToolNameSet = new Set(
      listBuiltinToolDefinitionList().map((toolDefinition) => toolDefinition.name),
    );
    for (const capabilityName of listConnectedCapabilityNameList()) {
      const toolNameList = listToolNameForCapability(capabilityName);
      expect(toolNameList.length).toBeGreaterThan(0);
      for (const toolName of toolNameList) {
        expect(builtinToolNameSet.has(toolName)).toBe(true);
      }
    }
  });

  it('does not connect unimplemented capabilities', () => {
    expect(listToolNameForCapability('desktop.volume')).toEqual([]);
    expect(listToolNameForCapability('desktop.files')).toEqual([]);
    expect(listToolNameForCapability('mobile.media')).toEqual([]);
    expect(listConnectedCapabilityNameList()).not.toContain('desktop.volume');
    expect(listConnectedCapabilityNameList()).not.toContain('mobile.media');
  });

  it('maps each of the six required capabilities to its existing tool', () => {
    expect(listToolNameForCapability('desktop.open_app')).toEqual(['open_pc_app']);
    expect(listToolNameForCapability('desktop.focus_app')).toEqual(['focus_pc_app']);
    expect(listToolNameForCapability('desktop.close_app')).toEqual(['close_pc_app']);
    expect(listToolNameForCapability('desktop.list_apps')).toEqual(['list_pc_apps']);
    expect(listToolNameForCapability('desktop.lock')).toEqual(['lock_pc_screen']);
    expect(listToolNameForCapability('desktop.spotify')).toContain('spotify_play');
  });

  it('round-trips tool → capability for every connected tool', () => {
    for (const capabilityName of listConnectedCapabilityNameList()) {
      for (const toolName of listToolNameForCapability(capabilityName)) {
        expect(listCapabilityNameForToolName(toolName)).toBe(capabilityName);
      }
    }
  });
});

describe('B6 router integration is not duplicated', () => {
  it('does not redefine router patterns', () => {
    // El mapping intención → capability no puede repetir regex del router.
    const intentSource = readModuleSource(join('devices', 'intent.ts'));
    expect(intentSource).not.toMatch(/= *\/.*\/[a-z]*;/);
    expect(intentSource).not.toContain('routeDeterministic');
  });

  it('maps every pc command the router can emit', () => {
    const pcCommandList = [
      'abrí chrome',
      'enfocá chrome',
      'cerrá chrome',
      'bloqueá la pantalla',
      'poné música',
      'pausá música',
      'siguiente canción',
    ];
    for (const text of pcCommandList) {
      const outcome = routeDeterministic(text, FIXED_NOW);
      expect(outcome.kind).toBe('pc_command');
      const intent = resolveCapabilityIntent(outcome);
      expect(intent).not.toBeNull();
      expect(
        listToolNameForCapability(intent?.capabilityName ?? 'desktop.open_app').length,
      ).toBeGreaterThan(0);
    }
  });

  it('returns no intent for non pc outcomes', () => {
    expect(
      resolveCapabilityIntent(routeDeterministic('qué hora es', FIXED_NOW)),
    ).toBeNull();
    expect(
      resolveCapabilityIntent(
        routeDeterministic('recordá que mi cumple es en mayo', FIXED_NOW),
      ),
    ).toBeNull();
  });
});
