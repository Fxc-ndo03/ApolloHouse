import { useState, useRef, useEffect } from 'react';
import { useTauriCommands } from '@/hooks/useTauri';
import { useAppStore } from '@/store';
import { Composer } from './Composer';
import { UserBubble, BotBubble, SystemBubble } from './MessageBubble';
import './Composer.css';
import './Chat.css';

const EMPTY_SUGGESTIONS = ['¿En qué podés ayudarme?', 'Abrí el navegador', 'Contame una novedad'];

export function ChatView() {
  const {
    sendText,
    pcOpenApp,
    pcFocusApp,
    pcCloseApp,
    pcLockScreen,
    pcListApps,
    manualListenStop,
  } = useTauriCommands();
  const messages = useAppStore((s) => s.messages);
  const addMessage = useAppStore((s) => s.addMessage);
  const clearMessages = useAppStore((s) => s.clearMessages);
  const setActiveSection = useAppStore((s) => s.setActiveSection);
  const setVoiceOpen = useAppStore((s) => s.setVoiceOpen);
  const orbState = useAppStore((s) => s.orbState);
  const sidecarRunning = useAppStore((s) => s.sidecarRunning);
  const connectionStatus = useAppStore((s) => s.connectionStatus);

  const [input, setInput] = useState('');
  const [showCommands, setShowCommands] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [votes, setVotes] = useState<Record<string, 'up' | 'down'>>({});
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => () => clearTimeout(copyTimer.current), []);

  // Al entrar al chat, bajar directo a lo más nuevo.
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  // Auto-scroll: sigue el final si el usuario ya estaba abajo o si acaba de enviar.
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const last = messages[messages.length - 1];
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 140;
    if (near || last?.role === 'user') el.scrollTop = el.scrollHeight;
  }, [messages]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const connected =
    sidecarRunning ||
    connectionStatus.status === 'connected' ||
    connectionStatus.status === 'authenticated';

  const busy =
    orbState.state === 'listening' ||
    orbState.state === 'responding' ||
    orbState.state === 'speaking' ||
    orbState.state === 'thinking';

  const last = messages[messages.length - 1];
  const firstUser = messages.find((m) => m.role === 'user');
  const status =
    orbState.state === 'thinking'
      ? 'Thinking…'
      : orbState.state === 'responding'
        ? last?.role === 'assistant' && last.content
          ? 'Typing…'
          : 'Thinking…'
        : orbState.state === 'speaking'
          ? 'Hablando…'
          : orbState.state === 'listening'
            ? 'Escuchando…'
            : 'Online';

  const submitText = async (raw: string) => {
    const text = raw.trim();
    if (!text) return;
    setInput('');
    addMessage({ role: 'user', content: text });

    if (text.startsWith('/')) {
      await handleCommand(text);
      return;
    }

    if (!connected) {
      addMessage({
        role: 'system',
        content: 'Apollo no está conectado. Abrí Configuración y cargá Worker URL + Shared Secret.',
      });
      return;
    }

    try {
      addMessage({ role: 'assistant', content: '' });
      await sendText(text);
    } catch (err) {
      useAppStore.getState().dropTrailingEmptyAssistant();
      addMessage({
        role: 'system',
        content: 'Error al enviar: ' + (err instanceof Error ? err.message : String(err)),
      });
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    void submitText(input);
  };

  const handleCommand = async (text: string) => {
    const parts = text.slice(1).split(' ');
    const cmd = parts[0].toLowerCase();
    const args = parts.slice(1).join(' ');

    const info = (m: string) => addMessage({ role: 'system', content: m });

    switch (cmd) {
      case 'open':
        if (args) {
          info(`Abriendo ${args}...`);
          try { await pcOpenApp(args); } catch { info('No se pudo abrir'); }
        } else info('Uso: /open <app>');
        break;
      case 'focus':
        if (args) {
          info(`Enfocando ${args}...`);
          try { await pcFocusApp(args); } catch { info('No se pudo enfocar'); }
        } else info('Uso: /focus <app>');
        break;
      case 'close':
        if (args) {
          info(`Cerrando ${args}...`);
          try { await pcCloseApp(args); } catch { info('No se pudo cerrar'); }
        } else info('Uso: /close <app>');
        break;
      case 'lock':
        info('Bloqueando pantalla...');
        try { await pcLockScreen(); } catch { info('No se pudo bloquear'); }
        break;
      case 'apps':
        info('Cargando aplicaciones...');
        try {
          await pcListApps();
          info(
            'Apps disponibles: Chrome, Edge, notepad, calc, explorer, code, spotify, discord, steam, slack, teams, outlook, winword, excel, powerpnt. Usá /open <nombre>',
          );
        } catch {
          info('Apps comunes: /open notepad / /open calc / /open explorer / /open chrome');
        }
        break;
      case 'clear':
        clearMessages();
        break;
      case 'help':
        info('Comandos: /open <app> /focus <app> /close <app> /lock /apps /clear /help');
        break;
      default:
        info(`Comando desconocido: /${cmd}. Usá /help.`);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleSubmit(e as unknown as React.FormEvent);
    }
    if (e.key === '/' && input === '') {
      e.preventDefault();
      setShowCommands(true);
    }
  };

  const copy = (id: string, text: string) => {
    navigator.clipboard?.writeText(text).catch(() => {});
    setCopiedId(id);
    clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopiedId(null), 1500);
  };

  const vote = (id: string, v: 'up' | 'down') =>
    setVotes((s) => ({ ...s, [id]: s[id] === v ? undefined as never : v }));

  return (
    <div className="apollo-chat">
      <header className="apollo-chat-head">
        <button
          type="button"
          className="apollo-icon-btn soft"
          onClick={() => setActiveSection('dashboard')}
          aria-label="Volver al inicio"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m15 18-6-6 6-6" /></svg>
        </button>
        <div className="apollo-chat-title">
          <b>{firstUser?.content ?? 'Chat con Apollo'}</b>
          <small key={status} className={status === 'Online' ? '' : 'live'}>
            <i /> {status}
          </small>
        </div>
        <button
          type="button"
          className="apollo-icon-btn"
          onClick={clearMessages}
          aria-label="Nuevo chat"
        >
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></svg>
        </button>
      </header>

      <div className="apollo-chat-list" ref={listRef}>
        {messages.length === 0 ? (
          <div className="apollo-chat-empty">
            <div className="glow" />
            <p>
              <b style={{ color: 'var(--apollo-text)' }}>Sin mensajes todavía</b>
            </p>
            <p>Decí &quot;Apollo&quot; o escribí un mensaje para empezar</p>
            <div className="apollo-chat-suggest">
              {EMPTY_SUGGESTIONS.map((s) => (
                <button key={s} type="button" onClick={() => void submitText(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <>
            <div className="apollo-chat-day">
              <span>Today</span>
            </div>
            {messages.map((m, i) =>
              m.role === 'user' ? (
                <UserBubble key={m.id} m={m} />
              ) : m.role === 'system' ? (
                <SystemBubble key={m.id} m={m} />
              ) : (
                <BotBubble
                  key={m.id}
                  m={m}
                  thinking={m.content === ''}
                  last={i === messages.length - 1}
                  copied={copiedId === m.id}
                  vote={votes[m.id]}
                  onCopy={() => copy(m.id, m.content)}
                  onVote={(v) => vote(m.id, v)}
                  onFollow={(t) => void submitText(t)}
                />
              ),
            )}
          </>
        )}
      </div>

      {showCommands && (
        <div className="apollo-cmds">
          {(['/open <app>', '/focus <app>', '/close <app>', '/lock', '/apps', '/clear', '/help'] as const).map(
            (cmd) => (
              <div
                key={cmd}
                className="apollo-cmd"
                onClick={() => {
                  setInput(cmd + ' ');
                  setShowCommands(false);
                  inputRef.current?.focus();
                }}
              >
                • {cmd}
              </div>
            ),
          )}
        </div>
      )}

      <div className="apollo-chat-foot">
        <Composer
          value={input}
          onChange={(v) => {
            setInput(v);
            if (v) setShowCommands(false);
          }}
          onSend={() => void submitText(input)}
          onStop={() => void manualListenStop()}
          onMic={() => setVoiceOpen(true)}
          busy={busy}
          placeholder="Escribí un mensaje o /comando..."
          inputRef={inputRef}
          onKeyDown={handleKeyDown}
        />
      </div>
    </div>
  );
}
