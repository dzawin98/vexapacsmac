import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Clipboard,
  Columns3,
  FileImage,
  FileOutput,
  FileText,
  Film,
  Layers3,
  Link2,
  Loader2,
  Maximize2,
  Monitor,
  PanelBottom,
  Printer,
  RectangleHorizontal,
  RotateCw,
  Rows3,
  Ruler,
  ScanLine,
  Send,
  Settings2,
  SlidersHorizontal,
  Type,
  UserRoundX,
  X,
  ZoomIn,
} from 'lucide-react'
import type { ExportFormat, ExportImageTransform, ExportIntent, ExportPreview, ExportScope, ViewerExportRequest, ViewerExportResult } from '../exportCenter'
import { getPdfPreviewPlan, loadDicomPrintSettings, parseExportPageSelection, type DicomPrintSettings } from '../exportCenter'

export type ExportCenterTarget = {
  id: string
  label: string
  modality: string
  size: string
  supportsSeries: boolean
  imageCount: number
  currentImageNumber: number
}

const dicomPrintGridDimensions = Array.from({ length: 10 }, (_, index) => index + 1)
const defaultExportImageTransform: ExportImageTransform = { scalePercent: 100, offsetXPercent: 0, offsetYPercent: 0 }

type ExportCenterDialogProps = {
  open: boolean
  targets: ExportCenterTarget[]
  preferredTargetId: string
  initialFileName?: string
  initialTargetIds?: string[]
  initialFormat?: ExportFormat
  mode?: 'export' | 'capture'
  busy: boolean
  status: { type: 'idle' | 'error' | 'success'; message: string }
  onClose: () => void
  onClearStatus?: () => void
  onExecute: (request: ViewerExportRequest) => Promise<ViewerExportResult>
}

const formats: Array<{ id: ExportFormat; label: string; icon: typeof FileImage }> = [
  { id: 'pdf', label: 'PDF', icon: FileText },
  { id: 'png', label: 'PNG', icon: FileImage },
  { id: 'jpeg', label: 'JPEG', icon: FileImage },
  { id: 'mp4', label: 'MP4', icon: Film },
  { id: 'avi', label: 'AVI', icon: Film },
  { id: 'mpeg', label: 'MPEG', icon: Film },
  { id: 'dicom-print', label: 'DICOM Print', icon: Printer },
]

export function ExportCenterDialog({
  open,
  targets,
  preferredTargetId,
  initialFileName = 'VEXA Export',
  initialTargetIds = [],
  initialFormat = 'pdf',
  mode = 'export',
  busy,
  status,
  onClose,
  onClearStatus,
  onExecute,
}: ExportCenterDialogProps) {
  const isCapture = mode === 'capture'
  const [format, setFormat] = useState<ExportFormat>(isCapture ? 'dicom' : initialFormat)
  const [scope, setScope] = useState<ExportScope>('current')
  const [selectedTargetIds, setSelectedTargetIds] = useState<string[]>(() => {
    const availableIds = new Set(targets.map((target) => target.id))
    const initial = initialTargetIds.filter((targetId) => availableIds.has(targetId))
    return initial.length > 0 ? initial : preferredTargetId ? [preferredTargetId] : []
  })
  const [selectedPages, setSelectedPages] = useState('')
  const [fileName, setFileName] = useState(initialFileName)
  const [seriesName, setSeriesName] = useState('')
  const [quality, setQuality] = useState(0.92)
  const [fps, setFps] = useState(24)
  const [tileLayout, setTileLayout] = useState('auto')
  const [orientation, setOrientation] = useState<'portrait' | 'landscape'>('portrait')
  const [includeTextOverlay, setIncludeTextOverlay] = useState(() => !isCapture)
  const [includeAnnotations, setIncludeAnnotations] = useState(true)
  const [includeMasks, setIncludeMasks] = useState(true)
  const [anonymize, setAnonymize] = useState(false)
  const [trueSize, setTrueSize] = useState(isCapture)
  const [targetLongEdge, setTargetLongEdge] = useState(() => isCapture ? 3840 : initialFormat === 'mp4' || initialFormat === 'avi' || initialFormat === 'mpeg' ? 2048 : 3072)
  const [preview, setPreview] = useState<ExportPreview | null>(null)
  const [pdfImageTransforms, setPdfImageTransforms] = useState<Record<number, ExportImageTransform>>({})
  const [selectedPdfImageIndex, setSelectedPdfImageIndex] = useState(0)
  const [syncImageTransforms, setSyncImageTransforms] = useState(false)
  const [pdfImagePanning, setPdfImagePanning] = useState(false)
  const pdfPanDragRef = useRef<{ pointerId: number; imageIndex: number; clientX: number; clientY: number; x: number; y: number } | null>(null)
  const previewMediaRef = useRef<HTMLDivElement | null>(null)
  const [previewMediaSize, setPreviewMediaSize] = useState({ width: 0, height: 0 })
  const [printSettings, setPrintSettings] = useState<DicomPrintSettings | null>(null)
  const [printerId, setPrinterId] = useState('')
  const [filmSizeId, setFilmSizeId] = useState('14INX17IN')
  const [printColumns, setPrintColumns] = useState(1)
  const [printRows, setPrintRows] = useState(1)
  const [includeFilmFooter, setIncludeFilmFooter] = useState(true)
  const [printPagesByTarget, setPrintPagesByTarget] = useState<Record<string, string>>(() => {
    const target = targets.find((item) => item.id === preferredTargetId) ?? targets[0]
    return target ? { [target.id]: String(Math.max(1, target.currentImageNumber)) } : {}
  })
  const [stillPreviewActive, setStillPreviewActive] = useState(false)
  const [previewPageIndex, setPreviewPageIndex] = useState(0)
  const livePreviewSequence = useRef(0)
  const dicomPreviewVariantsRef = useRef<NonNullable<ViewerExportResult['previewVariants']>>({})
  const previewObjectUrlsRef = useRef(new Set<string>())
  const skipNextFooterPreviewRef = useRef(false)
  const onExecuteRef = useRef(onExecute)
  useEffect(() => { onExecuteRef.current = onExecute }, [onExecute])

  useEffect(() => () => {
    previewObjectUrlsRef.current.forEach((url) => URL.revokeObjectURL(url))
    previewObjectUrlsRef.current.clear()
  }, [])

  useEffect(() => {
    if (open) return
    previewObjectUrlsRef.current.forEach((url) => URL.revokeObjectURL(url))
    previewObjectUrlsRef.current.clear()
    dicomPreviewVariantsRef.current = {}
    setPreview(null)
  }, [open])

  useEffect(() => {
    const element = previewMediaRef.current
    if (!open || !preview || format !== 'dicom-print' || !element) return
    const updateSize = () => {
      setPreviewMediaSize({
        width: Math.max(0, element.clientWidth - 12),
        height: Math.max(0, element.clientHeight - 12),
      })
    }
    updateSize()
    const observer = new ResizeObserver(updateSize)
    observer.observe(element)
    return () => observer.disconnect()
  }, [format, open, preview])

  useEffect(() => {
    if (!open || format !== 'dicom-print') return
    loadDicomPrintSettings().then((settings) => {
      setPrintSettings(settings)
      setPrinterId((current) => current || settings.printers[0]?.id || '')
      setFilmSizeId((current) => settings.filmProfiles.some((profile) => profile.filmSizeId === current) ? current : settings.filmProfiles[0]?.filmSizeId || '')
    }).catch(() => setPrintSettings({ configured: false, printers: [], filmProfiles: [], identity: {} }))
  }, [format, open])

  const selectedTarget = targets.find((target) => target.id === selectedTargetIds[0]) ?? targets[0]
  const selectedSeriesImageCount = selectedTarget?.imageCount ?? 0
  const supportsSeries = Boolean(selectedTarget?.supportsSeries && selectedSeriesImageCount > 1)
  const selectedPrintTargets = useMemo(
    () => selectedTargetIds
      .map((targetId) => targets.find((target) => target.id === targetId))
      .filter((target): target is ExportCenterTarget => Boolean(target)),
    [selectedTargetIds, targets],
  )
  const selectedPrintPageSelections = useMemo(() => Object.fromEntries(selectedPrintTargets.map((target) => [
    target.id,
    target.supportsSeries
      ? (printPagesByTarget[target.id] ?? String(Math.max(1, target.currentImageNumber)))
      : String(Math.max(1, target.currentImageNumber)),
  ])), [printPagesByTarget, selectedPrintTargets])
  const selectedPrintImageCount = useMemo(() => selectedPrintTargets.reduce((total, target) => (
    total + parseExportPageSelection(selectedPrintPageSelections[target.id] ?? '', target.imageCount).length
  ), 0), [selectedPrintPageSelections, selectedPrintTargets])
  const printGridCapacity = printColumns * printRows
  const printFilmCount = selectedPrintImageCount > 0 ? Math.ceil(selectedPrintImageCount / printGridCapacity) : 0
  const printPreviewPlan = getPdfPreviewPlan(selectedPrintImageCount, `${printColumns}x${printRows}`, previewPageIndex)
  const printCompositionLabel = selectedPrintImageCount > 1 ? 'Multiple' : 'Single'
  const printIdentityKey = `${filmSizeId}:${orientation}`
  const printFooterPercent = Math.max(8, Math.min(30, Number(
    printSettings?.identity?.footerHeights?.[printIdentityKey]
      ?? printSettings?.identity?.footerHeight
      ?? 18,
  )))
  const activePrintFooterPercent = includeFilmFooter ? printFooterPercent : 0
  const pdfTileMatch = tileLayout.match(/^(\d+)x(\d+)$/i)
  const pdfColumns = Math.min(10, Math.max(1, Number(pdfTileMatch?.[1]) || 1))
  const pdfRows = Math.min(10, Math.max(1, Number(pdfTileMatch?.[2]) || 1))
  const isVideo = format === 'mp4' || format === 'avi' || format === 'mpeg'
  const isPdf = format === 'pdf' || format === 'dicom-print'
  const supportsPageOrientation = format === 'png' || format === 'jpeg' || format === 'pdf' || format === 'dicom-print'
  const actionLabel = isCapture ? 'Save to PACS' : format === 'dicom-print' ? 'Send to printer' : 'Export'
  const canCopy = !isPdf && !isVideo && !isCapture && scope === 'current'
  const selectedExportImageCount = useMemo(() => {
    if (isCapture) return selectedTarget ? 1 : 0
    if (scope === 'selected') return parseExportPageSelection(selectedPages, selectedSeriesImageCount).length
    if (scope === 'series') return selectedSeriesImageCount
    if (scope === 'viewports') return selectedTargetIds.length
    if (scope === 'custom') {
      return selectedPrintTargets.reduce((total, target) => total + (target.supportsSeries ? target.imageCount : 1), 0)
    }
    return selectedTarget ? 1 : 0
  }, [isCapture, scope, selectedPages, selectedPrintTargets, selectedSeriesImageCount, selectedTarget, selectedTargetIds.length])
  const compositionImageCount = format === 'dicom-print' ? selectedPrintImageCount : selectedExportImageCount
  const stillPreviewPlan = format === 'pdf'
    ? getPdfPreviewPlan(selectedExportImageCount, tileLayout, previewPageIndex)
    : getPdfPreviewPlan(selectedExportImageCount, '1x1', previewPageIndex)
  const selectedPdfImageTransform = pdfImageTransforms[selectedPdfImageIndex] ?? defaultExportImageTransform
  const scopeOptions = useMemo(() => [
    { id: 'current' as const, label: `Current image${selectedTarget ? ` (${selectedTarget.currentImageNumber}/${Math.max(1, selectedTarget.imageCount)})` : ''}`, enabled: true },
    { id: 'selected' as const, label: 'Selected images', enabled: supportsSeries },
    { id: 'series' as const, label: `Entire series (${selectedSeriesImageCount} images)`, enabled: supportsSeries },
    { id: 'viewports' as const, label: 'Current images from viewports', enabled: targets.length > 1 },
    { id: 'custom' as const, label: 'Entire series from viewports', enabled: targets.length > 1 || supportsSeries },
  ], [selectedSeriesImageCount, selectedTarget, supportsSeries, targets.length])

  useEffect(() => {
    if (!open || format !== 'dicom-print') return
    setPrintPagesByTarget((current) => {
      let changed = false
      const next = { ...current }
      selectedPrintTargets.forEach((target) => {
        if (next[target.id] === undefined) {
          next[target.id] = String(Math.max(1, target.currentImageNumber))
          changed = true
        }
      })
      return changed ? next : current
    })
  }, [format, open, selectedPrintTargets])

  const execute = useCallback(async (intent: ExportIntent, livePreview = false, sequence = 0) => {
    const captureTargetId = selectedTarget?.id ?? preferredTargetId
    const identityTemplate = printSettings?.identity?.templates?.[`${filmSizeId}:${orientation}`]
    const identityKey = `${filmSizeId}:${orientation}`
    const selectedIdentity = printSettings?.identity
      ? { ...printSettings.identity, elements: identityTemplate || printSettings.identity.elements, footerHeight: printSettings.identity.footerHeights?.[identityKey], logoSize: printSettings.identity.logoSizes?.[identityKey], referenceWidth: orientation === 'portrait' ? 420 : 720 }
      : undefined
    const activePreviewPlan = format === 'dicom-print' ? printPreviewPlan : stillPreviewPlan
    const activeItemCount = format === 'dicom-print' ? selectedPrintImageCount : selectedExportImageCount
    const compositionLongEdge = getCompositionCaptureLongEdge(
      format,
      orientation,
      format === 'dicom-print' ? printColumns : tileLayout === 'auto' ? 3 : pdfColumns,
      format === 'dicom-print' ? printRows : tileLayout === 'auto' ? 4 : pdfRows,
      targetLongEdge,
    )
    const result = await onExecuteRef.current({
      format,
      scope: isCapture ? 'current' : format === 'dicom-print' ? 'custom' : scope,
      intent,
      targetIds: isCapture && captureTargetId ? [captureTargetId] : selectedTargetIds,
      selectedPages: isCapture || format === 'dicom-print' ? '' : selectedPages,
      targetPageSelections: format === 'dicom-print' ? selectedPrintPageSelections : undefined,
      fileName,
      seriesName,
      quality,
      fps,
      tileLayout: format === 'dicom-print' ? `${printColumns}x${printRows}` : tileLayout,
      orientation,
      sendToReport: false,
      livePreview,
      selectedItemCount: activeItemCount,
      previewItemOffset: intent === 'preview' && !isVideo ? activePreviewPlan.itemOffset : undefined,
      previewItemLimit: intent === 'preview' && !isVideo ? activePreviewPlan.itemLimit : undefined,
      previewTotalItems: intent === 'preview' && !isVideo ? activeItemCount : undefined,
      previewPageIndex: intent === 'preview' && !isVideo ? activePreviewPlan.pageIndex : undefined,
      previewPageCount: intent === 'preview' && !isVideo ? activePreviewPlan.pageCount : undefined,
      pdfImages: format === 'pdf' ? pdfImageTransforms : undefined,
      // The server sends one fully composed film raster to the printer, so the
      // DIMSE image box remains 1x1 even when the raster contains a collage.
      dicomPrint: format === 'dicom-print' ? { printerId, filmSizeId, layout: 'STANDARD\\1,1', imageScalePercent: 100, imageTransforms: pdfImageTransforms, filmCapacity: printGridCapacity, identity: selectedIdentity, includeFooter: includeFilmFooter } : undefined,
      render: {
        includeTextOverlay,
        includeAnnotations: isCapture || includeAnnotations,
        includeMasks: isCapture || includeMasks,
        anonymize: isCapture ? false : anonymize,
        trueSize,
        targetLongEdge: isCapture
          ? 3840
          : intent === 'preview'
            ? Math.min(activeItemCount > 4 ? 1280 : 2048, targetLongEdge)
            : compositionLongEdge,
      },
    })
    if (result.preview) {
      const resultPreviews = [
        result.preview,
        result.previewVariants?.filmFooterOn,
        result.previewVariants?.filmFooterOff,
      ].filter((item): item is ExportPreview => Boolean(item))
      const resultUrls = new Set(resultPreviews.map((item) => item.url))
      if (livePreview && sequence !== livePreviewSequence.current) {
        resultUrls.forEach((url) => URL.revokeObjectURL(url))
        return
      }
      await Promise.all(resultPreviews
        .filter((item) => item.type === 'image')
        .map((item) => decodePreviewImage(item.url)))
      if (livePreview && sequence !== livePreviewSequence.current) {
        resultUrls.forEach((url) => URL.revokeObjectURL(url))
        return
      }
      const previousUrls = new Set(previewObjectUrlsRef.current)
      previewObjectUrlsRef.current = resultUrls
      dicomPreviewVariantsRef.current = result.previewVariants ?? {}
      setPreview(result.preview)
      window.requestAnimationFrame(() => {
        previousUrls.forEach((url) => {
          if (!resultUrls.has(url)) URL.revokeObjectURL(url)
        })
      })
    }
  }, [anonymize, fileName, filmSizeId, format, fps, includeAnnotations, includeFilmFooter, includeMasks, includeTextOverlay, isCapture, isVideo, orientation, pdfColumns, pdfImageTransforms, pdfRows, preferredTargetId, printColumns, printGridCapacity, printPreviewPlan, printRows, printSettings, printerId, quality, scope, selectedExportImageCount, selectedPages, selectedPrintImageCount, selectedPrintPageSelections, selectedTarget, selectedTargetIds, seriesName, stillPreviewPlan, targetLongEdge, tileLayout, trueSize])

  const executePreviewRef = useRef(execute)
  useEffect(() => { executePreviewRef.current = execute }, [execute])

  const stillPreviewRequestKey = JSON.stringify({
    format,
    scope,
    selectedTargetIds,
    selectedPages,
    quality,
    tileLayout,
    orientation,
    includeTextOverlay,
    includeFilmFooter,
    includeAnnotations,
    includeMasks,
    anonymize,
    trueSize,
    targetLongEdge,
    pdfImageTransforms,
    selectedExportImageCount,
    stillPreviewPlan,
    targetFrames: scope === 'current' || scope === 'viewports'
      ? selectedTargetIds.map((targetId) => {
        const target = targets.find((item) => item.id === targetId)
        return [targetId, target?.currentImageNumber ?? 0, target?.imageCount ?? 0]
      })
      : [],
  })

  useEffect(() => {
    if (!open || busy || format !== 'dicom-print' || !filmSizeId || !printSettings || selectedPrintImageCount === 0) return
    if (skipNextFooterPreviewRef.current) {
      skipNextFooterPreviewRef.current = false
      return
    }
    const sequence = ++livePreviewSequence.current
    const timer = window.setTimeout(() => {
      void executePreviewRef.current('preview', true, sequence)
    }, 0)
    return () => window.clearTimeout(timer)
  }, [busy, filmSizeId, format, includeFilmFooter, includeTextOverlay, open, orientation, pdfImageTransforms, previewPageIndex, printColumns, printPagesByTarget, printRows, printSettings, printerId, selectedPrintImageCount, selectedTargetIds])

  useEffect(() => {
    if (!open || busy || !stillPreviewActive || (format !== 'pdf' && format !== 'png' && format !== 'jpeg')) return
    const sequence = ++livePreviewSequence.current
    const timer = window.setTimeout(() => {
      void executePreviewRef.current('preview', true, sequence)
    }, pdfImagePanning ? 0 : 32)
    return () => window.clearTimeout(timer)
  }, [busy, format, open, pdfImagePanning, stillPreviewActive, stillPreviewRequestKey])

  useEffect(() => {
    // A preview belongs to the format that created it. Invalidate any pending
    // DICOM Print render and remove its preview when the output format changes.
    if (format !== 'dicom-print') livePreviewSequence.current += 1
    setStillPreviewActive(false)
    setPreview((current) => {
      if (current?.url) URL.revokeObjectURL(current.url)
      return null
    })
  }, [format])

  useEffect(() => {
    if (open) return
    // Invalidate a live-preview result that finishes after the dialog closes.
    livePreviewSequence.current += 1
  }, [open])

  useEffect(() => {
    const grid = preview?.grid
    if ((format !== 'pdf' && format !== 'dicom-print') || !grid || grid.itemCount <= 0) return
    setSelectedPdfImageIndex((current) => (
      current >= grid.itemOffset && current < grid.itemOffset + grid.itemCount
        ? current
        : grid.itemOffset
    ))
  }, [format, preview?.grid?.itemCount, preview?.grid?.itemOffset])

  useEffect(() => {
    setPdfImageTransforms({})
    setSelectedPdfImageIndex(0)
  }, [scope, selectedPages, selectedTargetIds.join('|')])

  useEffect(() => {
    if (format !== 'dicom-print') return
    setPdfImageTransforms({})
    setSelectedPdfImageIndex(0)
  }, [format, JSON.stringify(printPagesByTarget)])

  const beginPdfImagePan = (event: React.PointerEvent<HTMLImageElement>) => {
    if ((format !== 'pdf' && format !== 'dicom-print') || !preview?.grid) return
    const imageIndex = getExportImageIndexAtPointer(event, preview, format, orientation, filmSizeId, printFooterPercent)
    if (imageIndex === null) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    const transform = pdfImageTransforms[imageIndex] ?? defaultExportImageTransform
    setSelectedPdfImageIndex(imageIndex)
    pdfPanDragRef.current = {
      pointerId: event.pointerId,
      imageIndex,
      clientX: event.clientX,
      clientY: event.clientY,
      x: transform.offsetXPercent,
      y: transform.offsetYPercent,
    }
    setPdfImagePanning(true)
  }

  const movePdfImagePan = (event: React.PointerEvent<HTMLImageElement>) => {
    const drag = pdfPanDragRef.current
    if (!drag || drag.pointerId !== event.pointerId || (format !== 'pdf' && format !== 'dicom-print')) return
    event.preventDefault()
    const geometry = preview?.grid ? getExportCellGeometry(preview.grid, drag.imageIndex, format, orientation, filmSizeId, printFooterPercent) : null
    const width = Math.max(1, event.currentTarget.clientWidth * (geometry ? geometry.width / geometry.page.width : 1))
    const height = Math.max(1, event.currentTarget.clientHeight * (geometry ? geometry.height / geometry.page.height : 1))
    setPdfImageTransforms((current) => ({
      ...applyExportImageTransform(
        current,
        drag.imageIndex,
        compositionImageCount,
        {
          ...(current[drag.imageIndex] ?? defaultExportImageTransform),
        offsetXPercent: Math.max(-100, Math.min(100, drag.x + (event.clientX - drag.clientX) / width * 100)),
        offsetYPercent: Math.max(-100, Math.min(100, drag.y + (event.clientY - drag.clientY) / height * 100)),
        },
        syncImageTransforms,
      ),
    }))
  }

  const endPdfImagePan = (event: React.PointerEvent<HTMLImageElement>) => {
    if (pdfPanDragRef.current?.pointerId !== event.pointerId) return
    pdfPanDragRef.current = null
    setPdfImagePanning(false)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }

  const updateSelectedPdfImageTransform = (change: Partial<ExportImageTransform>) => {
    setPdfImageTransforms((current) => {
      const transform = {
        ...(current[selectedPdfImageIndex] ?? defaultExportImageTransform),
        ...change,
      }
      return applyExportImageTransform(current, selectedPdfImageIndex, compositionImageCount, transform, syncImageTransforms)
    })
  }

  const changeImageTransformSync = (enabled: boolean) => {
    setSyncImageTransforms(enabled)
    if (!enabled) return
    setPdfImageTransforms((current) => applyExportImageTransform(
      current,
      selectedPdfImageIndex,
      compositionImageCount,
      current[selectedPdfImageIndex] ?? defaultExportImageTransform,
      true,
    ))
  }

  const selectedPdfCellStyle = (format === 'pdf' || format === 'dicom-print') && preview?.grid
    ? getExportSelectedCellStyle(preview.grid, selectedPdfImageIndex, format, orientation, filmSizeId, activePrintFooterPercent)
    : null
  const filmRatio = filmPreviewAspectRatio(filmSizeId, orientation)
  const filmFrameStyle = format === 'dicom-print'
    ? fitPreviewFrame(previewMediaSize.width, previewMediaSize.height, filmRatio)
    : undefined

  if (!open) return null

  return createPortal(
    <div className="export-center-backdrop" onPointerDown={(event) => event.target === event.currentTarget && !busy && onClose()}>
      <div className={`export-center-workspace${preview ? ' has-preview' : ''}`}>
      {preview && (
        <aside className={`export-center-preview${format === 'dicom-print' ? ' film-preview' : ''}`} aria-label="Export preview">
          <header>
            <span className="export-center-preview-title">{format === 'dicom-print' ? <Film size={13} /> : <FileImage size={13} />}{preview.caption || (format === 'dicom-print' ? 'Film Preview' : `${format.toUpperCase()} Preview`)}</span>
            <div className="export-center-preview-actions">
              {(preview.pageCount ?? 1) > 1 && <>
                <button type="button" disabled={(preview.pageIndex ?? 0) <= 0} onClick={() => setPreviewPageIndex((current) => Math.max(0, current - 1))} title="Previous page" aria-label="Previous preview page"><ChevronLeft size={13} /></button>
                <button type="button" disabled={(preview.pageIndex ?? 0) >= (preview.pageCount ?? 1) - 1} onClick={() => setPreviewPageIndex((current) => Math.min((preview.pageCount ?? 1) - 1, current + 1))} title="Next page" aria-label="Next preview page"><ChevronRight size={13} /></button>
              </>}
              <button type="button" onClick={() => { setStillPreviewActive(false); setPreview(null) }} title="Close preview" aria-label="Close preview"><X size={13} /></button>
            </div>
          </header>
          {(format === 'pdf' || format === 'dicom-print') && preview.type === 'image' && (
            <div className="export-center-preview-zoom" aria-label="PDF preview zoom">
              <span className="export-center-control-title"><ZoomIn size={13} />Image {selectedPdfImageIndex + 1}</span>
              <input
                aria-label={`${format === 'dicom-print' ? 'DICOM print' : 'PDF'} image zoom`}
                type="range"
                min="50"
                max="250"
                step="10"
                value={selectedPdfImageTransform.scalePercent}
                onChange={(event) => updateSelectedPdfImageTransform({ scalePercent: Number(event.currentTarget.value) })}
              />
              <output>{selectedPdfImageTransform.scalePercent}%</output>
              <button type="button" onClick={() => updateSelectedPdfImageTransform(defaultExportImageTransform)}><Maximize2 size={12} />Fit</button>
              <label className="export-center-preview-sync">
                <input type="checkbox" checked={syncImageTransforms} onChange={(event) => changeImageTransformSync(event.currentTarget.checked)} />
                <Link2 size={12} /><span>Sync images</span>
              </label>
              <small>{syncImageTransforms ? 'Zoom, pan, and reset are synchronized across all images.' : 'Select a tile, then drag it to pan. Other images remain unchanged.'}</small>
            </div>
          )}
          <div className="export-center-preview-media" ref={previewMediaRef}>
            {preview.type === 'image'
              ? format === 'pdf' || format === 'dicom-print'
                ? <div className="pdf-preview-interactive" style={filmFrameStyle}>
                  <img
                    alt={format === 'dicom-print' ? 'DICOM film preview' : 'PDF export preview'}
                    className={`pdf-image-pan-target${pdfImagePanning ? ' panning' : ''}`}
                    draggable={false}
                    src={preview.url}
                    onPointerDown={beginPdfImagePan}
                    onPointerMove={movePdfImagePan}
                    onPointerUp={endPdfImagePan}
                    onPointerCancel={endPdfImagePan}
                  />
                  {selectedPdfCellStyle && <span className="pdf-preview-selected-cell" style={selectedPdfCellStyle} aria-hidden="true" />}
                </div>
                : <img alt={`${format.toUpperCase()} export preview`} draggable={false} src={preview.url} />
              : <video controls autoPlay src={preview.url} />}
          </div>
        </aside>
      )}

      <section className="export-center-dialog" role="dialog" aria-modal="true" aria-label={isCapture ? 'Capture viewports to PACS' : 'Export images'}>
        <header className="export-center-header">
          <div className="export-center-heading">
            <FileOutput size={18} aria-hidden="true" />
            <div>
              <strong>{isCapture ? 'Capture Viewport' : format === 'dicom-print' ? 'DICOM Print' : 'Export & Print'}</strong>
              {isCapture && <span>DICOM Secondary Capture</span>}
            </div>
          </div>
          <button type="button" title="Close" aria-label="Close export" disabled={busy} onClick={onClose}><X size={16} /></button>
        </header>

        <div className="export-center-body">
          {!isCapture && <div className="export-center-source-row">
            <label className="export-center-field export-center-format-field">
              <span className="export-center-field-label"><FileOutput size={12} />Format</span>
              <select value={format} disabled={busy} onChange={(event) => {
                const nextFormat = event.currentTarget.value as ExportFormat
                setFormat(nextFormat)
                onClearStatus?.()
                setPreviewPageIndex(0)
                setPdfImageTransforms({})
                setSelectedPdfImageIndex(0)
                setSyncImageTransforms(false)
                if (nextFormat === 'dicom-print') { setScope('current'); setTileLayout('1x1') }
                if (nextFormat === 'mp4' || nextFormat === 'avi' || nextFormat === 'mpeg') setTargetLongEdge(2048)
              }}>
                {formats.map((item) => <option value={item.id} key={item.id}>{item.label}</option>)}
              </select>
            </label>

            {supportsPageOrientation && (
              <label className="export-center-field">
                <span className="export-center-field-label"><RotateCw size={12} />Orientation</span>
                <select value={orientation} disabled={busy} onChange={(event) => setOrientation(event.currentTarget.value as 'portrait' | 'landscape')}>
                  <option value="portrait">Portrait</option>
                  <option value="landscape">Landscape</option>
                </select>
              </label>
            )}

            {format !== 'dicom-print' && scope !== 'viewports' && scope !== 'custom' && selectedTarget && (
              <label className="export-center-field">
                <span className="export-center-field-label"><Monitor size={12} />Viewport</span>
                <select value={selectedTargetIds[0] || selectedTarget.id} disabled={busy} onChange={(event) => { setSelectedTargetIds([event.currentTarget.value]); setPreviewPageIndex(0) }}>
                  {targets.map((target) => <option value={target.id} key={target.id}>{target.label}</option>)}
                </select>
              </label>
            )}
          </div>}

          {!isCapture && format !== 'dicom-print' && <div className="export-center-columns">
            <fieldset className="export-center-scope" disabled={busy}>
              <legend><span className="export-center-legend"><Layers3 size={12} />Scope</span></legend>
              {scopeOptions.map((option) => (
                <label className={!option.enabled ? 'disabled' : ''} key={option.id}>
                  <input
                    type="radio"
                    name="export-scope"
                    checked={scope === option.id}
                    disabled={!option.enabled}
                  onChange={() => {
                    setScope(option.id)
                    setPreviewPageIndex(0)
                    if (option.id === 'selected' && parseExportPageSelection(selectedPages, selectedSeriesImageCount).length === 0) {
                      setSelectedPages(String(Math.max(1, selectedTarget?.currentImageNumber ?? 1)))
                    }
                  }}
                  />
                  <span>{option.label}</span>
                </label>
              ))}
              {scope === 'selected' && (
                <label className="export-center-pages">
                  <span>Pages</span>
                  <input value={selectedPages} placeholder={`e.g. 1,3-5 / ${selectedSeriesImageCount}`} onChange={(event) => { setSelectedPages(event.currentTarget.value); setPreviewPageIndex(0) }} />
                </label>
              )}
              <output className={selectedExportImageCount > 0 ? 'export-center-scope-summary' : 'export-center-scope-summary error'}>
                {selectedExportImageCount > 0
                  ? `${selectedExportImageCount} image${selectedExportImageCount === 1 ? '' : 's'} selected`
                  : 'No valid images selected'}
              </output>
            </fieldset>

            <fieldset className="export-center-output" disabled={busy}>
              <legend><span className="export-center-legend"><Settings2 size={12} />Output</span></legend>
              <label><input type="checkbox" checked={includeTextOverlay} onChange={(event) => setIncludeTextOverlay(event.currentTarget.checked)} /> <Type size={11} /><span>Text overlay</span></label>
              <label><input type="checkbox" checked={includeAnnotations} onChange={(event) => setIncludeAnnotations(event.currentTarget.checked)} /> <Ruler size={11} /><span>Annotations</span></label>
              <label><input type="checkbox" checked={includeMasks} onChange={(event) => setIncludeMasks(event.currentTarget.checked)} /> <ScanLine size={11} /><span>Masks</span></label>
              <label><input type="checkbox" checked={anonymize} onChange={(event) => setAnonymize(event.currentTarget.checked)} /> <UserRoundX size={11} /><span>Anonymize</span></label>
              {(format === 'png' || format === 'jpeg')
                ? <label><input type="checkbox" checked={!trueSize} onChange={(event) => setTrueSize(!event.currentTarget.checked)} /> <Maximize2 size={11} /><span>Fit to page</span></label>
                : format !== 'pdf' && <label><input type="checkbox" checked={trueSize} onChange={(event) => setTrueSize(event.currentTarget.checked)} /> <ScanLine size={11} /><span>True size</span></label>}
            </fieldset>
          </div>}

          {!isCapture && format !== 'dicom-print' && scope === 'viewports' && (
            <div className="export-center-targets">
              <div className="export-center-section-label">Viewports</div>
              {targets.map((target) => {
                const selected = selectedTargetIds.includes(target.id)
                return (
                  <button className={selected ? 'selected' : ''} type="button" key={target.id} disabled={busy} onClick={() => {
                    setPreviewPageIndex(0)
                    setSelectedTargetIds((current) => selected
                      ? current.filter((id) => id !== target.id)
                      : [...current, target.id])
                  }}>
                    <span className="export-center-check">{selected && <Check size={13} />}</span>
                    <span>{target.label}</span>
                    <small>Current image · {target.currentImageNumber}/{Math.max(1, target.imageCount)}</small>
                  </button>
                )
              })}
            </div>
          )}

          {!isCapture && format !== 'dicom-print' && scope === 'custom' && (
            <div className="export-center-custom-sources">
              <div className="export-center-section-label">Viewports</div>
              {targets.map((target) => {
                const selected = selectedTargetIds.includes(target.id)
                return (
                  <label className={selected ? 'selected' : ''} key={target.id}>
                    <input
                      type="checkbox"
                      checked={selected}
                      disabled={busy}
                      onChange={() => {
                        setPreviewPageIndex(0)
                        setSelectedTargetIds((current) => selected
                          ? current.filter((id) => id !== target.id)
                          : [...current, target.id])
                      }}
                    />
                    <span>{target.label}</span>
                    <small>Entire series · {target.imageCount} images</small>
                  </label>
                )
              })}
            </div>
          )}

          {isCapture && selectedTarget && (
            <div className="export-center-capture-source" aria-label="Capture source viewport">
              <span>Source viewport</span>
              <strong>{selectedTarget.label}</strong>
            </div>
          )}

          {format !== 'dicom-print' && <div className={`export-center-details${isCapture ? ' capture' : ''}`}>
            <label className="export-center-field">
              <span className="export-center-field-label"><FileText size={12} />{isCapture ? 'Series name' : 'File name'}</span>
              <input
                autoFocus={isCapture}
                value={isCapture ? seriesName : fileName}
                disabled={busy}
                maxLength={180}
                placeholder={isCapture ? 'Enter series name' : 'VEXA Export'}
                onChange={(event) => isCapture ? setSeriesName(event.currentTarget.value) : setFileName(event.currentTarget.value)}
              />
            </label>
            {!isCapture && <label className="export-center-field export-center-resolution">
              <span className="export-center-field-label"><RectangleHorizontal size={12} />Resolution</span>
              <select value={targetLongEdge} disabled={busy || trueSize} onChange={(event) => setTargetLongEdge(Number(event.currentTarget.value))}>
                <option value={2048}>2K</option>
                <option value={3072}>3K</option>
                <option value={3840}>4K</option>
              </select>
            </label>}
          </div>}

          {isCapture && <fieldset className="export-center-capture-options" disabled={busy}>
            <legend>Capture</legend>
            <label>
              <input type="checkbox" checked={includeTextOverlay} onChange={(event) => setIncludeTextOverlay(event.currentTarget.checked)} />
              <span>Text overlay</span>
            </label>
            <label title="Use the source image dimensions when available.">
              <input type="checkbox" checked={trueSize} onChange={(event) => setTrueSize(event.currentTarget.checked)} />
              <span>True size</span>
            </label>
          </fieldset>}

          {(format === 'jpeg' || format === 'pdf' || isVideo) && (
            <div className="export-center-settings">
              <Settings2 size={15} aria-hidden="true" />
              {format === 'jpeg' && <label><SlidersHorizontal size={12} />Quality <input type="range" min="0.6" max="1" step="0.02" value={quality} onChange={(event) => setQuality(Number(event.currentTarget.value))} /><output>{Math.round(quality * 100)}%</output></label>}
              {format === 'pdf' && <>
                <label><Columns3 size={12} />Columns <select value={tileLayout === 'auto' ? 'auto' : String(pdfColumns)} onChange={(event) => {
                  const value = event.currentTarget.value
                  setTileLayout(value === 'auto' ? 'auto' : `${value}x${pdfRows}`)
                  setPreviewPageIndex(0)
                }}><option value="auto">Auto</option>{dicomPrintGridDimensions.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
                <label><Rows3 size={12} />Rows <select value={tileLayout === 'auto' ? 'auto' : String(pdfRows)} disabled={tileLayout === 'auto'} onChange={(event) => {
                  setTileLayout(`${pdfColumns}x${event.currentTarget.value}`)
                  setPreviewPageIndex(0)
                }}>{tileLayout === 'auto' && <option value="auto">Auto</option>}{dicomPrintGridDimensions.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
              </>}
              {isVideo && <label>FPS <input type="number" min="1" max="60" value={fps} onChange={(event) => setFps(Math.min(60, Math.max(1, Number(event.currentTarget.value) || 1)))} /><output>{fps}</output></label>}
            </div>
          )}

          {format === 'dicom-print' && (
            <fieldset className="export-center-output dicom-print-panel" disabled={busy}>
              <legend><span className="export-center-legend"><Printer size={12} />Print settings</span></legend>
              <div className="dicom-print-sources">
                <div className="dicom-print-source-heading">
                  <div className="export-center-section-label export-center-label-with-icon"><Monitor size={12} />Source</div>
                  <strong>{selectedPrintTargets.length} viewport{selectedPrintTargets.length === 1 ? '' : 's'}</strong>
                </div>
                <div className="dicom-print-selected-targets">
                  {selectedPrintTargets.map((target, index) => (
                    <div className={target.supportsSeries ? 'has-pages' : ''} key={target.id}>
                      <span>{index + 1}</span>
                      <div>
                        <strong>{target.label}</strong>
                        <small>{target.modality} · {target.currentImageNumber}/{Math.max(1, target.imageCount)}</small>
                      </div>
                      {target.supportsSeries && (
                        <div className="dicom-print-page-selection">
                          <input
                            aria-label={`Slices for ${target.label}`}
                            value={printPagesByTarget[target.id] ?? String(Math.max(1, target.currentImageNumber))}
                            placeholder="e.g. 1-6"
                            onChange={(event) => { setPrintPagesByTarget((current) => ({ ...current, [target.id]: event.currentTarget.value })); setPreviewPageIndex(0) }}
                          />
                          <button type="button" onClick={() => { setPrintPagesByTarget((current) => ({ ...current, [target.id]: `1-${target.imageCount}` })); setPreviewPageIndex(0) }}>All</button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>

              <label className="export-center-field">
                <span className="export-center-field-label"><Printer size={12} />Printer</span>
                <select value={printerId} onChange={(event) => setPrinterId(event.currentTarget.value)}>
                  <option value="">Select printer</option>
                  {printSettings?.printers.map((printer) => <option key={printer.id} value={printer.id}>{printer.name} · {printer.aet}</option>)}
                </select>
              </label>
              <label className="export-center-field">
                <span className="export-center-field-label"><RectangleHorizontal size={12} />Film size</span>
                <select value={filmSizeId} onChange={(event) => setFilmSizeId(event.currentTarget.value)}>
                  {printSettings?.filmProfiles.map((profile) => <option key={profile.id} value={profile.filmSizeId}>{profile.label}</option>)}
                </select>
              </label>
              <div className="dicom-print-grid-settings">
                <div className="dicom-print-grid-heading">
                  <div className="export-center-section-label export-center-label-with-icon"><Layers3 size={12} />Layout</div>
                  <strong>{printCompositionLabel} · {selectedPrintImageCount} image{selectedPrintImageCount === 1 ? '' : 's'}</strong>
                </div>
                <label className="export-center-field">
                  <span className="export-center-field-label"><Columns3 size={12} />Columns</span>
                  <select value={printColumns} onChange={(event) => { setPrintColumns(Number(event.currentTarget.value)); setPreviewPageIndex(0) }}>
                    {dicomPrintGridDimensions.map((value) => <option key={value} value={value}>{value}</option>)}
                  </select>
                </label>
                <label className="export-center-field">
                  <span className="export-center-field-label"><Rows3 size={12} />Rows</span>
                  <select value={printRows} onChange={(event) => { setPrintRows(Number(event.currentTarget.value)); setPreviewPageIndex(0) }}>
                    {dicomPrintGridDimensions.map((value) => <option key={value} value={value}>{value}</option>)}
                  </select>
                </label>
                <output>{printColumns} × {printRows}</output>
                <small>{selectedPrintImageCount} image{selectedPrintImageCount === 1 ? '' : 's'} · {printFilmCount} film{printFilmCount === 1 ? '' : 's'}</small>
              </div>
              <div className="dicom-print-render-options">
                <label><input type="checkbox" checked={includeTextOverlay} onChange={(event) => setIncludeTextOverlay(event.currentTarget.checked)} /><Type size={12} /><span>Text overlay</span></label>
                <label><input type="checkbox" checked={includeFilmFooter} onChange={(event) => {
                  const enabled = event.currentTarget.checked
                  const cachedPreview = enabled
                    ? dicomPreviewVariantsRef.current.filmFooterOn
                    : dicomPreviewVariantsRef.current.filmFooterOff
                  if (cachedPreview) {
                    skipNextFooterPreviewRef.current = true
                    setPreview(cachedPreview)
                  }
                  setIncludeFilmFooter(enabled)
                }} /><PanelBottom size={12} /><span>Film footer</span></label>
              </div>
              {printSettings && !printSettings.configured && <small>No active DICOM printer is configured on the Viewer Service.</small>}
            </fieldset>
          )}

        </div>

        {status.message && <div className={`export-center-status ${status.type}`} aria-live="polite">{status.message}</div>}
        <footer className="export-center-footer">
          <button type="button" disabled={busy} onClick={onClose}>Cancel</button>
          {canCopy && <button type="button" disabled={busy} onClick={() => void execute('copy')}><Clipboard size={15} />Copy</button>}
          {(format === 'pdf' || format === 'png' || format === 'jpeg') && <button type="button" disabled={busy || selectedExportImageCount === 0} onClick={() => setStillPreviewActive(true)}><Film size={15} />Preview</button>}
          {isVideo && <button type="button" disabled={busy} onClick={() => void execute('preview')}><Film size={15} />Preview</button>}
          {format === 'pdf' && <button type="button" disabled={busy} onClick={() => void execute('print')}><Printer size={15} />Print</button>}
          <button className="primary" type="button" disabled={busy || !(isCapture ? selectedTarget?.id : selectedTargetIds.length) || (!isCapture && format !== 'dicom-print' && selectedExportImageCount === 0) || (isCapture && !seriesName.trim()) || (format === 'dicom-print' && (!printerId || !filmSizeId || selectedPrintImageCount === 0))} onClick={() => void execute('export')}>
            {busy ? <Loader2 className="spin" size={15} /> : format === 'dicom-print' ? <Send size={15} /> : <FileOutput size={15} />}
            {actionLabel}
          </button>
        </footer>
      </section>
      </div>
    </div>,
    document.body,
  )
}

function applyExportImageTransform(
  current: Record<number, ExportImageTransform>,
  selectedIndex: number,
  imageCount: number,
  transform: ExportImageTransform,
  synchronized: boolean,
) {
  if (!synchronized) return { ...current, [selectedIndex]: { ...transform } }
  const next = { ...current }
  for (let imageIndex = 0; imageIndex < Math.max(0, Math.floor(imageCount)); imageIndex += 1) {
    next[imageIndex] = { ...transform }
  }
  return next
}

function getCompositionCaptureLongEdge(
  format: ExportFormat,
  orientation: 'portrait' | 'landscape',
  columns: number,
  rows: number,
  requestedLongEdge: number,
) {
  if (format !== 'pdf' && format !== 'dicom-print') return requestedLongEdge

  const pageWidth = (orientation === 'portrait' ? 210 : 297) * 10
  const pageHeight = (orientation === 'portrait' ? 297 : 210) * 10
  const safeColumns = Math.max(1, Math.min(10, Math.floor(columns)))
  const safeRows = Math.max(1, Math.min(10, Math.floor(rows)))
  const cellWidth = pageWidth / safeColumns
  const cellHeight = pageHeight / safeRows
  const requiredLongEdge = Math.round(Math.sqrt(cellWidth * cellHeight) * 1.45)

  // A dense film grid does not benefit from rendering every source frame at
  // the same resolution as a 1x1 page. Keep enough detail for the actual cell
  // while avoiding hundreds of oversized canvases for CT/MR series exports.
  return Math.min(requestedLongEdge, Math.max(1024, requiredLongEdge))
}

function getExportPageDimensions(
  format: 'pdf' | 'dicom-print',
  orientation: 'portrait' | 'landscape',
  filmSizeId: string,
) {
  if (format === 'pdf') {
    return orientation === 'portrait'
      ? { width: 210, height: 297 }
      : { width: 297, height: 210 }
  }
  const match = String(filmSizeId).match(/(\d+(?:\.\d+)?)INX(\d+(?:\.\d+)?)IN/i)
  const shortSide = Number(match?.[1] || 14) * 25.4
  const longSide = Number(match?.[2] || 17) * 25.4
  return orientation === 'portrait'
    ? { width: shortSide, height: longSide }
    : { width: longSide, height: shortSide }
}

function getExportCellGeometry(
  grid: NonNullable<ExportPreview['grid']>,
  imageIndex: number,
  format: 'pdf' | 'dicom-print',
  orientation: 'portrait' | 'landscape',
  filmSizeId: string,
  footerPercent: number,
) {
  const localIndex = imageIndex - grid.itemOffset
  if (localIndex < 0 || localIndex >= grid.itemCount) return null
  const page = getExportPageDimensions(format, orientation, filmSizeId)
  const margin = format === 'pdf' ? 8 : 0
  const gutter = format === 'pdf' ? 1 : grid.itemCount > 1 ? page.width * 0.004 : 0
  const usableWidth = page.width - margin * 2
  const usableHeight = format === 'pdf'
    ? page.height - margin * 2
    : page.height * Math.max(0.2, 1 - footerPercent / 100)
  const cellWidth = (usableWidth - gutter * Math.max(0, grid.columns - 1)) / grid.columns
  const cellHeight = (usableHeight - gutter * Math.max(0, grid.rows - 1)) / grid.rows
  const column = localIndex % grid.columns
  const row = Math.floor(localIndex / grid.columns)
  return {
    page,
    x: margin + column * (cellWidth + gutter),
    y: margin + row * (cellHeight + gutter),
    width: cellWidth,
    height: cellHeight,
  }
}

function getExportImageIndexAtPointer(
  event: React.PointerEvent<HTMLImageElement>,
  preview: ExportPreview,
  format: 'pdf' | 'dicom-print',
  orientation: 'portrait' | 'landscape',
  filmSizeId: string,
  footerPercent: number,
) {
  const grid = preview.grid
  if (!grid) return null
  const rect = event.currentTarget.getBoundingClientRect()
  const page = getExportPageDimensions(format, orientation, filmSizeId)
  const pageX = (event.clientX - rect.left) / Math.max(1, rect.width) * page.width
  const pageY = (event.clientY - rect.top) / Math.max(1, rect.height) * page.height
  for (let localIndex = 0; localIndex < grid.itemCount; localIndex += 1) {
    const geometry = getExportCellGeometry(grid, grid.itemOffset + localIndex, format, orientation, filmSizeId, footerPercent)
    if (!geometry) continue
    if (pageX >= geometry.x && pageX <= geometry.x + geometry.width && pageY >= geometry.y && pageY <= geometry.y + geometry.height) {
      return grid.itemOffset + localIndex
    }
  }
  return null
}

function getExportSelectedCellStyle(
  grid: NonNullable<ExportPreview['grid']>,
  imageIndex: number,
  format: 'pdf' | 'dicom-print',
  orientation: 'portrait' | 'landscape',
  filmSizeId: string,
  footerPercent: number,
) {
  const geometry = getExportCellGeometry(grid, imageIndex, format, orientation, filmSizeId, footerPercent)
  if (!geometry) return null
  return {
    left: `${geometry.x / geometry.page.width * 100}%`,
    top: `${geometry.y / geometry.page.height * 100}%`,
    width: `${geometry.width / geometry.page.width * 100}%`,
    height: `${geometry.height / geometry.page.height * 100}%`,
  }
}

function filmPreviewAspectRatio(filmSizeId: string, orientation: 'portrait' | 'landscape') {
  const match = String(filmSizeId).match(/(\d+(?:\.\d+)?)INX(\d+(?:\.\d+)?)IN/i)
  const shortSide = Number(match?.[1] || 14)
  const longSide = Number(match?.[2] || 17)
  return orientation === 'portrait' ? shortSide / longSide : longSide / shortSide
}

function fitPreviewFrame(width: number, height: number, aspectRatio: number) {
  if (width <= 0 || height <= 0) return { aspectRatio }
  const fittedWidth = Math.min(width, height * aspectRatio)
  const fittedHeight = fittedWidth / aspectRatio
  return {
    aspectRatio,
    width: `${Math.floor(fittedWidth)}px`,
    height: `${Math.floor(fittedHeight)}px`,
  }
}

function decodePreviewImage(source: string) {
  return new Promise<void>((resolve) => {
    const image = new Image()
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      resolve()
    }
    image.onload = finish
    image.onerror = finish
    image.src = source
    if (typeof image.decode === 'function') {
      void image.decode().then(finish).catch(() => undefined)
    }
  })
}
