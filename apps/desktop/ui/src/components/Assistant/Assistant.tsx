import { useMemo, useState } from 'react';
import { useTauriCommands } from '@/hooks/useTauri';
import { useAppStore } from '@/store';
import { Icon, ApolloMark } from '@/components/ui/Icon';
import { Orb, toOrbVoiceState } from '@/components/Orb/Orb';
import { Composer } from '@/components/Chat/Composer';
import '../Chat/Composer.css';
import './Assistant.css';

interface Suggestion {
  pre: string;
  hl: string;
  color: string;
  send?: string;
}

// Sugerencias Apollo en español; send opcional ejecuta comando real (/open...).
const SUGGESTIONS: Suggestion[] = [
  { pre: 'Abrí', hl: 'el navegador', color: '#42E8E0', send: '/open https://www.google.com' },
  { pre: '¿Qué hora', hl: 'es?', color: '#67D9FF' },
  { pre: 'Poné', hl: 'música', color: '#63F2B0', send: '/open spotify' },
  { pre: 'Contame', hl: 'las noticias', color: '#42E8E0' },
  { pre: 'Abrí', hl: 'la calculadora', color: '#67D9FF', send: '/open calc' },
  { pre: '¿Cómo está', hl: 'el clima?', color: '#63F2B0' },
  { pre: 'Abrí', hl: 'el explorador', color: '#42E8E0', send: '/open explorer' },
  { pre: 'Resumí', hl: 'mi día', color: '#67D9FF' },
  { pre: 'Tomá', hl: 'una nota', color: '#63F2B0', send: '/open notepad' },
];

const rows = (list: Suggestion[], n = 3) =>
  Array.from({ length: n }, (_, r) => list.filter((_, i) => i % n === r));

const QUICK_APPS = [
  { title: 'Abrir navegador', appName: 'https://www.google.com', icon: 'globe' },
  { title: 'Explorador de archivos', appName: 'explorer', icon: 'home' },
  { title: 'Notas rápidas', appName: 'notepad', icon: 'edit' },
  { title: 'Calculadora', appName: 'calc', icon: 'clock' },
] as const;

export function Assistant() {
  const {
    sendText,
    pcOpenApp,
    pcFocusApp,
    pcCloseApp,
    pcLockScreen,
    manualListenStart,
    manualListenStop,
    setMicMuted,
    setTtsMuted,
  } = useTauriCommands();
  const orbState = useAppStore((s) => s.orbState);
  const addMessage = useAppStore((s) => s.addMessage);
  const setActiveSection = useAppStore((s) => s.setActiveSection);
  const setVoiceOpen = useAppStore((s) => s.setVoiceOpen);
  const sidecarRunning = useAppStore((s) => s.sidecarRunning);
  const connectionStatus = useAppStore((s) => s.connectionStatus);

  const [text, setText] = useState('');
  const [micHeld, setMicHeld] = useState(false);
  const [micMuted, setMicMutedState] = useState(false);
  const [ttsMuted, setTtsMutedState] = useState(false);

  const marquee = useMemo(() => rows(SUGGESTIONS), []);

  const isConnected =
    sidecarRunning ||
    connectionStatus.status === 'connected' ||
    connectionStatus.status === 'authenticated';
  const busy =
    orbState.state === 'listening' ||
    orbState.state === 'responding' ||
    orbState.state === 'speaking' ||
    orbState.state === 'thinking';

  const statusLabel =
    orbState.caption !== undefined && orbState.caption.trim().length > 0
      ? orbState.caption
      : !isConnected
        ? 'Desconectado'
        : orbState.state === 'listening'
          ? 'Escuchando…'
          : orbState.state === 'thinking'
            ? 'Pensando…'
            : orbState.state === 'responding'
              ? 'Respondiendo…'
              : orbState.state === 'speaking'
                ? 'Hablando…'
                : 'Online';

  const submit = async (raw: string) => {
    const t = raw.trim();
    if (!t) return;
    setText('');
    addMessage({ role: 'user', content: t });

    if (t.startsWith('/')) {
      const parts = t.slice(1).split(' ');
      const cmd = parts[0].toLowerCase();
      const args = parts.slice(1).join(' ');
      switch (cmd) {
        case 'open':
          if (args) {
            addMessage({ role: 'system', content: `Abriendo ${args}...` });
            try { await pcOpenApp(args); } catch { addMessage({ role: 'system', content: 'No se pudo abrir.' }); }
          }
          break;
        case 'focus':
          if (args) {
            addMessage({ role: 'system', content: `Enfocando ${args}...` });
            try { await pcFocusApp(args); } catch { addMessage({ role: 'system', content: 'No se pudo enfocar.' }); }
          }
          break;
        case 'close':
          if (args) {
            addMessage({ role: 'system', content: `Cerrando ${args}...` });
            try { await pcCloseApp(args); } catch { addMessage({ role: 'system', content: 'No se pudo cerrar.' }); }
          }
          break;
        case 'lock':
          addMessage({ role: 'system', content: 'Bloqueando pantalla...' });
          try { await pcLockScreen(); } catch { addMessage({ role: 'system', content: 'No se pudo bloquear.' }); }
          break;
        case 'clear':
          useAppStore.getState().clearMessages();
          return;
        case 'help':
          addMessage({ role: 'system', content: 'Comandos: /open <app> /focus <app> /close <app> /lock /clear /help' });
          break;
        default:
          addMessage({ role: 'system', content: `Comando desconocido: /${cmd}. Usá /help.` });
      }
      setActiveSection('chat');
      return;
    }

    if (!isConnected) {
      addMessage({
        role: 'system',
        content: 'Apollo no está conectado. Abrí Configuración y cargá Worker URL + Shared Secret.',
      });
      setActiveSection('chat');
      return;
    }

    try {
      addMessage({ role: 'assistant', content: '' });
      setActiveSection('chat');
      await sendText(t);
    } catch (e) {
      useAppStore.getState().dropTrailingEmptyAssistant();
      addMessage({ role: 'system', content: `Error al enviar: ${String(e)}` });
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
    } catch {
      setMicMutedState(!next);
    }
  };

  const toggleTts = async () => {
    const next = !ttsMuted;
    setTtsMutedState(next);
    try {
      await setTtsMuted(next);
    } catch {
      setTtsMutedState(!next);
    }
  };

  return (
    <div className="apollo-home">
      <div className="apollo-home-bg" />

      <header className="apollo-home-head">
        <span className="apollo-home-brand">
          <ApolloMark size={26} /> Apollo
        </span>
        <button
          type="button"
          className="apollo-home-round"
          onClick={() => setActiveSection('settings')}
          aria-label="Configuración"
        >
          <Icon n="sliders" />
        </button>
      </header>

      <div className="apollo-home-mid">
        <div className="apollo-home-orb">
          <Orb state={toOrbVoiceState(orbState.state)} size={210} />
        </div>

        <span className={'apollo-status-pill' + (isConnected ? ' on' : '')}>
          <i /> {statusLabel}
        </span>
        <h1 className="apollo-hello">
          Tu asistente <b>personal</b>
        </h1>
        <p className="apollo-sub">¿En qué puedo ayudarte?</p>

        <div className="apollo-marq">
          {marquee.map((r, i) => (
            <div className={'apollo-track t' + i} key={i}>
              {[...r, ...r].map((s, j) => (
                <button
                  type="button"
                  key={j}
                  className="apollo-chip"
                  tabIndex={j < r.length ? 0 : -1}
                  onClick={() => void submit(s.send ?? `${s.pre} ${s.hl}`)}
                >
                  <i className="apollo-chip-ico" style={{ ['--c' as string]: s.color }}>
                    <Icon n="zap" size={14} />
                  </i>
                  <span>
                    {s.pre} <b>{s.hl}</b>
                  </span>
                </button>
              ))}
            </div>
          ))}
        </div>
      </div>

      <div className="apollo-home-foot">
        <Composer
          value={text}
          onChange={setText}
          onSend={() => void submit(text)}
          onStop={() => void manualListenStop()}
          onMic={() => setVoiceOpen(true)}
          busy={busy}
          placeholder="Escribí un mensaje..."
        />
        <div className="apollo-home-tools">
          <button
            type="button"
            className={'apollo-tool' + (micMuted ? ' off' : '')}
            onClick={() => void toggleMic()}
            aria-label={micMuted ? 'Activar micrófono' : 'Silenciar micrófono'}
            aria-pressed={micMuted}
            title={micMuted ? 'Mic silenciado' : 'Mic activo'}
          >
            <Icon n={micMuted ? 'micOff' : 'mic'} size={15} />
          </button>
          <button
            type="button"
            className={'apollo-tool' + (ttsMuted ? ' off' : '')}
            onClick={() => void toggleTts()}
            aria-label={ttsMuted ? 'Activar voz' : 'Silenciar voz'}
            aria-pressed={ttsMuted}
            title={ttsMuted ? 'Voz silenciada' : 'Voz activa'}
          >
            <Icon n={ttsMuted ? 'volOff' : 'vol'} size={15} />
          </button>
          <button
            type="button"
            className={'apollo-tool' + (micHeld ? ' live' : '')}
            onPointerDown={beginManualListen}
            onPointerUp={endManualListen}
            onPointerLeave={endManualListen}
            onPointerCancel={endManualListen}
            onContextMenu={(e) => e.preventDefault()}
            aria-label="Mantener para dictar"
            title="Mantené para dictar"
          >
            <Icon n="kb" size={15} />
          </button>
          <span className="apollo-tools-sep" />
          {QUICK_APPS.map((q) => (
            <button
              key={q.title}
              type="button"
              className="apollo-tool"
              title={q.title}
              aria-label={q.title}
              onClick={() => void submit(`/open ${q.appName}`)}
            >
              <Icon n={q.icon as 'globe' | 'home' | 'edit' | 'clock'} size={15} />
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
