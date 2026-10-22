import { create } from 'zustand'
import type { InstanceSummary, SeriesSummary, StudySummary } from '../dicomweb/types'

export type ViewportLayout = '1x1' | '1x2' | '2x1' | '1x3' | '3x1' | '2x2' | '2x3' | '3x2' | '3x3'

type ViewportStack = {
  series: SeriesSummary
  instances: InstanceSummary[]
  imageIds: string[]
}

type ViewportCommand = {
  id: number
  type: 'reset' | 'reset-mpr-free-rotate' | 'delete-annotation' | 'save-gsps' | 'save-secondary-capture' | 'set-slice' | 'set-mpr-slice' | 'set-zoom' | 'set-pan' | 'set-window-level' | 'toggle-cine' | 'invert' | 'spatial-flip-horizontal' | 'spatial-flip-vertical' | 'spatial-rotate-cw' | 'spatial-rotate-ccw' | 'spatial-rotate-180' | 'spatial-zoom-1x' | 'spatial-zoom-input' | 'spatial-zoom-fit' | 'zoom-in' | 'zoom-out' | 'preset-lung' | 'preset-bone' | 'preset-brain' | 'preset-mediastinum' | 'preset-soft'
  targetViewportKey: string
  sourceViewportKey?: string
  sliceIndex?: number
  zoom?: number
  camera?: CameraInfo
  windowLevel?: WindowLevelInfo
}

type WindowLevelInfo = {
  windowWidth: number
  windowLevel: number
}

type CameraInfo = {
  focalPoint?: number[]
  position?: number[]
  viewUp?: number[]
  parallelScale?: number
}

type Stack3dCursorState = {
  id: number
  sourceViewportKey: string
  worldPoint: [number, number, number]
} | null


type ViewerState = {
  viewportLayout: ViewportLayout
  selectedViewportKey: string
  viewportStacks: Record<string, ViewportStack>
  viewportSliceIndexes: Record<string, number>
  viewportCinePlaying: Record<string, boolean>
  viewportZooms: Record<string, number>
  viewportWindowLevels: Record<string, WindowLevelInfo>
  viewportCommand: ViewportCommand | null
  viewportCommands: Record<string, ViewportCommand>
  activeSeriesTargetViewportKey: string
  activeStudy: StudySummary | null
  activeSeries: SeriesSummary | null
  activeSeriesBatch: Record<string, SeriesSummary>
  instances: InstanceSummary[]
  imageIds: string[]
  activeTool: string
  hotkeyOverrides: Record<string, string>
  referenceLinesEnabled: boolean
  stack3dCursor: Stack3dCursorState
  loadingMessage: string
  errorMessage: string
  annotationCount: number
  mprMode: boolean
  mprViewportKey: string | null
  mprViewportKeys: Record<string, boolean>
  mprVolumeId: string | null
  mprActiveViewportId: string
  mprActiveViewportIds: Record<string, string>
  mprSliceIndexes: Record<string, number>
  mprSliceCounts: Record<string, number>
  ichMprViewportKeys: Record<string, boolean>
  intelliLink: {
    scroll: boolean
    windowLevel: boolean
    pan: boolean
    zoom: boolean
  }
  setActiveStudy: (study: StudySummary | null) => void
  setActiveSeries: (series: SeriesSummary | null, targetViewportKey?: string) => void
  setActiveSeriesBatch: (seriesByViewport: Record<string, SeriesSummary>, layout?: ViewportLayout) => void
  setInstances: (instances: InstanceSummary[], imageIds: string[]) => void
  setActiveTool: (tool: string) => void
  setHotkeyOverrides: (overrides: Record<string, string>) => void
  setReferenceLinesEnabled: (enabled: boolean) => void
  setStack3dCursor: (sourceViewportKey: string, worldPoint: [number, number, number]) => void
  setViewportLayout: (layout: ViewportLayout) => void
  setSelectedViewportKey: (viewportKey: string) => void
  setViewportStack: (viewportKey: string, stack: ViewportStack) => void
  refreshViewportStackInstances: (viewportKey: string, instances: InstanceSummary[]) => void
  setStudyColors: (studyColorByUid: Record<string, string>, enabled: boolean) => void
  setViewportSliceIndex: (viewportKey: string, sliceIndex: number) => void
  setViewportCinePlaying: (viewportKey: string, playing: boolean) => void
  setViewportZoom: (viewportKey: string, zoom: number) => void
  setViewportWindowLevel: (viewportKey: string, info: WindowLevelInfo) => void
  sendViewportCommand: (type: ViewportCommand['type'], targetViewportKey?: string, options?: { sliceIndex?: number; zoom?: number; camera?: CameraInfo; windowLevel?: WindowLevelInfo; sourceViewportKey?: string }) => void
  setIntelliLinkOption: (option: keyof ViewerState['intelliLink'], enabled: boolean) => void
  setAllIntelliLinkOptions: (enabled: boolean) => void
  setLoadingMessage: (message: string) => void
  setErrorMessage: (message: string) => void
  setAnnotationCount: (count: number) => void
  setMprMode: (mode: boolean, viewportKey?: string | null) => void
  setMprVolumeId: (volumeId: string | null) => void
  setMprActiveViewportId: (viewportId: string, viewportKey?: string) => void
  setMprSliceInfo: (viewportId: string, sliceIndex: number, sliceCount: number) => void
  setIchMprWorkspace: (viewportKey: string, enabled: boolean) => void
}

export const useViewerStore = create<ViewerState>((set) => ({
  viewportLayout: '1x1',
  selectedViewportKey: '0',
  viewportStacks: {},
  viewportSliceIndexes: {},
  viewportCinePlaying: {},
  viewportZooms: {},
  viewportWindowLevels: {},
  viewportCommand: null,
  viewportCommands: {},
  activeSeriesTargetViewportKey: '0',
  activeStudy: null,
  activeSeries: null,
  activeSeriesBatch: {},
  instances: [],
  imageIds: [],
  activeTool: 'WindowLevel',
  hotkeyOverrides: {},
  referenceLinesEnabled: true,
  stack3dCursor: null,
  loadingMessage: '',
  errorMessage: '',
  annotationCount: 0,
  mprMode: false,
  mprViewportKey: null,
  mprViewportKeys: {},
  mprVolumeId: null,
  mprActiveViewportId: 'mpr-axial',
  mprActiveViewportIds: {},
  mprSliceIndexes: {},
  mprSliceCounts: {},
  ichMprViewportKeys: {},
  intelliLink: { scroll: false, windowLevel: false, pan: false, zoom: false },
  setActiveStudy: (study) => set({ activeStudy: study, activeSeries: null, instances: [], imageIds: [], errorMessage: '', mprMode: false, mprViewportKey: null, mprViewportKeys: {}, mprVolumeId: null, mprActiveViewportIds: {}, ichMprViewportKeys: {} }),
  setActiveSeries: (series, targetViewportKey) => set((state) => {
    const targetKey = targetViewportKey ?? state.selectedViewportKey
    const replacingMprViewport = Boolean(state.mprViewportKeys[targetKey])
    const nextMprViewportKeys = { ...state.mprViewportKeys }
    const nextMprActiveViewportIds = { ...state.mprActiveViewportIds }
    const nextIchMprViewportKeys = { ...state.ichMprViewportKeys }
    if (replacingMprViewport) {
      delete nextMprViewportKeys[targetKey]
      delete nextMprActiveViewportIds[targetKey]
      delete nextIchMprViewportKeys[targetKey]
    }
    const nextMprKeys = Object.keys(nextMprViewportKeys)

    return {
      activeSeries: series,
      activeSeriesTargetViewportKey: targetKey,
      instances: [],
      imageIds: [],
      errorMessage: '',
      mprMode: nextMprKeys.length > 0,
      mprViewportKey: nextMprKeys.includes(state.mprViewportKey ?? '') ? state.mprViewportKey : (nextMprKeys[0] ?? null),
      mprViewportKeys: nextMprViewportKeys,
      mprActiveViewportIds: nextMprActiveViewportIds,
      mprVolumeId: replacingMprViewport ? null : state.mprVolumeId,
      ichMprViewportKeys: nextIchMprViewportKeys,
    }
  }),
  setActiveSeriesBatch: (seriesByViewport, layout) => set((state) => {
    const firstKey = Object.keys(seriesByViewport)[0]
    const firstSeries = firstKey ? seriesByViewport[firstKey] ?? null : null
    const nextLayout = layout ?? state.viewportLayout
    return {
      activeSeriesBatch: seriesByViewport,
      activeSeries: firstSeries,
      activeSeriesTargetViewportKey: firstKey ?? '0',
      instances: [],
      imageIds: [],
      errorMessage: '',
      viewportLayout: nextLayout,
      selectedViewportKey: isViewportVisible(nextLayout, state.selectedViewportKey) ? state.selectedViewportKey : '0',
    }
  }),
  setInstances: (instances, imageIds) => set({ instances, imageIds }),
  setActiveTool: (tool) => set({ activeTool: tool }),
  setHotkeyOverrides: (hotkeyOverrides) => set({ hotkeyOverrides }),
  setReferenceLinesEnabled: (referenceLinesEnabled) => set({ referenceLinesEnabled }),
  setStack3dCursor: (sourceViewportKey, worldPoint) => set({
    stack3dCursor: { id: Date.now(), sourceViewportKey, worldPoint },
  }),
  setViewportLayout: (viewportLayout) => set((state) => ({
    viewportLayout,
    selectedViewportKey: isViewportVisible(viewportLayout, state.selectedViewportKey) ? state.selectedViewportKey : '0',
  })),
  setSelectedViewportKey: (selectedViewportKey) => set({ selectedViewportKey }),
  setViewportStack: (viewportKey, stack) => set((state) => ({
    viewportStacks: { ...state.viewportStacks, [viewportKey]: stack },
    viewportSliceIndexes: { ...state.viewportSliceIndexes, [viewportKey]: 0 },
    viewportCinePlaying: { ...state.viewportCinePlaying, [viewportKey]: false },
    viewportZooms: { ...state.viewportZooms, [viewportKey]: 1 },
    viewportWindowLevels: { ...state.viewportWindowLevels, [viewportKey]: { windowWidth: 0, windowLevel: 0 } },
    instances: stack.instances,
    imageIds: stack.imageIds,
  })),
  refreshViewportStackInstances: (viewportKey, instances) => set((state) => {
    const stack = state.viewportStacks[viewportKey]
    if (!stack) return state

    return {
      viewportStacks: {
        ...state.viewportStacks,
        [viewportKey]: { ...stack, instances },
      },
      ...(state.activeSeriesTargetViewportKey === viewportKey ? { instances } : {}),
    }
  }),
  setStudyColors: (studyColorByUid, enabled) => set((state) => {
    const applyColor = (series: SeriesSummary) => ({
      ...series,
      studyColor: enabled ? studyColorByUid[series.studyInstanceUid] : undefined,
    })
    const viewportStacks = Object.fromEntries(
      Object.entries(state.viewportStacks).map(([viewportKey, stack]) => [
        viewportKey,
        { ...stack, series: applyColor(stack.series) },
      ]),
    )

    return {
      viewportStacks,
      activeSeries: state.activeSeries ? applyColor(state.activeSeries) : state.activeSeries,
    }
  }),
  setViewportSliceIndex: (viewportKey, sliceIndex) => set((state) => (
    state.viewportSliceIndexes[viewportKey] === sliceIndex
      ? state
      : { viewportSliceIndexes: { ...state.viewportSliceIndexes, [viewportKey]: sliceIndex } }
  )),
  setViewportCinePlaying: (viewportKey, playing) => set((state) => (
    state.viewportCinePlaying[viewportKey] === playing
      ? state
      : { viewportCinePlaying: { ...state.viewportCinePlaying, [viewportKey]: playing } }
  )),
  setViewportZoom: (viewportKey, zoom) => set((state) => (
    Math.abs((state.viewportZooms[viewportKey] ?? 1) - zoom) < 0.001
      ? state
      : { viewportZooms: { ...state.viewportZooms, [viewportKey]: zoom } }
  )),
  setViewportWindowLevel: (viewportKey, info) => set((state) => {
    const current = state.viewportWindowLevels[viewportKey]
    if (
      current
      && Math.abs(current.windowWidth - info.windowWidth) < 0.001
      && Math.abs(current.windowLevel - info.windowLevel) < 0.001
    ) {
      return state
    }

    return {
      viewportWindowLevels: { ...state.viewportWindowLevels, [viewportKey]: info },
    }
  }),
  sendViewportCommand: (type, targetViewportKey, options) => set((state) => {
    const targetKey = targetViewportKey ?? state.selectedViewportKey
    const command = {
      id: Date.now(),
      type,
      targetViewportKey: targetKey,
      sourceViewportKey: options?.sourceViewportKey,
      sliceIndex: options?.sliceIndex,
      zoom: options?.zoom,
      camera: options?.camera,
      windowLevel: options?.windowLevel,
    }

    return {
      viewportCommand: command,
      viewportCommands: { ...state.viewportCommands, [targetKey]: command },
    }
  }),
  setIntelliLinkOption: (option, enabled) => set((state) => ({
    intelliLink: { ...state.intelliLink, [option]: enabled },
  })),
  setAllIntelliLinkOptions: (enabled) => set({
    intelliLink: { scroll: enabled, windowLevel: enabled, pan: enabled, zoom: enabled },
  }),
  setLoadingMessage: (message) => set({ loadingMessage: message }),
  setErrorMessage: (message) => set({ errorMessage: message }),
  setAnnotationCount: (annotationCount) => set({ annotationCount }),
  setMprMode: (mode, viewportKey) => set((state) => {
    const targetKey = viewportKey ?? state.selectedViewportKey
    const nextMprViewportKeys = { ...state.mprViewportKeys }
    const nextMprActiveViewportIds = { ...state.mprActiveViewportIds }
    const nextIchMprViewportKeys = { ...state.ichMprViewportKeys }
    if (mode) {
      nextMprViewportKeys[targetKey] = true
    } else {
      delete nextMprViewportKeys[targetKey]
      delete nextMprActiveViewportIds[targetKey]
      delete nextIchMprViewportKeys[targetKey]
    }
    const nextMprKeys = Object.keys(nextMprViewportKeys)

    return {
      mprMode: nextMprKeys.length > 0,
      mprViewportKey: mode ? targetKey : (nextMprKeys.includes(state.mprViewportKey ?? '') ? state.mprViewportKey : (nextMprKeys[0] ?? null)),
      mprViewportKeys: nextMprViewportKeys,
      mprActiveViewportIds: nextMprActiveViewportIds,
      mprVolumeId: nextMprKeys.length > 0 ? state.mprVolumeId : null,
      ichMprViewportKeys: nextMprKeys.length > 0 ? nextIchMprViewportKeys : {},
    }
  }),
  setMprVolumeId: (volumeId) => set({ mprVolumeId: volumeId }),
  setMprActiveViewportId: (viewportId, viewportKey) => set((state) => ({
    mprActiveViewportId: viewportId,
    mprActiveViewportIds: viewportKey
      ? { ...state.mprActiveViewportIds, [viewportKey]: viewportId }
      : state.mprActiveViewportIds,
  })),
  setMprSliceInfo: (viewportId, sliceIndex, sliceCount) => set((state) => ({
    mprSliceIndexes: { ...state.mprSliceIndexes, [viewportId]: sliceIndex },
    mprSliceCounts: { ...state.mprSliceCounts, [viewportId]: sliceCount },
  })),
  setIchMprWorkspace: (viewportKey, enabled) => set((state) => {
    const nextIchMprViewportKeys = { ...state.ichMprViewportKeys }
    if (enabled) {
      nextIchMprViewportKeys[viewportKey] = true
    } else {
      delete nextIchMprViewportKeys[viewportKey]
    }

    return { ichMprViewportKeys: nextIchMprViewportKeys }
  }),
}))

function isViewportVisible(layout: ViewportLayout, viewportKey: string) {
  const visibleCount = getViewportCount(layout)

  return Number(viewportKey) < visibleCount
}

function getViewportCount(layout: ViewportLayout) {
  const [rows, columns] = layout.split('x').map(Number)

  return rows * columns
}
