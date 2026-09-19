import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface OrbState {
  state:
    | 'idle'
    | 'listening'
    | 'thinking'
    | 'speaking'
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

export interface Settings {
  workerUrl: string;
  deviceSharedSecret: string;
  wakeWords: string[];
  useVoskWake: boolean;
  wakeModelDir: string;
  responseOutputTarget: 'pc' | 'server';
}

interface AppStore {
  // Orb
  orbState: OrbState;
  setOrbState: (state: Partial<OrbState>) => void;

  // Chat
  messages: ChatMessage[];
  addMessage: (message: Omit<ChatMessage, 'id' | 'timestamp'>) => void;
  clearMessages: () => void;

  // Connection
  connectionStatus: ConnectionStatus;
  setConnectionStatus: (status: ConnectionStatus) => void;

  // Settings
  settings: Settings;
  updateSettings: (settings: Partial<Settings>) => void;
  resetSettings: () => void;

  // Sidecar
  sidecarRunning: boolean;
  setSidecarRunning: (running: boolean) => void;
}

const defaultSettings: Settings = {
  workerUrl: 'wss://apollo.facupapollo.workers.dev/agents/apollo/default',
  deviceSharedSecret: '',
  wakeWords: ['juana', 'hey juana'],
  useVoskWake: true,
  wakeModelDir: '',
  responseOutputTarget: 'pc',
};

const defaultOrbState: OrbState = {
  state: 'idle',
};

export const useAppStore = create<AppStore>()(
  persist(
    (set) => ({
      // Orb
      orbState: defaultOrbState,
      setOrbState: (partial) =>
        set((state) => ({
          orbState: { ...state.orbState, ...partial },
        })),

      // Chat
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
          ].slice(-100), // Keep last 100 messages
        })),
      clearMessages: () => set({ messages: [] }),

      // Connection
      connectionStatus: { status: 'disconnected' },
      setConnectionStatus: (status) => set({ connectionStatus: status }),

      // Settings
      settings: defaultSettings,
      updateSettings: (partial) =>
        set((state) => ({
          settings: { ...state.settings, ...partial },
        })),
      resetSettings: () => set({ settings: defaultSettings }),

      // Sidecar
      sidecarRunning: false,
      setSidecarRunning: (running) => set({ sidecarRunning: running }),
    }),
    {
      name: 'apollo-desktop-store',
      partialize: (state) => ({
        settings: state.settings,
      }),
    },
  ),
);
