import { useState, useRef, useEffect } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useTauriCommands } from '@/hooks/useTauri';
import { useAppStore } from '@/store';
import { theme } from '@/theme';

export function ChatWindow() {
  const {
    sendText,
    hideChat,
    pcOpenApp,
    pcFocusApp,
    pcCloseApp,
    pcLockScreen,
    pcListApps,
  } = useTauriCommands();
  const { messages, connectionStatus, clearMessages, sidecarRunning } = useAppStore();
  const addMessage = useAppStore((s) => s.addMessage);
  const [input, setInput] = useState('');
  const [showCommands, setShowCommands] = useState(false);
  const [inputFocused, setInputFocused] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim()) return;

    const text = input.trim();
    setInput('');

    addMessage({ role: 'user', content: text });

    if (text.startsWith('/')) {
      await handleCommand(text);
      return;
    }

    if (!sidecarRunning) {
      addMessage({
        role: 'system',
        content:
          '⚠️ Apollo sin conexión. Abrí Configuración (⌘⇧S) y cargá Worker URL + Shared Secret.',
      });
      return;
    }

    try {
      await sendText(text);
    } catch (err) {
      addMessage({
        role: 'system',
        content:
          '❌ Error al enviar: ' + (err instanceof Error ? err.message : String(err)),
      });
    }
  };

  const handleCommand = async (text: string) => {
    const parts = text.slice(1).split(' ');
    const cmd = parts[0].toLowerCase();
    const args = parts.slice(1).join(' ');

    const info = (m: string) => addMessage({ role: 'system', content: m });

    switch (cmd) {
      case 'open':
        if (args) {
          info(`▶ Abriendo ${args}...`);
          try {
            await pcOpenApp(args);
          } catch {
            info('❌ No se pudo abrir');
          }
        } else info('Uso: /open <app>');
        break;
      case 'focus':
        if (args) {
          info(`▶ Enfocando ${args}...`);
          try {
            await pcFocusApp(args);
          } catch {
            info('❌ No se pudo enfocar');
          }
        } else info('Uso: /focus <app>');
        break;
      case 'close':
        if (args) {
          info(`▶ Cerrando ${args}...`);
          try {
            await pcCloseApp(args);
          } catch {
            info('❌ No se pudo cerrar');
          }
        } else info('Uso: /close <app>');
        break;
      case 'lock':
        info('▶ Bloqueando pantalla...');
        try {
          await pcLockScreen();
        } catch {
          info('❌ No se pudo bloquear');
        }
        break;
      case 'apps':
        info('▶ Cargando aplicaciones...');
        try {
          await pcListApps();
          info(
            'Apps disponibles: Chrome, Edge, notepad, calc, explorer, code, spotify, discord, steam, slack, teams, outlook, winword, excel, powerpnt. Usa /open <nombre>',
          );
        } catch {
          info(
            'Apps comunes: /open notepad · /open calc · /open explorer · /open chrome',
          );
        }
        break;
      case 'clear':
        clearMessages();
        break;
      case 'help':
        info(`Comandos disponibles:
/open <app> · /focus <app> · /close <app> · /lock · /apps · /clear · /help`);
        break;
      default:
        info(`Comando desconocido: /${cmd}. Usa /help.`);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
    if (e.key === '/' && input === '') {
      e.preventDefault();
      setShowCommands(true);
    }
  };

  const connected =
    connectionStatus.status === 'connected' ||
    connectionStatus.status === 'authenticated';
  const statusColor = connected
    ? theme.color.primarySoft
    : connectionStatus.status === 'connecting'
      ? theme.color.warn
      : connectionStatus.status === 'error'
        ? theme.color.danger
        : theme.color.textFaint;

  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        background: theme.color.background,
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: '12px 16px',
          borderBottom: `1px solid ${theme.color.borderSoft}`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          background: theme.color.panel,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div
            style={{
              width: 8,
              height: 8,
              borderRadius: '50%',
              background: statusColor,
              boxShadow: connected ? `0 0 8px 2px ${theme.color.primary}` : 'none',
            }}
          />
          <span style={{ fontWeight: 600, fontSize: 14, color: theme.color.text }}>
            <span style={{ color: theme.color.primarySoft }}>●</span> Apollo Chat
          </span>
          <span
            className="mono"
            style={{
              fontSize: 11,
              color: statusColor,
              background: theme.color.primaryGhost,
              border: `1px solid ${theme.color.border}`,
              padding: '2px 8px',
              borderRadius: 10,
            }}
          >
            {connectionStatus.status}
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center' }}>
          <button
            onClick={hideChat}
            style={{
              padding: '6px 12px',
              background: 'transparent',
              border: `1px solid ${theme.color.border}`,
              borderRadius: 8,
              color: theme.color.textDim,
              fontSize: 12,
              cursor: 'pointer',
              marginRight: 8,
            }}
            title="Ocultar chat"
          >
            Ocultar
          </button>
          <button
            title="Minimizar"
            onClick={async () => {
              try {
                await getCurrentWindow().minimize();
              } catch {}
            }}
            style={{
              width: 30,
              height: 30,
              marginLeft: 4,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: 'transparent',
              border: `1px solid ${theme.color.border}`,
              borderRadius: 8,
              color: theme.color.textDim,
              cursor: 'pointer',
            }}
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M5 12h14" />
            </svg>
          </button>
          <button
            title="Maximizar"
            onClick={async () => {
              try {
                await getCurrentWindow().toggleMaximize();
              } catch {}
            }}
            style={{
              width: 30,
              height: 30,
              marginLeft: 4,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: 'transparent',
              border: `1px solid ${theme.color.border}`,
              borderRadius: 8,
              color: theme.color.textDim,
              cursor: 'pointer',
            }}
          >
            <svg
              width="11"
              height="11"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <rect x="5" y="5" width="14" height="14" rx="2" />
            </svg>
          </button>
          <button
            title="Cerrar ventana"
            onClick={async () => {
              try {
                await getCurrentWindow().close();
              } catch {}
            }}
            style={{
              width: 30,
              height: 30,
              marginLeft: 4,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: 'transparent',
              border: '1px solid rgba(255,106,74,0.35)',
              borderRadius: 8,
              color: '#ff8a72',
              cursor: 'pointer',
            }}
          >
            <svg
              width="12"
              height="12"
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

      {/* Messages */}
      <div
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: 16,
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
        }}
      >
        {messages.length === 0 && (
          <div
            style={{
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              color: theme.color.textFaint,
              textAlign: 'center',
              padding: 32,
            }}
          >
            <div
              style={{
                width: 56,
                height: 56,
                borderRadius: '50%',
                background: `radial-gradient(circle, ${theme.color.primarySoft} 0%, ${theme.color.primary} 45%, transparent 70%)`,
                boxShadow: `0 0 32px ${theme.color.primary}`,
                marginBottom: 16,
              }}
            />
            <p style={{ marginBottom: 8, color: theme.color.label }}>
              No hay mensajes aún
            </p>
            <p style={{ fontSize: 12 }}>Di "Juana" o escribe un mensaje para empezar</p>
            <p
              className="mono"
              style={{
                fontSize: 11,
                marginTop: 16,
                color: theme.color.textFaint,
                lineHeight: 1.8,
              }}
            >
              <span style={{ color: theme.color.primarySoft }}>•</span> /open{' '}
              <span style={{ color: theme.color.textFaint }}>/focus /close /lock</span>
              <br />
              <span style={{ color: theme.color.primarySoft }}>•</span> /apps /clear /help
            </p>
          </div>
        )}

        {messages.map((msg) => (
          <div
            key={msg.id}
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 4,
              maxWidth: '85%',
              alignSelf:
                msg.role === 'user'
                  ? 'flex-end'
                  : msg.role === 'system'
                    ? 'center'
                    : 'flex-start',
            }}
          >
            <div
              style={{
                padding: '10px 14px',
                borderRadius:
                  msg.role === 'user' ? '18px 18px 4px 18px' : '18px 18px 18px 4px',
                background:
                  msg.role === 'user'
                    ? 'rgba(139, 92, 246, 0.12)'
                    : msg.role === 'system'
                      ? 'transparent'
                      : theme.color.panelAlt,
                border:
                  msg.role === 'user'
                    ? `1px solid ${theme.color.primary}`
                    : msg.role === 'system'
                      ? `1px dashed ${theme.color.border}`
                      : `1px solid ${theme.color.borderSoft}`,
                color: msg.role === 'system' ? theme.color.textDim : theme.color.text,
                fontSize: msg.role === 'system' ? 12 : 14,
                fontFamily: msg.role === 'system' ? theme.font.mono : 'inherit',
                lineHeight: 1.5,
                wordWrap: 'break-word',
                whiteSpace: 'pre-wrap',
                boxShadow:
                  msg.role === 'user'
                    ? `0 0 16px rgba(139, 92, 246, 0.25)`
                    : '0 2px 8px rgba(0,0,0,0.3)',
              }}
            >
              {msg.role === 'system' && (
                <span style={{ color: theme.color.primarySoft }}>• </span>
              )}
              {msg.content}
            </div>
            <div
              className="mono"
              style={{
                fontSize: 10,
                color: theme.color.textFaint,
                padding: '0 4px',
                alignSelf:
                  msg.role === 'user'
                    ? 'flex-end'
                    : msg.role === 'system'
                      ? 'center'
                      : 'flex-start',
              }}
            >
              {new Date(msg.timestamp).toLocaleTimeString([], {
                hour: '2-digit',
                minute: '2-digit',
              })}
            </div>
          </div>
        ))}

        <div ref={messagesEndRef} />
      </div>

      {/* Command suggestions */}
      {showCommands && (
        <div
          style={{
            position: 'absolute',
            bottom: 80,
            left: 16,
            right: 16,
            background: theme.color.panel,
            border: `1px solid ${theme.color.border}`,
            borderRadius: 12,
            padding: 8,
            maxHeight: 200,
            overflowY: 'auto',
            zIndex: 10,
          }}
        >
          {(
            [
              '/open <app>',
              '/focus <app>',
              '/close <app>',
              '/lock',
              '/apps',
              '/clear',
              '/help',
            ] as const
          ).map((cmd) => (
            <div
              key={cmd}
              onClick={() => {
                setInput(cmd + ' ');
                setShowCommands(false);
                inputRef.current?.focus();
              }}
              className="mono"
              style={{
                padding: '8px 12px',
                fontSize: 13,
                color: theme.color.label,
                cursor: 'pointer',
                borderRadius: 6,
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = theme.color.primaryGhost;
                e.currentTarget.style.color = theme.color.primarySoft;
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'transparent';
                e.currentTarget.style.color = theme.color.label;
              }}
            >
              <span style={{ color: theme.color.primarySoft }}>• </span>
              {cmd}
            </div>
          ))}
        </div>
      )}

      {/* Input */}
      <form
        onSubmit={handleSubmit}
        style={{
          padding: 16,
          background: theme.color.panel,
          borderTop: `1px solid ${theme.color.borderSoft}`,
        }}
      >
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Escribe un mensaje o /comando..."
            style={{
              flex: 1,
              minHeight: 44,
              maxHeight: 120,
              padding: '10px 14px',
              background: theme.color.background,
              border: `1px solid ${inputFocused ? theme.color.primary : theme.color.border}`,
              boxShadow: inputFocused
                ? `0 0 0 1px ${theme.color.primary}, 0 0 16px rgba(139, 92, 246, 0.25)`
                : 'none',
              borderRadius: 22,
              color: theme.color.text,
              fontSize: 14,
              fontFamily: 'inherit',
              resize: 'none',
              outline: 'none',
              lineHeight: 1.5,
              transition: 'border-color 0.2s, box-shadow 0.2s',
            }}
            onFocus={() => {
              setShowCommands(false);
              setInputFocused(true);
            }}
            onBlur={() => setInputFocused(false)}
          />
          <button
            type="submit"
            disabled={!input.trim()}
            style={{
              width: 44,
              height: 44,
              borderRadius: '50%',
              background: input.trim() ? theme.color.primary : theme.color.border,
              border: 'none',
              color: '#fff',
              cursor: input.trim() ? 'pointer' : 'not-allowed',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              transition: 'all 0.2s',
              boxShadow: input.trim() ? `0 0 16px rgba(139, 92, 246, 0.5)` : 'none',
            }}
          >
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
            >
              <line x1="22" y1="2" x2="11" y2="13" />
              <polygon points="22 2 15 22 11 13 2 9 22 2" />
            </svg>
          </button>
        </div>
      </form>
    </div>
  );
}
