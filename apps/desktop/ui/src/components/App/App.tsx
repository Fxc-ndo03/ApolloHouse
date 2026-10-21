import { useEffect, useRef, useState } from 'react';
import { getCurrentWindow, type Theme } from '@tauri-apps/api/window';
import { useTauriCommands, invokeStrict } from '@/hooks/useTauri';
import { useAppStore } from '@/store';
import type { ActiveSection, ConnectionStatus } from '@/store';
import { applyAppearance } from '@/components/ui/applyAppearance';
import { Icon } from '@/components/ui/Icon';
import { AccountGate } from '@/components/Account/AccountGate';
import { useAuth } from '@/auth/authStore';
import { Assistant } from '@/components/Assistant/Assistant';
import { ChatView } from '@/components/Chat/ChatView';
import { SettingsWindow } from '@/components/Settings/SettingsWindow';
import { VoiceOverlay } from '@/components/voice/VoiceOverlay';
import '@/components/voice/Voice.css';
import './App.css';
import { AuthGate } from '@/auth/AuthGate';
import { normalizeUpdateStatus } from '@/components/Settings/updateState';

const NAV_ITEMS: { id: ActiveSection; label: string; icon: 'home' | 'chat' | 'gear' }[] = [
  { id: 'dashboard', label: 'Inicio', icon: 'home' },
  { id: 'chat', label: 'Chat', icon: 'chat' },
  { id: 'settings', label: 'Configuración', icon: 'gear' },
];

function Section({ id }: { id: ActiveSection }) {
  return (
    <AccountGate section={id}>
      {id === 'dashboard' && <Assistant />}
      {id === 'chat' && <ChatView />}
      {id === 'settings' && <SettingsWindow />}
    </AccountGate>
  );
}

export function App() {
  const appearance = useAppStore((s) => s.appearance);
  const setActiveSection = useAppStore((s) => s.setActiveSection);
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [updateNotice, setUpdateNotice] = useState<string | null>(null);
  const [systemMode, setSystemMode] = useState<'dark' | 'light'>(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function' &&
    !window.matchMedia('(prefers-color-scheme: dark)').matches
      ? 'light'
      : 'dark',
  );

  useEffect(() => {
    let disposed = false;
    let unlistenNativeTheme: (() => void) | undefined;
    const applySystemMode = (mode: Theme | null) => {
      if (!disposed && (mode === 'dark' || mode === 'light')) setSystemMode(mode);
    };
    const media = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-color-scheme: dark)')
      : null;
    const applyMediaMode = (matches: boolean) => applySystemMode(matches ? 'dark' : 'light');
    const onMediaChange = (event: MediaQueryListEvent) => applyMediaMode(event.matches);
    if (media) {
      applyMediaMode(media.matches);
      try { media.addEventListener('change', onMediaChange); } catch {
        media.addListener(onMediaChange as any);
      }
    }

    // En Tauri usamos el tema nativo de Windows como fuente principal. WebView2
    // puede conservar un `prefers-color-scheme` desactualizado al reabrir la app.
    void getCurrentWindow().theme().then(applySystemMode).catch(() => { /* navegador de preview */ });
    void getCurrentWindow().onThemeChanged(({ payload }) => applySystemMode(payload))
      .then((unlisten) => {
        if (disposed) unlisten();
        else unlistenNativeTheme = unlisten;
      })
      .catch(() => { /* navegador de preview */ });

    return () => {
      disposed = true;
      unlistenNativeTheme?.();
      if (media) {
        try { media.removeEventListener('change', onMediaChange); } catch {
          media.removeListener(onMediaChange as any);
        }
      }
    };
  }, []);

  useEffect(() => {
    applyAppearance(appearance, systemMode);
  }, [appearance, systemMode]);

  useEffect(() => {
    void getCurrentWindow().maximize().catch(() => { /* noop */ });
  }, []);

  // Updates are public and should be checked even while the login gate is shown.
  useEffect(() => {
    void (async () => {
      try {
        const status = normalizeUpdateStatus(await invokeStrict('check_for_update'));
        if (status.status.kind === 'available') {
          setUpdateAvailable(true);
          setUpdateNotice(status.latestVersion ?? 'Hay una versión nueva disponible');
        }
      } catch { /* el panel de Actualizaciones conserva el detalle de errores */ }
    })();
  }, []);

  return (
    <>
      <AuthGate><Authed updateAvailable={updateAvailable} /></AuthGate>
      {updateNotice && (
        <aside className="app-update-notice" role="status" aria-live="polite">
          <div>
            <strong>Nueva actualización de Apollo</strong>
            <span>Versión {updateNotice} disponible.</span>
          </div>
          <button type="button" onClick={() => { setActiveSection('settings'); setUpdateNotice(null); }}>
            Ver actualización
          </button>
          <button
            type="button"
            className="app-update-dismiss"
            aria-label="Cerrar aviso de actualización"
            onClick={() => setUpdateNotice(null)}
          >
            ×
          </button>
        </aside>
      )}
    </>
  );
}

function Authed({ updateAvailable }: { updateAvailable: boolean }) {
  const authStatus = useAuth((s) => s.status);
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

  useEffect(() => {
    if (authStatus !== 'signedIn') return;
    (async () => {
      try {
        const settings = await getSettings();
        // Always start sidecar â€” it handles wake word + STT + TTS.
        // PcBridge/CloudCore only need the secret, entered via Settings.
        await startSidecar();
        if (typeof settings?.mic_muted === 'boolean') setMicMuted(settings.mic_muted);
        if (typeof settings?.tts_muted === 'boolean') setTtsMuted(settings.tts_muted);
      } catch (e) {
        console.error('Failed to auto-start sidecar:', e);
      }
    })();
  }, [authStatus, getSettings, startSidecar, setMicMuted, setTtsMuted]);

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

  // El sidecar arrancado NO es una conexion de conversacion: solo abre el
  // microfono. "Online" significa que Cloudcore (el transporte del chat) esta
  // conectado de verdad.
  const isConnected =
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
                {item.id === 'settings' && updateAvailable && (
                  <span className="app-nav-update-dot" title="Hay una actualización disponible" />
                )}
              </button>
            ))}
          </div>
          <div
            className="app-side-foot"
            title={`Apollo ${statusLabel}${sidecarRunning ? ' · Sidecar activo' : ''}`}
          >
            <span
              className="app-side-dot"
              style={{
                background: statusColor,
                boxShadow: isConnected ? `0 0 8px 1px ${statusColor}7a` : 'none',
              }}
            />
            <span className="app-side-status">{statusLabel}</span>
          </div>
          <div className="app-window-controls app-sidebar-window-controls" aria-label="Controles de ventana">
            <button
              className="app-win-btn"
              title="Minimizar"
              aria-label="Minimizar"
              onClick={async () => { try { await getCurrentWindow().minimize(); } catch { /* noop */ } }}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" width="15" height="15">
                <path d="M5 12h14" />
              </svg>
            </button>
            <button
              className="app-win-btn"
              title="Restaurar o maximizar"
              aria-label="Restaurar o maximizar"
              onClick={async () => { try { await getCurrentWindow().toggleMaximize(); } catch { /* noop */ } }}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" width="14" height="14">
                <rect x="5" y="5" width="14" height="14" rx="2" />
              </svg>
            </button>
            <button
              className="app-win-btn app-win-close"
              title="Cerrar"
              aria-label="Cerrar"
              onClick={async () => { try { await getCurrentWindow().close(); } catch { /* noop */ } }}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" width="15" height="15">
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
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
