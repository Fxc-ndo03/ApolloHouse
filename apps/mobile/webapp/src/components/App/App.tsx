import { useEffect, useRef, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useTauriCommands, invokeStrict, listen } from '@/hooks/useTauri';
import { useAppStore } from '@/store';
import type { ActiveSection, ConnectionStatus } from '@/store';
import { applyAppearance } from '@/components/ui/applyAppearance';
import { Icon } from '@/components/ui/Icon';
import { AccountGate } from '@/components/Account/AccountGate';
import { readAccountStatus } from '@/components/Account/AccountPanel';
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
  const setActiveSection = useAppStore((s) => s.setActiveSection);
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [updateNotice, setUpdateNotice] = useState<string | null>(null);

  // Check for updates before login too; updating must not depend on an account session.
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    const applyUpdateStatus = (raw: unknown) => {
      const status = normalizeUpdateStatus(raw);
      if (disposed) return;
      if (status.status.kind === 'available') {
        setUpdateAvailable(true);
        setUpdateNotice(status.latestVersion ?? 'Hay una versión nueva disponible');
      } else if (status.status.kind === 'upToDate') {
        setUpdateAvailable(false);
        setUpdateNotice(null);
      }
    };

    void (async () => {
      try {
        unlisten = await listen<unknown>('update://status', (event) => applyUpdateStatus(event.payload));
        if (disposed) { unlisten(); return; }
        applyUpdateStatus(await invokeStrict('check_for_update'));
      } catch { /* el panel de Actualizaciones conserva el detalle de errores */ }
    })();
    return () => { disposed = true; unlisten?.(); };
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
  const setAccount = useAppStore((s) => s.setAccount);
  const updateAppearance = useAppStore((s) => s.updateAppearance);

  // La sesión se lee UNA vez al arrancar, antes de nada. Si esto no corre, el
  // gate queda con `account === null` y deja pasar al chat sin haber comprobado
  // la sesión: el fallo silencioso de un gate es abrir la puerta de entrada.
  useEffect(() => {
    void (async () => {
      try {
        setAccount(await readAccountStatus());
      } catch (error) {
        console.error('Failed to read account status:', error);
      }
    })();
  }, [setAccount]);

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

  // Seguir el tema del sistema en tiempo real; oscuro original como fallback.
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      updateAppearance({ mode: 'dark' });
      return;
    }
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => updateAppearance({ mode: mq.matches ? 'dark' : 'light' });
    apply();
    const listener = (event: MediaQueryListEvent) => {
      updateAppearance({ mode: event.matches ? 'dark' : 'light' });
    };
    try { mq.addEventListener('change', listener); } catch {
      mq.addListener(listener as any);
    }
    return () => {
      try { mq.removeEventListener('change', listener); } catch {
        mq.removeListener(listener as any);
      }
    };
  }, [updateAppearance]);

  useEffect(() => {
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

  // Aplica la apariencia activa al arrancar y ante cada cambio.
  useEffect(() => {
    applyAppearance(appearance);
  }, [appearance]);

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
      <div className="app-topbar" data-tauri-drag-region>
        <div className="app-brand">
          <span className="app-brand-name">Apollo</span>
        </div>
        <button type="button" title="Actualizaciones" onClick={() => setActiveSection('settings')} style={{position:"relative",background:"transparent",border:"none",color:"inherit",cursor:"pointer",marginRight:8}}>U{updateAvailable && <span style={{position:"absolute",top:2,right:2,width:8,height:8,borderRadius:"50%",background:"#ff6a4a"}} />}</button>
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
