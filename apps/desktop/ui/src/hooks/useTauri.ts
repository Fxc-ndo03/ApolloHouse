import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import {
  listen as tauriListen,
  UnlistenFn,
} from '@tauri-apps/api/event';
import { useEffect, useCallback } from 'react';
import { useAppStore } from '@/store';
import type { OrbState as StoreOrbState } from '@/store';

const TAURI_AVAILABLE = typeof window !== 'undefined'
  // @ts-expect-error __TAURI__ injected at runtime by Tauri
  && (typeof window.__TAURI__ !== 'undefined'
    // @ts-expect-error Tauri v2 internals
    || typeof window.__TAURI_INTERNALS__ !== 'undefined');

// FASE 2.12: el panel de cuenta lo importa. Se exporta el MISMO wrapper que usa
// el resto del hook (mismo TAURI_AVAILABLE, mismo manejo de error): asi el
// login nunca puede saltarse el camino seguro.
export const invoke: typeof tauriInvoke = async (cmd, args?) => {
  if (!TAURI_AVAILABLE) return undefined as never;
  try {
    return await tauriInvoke(cmd, args);
  } catch {
    return undefined as never;
  }
};

const listen: typeof tauriListen = async (evt, cb?) => {
  if (!TAURI_AVAILABLE) return () => {};
  try {
    return await tauriListen(evt, cb as any);
  } catch {
    return () => {};
  }
};

type TauriEvent<T = any> = { payload: T };

/**
 * Registro único de listeners a nivel app.
 *
 * useTauriCommands() se usa en varios componentes (App, Chat, Home, Voice,
 * Settings). Sin este guard, cada montaje registraba el set completo de
 * listeners y cada transcript/caption/respuesta se procesaba 2-3 veces
 * (mensajes duplicados/triplicados y churn de estado). Los callbacks son
 * acciones estables del store, así que compartirlos es seguro.
 */
let tauriListenerSetup: Promise<UnlistenFn[]> | null = null;

/** Caption transitorio de estado ("Pensando…"): se muestra en header/orbe, nunca como burbuja. */
function isTransientCaption(caption: unknown): boolean {
  if (typeof caption !== 'string') return true;
  const t = caption.trim();
  return t.length === 0 || t.endsWith('…') || t.endsWith('...');
}

/**
 * Inserta o actualiza el mensaje del asistente sin duplicar:
 * - burbuja vacía al final → la rellena (flujo optimista del chat)
 * - mismo texto → no-op (caption final idéntico al texto ya mostrado)
 * - el nuevo extiende al anterior → actualiza (crecimiento tipo stream)
 * - si no, agrega burbuja nueva (turno nuevo / turno por voz)
 */
function upsertAssistantMessage(content: string) {
  const msgs = useAppStore.getState().messages;
  const last = msgs[msgs.length - 1];
  if (last && last.role === 'assistant') {
    if (last.content === '' || last.content === content) {
      if (last.content === content) return;
      useAppStore.setState({
        messages: msgs.map((m, i) => (i === msgs.length - 1 ? { ...m, content } : m)),
      });
      return;
    }
    if (content.length > last.content.length && content.startsWith(last.content)) {
      useAppStore.setState({
        messages: msgs.map((m, i) => (i === msgs.length - 1 ? { ...m, content } : m)),
      });
      return;
    }
  }
  useAppStore.getState().addMessage({ role: 'assistant', content });
}

/** Asegura una burbuja vacía al final para streaming, sin duplicarla. */
function ensureEmptyAssistantMessage() {
  const msgs = useAppStore.getState().messages;
  const last = msgs[msgs.length - 1];
  if (!(last && last.role === 'assistant' && last.content === '')) {
    useAppStore.getState().addMessage({ role: 'assistant', content: '' });
  }
}

interface AppSettingsData {
  worker_url: string;
  device_shared_secret: string;
  wake_words: string[];
  use_vosk_wake: boolean;
  wake_model_dir: string | null;
  response_output_target: string;
  autostart_enabled: boolean;
  mic_muted: boolean;
  tts_muted: boolean;
  use_local_core: boolean;
  core_lan_url: string;
  tts_provider: string;
  tts_voice: string;
  tts_language: string;
  tts_speed: number;
  input_device_name?: string;
  output_device_name?: string;
}

type OrbState =
  | 'idle'
  | 'listening'
  | 'thinking'
  | 'speaking'
  | 'responding'
  | 'confirming'
  | 'focusing'
  | 'alarm'
  | 'error';

export function useTauriCommands() {
  const setConnectionStatus = useAppStore((s) => s.setConnectionStatus);
  const setOrbState = useAppStore((s) => s.setOrbState);
  const addMessage = useAppStore((s) => s.addMessage);
  const setSidecarRunning = useAppStore((s) => s.setSidecarRunning);

  useEffect(() => {
    if (!tauriListenerSetup) {
      tauriListenerSetup = setupTauriListeners({
        setConnectionStatus,
        setOrbState,
        addMessage,
        setSidecarRunning,
      });
    }
    // Listeners de por vida de la app: no se remueven al desmontar vistas.
    return () => {};
  }, [setConnectionStatus, setOrbState, addMessage, setSidecarRunning]);

interface TauriListenerDeps {
  setConnectionStatus: (status: { status: 'disconnected' | 'connecting' | 'connected' | 'authenticated' | 'error'; error?: string }) => void;
  setOrbState: (state: Partial<StoreOrbState>) => void;
  addMessage: (message: { role: 'user' | 'assistant' | 'system'; content: string }) => void;
  setSidecarRunning: (running: boolean) => void;
}

async function setupTauriListeners(deps: TauriListenerDeps): Promise<UnlistenFn[]> {
  const { setConnectionStatus, setOrbState, addMessage, setSidecarRunning } = deps;
  const unlisteners: UnlistenFn[] = [];
  let textResponseBuffer = '';
  let isStreamingResponse = false;

  /** Corte limpio: un stream o turno interrumpido nunca deja 'responding' colgado. */
  const resetTurnState = () => {
    textResponseBuffer = '';
    isStreamingResponse = false;
    setOrbState({ state: 'idle', caption: undefined });
    useAppStore.getState().dropTrailingEmptyAssistant();
  };

  const handleProtocolMessage = (msg: any) => {
    switch (msg.type) {
      case 'connection_state':
        if (msg.state === 'error') {
          setConnectionStatus({ status: 'error', error: msg.error });
          resetTurnState();
        } else {
          setConnectionStatus({ status: msg.state });
          if (msg.state === 'disconnected') resetTurnState();
        }
        break;
      case 'ui_state':
        setOrbState({
          state: msg.state,
          caption: msg.caption,
          emotion: msg.emotion,
          accentColor: msg.accent_color,
        });
        // Solo los captions sustantivos llegan al chat; los transitorios
        // ("Pensando…") viven en header/orbe. Upsert: jamás duplica.
        if (msg.caption && !isTransientCaption(msg.caption)) {
          upsertAssistantMessage(msg.caption);
        }
        break;
      case 'tts_start':
        setOrbState({ state: 'speaking' });
        break;
      case 'tts_end':
      case 'tts_aborted':
        setOrbState({ state: 'idle' });
        break;
      case 'turn_end':
        if (msg.expects_reply) {
          setOrbState({ state: 'listening' });
        } else {
          setOrbState({ state: 'idle' });
        }
        break;
      case 'confirm_request':
        setOrbState({ state: 'confirming', caption: msg.summary });
        break;
      case 'error':
        resetTurnState();
        setOrbState({ state: 'error', caption: msg.message });
        break;
      case 'text_response':
        upsertAssistantMessage(msg.text);
        break;
      case 'voice_transcript':
        addMessage({ role: 'user', content: msg.text });
        break;
      case 'alarm_ring':
        setOrbState({ state: 'alarm', caption: msg.label });
        break;
    }
  };

  unlisteners.push(
    await listen('orb-state-change', (event: TauriEvent<string>) => {
      setOrbState({ state: event.payload as OrbState });
    }),
  );

  unlisteners.push(
    await listen('tts-start', (event: TauriEvent<any>) => {
      setOrbState({ state: 'speaking', caption: event.payload?.caption });
    }),
  );

  unlisteners.push(
    await listen('tts-end', () => {
      setOrbState({ state: 'idle', caption: undefined });
    }),
  );

  unlisteners.push(
    await listen('tts-aborted', () => {
      setOrbState({ state: 'idle', caption: undefined });
    }),
  );

  unlisteners.push(
    await listen('turn-end', (event: TauriEvent<any>) => {
      if (event.payload?.expectsReply) {
        setOrbState({ state: 'listening' });
      } else {
        setOrbState({ state: 'idle' });
      }
    }),
  );

  unlisteners.push(
    await listen('confirm-request', (event: TauriEvent<any>) => {
      setOrbState({ state: 'confirming', caption: event.payload?.summary });
      addMessage({
        role: 'system',
        content: `Confirmacion requerida: ${event.payload?.summary}`,
      });
    }),
  );

  unlisteners.push(
    await listen('error', (event: TauriEvent<any>) => {
      resetTurnState();
      setOrbState({ state: 'error', caption: event.payload?.message });
      addMessage({
        role: 'system',
        content: `Error: ${event.payload?.message}`,
      });
      setConnectionStatus({ status: 'error', error: event.payload?.message });
    }),
  );

  unlisteners.push(
    await listen('play-effect', (event: TauriEvent<any>) => {
      console.log('Play effect:', event.payload?.name);
    }),
  );

  unlisteners.push(
    await listen('alarm-ring', (event: TauriEvent<any>) => {
      setOrbState({ state: 'alarm', caption: event.payload?.label || 'Alarma' });
      addMessage({
        role: 'system',
        content: `Alarma: ${event.payload?.label || 'Sonando'}`,
      });
    }),
  );

  unlisteners.push(
    await listen('response-output-target', (event: TauriEvent<any>) => {
      console.log('Response output target:', event.payload?.target);
    }),
  );

  unlisteners.push(
    await listen('sidecar-exited', () => {
      setSidecarRunning(false);
      setConnectionStatus({ status: 'disconnected' });
      resetTurnState();
    }),
  );

  unlisteners.push(
    await listen('text-response-chunk', (event: TauriEvent<string>) => {
      textResponseBuffer += event.payload;
      if (!isStreamingResponse) {
        isStreamingResponse = true;
        setOrbState({ state: 'responding' });
      }
      ensureEmptyAssistantMessage();
      const msgs = useAppStore.getState().messages;
      const lastMsg = msgs[msgs.length - 1];
      if (lastMsg && lastMsg.role === 'assistant') {
        useAppStore.setState({
          messages: msgs.map((m, i) =>
            i === msgs.length - 1 ? { ...m, content: textResponseBuffer } : m,
          ),
        });
      }
    }),
  );

  unlisteners.push(
    await listen('text-response-end', () => {
      if (textResponseBuffer.length > 0) {
        const msgs = useAppStore.getState().messages;
        const lastMsg = msgs[msgs.length - 1];
        if (lastMsg && lastMsg.role === 'assistant' && lastMsg.content === '') {
          useAppStore.setState({
            messages: msgs.slice(0, -1),
          });
        }
      }
      textResponseBuffer = '';
      isStreamingResponse = false;
      setOrbState({ state: 'idle' });
    }),
  );

  unlisteners.push(
    await listen('protocol-message', (event: TauriEvent<any>) => {
      handleProtocolMessage(event.payload);
    }),
  );

  return unlisteners;
}

  const startSidecar = useCallback(async () => {
    try {
      await invoke('start_sidecar');
      setSidecarRunning(true);
      setConnectionStatus({ status: 'connecting' });
    } catch (e) {
      console.error('Failed to start sidecar:', e);
      setConnectionStatus({ status: 'error', error: String(e) });
    }
    try {
      await invoke('start_pcbridge');
    } catch (e) {
      console.error('Failed to start PcBridge companion:', e);
    }
  }, [setConnectionStatus, setSidecarRunning]);

  const stopSidecar = useCallback(async () => {
    try {
      await invoke('stop_sidecar');
      setSidecarRunning(false);
      setConnectionStatus({ status: 'disconnected' });
      setOrbState({ state: 'idle' });
    } catch (e) {
      console.error('Failed to stop sidecar:', e);
    }
    try {
      await invoke('stop_pcbridge');
    } catch (e) {
      console.error('Failed to stop PcBridge companion:', e);
    }
  }, [setConnectionStatus, setSidecarRunning, setOrbState]);

  const sendText = useCallback(async (text: string) => {
    try {
      await invoke('send_text_to_cloud_core', { text });
    } catch (e) {
      console.error('cloudcore-send error:', e);
      throw e;
    }
  }, []);

  const testTts = useCallback(async (text?: string) => {
    const testText = text ?? 'Hola, soy Apollo. En que puedo ayudarte?';
    try {
      await invoke('send_text_to_cloud_core', { text: testText });
    } catch (e) {
      console.error('tts-test error:', e);
    }
  }, []);

  const sendConfirm = useCallback(async (ok: boolean) => {
    try {
      await invoke('send_confirm_to_sidecar', { ok });
    } catch (e) {
      console.error('Failed to send confirm:', e);
    }
  }, []);

  const manualListenStart = useCallback(async () => {
    try {
      await invoke('manual_listen_start');
    } catch (e) {
      console.error('Failed to start manual listen:', e);
    }
  }, []);

  const manualListenStop = useCallback(async () => {
    try {
      await invoke('manual_listen_stop');
    } catch (e) {
      console.error('Failed to stop manual listen:', e);
    }
  }, []);

  const showOrb = useCallback(async () => {
    await invoke('show_orb_window');
  }, []);

  const hideOrb = useCallback(async () => {
    await invoke('hide_orb_window');
  }, []);

  const showChat = useCallback(async () => {
    await invoke('show_chat_window');
  }, []);

  const hideChat = useCallback(async () => {
    await invoke('hide_chat_window');
  }, []);

  const showSettings = useCallback(async () => {
    await invoke('show_settings_window');
  }, []);

  const getSettings = useCallback(async () => {
    return await invoke<AppSettingsData>('get_settings');
  }, []);

  const updateSettings = useCallback(async (data: any) => {
    await invoke('update_settings', { data });
  }, []);

  const setDeviceSharedSecret = useCallback(async (secret: string) => {
    await invoke('set_device_shared_secret', { secret });
  }, []);

  const getAutostartEnabled = useCallback(async () => {
    return await invoke<boolean>('get_autostart_enabled');
  }, []);

  const setAutostartEnabled = useCallback(async (enabled: boolean) => {
    await invoke('set_autostart_enabled', { enabled });
  }, []);

  const setResponseOutputTarget = useCallback(async (target: 'pc' | 'server') => {
    await invoke('set_response_output_target', { target });
  }, []);

  const pcbridgeStatus = useCallback(async () => {
    return await invoke<{ running: boolean; connected: boolean }>('pcbridge_status');
  }, []);

  const getSidecarStatus = useCallback(async () => {
    return await invoke<{
      running: boolean;
      connection_status: {
        status: string;
        error?: string;
      };
    }>('get_sidecar_status');
  }, []);

  const setMicMuted = useCallback(async (muted: boolean) => {
    await invoke('set_mic_muted', { muted });
  }, []);

  const setTtsMuted = useCallback(async (muted: boolean) => {
    await invoke('set_tts_muted', { muted });
  }, []);

  const pcOpenApp = useCallback(async (appName: string, args?: string) => {
    return await invoke('execute_pc_open_app', { app_name: appName, args });
  }, []);

  const pcFocusApp = useCallback(async (appName: string) => {
    return await invoke('execute_pc_focus_app', { app_name: appName });
  }, []);

  const pcCloseApp = useCallback(async (appName: string) => {
    return await invoke('execute_pc_close_app', { app_name: appName });
  }, []);

  const pcLockScreen = useCallback(async () => {
    return await invoke('execute_pc_lock_screen');
  }, []);

  const pcListApps = useCallback(async () => {
    return await invoke('pc_list_apps');
  }, []);

  const pcSpotifyPlay = useCallback(async () => {
    return await invoke('pc_spotify_play');
  }, []);

  const pcSpotifyPause = useCallback(async () => {
    return await invoke('pc_spotify_pause');
  }, []);

  const pcSpotifyNext = useCallback(async () => {
    return await invoke('pc_spotify_next');
  }, []);

  const pcSpotifyPrevious = useCallback(async () => {
    return await invoke('pc_spotify_previous');
  }, []);

  const pcSpotifyGetState = useCallback(async () => {
    return await invoke('pc_spotify_get_state');
  }, []);

  return {
    startSidecar,
    stopSidecar,
    sendText,
    testTts,
    sendConfirm,
    manualListenStart,
    manualListenStop,
    showOrb,
    hideOrb,
    showChat,
    hideChat,
    showSettings,
    getSettings,
    updateSettings,
    setDeviceSharedSecret,
    getAutostartEnabled,
    setAutostartEnabled,
    setResponseOutputTarget,
    pcbridgeStatus,
    getSidecarStatus,
    setMicMuted,
    setTtsMuted,
    pcOpenApp,
    pcFocusApp,
    pcCloseApp,
    pcLockScreen,
    pcListApps,
    pcSpotifyPlay,
    pcSpotifyPause,
    pcSpotifyNext,
    pcSpotifyPrevious,
    pcSpotifyGetState,
  };
}
