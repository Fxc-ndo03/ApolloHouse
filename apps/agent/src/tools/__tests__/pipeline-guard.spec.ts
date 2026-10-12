import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

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

// Los guards miran código, no prosa: un comentario que nombre una función no
// cuenta como usarla.
function stripComment(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function readModule(relativePath: string): string {
  return readFileSync(join(SOURCE_ROOT, relativePath), 'utf8');
}

function readModuleCode(relativePath: string): string {
  return stripComment(readModule(relativePath));
}

describe('B6.1 structural: one execution path for deterministic and llm', () => {
  it('only tools/execution.ts invokes a tool handler', () => {
    const offenderList = listSourceFilePathList().filter(
      (filePath) =>
        /\.handler\s*\(/.test(readFileSync(filePath, 'utf8')) &&
        !filePath.endsWith(join('tools', 'execution.ts')),
    );
    expect(offenderList.map(toRelativePath)).toEqual([]);
  });

  it('the registry imports neither authorization nor execution', () => {
    const registrySource = readModuleCode(join('devices', 'registry.ts'));
    for (const forbiddenImport of [
      '@/tools/execution',
      '@/tools/router',
      '@/tools/target',
    ]) {
      expect(registrySource).not.toContain(forbiddenImport);
    }
    expect(registrySource).not.toContain('.handler(');
  });

  it('no device module reaches execution or authorization', () => {
    const offenderList = listSourceFilePathList()
      .filter((filePath) => filePath.replace(/\\/g, '/').includes('/devices/'))
      .filter((filePath) => {
        const source = stripComment(readFileSync(filePath, 'utf8'));
        return (
          source.includes('executeAuthorizedTool') ||
          source.includes('authorizeToolExecution') ||
          /\.handler\s*\(/.test(source)
        );
      });
    expect(offenderList.map(toRelativePath)).toEqual([]);
  });

  it('the llm tool loop goes through the target pipeline, not the raw executor', () => {
    const runSource = readModuleCode(join('turn', 'run.ts'));
    // El loop debe llamar al pipeline central.
    expect(runSource).toContain('executeToolWithTargetResolution(');
    // Y no puede usar el atajo que omite la resolución de target.
    expect(runSource).not.toContain('executeToolByName(');
  });

  it('the deterministic turn goes through the same pipeline', () => {
    const runtimeSource = readModuleCode(join('agents', 'runtime.ts'));
    expect(runtimeSource).toContain('executeToolWithTargetResolution(');
    expect(runtimeSource).not.toContain('resolveToolExecution(');
    expect(runtimeSource).not.toContain('executeToolByName(');
  });

  it('no module resolves and executes a target on its own', () => {
    // executeToolWithTargetResolution es el único que autoriza y ejecuta con target.
    const pipelineModulePath = join('tools', 'target.ts');
    const callerList = listSourceFilePathList()
      .filter((filePath) => !filePath.endsWith(pipelineModulePath))
      .filter((filePath) =>
        stripComment(readFileSync(filePath, 'utf8')).includes(
          'executeToolWithTargetResolution(',
        ),
      );
    // BLOCK 9.1 agrega un TERCER entry point (el harness env-gated del Apollo
    // DO), pero no un segundo camino: llama a la misma función. La invariante
    // sigue siendo que nadie resuelve y ejecuta un target por su cuenta.
    expect(callerList.map(toRelativePath).toSorted()).toEqual([
      'agents/apollo.ts',
      'agents/runtime.ts',
      'turn/run.ts',
    ]);
  });

  it('the confirmation engine is the only place that verifies a pending target', () => {
    const runtimeSource = readModuleCode(join('agents', 'runtime.ts'));
    expect(runtimeSource).not.toContain('verifyExecutionTarget');
    const routerSource = readModuleCode(join('tools', 'router.ts'));
    expect(routerSource).toContain('verifyExecutionTarget(');
  });

  it('no invented capability fallback remains', () => {
    const targetSource = readModuleCode(join('devices', 'target.ts'));
    expect(targetSource).toContain('getCapabilityForToolName');
    // El default que inventaba desktop.list_apps para tools desconocidas.
    expect(targetSource).not.toContain("?? 'desktop.list_apps'");
  });
});
