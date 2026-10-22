import type { DicomJsonDataset, InstanceSummary, SeriesSummary } from '../dicomweb/types'

export type ViewerWindowLevel = {
  windowWidth: number
  windowLevel: number
}

const WINDOW_CENTER_TAG = '00281050'
const WINDOW_WIDTH_TAG = '00281051'
const PROTOCOL_NAME_TAG = '00181030'
const CONVOLUTION_KERNEL_TAG = '00181210'
const BODY_PART_TAG = '00180015'

export function getSeriesDefaultWindowLevel(
  series?: SeriesSummary | null,
  instances: InstanceSummary[] = [],
  fallback?: ViewerWindowLevel,
): ViewerWindowLevel {
  const dicomWindow = readWindowLevelFromInstances(instances)
  if (dicomWindow) {
    return dicomWindow
  }

  const modality = series?.modality?.toUpperCase() ?? ''
  const descriptor = buildSeriesDescriptor(series, instances)

  if (modality === 'CT') {
    if (/\b(lung|thorax|chest|parenchyma)\b/i.test(descriptor)) {
      return { windowWidth: 1500, windowLevel: -600 }
    }

    if (/\b(h70|h60|bone|bony|sharp|skull|spine|high\s*res|hrct)\b/i.test(descriptor)) {
      return { windowWidth: 2000, windowLevel: 500 }
    }

    if (/\b(abdomen|mediastinum|soft|h40|b30|b40)\b/i.test(descriptor)) {
      return { windowWidth: 400, windowLevel: 40 }
    }

    if (/\b(brain|head|kepala|h31|h30)\b/i.test(descriptor)) {
      return { windowWidth: 80, windowLevel: 35 }
    }
  }

  if (fallback && fallback.windowWidth > 0) {
    return fallback
  }

  if (modality === 'CT') {
    return { windowWidth: 400, windowLevel: 40 }
  }

  if (['CR', 'DX', 'DR', 'XA', 'MG'].includes(modality)) {
    return { windowWidth: 1500, windowLevel: 750 }
  }

  return { windowWidth: 400, windowLevel: 40 }
}

function readWindowLevelFromInstances(instances: InstanceSummary[]): ViewerWindowLevel | null {
  for (const instance of instances) {
    const windowLevel = readWindowLevel(instance.metadata)
    if (windowLevel) {
      return windowLevel
    }
  }

  return null
}

function readWindowLevel(metadata?: DicomJsonDataset): ViewerWindowLevel | null {
  if (!metadata) {
    return null
  }

  const windowLevel = readFirstNumber(metadata[WINDOW_CENTER_TAG]?.Value)
  const windowWidth = readFirstNumber(metadata[WINDOW_WIDTH_TAG]?.Value)

  if (!Number.isFinite(windowLevel) || !Number.isFinite(windowWidth) || windowWidth <= 1) {
    return null
  }

  return { windowWidth, windowLevel }
}

function buildSeriesDescriptor(series?: SeriesSummary | null, instances: InstanceSummary[] = []) {
  const firstMetadata = instances.find((instance) => instance.metadata)?.metadata
  return [
    series?.seriesDescription,
    readFirstString(firstMetadata?.[PROTOCOL_NAME_TAG]?.Value),
    readFirstString(firstMetadata?.[CONVOLUTION_KERNEL_TAG]?.Value),
    readFirstString(firstMetadata?.[BODY_PART_TAG]?.Value),
  ]
    .filter(Boolean)
    .join(' ')
}

function readFirstNumber(values: unknown[] | undefined) {
  if (!Array.isArray(values)) {
    return Number.NaN
  }

  for (const value of values) {
    const numberValue = Number(Array.isArray(value) ? value[0] : value)
    if (Number.isFinite(numberValue)) {
      return numberValue
    }
  }

  return Number.NaN
}

function readFirstString(values: unknown[] | undefined) {
  if (!Array.isArray(values)) {
    return ''
  }

  const value = values[0]
  return typeof value === 'string' || typeof value === 'number' ? String(value) : ''
}
