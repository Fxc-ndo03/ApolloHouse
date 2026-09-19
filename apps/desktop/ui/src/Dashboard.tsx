import { useState, useRef, useEffect } from 'react';
import { Eyes, EyeState } from '@/components/Eyes/Eyes';
import { useTauriCommands } from '@/hooks/useTauri';
import { useAppStore } from '@/store';
import { theme } from '@/theme';

type CompactMode = 'full' | 'compact' | 'expanding';

export function Dashboard() {
  const {
    startSidecar,
    sendText,
    getSettings,
    updateSettings,
    manualListenStart,
    manualListenStop,
    pcOpenApp,
    pcFocusApp,
    pcCloseApp,
    pcLockScreen,
  } = useTauriCommands();
  const {
    connectionStatus,
    sidecarRunning,
    messages,
    orbState,
    addMessage,
    clearMessages,
  } = useAppStore();
  const { state: orbMode, caption } = orbState;

  const [commandInput, setCommandInput] = useState('');
  const [compact, setCompact] = useState<CompactMode>('full');
  const [showSettings, setShowSettings] = useState(false);
  const commandInputRef = useRef<HTMLInputElement>(null);

  const [settings, setSettings] = useState({
    workerUrl: '',
    deviceSharedSecret: '',
    wakeWords: 'hey nova,nova,hey apollo',
    useVoskWake: true,
    wakeModelDir: '',
    responseOutputTarget: 'pc' as 'pc' | 'server',
  });
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    const s = useAppStore.getState().settings;
    if (s.workerUrl && s.deviceSharedSecret) startSidecar();
  }, [startSidecar]);

  useEffect(() => {
    loadSettings();
  }, []);

  const loadSettings = async () => {
    try {
      const s = await getSettings();
      setSettings({
        workerUrl: s.worker_url,
        deviceSharedSecret: s.device_shared_secret,
        wakeWords: s.wake_words.join(','),
        useVoskWake: s.use_vosk_wake,
        wakeModelDir: s.wake_model_dir || '',
        responseOutputTarget: s.response_output_target as 'pc' | 'server',
      });
    } catch {}
  };

  const handleSaveSettings = async () => {
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
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch {}
  };

  const handleCommandSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const text = commandInput.trim();
    if (!text) return;
    setCommandInput('');
    addMessage({ role: 'user', content: text });
    if (text.startsWith('/')) {
      await handleSlashCommand(text);
      return;
    }
    await sendText(text);
  };

  const handleSlashCommand = async (text: string) => {
    const parts = text.slice(1).split(' ');
    const cmd = parts[0].toLowerCase();
    const args = parts.slice(1).join(' ');
    switch (cmd) {
      case 'open':
        if (args) await pcOpenApp(args);
        break;
      case 'focus':
        if (args) await pcFocusApp(args);
        break;
      case 'close':
        if (args) await pcCloseApp(args);
        break;
      case 'lock':
        await pcLockScreen();
        break;
      case 'clear':
        clearMessages();
        break;
      case 'compact':
        setCompact('compact');
        break;
      case 'full':
        setCompact('full');
        break;
      case 'help':
        addMessage({
          role: 'system',
          content: '/open /focus /close /lock /clear /compact /full /help',
        });
        break;
    }
  };

  // Keyboard shortcuts: CTRL+SPACE toggles compact/full, ESC = compact
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.code === 'Space') {
        e.preventDefault();
        setCompact((c) => (c === 'full' ? 'compact' : 'full'));
      }
      if (e.key === 'Escape') setCompact('compact');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
  const lastAny = lastAssistant || lastUser;

  const stateLabel: Record<string, string> = {
    idle: 'LISTA',
    listening: 'ESCUCHANDO',
    thinking: 'PENSANDO',
    speaking: 'HABLANDO',
    confirming: 'CONFIRMAR',
    focusing: 'ENFOCADA',
    alarm: 'ALARMA',
    error: 'ERROR',
  };

  // ------------------------- COMPACT MODE -------------------------
  if (compact === 'compact') {
    return (
      <div
        onClick={() => {
          setCompact('expanding');
          setTimeout(() => setCompact('full'), 250);
        }}
        style={{
          width: '100vw',
          height: '100vh',
          background: 'transparent',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: 'pointer',
        }}
        title="Click o Ctrl+Space para expandir · Hey Nova"
      >
        <div
          style={{
            width: 220,
            height: 110,
            borderRadius: 60,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background:
              'radial-gradient(ellipse at 50% 50%, rgba(169,139,255,0.26) 0%, rgba(169,139,255,0.06) 55%, transparent 80%)',
            boxShadow:
              orbMode !== 'idle'
                ? `0 0 44px 6px ${theme.color.primaryGlow}`
                : '0 0 18px 2px rgba(169,139,255,0.22)',
            transition: 'box-shadow 0.3s ease',
          }}
        >
          <Eyes width={200} height={100} state={(orbMode as EyeState) ?? 'idle'} />
        </div>
      </div>
    );
  }

  // ------------------------- FULL HUD MODE -------------------------
  const statusDotColor =
    orbMode === 'idle'
      ? theme.color.primary
      : orbMode === 'listening'
        ? theme.color.primarySoft
        : orbMode === 'thinking'
          ? theme.color.primaryDeep
          : theme.color.primary;

  const hudStyle: React.CSSProperties = {
    width: '100vw',
    height: '100vh',
    background: 'transparent',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: theme.color.text,
    fontFamily: theme.font.sans,
    position: 'relative',
    overflow: 'hidden',
  };

  const hudCardStyle: React.CSSProperties = {
    width: 500,
    maxWidth: 'calc(100vw - 24px)',
    height: 700,
    maxHeight: 'calc(100vh - 24px)',
    borderRadius: 28,
    background: 'linear-gradient(180deg, rgba(13,14,20,0.82) 0%, rgba(8,9,13,0.92) 100%)',
    border: `1px solid rgba(169,139,255,0.14)`,
    backdropFilter: 'blur(26px) saturate(160%)',
    WebkitBackdropFilter: 'blur(26px) saturate(160%)',
    boxShadow:
      '0 30px 90px rgba(0,0,0,0.7), 0 0 0 1px rgba(255,255,255,0.02) inset, 0 1px 0 rgba(255,255,255,0.05) inset, 0 0 80px rgba(169,139,255,0.10)',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    padding: '28px 24px 20px',
    position: 'relative',
  };

  return (
    <div style={hudStyle}>
      {/* soft outer glow */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          pointerEvents: 'none',
          background:
            'radial-gradient(ellipse 60% 55% at 50% 42%, rgba(169,139,255,0.14) 0%, transparent 70%)',
        }}
      />

      <div style={hudCardStyle}>
        {/* TOP: NOVA title + corner actions */}
        <div
          style={{
            width: '100%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: 10,
          }}
        >
          <button
            onClick={() => setCompact('compact')}
            title="Minimizar (Esc)"
            style={{
              width: 30,
              height: 30,
              borderRadius: 10,
              background: 'transparent',
              border: '1px solid rgba(169,139,255,0.12)',
              color: theme.color.textDim,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
            >
              <line x1="5" y1="19" x2="19" y2="19" />
            </svg>
          </button>

          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
            <div
              className="mono"
              style={{
                fontSize: 10,
                letterSpacing: '4px',
                color: theme.color.primary,
                fontWeight: 600,
              }}
            >
              NOVA
            </div>
            <div
              style={{
                marginTop: 2,
                fontSize: 10,
                color: theme.color.textFaint,
                fontFamily: theme.font.mono,
              }}
            >
              {connectionStatus.status}
              {sidecarRunning && (
                <span style={{ color: theme.color.primary, marginLeft: 6 }}>· LIVE</span>
              )}
            </div>
          </div>

          <button
            onClick={() => setShowSettings((v) => !v)}
            title="Settings"
            style={{
              width: 30,
              height: 30,
              borderRadius: 10,
              background: showSettings ? theme.color.primaryGhost : 'transparent',
              border: `1px solid ${showSettings ? 'rgba(169,139,255,0.38)' : 'rgba(169,139,255,0.12)'}`,
              color: showSettings ? theme.color.primarySoft : theme.color.textDim,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="12" cy="12" r="2.4" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </button>
        </div>

        {/* SETTINGS PANEL overlay (mini) */}
        {showSettings && (
          <div
            style={{
              position: 'absolute',
              top: 64,
              right: 24,
              width: 340,
              zIndex: 30,
              padding: 16,
              borderRadius: 18,
              background: 'rgba(16,18,24,0.96)',
              border: '1px solid rgba(169,139,255,0.2)',
              backdropFilter: 'blur(18px)',
              WebkitBackdropFilter: 'blur(18px)',
              boxShadow: '0 20px 60px rgba(0,0,0,0.6)',
              maxHeight: 560,
              overflowY: 'auto',
            }}
          >
            <h3
              style={{
                fontSize: 11,
                color: theme.color.primary,
                letterSpacing: '2px',
                fontWeight: 700,
                marginBottom: 14,
              }}
            >
              AJUSTES · NOVA
            </h3>

            <label
              style={{
                fontSize: 11,
                color: theme.color.label,
                display: 'block',
                marginBottom: 4,
              }}
            >
              Worker URL
            </label>
            <input
              type="text"
              value={settings.workerUrl}
              onChange={(e) => setSettings({ ...settings, workerUrl: e.target.value })}
              style={sField()}
            />

            <label
              style={{
                fontSize: 11,
                color: theme.color.label,
                display: 'block',
                marginBottom: 4,
                marginTop: 10,
              }}
            >
              Device Shared Secret
            </label>
            <input
              type="password"
              value={settings.deviceSharedSecret}
              onChange={(e) =>
                setSettings({ ...settings, deviceSharedSecret: e.target.value })
              }
              style={sField()}
            />

            <label
              style={{
                fontSize: 11,
                color: theme.color.label,
                display: 'block',
                marginBottom: 4,
                marginTop: 10,
              }}
            >
              Wake Words (coma)
            </label>
            <input
              type="text"
              value={settings.wakeWords}
              onChange={(e) => setSettings({ ...settings, wakeWords: e.target.value })}
              style={sField()}
            />

            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                fontSize: 12,
                color: theme.color.text,
                margin: '14px 0 14px',
                cursor: 'pointer',
              }}
            >
              <input
                type="checkbox"
                checked={settings.useVoskWake}
                onChange={(e) =>
                  setSettings({ ...settings, useVoskWake: e.target.checked })
                }
                style={{ accentColor: theme.color.primary, width: 14, height: 14 }}
              />
              Vosk · detección offline
            </label>

            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 6,
                marginBottom: 14,
              }}
            >
              {(['pc', 'server'] as const).map((t) => (
                <label key={t} style={radioLabel(settings.responseOutputTarget === t)}>
                  <input
                    type="radio"
                    checked={settings.responseOutputTarget === t}
                    onChange={() => setSettings({ ...settings, responseOutputTarget: t })}
                    style={{ accentColor: theme.color.primary, width: 13, height: 13 }}
                  />
                  <div>
                    <div style={{ fontSize: 12, color: theme.color.text }}>
                      {t === 'pc' ? 'PC · esta ventana' : 'Dispositivo Juana Manso'}
                    </div>
                    <div style={{ fontSize: 10.5, color: theme.color.textFaint }}>
                      {t === 'pc' ? 'Altavoces locales' : 'Altavoces ESP32 / Galaxy S5'}
                    </div>
                  </div>
                </label>
              ))}
            </div>

            <button onClick={handleSaveSettings} style={primaryBtn(saved)}>
              {saved ? '✓ Guardado' : 'Guardar'}
            </button>

            <div
              className="mono"
              style={{
                marginTop: 14,
                padding: 10,
                borderRadius: 10,
                background: theme.color.panelAlt,
                fontSize: 10,
                color: theme.color.textFaint,
                lineHeight: 1.8,
              }}
            >
              <div>
                <span style={{ color: theme.color.primary }}>Ctrl + Space</span> · modo
                compacto
              </div>
              <div>
                <span style={{ color: theme.color.primary }}>Esc</span> · minimizar
              </div>
              <div>
                <span style={{ color: theme.color.primary }}>Hey Nova</span> · voz
              </div>
            </div>
          </div>
        )}

        {/* EYES */}
        <div style={{ width: 460, height: 280, marginTop: 28, marginBottom: 16 }}>
          <Eyes width={460} height={280} state={(orbMode as EyeState) ?? 'idle'} />
        </div>

        {/* RESPONSE / CHAT TEXT BUBBLE */}
        <div
          style={{
            minHeight: 60,
            width: '100%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '0 8px',
            margin: '2px 0 8px',
          }}
        >
          {caption || lastAny ? (
            <div
              style={{
                maxWidth: '100%',
                padding: '10px 16px',
                borderRadius: 18,
                background: 'rgba(22,25,35,0.85)',
                border: '1px solid rgba(169,139,255,0.16)',
                color: theme.color.text,
                fontSize: 13,
                lineHeight: 1.55,
                textAlign: 'center',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                boxShadow: '0 8px 26px rgba(0,0,0,0.35)',
                animation: 'novaIn 260ms ease-out',
              }}
            >
              {lastAny?.role === 'user' && !caption ? (
                <span style={{ color: theme.color.primarySoft }}>Tú · </span>
              ) : !caption && lastAny?.role === 'system' ? (
                <span style={{ color: theme.color.primarySoft }}>• </span>
              ) : null}
              {caption ?? lastAny?.content}
            </div>
          ) : (
            <div
              style={{
                fontSize: 12,
                color: theme.color.textFaint,
                letterSpacing: '0.5px',
              }}
            >
              Di{' '}
              <span style={{ color: theme.color.primary, fontFamily: theme.font.mono }}>
                Hey Nova
              </span>{' '}
              o escribe un comando
            </div>
          )}
        </div>

        {/* STATUS PILL · DOT */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 8,
            marginBottom: 12,
          }}
        >
          <div
            style={{
              width: 8,
              height: 8,
              borderRadius: '50%',
              background: statusDotColor,
              boxShadow: `0 0 10px 2px ${theme.color.primaryGlow}`,
              animation:
                orbMode === 'listening'
                  ? 'novaPulse 1.1s ease-in-out infinite'
                  : orbMode === 'speaking'
                    ? 'novaPulse 0.6s ease-in-out infinite'
                    : orbMode === 'thinking'
                      ? 'novaPulse 1.6s ease-in-out infinite'
                      : undefined,
            }}
          />
          <div
            className="mono"
            style={{
              fontSize: 10.5,
              letterSpacing: '3px',
              fontWeight: 700,
              color: orbMode === 'idle' ? theme.color.textDim : theme.color.primarySoft,
            }}
          >
            {stateLabel[orbMode] ?? orbMode.toUpperCase()}
          </div>
        </div>

        {/* COMMAND BAR · INPUT */}
        <form
          onSubmit={handleCommandSubmit}
          style={{
            width: '100%',
            marginTop: 'auto',
            padding: 6,
            borderRadius: 999,
            background:
              'linear-gradient(180deg, rgba(22,25,35,0.95), rgba(13,14,20,0.95))',
            border: '1px solid rgba(169,139,255,0.16)',
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            boxShadow: '0 10px 30px rgba(0,0,0,0.45)',
          }}
        >
          <button
            type="button"
            title="Mantener para dictar · Click para toggle"
            onClick={async () => {
              if (orbMode === 'listening') {
                await manualListenStop();
              } else {
                await manualListenStart();
              }
            }}
            onPointerDown={async () => {
              if (orbMode !== 'listening') await manualListenStart();
            }}
            onPointerUp={async () => {
              if (orbMode === 'listening') await manualListenStop();
            }}
            onPointerLeave={async () => {
              if (orbMode === 'listening') await manualListenStop();
            }}
            style={{
              width: 36,
              height: 36,
              borderRadius: '50%',
              border: 'none',
              marginLeft: 2,
              flexShrink: 0,
              cursor: 'pointer',
              background:
                orbMode === 'listening'
                  ? 'radial-gradient(circle at 35% 35%, #C4AEFF, #A98BFF 60%, #8B6BFF 100%)'
                  : 'rgba(26,29,38,1)',
              color: orbMode === 'listening' ? '#fff' : theme.color.primarySoft,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              boxShadow:
                orbMode === 'listening'
                  ? `0 0 18px ${theme.color.primaryGlow}, inset 0 1px 0 rgba(255,255,255,0.3)`
                  : 'inset 0 1px 0 rgba(255,255,255,0.05)',
            }}
          >
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.3"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect x="9" y="2" width="6" height="12" rx="3" />
              <path d="M5 10a7 7 0 0 0 14 0" />
              <line x1="12" y1="19" x2="12" y2="22" />
              <line x1="8" y1="22" x2="16" y2="22" />
            </svg>
          </button>

          <input
            ref={commandInputRef}
            value={commandInput}
            onChange={(e) => setCommandInput(e.target.value)}
            placeholder="Hey Nova...  /open  /focus  /close  /lock  /compact  /help"
            style={{
              flex: 1,
              height: 36,
              background: 'transparent',
              border: 'none',
              outline: 'none',
              color: theme.color.text,
              fontSize: 13,
              fontFamily: 'inherit',
            }}
          />

          <button
            type="submit"
            disabled={!commandInput.trim()}
            style={{
              width: 36,
              height: 36,
              borderRadius: '50%',
              border: 'none',
              marginRight: 2,
              flexShrink: 0,
              cursor: commandInput.trim() ? 'pointer' : 'not-allowed',
              background: commandInput.trim()
                ? 'linear-gradient(180deg, #C4AEFF, #8B6BFF)'
                : 'rgba(26,29,38,1)',
              color: '#fff',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              boxShadow: commandInput.trim()
                ? `0 6px 18px rgba(139,107,255,0.45), inset 0 1px 0 rgba(255,255,255,0.3)`
                : 'inset 0 1px 0 rgba(255,255,255,0.05)',
            }}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <line x1="22" y1="2" x2="11" y2="13" />
              <polygon points="22 2 15 22 11 13 2 9 22 2" />
            </svg>
          </button>
        </form>
      </div>

      {/* keyframes */}
      <style>{`
        @keyframes novaPulse {
          0%, 100% { transform: scale(1);   opacity: 1; }
          50%      { transform: scale(1.8); opacity: 0.45; }
        }
        @keyframes novaIn {
          from { transform: translateY(6px) scale(0.985); opacity: 0; }
          to   { transform: translateY(0)   scale(1);     opacity: 1; }
        }
      `}</style>
    </div>
  );
}

// ------------------------- helpers -------------------------
function sField(): React.CSSProperties {
  return {
    width: '100%',
    padding: '8px 10px',
    borderRadius: 10,
    background: theme.color.panelAlt,
    border: `1px solid ${theme.color.border}`,
    color: theme.color.text,
    fontSize: 12,
    outline: 'none',
    fontFamily: theme.font.mono,
  };
}

function radioLabel(active: boolean): React.CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '8px 10px',
    borderRadius: 10,
    background: active ? 'rgba(169,139,255,0.10)' : 'transparent',
    border: active ? '1px solid rgba(169,139,255,0.32)' : '1px solid transparent',
    cursor: 'pointer',
  };
}

function primaryBtn(saved: boolean): React.CSSProperties {
  return {
    width: '100%',
    padding: '10px 14px',
    borderRadius: 12,
    border: 'none',
    cursor: saved ? 'default' : 'pointer',
    background: saved
      ? 'linear-gradient(180deg, #C4AEFF, #8B6BFF)'
      : 'linear-gradient(180deg, #C4AEFF 0%, #8B6BFF 100%)',
    color: '#fff',
    fontSize: 12.5,
    fontWeight: 600,
    letterSpacing: '0.4px',
    boxShadow: '0 10px 24px rgba(139,107,255,0.35), inset 0 1px 0 rgba(255,255,255,0.3)',
  };
}
