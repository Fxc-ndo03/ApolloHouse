// Sustituye a '@tauri-apps/api/event' en el build de Android.
export type UnlistenFn = () => void;
export type Event<T> = { payload: T };
type Handler = (e: Event<unknown>) => void;
const handlers = new Map<string, Set<Handler>>();
const last = new Map<string, unknown>();
// Estados que se reenvian a quien se suscribe tarde. Los fragmentos de texto NO se reenvian (evita duplicados).
const REPLAYABLE = new Set(['orb-state-change', 'connection-status']);

export async function listen<T = unknown>(evt: string, cb: (e: Event<T>) => void): Promise<UnlistenFn> {
  const set = handlers.get(evt) ?? new Set<Handler>();
  const h = cb as Handler;
  set.add(h);
  handlers.set(evt, set);
  if (REPLAYABLE.has(evt) && last.has(evt)) h({ payload: last.get(evt) });
  return () => { set.delete(h); };
}

/** Entrega un evento nativo a los suscriptores. Lo llama window.__apolloEvent (platform/android/nativeBridge.ts). */
export function dispatchNativeEvent(evt: string, payload: unknown): void {
  if (REPLAYABLE.has(evt)) last.set(evt, payload);
  handlers.get(evt)?.forEach((cb) => cb({ payload }));
}
