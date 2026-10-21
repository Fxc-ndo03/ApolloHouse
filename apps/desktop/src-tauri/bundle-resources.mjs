// Stages juana-client for bundling: copies ../../../juana-client into
// src-tauri/resources/juana-client, excluding the dev venv, caches and zips.
// The dev .venv is excluded on purpose (it carries absolute paths and binds
// to the build machine's base interpreter); the installed build gets its own
// relocatable interpreter from bundle-python-runtime.mjs instead.
//
// Two modes, decided by whether the juana-client source tree is reachable:
//   1. Source present  -> unchanged: wipe resources/juana-client and re-stage a
//      filtered copy. Any copy error propagates and fails the build.
//   2. Source missing  -> READ-ONLY reuse of the already staged resources, and
//      only when every mandatory file below is present (requirements.txt,
//      juana_client/client.py, python-runtime/python.exe). Nothing is copied,
//      deleted or overwritten; the build warns loudly instead. If the staged
//      resources are incomplete the build fails, so a half-staged bundle can
//      never reach the installer.
// Run automatically via beforeBuildCommand in tauri.conf.json.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const srcTauriDir = path.dirname(fileURLToPath(import.meta.url));
const resourcesDir = path.resolve(srcTauriDir, 'resources');
const sourceCandidates = [
  path.resolve(srcTauriDir, '..', '..', '..', 'juana-client'),
  path.resolve(srcTauriDir, '..', '..', '..', 'ApolloHouse', 'juana-client'),
];
const sourceIsComplete = (candidate) =>
  existsSync(path.join(candidate, 'requirements.txt')) &&
  existsSync(path.join(candidate, 'juana_client', 'client.py'));
const sourceDir = sourceCandidates.find(sourceIsComplete);
const sourceLocation = sourceDir ?? sourceCandidates.join(' or ');
const stagingDir = path.resolve(resourcesDir, 'juana-client');
const WAKE_MODEL_NAME = 'vosk-model-small-es-0.42';
const wakeModelDir = path.join(stagingDir, 'juana_client', 'models', WAKE_MODEL_NAME);
const wakeModelManifestPath = path.join(srcTauriDir, `${WAKE_MODEL_NAME}.manifest.json`);

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

function listFiles(directory, relative = '') {
  const files = [];
  for (const entry of readdirSync(path.join(directory, relative), { withFileTypes: true })) {
    const child = relative ? path.join(relative, entry.name) : entry.name;
    if (entry.isDirectory()) files.push(...listFiles(directory, child));
    else if (entry.isFile()) files.push(child.split(path.sep).join('/'));
  }
  return files;
}

function verifyWakeModel(directory, expectedFiles) {
  const expectedNames = Object.keys(expectedFiles).sort();
  const actualNames = listFiles(directory).sort();
  if (actualNames.length !== expectedNames.length || actualNames.some((name, index) => name !== expectedNames[index])) {
    throw new Error(`el contenido de ${WAKE_MODEL_NAME} no coincide con el manifiesto fijado`);
  }
  for (const relativeName of expectedNames) {
    const actualPath = path.join(directory, ...relativeName.split('/'));
    const expected = expectedFiles[relativeName];
    const actualBytes = readFileSync(actualPath);
    const digest = createHash('sha256').update(actualBytes).digest('hex');
    if (actualBytes.length !== expected.bytes || digest !== expected.sha256) {
      throw new Error(`el archivo del modelo no coincide con el manifiesto: ${relativeName}`);
    }
  }
}

function extractZip(zipPath, destination) {
  const code = 'import sys, zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])';
  for (const python of ['python', 'py']) {
    const result = spawnSync(python, ['-c', code, zipPath, destination], { stdio: 'inherit' });
    if (result.error?.code === 'ENOENT') continue;
    if (result.status !== 0) throw new Error(`no se pudo extraer el modelo con ${python}`);
    return;
  }
  throw new Error('no se encontró Python para extraer el modelo Vosk');
}

async function ensureWakeModel() {
  const manifest = JSON.parse(readFileSync(wakeModelManifestPath, 'utf8'));
  if (manifest.model !== WAKE_MODEL_NAME || !manifest.source || !manifest.files) {
    throw new Error(`manifiesto inválido: ${wakeModelManifestPath}`);
  }

  if (existsSync(wakeModelDir)) {
    verifyWakeModel(wakeModelDir, manifest.files);
    console.log(`[bundle-resources] verified ${WAKE_MODEL_NAME} from source`);
    return;
  }

  const temporaryDir = path.join(resourcesDir, `.tmp-${WAKE_MODEL_NAME}`);
  const archivePath = path.join(temporaryDir, `${WAKE_MODEL_NAME}.zip`);
  const extractedDir = path.join(temporaryDir, 'extracted');
  rmSync(temporaryDir, { recursive: true, force: true });
  mkdirSync(extractedDir, { recursive: true });
  try {
    const response = await fetch(manifest.source);
    if (!response.ok) throw new Error(`descarga del modelo respondió HTTP ${response.status}`);
    const archive = Buffer.from(await response.arrayBuffer());
    if (archive.length < 1024 * 1024) throw new Error('el archivo descargado del modelo es demasiado pequeño');
    writeFileSync(archivePath, archive);
    extractZip(archivePath, extractedDir);

    const extractedModel = path.join(extractedDir, WAKE_MODEL_NAME);
    verifyWakeModel(extractedModel, manifest.files);
    mkdirSync(path.dirname(wakeModelDir), { recursive: true });
    cpSync(extractedModel, wakeModelDir, { recursive: true });
    verifyWakeModel(wakeModelDir, manifest.files);
    console.log(`[bundle-resources] downloaded and verified ${WAKE_MODEL_NAME}`);
  } finally {
    rmSync(temporaryDir, { recursive: true, force: true });
  }
}

if (!sourceDir) {
  // Modo reutilizacion: la fuente no esta disponible o esta incompleta. Solo
  // se acepta si los recursos staged estan COMPLETOS; nunca se borran ni se reescriben.
  const missing = [
    [path.join(stagingDir, 'requirements.txt'), 'resources/juana-client/requirements.txt'],
    [path.join(stagingDir, 'juana_client', 'client.py'), 'resources/juana-client/juana_client/client.py'],
    [path.join(resourcesDir, 'python-runtime', 'python.exe'), 'resources/python-runtime/python.exe'],
  ].filter(([target]) => !existsSync(target)).map(([, label]) => label);

  if (missing.length > 0) {
    console.error(`[bundle-resources] ERROR: juana-client source is missing or incomplete at ${sourceLocation}`);
    console.error('[bundle-resources] ERROR: staged resources incomplete, cannot reuse them. Missing:');
    for (const label of missing) console.error(`  - ${label}`);
    console.error('[bundle-resources] ERROR: restore the juana-client source tree or fix resources/ before building.');
    process.exit(1);
  }

  console.warn(`[bundle-resources] WARNING: juana-client source missing/incomplete at ${sourceLocation}`);
  console.warn('[bundle-resources] WARNING: reusing the ALREADY STAGED resources, untouched (nothing copied, nothing deleted):');
  console.warn(`  - ${stagingDir}`);
  console.warn(`  - ${path.join(resourcesDir, 'python-runtime')}`);
  console.warn('[bundle-resources] WARNING: they are reused as-is; verify they match the intended build before shipping.');
  process.exit(0);
}
rmSync(stagingDir, { recursive: true, force: true });
mkdirSync(stagingDir, { recursive: true });
copyFiltered(sourceDir, stagingDir);
await ensureWakeModel();
console.log(`[bundle-resources] staged ${stagingDir}`);

