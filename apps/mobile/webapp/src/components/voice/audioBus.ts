/**
 * Bus mutable de nivel de audio para los visualizadores (Orb, Waveform).
 *
 * El pipeline real de audio (captura de micrófono y reproducción TTS) sigue
 * viviendo en el sidecar Python + Rust. Este bus SOLO representa estado:
 * - Sin fuente conectada, `level`/`bins` quedan en 0 y los visualizadores
 *   animan por estado (idle/listening/thinking/answering).
 * - Si en el futuro el backend emite niveles por eventos Tauri, se escriben
 *   aquí (`audioBus.level = ...`) sin tocar el pipeline real.
 *
 * Se lee en cada frame sin re-render de React.
 */
export const audioBus = { level: 0, bins: new Uint8Array(64) };

export function resetAudioBus() {
  audioBus.level = 0;
  audioBus.bins.fill(0);
}
