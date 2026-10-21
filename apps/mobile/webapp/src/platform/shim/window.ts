// Sustituye a '@tauri-apps/api/window' en el build de Android.
// En Android no hay ventana con controles propios: minimizar, maximizar y cerrar no aplican.
export function getCurrentWindow() {
  return {
    minimize: async () => {},
    toggleMaximize: async () => {},
    close: async () => {},
  };
}
