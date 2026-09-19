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
const repoJuanaDir = path.resolve(srcTauriDir, '..', '..', '..', 'juana-client');
const requirementsFile = path.join(repoJuanaDir, 'requirements.txt');
const stagingDir = path.resolve(srcTauriDir, 'resources', 'python-runtime');
const markerFile = path.join(stagingDir, '.runtime-marker.json');
const tmpDir = path.resolve(srcTauriDir, 'resources', '.tmp-python-runtime');

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
