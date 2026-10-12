import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface OrbState {
  state:
    | 'idle'
    | 'listening'
    | 'thinking'
    | 'speaking'
    | 'responding'
    | 'confirming'
    | 'focusing'
    | 'alarm'
    | 'error';
  caption?: string;
  emotion?: string;
  accentColor?: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
}

export interface ConnectionStatus {
  status: 'disconnected' | 'connecting' | 'connected' | 'authenticated' | 'error';
  error?: string;
}

export interface TtsSettings {
  provider: 'cloudflare' | 'gemini';
  voice: string;
  language: string;
  speed: number;
}

export interface Settings {
  workerUrl: string;
  deviceSharedSecret: string;
  wakeWords: string[];
  useVoskWake: boolean;
  wakeModelDir: string;
  responseOutputTarget: 'pc' | 'server';
  tts: TtsSettings;
}

export type ActiveSection = 'dashboard' | 'chat' | 'settings';

export type AppearanceAccent = 'ocean' | 'cyan' | 'mint' | 'blue';
export type AppearanceTextSize = 'small' | 'default' | 'large' | 'xl';
export type AppearanceUiStyle = 'rounded' | 'soft' | 'crisp';
export type AppearanceMode = 'dark' | 'light';

export interface Appearance {
  accent: AppearanceAccent;
  textSize: AppearanceTextSize;
  uiStyle: AppearanceUiStyle;
  mode: AppearanceMode;
}

export const defaultAppearance: Appearance = {
  accent: 'cyan',
  textSize: 'default',
  uiStyle: 'rounded',
  mode: 'dark',
};

interface AppStore {
  orbState: OrbState;
  setOrbState: (state: Partial<OrbState>) => void;

  messages: ChatMessage[];
  addMessage: (message: Omit<ChatMessage, 'id' | 'timestamp'>) => void;
  updateLastAssistantMessage: (content: string) => void;
  dropTrailingEmptyAssistant: () => void;
  clearMessages: () => void;

  activeSection: ActiveSection;
  setActiveSection: (section: ActiveSection) => void;

  voiceOpen: boolean;
  setVoiceOpen: (open: boolean) => void;

  connectionStatus: ConnectionStatus;
  setConnectionStatus: (status: ConnectionStatus) => void;

  settings: Settings;
  updateSettings: (settings: Partial<Settings>) => void;
  resetSettings: () => void;

  appearance: Appearance;
  updateAppearance: (partial: Partial<Appearance>) => void;
  resetAppearance: () => void;

  sidecarRunning: boolean;
  setSidecarRunning: (running: boolean) => void;
}

const defaultSettings: Settings = {
  workerUrl: 'wss://apollo.facupapollo.workers.dev/agents/apollo/default',
  deviceSharedSecret: '',
  wakeWords: ['apollo', 'hey apollo'],
  useVoskWake: true,
  wakeModelDir: '',
  responseOutputTarget: 'pc',
  tts: {
    provider: 'cloudflare',
    voice: 'carina',
    language: 'es',
    speed: 1.0,
  },
};

const defaultOrbState: OrbState = {
  state: 'idle',
};

export const useAppStore = create<AppStore>()(
  persist(
    (set) => ({
      orbState: defaultOrbState,
      setOrbState: (partial) =>
        set((state) => ({
          orbState: { ...state.orbState, ...partial },
        })),

      messages: [],
      addMessage: (message) =>
        set((state) => ({
          messages: [
            ...state.messages,
            {
              ...message,
              id: crypto.randomUUID(),
              timestamp: Date.now(),
            },
          ].slice(-200),
        })),
      updateLastAssistantMessage: (content) =>
        set((state) => {
          const msgs = [...state.messages];
          for (let i = msgs.length - 1; i >= 0; i--) {
            if (msgs[i].role === 'assistant') {
              msgs[i] = { ...msgs[i], content };
              break;
            }
          }
          return { messages: msgs };
        }),
      clearMessages: () => set({ messages: [] }),
      dropTrailingEmptyAssistant: () =>
        set((state) => {
          const last = state.messages[state.messages.length - 1];
          if (last && last.role === 'assistant' && last.content === '') {
            return { messages: state.messages.slice(0, -1) };
          }
          return { messages: state.messages };
        }),

      activeSection: 'dashboard' as ActiveSection,
      setActiveSection: (section) => set({ activeSection: section }),

      voiceOpen: false,
      setVoiceOpen: (open) => set({ voiceOpen: open }),

      connectionStatus: { status: 'disconnected' },
      setConnectionStatus: (status) => set({ connectionStatus: status }),

      settings: defaultSettings,
      updateSettings: (partial) =>
        set((state) => ({
          settings: { ...state.settings, ...partial },
        })),
      resetSettings: () => set({ settings: defaultSettings }),

      appearance: defaultAppearance,
      updateAppearance: (partial) =>
        set((state) => ({
          appearance: { ...state.appearance, ...partial },
        })),
      resetAppearance: () => set({ appearance: defaultAppearance }),

      sidecarRunning: false,
      setSidecarRunning: (running) => set({ sidecarRunning: running }),
    }),
    {
      name: 'apollo-desktop-store',
      partialize: (state) => ({
        settings: state.settings,
        messages: state.messages,
        appearance: state.appearance,
      }),
    },
  ),
);
