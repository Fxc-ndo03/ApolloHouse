import { useEffect } from 'react';
import { useTauriCommands } from '@/hooks/useTauri';
import { useAppStore } from '@/store';
import { Icon } from '@/components/ui/Icon';
import { Orb, toOrbVoiceState } from '@/components/Orb/Orb';
import { Waveform } from './Waveform';
import { StreamText } from './StreamText';
import { resetAudioBus } from './audioBus';
import './Voice.css';

const LABEL: Record<string, string> = {
  idle: '',
  listening: 'Escuchando…',
  thinking: 'Pensando…',
  answering: 'Respondiendo…',
};

const CHIPS = [
  { label: 'Profundizar', prompt: 'Contame más' },
  { label: 'Ejemplo', prompt: 'Dame un ejemplo' },
  { label: 'Más corto', prompt: 'Más corto' },
];

export function VoiceOverlay() {
  const { manualListenStart, manualListenStop, sendText } = useTauriCommands();
  const open = useAppStore((s) => s.voiceOpen);
  const setVoiceOpen = useAppStore((s) => s.setVoiceOpen);
  const orbState = useAppStore((s) => s.orbState);
  const messages = useAppStore((s) => s.messages);
  const addMessage = useAppStore((s) => s.addMessage);

  const voice = toOrbVoiceState(orbState.state);

  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
  const transcript = lastUser?.content ?? '';
  const answer = lastAssistant?.content ?? '';

  useEffect(() => {
    if (!open) resetAudioBus();
  }, [open ]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        void manualListenStop();
        setVoiceOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, manualListenStop, setVoiceOpen]);

  if (!open) return null;

  const close = () => {
    if (voice === 'listening') void manualListenStop();
    setVoiceOpen(false);
  };

  const sendPrompt = async (prompt: string) => {
    const t = prompt.trim();
    if (!t) return;
    addMessage({ role: 'user', content: t });
    try {
      addMessage({ role: 'assistant', content: '' });
      await sendText(t);
    } catch (e) {
      useAppStore.getState().dropTrailingEmptyAssistant();
      addMessage({ role: 'system', content: `Error al enviar: ${String(e)}` });
    }
  };

  const main =
    voice === 'idle'
      ? { icon: 'mic' as const, label: 'Hablar', act: () => void manualListenStart() }
      : voice === 'listening'
        ? { icon: 'up' as const, label: 'Enviar', act: () => void manualListenStop() }
        : { icon: 'stop' as const, label: 'Detener', act: () => void manualListenStop() };

  return (
    <div className="apollo-voice" role="dialog" aria-label="Modo voz">
      <Orb state={voice} size={220} />

      <div className="apollo-voice-text">
        <span className="apollo-voice-label">
          {voice === 'idle' && answer
            ? 'Tocá el mic para responder'
            : (orbState.caption?.trim() || LABEL[voice])}
        </span>
        {voice === 'listening' ? (
          <StreamText text={transcript} active />
        ) : (
          <>
            {transcript && <span className="apollo-voice-sub">{transcript}</span>}
            {answer && <StreamText text={answer} active={voice === 'answering'} />}
          </>
        )}
      </div>

      <Waveform state={voice} />

      <div className="apollo-voice-chips">
        {voice === 'idle' &&
          answer &&
          CHIPS.map((c) => (
            <button key={c.label} type="button" className="apollo-voice-chip" onClick={() => void sendPrompt(c.prompt)}>
              {c.label}
            </button>
          ))}
      </div>

      <div className="apollo-voice-bar">
        <button
          type="button"
          className="apollo-voice-btn"
          aria-label="Ir al chat"
          onClick={() => {
            setVoiceOpen(false);
            useAppStore.getState().setActiveSection('chat');
          }}
        >
          <Icon n="kb" size={22} />
        </button>
        <button
          type="button"
          className="apollo-voice-btn main"
          onClick={main.act}
          aria-label={main.label}
        >
          <Icon n={main.icon} size={22} />
        </button>
        <button type="button" className="apollo-voice-btn" onClick={close} aria-label="Cerrar modo voz">
          <Icon n="x" size={22} />
        </button>
      </div>
    </div>
  );
}
