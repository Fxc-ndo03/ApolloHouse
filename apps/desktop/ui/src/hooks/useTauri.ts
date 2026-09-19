import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import {
  listen as tauriListen,
  UnlistenFn,
} from '@tauri-apps/api/event';
import { useEffect, useCallback } from 'react';
import { useAppStore } from '@/store';

const TAURI_AVAILABLE = typeof window !== 'undefined'
  // @ts-expect-error __TAURI__ injected at runtime by Tauri
  && (typeof window.__TAURI__ !== 'undefined'
    // @ts-expect-error Tauri v2 internals
    || typeof window.__TAURI_INTERNALS__ !== 'undefined');

const invoke: typeof tauriInvoke = async (cmd, args?) => {
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
}

type OrbState =
  | 'idle'
  | 'listening'
  | 'thinking'
  | 'speaking'
  | 'confirming'
  | 'focusing'
  | 'alarm'
  | 'error';

export function useTauriCommands() {
  const setConnectionStatus = useAppStore((s) => s.setConnectionStatus);
  const setOrbState = useAppStore((s) => s.setOrbState);
  const addMessage = useAppStore((s) => s.addMessage);
  const setSidecarRunning = useAppStore((s) => s.setSidecarRunning);

  // Listen for events from backend
  useEffect(() => {
    const unlisteners: UnlistenFn[] = [];

    const setupListeners = async () => {
      // Orb state changes
      unlisteners.push(
        await listen('orb-state-change', (event: TauriEvent<string>) => {
          setOrbState({ state: event.payload as OrbState });
        }),
      );

      // TTS events
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

      // Turn end
      unlisteners.push(
        await listen('turn-end', (event: TauriEvent<any>) => {
          if (event.payload?.expectsReply) {
            setOrbState({ state: 'listening' });
          } else {
            setOrbState({ state: 'idle' });
          }
        }),
      );

      // Confirm request
      unlisteners.push(
        await listen('confirm-request', (event: TauriEvent<any>) => {
          setOrbState({ state: 'confirming', caption: event.payload?.summary });
          addMessage({
            role: 'system',
            content: `❓ Confirmación requerida: ${event.payload?.summary}`,
          });
        }),
      );

      // Error
      unlisteners.push(
        await listen('error', (event: TauriEvent<any>) => {
          setOrbState({ state: 'error', caption: event.payload?.message });
          addMessage({
            role: 'system',
            content: `❌ Error: ${event.payload?.message}`,
          });
          setConnectionStatus({ status: 'error', error: event.payload?.message });
        }),
      );

      // Play effect
      unlisteners.push(
        await listen('play-effect', (event: TauriEvent<any>) => {
          console.log('Play effect:', event.payload?.name);
        }),
      );

      // Alarm ring
      unlisteners.push(
        await listen('alarm-ring', (event: TauriEvent<any>) => {
          setOrbState({ state: 'alarm', caption: event.payload?.label || 'Alarma' });
          addMessage({
            role: 'system',
            content: `🔔 Alarma: ${event.payload?.label || 'Sonando'}`,
          });
        }),
      );

      // Response output target
      unlisteners.push(
        await listen('response-output-target', (event: TauriEvent<any>) => {
          console.log('Response output target:', event.payload?.target);
        }),
      );

      // Sidecar exited
      unlisteners.push(
        await listen('sidecar-exited', () => {
          setSidecarRunning(false);
          setConnectionStatus({ status: 'disconnected' });
          setOrbState({ state: 'idle' });
        }),
      );

      // Protocol messages from sidecar
      unlisteners.push(
        await listen('protocol-message', (event: TauriEvent<any>) => {
          handleProtocolMessage(event.payload);
        }),
      );
    };

    setupListeners();

    return () => {
      unlisteners.forEach((unlisten) => unlisten());
    };
  }, [setConnectionStatus, setOrbState, addMessage, setSidecarRunning]);

  const handleProtocolMessage = useCallback(
    (msg: any) => {
      switch (msg.type) {
        case 'connection_state':
          if (msg.state === 'error') {
            setConnectionStatus({ status: 'error', error: msg.error });
          } else {
            setConnectionStatus({ status: msg.state });
          }
          break;
        case 'ui_state':
          setOrbState({
            state: msg.state,
            caption: msg.caption,
            emotion: msg.emotion,
            accentColor: msg.accent_color,
          });
          if (msg.caption) {
            addMessage({ role: 'assistant', content: msg.caption });
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
          setOrbState({ state: 'error', caption: msg.message });
          break;
        case 'text_response':
          addMessage({ role: 'assistant', content: msg.text });
          break;
        case 'alarm_ring':
          setOrbState({ state: 'alarm', caption: msg.label });
          break;
      }
    },
    [setConnectionStatus, setOrbState, addMessage],
  );

  // Commands
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
      await invoke('send_text_to_sidecar', { text });
    } catch (e) {
      console.error('Failed to send text:', e);
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

  // PC Commands (native Windows execution)
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
    // Sidecar
    startSidecar,
    stopSidecar,
    // Communication
    sendText,
    sendConfirm,
    manualListenStart,
    manualListenStop,
    // Windows
    showOrb,
    hideOrb,
    showChat,
    hideChat,
    showSettings,
    // Settings
    getSettings,
    updateSettings,
    getAutostartEnabled,
    setAutostartEnabled,
    setResponseOutputTarget,
    pcbridgeStatus,
    // Sidecar status
    getSidecarStatus,
    // Mutes
    setMicMuted,
    setTtsMuted,
    // PC Commands
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
