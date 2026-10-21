// Stages a self-contained Python runtime for the installed build:
// downloads the CPython embeddable zip, enables `import site`, bootstraps
// pip, installs juana-client/requirements.txt into it and strips build-time
// junk (pip/setuptools caches, __pycache__). Output: resources/python-runtime.
// The dev .venv is intentionally NOT bundled: venvs carry absolute paths in
// pyvenv.cfg and bind to the base interpreter of the build machine, so they
// break on any other PC. The embeddable runtime is relocatable by design.
//
// Idempotent: skips work when .runtime-marker.json matches the pinned Python
// version + requirements.txt hash. Run via beforeBuildCommand in tauri.conf.json.
//
// Two modes, decided by whether the juana-client source tree is reachable:
//   1. Source present  -> unchanged: hash requirements.txt, honour the marker
//      and (re)build the runtime from the pinned CPython embeddable zip.
//   2. Source missing/incomplete -> reuse the already staged runtime only when
//      every mandatory file is present (resources/juana-client/requirements.txt,
//      resources/juana-client/juana_client/client.py, and
//      resources/python-runtime/python.exe). Nothing is downloaded or deleted;
//      the relative '../juana-client' entry of the ._pth is corrected if needed. If the staged
//      runtime is incomplete the build fails: a rebuild would need network
//      access, which the reuse mode exists to avoid.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_VERSION = 2;
const PYTHON_VERSION = '3.11.9';
const PYTHON_MAJOR_MINOR = '3.11';
const EMBED_URL = `https://www.python.org/ftp/python/${PYTHON_VERSION}/python-${PYTHON_VERSION}-embed-amd64.zip`;
const GET_PIP_URL = 'https://bootstrap.pypa.io/get-pip.py';

const srcTauriDir = path.dirname(fileURLToPath(import.meta.url));
const sourceCandidates = [
  path.resolve(srcTauriDir, '..', '..', '..', 'juana-client'),
  path.resolve(srcTauriDir, '..', '..', '..', 'ApolloHouse', 'juana-client'),
];
const sourceIsComplete = (candidate) =>
  existsSync(path.join(candidate, 'requirements.txt')) &&
  existsSync(path.join(candidate, 'juana_client', 'client.py'));
const repoJuanaDir = sourceCandidates.find(sourceIsComplete);
const sourceLocation = repoJuanaDir ?? sourceCandidates.join(' or ');
const requirementsFile = repoJuanaDir
  ? path.join(repoJuanaDir, 'requirements.txt')
  : path.join(sourceCandidates[0], 'requirements.txt');
const resourcesDir = path.resolve(srcTauriDir, 'resources');
const stagingDir = path.resolve(resourcesDir, 'python-runtime');
const stagedJuanaDir = path.resolve(resourcesDir, 'juana-client');
const markerFile = path.join(stagingDir, '.runtime-marker.json');
const tmpDir = path.resolve(resourcesDir, '.tmp-python-runtime');

function fail(message) {
  console.error(`[bundle-python-runtime] ERROR: ${message}`);
  process.exit(1);
}

function run(label, command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.status !== 0) fail(`${label} failed (exit ${result.status})`);
}

function sha256File(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

async function download(url, destPath) {
  const response = await fetch(url);
  if (!response.ok) fail(`download ${url} -> HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length < 1024 * 1024) fail(`download ${url} suspiciously small (${buffer.length} bytes)`);
  writeFileSync(destPath, buffer);
  console.log(`[bundle-python-runtime] downloaded ${(buffer.length / 1048576).toFixed(1)} MB ${path.basename(destPath)}`);
}

// The build machine always has a Python (dev .venv); use it only as a tool
// to unzip — never as the shipped runtime.
function findBuildPython() {
  for (const candidate of ['python', 'py']) {
    const probe = spawnSync(candidate, ['-c', 'import zipfile; print("ok")'], { stdio: 'pipe' });
    if (probe.status === 0) return candidate;
  }
  fail('no build-time python found (need `python -m zipfile` to unpack the embeddable zip)');
}

function removeRecursively(targetPath) {
  rmSync(targetPath, { recursive: true, force: true });
}

function stripRuntime(dir) {
  let removedBytes = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (
          entry.name === '__pycache__' ||
          entry.name === 'pip' ||
          entry.name === 'pip-24.0.dist-info' ||
          entry.name.startsWith('pip-') && entry.name.endsWith('.dist-info') ||
          entry.name === 'setuptools' ||
          entry.name.startsWith('setuptools-') && entry.name.endsWith('.dist-info') ||
          entry.name === 'wheel' ||
          entry.name.startsWith('wheel-') && entry.name.endsWith('.dist-info') ||
          entry.name === 'pkg_resources' ||
          entry.name === '_distutils_hack' ||
          entry.name.startsWith('_distutils_hack-') && entry.name.endsWith('.dist-info')
        ) {
          removedBytes += dirSize(full);
          removeRecursively(full);
        } else {
          stack.push(full);
        }
      } else if (entry.isFile() && (entry.name.endsWith('.pyc') || entry.name.endsWith('.pyo'))) {
        removedBytes += statSync(full).size;
        removeRecursively(full);
      }
    }
  }
  // get-pip.py leftover at runtime root
  const getPip = path.join(dir, 'get-pip.py');
  if (existsSync(getPip)) {
    removedBytes += statSync(getPip).size;
    removeRecursively(getPip);
  }
  // setuptools' .pth hook survives the package-dir stripping above and would
  // print a ModuleNotFoundError on every interpreter startup: drop it too.
  for (const stalePth of ['distutils-precedence.pth']) {
    const stale = path.join(dir, 'Lib', 'site-packages', stalePth);
    if (existsSync(stale)) {
      removedBytes += statSync(stale).size;
      removeRecursively(stale);
    }
  }
  console.log(`[bundle-python-runtime] stripped ${(removedBytes / 1048576).toFixed(1)} MB of build-time junk`);
}

function dirSize(dir) {
  let total = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) total += statSync(full).size;
    }
  }
  return total;
}

if (process.platform !== 'win32') {
  fail(`unsupported build platform ${process.platform}: extend this script for ${process.platform} before bundling`);
}

/**
 * Modo reutilizacion: la fuente juana-client no vive en este arbol (solo el
 * paquete instalado). Se acepta reutilizar el runtime YA staged solo si estan
 * todos los archivos obligatorios; si falta alguno el build falla, porque
 * reconstruir exigiria descargar Python y dependencias.
 * No borra, no descarga y no reescribe los recursos staged.
 */
function reuseStagedRuntime() {
  const missing = [
    [path.join(stagedJuanaDir, 'requirements.txt'), 'resources/juana-client/requirements.txt'],
    [path.join(stagedJuanaDir, 'juana_client', 'client.py'), 'resources/juana-client/juana_client/client.py'],
    [path.join(stagingDir, 'python.exe'), 'resources/python-runtime/python.exe'],
    [path.join(stagingDir, `python${PYTHON_MAJOR_MINOR.replace('.', '')}._pth`), 'resources/python-runtime/python311._pth'],
  ].filter(([target]) => !existsSync(target)).map(([, label]) => label);

  if (missing.length > 0) {
    console.error(`[bundle-python-runtime] ERROR: juana-client source not found at ${sourceLocation}`);
    console.error('[bundle-python-runtime] ERROR: cannot reuse the staged runtime, missing:');
    for (const label of missing) console.error(`  - ${label}`);
    console.error('[bundle-python-runtime] ERROR: restore the juana-client source tree or stage resources/ by hand before building.');
    process.exit(1);
  }

  // El runtime embeddable ignora PYTHONPATH (modo ._pth aislado): el paquete de
  // la app tiene que estar en el ._pth. Se exige el mismo path relativo que
  // escribe el modo de build, y solo se agrega si un runtime viejo no lo tiene.
  const pthPath = path.join(stagingDir, `python${PYTHON_MAJOR_MINOR.replace('.', '')}._pth`);
  const pthLines = readFileSync(pthPath, 'utf8').split(/\r?\n/);
  const correctedPthLines = pthLines.filter((line) => line.trim() !== '../juna-client');
  if (!correctedPthLines.some((line) => line.trim() === '../juana-client')) {
    correctedPthLines.push('../juana-client');
  }
  if (correctedPthLines.length !== pthLines.length || correctedPthLines.some((line, index) => line !== pthLines[index])) {
    writeFileSync(pthPath, correctedPthLines.join('\r\n'));
    console.log('[bundle-python-runtime] corrected the juana-client path in the staged runtime ._pth');
  }

  console.warn(`[bundle-python-runtime] WARNING: juana-client source not found at ${sourceLocation}`);
  console.warn('[bundle-python-runtime] WARNING: reusing the ALREADY STAGED runtime, nothing downloaded, nothing deleted:');
  console.warn(`  - ${stagingDir}`);
  console.warn(`  - ${stagedJuanaDir}`);
  console.warn('[bundle-python-runtime] WARNING: it is reused as-is; verify it matches requirements.txt before shipping.');
  process.exit(0);
}

if (!repoJuanaDir) {
  reuseStagedRuntime();
}
if (!existsSync(requirementsFile)) fail(`requirements.txt not found at ${requirementsFile}`);

const requirementsHash = sha256File(requirementsFile);
if (existsSync(markerFile)) {
  try {
    const marker = JSON.parse(readFileSync(markerFile, 'utf8'));
    if (
      marker.scriptVersion === SCRIPT_VERSION &&
      marker.pythonVersion === PYTHON_VERSION &&
      marker.requirementsSha256 === requirementsHash &&
      existsSync(path.join(stagingDir, 'python.exe'))
    ) {
      console.log('[bundle-python-runtime] runtime up to date, skipping');
      process.exit(0);
    }
  } catch {
    console.log('[bundle-python-runtime] marker unreadable, rebuilding');
  }
}

console.log(`[bundle-python-runtime] staging CPython ${PYTHON_VERSION} embeddable + requirements`);
removeRecursively(stagingDir);
removeRecursively(tmpDir);
mkdirSync(stagingDir, { recursive: true });
mkdirSync(tmpDir, { recursive: true });

const zipPath = path.join(tmpDir, 'python-embed.zip');
const getPipPath = path.join(tmpDir, 'get-pip.py');
await download(EMBED_URL, zipPath);
await download(GET_PIP_URL, getPipPath);

// Unpack with the build machine python (zipfile is stdlib, no extra deps).
const buildPython = findBuildPython();
run('unzip embeddable', buildPython, ['-m', 'zipfile', '-e', zipPath, stagingDir]);

// Embedded distributions ship with `import site` commented out; pip and
// site-packages resolution need it enabled (documented get-pip procedure).
const pthPath = path.join(stagingDir, `python${PYTHON_MAJOR_MINOR.replace('.', '')}._pth`);
if (!existsSync(pthPath)) fail(`expected ${pthPath} missing from embeddable zip`);
const pthLines = readFileSync(pthPath, 'utf8').split(/\r?\n/);
const patched = pthLines.map((line) => (line.trim() === '#import site' || line.trim() === '# import site' ? 'import site' : line));
if (!patched.some((line) => line.trim() === 'import site')) fail(`could not enable 'import site' in ${pthPath}`);
// The embeddable interpreter ignores PYTHONPATH (isolated ._pth mode), so the
// app package path must live here. Relative to the runtime dir, which keeps
// working wherever the installer lands (both dirs are siblings in resources/).
if (!patched.some((line) => line.trim() === '../juana-client')) patched.push('../juana-client');
writeFileSync(pthPath, patched.join('\r\n'));

const runtimePython = path.join(stagingDir, 'python.exe');
if (!existsSync(runtimePython)) fail(`expected ${runtimePython} missing after unpack`);
cpSync(getPipPath, path.join(stagingDir, 'get-pip.py'));
// Absolute path: the build cwd (apps/desktop/ui) is not the runtime dir.
run('bootstrap pip', runtimePython, [path.join(stagingDir, 'get-pip.py'), '--no-warn-script-location']);
run('install requirements', runtimePython, [
  '-m',
  'pip',
  'install',
  '--no-cache-dir',
  '--disable-pip-version-check',
  '-r',
  requirementsFile,
]);
// Fail fast: a missing native wheel (pyaudio/vosk) must break the build,
// never a silent runtime crash on the user's PC.
run('verify runtime imports', runtimePython, [
  '-c',
  'import websockets, numpy, vosk, pyaudio, dotenv; print("runtime imports ok")',
]);

stripRuntime(stagingDir);
removeRecursively(tmpDir);

writeFileSync(
  markerFile,
  JSON.stringify(
    { scriptVersion: SCRIPT_VERSION, pythonVersion: PYTHON_VERSION, requirementsSha256: requirementsHash },
    null,
    2,
  ),
);
console.log(`[bundle-python-runtime] staged ${stagingDir} (${(dirSize(stagingDir) / 1048576).toFixed(1)} MB)`);
