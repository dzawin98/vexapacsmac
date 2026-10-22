import { useEffect, useRef, useState } from 'react'
import { Enums, type Types } from '@cornerstonejs/core'
import { Pause, Play, SkipBack, SkipForward, StepBack, StepForward } from 'lucide-react'
import { createRenderedVideoUrl, createWadoRsImageId, registerWadoRsMetadata } from '../../dicomweb/client'
import type { InstanceSummary, SeriesSummary, StudySummary } from '../../dicomweb/types'
import { initializeCornerstone } from '../cornerstone/initCornerstone'
import { acquireStackRenderingEngine, releaseStackRenderingEngine } from '../cornerstone/stackRenderingEngine'
import { useViewerStore } from '../viewerStore'

type DicomVideoViewportProps = {
  viewportKey: string
  study: StudySummary | null
  series: SeriesSummary
  instance: InstanceSummary
  isSelected: boolean
  onSelect: () => void
}

type VideoViewportApi = Types.IViewport & {
  setVideo?: (imageId: string, frameNumber?: number) => Promise<unknown>
  setVideoURL?: (videoUrl: string) => Promise<unknown>
  play?: () => Promise<void>
  pause?: () => void
  scroll?: (delta?: number) => Promise<void>
  start?: () => Promise<void>
  end?: () => Promise<void>
  setFrameNumber?: (frameNumber: number) => Promise<void>
  getFrameNumber?: () => number
  getNumberOfSlices?: () => number
  getFrameRate?: () => number
}

function safeViewportId(viewportKey: string) {
  return `video-${viewportKey.replace(/[^a-zA-Z0-9_-]/g, '_')}`
}

export function DicomVideoViewport({ viewportKey, study, series, instance, isSelected, onSelect }: DicomVideoViewportProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const elementRef = useRef<HTMLDivElement>(null)
  const viewportRef = useRef<VideoViewportApi | null>(null)
  const processedCommandIdRef = useRef<number | null>(null)
  const [error, setError] = useState('')
  const [ready, setReady] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [frameNumber, setFrameNumberState] = useState(1)
  const [frameCount, setFrameCount] = useState(Math.max(1, instance.numberOfFrames || 1))
  const [frameRate, setFrameRate] = useState(0)
  const setViewportCinePlaying = useViewerStore((state) => state.setViewportCinePlaying)
  const viewportCommand = useViewerStore((state) => state.viewportCommands[viewportKey] ?? state.viewportCommand)
  const viewportId = safeViewportId(viewportKey)

  const refreshPlaybackState = () => {
    const viewport = viewportRef.current
    if (!viewport) return

    const nextFrame = Math.max(1, Math.round(viewport.getFrameNumber?.() || 1))
    const nextCount = Math.max(1, Math.round(viewport.getNumberOfSlices?.() || instance.numberOfFrames || 1))
    const nextRate = Math.max(0, Math.round(viewport.getFrameRate?.() || 0))
    setFrameNumberState(nextFrame)
    setFrameCount(nextCount)
    setFrameRate(nextRate)
  }

  useEffect(() => {
    const element = elementRef.current
    if (!element) return

    initializeCornerstone()
    registerWadoRsMetadata([instance])

    let cancelled = false
    const renderingEngine = acquireStackRenderingEngine(viewportId)
    const resizeObserver = new ResizeObserver(() => {
      try {
        renderingEngine.resize(true, false)
      } catch {
        // Resize can race while the viewport is being mounted.
      }
    })
    resizeObserver.observe(element)

    async function setupVideo() {
      try {
        renderingEngine.enableElement({
          viewportId,
          element,
          type: Enums.ViewportType.VIDEO,
          defaultOptions: {
            background: [0, 0, 0],
          },
        })

        const viewport = renderingEngine.getViewport(viewportId) as VideoViewportApi
        viewportRef.current = viewport
        const imageId = createWadoRsImageId(instance, 1)
        try {
          if (!viewport.setVideo) throw new Error('Cornerstone VideoViewport setVideo API is unavailable')
          await withVideoLoadTimeout(viewport.setVideo(imageId, 1))
        } catch {
          if (!viewport.setVideoURL) throw new Error('Cornerstone VideoViewport setVideoURL API is unavailable')
          await withVideoLoadTimeout(viewport.setVideoURL(createRenderedVideoUrl(instance)))
        }
        if (cancelled) return

        viewport.pause?.()
        viewport.render?.()
        refreshPlaybackState()
        setReady(true)
        setError('')
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Unable to render video series')
        }
      }
    }

    void setupVideo()

    return () => {
      cancelled = true
      resizeObserver.disconnect()
      viewportRef.current?.pause?.()
      setViewportCinePlaying(viewportKey, false)
      releaseStackRenderingEngine(viewportId)
      viewportRef.current = null
    }
  }, [instance, setViewportCinePlaying, viewportId, viewportKey])

  useEffect(() => {
    if (!playing) return
    const timer = window.setInterval(refreshPlaybackState, 150)
    return () => window.clearInterval(timer)
  }, [playing])

  useEffect(() => {
    const element = containerRef.current
    if (!element || !ready) return

    const handleWheel = (event: WheelEvent) => {
      event.preventDefault()
      event.stopPropagation()
      void step(event.deltaY > 0 ? 1 : -1)
    }

    element.addEventListener('wheel', handleWheel, { passive: false })
    return () => element.removeEventListener('wheel', handleWheel)
  }, [ready, frameCount])

  useEffect(() => {
    if (!viewportCommand || viewportCommand.targetViewportKey !== viewportKey || processedCommandIdRef.current === viewportCommand.id) {
      return
    }
    processedCommandIdRef.current = viewportCommand.id

    if (viewportCommand.type === 'toggle-cine') {
      void togglePlayback()
    } else if (viewportCommand.type === 'set-slice' && Number.isFinite(viewportCommand.sliceIndex)) {
      void goToFrame((viewportCommand.sliceIndex ?? 0) + 1)
    }
  }, [viewportCommand, viewportKey])

  useEffect(() => {
    setViewportCinePlaying(viewportKey, playing)
  }, [playing, setViewportCinePlaying, viewportKey])

  async function togglePlayback() {
    const viewport = viewportRef.current
    if (!viewport || !ready) return

    if (playing) {
      viewport.pause?.()
      setPlaying(false)
      refreshPlaybackState()
      return
    }

    await viewport.play?.()
    setPlaying(true)
    refreshPlaybackState()
  }

  async function goToFrame(frame: number) {
    const viewport = viewportRef.current
    if (!viewport || !ready) return
    const nextFrame = Math.min(Math.max(Math.round(frame), 1), frameCount)
    viewport.pause?.()
    setPlaying(false)
    await viewport.setFrameNumber?.(nextFrame)
    refreshPlaybackState()
  }

  async function step(delta: number) {
    const viewport = viewportRef.current
    if (!viewport || !ready) return
    viewport.pause?.()
    setPlaying(false)
    await viewport.scroll?.(delta)
    refreshPlaybackState()
  }

  async function jumpToEdge(edge: 'start' | 'end') {
    const viewport = viewportRef.current
    if (!viewport || !ready) return
    viewport.pause?.()
    setPlaying(false)
    if (edge === 'start') await viewport.start?.()
    else await viewport.end?.()
    refreshPlaybackState()
  }

  const title = [series.modality, series.seriesDescription].filter(Boolean).join(' - ') || 'DICOM Video'

  return (
    <div
      className={isSelected ? 'dicom-video-viewport selected' : 'dicom-video-viewport'}
      ref={containerRef}
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onDoubleClick={onSelect}
      onKeyDown={(event) => event.key === 'Enter' && onSelect()}
    >
      <div className="dicom-video-canvas" ref={elementRef} />
      <div className="dicom-video-overlay top-left">
        <strong>{study?.patientName || 'Unknown Patient'}</strong>
        <span>{study?.patientId || ''}</span>
      </div>
      <div className="dicom-video-overlay top-right">
        <strong>{title}</strong>
        <span>{study?.studyDate || series.studyDate || ''}</span>
        <span>{study?.accessionNumber ? `Acc: ${study.accessionNumber}` : ''}</span>
      </div>
      <div className="dicom-video-frame-info">
        <span>Video</span>
        <strong>{frameNumber} / {frameCount}</strong>
        {frameRate > 0 && <span>{frameRate} fps</span>}
      </div>
      {error && <div className="dicom-video-error">{error}</div>}
      <div className="dicom-video-controls" onClick={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()}>
        <button type="button" title="First frame" onClick={() => void jumpToEdge('start')}><SkipBack size={17} fill="currentColor" /></button>
        <button type="button" title="Previous frame" onClick={() => void step(-1)}><StepBack size={17} fill="currentColor" /></button>
        <button className="primary" type="button" title={playing ? 'Pause video' : 'Play video'} onClick={() => void togglePlayback()}>
          {playing ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" />}
        </button>
        <button type="button" title="Next frame" onClick={() => void step(1)}><StepForward size={17} fill="currentColor" /></button>
        <button type="button" title="Last frame" onClick={() => void jumpToEdge('end')}><SkipForward size={17} fill="currentColor" /></button>
        <input
          aria-label="Video frame"
          min={1}
          max={frameCount}
          step={1}
          type="range"
          value={Math.min(frameNumber, frameCount)}
          onChange={(event) => void goToFrame(Number(event.currentTarget.value))}
        />
      </div>
    </div>
  )
}

function withVideoLoadTimeout<T>(promise: Promise<T>, timeoutMs = 15_000) {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error('DICOM video rendered endpoint did not respond as MP4 in time.')), timeoutMs)
    promise.then(
      (value) => {
        window.clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        window.clearTimeout(timer)
        reject(error)
      },
    )
  })
}
