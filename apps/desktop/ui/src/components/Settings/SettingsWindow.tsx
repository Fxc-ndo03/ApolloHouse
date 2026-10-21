import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke, listen, useTauriCommands } from '@/hooks/useTauri';
import {
  ALLOWED_POSTPONE_HOURS,
  describeUpdateState,
  isRetryableFailure,
  normalizeUpdateStatus,
  postponeDeadline,
  readProgressPercent,
  shouldOfferInstall,
  type UpdateStatus,
} from '@/components/Settings/updateState';
import { useAppStore } from '@/store';
import type { Appearance } from '@/store';
import { applyAppearance } from '@/components/ui/applyAppearance';
import { Icon } from '@/components/ui/Icon';
import { Page } from '@/components/Settings/Page';
import { Field, Group, Label, Row, Toggle } from '@/components/Settings/controls';
import { ProfilePage } from '@/components/Settings/ProfilePage';
import './Settings.css';

type Route =
  | 'home'
  | 'profile'
  | 'appearance'
  | 'language'
  | 'voice'
  | 'audio'
  | 'connection'
  | 'system'
  | 'updates';

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
  if (key === 'appearance.mode') {
    return v === 'dark' ? 'Oscuro' : v === 'light' ? 'Claro' : 'Sistema';
  }
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
        {route === 'profile' && (
          <ProfilePage
            onBack={back}
            onSignedOut={() => setStack(['home'])}
          />
        )}
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
        {route === 'updates' && <UpdatePage onBack={back} />}
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

function SettingsHome({ go, draft }: { go: (r: 'profile' | 'appearance' | 'language' | 'voice' | 'audio' | 'connection' | 'system' | 'updates') => void; draft: Draft }) {
  const account = useAppStore((s) => s.account);
  return (
    <Page title="Configuración" subtitle="Personalizá Apollo a tu manera." onBack={() => {}}>
      <Label>Cuenta</Label>
      <Group>
        <Row
          icon="shield"
          title="Perfil"
          sub={
            account === null
              ? 'Comprobando sesión…'
              : account.authenticated
                ? `Sesión activa · ${account.account_id}`
                : 'Sin sesión · iniciá sesión'
          }
          onClick={() => go('profile')}
        />
      </Group>
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
          <Row icon="up" title="Actualizaciones" sub="Version, canal y descargas" onClick={() => go('updates')} />
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
      <div className="apollo-opts cols3">
        {(['system', 'dark', 'light'] as const).map((m) => (
          <button
            key={m}
            type="button"
            className={'apollo-opt' + (a.mode === m ? ' on' : '')}
            aria-pressed={a.mode === m}
            onClick={() => patchAppearance({ mode: m })}
          >
            <Icon n={m === 'system' ? 'monitor' : m === 'dark' ? 'moon' : 'sun'} size={20} />
            <span>{m === 'system' ? 'Sistema' : m === 'dark' ? 'Oscuro' : 'Claro'}</span>
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

/**
 * FASE 3.1 — pagina de actualizaciones dentro de Ajustes.
 *
 * Usa las mismas primitivas que el resto (Page/Group/Row) y la logica pura de
 * updateState.ts. No crea un camino de actualizacion paralelo.
 */
function UpdatePage({ onBack }: { onBack: () => void }) {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const statusRef = useRef<UpdateStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [lastChecked, setLastChecked] = useState<string | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [deferredUntil, setDeferredUntil] = useState<number | null>(null);

  const apply = useCallback((next: UpdateStatus) => {
    // Android's bridge first replies "checking" and later emits the final
    // status. Do not let a delayed initial reply overwrite that final event.
    if (next.status.kind === 'checking' && statusRef.current && statusRef.current.status.kind !== 'checking') {
      return;
    }
    statusRef.current = next;
    setStatus(next);
    setProgress(next.status.kind === 'downloading' ? next.status.percent : null);
  }, []);

  const check = useCallback(async () => {
    setBusy(true);
    // FASE 3.4: se declara "comprobando" antes de salir a la red, para que el
    // panel no siga diciendo "Aun no se comprobo" mientras espera.
    if (status) {
      apply({ ...status, status: { kind: 'checking' } });
    }
    try {
      const next = normalizeUpdateStatus(await invoke('check_for_update'));
      apply(next);
      setLastChecked(new Date().toLocaleTimeString());
    } catch (error) {
      apply({
        channel: status?.channel ?? 'stable',
        installedVersion: status?.installedVersion ?? '?',
        status: { kind: 'failed', reason: String(error) },
        latestVersion: null,
        notes: null,
        publishedAt: null,
        message: null,
      });
    } finally {
      setBusy(false);
    }
  }, [apply, status?.channel, status?.installedVersion]);

  const install = useCallback(async () => {
    setBusy(true);
    setProgress(0);
    // FASE 3.4: el progreso real llega por el evento `update://progress` de
    // Rust. No se marca "descargando" con un porcentaje inventado.
    apply({
      channel: status?.channel ?? 'stable',
      installedVersion: status?.installedVersion ?? '?',
      status: { kind: 'checking' },
      latestVersion: status?.latestVersion ?? null,
      notes: null,
      publishedAt: null,
      message: null,
    });
    try {
      const next = normalizeUpdateStatus(await invoke('download_and_install_update'));
      apply(next);
    } catch (error) {
      apply({
        channel: status?.channel ?? 'stable',
        installedVersion: status?.installedVersion ?? '?',
        status: { kind: 'failed', reason: String(error) },
        latestVersion: status?.latestVersion ?? null,
        notes: null,
        publishedAt: null,
        message: null,
      });
    } finally {
      setBusy(false);
    }
  }, [apply, status]);

  const restart = useCallback(async () => {
    await invoke('restart_after_update');
  }, []);

  // FASE 3.4: Rust emite el progreso real de la descarga. Sin este listener el
  // panel se quedaba en "comprobando" durante toda la descarga.
  useEffect(() => {
    const unlistenProgress = listen<number>('update://progress', (event) => {
      const percent = readProgressPercent(event.payload);
      if (percent === null) return;
      setProgress(percent);
      setStatus((previous) =>
        previous === null
          ? previous
          : { ...previous, status: { kind: 'downloading', percent } },
      );
    });
    const unlistenReady = listen('update://ready', () => {
      setProgress(100);
      setStatus((previous) =>
        previous === null ? previous : { ...previous, status: { kind: 'ready' } },
      );
    });
    const unlistenStatus = listen<unknown>('update://status', (event) => {
      const next = normalizeUpdateStatus(event.payload);
      apply(next);
      if (['upToDate', 'available', 'failed'].includes(next.status.kind)) {
        setLastChecked(new Date().toLocaleTimeString());
      }
    });

    return () => {
      void unlistenProgress.then((stop) => stop());
      void unlistenReady.then((stop) => stop());
      void unlistenStatus.then((stop) => stop());
    };
  }, [apply]);

  useEffect(() => {
    void check();
    // Solo al abrir la pagina. El usuario manda desde el boton.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const kind = status?.status.kind ?? 'idle';
  const canInstall = status ? shouldOfferInstall(status.status) : false;
  const failureReason = status?.status.kind === 'failed' ? status.status.reason : '';
  const retryable = failureReason !== '' && isRetryableFailure(failureReason);

  const postpone = useCallback((hours: number) => {
    const deadline = postponeDeadline(Math.floor(Date.now() / 1000), hours);
    if (!deadline.ok) return;
    setDeferredUntil(deadline.untilEpochSeconds);
    apply({
      channel: status?.channel ?? 'stable',
      installedVersion: status?.installedVersion ?? '?',
      status: { kind: 'deferred', untilEpochSeconds: deadline.untilEpochSeconds },
      latestVersion: status?.latestVersion ?? null,
      notes: status?.notes ?? null,
      publishedAt: status?.publishedAt ?? null,
      message: `Se comprobara de nuevo en ${hours} h.`,
    });
  }, [apply, status]);

  return (
    <Page
      title="Actualizaciones"
      subtitle={status ? describeUpdateState(status) : 'Comprobando...'}
      onBack={onBack}
    >
      <Label>Estado</Label>
      <Group>
        <Row icon="check" title="Version instalada" sub={status?.installedVersion ?? '-'} />
        <Row icon="shield" title="Canal" sub={status?.channel === 'staging' ? 'STAGING (pruebas)' : 'Estable'} />
        <Row icon="clock" title="Ultima comprobacion" sub={lastChecked ?? 'Sin comprobar'} />
        {deferredUntil !== null && (
          <Row icon="msg" title="Pospuesta hasta" sub={new Date(deferredUntil * 1000).toLocaleString()} />
        )}
      </Group>

      {kind === 'available' && status?.latestVersion && (
        <>
          <Label>Disponible</Label>
          <Group>
            <Row icon="up" title={`Version ${status.latestVersion}`} sub={status.publishedAt ?? ''} />
            {status.notes ? <Row icon="msg" title="Notas" sub={status.notes} /> : null}
          </Group>
        </>
      )}

      {progress !== null && (
        <Group>
          <Row icon="down" title="Descargando" sub={`${progress}%`} />
        </Group>
      )}

      <Label>Acciones</Label>
      <Group>
        <Row
          icon="bell"
          title={busy ? 'Un momento...' : 'Comprobar ahora'}
          sub={retryable ? 'El ultimo intento fallo; puedes reintentar' : 'Consulta el canal de esta app'}
          onClick={busy ? undefined : () => void check()}
        />
        {canInstall && (
          <Row
            icon="down"
            title="Descargar e instalar"
            sub="La firma se verifica antes de instalar"
            onClick={() => void install()}
          />
        )}
        {kind === 'pendingRestart' && (
          <Row
            icon="gear"
            title="Reiniciar Apollo"
            sub="Hazlo cuando no estes hablando"
            onClick={() => void restart()}
          />
        )}
        {kind === 'available' &&
          ALLOWED_POSTPONE_HOURS.map((hours) => (
            <Row
              key={`postpone-${hours}`}
              icon="clock"
              title={`Posponer ${hours} h`}
              sub="Sigue instalada la version actual"
              onClick={() => postpone(hours)}
            />
          ))}
      </Group>

      {status?.message && kind !== 'failed' && (
        <Group>
          <Row icon="msg" title={status.message} sub="" />
        </Group>
      )}
    </Page>
  );
}
