function normalizeBasePath(value: unknown): string {
  const configuredBase = String(value || '/')
  const normalizedBase = `/${configuredBase.replace(/^\/+|\/+$/g, '')}`
  return normalizedBase === '/' || normalizedBase === '/.' ? '' : normalizedBase
}

function detectRuntimeBasePath(): string {
  const explicitEnv = String(import.meta.env.VITE_APP_BASE_PATH ?? '').trim()
  if (explicitEnv) {
    return normalizeBasePath(explicitEnv)
  }

  if (typeof window !== 'undefined') {
    const pathname = window.location.pathname
    const segments = pathname.split('/').filter(Boolean)
    // '/viewer' is the mounted deployment (Caddy proxies /viewer/* to this app
    // WITHOUT stripping the prefix), and the app's own launch route is
    // '/Viewer' (capital V - see the launchUrl built in server/authApi.mjs).
    // Compare case-sensitively: only the lowercase 'viewer' spelling can be a
    // mount prefix. Matching case-insensitively made the router strip the
    // 'Viewer' segment of '/Viewer?launch=...', leaving '/', which rendered
    // "Viewer can only be used with an integrated system." and silently dropped
    // the RIS launch token on every dev launch.
    const mountSegment = segments[0] ?? ''
    if (mountSegment === 'viewer') return '/viewer'
    if (mountSegment.toLowerCase() === 'mobile') return '/mobile'
  }

  return ''
}

export const appBasePath = detectRuntimeBasePath()

export function appUrl(path: string): string {
  const normalizedPath = `/${String(path || '').replace(/^\/+/, '')}`
  return `${appBasePath}${normalizedPath}`
}
