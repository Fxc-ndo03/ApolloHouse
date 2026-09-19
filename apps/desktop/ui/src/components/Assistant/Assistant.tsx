import { useEffect, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useTauriCommands } from '@/hooks/useTauri';
import { useAppStore } from '@/store';
import type { ConnectionStatus } from '@/store';
import './Assistant.css';

type VisualState = 'reposo' | 'escuchando' | 'pensando' | 'respondiendo';

const STATUS_LABELS: Record<VisualState, string> = {
  reposo: 'En reposo.',
  escuchando: 'Te estoy escuchando.',
  pensando: 'Procesando la información.',
  respondiendo: 'Respondiendo tu consulta.',
};

function mapOrbStateToVisual(state: string): VisualState {
  switch (state) {
    case 'listening':
      return 'escuchando';
    case 'thinking':
      return 'pensando';
    case 'speaking':
      return 'respondiendo';
    case 'focusing':
    case 'focus':
      return 'pensando';
    case 'confirming':
    case 'confirm':
      return 'escuchando';
    case 'alarming':
    case 'alarm':
      return 'respondiendo';
    default:
      return 'reposo';
  }
}

const RAIL_TARGETS: { title: string; appName: string; icon: JSX.Element }[] = [
  {
    title: 'Abrir navegador',
    appName: 'https://www.google.com',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
        <circle cx="12" cy="12" r="10" />
        <path d="M2 12h20M12 2a15 15 0 0 1 0 20 15 15 0 0 1 0-20z" />
      </svg>
    ),
  },
  {
    title: 'Explorador de archivos',
    appName: 'explorer',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
        <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
      </svg>
    ),
  },
  {
    title: 'Notas rápidas',
    appName: 'notepad',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
        <path d="M4 4h16v16H4z" />
        <path d="M8 9h8M8 13h8M8 17h5" />
      </svg>
    ),
  },
  {
    title: 'Calculadora',
    appName: 'calc',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
        <rect x="5" y="2" width="14" height="20" rx="2" />
        <path d="M8 6h8M8 11h.01M12 11h.01M16 11h.01M8 15h.01M12 15h.01M16 15h.01M8 19h.01M12 19h.01" />
      </svg>
    ),
  },
];

export function Assistant() {
  const {
    sendText,
    showSettings,
    pcOpenApp,
    pcFocusApp,
    pcCloseApp,
    pcLockScreen,
    manualListenStart,
    manualListenStop,
    getSettings,
    startSidecar,
    setMicMuted,
    setTtsMuted,
  } = useTauriCommands();
  const orbState = useAppStore((s) => s.orbState);
  const addMessage = useAppStore((s) => s.addMessage);
  const sidecarRunning = useAppStore((s) => s.sidecarRunning);
  const connectionStatus = useAppStore((s) => s.connectionStatus);

  const [composerText, setComposerText] = useState('');
  const [micHeld, setMicHeld] = useState(false);
  const [micMuted, setMicMutedState] = useState(false);
  const [ttsMuted, setTtsMutedState] = useState(false);

  // Auto-start sidecar + restaurar mutes persistidos
  useEffect(() => {
    (async () => {
      try {
        const settings = await getSettings();
        if (settings?.worker_url && settings?.device_shared_secret) {
          await startSidecar();
        }
        if (typeof settings?.mic_muted === 'boolean') setMicMutedState(settings.mic_muted);
        if (typeof settings?.tts_muted === 'boolean') setTtsMutedState(settings.tts_muted);
      } catch (e) {
        console.error('Failed to auto-start sidecar:', e);
      }
    })();
  }, [getSettings, startSidecar]);

  // Sincronizar estado real del sidecar desde el backend (get_sidecar_status).
  // El sidecar puede arrancar en setup() de Rust antes de que la UI cargue;
  // esto evita quedar atascado en gris si los eventos connection_state
  // iniciales se pierden por la carrera de montaje.
  const setConnectionStatus = useAppStore((s) => s.setConnectionStatus);
  const setSidecarRunning = useAppStore((s) => s.setSidecarRunning);
  const { getSidecarStatus } = useTauriCommands();

  useEffect(() => {
    (async () => {
      try {
        const status = await getSidecarStatus();
        if (!status) return;
        if (status.running) {
          setSidecarRunning(true);
          const backendStatus = status.connection_status?.status;
          if (backendStatus && backendStatus !== 'disconnected') {
            setConnectionStatus({
              status: backendStatus as ConnectionStatus['status'],
              error: status.connection_status?.error,
            });
          }
        }
      } catch (e) {
        console.error('Failed to sync sidecar status:', e);
      }
    })();
  }, [getSidecarStatus, setSidecarRunning, setConnectionStatus]);

  const messages = useAppStore((s) => s.messages);
  const lastMsg = messages[messages.length - 1];

  const visual = mapOrbStateToVisual(orbState.state);
  const isConnected =
    sidecarRunning ||
    connectionStatus.status === 'connected' ||
    connectionStatus.status === 'authenticated';
  const statusText =
    orbState.caption !== undefined && orbState.caption.trim().length > 0
      ? orbState.caption
      : lastMsg && lastMsg.content.length < 180
        ? (lastMsg.role === 'user' ? 'Tú: ' : lastMsg.role === 'system' ? '• ' : '') +
          lastMsg.content
        : STATUS_LABELS[visual];

  const sendComposer = async () => {
    const text = composerText.trim();
    if (text.length === 0) return;
    setComposerText('');
    addMessage({ role: 'user', content: text });

    if (text.startsWith('/')) {
      const parts = text.slice(1).split(' ');
      const cmd = parts[0].toLowerCase();
      const args = parts.slice(1).join(' ');
      switch (cmd) {
        case 'open':
          if (args) {
            addMessage({ role: 'system', content: `Abriendo ${args}...` });
            await pcOpenApp(args);
          }
          break;
        case 'focus':
          if (args) {
            addMessage({ role: 'system', content: `Enfocando ${args}...` });
            await pcFocusApp(args);
          }
          break;
        case 'close':
          if (args) {
            addMessage({ role: 'system', content: `Cerrando ${args}...` });
            await pcCloseApp(args);
          }
          break;
        case 'lock':
          addMessage({ role: 'system', content: 'Bloqueando pantalla...' });
          await pcLockScreen();
          break;
        case 'clear':
          useAppStore.getState().clearMessages();
          break;
        case 'help':
          addMessage({
            role: 'system',
            content:
              'Comandos: /open <app>  /focus <app>  /close <app>  /lock  /clear  /help',
          });
          break;
        default:
          addMessage({
            role: 'system',
            content: `Comando desconocido: /${cmd}. Usa /help.`,
          });
      }
      return;
    }

    if (!isConnected) {
      addMessage({
        role: 'system',
        content:
          '⚠️ Apollo no está conectado. Abre Configuración (ruedita) y carga Worker URL + Shared Secret, luego Guardar.',
      });
      return;
    }

    try {
      await sendText(text);
    } catch (e) {
      addMessage({ role: 'system', content: `❌ Error al enviar: ${String(e)}` });
    }
  };

  const beginManualListen = () => {
    setMicHeld(true);
    void manualListenStart();
  };

  const endManualListen = () => {
    if (!micHeld) return;
    setMicHeld(false);
    void manualListenStop();
  };

  const toggleMic = async () => {
    const next = !micMuted;
    setMicMutedState(next);
    try {
      await setMicMuted(next);
    } catch (e) {
      console.error('set_mic_muted failed:', e);
      setMicMutedState(!next);
    }
  };

  const toggleTts = async () => {
    const next = !ttsMuted;
    setTtsMutedState(next);
    try {
      await setTtsMuted(next);
    } catch (e) {
      console.error('set_tts_muted failed:', e);
      setTtsMutedState(!next);
    }
  };

  return (
    <div
      className="assistant-root"
      data-visual={visual}
      data-muted={micMuted ? 'mic' : undefined}
    >
      <div className="assistant-topbar">
        <div className="assistant-brand" data-tauri-drag-region>
          <span className="name">Apollo</span>
          <span className="sub">Asistente de PC</span>
        </div>
        <div className="assistant-window-controls">
          <div
            title={`Estado: ${connectionStatus.status}${sidecarRunning ? ' · Sidecar activo' : ''}`}
            style={{
              width: 8,
              height: 8,
              borderRadius: '50%',
              marginRight: 6,
              background:
                connectionStatus.status === 'connected' ||
                connectionStatus.status === 'authenticated'
                  ? '#35e08a'
                  : connectionStatus.status === 'connecting'
                    ? '#ffc23c'
                    : connectionStatus.status === 'error'
                      ? '#ff6a4a'
                      : '#6b6963',
              boxShadow:
                connectionStatus.status === 'connected' ||
                connectionStatus.status === 'authenticated'
                  ? '0 0 8px 2px #35e08a7a'
                  : connectionStatus.status === 'connecting'
                    ? '0 0 8px 2px #ffc23c7a'
                    : 'none',
            }}
          />
          <button
            className="assistant-icon-btn"
            title="Configuración"
            aria-label="Configuración"
            onClick={async () => {
              try {
                await showSettings();
              } catch (e) {
                addMessage({
                  role: 'system',
                  content: '❌ No se pudo abrir Configuración',
                });
              }
            }}
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              width="17"
              height="17"
            >
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9c.14.62.66 1.09 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </button>
          <button
            className="assistant-icon-btn assistant-win-btn"
            title="Minimizar"
            aria-label="Minimizar"
            onClick={async () => {
              try {
                const w = getCurrentWindow();
                await w.minimize();
              } catch (e) {
                console.error('minimize failed:', e);
              }
            }}
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              width="15"
              height="15"
            >
              <path d="M5 12h14" />
            </svg>
          </button>
          <button
            className="assistant-icon-btn assistant-win-btn"
            title="Maximizar / restaurar"
            aria-label="Maximizar"
            onClick={async () => {
              try {
                const w = getCurrentWindow();
                await w.toggleMaximize();
              } catch (e) {
                console.error('toggleMaximize failed:', e);
              }
            }}
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              width="14"
              height="14"
            >
              <rect x="5" y="5" width="14" height="14" rx="2" />
            </svg>
          </button>
          <button
            className="assistant-icon-btn assistant-win-btn assistant-win-close"
            title="Cerrar (queda en segundo plano)"
            aria-label="Cerrar"
            onClick={async () => {
              try {
                const w = getCurrentWindow();
                await w.close();
              } catch (e) {
                console.error('close failed:', e);
              }
            }}
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              width="15"
              height="15"
            >
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>
      </div>

      <div className="assistant-body">
        <nav className="assistant-rail" aria-label="Accesos rápidos">
          {RAIL_TARGETS.map((target) => (
            <button
              key={target.title}
              className="assistant-rail-btn"
              title={target.title}
              aria-label={target.title}
              onClick={async () => {
                addMessage({ role: 'system', content: `▶ ${target.title}` });
                try {
                  await pcOpenApp(target.appName);
                } catch (e) {
                  addMessage({
                    role: 'system',
                    content: `❌ No se pudo abrir: ${target.title}`,
                  });
                }
              }}
            >
              {target.icon}
            </button>
          ))}
        </nav>

        <div className="assistant-stage">
          <div className="assistant-greeting">
            <p className="hi">
              Hola, <b>Facu</b>
            </p>
            <p className="status">{statusText}</p>
          </div>

          <div className="assistant-face">
            <div className="assistant-eyes-row">
              <div className="assistant-eye-dot" />
              <div className="assistant-eye-dot" />
            </div>
          </div>
        </div>
      </div>

      <div className="assistant-composer">
        <button
          className={`assistant-icon-btn ${micMuted ? 'assistant-toggle-off assistant-mute-active' : 'assistant-toggle-on'}`}
          title={micMuted ? 'Mic silenciado — click para activar' : 'Mic activo — click para silenciar'}
          aria-label={micMuted ? 'Activar micrófono' : 'Silenciar micrófono'}
          aria-pressed={micMuted}
          onClick={() => void toggleMic()}
        >
          {micMuted ? (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
              <path d="M1 1l22 22M9 9a3 3 0 0 0 4 4M15 8a3 3 0 0 1-3 3M5 10v1a7 7 0 0 0 5 6M12 18v4M8 22h8" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
              <path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3z" />
              <path d="M19 10a7 7 0 0 1-14 0" />
              <path d="M12 19v4M8 23h8" />
            </svg>
          )}
        </button>
        <button
          className={`assistant-icon-btn ${ttsMuted ? 'assistant-toggle-off assistant-mute-active' : 'assistant-toggle-on'}`}
          title={ttsMuted ? 'Voz silenciada — click para activar' : 'Voz activa — click para silenciar'}
          aria-label={ttsMuted ? 'Activar voz' : 'Silenciar voz'}
          aria-pressed={ttsMuted}
          onClick={() => void toggleTts()}
        >
          {ttsMuted ? (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
              <path d="M11 5L6 9H2v6h4l5 4V5z" />
              <path d="M23 9l-6 6M17 9l6 6" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
              <path d="M11 5L6 9H2v6h4l5 4V5z" />
              <path d="M15.54 8.46a5 5 0 0 1 0 7.08" />
              <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
            </svg>
          )}
        </button>
        <button
          className={`assistant-icon-btn${micHeld ? ' assistant-mic-live' : ''}`}
          title="Mantener para dictar"
          aria-label="Dictar"
          onPointerDown={beginManualListen}
          onPointerUp={endManualListen}
          onPointerLeave={endManualListen}
          onPointerCancel={endManualListen}
          onContextMenu={(e) => e.preventDefault()}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
            <rect x="9" y="2" width="6" height="12" rx="3" />
            <path d="M5 10v1a7 7 0 0 0 14 0v-1M12 18v4" />
          </svg>
        </button>
        <input
          type="text"
          value={composerText}
          onChange={(e) => setComposerText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void sendComposer();
            }
          }}
          placeholder="Escribí un comando · /help para ayuda"
        />
        <button
          className="assistant-icon-btn send"
          title="Enviar"
          aria-label="Enviar"
          disabled={!composerText.trim()}
          style={{
            opacity: composerText.trim() ? 1 : 0.4,
            cursor: composerText.trim() ? 'pointer' : 'not-allowed',
          }}
          onClick={() => void sendComposer()}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
            <path d="M5 12h14M13 6l6 6-6 6" />
          </svg>
        </button>
      </div>
    </div>
  );
}
