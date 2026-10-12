import type { Ref } from 'react';
import { Icon } from '@/components/ui/Icon';

interface Props {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  onStop: () => void;
  onMic?: () => void;
  busy: boolean;
  placeholder?: string;
  inputRef?: Ref<HTMLInputElement>;
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
}

/**
 * Un solo botón de acción con 3 estados: detener (ocupado), enviar (hay
 * texto), micrófono (vacío). Usa callbacks reales del backend.
 */
export function Composer({ value, onChange, onSend, onStop, onMic, busy, placeholder, inputRef, onKeyDown }: Props) {
  const hasText = value.trim().length > 0;
  const mode = busy ? 'stop' : hasText ? 'send' : 'mic';
  const act = busy ? onStop : hasText ? onSend : () => onMic?.();

  return (
    <div className="apollo-composer">
      <input
        ref={inputRef}
        className="apollo-composer-input"
        placeholder={placeholder ?? 'Escribí un mensaje...'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (onKeyDown) {
            onKeyDown(e);
            if (e.defaultPrevented) return;
          }
          if (e.key === 'Enter' && !busy && hasText) onSend();
        }}
        aria-label="Mensaje"
      />
      <button
        type="button"
        className={'apollo-composer-btn ' + mode}
        onClick={act}
        aria-label={mode === 'stop' ? 'Detener' : mode === 'send' ? 'Enviar' : 'Voz'}
      >
        {(['stop', 'send', 'mic'] as const).map((m) => (
          <span key={m} className={m === mode ? 'on' : ''}>
            <Icon n={m} size={18} />
          </span>
        ))}
      </button>
    </div>
  );
}
