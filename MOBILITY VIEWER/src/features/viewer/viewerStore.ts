import { create } from 'zustand'
import type { InstanceSummary, SeriesSummary, StudySummary } from '../dicomweb/types'

type ViewportLayout = '1x1' | '1x2' | '2x1' | '2x2'

type ViewportStack = {
  series: SeriesSummary
  instances: InstanceSummary[]
  imageIds: string[]
}

type ViewportCommand = {
  id: number
  type: 'reset' | 'delete-annotation' | 'set-slice' | 'set-mpr-slice' | 'reset-mpr-free-rotate' | 'set-zoom' | 'set-pan' | 'set-window-level' | 'invert' | 'spatial-flip-horizontal' | 'spatial-flip-vertical' | 'spatial-rotate-cw' | 'spatial-rotate-ccw' | 'spatial-rotate-180' | 'spatial-zoom-1x' | 'spatial-zoom-input' | 'spatial-zoom-fit' | 'zoom-in' | 'zoom-out' | 'preset-lung' | 'preset-bone' | 'preset-brain' | 'preset-mediastinum' | 'preset-soft'
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
  viewportZooms: Record<string, number>
  viewportWindowLevels: Record<string, WindowLevelInfo>
  viewportCommand: ViewportCommand | null
  activeSeriesTargetViewportKey: string
  activeStudy: StudySummary | null
  activeSeries: SeriesSummary | null
  instances: InstanceSummary[]
  imageIds: string[]
  activeTool: string
  referenceLinesEnabled: boolean
  stack3dCursor: Stack3dCursorState
  loadingMessage: string
  errorMessage: string
  annotationCount: number
  mprMode: boolean
  mprVolumeId: string | null
  mprActiveViewportId: string
  mprSliceIndexes: Record<string, number>
  mprSliceCounts: Record<string, number>
  intelliLink: {
    scroll: boolean
    windowLevel: boolean
    pan: boolean
    zoom: boolean
  }
  setActiveStudy: (study: StudySummary | null) => void
  setActiveSeries: (series: SeriesSummary | null, targetViewportKey?: string) => void
  setInstances: (instances: InstanceSummary[], imageIds: string[]) => void
  setActiveTool: (tool: string) => void
  setReferenceLinesEnabled: (enabled: boolean) => void
  setStack3dCursor: (sourceViewportKey: string, worldPoint: [number, number, number]) => void
  setViewportLayout: (layout: ViewportLayout) => void
  setSelectedViewportKey: (viewportKey: string) => void
  setViewportStack: (viewportKey: string, stack: ViewportStack) => void
  setViewportSliceIndex: (viewportKey: string, sliceIndex: number) => void
  setViewportZoom: (viewportKey: string, zoom: number) => void
  setViewportWindowLevel: (viewportKey: string, info: WindowLevelInfo) => void
  sendViewportCommand: (type: ViewportCommand['type'], targetViewportKey?: string, options?: { sliceIndex?: number; zoom?: number; camera?: CameraInfo; windowLevel?: WindowLevelInfo; sourceViewportKey?: string }) => void
  setIntelliLinkOption: (option: keyof ViewerState['intelliLink'], enabled: boolean) => void
  setAllIntelliLinkOptions: (enabled: boolean) => void
  setLoadingMessage: (message: string) => void
  setErrorMessage: (message: string) => void
  setAnnotationCount: (count: number) => void
  setMprMode: (mode: boolean) => void
  setMprVolumeId: (volumeId: string | null) => void
  setMprActiveViewportId: (viewportId: string) => void
  setMprSliceInfo: (viewportId: string, sliceIndex: number, sliceCount: number) => void
}

export const useViewerStore = create<ViewerState>((set) => ({
  viewportLayout: '1x1',
  selectedViewportKey: '0',
  viewportStacks: {},
  viewportSliceIndexes: {},
  viewportZooms: {},
  viewportWindowLevels: {},
  viewportCommand: null,
  activeSeriesTargetViewportKey: '0',
  activeStudy: null,
  activeSeries: null,
  instances: [],
  imageIds: [],
  activeTool: 'WindowLevel',
  referenceLinesEnabled: true,
  stack3dCursor: null,
  loadingMessage: '',
  errorMessage: '',
  annotationCount: 0,
  mprMode: false,
  mprVolumeId: null,
  mprActiveViewportId: 'mpr-axial',
  mprSliceIndexes: {},
  mprSliceCounts: {},
  intelliLink: { scroll: false, windowLevel: false, pan: false, zoom: false },
  setActiveStudy: (study) => set({ activeStudy: study, activeSeries: null, instances: [], imageIds: [], errorMessage: '', mprMode: false, mprVolumeId: null }),
  setActiveSeries: (series, targetViewportKey) => set((state) => ({ activeSeries: series, activeSeriesTargetViewportKey: targetViewportKey ?? state.selectedViewportKey, instances: [], imageIds: [], errorMessage: '', mprMode: false, mprVolumeId: null })),
  setInstances: (instances, imageIds) => set({ instances, imageIds }),
  setActiveTool: (tool) => set({ activeTool: tool }),
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
    viewportZooms: { ...state.viewportZooms, [viewportKey]: 1 },
    viewportWindowLevels: { ...state.viewportWindowLevels, [viewportKey]: { windowWidth: 0, windowLevel: 0 } },
    instances: stack.instances,
    imageIds: stack.imageIds,
  })),
  setViewportSliceIndex: (viewportKey, sliceIndex) => set((state) => ({
    viewportSliceIndexes: { ...state.viewportSliceIndexes, [viewportKey]: sliceIndex },
  })),
  setViewportZoom: (viewportKey, zoom) => set((state) => ({
    viewportZooms: { ...state.viewportZooms, [viewportKey]: zoom },
  })),
  setViewportWindowLevel: (viewportKey, info) => set((state) => ({
    viewportWindowLevels: { ...state.viewportWindowLevels, [viewportKey]: info },
  })),
  sendViewportCommand: (type, targetViewportKey, options) => set((state) => ({
    viewportCommand: {
      id: Date.now(),
      type,
      targetViewportKey: targetViewportKey ?? state.selectedViewportKey,
      sourceViewportKey: options?.sourceViewportKey,
      sliceIndex: options?.sliceIndex,
      zoom: options?.zoom,
      camera: options?.camera,
      windowLevel: options?.windowLevel,
    },
  })),
  setIntelliLinkOption: (option, enabled) => set((state) => ({
    intelliLink: { ...state.intelliLink, [option]: enabled },
  })),
  setAllIntelliLinkOptions: (enabled) => set({
    intelliLink: { scroll: enabled, windowLevel: enabled, pan: enabled, zoom: enabled },
  }),
  setLoadingMessage: (message) => set({ loadingMessage: message }),
  setErrorMessage: (message) => set({ errorMessage: message }),
  setAnnotationCount: (annotationCount) => set({ annotationCount }),
  setMprMode: (mode) => set({ mprMode: mode }),
  setMprVolumeId: (volumeId) => set({ mprVolumeId: volumeId }),
  setMprActiveViewportId: (viewportId) => set({ mprActiveViewportId: viewportId }),
  setMprSliceInfo: (viewportId, sliceIndex, sliceCount) => set((state) => ({
    mprSliceIndexes: { ...state.mprSliceIndexes, [viewportId]: sliceIndex },
    mprSliceCounts: { ...state.mprSliceCounts, [viewportId]: sliceCount },
  })),
}))

function isViewportVisible(layout: ViewportLayout, viewportKey: string) {
  const visibleCount = layout === '1x1' ? 1 : layout === '2x2' ? 4 : 2

  return Number(viewportKey) < visibleCount
}
