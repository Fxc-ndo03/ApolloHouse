// Entrada SOLO PARA PRUEBAS: instala un puente falso y luego carga la entrada de Android.
import { installFakeBridge } from '../shim/fakeBridge';
const scenario = new URLSearchParams(location.search).get('scenario') ?? 'signedout';
installFakeBridge(scenario);
void import('./entry');
