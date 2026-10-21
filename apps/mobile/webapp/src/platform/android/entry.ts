// Entrada de produccion para Android. Orden: marca de plataforma -> estilos Android -> puente de eventos -> app.
import '../shim/bootstrap';
import './android.css';
import { installNativeEventBridge } from './nativeBridge';

installNativeEventBridge();
void import('../../main');
