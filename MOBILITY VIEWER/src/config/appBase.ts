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
    const firstSegment = segments[0]?.toLowerCase()
    if (firstSegment === 'mobile') return '/mobile'
    if (firstSegment === 'viewer') return ''
  }

  return ''
}

export const appBasePath = detectRuntimeBasePath()

export function appUrl(path: string): string {
  const normalizedPath = `/${String(path || '').replace(/^\/+/, '')}`
  return `${appBasePath}${normalizedPath}`
}
