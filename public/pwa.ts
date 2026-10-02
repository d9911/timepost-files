export async function registerPwa() {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
  try {
    await navigator.serviceWorker.register('/sw.js', {
      type: 'module',
      scope: '/',
      updateViaCache: 'none',
    });
  } catch {
    // Ошибка установки кэша не блокирует обычную работу интерфейса через API.
    console.warn('Files: PWA cache is unavailable');
  }
}
