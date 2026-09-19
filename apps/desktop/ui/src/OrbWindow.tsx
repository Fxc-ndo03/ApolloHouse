import { useEffect } from 'react';
import { Orb } from '@/components/Orb/Orb';
import { useTauriCommands } from '@/hooks/useTauri';
import { useAppStore } from '@/store';
import { theme } from '@/theme';

const ghostButton: React.CSSProperties = {
  padding: '8px 16px',
  background: 'rgba(139, 92, 246, 0.12)',
  border: `1px solid ${theme.color.primary}`,
  borderRadius: 20,
  color: theme.color.text,
  fontSize: 12,
  cursor: 'pointer',
  backdropFilter: 'blur(10px)',
  transition: 'all 0.2s',
};

export function OrbWindow() {
  const { startSidecar, showChat, showSettings } = useTauriCommands();
  const { connectionStatus, sidecarRunning } = useAppStore();

  useEffect(() => {
    // Auto-start sidecar on load if settings are configured
    const settings = useAppStore.getState().settings;
    if (settings.workerUrl && settings.deviceSharedSecret) {
      startSidecar();
    }
  }, [startSidecar]);

  // Handle keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ctrl+Shift+A to show chat
      if (e.ctrlKey && e.shiftKey && e.key === 'A') {
        showChat();
      }
      // Ctrl+Shift+S to show settings
      if (e.ctrlKey && e.shiftKey && e.key === 'S') {
        showSettings();
      }
      // Escape to hide orb
      if (e.key === 'Escape') {
        // Handled by window blur
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [showChat, showSettings]);

  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'transparent',
      }}
    >
      <Orb width={360} height={360} />

      <div
        style={{
          position: 'absolute',
          bottom: 16,
          left: '50%',
          transform: 'translateX(-50%)',
          display: 'flex',
          gap: 8,
          pointerEvents: 'auto',
        }}
      >
        <button
          onClick={showChat}
          style={ghostButton}
          onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(139, 92, 246, 0.28)'}
          onMouseLeave={(e) => e.currentTarget.style.background = 'rgba(139, 92, 246, 0.12)'}
        >
          Chat (⌘⇧A)
        </button>
        <button
          onClick={showSettings}
          style={ghostButton}
          onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(139, 92, 246, 0.28)'}
          onMouseLeave={(e) => e.currentTarget.style.background = 'rgba(139, 92, 246, 0.12)'}
        >
          Settings (⌘⇧S)
        </button>
      </div>

      <div
        style={{
          position: 'absolute',
          top: 12,
          left: 12,
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          fontSize: 11,
          color: theme.color.textDim,
          fontFamily: theme.font.mono,
        }}
      >
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: '50%',
            background:
              connectionStatus.status === 'connected' || connectionStatus.status === 'authenticated'
                ? theme.color.primarySoft
                : connectionStatus.status === 'connecting'
                ? theme.color.warn
                : connectionStatus.status === 'error'
                ? theme.color.danger
                : theme.color.textFaint,
            boxShadow:
              connectionStatus.status === 'connected' || connectionStatus.status === 'authenticated'
                ? `0 0 6px 2px ${theme.color.primary}`
                : 'none',
          }}
        />
        <span>{connectionStatus.status}</span>
        {sidecarRunning && (
          <span style={{ marginLeft: 8, color: theme.color.primarySoft }}>● LISTENING</span>
        )}
      </div>
    </div>
  );
}