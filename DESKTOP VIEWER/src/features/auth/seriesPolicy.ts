import type { SeriesSummary } from '../dicomweb/types'
import type { AuthRole, SeriesAccessPolicy } from './authStore'

export function getEffectiveSeriesPolicy(roles: AuthRole[]): SeriesAccessPolicy {
  const maxImageLimits = roles
    .map((role) => Number(role.seriesPolicy?.maxImagesPerSeries))
    .filter((value) => Number.isFinite(value) && value > 0)
  const blockedModalitySets = roles
    .map((role) => normalizeModalities(role.seriesPolicy?.blockedModalities))
    .filter((modalities) => modalities.length > 0)

  return {
    maxImagesPerSeries: maxImageLimits.length ? Math.max(...maxImageLimits) : undefined,
    blockedModalities: blockedModalitySets.length
      ? [...blockedModalitySets.reduce((allowed, modalities) => (
          new Set(modalities.filter((modality) => allowed.has(modality)))
        ), new Set(blockedModalitySets[0]))].sort()
      : [],
  }
}

export function canAccessSeries(series: SeriesSummary, policy: SeriesAccessPolicy) {
  return !getSeriesAccessDenyReason(series, policy)
}

export function getSeriesAccessDenyReason(series: SeriesSummary, policy: SeriesAccessPolicy) {
  const modality = series.modality?.trim().toUpperCase()
  if (modality && normalizeModalities(policy.blockedModalities).includes(modality)) {
    return `This role is not authorized to open ${modality} studies.`
  }

  const maxImages = Number(policy.maxImagesPerSeries)
  if (Number.isFinite(maxImages) && maxImages > 0 && series.instanceCount > maxImages) {
    return `This role may open series containing up to ${maxImages} images. This series contains ${series.instanceCount} images.`
  }

  return ''
}

export function filterAccessibleSeries(series: SeriesSummary[], policy: SeriesAccessPolicy) {
  return series.filter((item) => canAccessSeries(item, policy))
}

function normalizeModalities(modalities: unknown) {
  if (!Array.isArray(modalities)) {
    return []
  }

  return [...new Set(modalities
    .map((modality) => String(modality).trim().toUpperCase())
    .filter(Boolean))]
}
