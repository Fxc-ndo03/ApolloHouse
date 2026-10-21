// Sustituye a '@tauri-apps/api/core' en el build de Android (alias en vite.config.android.ts).
// Protocolo REAL del puente (igual que native/bridgeClient.ts del Android):
//   JS -> window.ApolloNative.postMessage(JSON {contractVersion, operation, arguments, requestId})
//   Kotlin -> evento 'message' sobre window.ApolloNative con JSON {ok, data?, error?, requestId}
import { MOCK_RESPONSES } from './mock';
import { COMMAND_MAP, LOCAL_ONLY, NAVIGATION_PENDING, toWindowsError } from './commandMap';

const CONTRACT_VERSION = 1;
const TIMEOUT_MS = 15000;

export interface BridgeReply {
  ok: boolean;
  data?: Record<string, unknown>;
  error?: string;
  requestId?: string;
}

interface BridgeObject {
  postMessage(json: string): void;
  addEventListener(type: 'message', cb: (ev: { data: unknown }) => void): void;
  removeEventListener(type: 'message', cb: (ev: { data: unknown }) => void): void;
}

declare global {
  interface Window {
    ApolloNative?: BridgeObject;
  }
}

const isMock = typeof location !== 'undefined' && new URLSearchParams(location.search).has('mock');

function newRequestId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `r${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

/** Envia una operacion del puente y espera la respuesta con el mismo requestId. */
export function callOperation(operation: string, args: Record<string, unknown>): Promise<BridgeReply> {
  const bridge = typeof window !== 'undefined' ? window.ApolloNative : undefined;
  if (!bridge || typeof bridge.postMessage !== 'function') {
    return Promise.reject(new Error('bridge_unavailable'));
  }
  const requestId = newRequestId();
  return new Promise<BridgeReply>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onMessage = (ev: { data: unknown }) => {
      let parsed: unknown = ev?.data;
      if (typeof parsed === 'string') {
        try { parsed = JSON.parse(parsed); } catch { return; }
      }
      if (!parsed || typeof parsed !== 'object') return;
      if ((parsed as BridgeReply).requestId !== requestId) return;
      cleanup();
      resolve(parsed as BridgeReply);
    };
    const cleanup = () => {
      bridge.removeEventListener('message', onMessage);
      if (timer !== undefined) clearTimeout(timer);
    };
    bridge.addEventListener('message', onMessage);
    timer = setTimeout(() => { cleanup(); reject(new Error('network unreachable (timeout)')); }, TIMEOUT_MS);
    bridge.postMessage(JSON.stringify({ contractVersion: CONTRACT_VERSION, operation, arguments: args, requestId }));
  });
}

export async function invoke<T = unknown>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  if (isMock) {
    return (cmd in MOCK_RESPONSES ? MOCK_RESPONSES[cmd] : undefined) as T;
  }
  if (LOCAL_ONLY.has(cmd) || NAVIGATION_PENDING.has(cmd)) {
    // Estado solo de UI o navegacion: pendiente de conectar en la app (ver docs/03 del paquete).
    return undefined as T;
  }
  const entry = COMMAND_MAP[cmd];
  if (!entry) {
    // Comando exclusivo de PC: se rechaza de forma explicita, nunca se simula.
    throw new Error(`not_available_on_android: ${cmd}`);
  }
  const reply = await callOperation(entry.operation, entry.toArgs ? entry.toArgs(args) : {});
  if (!reply.ok && cmd === 'get_settings' && reply.error === 'unsupported_operation') {
    // Temporal: el puente aun no implementa settings.read. Se usan valores por defecto y la pagina carga.
    return (entry.fromData ? entry.fromData({}, args) : {}) as T;
  }
  if (!reply.ok) throw new Error(toWindowsError(reply.error));
  return (entry.fromData ? entry.fromData(reply.data ?? {}, args) : reply.data) as T;
}
