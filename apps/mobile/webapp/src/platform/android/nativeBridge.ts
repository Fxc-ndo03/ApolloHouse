import { dispatchNativeEvent } from '../shim/event';
import { useAppStore } from '../../store';
import { listen } from '../shim/event';

type NativeWindow = Window & {
  __apolloEvent?: (name: string, payloadJson: string) => void;
  __apolloBack?: () => boolean;
};

/**
 * Puente de entrada desde Kotlin (lista cerrada en docs/02 del paquete).
 * - window.__apolloEvent(nombre, payloadJson): entrega un evento a los suscriptores de listen().
 * - window.__apolloBack(): el boton atras de Android. true = la app lo consumio; false = Android cierra la pantalla.
 */
export function installNativeEventBridge(): void {
  const w = window as NativeWindow;
  // Kotlin emite 'connection-status' con el objeto ConnectionStatus de la UI: {status, error?}.
  void listen<{ status: string; error?: string }>('connection-status', (e) => {
    useAppStore.getState().setConnectionStatus(e.payload as never);
  });
  w.__apolloEvent = (name, payloadJson) => {
    let payload: unknown = payloadJson;
    try { payload = JSON.parse(payloadJson); } catch { /* payload que no es JSON: se entrega tal cual */ }
    dispatchNativeEvent(name, payload);
  };
  w.__apolloBack = () => {
    const st = useAppStore.getState();
    if (st.activeSection !== 'dashboard') {
      st.setActiveSection('dashboard');
      return true;
    }
    return false;
  };
}
