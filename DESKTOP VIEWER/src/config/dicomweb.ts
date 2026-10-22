import { appUrl } from './appBase'

export type DicomWebConfig = {
  baseUrl: string
  authorization?: string
  qidoPrefix?: string
  wadoPrefix?: string
  stowPrefix?: string
}

const configuredBaseUrl = String(import.meta.env.VITE_DICOMWEB_BASE_URL ?? '').trim()
const resolvedBaseUrl = configuredBaseUrl.startsWith('/')
  ? appUrl(configuredBaseUrl)
  : configuredBaseUrl || appUrl('/rs')

export const dicomWebConfig: DicomWebConfig = {
  baseUrl: resolvedBaseUrl,
  authorization: import.meta.env.VITE_DICOMWEB_AUTHORIZATION,
  qidoPrefix: import.meta.env.VITE_DICOMWEB_QIDO_PREFIX ?? '',
  wadoPrefix: import.meta.env.VITE_DICOMWEB_WADO_PREFIX ?? '',
  stowPrefix: import.meta.env.VITE_DICOMWEB_STOW_PREFIX ?? '',
}
