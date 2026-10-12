import { useEffect, useMemo, useState } from 'react';
import { useTauriCommands } from '@/hooks/useTauri';
import { useAppStore } from '@/store';
import type { Appearance } from '@/store';
import { applyAppearance } from '@/components/ui/applyAppearance';
import { Icon } from '@/components/ui/Icon';
import type { IconName } from '@/components/ui/Icon';
import './Settings.css';

type Route = 'home' | 'appearance' | 'language' | 'voice' | 'audio' | 'connection' | 'system';

interface Draft {
  workerUrl: string;
  deviceSharedSecret: string;
  wakeWords: string;
  useVoskWake: boolean;
  wakeModelDir: string;
  responseOutputTarget: 'pc' | 'server';
  autostartEnabled: boolean;
  useLocalCore: boolean;
  coreLanUrl: string;
  ttsProvider: 'cloudflare' | 'gemini';
  ttsVoice: string;
  ttsLanguage: string;
  ttsSpeed: number;
  micMuted: boolean;
  ttsMuted: boolean;
  inputDeviceName: string;
  outputDeviceName: string;
  appearance: Appearance;
}

const ACCENTS: { k: Appearance['accent']; name: string; hex: string }[] = [
  { k: 'ocean', name: 'Ocean', hex: '#38BDF8' },
  { k: 'cyan', name: 'Cyan', hex: '#42E8E0' },
  { k: 'mint', name: 'Mint', hex: '#63F2B0' },
  { k: 'blue', name: 'Blue', hex: '#5B8CFF' },
];

const TEXT_SIZES: { k: Appearance['textSize']; name: string; px: number }[] = [
  { k: 'small', name: 'Pequeño', px: 12 },
  { k: 'default', name: 'Normal', px: 14 },
  { k: 'large', name: 'Grande', px: 16 },
  { k: 'xl', name: 'Muy grande', px: 19 },
];

const UI_STYLES: { k: Appearance['uiStyle']; name: string }[] = [
  { k: 'rounded', name: 'Redondeado' },
  { k: 'soft', name: 'Suave' },
  { k: 'crisp', name: 'Nítido' },
];

const LANGS = [
  { code: 'es', native: 'Español', hello: 'Hola' },
  { code: 'en', native: 'English', hello: 'Hello' },
  { code: 'pt', native: 'Português', hello: 'Olá' },
  { code: 'fr', native: 'Français', hello: 'Bonjour' },
  { code: 'de', native: 'Deutsch', hello: 'Hallo' },
];

const CLOUDFLARE_VOICES = [
  ['carina', 'Carina (Femenina, España)'],
  ['celeste', 'Celeste (Femenina, Colombia)'],
  ['diana', 'Diana (Femenina, España)'],
  ['selena', 'Selena (Femenina, codeswitching)'],
  ['estrella', 'Estrella (Femenina, México)'],
  ['sirio', 'Sirio (Masculino, México)'],
  ['nestor', 'Néstor (Masculino, España)'],
  ['alvaro', 'Álvaro (Masculino, España)'],
  ['aquila', 'Aquila (Masculino, Latinoamericano)'],
  ['javier', 'Javier (Masculino, México)'],
] as const;

const GEMINI_VOICES = ['Puck', 'Charon', 'Kore', 'Fenrir', 'Aoede'];

const LABELS: Record<string, string> = {
  workerUrl: 'Worker URL',
  deviceSharedSecret: 'Device Shared Secret',
  wakeWords: 'Wake words',
  useVoskWake: 'Vosk offline',
  wakeModelDir: 'Directorio de modelos',
  responseOutputTarget: 'Salida de audio',
  autostartEnabled: 'Iniciar con Windows',
  useLocalCore: 'Core local (LAN)',
  coreLanUrl: 'Core LAN URL',
  ttsProvider: 'Proveedor TTS',
  ttsVoice: 'Voz',
  ttsLanguage: 'Idioma',
  ttsSpeed: 'Velocidad de voz',
  micMuted: 'Micrófono silenciado',
  ttsMuted: 'Voz silenciada',
  inputDeviceName: 'Dispositivo de entrada',
  outputDeviceName: 'Dispositivo de salida',
  'appearance.accent': 'Color de acento',
  'appearance.textSize': 'Tamaño de texto',
  'appearance.uiStyle': 'Estilo de UI',
  'appearance.mode': 'Tema',
};

function showValue(key: string, v: unknown): string {
  if (typeof v === 'boolean') return v ? 'Sí' : 'No';
  if (typeof v === 'number') return String(v);
  if (key === 'deviceSharedSecret') return v ? '••••••••' : '(vacío)';
  if (key === 'responseOutputTarget') return v === 'pc' ? 'PC' : 'Dispositivo';
  if (key === 'appearance.accent') return ACCENTS.find((a) => a.k === v)?.name ?? String(v);
  if (key === 'appearance.textSize') return TEXT_SIZES.find((a) => a.k === v)?.name ?? String(v);
  if (key === 'appearance.uiStyle') return UI_STYLES.find((a) => a.k === v)?.name ?? String(v);
  if (key === 'appearance.mode') return v === 'dark' ? 'Oscuro' : 'Claro';
  const s = String(v ?? '');
  return s.length > 42 ? s.slice(0, 42) + '…' : s || '(vacío)';
}

export function SettingsWindow() {
  const {
    getSettings,
    updateSettings,
    setDeviceSharedSecret,
    getAutostartEnabled,
    setAutostartEnabled,
    setResponseOutputTarget,
    setMicMuted,
    setTtsMuted,
    startSidecar,
    stopSidecar,
    testTts,
  } = useTauriCommands();
  const updateAppearance = useAppStore((s) => s.updateAppearance);

  const [draft, setDraft] = useState<Draft | null>(null);
  const [saved, setSaved] = useState<Draft | null>(null);
  const [stack, setStack] = useState<Route[]>(['home']);
  const [dir, setDir] = useState<'fwd' | 'back'>('fwd');
  const [review, setReview] = useState(false);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const route = stack[stack.length - 1];

  const patch = (p: Partial<Draft>) =>
    setDraft((d) => (d ? { ...d, ...p } : d));
  const patchAppearance = (p: Partial<Appearance>) =>
    setDraft((d) => (d ? { ...d, appearance: { ...d.appearance, ...p } } : d));

  const loadAll = async () => {
    try {
      const s = await getSettings();
      let autostartEnabled = s.autostart_enabled ?? true;
      try {
        const live = await getAutostartEnabled();
        if (typeof live === 'boolean') autostartEnabled = live;
      } catch { /* noop */ }
      const d: Draft = {
        workerUrl: s.worker_url ?? '',
        deviceSharedSecret: s.device_shared_secret ?? '',
        wakeWords: (s.wake_words ?? ['apollo', 'hey apollo']).join(','),
        useVoskWake: s.use_vosk_wake ?? true,
        wakeModelDir: s.wake_model_dir || '',
        responseOutputTarget: (s.response_output_target as 'pc' | 'server') ?? 'pc',
        autostartEnabled,
        useLocalCore: s.use_local_core ?? false,
        coreLanUrl: s.core_lan_url || 'ws://192.168.100.8:9876',
        ttsProvider: (s.tts_provider as 'cloudflare' | 'gemini') || 'cloudflare',
        ttsVoice: s.tts_voice || 'carina',
        ttsLanguage: s.tts_language || 'es',
        ttsSpeed: s.tts_speed ?? 1.0,
        micMuted: s.mic_muted ?? false,
        ttsMuted: s.tts_muted ?? false,
        inputDeviceName: s.input_device_name || '',
        outputDeviceName: s.output_device_name || '',
        appearance: { ...useAppStore.getState().appearance },
      };
      setDraft(d);
      setSaved(JSON.parse(JSON.stringify(d)) as Draft);
    } catch (e) {
      console.error('Failed to load settings:', e);
    }
  };

  useEffect(() => {
    void loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Vista previa en vivo del tema con el borrador.
  useEffect(() => {
    if (draft) applyAppearance(draft.appearance);
  }, [draft?.appearance]);

  // Al desmontar sin aplicar, vuelve a lo guardado.
  useEffect(
    () => () => {
      applyAppearance(useAppStore.getState().appearance);
    },
    [],
  );

  const changes = useMemo(() => {
    if (!draft || !saved) return [] as string[];
    const out: string[] = [];
    (Object.keys(LABELS) as string[]).forEach((k) => {
      const get = (o: Draft) =>
        k.startsWith('appearance.') ? o.appearance[k.slice(11) as keyof Appearance] : (o as unknown as Record<string, unknown>)[k];
      if (JSON.stringify(get(draft)) !== JSON.stringify(get(saved))) out.push(k);
    });
    return out;
  }, [draft, saved]);

  if (!draft) {
    return (
      <div className="apollo-settings">
        <p className="apollo-settings-loading">Cargando configuración…</p>
      </div>
    );
  }

  const go = (r: Route) => {
    setDir('fwd');
    setStack((s) => [...s, r]);
  };
  const back = () => {
    if (stack.length === 1) return;
    setDir('back');
    setStack((s) => s.slice(0, -1));
  };

  const discard = async () => {
    await loadAll();
    applyAppearance(useAppStore.getState().appearance);
    setReview(false);
  };

  const apply = async () => {
    try {
      if (draft.deviceSharedSecret) {
        await setDeviceSharedSecret(draft.deviceSharedSecret);
      }
      await updateSettings({
        worker_url: draft.workerUrl,
        device_shared_secret: draft.deviceSharedSecret,
        wake_words: draft.wakeWords.split(',').map((w) => w.trim()).filter(Boolean),
        use_vosk_wake: draft.useVoskWake,
        wake_model_dir: draft.wakeModelDir || null,
        response_output_target: draft.responseOutputTarget,
        autostart_enabled: draft.autostartEnabled,
        use_local_core: draft.useLocalCore,
        core_lan_url: draft.coreLanUrl,
        tts_provider: draft.ttsProvider,
        tts_voice: draft.ttsVoice,
        tts_language: draft.ttsLanguage,
        tts_speed: draft.ttsSpeed,
        input_device_name: draft.inputDeviceName,
        output_device_name: draft.outputDeviceName,
      });
      try {
        await setAutostartEnabled(draft.autostartEnabled);
      } catch (e) {
        console.error('Failed to apply autostart:', e);
      }
      try {
        await setMicMuted(draft.micMuted);
      } catch (e) {
        console.error('Failed to apply mic mute:', e);
      }
      try {
        await setTtsMuted(draft.ttsMuted);
      } catch (e) {
        console.error('Failed to apply tts mute:', e);
      }
      updateAppearance(draft.appearance);
      applyAppearance(draft.appearance);
      try {
        await startSidecar();
      } catch (e) {
        console.error('Failed to start sidecar after save:', e);
      }
      setSaved(JSON.parse(JSON.stringify(draft)) as Draft);
      setResult('Guardado y conectado.');
      setReview(false);
      setTimeout(() => setResult(null), 2500);
    } catch (e) {
      setResult('Error al guardar: ' + (e instanceof Error ? e.message : String(e)));
    }
  };

  const testConnection = async () => {
    if (!draft.workerUrl || !draft.deviceSharedSecret) {
      setResult('Faltan Worker URL o Device Shared Secret');
      return;
    }
    setTesting(true);
    setResult(null);
    try {
      await startSidecar();
      setTimeout(async () => {
        try {
          await stopSidecar();
        } catch { /* noop */ }
        setTesting(false);
        setResult('Conexión OK. Guardá y reiniciá la app.');
      }, 1500);
    } catch (e) {
      setTesting(false);
      setResult('Fallo: ' + (e instanceof Error ? e.message : String(e)));
    }
  };

  const changeOutputTarget = async (target: 'pc' | 'server') => {
    patch({ responseOutputTarget: target });
    try {
      await setResponseOutputTarget(target);
    } catch (e) {
      console.error('Failed to apply output target:', e);
    }
  };

  const n = changes.length;

  return (
    <div className="apollo-settings">
      <div key={route} className={'apollo-settings-anim ' + dir}>
        {route === 'home' && <SettingsHome go={go} draft={draft} />}
        {route === 'appearance' && (
          <AppearancePage draft={draft} patchAppearance={patchAppearance} onBack={back} />
        )}
        {route === 'language' && (
          <LanguagePage draft={draft} patch={patch} onBack={back} />
        )}
        {route === 'voice' && (
          <VoicePage draft={draft} patch={patch} testing={testing} onTestVoice={() => void (async () => {
            setTesting(true);
            try {
              await testTts();
              setTimeout(() => setTesting(false), 2000);
            } catch {
              setTesting(false);
              setResult('No se pudo reproducir la voz.');
            }
          })()} onBack={back} />
        )}
        {route === 'audio' && (
          <AudioPage draft={draft} patch={patch} onBack={back} />
        )}
        {route === 'connection' && (
          <ConnectionPage
            draft={draft}
            patch={patch}
            testing={testing}
            onTest={testConnection}
            onOutput={changeOutputTarget}
            onBack={back}
          />
        )}
        {route === 'system' && (
          <SystemPage draft={draft} patch={patch} onBack={back} onReload={() => void loadAll()} />
        )}
      </div>

      {result && <p className="apollo-settings-toast" role="status">{result}</p>}

      <div className={'apollo-changes-bar' + (n ? ' on' : '')}>
        <span className="apollo-changes-dot" />
        <span key={n} className="apollo-changes-count">
          {n} {n === 1 ? 'cambio' : 'cambios'}
        </span>
        <button type="button" className="apollo-btn ghost" onClick={() => void discard()}>
          Descartar
        </button>
        <button type="button" className="apollo-btn" onClick={() => setReview(true)}>
          Revisar
        </button>
      </div>

      {review && (
        <div className="apollo-sheet-ov" onClick={() => setReview(false)}>
          <div className="apollo-sheet" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Revisar cambios">
            <h2>Tu experiencia</h2>
            {n === 0 ? (
              <p className="apollo-hint">Sin cambios todavía.</p>
            ) : (
              <div className="apollo-diff">
                {changes.map((k) => (
                  <div key={k}>
                    <span>{LABELS[k]}</span>
                    <em>{showValue(k, getVal(saved!, k))}</em>
                    <Icon n="chev" size={14} />
                    <b>{showValue(k, getVal(draft, k))}</b>
                  </div>
                ))}
              </div>
            )}
            <div className="apollo-sheet-act">
              <button type="button" className="apollo-btn ghost" onClick={() => void discard()}>
                Descartar
              </button>
              <button type="button" className="apollo-btn" disabled={!n} onClick={() => void apply()}>
                Aplicar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function getVal(o: Draft, k: string): unknown {
  return k.startsWith('appearance.')
    ? o.appearance[k.slice(11) as keyof Appearance]
    : (o as unknown as Record<string, unknown>)[k];
}

/* ---------------- componentes de página ---------------- */

function Page(props: { title: string; subtitle?: string; onBack: () => void; children: React.ReactNode }) {
  return (
    <div className="apollo-page">
      <div className="apollo-page-top">
        <button type="button" className="apollo-icon-btn" onClick={props.onBack} aria-label="Volver">
          <Icon n="back" size={18} />
        </button>
        <span className="apollo-page-small">{props.title}</span>
      </div>
      <div className="apollo-page-scroll">
        <div className="apollo-page-big">
          <h1>{props.title}</h1>
          {props.subtitle && <p>{props.subtitle}</p>}
        </div>
        {props.children}
      </div>
    </div>
  );
}

function Label({ children, value }: { children: React.ReactNode; value?: string }) {
  return (
    <div className="apollo-label">
      <span>{children}</span>
      {value && <b key={value}>{value}</b>}
    </div>
  );
}

function Group({ children }: { children: React.ReactNode }) {
  return <div className="apollo-group">{children}</div>;
}

function Row(p: {
  icon: IconName;
  title: string;
  sub?: string;
  onClick?: () => void;
  right?: React.ReactNode;
  dim?: boolean;
}) {
  return (
    <div
      className={'apollo-row' + (p.dim ? ' dim' : '') + (p.onClick ? ' tap' : '')}
      onClick={p.onClick}
      role={p.onClick ? 'button' : undefined}
      tabIndex={p.onClick ? 0 : undefined}
      onKeyDown={p.onClick ? (e) => e.key === 'Enter' && p.onClick?.() : undefined}
    >
      <span className="apollo-row-ico">
        <Icon n={p.icon} size={18} />
      </span>
      <span className="apollo-row-t">
        <b>{p.title}</b>
        {p.sub && <small>{p.sub}</small>}
      </span>
      {p.right ?? (p.onClick && (
        <span className="apollo-row-chev">
          <Icon n="chev" size={18} />
        </span>
      ))}
    </div>
  );
}

function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      className="apollo-toggle"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation();
        onChange(!on);
      }}
    >
      <i>
        <Icon n="check" size={14} />
      </i>
    </button>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="apollo-field">
      <label>{label}</label>
      <div className="apollo-field-box">{children}</div>
      {hint && <p className="apollo-hint">{hint}</p>}
    </div>
  );
}

function SettingsHome({ go, draft }: { go: (r: 'appearance' | 'language' | 'voice' | 'audio' | 'connection' | 'system') => void; draft: Draft }) {
  return (
    <Page title="Configuración" subtitle="Personalizá Apollo a tu manera." onBack={() => {}}>
      <Label>Personalización</Label>
      <Group>
        <Row icon="pen" title="Apariencia" sub="Tema, color, texto y estilo" onClick={() => go('appearance')} />
        <Row icon="globe" title="Idioma" sub={LANGS.find((l) => l.code === draft.ttsLanguage)?.native ?? draft.ttsLanguage} onClick={() => go('language')} />
      </Group>
      <Label>Voz y audio</Label>
      <Group>
        <Row icon="msg" title="Voz de Apollo" sub={`${draft.ttsProvider === 'cloudflare' ? 'Cloudflare' : 'Gemini'} · ${draft.ttsVoice}`} onClick={() => go('voice')} />
        <Row icon="vol" title="Audio" sub={draft.micMuted ? 'Mic silenciado' : 'Mic y voz activos'} onClick={() => go('audio')} />
      </Group>
      <Label>Conexión</Label>
      <Group>
        <Row icon="zap" title="Worker y dispositivos" sub={draft.workerUrl ? 'Configurado' : 'Falta Worker URL'} onClick={() => go('connection')} />
      </Group>
      <Label>Sistema</Label>
      <Group>
        <Row icon="shield" title="Sistema" sub="Autostart y atajos" onClick={() => go('system')} />
      </Group>
    </Page>
  );
}

function AppearancePage({ draft, patchAppearance, onBack }: {
  draft: Draft;
  patchAppearance: (p: Partial<Appearance>) => void;
  onBack: () => void;
}) {
  const a = draft.appearance;
  return (
    <Page title="Apariencia" subtitle="Cada cambio se previsualiza al instante." onBack={onBack}>
      <div className="apollo-card apollo-preview">
        <div className="apollo-preview-head">
          <span className="apollo-preview-ico"><Icon n="msg" size={14} /></span> Apollo <em>● Online</em>
        </div>
        <div className="apollo-bub">Un plan tranquilo para tu semana. ¿Agrego pausas?</div>
        <div className="apollo-bub me">Sí, dejá el viernes libre</div>
        <div className="apollo-preview-in">Preguntá lo que sea…<span><Icon n="up" size={14} /></span></div>
      </div>

      <Label>Tema</Label>
      <div className="apollo-opts cols2">
        {(['dark', 'light'] as const).map((m) => (
          <button
            key={m}
            type="button"
            className={'apollo-opt' + (a.mode === m ? ' on' : '')}
            aria-pressed={a.mode === m}
            onClick={() => patchAppearance({ mode: m })}
          >
            <Icon n={m === 'dark' ? 'moon' : 'sun'} size={20} />
            <span>{m === 'dark' ? 'Oscuro' : 'Claro'}</span>
          </button>
        ))}
      </div>

      <Label value={ACCENTS.find((x) => x.k === a.accent)?.name}>Color de acento</Label>
      <div className="apollo-card apollo-swatches">
        {ACCENTS.map((x) => (
          <button
            key={x.k}
            type="button"
            className={'apollo-sw' + (a.accent === x.k ? ' on' : '')}
            aria-label={x.name}
            aria-pressed={a.accent === x.k}
            style={{ ['--c' as string]: x.hex }}
            onClick={() => patchAppearance({ accent: x.k })}
          >
            <Icon n="check" size={16} />
          </button>
        ))}
      </div>

      <Label value={TEXT_SIZES.find((x) => x.k === a.textSize)?.name}>Tamaño de texto</Label>
      <div className="apollo-opts cols4">
        {TEXT_SIZES.map((x) => (
          <button
            key={x.k}
            type="button"
            className={'apollo-opt' + (a.textSize === x.k ? ' on' : '')}
            aria-pressed={a.textSize === x.k}
            onClick={() => patchAppearance({ textSize: x.k })}
          >
            <span style={{ fontSize: x.px, fontWeight: 600 }}>Aa</span>
          </button>
        ))}
      </div>

      <Label value={UI_STYLES.find((x) => x.k === a.uiStyle)?.name}>Estilo de UI</Label>
      <div className="apollo-opts cols3">
        {UI_STYLES.map((x) => (
          <button
            key={x.k}
            type="button"
            className={'apollo-opt tall' + (a.uiStyle === x.k ? ' on' : '')}
            aria-pressed={a.uiStyle === x.k}
            onClick={() => patchAppearance({ uiStyle: x.k })}
          >
            <span>{x.name}</span>
          </button>
        ))}
      </div>
    </Page>
  );
}

function LanguagePage({ draft, patch, onBack }: {
  draft: Draft;
  patch: (p: Partial<Draft>) => void;
  onBack: () => void;
}) {
  const cur = LANGS.find((l) => l.code === draft.ttsLanguage) ?? LANGS[0];
  return (
    <Page title="Idioma" subtitle="El idioma en que habla Apollo." onBack={onBack}>
      <div className="apollo-card apollo-greet">
        <div key={cur.code} className="apollo-hello-word">{cur.hello}</div>
        <small>Respuestas en {cur.native}</small>
      </div>
      <Label>Idiomas</Label>
      <Group>
        {LANGS.map((l) => (
          <Row
            key={l.code}
            icon="globe"
            title={l.native}
            onClick={() => patch({ ttsLanguage: l.code })}
            right={
              <span className={'apollo-radio' + (l.code === draft.ttsLanguage ? ' on' : '')}>
                <Icon n="check" size={14} />
              </span>
            }
          />
        ))}
      </Group>
      <p className="apollo-hint">Asegurate de elegir una voz acorde al idioma en la página Voz.</p>
    </Page>
  );
}

function VoicePage({ draft, patch, testing, onTestVoice, onBack }: {
  draft: Draft;
  patch: (p: Partial<Draft>) => void;
  testing: boolean;
  onTestVoice: () => void;
  onBack: () => void;
}) {
  return (
    <Page title="Voz de Apollo" subtitle="Elegí cómo querés que suene." onBack={onBack}>
      <Field label="Palabras de activación (separadas por coma)" hint='Ej: "apollo,hey apollo"'>
        <input
          className="apollo-input"
          value={draft.wakeWords}
          onChange={(e) => patch({ wakeWords: e.target.value })}
          placeholder="apollo,hey apollo"
        />
      </Field>
      <Group>
        <Row
          icon="mic"
          title="Vosk (detección offline)"
          right={<Toggle on={draft.useVoskWake} onChange={(v) => patch({ useVoskWake: v })} label="Vosk offline" />}
        />
      </Group>
      <Field label="Directorio de modelos Vosk (opcional)" hint="Por defecto: juana_client/models">
        <input
          className="apollo-input"
          value={draft.wakeModelDir}
          onChange={(e) => patch({ wakeModelDir: e.target.value })}
          placeholder="juana_client/models"
        />
      </Field>
      <Label>Proveedor</Label>
      <div className="apollo-opts cols2">
        {(['cloudflare', 'gemini'] as const).map((p) => (
          <button
            key={p}
            type="button"
            className={'apollo-opt' + (draft.ttsProvider === p ? ' on' : '')}
            aria-pressed={draft.ttsProvider === p}
            onClick={() =>
              patch({
                ttsProvider: p,
                ttsVoice: p === 'cloudflare' ? 'carina' : 'Puck',
                ttsLanguage: p === 'cloudflare' ? 'es' : 'es-US',
              })
            }
          >
            <span>{p === 'cloudflare' ? 'Cloudflare (gratis)' : 'Gemini'}</span>
          </button>
        ))}
      </div>
      <Field label="Voz">
        <select
          className="apollo-input apollo-select"
          value={draft.ttsVoice}
          onChange={(e) => patch({ ttsVoice: e.target.value })}
        >
          {draft.ttsProvider === 'cloudflare'
            ? CLOUDFLARE_VOICES.map(([v, l]) => <option key={v} value={v}>{l}</option>)
            : GEMINI_VOICES.map((v) => <option key={v} value={v}>{v}</option>)}
        </select>
      </Field>
      <Field label="Velocidad">
        <div className="apollo-range">
          <input
            type="range"
            min="0.5"
            max="2.0"
            step="0.1"
            value={draft.ttsSpeed}
            onChange={(e) => patch({ ttsSpeed: parseFloat(e.target.value) })}
            aria-label="Velocidad de voz"
          />
          <span className="mono">{draft.ttsSpeed.toFixed(1)}x</span>
        </div>
      </Field>
      <button type="button" className="apollo-btn ghost" disabled={testing} onClick={onTestVoice}>
        {testing ? 'Probando…' : 'Probar voz'}
      </button>
    </Page>
  );
}

function AudioPage({ draft, patch, onBack }: {
  draft: Draft;
  patch: (p: Partial<Draft>) => void;
  onBack: () => void;
}) {
  return (
    <Page title="Audio" subtitle="Micrófono, voz y dispositivos." onBack={onBack}>
      <Group>
        <Row
          icon="mic"
          title="Micrófono"
          sub={draft.micMuted ? 'Silenciado' : 'Activo'}
          right={<Toggle on={!draft.micMuted} onChange={(v) => patch({ micMuted: !v })} label="Micrófono" />}
        />
        <Row
          icon="vol"
          title="Voz de Apollo"
          sub={draft.ttsMuted ? 'Silenciada' : 'Activa'}
          right={<Toggle on={!draft.ttsMuted} onChange={(v) => patch({ ttsMuted: !v })} label="Voz" />}
        />
      </Group>
      <Field label="Dispositivo de entrada" hint="Se resuelve por nombre en cada inicio">
        <input
          className="apollo-input"
          value={draft.inputDeviceName}
          onChange={(e) => patch({ inputDeviceName: e.target.value })}
          placeholder="Micrófono (JBL Quantum 300)"
        />
      </Field>
      <Field label="Dispositivo de salida" hint="Se resuelve por nombre en cada inicio">
        <input
          className="apollo-input"
          value={draft.outputDeviceName}
          onChange={(e) => patch({ outputDeviceName: e.target.value })}
          placeholder="JBL Quantum 300"
        />
      </Field>
      <Label>Destino de respuesta</Label>
      <div className="apollo-opts cols2">
        {(['pc', 'server'] as const).map((t) => (
          <button
            key={t}
            type="button"
            className={'apollo-opt' + (draft.responseOutputTarget === t ? ' on' : '')}
            aria-pressed={draft.responseOutputTarget === t}
            onClick={() => patch({ responseOutputTarget: t })}
          >
            <span>{t === 'pc' ? 'Esta PC' : 'Dispositivo'}</span>
          </button>
        ))}
      </div>
    </Page>
  );
}

function ConnectionPage({ draft, patch, testing, onTest, onOutput, onBack }: {
  draft: Draft;
  patch: (p: Partial<Draft>) => void;
  testing: boolean;
  onTest: () => void;
  onOutput: (t: 'pc' | 'server') => void;
  onBack: () => void;
}) {
  return (
    <Page title="Conexión" subtitle="Worker, secreto y core local." onBack={onBack}>
      <Field label="Worker URL (WebSocket)" hint="URL del WebSocket del Apollo Worker">
        <input
          className="apollo-input"
          value={draft.workerUrl}
          onChange={(e) => patch({ workerUrl: e.target.value })}
          placeholder="wss://apollo.facupapollo.workers.dev/agents/apollo/default"
        />
      </Field>
      <Field label="Device Shared Secret" hint="Secreto compartido del dispositivo">
        <input
          className="apollo-input"
          type="password"
          value={draft.deviceSharedSecret}
          onChange={(e) => patch({ deviceSharedSecret: e.target.value })}
          placeholder="••••••••••••••••"
        />
      </Field>
      <button type="button" className="apollo-btn ghost" disabled={testing} onClick={onTest}>
        {testing ? 'Probando…' : 'Probar conexión'}
      </button>
      <Label>Core local (LAN)</Label>
      <Group>
        <Row
          icon="zap"
          title="Core local en Juana Manso"
          sub="Qwen local por LAN"
          right={<Toggle on={draft.useLocalCore} onChange={(v) => patch({ useLocalCore: v })} label="Core local" />}
        />
      </Group>
      <Field label="Core LAN URL" hint="Ej: ws://192.168.100.8:9876">
        <input
          className="apollo-input"
          value={draft.coreLanUrl}
          onChange={(e) => patch({ coreLanUrl: e.target.value })}
          placeholder="ws://192.168.100.8:9876"
        />
      </Field>
      <Label>Responder por</Label>
      <div className="apollo-opts cols2">
        {(['pc', 'server'] as const).map((t) => (
          <button
            key={t}
            type="button"
            className={'apollo-opt' + (draft.responseOutputTarget === t ? ' on' : '')}
            aria-pressed={draft.responseOutputTarget === t}
            onClick={() => void onOutput(t)}
          >
            <span>{t === 'pc' ? 'Esta PC' : 'Dispositivo'}</span>
          </button>
        ))}
      </div>
    </Page>
  );
}

function SystemPage({ draft, patch, onBack, onReload }: {
  draft: Draft;
  patch: (p: Partial<Draft>) => void;
  onBack: () => void;
  onReload: () => void;
}) {
  return (
    <Page title="Sistema" subtitle="Arranque y ayuda." onBack={onBack}>
      <Group>
        <Row
          icon="clock"
          title="Iniciar con Windows"
          sub="Apollo arranca en segundo plano"
          right={<Toggle on={draft.autostartEnabled} onChange={(v) => patch({ autostartEnabled: v })} label="Autostart" />}
        />
      </Group>
      <Label>Atajos de teclado</Label>
      <Group>
        {[
          ['Ctrl+Shift+A', 'Abrir Chat'],
          ['Ctrl+Shift+S', 'Abrir Configuración'],
          ['Escape', 'Cerrar overlays'],
          ['Click bandeja', 'Mostrar / ocultar'],
        ].map(([k, a]) => (
          <Row key={k} icon="kb" title={k} sub={a} />
        ))}
      </Group>
      <button type="button" className="apollo-btn ghost" onClick={onReload}>
        Recargar valores
      </button>
    </Page>
  );
}
