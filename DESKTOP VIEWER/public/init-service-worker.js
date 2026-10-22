(async function () {
  try {
    if ('serviceWorker' in navigator) {
      const registrations = await navigator.serviceWorker.getRegistrations();
      await Promise.all(registrations.map((registration) => registration.unregister()));
    }
    if ('caches' in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map((key) => caches.delete(key)));
    }
  } catch (error) {
    console.warn('Viewer cache cleanup failed', error);
  }

  const marker = 'vexa_viewer_cache_reset';
  try {
    if (!sessionStorage.getItem(marker)) {
      sessionStorage.setItem(marker, '1');
      window.location.reload();
    }
  } catch {
    window.location.reload();
  }
})();
