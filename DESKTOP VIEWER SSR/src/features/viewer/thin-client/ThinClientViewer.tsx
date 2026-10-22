import { useEffect, useMemo, useRef, useState } from 'react'
import type { MouseEvent, MutableRefObject, PointerEvent } from 'react'
import { useSearchParams } from 'react-router-dom'

type ConnectionState = 'idle' | 'connecting' | 'open' | 'closed' | 'error'

type FrameInfo = {
  requestId: string
  slice: number
  orientation: 'axial' | 'sagittal' | 'coronal'
  totalSlices: number
  windowWidth: number
  windowLevel: number
  zoom: number
  panX: number
  panY: number
  byteLength: number
  sopInstanceUid?: string
  renderMs: number
  framesRendered: number
  generatedAt: number
}

type SessionInfo = {
  sessionId: string
  serverVolume?: {
    bytes: number
    loadMs: number
    transferSyntaxUid: string
    cachedAt: number
  }
  geometry: {
    dimensions: number[]
    spacing: number[]
    origin: number[]
    direction: number[]
    slope: number
    intercept: number
    frameOfReferenceUid: string
  }
}

function defaultRenderWsUrl() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${window.location.host}/api/render/ws`
}

function normalizeWsUrl(value: string | null) {
  if (!value) return defaultRenderWsUrl()
  try {
    return new URL(value).toString()
  } catch {
    return defaultRenderWsUrl()
  }
}

function normalizeOrientation(value: string | null): FrameInfo['orientation'] {
  const orientation = String(value || '').toLowerCase()
  if (orientation === 'sagittal' || orientation === 'coronal') return orientation
  return 'axial'
}

export function ThinClientViewer() {
  const [searchParams] = useSearchParams()
  const studyInstanceUid = searchParams.get('studyUID') || searchParams.get('StudyInstanceUIDs') || ''
  const seriesInstanceUid = searchParams.get('seriesUID') || searchParams.get('SeriesInstanceUID') || ''
  const sopInstanceUid = searchParams.get('sopUID') || searchParams.get('SOPInstanceUID') || ''
  const renderWsUrl = useMemo(() => normalizeWsUrl(searchParams.get('renderWs')), [searchParams])
  const initialOrientation = normalizeOrientation(searchParams.get('orientation'))
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const socketRef = useRef<WebSocket | null>(null)
  const frameInfoRef = useRef<FrameInfo | null>(null)
  const pendingFrameRef = useRef<FrameInfo | null>(null)
  const dragRef = useRef<{ x: number; y: number; mode: 'windowLevel' | 'pan' | 'zoom' } | null>(null)
  const requestSeqRef = useRef(0)
  const [connectionState, setConnectionState] = useState<ConnectionState>('idle')
  const [sessionInfo, setSessionInfo] = useState<SessionInfo | null>(null)
  const [frameInfo, setFrameInfo] = useState<FrameInfo | null>(null)
  const [toolReadout, setToolReadout] = useState<string>('')
  const [errorMessage, setErrorMessage] = useState('')

  useEffect(() => {
    let disposed = false
    const socket = new WebSocket(renderWsUrl)
    socket.binaryType = 'arraybuffer'
    socketRef.current = socket
    setConnectionState('connecting')
    setErrorMessage('')

    socket.onopen = () => {
      if (disposed) return
      setConnectionState('open')
      sendSocketMessage(socket, {
        type: 'openStudy',
        requestId: nextRequestId(requestSeqRef),
        studyInstanceUid,
        seriesInstanceUid,
        initialSopInstanceUid: sopInstanceUid,
        initialSlice: Number(searchParams.get('slice') || 174),
        orientation: initialOrientation,
        windowWidth: Number(searchParams.get('ww') || 80),
        windowLevel: Number(searchParams.get('wl') || 35),
      })
    }

    socket.onmessage = (event) => {
      if (disposed) return
      if (typeof event.data === 'string') {
        handleJsonMessage(event.data)
        return
      }
      void drawBinaryFrame(event.data)
    }

    socket.onerror = () => {
      if (disposed) return
      setConnectionState('error')
      setErrorMessage('WebSocket render connection error.')
    }

    socket.onclose = () => {
      if (disposed) return
      setConnectionState('closed')
    }

    function handleJsonMessage(raw: string) {
      try {
        const message = JSON.parse(raw)
        if (message.type === 'session') {
          setSessionInfo(message as SessionInfo)
          return
        }
        if (message.type === 'frame') {
          pendingFrameRef.current = message as FrameInfo
          return
        }
        if (message.type === 'toolResult' && message.tool === 'probe') {
          setToolReadout(`HU ${Math.round(Number(message.hu || 0))} @ ${Math.round(Number(message.x || 0))}, ${Math.round(Number(message.y || 0))}`)
          return
        }
        if (message.type === 'error') {
          setErrorMessage(String(message.message || 'Render server error'))
        }
      } catch {
        setErrorMessage('Invalid WebSocket JSON message.')
      }
    }

    async function drawBinaryFrame(data: Blob | ArrayBuffer) {
      const canvas = canvasRef.current
      const frame = pendingFrameRef.current
      if (!canvas || !frame) return

      const blob = data instanceof Blob ? data : new Blob([data], { type: 'image/jpeg' })
      const bitmap = await createImageBitmap(blob)
      const context = canvas.getContext('2d')
      if (!context) {
        bitmap.close()
        return
      }

      canvas.width = bitmap.width
      canvas.height = bitmap.height
      context.drawImage(bitmap, 0, 0)
      bitmap.close()

      frameInfoRef.current = frame
      setFrameInfo(frame)
      pendingFrameRef.current = null
    }

    return () => {
      disposed = true
      socket.close()
      if (socketRef.current === socket) {
        socketRef.current = null
      }
    }
  }, [initialOrientation, renderWsUrl, searchParams, seriesInstanceUid, sopInstanceUid, studyInstanceUid])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const handleWheel = (event: WheelEvent) => {
      event.preventDefault()
      sendInteraction(socketRef.current, requestSeqRef, {
        action: 'scroll',
        delta: event.deltaY > 0 ? 1 : -1,
      })
    }

    canvas.addEventListener('wheel', handleWheel, { passive: false })
    return () => {
      canvas.removeEventListener('wheel', handleWheel)
    }
  }, [])

  function handlePointerDown(event: PointerEvent<HTMLCanvasElement>) {
    event.currentTarget.setPointerCapture(event.pointerId)
    dragRef.current = {
      x: event.clientX,
      y: event.clientY,
      mode: event.ctrlKey || event.metaKey ? 'zoom' : event.shiftKey ? 'pan' : 'windowLevel',
    }
  }

  function handlePointerMove(event: PointerEvent<HTMLCanvasElement>) {
    const drag = dragRef.current
    if (!drag) return
    const deltaX = event.clientX - drag.x
    const deltaY = event.clientY - drag.y
    drag.x = event.clientX
    drag.y = event.clientY

    if (drag.mode === 'pan') {
      sendInteraction(socketRef.current, requestSeqRef, {
        action: 'pan',
        deltaX,
        deltaY,
      })
      return
    }
    if (drag.mode === 'zoom') {
      sendInteraction(socketRef.current, requestSeqRef, {
        action: 'zoom',
        delta: -deltaY / 240,
      })
      return
    }
    sendInteraction(socketRef.current, requestSeqRef, {
      action: 'windowLevel',
      deltaWidth: deltaX,
      deltaLevel: -deltaY,
    })
  }

  function handlePointerUp(event: PointerEvent<HTMLCanvasElement>) {
    dragRef.current = null
    event.currentTarget.releasePointerCapture(event.pointerId)
  }

  function handleProbe(event: MouseEvent<HTMLCanvasElement>) {
    if (!event.altKey) return
    const canvas = canvasRef.current
    const socket = socketRef.current
    if (!canvas || !socket || socket.readyState !== WebSocket.OPEN) return
    const rect = canvas.getBoundingClientRect()
    const scaleX = canvas.width / Math.max(1, rect.width)
    const scaleY = canvas.height / Math.max(1, rect.height)
    sendSocketMessage(socket, {
      type: 'probe',
      requestId: nextRequestId(requestSeqRef),
      x: (event.clientX - rect.left) * scaleX,
      y: (event.clientY - rect.top) * scaleY,
    })
  }

  const dimensions = sessionInfo?.geometry?.dimensions ?? []
  const spacing = sessionInfo?.geometry?.spacing ?? []
  const activeOrientation = frameInfo?.orientation ?? initialOrientation

  return (
    <main className="thin-render-page">
      <section className="thin-render-toolbar">
        <div>
          <strong>VEXA Thin Client SSR PoC</strong>
          <span>{connectionState}</span>
        </div>
        <div className="thin-render-segment" aria-label="MPR orientation">
          {(['axial', 'sagittal', 'coronal'] as const).map((orientation) => (
            <button
              key={orientation}
              type="button"
              className={activeOrientation === orientation ? 'active' : ''}
              onClick={() => sendInteraction(socketRef.current, requestSeqRef, { action: 'orientation', orientation })}
            >
              {orientation === 'axial' ? 'Axial' : orientation === 'sagittal' ? 'Sagittal' : 'Coronal'}
            </button>
          ))}
        </div>
        <button type="button" onClick={() => sendInteraction(socketRef.current, requestSeqRef, { action: 'reset' })}>
          Reset
        </button>
      </section>

      <section className="thin-render-stage">
        <canvas
          ref={canvasRef}
          className="thin-render-canvas"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          onClick={handleProbe}
        />
        <aside className="thin-render-overlay top-left">
          <div>{studyInstanceUid || 'No Study UID'}</div>
          <div>{seriesInstanceUid || 'No Series UID'}</div>
          <div>Target SOP: {sopInstanceUid || '-'}</div>
          <div>WS: {renderWsUrl}</div>
          <div>Dims: {dimensions.join(' x ') || '-'}</div>
          <div>Spacing: {spacing.map((value) => Number(value).toFixed(3)).join(' / ') || '-'}</div>
          <div>Server cache: {sessionInfo?.serverVolume ? `${Math.round(sessionInfo.serverVolume.bytes / 1024 / 1024)} MB` : '-'}</div>
          <div>Volume load: {sessionInfo?.serverVolume ? `${sessionInfo.serverVolume.loadMs} ms` : '-'}</div>
          <div>Transfer syntax: {sessionInfo?.serverVolume?.transferSyntaxUid || '-'}</div>
        </aside>
        <aside className="thin-render-overlay bottom-left">
          <div>Wheel: slice scroll</div>
          <div>Drag: WW/WL</div>
          <div>Shift+Drag: pan</div>
          <div>Ctrl+Drag: zoom</div>
          <div>Alt+Click: server HU probe</div>
        </aside>
        <aside className="thin-render-overlay bottom-right">
          <div>Plane: {frameInfo?.orientation?.toUpperCase() ?? '-'}</div>
          <div>Slice: {frameInfo ? `${frameInfo.slice + 1} / ${frameInfo.totalSlices}` : '-'}</div>
          <div>SOP: {frameInfo?.sopInstanceUid || '-'}</div>
          <div>WW/WL: {frameInfo ? `${frameInfo.windowWidth}/${frameInfo.windowLevel}` : '-'}</div>
          <div>Zoom: {frameInfo?.zoom ?? '-'}</div>
          <div>Frame: {frameInfo?.byteLength ? `${Math.round(frameInfo.byteLength / 1024)} KB` : '-'}</div>
          <div>Server render: {frameInfo?.renderMs ?? '-'} ms</div>
          <div>{toolReadout}</div>
        </aside>
        {errorMessage && <div className="thin-render-error">{errorMessage}</div>}
      </section>
    </main>
  )
}

function nextRequestId(ref: MutableRefObject<number>) {
  ref.current += 1
  return `thin-${Date.now()}-${ref.current}`
}

function sendInteraction(socket: WebSocket | null, requestSeqRef: MutableRefObject<number>, payload: Record<string, unknown>) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return
  sendSocketMessage(socket, {
    type: 'interaction',
    requestId: nextRequestId(requestSeqRef),
    ...payload,
  })
}

function sendSocketMessage(socket: WebSocket, payload: Record<string, unknown>) {
  socket.send(JSON.stringify(payload))
}
