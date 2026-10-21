import { useEffect, useRef, useState } from 'react';
import type { ChatMessage } from '@/store';
import { Icon, ApolloMark } from '@/components/ui/Icon';

export function UserBubble({ m }: { m: ChatMessage }) {
  return (
    <div className="apollo-msg user">
      <div className="apollo-bubble-user">{m.content}</div>
      <time className="apollo-msg-time">
        {new Date(m.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
      </time>
    </div>
  );
}

interface BotProps {
  m: ChatMessage;
  thinking: boolean;
  last: boolean;
  copied: boolean;
  vote?: 'up' | 'down';
  onCopy: () => void;
  onVote: (v: 'up' | 'down') => void;
  onFollow: (t: string) => void;
}

const FOLLOW_UPS = ['Contame más', 'Dame un ejemplo', 'Más corto'];

export function BotBubble({ m, thinking, last, copied, vote, onCopy, onVote, onFollow }: BotProps) {
  const [rendered, setRendered] = useState(m.content);
  const raf = useRef(0);

  // Revelado progresivo del stream real: limita cuánto se pinta por frame
  // para una transición suave, sin retrasar ni simular el backend.
  useEffect(() => {
    const target = m.content;
    if (rendered === target) return;
    if (rendered.length > target.length || target.startsWith(rendered) === false) {
      setRendered(target);
      return;
    }
    const tick = () => {
      setRendered((cur) => {
        if (cur === target) return cur;
        const next = target.slice(0, cur.length + 24);
        if (next !== target) raf.current = requestAnimationFrame(tick);
        return next;
      });
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [m.content, rendered]);

  const done = !thinking;
  return (
    <div className="apollo-msg bot">
      <div className="apollo-bot-name">
        <ApolloMark size={22} /> Apollo
      </div>

      <div className={'apollo-bubble-bot' + (thinking ? ' thinking' : '')}>
        {thinking && !rendered ? (
          <span className="apollo-think">
            Thinking <i />
            <i />
            <i />
          </span>
        ) : (
          rendered
        )}
      </div>

      {done && (
        <div className="apollo-msg-acts">
          <button
            type="button"
            onClick={onCopy}
            aria-label="Copiar"
            className={copied ? 'on' : ''}
          >
            <Icon n={copied ? 'check' : 'copy'} size={14} />
          </button>
          <button
            type="button"
            onClick={() => onVote('up')}
            aria-label="Buena respuesta"
            aria-pressed={vote === 'up'}
            className={vote === 'up' ? 'on' : ''}
          >
            <Icon n="up" size={14} />
          </button>
          <button
            type="button"
            onClick={() => onVote('down')}
            aria-label="Mala respuesta"
            aria-pressed={vote === 'down'}
            className={vote === 'down' ? 'on' : ''}
          >
            <Icon n="down" size={14} />
          </button>
        </div>
      )}

      {done && last && (
        <div className="apollo-follow">
          {FOLLOW_UPS.map((t, i) => (
            <button
              key={t}
              type="button"
              style={{ animationDelay: `${0.1 + i * 0.07}s` }}
              onClick={() => onFollow(t)}
            >
              <i /> {t}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function SystemBubble({ m }: { m: ChatMessage }) {
  return (
    <div className="apollo-msg sys">
      <div className="apollo-bubble-sys">{m.content}</div>
    </div>
  );
}
