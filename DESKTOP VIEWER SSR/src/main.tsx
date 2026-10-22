import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import './index.css'
import { appBasePath } from './config/appBase'
import { installViewerTelemetry } from './utils/viewerTelemetry'

if (import.meta.env.VITE_CLEAR_VIEWER_CACHE_ON_STARTUP === 'true') {
  void cleanupLegacyServiceWorker()
}
installViewerTelemetry()

const isThinClientPath = /(?:^|\/)thin-client(?:\/|$)/i.test(window.location.pathname)
const appModule = isThinClientPath ? import('./ThinClientApp.tsx') : import('./App.tsx')

void appModule.then(({ default: App }) => {
  createRoot(document.getElementById('root')!).render(
    <BrowserRouter basename={appBasePath || undefined}>
      <App />
    </BrowserRouter>,
  )
})

async function cleanupLegacyServiceWorker() {
  try {
    if ('serviceWorker' in navigator) {
      const registrations = await navigator.serviceWorker.getRegistrations()
      await Promise.all(registrations.map((registration) => registration.unregister()))
    }
    if ('caches' in window) {
      const keys = await caches.keys()
      await Promise.all(keys.map((key) => caches.delete(key)))
    }
  } catch {
    // A stale viewer cache should never block the actual viewer startup.
  }
}
