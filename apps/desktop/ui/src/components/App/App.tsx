import { useEffect, useRef, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useTauriCommands } from '@/hooks/useTauri';
import { useAppStore } from '@/store';
import type { ActiveSection, ConnectionStatus } from '@/store';
import { applyAppearance } from '@/components/ui/applyAppearance';
import { Icon } from '@/components/ui/Icon';
import { Assistant } from '@/components/Assistant/Assistant';
import { ChatView } from '@/components/Chat/ChatView';
import { SettingsWindow } from '@/components/Settings/SettingsWindow';
import { VoiceOverlay } from '@/components/voice/VoiceOverlay';
import '@/components/voice/Voice.css';
import './App.css';

const NAV_ITEMS: { id: ActiveSection; label: string; icon: 'home' | 'chat' | 'gear' }[] = [
  { id: 'dashboard', label: 'Inicio', icon: 'home' },
  { id: 'chat', label: 'Chat', icon: 'chat' },
  { id: 'settings', label: 'Configuración', icon: 'gear' },
];

function Section({ id }: { id: ActiveSection }) {
  if (id === 'dashboard') return <Assistant />;
  if (id === 'chat') return <ChatView />;
  return <SettingsWindow />;
}

export function App() {
  const {
    getSettings,
    startSidecar,
    setMicMuted,
    setTtsMuted,
    getSidecarStatus,
  } = useTauriCommands();
  const activeSection = useAppStore((s) => s.activeSection);
  const setActiveSection = useAppStore((s) => s.setActiveSection);
  const connectionStatus = useAppStore((s) => s.connectionStatus);
  const sidecarRunning = useAppStore((s) => s.sidecarRunning);
  const setConnectionStatus = useAppStore((s) => s.setConnectionStatus);
  const setSidecarRunning = useAppStore((s) => s.setSidecarRunning);
  const appearance = useAppStore((s) => s.appearance);
  const orbState = useAppStore((s) => s.orbState);

  // Transición entre secciones: mantiene la anterior 500ms con salida animada.
  const [leaving, setLeaving] = useState<ActiveSection | null>(null);
  const prevRef = useRef(activeSection);
  useEffect(() => {
    if (prevRef.current !== activeSection) {
      const prev = prevRef.current;
      prevRef.current = activeSection;
      setLeaving(prev);
      const id = setTimeout(() => setLeaving(null), 520);
      return () => clearTimeout(id);
    }
  }, [activeSection]);

  // Aplica la apariencia guardada al arrancar y ante cada cambio.
  useEffect(() => {
    applyAppearance(appearance);
  }, [appearance]);

  useEffect(() => {
    (async () => {
      try {
        const settings = await getSettings();
        // Always start sidecar — it handles wake word + STT + TTS.
        // PcBridge/CloudCore only need the secret, entered via Settings.
        await startSidecar();
        if (typeof settings?.mic_muted === 'boolean') setMicMuted(settings.mic_muted);
        if (typeof settings?.tts_muted === 'boolean') setTtsMuted(settings.tts_muted);
      } catch (e) {
        console.error('Failed to auto-start sidecar:', e);
      }
    })();
  }, [getSettings, startSidecar, setMicMuted, setTtsMuted]);

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

  const isConnected =
    sidecarRunning ||
    connectionStatus.status === 'connected' ||
    connectionStatus.status === 'authenticated';

  const statusColor = isConnected
    ? '#35e08a'
    : connectionStatus.status === 'connecting'
      ? '#ffc23c'
      : connectionStatus.status === 'error'
        ? '#ff6a4a'
        : '#6b6963';

  const statusLabel = !isConnected && connectionStatus.status !== 'connecting' && connectionStatus.status !== 'error'
    ? 'Offline'
    : connectionStatus.status === 'connecting'
      ? 'Conectando'
      : connectionStatus.status === 'error'
        ? 'Error'
        : orbState.state === 'idle'
          ? 'Online'
          : orbState.state;

  return (
    <div className="app-root">
      <div className="app-topbar" data-tauri-drag-region>
        <div className="app-brand">
          <span className="app-brand-name">Apollo</span>
        </div>
        <div className="app-window-controls">
          <div
            className="app-status-dot"
            title={`Estado: ${connectionStatus.status}${sidecarRunning ? ' · Sidecar activo' : ''}`}
            style={{
              background: statusColor,
              boxShadow: isConnected ? `0 0 8px 2px ${statusColor}7a` : 'none',
            }}
          />
          <button
            className="app-win-btn"
            title="Minimizar"
            aria-label="Minimizar"
            onClick={async () => {
              try { await getCurrentWindow().minimize(); } catch { /* noop */ }
            }}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" width="15" height="15">
              <path d="M5 12h14" />
            </svg>
          </button>
          <button
            className="app-win-btn"
            title="Maximizar"
            aria-label="Maximizar"
            onClick={async () => {
              try { await getCurrentWindow().toggleMaximize(); } catch { /* noop */ }
            }}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" width="14" height="14">
              <rect x="5" y="5" width="14" height="14" rx="2" />
            </svg>
          </button>
          <button
            className="app-win-btn app-win-close"
            title="Cerrar"
            aria-label="Cerrar"
            onClick={async () => {
              try { await getCurrentWindow().close(); } catch { /* noop */ }
            }}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" width="15" height="15">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>
      </div>

      <div className="app-body">
        <nav className="app-sidebar" aria-label="Navegación principal">
          <div className="app-nav-list">
            {NAV_ITEMS.map((item) => (
              <button
                key={item.id}
                className={`app-nav-btn ${activeSection === item.id ? 'active' : ''}`}
                onClick={() => setActiveSection(item.id)}
                title={item.label}
                aria-label={item.label}
                aria-current={activeSection === item.id ? 'page' : undefined}
              >
                <span className="app-nav-icon">
                  <Icon n={item.icon} size={17} />
                </span>
                <span className="app-nav-label">{item.label}</span>
              </button>
            ))}
          </div>
          <div className="app-side-foot" title={`Apollo ${statusLabel}`}>
            <span
              className="app-side-dot"
              style={{
                background: statusColor,
                boxShadow: isConnected ? `0 0 8px 1px ${statusColor}7a` : 'none',
              }}
            />
            <span className="app-side-status">{statusLabel}</span>
          </div>
        </nav>

        <main className="app-content">
          <div key={activeSection} className="app-section enter">
            <Section id={activeSection} />
          </div>
          {leaving && leaving !== activeSection && (
            <div key={'leave-' + leaving} className="app-section leave" aria-hidden>
              <Section id={leaving} />
            </div>
          )}
          <VoiceOverlay />
        </main>
      </div>
    </div>
  );
}
