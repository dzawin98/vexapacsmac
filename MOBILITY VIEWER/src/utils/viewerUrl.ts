export type ViewerMode = 'stack' | 'mpr' | 'auto'

export type ViewerUrlParams = {
  studyUID: string
  seriesUID?: string
  mode?: ViewerMode
  accession?: string
  patientId?: string
}

export function buildViewerUrl(params: ViewerUrlParams) {
  const search = new URLSearchParams()

  search.set('studyUID', params.studyUID)
  if (params.seriesUID) search.set('seriesUID', params.seriesUID)
  if (params.mode && params.mode !== 'auto') search.set('mode', params.mode)
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
    accession: params.get('accession') ?? undefined,
    patientId: params.get('patientId') ?? undefined,
  }
}
