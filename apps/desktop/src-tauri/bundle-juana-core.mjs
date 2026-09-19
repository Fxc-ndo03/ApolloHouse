// Bundle script: empaqueta el Apollo Core server de Juana para que corra
// dentro del proceso Python del sidecar. Se ejecuta junto al cliente
// juana_client y provee WS LAN en el puerto definido por JUANA_CORE_PORT.
//
// Flujo:
//   1. Build staging: asegura que juana_core_server.py está en resources/
//   2. Runtime: server WS en 127.0.0.1:PORT (default 9876)
//   3. Cliente se conecta a ws://127.0.0.1:PORT?token=SECRET
//   4. Si falla → fallback a Worker de Cloudflare

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_VERSION = 1;
const DEFAULT_PORT = 9876;
const PYTHON_CORE_FILE = 'juana_core_server.py';
const CORE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'resources');
const CORE_PATH = path.join(CORE_DIR, PYTHON_CORE_FILE);
const MARKER_FILE = path.join(CORE_DIR, '.juana-core-marker.json');

function fail(message) {
  console.error(`[bundle-juana-core] ERROR: ${message}`);
  process.exit(1);
}

// Asegurar directorio de resources
mkdirSync(CORE_DIR, { recursive: true });

// Verificar idempotencia con marker
if (existsSync(MARKER_FILE)) {
  try {
    const marker = JSON.parse(readFileSync(MARKER_FILE, 'utf8'));
    if (marker.scriptVersion === SCRIPT_VERSION) {
      console.log('[bundle-juana-core] Core up to date, skipping');
      process.exit(0);
    }
  } catch {
    console.log('[bundle-juana-core] marker unreadable, rebuilding');
  }
}

console.log('[bundle-juana-core] staging Apollo Core server');

// El archivo core server debe existir previamente (creado manualmente o por otro proceso).
// Si no existe, fallamos con un mensaje claro.
if (!existsSync(CORE_PATH)) {
  fail(`No se encontró ${PYTHON_CORE_FILE} en ${CORE_DIR}. ` +
       'Crea el archivo o ejecuta el build después de haberlo creado.');
}

// Marker de que el core ha sido staged
writeFileSync(MARKER_FILE, JSON.stringify({ scriptVersion: SCRIPT_VERSION }));
console.log(`[bundle-juana-core] staged ${PYTHON_CORE_FILE} → ${CORE_PATH}`);
console.log(`[bundle-juana-core] Apollo Core listo en ${CORE_PATH}`);