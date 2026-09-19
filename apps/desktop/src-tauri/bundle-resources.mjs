// Stages juana-client for bundling: copies ../../../juana-client into
// src-tauri/resources/juana-client, excluding the dev venv, caches and zips.
// The dev .venv is excluded on purpose (it carries absolute paths and binds
// to the build machine's base interpreter); the installed build gets its own
// relocatable interpreter from bundle-python-runtime.mjs instead.
// Run automatically via beforeBuildCommand in tauri.conf.json.
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const srcTauriDir = path.dirname(fileURLToPath(import.meta.url));
const sourceDir = path.resolve(srcTauriDir, '..', '..', '..', 'juana-client');
const stagingDir = path.resolve(srcTauriDir, 'resources', 'juana-client');

const EXCLUDED_DIRS = new Set(['.venv', '__pycache__', '.git', '.mypy_cache', '.pytest_cache']);
const EXCLUDED_EXTENSIONS = new Set(['.pyc', '.pyo', '.zip']);
// Never ship local secrets, and skip the stray duplicate model dir at the root
// (the real one lives in juana_client/models/).
const EXCLUDED_FILES = new Set(['.env']);
const EXCLUDED_TOP_LEVEL = new Set(['vosk-model-small-es-0.42']);

function shouldExclude(relativePath, isDirectory) {
  const fileName = relativePath.split(path.sep).pop();
  if (EXCLUDED_FILES.has(fileName)) return true;
  if (!relativePath.includes(path.sep) && EXCLUDED_TOP_LEVEL.has(fileName)) return true;
  for (const part of relativePath.split(path.sep)) {
    if (EXCLUDED_DIRS.has(part)) return true;
  }
  if (!isDirectory && EXCLUDED_EXTENSIONS.has(path.extname(relativePath))) return true;
  return false;
}

function copyFiltered(source, target, relative = '') {
  const entries = readdirSync(source, { withFileTypes: true });
  for (const entry of entries) {
    const relativeChild = relative === '' ? entry.name : relative + path.sep + entry.name;
    if (shouldExclude(relativeChild, entry.isDirectory())) continue;
    const sourceChild = path.join(source, entry.name);
    const targetChild = path.join(target, entry.name);
    if (entry.isDirectory()) {
      mkdirSync(targetChild, { recursive: true });
      copyFiltered(sourceChild, targetChild, relativeChild);
    } else if (entry.isFile()) {
      cpSync(sourceChild, targetChild);
    }
  }
}

if (!existsSync(sourceDir)) {
  console.error(`[bundle-resources] juana-client not found at ${sourceDir}`);
  process.exit(1);
}
rmSync(stagingDir, { recursive: true, force: true });
mkdirSync(stagingDir, { recursive: true });
copyFiltered(sourceDir, stagingDir);
console.log(`[bundle-resources] staged ${stagingDir}`);

