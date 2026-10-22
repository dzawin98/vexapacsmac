export type ViewerMode = 'stack' | 'mpr' | 'auto'
export type ViewerMprEngine = 'server' | 'proxy' | 'cornerstone'

export type ViewerUrlParams = {
  studyUID: string
  seriesUID?: string
  mode?: ViewerMode
  renderMode?: 'server' | 'cornerstone'
  mprEngine?: ViewerMprEngine
  accession?: string
  patientId?: string
}

export function buildViewerUrl(params: ViewerUrlParams) {
  const search = new URLSearchParams()

  search.set('studyUID', params.studyUID)
  if (params.seriesUID) search.set('seriesUID', params.seriesUID)
  if (params.mode && params.mode !== 'auto') search.set('mode', params.mode)
  if (params.renderMode === 'server') search.set('renderMode', params.renderMode)
  if (params.mprEngine === 'server' || params.mprEngine === 'proxy') search.set('mprEngine', params.mprEngine)
  if (params.accession) search.set('accession', params.accession)
  if (params.patientId) search.set('patientId', params.patientId)

  return `/view?${search.toString()}`
}

export function parseViewerUrl(): ViewerUrlParams | null {
  const params = new URLSearchParams(window.location.search)
  const studyUID = params.get('studyUID')

  if (!studyUID) {
    return null
  }

  return {
    studyUID,
    seriesUID: params.get('seriesUID') ?? undefined,
    mode: (params.get('mode') as ViewerMode | null) ?? 'auto',
    renderMode: params.get('renderMode') === 'server' ? 'server' : undefined,
    mprEngine: parseMprEngine(params.get('mprEngine')),
    accession: params.get('accession') ?? undefined,
    patientId: params.get('patientId') ?? undefined,
  }
}

function parseMprEngine(value: string | null): ViewerMprEngine | undefined {
  return value === 'server' || value === 'proxy' ? value : undefined
}
