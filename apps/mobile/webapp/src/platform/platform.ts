// Plataforma de ejecucion. El build de Android marca <html data-platform="android"> antes de renderizar.
export function isAndroidPlatform(): boolean {
  return typeof document !== 'undefined' && document.documentElement.dataset.platform === 'android';
}
