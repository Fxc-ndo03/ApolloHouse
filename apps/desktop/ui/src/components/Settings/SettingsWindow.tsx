import { useState, useEffect } from 'react';
import type { ReactNode, CSSProperties } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useTauriCommands } from '@/hooks/useTauri';
import { theme } from '@/theme';

const labelStyle: CSSProperties = {
  display: 'block',
  marginBottom: 6,
  fontSize: 13,
  fontWeight: 500,
  color: theme.color.label,
};

const hintStyle: CSSProperties = {
  fontSize: 11,
  color: theme.color.textFaint,
  marginTop: 4,
};

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div
      style={{
        marginBottom: 24,
        paddingBottom: 24,
        borderBottom: `1px solid ${theme.color.borderSoft}`,
      }}
    >
      <h2
        style={{
          fontSize: 13,
          fontWeight: 700,
          color: theme.color.primarySoft,
          marginBottom: 16,
          textTransform: 'uppercase',
          letterSpacing: '1px',
        }}
      >
        <span style={{ color: theme.color.primary }}>• </span>
        {title}
      </h2>
      {children}
    </div>
  );
}

function Field({
  label,
  hint,
  focused,
  children,
}: {
  label: string;
  hint?: ReactNode;
  focused?: boolean;
  children: ReactNode;
}) {
  return (
    <div style={{ marginBottom: 16 }}>
      <label style={labelStyle}>{label}</label>
      <div
        style={{
          border: `1px solid ${focused ? theme.color.primary : theme.color.border}`,
          boxShadow: focused
            ? `0 0 0 1px ${theme.color.primary}, 0 0 16px rgba(139, 92, 246, 0.25)`
            : 'none',
          borderRadius: 8,
          transition: 'border-color 0.2s, box-shadow 0.2s',
        }}
      >
        {children}
      </div>
      {hint && <p style={hintStyle}>{hint}</p>}
    </div>
  );
}

const bareInput: CSSProperties = {
  width: '100%',
  padding: '10px 12px',
  background: theme.color.panel,
  border: 'none',
  borderRadius: 8,
  color: theme.color.text,
  fontSize: 13,
  fontFamily: 'inherit',
  outline: 'none',
};

export function SettingsWindow() {
  const {
    getSettings,
    updateSettings,
    getAutostartEnabled,
    setAutostartEnabled,
    startSidecar,
    stopSidecar,
  } = useTauriCommands();

  const [settings, setSettings] = useState({
    workerUrl: '',
    deviceSharedSecret: '',
    wakeWords: 'juana,hey juana',
    useVoskWake: true,
    wakeModelDir: '',
    responseOutputTarget: 'pc' as 'pc' | 'server',
    autostartEnabled: true,
    // Local Core LAN settings
    useLocalCore: true,
    coreLanUrl: 'ws://192.168.100.8:9876',
  });
  const [saved, setSaved] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [focusedField, setFocusedField] = useState<string | null>(null);

  useEffect(() => {
    loadSettings();
  }, []);

  const loadSettings = async () => {
    try {
      const s = await getSettings();
      let autostartEnabled = s.autostart_enabled ?? true;
      try {
        const liveAutostart = await getAutostartEnabled();
        if (typeof liveAutostart === 'boolean') autostartEnabled = liveAutostart;
      } catch {}
      setSettings({
        workerUrl: s.worker_url,
        deviceSharedSecret: s.device_shared_secret,
        wakeWords: s.wake_words.join(','),
        useVoskWake: s.use_vosk_wake,
        wakeModelDir: s.wake_model_dir || '',
        responseOutputTarget: s.response_output_target as 'pc' | 'server',
        autostartEnabled,
        // Local Core LAN settings
        useLocalCore: s.use_local_core ?? true,
        coreLanUrl: s.core_lan_url || 'ws://192.168.100.8:9876',
      });
    } catch (e) {
      console.error('Failed to load settings:', e);
    }
  };

  const handleSave = async () => {
    try {
      await updateSettings({
        worker_url: settings.workerUrl,
        device_shared_secret: settings.deviceSharedSecret,
        wake_words: settings.wakeWords
          .split(',')
          .map((w) => w.trim())
          .filter(Boolean),
        use_vosk_wake: settings.useVoskWake,
        wake_model_dir: settings.wakeModelDir || null,
        response_output_target: settings.responseOutputTarget,
        autostart_enabled: settings.autostartEnabled,
        // Local Core LAN settings
        use_local_core: settings.useLocalCore,
        core_lan_url: settings.coreLanUrl,
      });
      try {
        await setAutostartEnabled(settings.autostartEnabled);
      } catch (e) {
        console.error('Failed to apply autostart:', e);
      }
      try {
        await startSidecar();
      } catch (e) {
        console.error('Failed to start sidecar after save:', e);
      }
      setSaved(true);
      setTestResult('✓ Guardado y conectado.');
      setTimeout(() => setSaved(false), 2500);
    } catch (e) {
      console.error('Failed to save settings:', e);
      setTestResult(
        '❌ Error al guardar: ' + (e instanceof Error ? e.message : String(e)),
      );
    }
  };

  const handleTestConnection = async () => {
    if (!settings.workerUrl || !settings.deviceSharedSecret) {
      setTestResult('❌ Faltan Worker URL o Device Shared Secret');
      return;
    }
    setTesting(true);
    setTestResult(null);
    try {
      await startSidecar();
      setTimeout(async () => {
        try {
          await stopSidecar();
        } catch {}
        setTesting(false);
        setTestResult('✓ Conexión OK. Guardar y reiniciar la app.');
      }, 1500);
    } catch (e) {
      setTesting(false);
      setTestResult('❌ Falló: ' + (e instanceof Error ? e.message : String(e)));
    }
  };

  const focusProps = (name: string) => ({
    onFocus: () => setFocusedField(name),
    onBlur: () => setFocusedField((f) => (f === name ? null : f)),
  });

  const winBtn: CSSProperties = {
    width: 32,
    height: 32,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'transparent',
    border: `1px solid ${theme.color.border}`,
    borderRadius: 8,
    color: theme.color.textDim,
    cursor: 'pointer',
  };
  const closeBtn: CSSProperties = { ...winBtn, borderColor: 'rgba(255,106,74,0.35)' };

  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        background: theme.color.background,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: '14px 20px',
          borderBottom: `1px solid ${theme.color.borderSoft}`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          background: theme.color.panel,
        }}
      >
        <h1 style={{ fontSize: 18, fontWeight: 600, color: theme.color.text, margin: 0 }}>
          <span style={{ color: theme.color.primarySoft }}>●</span> Configuración
        </h1>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button
            onClick={loadSettings}
            style={{
              padding: '7px 14px',
              background: 'transparent',
              border: `1px solid ${theme.color.border}`,
              borderRadius: 8,
              color: theme.color.textDim,
              fontSize: 12,
              cursor: 'pointer',
            }}
          >
            Recargar
          </button>
          <button
            title="Minimizar"
            onClick={async () => {
              try {
                await getCurrentWindow().minimize();
              } catch {}
            }}
            style={winBtn}
          >
            <svg
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M5 12h14" />
            </svg>
          </button>
          <button
            title="Cerrar"
            onClick={async () => {
              try {
                await getCurrentWindow().close();
              } catch {}
            }}
            style={{ ...closeBtn, color: '#ff8a72' }}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflowY: 'auto', padding: 24 }}>
        <div style={{ maxWidth: 560, margin: '0 auto' }}>
          {/* Connection */}
          <Section title="Conexión">
            <Field
              label="Worker URL (WebSocket)"
              hint="URL del WebSocket del Apollo Worker"
              focused={focusedField === 'workerUrl'}
            >
              <input
                type="text"
                value={settings.workerUrl}
                onChange={(e) => setSettings({ ...settings, workerUrl: e.target.value })}
                placeholder="wss://apollo.facupapollo.workers.dev/agents/apollo/default"
                style={bareInput}
                {...focusProps('workerUrl')}
              />
            </Field>

            <Field
              label="Device Shared Secret"
              hint="Secreto compartido del dispositivo (desde Cloudflare Worker secrets)"
              focused={focusedField === 'secret'}
            >
              <input
                type="password"
                value={settings.deviceSharedSecret}
                onChange={(e) =>
                  setSettings({ ...settings, deviceSharedSecret: e.target.value })
                }
                placeholder="••••••••••••••••"
                style={bareInput}
                {...focusProps('secret')}
              />
            </Field>

            <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
              <button
                onClick={handleTestConnection}
                disabled={testing}
                style={{
                  padding: '10px 20px',
                  background: theme.color.primary,
                  border: 'none',
                  borderRadius: 8,
                  color: '#fff',
                  fontSize: 13,
                  fontWeight: 500,
                  cursor: testing ? 'not-allowed' : 'pointer',
                  opacity: testing ? 0.7 : 1,
                  boxShadow: '0 0 16px rgba(139, 92, 246, 0.4)',
                }}
              >
                {testing ? 'Probando...' : 'Probar Conexión'}
              </button>
              {testResult && (
                <span
                  className="mono"
                  style={{
                    fontSize: 12,
                    color: testResult.includes('Error')
                      ? theme.color.danger
                      : theme.color.primarySoft,
                  }}
                >
                  {testResult}
                </span>
              )}
            </div>
          </Section>
          {/* Local Core LAN */}
          <Section title="Core Local (LAN)">
            <Field
              label="Usar Core Local (LAN)"
              hint="Conectar directamente a Juana Manso en la red local (desactiva para usar Worker Cloudflare)"
              focused={focusedField === 'useLocalCore'}
            >
              <label
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  cursor: 'pointer',
                  padding: 12,
                  background:
                    settings.useLocalCore ? theme.color.primaryGhost : theme.color.panel,
                  border: `1px solid ${settings.useLocalCore ? theme.color.primary : theme.color.border}`,
                  borderRadius: 8,
                }}
              >
                <input
                  type="checkbox"
                  checked={settings.useLocalCore}
                  onChange={(e) =>
                    setSettings({ ...settings, useLocalCore: e.target.checked })
                  }
                  style={{ width: 18, height: 18, accentColor: theme.color.primary }}
                />
                <div>
                  <div style={{ fontWeight: 500, fontSize: 13, color: theme.color.text }}>
                    Core Local en Juana Manso
                  </div>
                  <div style={{ fontSize: 11, color: theme.color.textDim }}>
                    Apollo Core corre en Juana Manso (LAN), Qwen 0.5B local
                  </div>
                </div>
              </label>
            </Field>
            <Field
              label="Core LAN URL"
              hint="WebSocket URL del Apollo Core en Juana Manso (ej: ws://192.168.100.8:9876)"
              focused={focusedField === 'coreLanUrl'}
            >
              <input
                type="text"
                value={settings.coreLanUrl}
                onChange={(e) =>
                  setSettings({ ...settings, coreLanUrl: e.target.value })
                }
                placeholder="ws://192.168.100.8:9876"
                style={bareInput}
                {...focusProps('coreLanUrl')}
              />
            </Field>
          </Section>
          <Section title="Wake Word (Voz)">
            <Field
              label="Palabras de activación (separadas por coma)"
              hint='Ej: "juana,hey juana,ok apollo"'
              focused={focusedField === 'wakeWords'}
            >
              <input
                type="text"
                value={settings.wakeWords}
                onChange={(e) => setSettings({ ...settings, wakeWords: e.target.value })}
                placeholder="juana,hey juana"
                style={bareInput}
                {...focusProps('wakeWords')}
              />
            </Field>

            <div
              style={{ marginBottom: 16, display: 'flex', alignItems: 'center', gap: 12 }}
            >
              <label
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  cursor: 'pointer',
                  fontSize: 13,
                  color: theme.color.text,
                }}
              >
                <input
                  type="checkbox"
                  checked={settings.useVoskWake}
                  onChange={(e) =>
                    setSettings({ ...settings, useVoskWake: e.target.checked })
                  }
                  style={{ width: 18, height: 18, accentColor: theme.color.primary }}
                />
                Usar Vosk (detección offline, sin cuenta externa)
              </label>
            </div>

            <Field
              label="Directorio de modelos Vosk (opcional)"
              hint={
                <>
                  Por defecto:{' '}
                  <code className="mono" style={{ color: theme.color.textDim }}>
                    juana_client/models
                  </code>
                </>
              }
              focused={focusedField === 'wakeModelDir'}
            >
              <input
                type="text"
                value={settings.wakeModelDir}
                onChange={(e) =>
                  setSettings({ ...settings, wakeModelDir: e.target.value })
                }
                placeholder="juana_client/models"
                style={bareInput}
                {...focusProps('wakeModelDir')}
              />
            </Field>

            <div
              style={{
                padding: 12,
                background: theme.color.panel,
                borderRadius: 8,
                border: `1px solid ${theme.color.borderSoft}`,
                fontSize: 12,
                color: theme.color.textDim,
              }}
            >
              <strong style={{ color: theme.color.primarySoft }}>
                Modelos recomendados:
              </strong>{' '}
              Descarga <code className="mono">vosk-model-small-es-0.42</code> (español) o{' '}
              <code className="mono">vosk-model-small-en-us-0.15</code> (inglés) en el
              directorio indicado. ~40-50 MB cada uno.
            </div>
          </Section>
          {/* Audio Output */}
          <Section title="Salida de Audio">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <label
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  cursor: 'pointer',
                  padding: 12,
                  background:
                    settings.responseOutputTarget === 'pc'
                      ? theme.color.primaryGhost
                      : theme.color.panel,
                  border: `1px solid ${settings.responseOutputTarget === 'pc' ? theme.color.primary : theme.color.border}`,
                  borderRadius: 8,
                }}
              >
                <input
                  type="radio"
                  name="outputTarget"
                  checked={settings.responseOutputTarget === 'pc'}
                  onChange={() =>
                    setSettings({ ...settings, responseOutputTarget: 'pc' })
                  }
                  style={{ width: 18, height: 18, accentColor: theme.color.primary }}
                />
                <div>
                  <div style={{ fontWeight: 500, fontSize: 13, color: theme.color.text }}>
                    PC Principal (esta app)
                  </div>
                  <div style={{ fontSize: 11, color: theme.color.textDim }}>
                    Apollo responde por los altavoces de esta PC
                  </div>
                </div>
              </label>

              <label
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  cursor: 'pointer',
                  padding: 12,
                  background:
                    settings.responseOutputTarget === 'server'
                      ? theme.color.primaryGhost
                      : theme.color.panel,
                  border: `1px solid ${settings.responseOutputTarget === 'server' ? theme.color.primary : theme.color.border}`,
                  borderRadius: 8,
                }}
              >
                <input
                  type="radio"
                  name="outputTarget"
                  checked={settings.responseOutputTarget === 'server'}
                  onChange={() =>
                    setSettings({ ...settings, responseOutputTarget: 'server' })
                  }
                  style={{ width: 18, height: 18, accentColor: theme.color.primary }}
                />
                <div>
                  <div style={{ fontWeight: 500, fontSize: 13, color: theme.color.text }}>
                    Juana Manso (Dispositivo)
                  </div>
                  <div style={{ fontSize: 11, color: theme.color.textDim }}>
                    Apollo responde por el dispositivo físico (ESP32)
                  </div>
                </div>
              </label>
            </div>
          </Section>
          {/* Sistema */}
          <Section title="Sistema">
            <div
              style={{ marginBottom: 16, display: 'flex', alignItems: 'center', gap: 12 }}
            >
              <label
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  cursor: 'pointer',
                  fontSize: 13,
                  color: theme.color.text,
                }}
              >
                <input
                  type="checkbox"
                  checked={settings.autostartEnabled}
                  onChange={async (e) => {
                    const enabled = e.target.checked;
                    setSettings({ ...settings, autostartEnabled: enabled });
                    try {
                      await setAutostartEnabled(enabled);
                    } catch (err) {
                      console.error('Failed to apply autostart:', err);
                    }
                  }}
                  style={{ width: 18, height: 18, accentColor: theme.color.primary }}
                />
                Iniciar con Windows
              </label>
            </div>
            <p style={{ fontSize: 12, color: theme.color.textDim, margin: 0 }}>
              Apollo arranca en segundo plano con el orbe como fondo de escritorio. Se
              aplica al instante, sin esperar a Guardar.
            </p>
          </Section>
          {/* Shortcuts */}{' '}
          <Section title="Atajos de Teclado">
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(2, 1fr)',
                gap: 8,
                fontSize: 12,
                color: theme.color.textDim,
              }}
            >
              {[
                ['Ctrl+Shift+A', 'Abrir Chat'],
                ['Ctrl+Shift+S', 'Abrir Settings'],
                ['Escape', 'Ocultar Orbe'],
                ['Click bandeja', 'Toggle Orbe'],
              ].map(([keys, action]) => (
                <div key={keys}>
                  <kbd
                    className="mono"
                    style={{
                      background: theme.color.panelAlt,
                      padding: '2px 6px',
                      borderRadius: 4,
                      border: `1px solid ${theme.color.border}`,
                      color: theme.color.primarySoft,
                    }}
                  >
                    {keys}
                  </kbd>{' '}
                  {action}
                </div>
              ))}
            </div>
          </Section>
        </div>
      </div>

      {/* Footer */}
      <div
        style={{
          padding: '16px 24px',
          borderTop: `1px solid ${theme.color.borderSoft}`,
          background: theme.color.panel,
          display: 'flex',
          justifyContent: 'flex-end',
          gap: 12,
        }}
      >
        <button
          onClick={handleSave}
          disabled={saved}
          style={{
            padding: '10px 24px',
            background: saved ? theme.color.ok : theme.color.primary,
            border: 'none',
            borderRadius: 8,
            color: '#fff',
            fontSize: 13,
            fontWeight: 500,
            cursor: saved ? 'not-allowed' : 'pointer',
            boxShadow: '0 0 16px rgba(139, 92, 246, 0.4)',
          }}
        >
          {saved ? '✓ Guardado' : 'Guardar Cambios'}
        </button>
      </div>
    </div>
  );
}
