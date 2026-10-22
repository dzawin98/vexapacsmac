import { appUrl } from '../../config/appBase'

// jspdf (~36 MB of source, and the single largest contributor to the initial
// bundle) and jszip are only ever needed when the operator actually runs an
// export. Importing them statically put both in the first chunk every viewer
// download had to fetch before it could paint anything. They are loaded on
// demand instead; the surrounding functions are already async.
let jsPdfModulePromise: Promise<typeof import('jspdf')> | null = null

// jszip's typings use `export = JSZip` with the class merged into the
// namespace, so the default export shape differs between interop settings.
// Type the loader loosely and narrow at the single call site.
let jsZipModulePromise: Promise<{ default: new () => import('jszip') }> | null = null

function loadJsPdf() {
  jsPdfModulePromise ??= import('jspdf')
  return jsPdfModulePromise
}

function loadJsZip() {
  jsZipModulePromise ??= import('jszip') as unknown as Promise<{ default: new () => import('jszip') }>
  return jsZipModulePromise
}

export type ExportFormat = 'png' | 'jpeg' | 'pdf' | 'mp4' | 'avi' | 'mpeg' | 'dicom' | 'dicom-print'
export type ExportScope = 'current' | 'selected' | 'series' | 'viewports' | 'custom'
export type ExportIntent = 'export' | 'preview' | 'print' | 'copy'

export type ExportRenderOptions = {
  includeTextOverlay: boolean
  includeAnnotations: boolean
  includeMasks: boolean
  anonymize: boolean
  trueSize: boolean
  targetLongEdge: number
}

export type ExportImageTransform = {
  scalePercent: number
  offsetXPercent: number
  offsetYPercent: number
}

export type ViewerExportRequest = {
  format: ExportFormat
  scope: ExportScope
  intent: ExportIntent
  targetIds: string[]
  selectedPages: string
  targetPageSelections?: Record<string, string>
  fileName: string
  seriesName: string
  quality: number
  fps: number
  tileLayout: string
  orientation: 'portrait' | 'landscape'
  sendToReport: boolean
  livePreview?: boolean
  previewItemLimit?: number
  previewItemOffset?: number
  previewTotalItems?: number
  previewPageCount?: number
  previewPageIndex?: number
  selectedItemCount?: number
  pdfImages?: Record<number, ExportImageTransform>
  dicomPrint?: {
    printerId: string
    filmSizeId: string
    layout: string
    imageScalePercent?: number
    imageTransforms?: Record<number, ExportImageTransform>
    filmCapacity?: number
    identity?: DicomFilmIdentity
    includeFooter?: boolean
  }
  render: ExportRenderOptions
}

export type ExportPreview = {
  url: string
  type: 'image' | 'video'
  caption?: string
  pageIndex?: number
  pageCount?: number
  grid?: {
    columns: number
    rows: number
    itemOffset: number
    itemCount: number
  }
}

export type ViewerExportResult = {
  message: string
  preview?: ExportPreview
  previewVariants?: {
    filmFooterOn?: ExportPreview
    filmFooterOff?: ExportPreview
  }
}

export type CanvasExportItem = {
  canvas: HTMLCanvasElement
  label: string
  textOverlay?: PdfTextOverlay
}

export type PdfTextOverlay = {
  topLeft: string[]
  topRight: string[]
  bottomLeft: string[]
  bottomRight: string[]
}

export function parseExportPageSelection(value: string, total: number) {
  const safeTotal = Math.max(0, Math.floor(total))
  if (!value.trim()) return []

  const selected = new Set<number>()
  value.split(',').forEach((token) => {
    const normalized = token.trim()
    if (!normalized) return
    const range = normalized.match(/^(\d+)\s*-\s*(\d+)$/)
    if (range) {
      const requestedStart = Number(range[1])
      const requestedEnd = Number(range[2])
      const start = Math.max(1, Math.min(requestedStart, requestedEnd))
      const end = Math.min(safeTotal, Math.max(requestedStart, requestedEnd))
      for (let page = start; page <= end; page += 1) {
        selected.add(page - 1)
      }
      return
    }

    const page = Number(normalized)
    if (Number.isInteger(page) && page >= 1 && page <= safeTotal) {
      selected.add(page - 1)
    }
  })

  return Array.from(selected).sort((left, right) => left - right)
}

const automaticPdfItemsPerPage = 12
const defaultImageTransform: ExportImageTransform = { scalePercent: 100, offsetXPercent: 0, offsetYPercent: 0 }

export function getPdfPreviewPlan(total: number, tileLayout: string, requestedPageIndex = 0) {
  const safeTotal = Math.max(0, Math.floor(total))
  if (safeTotal === 0) return { itemOffset: 0, itemLimit: 0, pageIndex: 0, pageCount: 0 }
  if (tileLayout !== 'auto') {
    const layout = parseTileLayout(tileLayout)
    const itemLimit = layout.columns * layout.rows
    const pageCount = Math.ceil(safeTotal / itemLimit)
    const pageIndex = Math.min(pageCount - 1, Math.max(0, Math.floor(requestedPageIndex)))
    const itemOffset = pageIndex * itemLimit
    return { itemOffset, itemLimit: Math.min(safeTotal - itemOffset, itemLimit), pageIndex, pageCount }
  }

  const pageCount = Math.ceil(safeTotal / automaticPdfItemsPerPage)
  const minimumItemsPerPage = Math.floor(safeTotal / pageCount)
  const pagesWithExtraItem = safeTotal % pageCount
  const pageIndex = Math.min(pageCount - 1, Math.max(0, Math.floor(requestedPageIndex)))
  const itemOffset = pageIndex * minimumItemsPerPage + Math.min(pageIndex, pagesWithExtraItem)
  return {
    itemOffset,
    itemLimit: minimumItemsPerPage + (pageIndex < pagesWithExtraItem ? 1 : 0),
    pageIndex,
    pageCount,
  }
}

export function sanitizeExportFileName(value: string, fallback = 'vexa-export') {
  const normalized = value
    .trim()
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, ' ')
    .slice(0, 180)
  return normalized || fallback
}

export async function canvasToBlob(canvas: HTMLCanvasElement, mimeType: 'image/png' | 'image/jpeg', quality = 0.92) {
  // canvas.toBlob bisa TIDAK PERNAH memanggil callback-nya (context WebGL hilang, canvas
  // tainted, encoder sibuk). Tanpa batas waktu, pemanggil menunggu selamanya dan operator
  // hanya melihat status loading sampai timeout. Beri batas supaya kegagalan tampil sebagai
  // pesan yang bisa ditindaklanjuti, bukan spinner tanpa akhir.
  const blob = await new Promise<Blob | null>((resolve, reject) => {
    let settled = false
    const timer = window.setTimeout(() => {
      if (settled) return
      settled = true
      reject(new Error('Unable to encode the viewport image (timed out after 15 s).'))
    }, 15000)
    try {
      canvas.toBlob((result) => {
        if (settled) return
        settled = true
        window.clearTimeout(timer)
        resolve(result)
      }, mimeType, quality)
    } catch (error) {
      settled = true
      window.clearTimeout(timer)
      reject(error instanceof Error ? error : new Error('Unable to encode the viewport image.'))
    }
  })
  if (!blob) throw new Error('Unable to encode the viewport image.')
  return blob
}

export function createA4JpegCanvas(
  source: HTMLCanvasElement,
  overlay: PdfTextOverlay | undefined,
  requestedLongEdge: number,
  orientation?: 'portrait' | 'landscape',
) {
  const longEdge = Math.min(4096, Math.max(2048, Math.round(Number(requestedLongEdge) || 3072)))
  const isPortrait = orientation ? orientation === 'portrait' : source.height >= source.width
  const a4Ratio = 210 / 297
  const output = document.createElement('canvas')
  output.width = isPortrait ? Math.round(longEdge * a4Ratio) : longEdge
  output.height = isPortrait ? longEdge : Math.round(longEdge * a4Ratio)
  const context = output.getContext('2d')
  if (!context) throw new Error('Unable to initialize the A4 JPEG canvas.')

  const fontSize = Math.max(16, Math.round(longEdge * 0.0085))
  const lineHeight = Math.round(fontSize * 1.16)
  const horizontalPadding = Math.max(18, Math.round(output.width * 0.014))
  const verticalPadding = Math.max(14, Math.round(output.height * 0.008))
  const topLineCount = Math.max(overlay?.topLeft.length ?? 0, overlay?.topRight.length ?? 0)
  const bottomLineCount = Math.max(overlay?.bottomLeft.length ?? 0, overlay?.bottomRight.length ?? 0)
  const minimumBandHeight = Math.round(output.height * 0.065)
  const topBandHeight = topLineCount > 0
    ? Math.max(minimumBandHeight, topLineCount * lineHeight + verticalPadding * 2)
    : 0
  const bottomBandHeight = bottomLineCount > 0
    ? Math.max(minimumBandHeight, bottomLineCount * lineHeight + verticalPadding * 2)
    : 0
  const contentHeight = Math.max(1, output.height - topBandHeight - bottomBandHeight)
  const sourceAspect = source.width / Math.max(1, source.height)
  const contentAspect = output.width / contentHeight
  const drawWidth = sourceAspect > contentAspect ? output.width : contentHeight * sourceAspect
  const drawHeight = sourceAspect > contentAspect ? output.width / sourceAspect : contentHeight
  const drawX = (output.width - drawWidth) / 2
  const drawY = topBandHeight + (contentHeight - drawHeight) / 2

  context.fillStyle = '#000'
  context.fillRect(0, 0, output.width, output.height)
  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = 'high'
  context.drawImage(source, drawX, drawY, drawWidth, drawHeight)

  if (overlay) {
    drawCanvasOverlayBlock(context, overlay.topLeft, 'left', topBandHeight, 0, fontSize, lineHeight, horizontalPadding, verticalPadding)
    drawCanvasOverlayBlock(context, overlay.topRight, 'right', topBandHeight, 0, fontSize, lineHeight, horizontalPadding, verticalPadding)
    drawCanvasOverlayBlock(context, overlay.bottomLeft, 'left', bottomBandHeight, output.height - bottomBandHeight, fontSize, lineHeight, horizontalPadding, verticalPadding)
    drawCanvasOverlayBlock(context, overlay.bottomRight, 'right', bottomBandHeight, output.height - bottomBandHeight, fontSize, lineHeight, horizontalPadding, verticalPadding)
  }

  return output
}

function drawCanvasOverlayBlock(
  context: CanvasRenderingContext2D,
  lines: string[],
  side: 'left' | 'right',
  bandHeight: number,
  bandTop: number,
  baseFontSize: number,
  baseLineHeight: number,
  horizontalPadding: number,
  verticalPadding: number,
) {
  if (!lines.length) return
  const maximumWidth = context.canvas.width * 0.47 - horizontalPadding
  let fontSize = baseFontSize
  context.font = `400 ${fontSize}px Arial, sans-serif`
  const widestLine = Math.max(...lines.map((line) => context.measureText(line).width))
  if (widestLine > maximumWidth) {
    fontSize = Math.max(11, Math.floor(fontSize * maximumWidth / widestLine))
  }
  const lineHeight = Math.max(Math.round(fontSize * 1.16), Math.round(baseLineHeight * fontSize / baseFontSize))
  const blockHeight = lines.length * lineHeight
  const startY = bandTop + Math.max(verticalPadding, (bandHeight - blockHeight) / 2)
  const x = side === 'left' ? horizontalPadding : context.canvas.width - horizontalPadding

  context.save()
  context.fillStyle = '#f1f5f4'
  context.strokeStyle = 'rgba(0, 0, 0, 0.95)'
  context.lineWidth = Math.max(2, fontSize * 0.12)
  context.lineJoin = 'round'
  context.font = `400 ${fontSize}px Arial, sans-serif`
  context.textAlign = side
  context.textBaseline = 'top'
  lines.forEach((line, index) => {
    const y = startY + index * lineHeight
    context.strokeText(line, x, y)
    context.fillText(line, x, y)
  })
  context.restore()
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.style.display = 'none'
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000)
}

export async function exportStillImages(
  items: CanvasExportItem[],
  format: 'png' | 'jpeg',
  fileName: string,
  quality: number,
) {
  if (!items.length) throw new Error('No images are available for export.')
  const extension = format === 'png' ? 'png' : 'jpg'
  const mimeType = format === 'png' ? 'image/png' : 'image/jpeg'
  const safeName = sanitizeExportFileName(fileName)

  if (items.length === 1) {
    downloadBlob(await canvasToBlob(items[0].canvas, mimeType, quality), `${safeName}.${extension}`)
    return { count: 1, archive: false }
  }

  const { default: JSZip } = await loadJsZip()
  const zip = new JSZip()
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]
    const suffix = String(index + 1).padStart(3, '0')
    const label = sanitizeExportFileName(item.label, `image-${suffix}`)
    zip.file(`${safeName}-${suffix}-${label}.${extension}`, await canvasToBlob(item.canvas, mimeType, quality))
  }
  downloadBlob(await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } }), `${safeName}.zip`)
  return { count: items.length, archive: true }
}

export async function copyCanvasToClipboard(canvas: HTMLCanvasElement) {
  if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') {
    throw new Error('This browser does not support copying images to the clipboard.')
  }
  const blob = await canvasToBlob(canvas, 'image/png')
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
}

export async function copyTextToClipboard(value: string) {
  if (!navigator.clipboard?.writeText) {
    throw new Error('This browser does not support copying text to the clipboard.')
  }
  await navigator.clipboard.writeText(value)
}

export async function createPdfBlob(
  items: CanvasExportItem[],
  options: {
    orientation: 'portrait' | 'landscape'
    tileLayout: string
    quality: number
    imageScalePercent?: number
    imageOffsetXPercent?: number
    imageOffsetYPercent?: number
    imageTransforms?: Record<number, ExportImageTransform>
  },
) {
  if (!items.length) throw new Error('No images are available for the PDF.')
  const { jsPDF } = await loadJsPdf()
  const pdf = new jsPDF({
    orientation: options.orientation,
    unit: 'mm',
    format: 'a4',
    compress: true,
  })
  const pageSize = pdf.internal.pageSize
  const pageWidth = pageSize.getWidth()
  const pageHeight = pageSize.getHeight()
  const margin = 8
  const gutter = 1
  const usableWidth = pageWidth - margin * 2
  const usableHeight = pageHeight - margin * 2
  const pages = options.tileLayout === 'auto'
    ? createAutoPdfPages(items, usableWidth, usableHeight, gutter)
    : createFixedPdfPages(items, parseTileLayout(options.tileLayout))

  pages.forEach((page, pageIndex) => {
    if (pageIndex > 0) pdf.addPage()
    const pageCanvas = renderStandardPdfPageCanvas(page.items, page.layout, {
      pageWidth,
      pageHeight,
      margin,
      gutter,
      renderScale: 10,
      imageTransforms: options.imageTransforms,
      itemIndexOffset: page.startIndex,
    })
    pdf.addImage(pageCanvas.toDataURL('image/jpeg', options.quality), 'JPEG', 0, 0, pageWidth, pageHeight, undefined, 'FAST')
  })

  return pdf.output('blob')
}

export async function createPdfPreviewBlob(
  items: CanvasExportItem[],
  options: {
    orientation: 'portrait' | 'landscape'
    tileLayout: string
    identity?: DicomFilmIdentity
    filmSizeId?: string
    imageScalePercent?: number
    imageOffsetXPercent?: number
    imageOffsetYPercent?: number
    imageTransforms?: Record<number, ExportImageTransform>
    itemIndexOffset?: number
    includeTextOverlay?: boolean
  },
) {
  if (!items.length) throw new Error('No images are available for preview.')
  const filmMatch = String(options.filmSizeId || '').match(/(\d+(?:\.\d+)?)INX(\d+(?:\.\d+)?)IN/i)
  const filmShort = filmMatch ? Number(filmMatch[1]) * 25.4 : 210
  const filmLong = filmMatch ? Number(filmMatch[2]) * 25.4 : 297
  const pageWidth = options.orientation === 'portrait' ? filmShort : filmLong
  const pageHeight = options.orientation === 'portrait' ? filmLong : filmShort
  const margin = options.filmSizeId ? 0 : 8
  const gutter = 1
  const usableWidth = pageWidth - margin * 2
  const footerPercent = options.identity ? Math.max(8, Math.min(30, Number(options.identity.footerHeight || 18))) : 0
  const usableHeight = pageHeight * (1 - footerPercent / 100) - margin * 2
  const pages = options.tileLayout === 'auto'
    ? createAutoPdfPages(items, usableWidth, usableHeight, gutter)
    : createFixedPdfPages(items, parseTileLayout(options.tileLayout))
  const page = pages[0]
  const renderScale = 4
  if (!options.identity) {
    const canvas = renderStandardPdfPageCanvas(page.items, page.layout, {
      pageWidth,
      pageHeight,
      margin,
      gutter,
      renderScale,
      imageTransforms: options.imageTransforms,
      itemIndexOffset: options.itemIndexOffset || 0,
    })
    return {
      blob: await canvasToBlob(canvas, 'image/jpeg', 0.88),
      layout: page.layout,
    }
  }
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(pageWidth * renderScale)
  canvas.height = Math.round(pageHeight * renderScale)
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Unable to render the PDF preview.')

  context.fillStyle = '#000'
  context.fillRect(0, 0, canvas.width, canvas.height)
  if (options.identity) {
    const imageAreaHeight = canvas.height * Math.max(0.2, 1 - footerPercent / 100)
    const gutterPixels = page.items.length > 1 ? Math.max(2, Math.round(canvas.width * 0.004)) : 0
    const cellWidth = (canvas.width - gutterPixels * Math.max(0, page.layout.columns - 1)) / page.layout.columns
    const cellHeight = (imageAreaHeight - gutterPixels * Math.max(0, page.layout.rows - 1)) / page.layout.rows
    page.items.forEach((item, index) => {
      const imageTransform = normalizeImageTransform(options.imageTransforms?.[(options.itemIndexOffset || 0) + index] || options)
      const row = Math.floor(index / page.layout.columns)
      const column = index % page.layout.columns
      const cellX = column * (cellWidth + gutterPixels)
      const cellY = row * (cellHeight + gutterPixels)
      const aspect = item.canvas.width / Math.max(1, item.canvas.height)
      const fitWidth = Math.min(cellWidth, cellHeight * aspect)
      const fitHeight = fitWidth / aspect
      const width = fitWidth * imageTransform.scale
      const height = fitHeight * imageTransform.scale
      const drawX = cellX + (cellWidth - width) / 2 + cellWidth * imageTransform.offsetX
      const drawY = cellY + (cellHeight - height) / 2 + cellHeight * imageTransform.offsetY
      context.fillStyle = '#000'
      context.fillRect(cellX, cellY, cellWidth, cellHeight)
      context.save()
      context.beginPath()
      context.rect(cellX, cellY, cellWidth, cellHeight)
      context.clip()
      context.drawImage(item.canvas, drawX, drawY, width, height)
      context.restore()
      if (options.includeTextOverlay !== false) {
        drawCanvasTextOverlayInCell(context, item.textOverlay, cellX, cellY, cellWidth, cellHeight)
      }
    })
    drawFilmGridLines(context, 0, 0, canvas.width, imageAreaHeight, page.layout, gutterPixels)
  }

  if (options.identity) await drawFilmIdentity(context, canvas, page.items[0]?.textOverlay, options.identity)

  return {
    blob: await canvasToBlob(canvas, 'image/jpeg', 0.88),
    layout: page.layout,
  }
}

function renderStandardPdfPageCanvas(
  items: CanvasExportItem[],
  layout: PdfGridLayout,
  options: {
    pageWidth: number
    pageHeight: number
    margin: number
    gutter: number
    renderScale: number
    imageTransforms?: Record<number, ExportImageTransform>
    itemIndexOffset: number
  },
) {
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(options.pageWidth * options.renderScale)
  canvas.height = Math.round(options.pageHeight * options.renderScale)
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Unable to render the PDF page.')
  const usableWidth = options.pageWidth - options.margin * 2
  const usableHeight = options.pageHeight - options.margin * 2
  const metrics = calculatePdfPageMetrics(layout, usableWidth, usableHeight, options.gutter)
  context.fillStyle = '#000'
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = 'high'

  items.forEach((item, index) => {
    const imageTransform = normalizeImageTransform(options.imageTransforms?.[options.itemIndexOffset + index] || defaultImageTransform)
    const row = Math.floor(index / layout.columns)
    const column = index % layout.columns
    const cellX = (options.margin + column * (metrics.cellWidth + options.gutter)) * options.renderScale
    const cellY = (options.margin + row * (metrics.cellHeight + options.gutter)) * options.renderScale
    const cellWidth = metrics.cellWidth * options.renderScale
    const cellHeight = metrics.cellHeight * options.renderScale
    const aspect = item.canvas.width / Math.max(1, item.canvas.height)
    const fitWidth = Math.min(cellWidth, cellHeight * aspect)
    const fitHeight = fitWidth / aspect
    const width = fitWidth * imageTransform.scale
    const height = fitHeight * imageTransform.scale
    const drawX = cellX + (cellWidth - width) / 2 + cellWidth * imageTransform.offsetX
    const drawY = cellY + (cellHeight - height) / 2 + cellHeight * imageTransform.offsetY
    context.fillStyle = '#000'
    context.fillRect(cellX, cellY, cellWidth, cellHeight)
    context.save()
    context.beginPath()
    context.rect(cellX, cellY, cellWidth, cellHeight)
    context.clip()
    context.drawImage(item.canvas, drawX, drawY, width, height)
    context.restore()
    drawCanvasTextOverlayInCell(context, item.textOverlay, cellX, cellY, cellWidth, cellHeight)
  })

  drawFilmGridLines(
    context,
    options.margin * options.renderScale,
    options.margin * options.renderScale,
    usableWidth * options.renderScale,
    usableHeight * options.renderScale,
    layout,
    options.gutter * options.renderScale,
  )
  return canvas
}

function drawCanvasTextOverlayInCell(
  context: CanvasRenderingContext2D,
  overlay: PdfTextOverlay | undefined,
  cellX: number,
  cellY: number,
  cellWidth: number,
  cellHeight: number,
) {
  if (!overlay) return

  const padding = Math.max(5, Math.round(cellWidth * 0.018))
  const maximumBlockWidth = cellWidth * 0.47
  const baseFontSize = Math.max(10, Math.min(28, cellWidth * 0.036))

  const drawBlock = (lines: string[], side: 'left' | 'right', vertical: 'top' | 'bottom') => {
    if (!lines.length) return
    let fontSize = baseFontSize
    context.font = `400 ${fontSize}px Arial, sans-serif`
    const widestLine = Math.max(...lines.map((line) => context.measureText(line).width))
    if (widestLine > maximumBlockWidth) {
      fontSize = Math.max(8, fontSize * maximumBlockWidth / widestLine)
    }
    const lineHeight = Math.max(10, fontSize * 1.12)
    const x = side === 'left' ? cellX + padding : cellX + cellWidth - padding
    const firstY = vertical === 'top'
      ? cellY + padding
      : cellY + cellHeight - padding - lineHeight * lines.length

    context.save()
    context.font = `400 ${fontSize}px Arial, sans-serif`
    context.textAlign = side
    context.textBaseline = 'top'
    context.fillStyle = '#a6d8cc'
    context.strokeStyle = 'rgba(0, 0, 0, 0.9)'
    context.lineWidth = Math.max(1.5, fontSize * 0.1)
    context.lineJoin = 'round'
    lines.forEach((line, index) => {
      const y = firstY + index * lineHeight
      context.strokeText(line, x, y)
      context.fillText(line, x, y)
    })
    context.restore()
  }

  drawBlock(overlay.topLeft, 'left', 'top')
  drawBlock(overlay.topRight, 'right', 'top')
  drawBlock(overlay.bottomLeft, 'left', 'bottom')
  drawBlock(overlay.bottomRight, 'right', 'bottom')
}

function drawFilmGridLines(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  layout: { columns: number; rows: number },
  gutter: number,
) {
  if (layout.columns <= 1 && layout.rows <= 1) return
  const cellWidth = (width - gutter * Math.max(0, layout.columns - 1)) / layout.columns
  const cellHeight = (height - gutter * Math.max(0, layout.rows - 1)) / layout.rows
  context.save()
  context.beginPath()
  for (let column = 1; column < layout.columns; column += 1) {
    const dividerX = x + column * cellWidth + (column - 0.5) * gutter
    context.moveTo(dividerX, y)
    context.lineTo(dividerX, y + height)
  }
  for (let row = 1; row < layout.rows; row += 1) {
    const dividerY = y + row * cellHeight + (row - 0.5) * gutter
    context.moveTo(x, dividerY)
    context.lineTo(x + width, dividerY)
  }
  context.strokeStyle = 'rgba(210, 222, 218, 0.72)'
  context.lineWidth = Math.max(1, Math.min(width, height) * 0.0012)
  context.stroke()
  context.restore()
}

async function drawFilmIdentity(context: CanvasRenderingContext2D, canvas: HTMLCanvasElement, overlay: PdfTextOverlay | undefined, identity: DicomFilmIdentity) {
  const lines = [...(overlay?.topLeft || []), ...(overlay?.topRight || []), ...(overlay?.bottomLeft || []), ...(overlay?.bottomRight || [])]
  const find = (pattern: RegExp, fallback: string) => lines.find((line) => pattern.test(line)) || fallback
  const values: Record<string, string> = { facilityName: identity.facilityName || '', patientName: overlay?.topLeft?.[0] || 'Patient Name', patientId: find(/(?:ID|MRN|RM)\s*[:#]/i, overlay?.topLeft?.[1] || 'Medical Record No.'), birthDate: find(/(?:DOB|Birth|Age)\s*[:#]/i, 'Birth Date / Age'), sex: find(/(?:Sex|Gender)\s*[:#]/i, 'Sex'), studyDate: find(/(?:Study|Acq).*Date\s*[:#]/i, 'Study Date'), accessionNumber: find(/(?:Accession|ACC)\s*[:#]/i, 'Accession No.') }
  context.save()
  const footerHeight = Math.max(8, Math.min(30, Number(identity.footerHeight || 18)))
  context.fillStyle = '#000'
  context.fillRect(0, canvas.height * (1 - footerHeight / 100), canvas.width, canvas.height * footerHeight / 100)
  context.fillStyle = '#fff'
  const referenceWidth = Math.max(320, Number(identity.referenceWidth || 420))
  context.textBaseline = 'middle'
  for (const [key, item] of Object.entries(identity.elements || {})) {
    if (item.enabled === false) continue
    const x = canvas.width * (Number(item.x ?? 5) / 100)
    const y = canvas.height * (Number(item.y ?? 5) / 100)
    context.textAlign = item.align || 'left'
    const fontSize = canvas.width * ((key === 'facilityName' ? 12 : 10) / referenceWidth)
    context.font = `${key === 'facilityName' ? 700 : 500} ${Math.max(12, Math.round(fontSize))}px Arial, sans-serif`
    if (key === 'logo' && identity.logoDataUrl) {
      try { const image = await loadFilmLogo(identity.logoDataUrl); const size = Math.max(24, canvas.width * (Number(identity.logoSize || 38) / referenceWidth)); const offset = item.align === 'center' ? size / 2 : item.align === 'right' ? size : 0; context.drawImage(image, x - offset, y - size / 2, size, size) } catch { /* Invalid logo must not block printing. */ }
    } else if (values[key]) context.fillText(values[key], x, y)
  }
  context.restore()
}

function loadFilmLogo(source: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => { const image = new Image(); image.onload = () => resolve(image); image.onerror = reject; image.src = source })
}

type PdfGridLayout = {
  columns: number
  rows: number
}

type PdfPage = {
  items: CanvasExportItem[]
  layout: PdfGridLayout
  startIndex: number
}

type PdfPageMetrics = {
  cellWidth: number
  cellHeight: number
}

function createFixedPdfPages(items: CanvasExportItem[], layout: PdfGridLayout) {
  const slotsPerPage = layout.columns * layout.rows
  const pages: PdfPage[] = []
  for (let start = 0; start < items.length; start += slotsPerPage) {
    pages.push({ items: items.slice(start, start + slotsPerPage), layout, startIndex: start })
  }
  return pages
}

function createAutoPdfPages(items: CanvasExportItem[], usableWidth: number, usableHeight: number, gutter: number) {
  const pages: PdfPage[] = []
  const maximumItemsPerPage = automaticPdfItemsPerPage
  const pageCount = Math.ceil(items.length / maximumItemsPerPage)
  const minimumItemsPerPage = Math.floor(items.length / pageCount)
  const pagesWithExtraItem = items.length % pageCount
  let start = 0

  for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
    const itemCount = minimumItemsPerPage + (pageIndex < pagesWithExtraItem ? 1 : 0)
    const pageItems = items.slice(start, start + itemCount)
    const layout = selectAutoPdfGrid(pageItems, usableWidth, usableHeight, gutter)
    pages.push({ items: pageItems, layout, startIndex: start })
    start += itemCount
  }
  return pages
}

function selectAutoPdfGrid(items: CanvasExportItem[], usableWidth: number, usableHeight: number, gutter: number): PdfGridLayout {
  let bestLayout: PdfGridLayout = { columns: 1, rows: Math.max(1, items.length) }
  let bestScore = Number.NEGATIVE_INFINITY

  for (let columns = 1; columns <= 6; columns += 1) {
    for (let rows = 1; rows <= 8; rows += 1) {
      const layout = { columns, rows }
      if (layout.columns * layout.rows < items.length) continue
      const metrics = calculatePdfPageMetrics(layout, usableWidth, usableHeight, gutter)
      const imageArea = getPdfImageArea(items, metrics)
      const pageArea = usableWidth * usableHeight
      const unusedSlots = layout.columns * layout.rows - items.length
      const score = imageArea / pageArea - unusedSlots * 0.002
      if (score > bestScore) {
        bestLayout = layout
        bestScore = score
      }
    }
  }

  return bestLayout
}

function normalizeImageTransform(options: Partial<ExportImageTransform> & {
  imageScalePercent?: number
  imageOffsetXPercent?: number
  imageOffsetYPercent?: number
}) {
  return {
    scale: Math.max(0.5, Math.min(2.5, Number(options.scalePercent ?? options.imageScalePercent ?? 100) / 100)),
    offsetX: Math.max(-1, Math.min(1, Number(options.offsetXPercent ?? options.imageOffsetXPercent ?? 0) / 100)),
    offsetY: Math.max(-1, Math.min(1, Number(options.offsetYPercent ?? options.imageOffsetYPercent ?? 0) / 100)),
  }
}

function calculatePdfPageMetrics(layout: PdfGridLayout, usableWidth: number, usableHeight: number, gutter: number): PdfPageMetrics {
  const cellWidth = (usableWidth - gutter * (layout.columns - 1)) / layout.columns
  const cellHeight = (usableHeight - gutter * (layout.rows - 1)) / layout.rows
  return {
    cellWidth,
    cellHeight,
  }
}

function getPdfImageArea(items: CanvasExportItem[], metrics: PdfPageMetrics) {
  return items.reduce((total, item) => {
    const aspect = item.canvas.width / Math.max(1, item.canvas.height)
    const width = Math.min(metrics.cellWidth, metrics.cellHeight * aspect)
    return total + width * (width / aspect)
  }, 0)
}

export async function renderCanvasSequenceToVideo(items: CanvasExportItem[], fps: number) {
  if (!items.length) throw new Error('No frames are available for cine export.')
  if (typeof MediaRecorder === 'undefined') throw new Error('This browser does not support cine export.')

  const width = Math.max(...items.map((item) => item.canvas.width))
  const height = Math.max(...items.map((item) => item.canvas.height))
  const output = document.createElement('canvas')
  output.width = width
  output.height = height
  const context = output.getContext('2d')
  if (!context) throw new Error('Unable to initialize the cine canvas.')
  const normalizedFps = Math.min(60, Math.max(1, Math.round(fps)))
  const stream = output.captureStream(normalizedFps)
  const mimeType = pickMediaRecorderMimeType()
  const recorder = new MediaRecorder(stream, {
    ...(mimeType ? { mimeType } : {}),
    videoBitsPerSecond: Math.min(14_000_000, Math.max(2_500_000, width * height * normalizedFps * 0.28)),
  })
  const chunks: BlobPart[] = []
  recorder.addEventListener('dataavailable', (event) => {
    if (event.data.size) chunks.push(event.data)
  })
  const stopped = new Promise<void>((resolve, reject) => {
    recorder.addEventListener('stop', () => resolve(), { once: true })
    recorder.addEventListener('error', () => reject(new Error('Cine encoding failed.')), { once: true })
  })

  recorder.start()
  const delay = Math.max(17, Math.round(1000 / normalizedFps))
  for (const item of items) {
    context.fillStyle = '#000'
    context.fillRect(0, 0, width, height)
    const scale = Math.min(width / item.canvas.width, height / item.canvas.height)
    const drawWidth = Math.round(item.canvas.width * scale)
    const drawHeight = Math.round(item.canvas.height * scale)
    context.drawImage(item.canvas, (width - drawWidth) / 2, (height - drawHeight) / 2, drawWidth, drawHeight)
    await wait(delay)
  }
  await wait(delay * 2)
  recorder.stop()
  await stopped
  stream.getTracks().forEach((track) => track.stop())
  return new Blob(chunks, { type: mimeType || 'video/webm' })
}

export async function transcodeVideo(video: Blob, format: 'mp4' | 'avi' | 'mpeg', fileName: string, fps: number) {
  const response = await fetch(appUrl(`/api/viewer/export/video?format=${encodeURIComponent(format)}&filename=${encodeURIComponent(sanitizeExportFileName(fileName))}&fps=${encodeURIComponent(String(fps))}`), {
    method: 'POST',
    headers: { 'Content-Type': video.type || 'video/webm' },
    body: video,
  })
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: string } | null
    throw new Error(payload?.error || 'Video transcoding failed.')
  }
  return response.blob()
}

export type DicomPrintSettings = {
  configured: boolean
  printers: Array<{ id: string; name: string; aet: string; host: string; port: number }>
  filmProfiles: Array<{ id: string; label: string; filmSizeId: string; orientation?: string }>
  identity: DicomFilmIdentity
}

export type DicomFilmIdentity = {
  facilityName?: string
  logoDataUrl?: string
  elements?: Record<string, { enabled?: boolean; x?: number; y?: number; align?: CanvasTextAlign }>
  templates?: Record<string, Record<string, { enabled?: boolean; x?: number; y?: number; align?: CanvasTextAlign }>>
  footerHeights?: Record<string, number>
  logoSizes?: Record<string, number>
  footerHeight?: number
  logoSize?: number
  referenceWidth?: number
}

export async function loadDicomPrintSettings() {
  const response = await fetch(appUrl('/api/viewer/dicom-print'), { headers: { Accept: 'application/json' } })
  if (!response.ok) throw new Error('Unable to load DICOM printer configuration.')
  return response.json() as Promise<DicomPrintSettings>
}

export async function sendDicomPrint(filmImage: Blob, fileName: string, options: NonNullable<ViewerExportRequest['dicomPrint']>, orientation: 'portrait' | 'landscape') {
  const query = new URLSearchParams({
    filename: sanitizeExportFileName(fileName),
    printerId: options.printerId,
    filmSizeId: options.filmSizeId,
    layout: options.layout,
    orientation,
  })
  const response = await fetch(appUrl(`/api/viewer/dicom-print?${query.toString()}`), {
    method: 'POST',
    headers: { 'Content-Type': filmImage.type || 'image/jpeg' },
    body: filmImage,
  })
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: string } | null
    throw new Error(payload?.error || 'The DICOM Print gateway request failed.')
  }
  return response.json().catch(() => ({ ok: true })) as Promise<{ ok?: boolean; jobId?: string }>
}

export function makeExportPreview(
  blob: Blob,
  type: ExportPreview['type'],
  caption?: string,
  pageIndex = 0,
  pageCount = 1,
  grid?: ExportPreview['grid'],
) {
  return { url: URL.createObjectURL(blob), type, caption, pageIndex, pageCount, grid }
}

function parseTileLayout(value: string) {
  const match = value.match(/^(\d+)x(\d+)$/i)
  const columns = Math.min(10, Math.max(1, Number(match?.[1]) || 1))
  const rows = Math.min(10, Math.max(1, Number(match?.[2]) || 1))
  return { columns, rows }
}

function pickMediaRecorderMimeType() {
  const candidates = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
  return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate)) || ''
}

function wait(milliseconds: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds))
}
