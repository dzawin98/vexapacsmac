/**
 * Tile Renderer — MPR Engine
 *
 * Renders volume slices as JPEG images using jpeg-js.
 * Falls back to BMP if jpeg-js is not available.
 *
 * @module mprEngine/tileRenderer
 */

import { Buffer } from 'node:buffer'

// Try to load jpeg-js (optional dependency)
let jpegEncoder = null
try {
  jpegEncoder = (await import('jpeg-js')).default
} catch {
  // jpeg-js not installed, will fall back to BMP
}

const JPEG_QUALITY = 70 // Matching Fujifilm benchmark (imageQuality=70)

/**
 * Render a full slice from an 8-bit pixel buffer to a JPEG (or BMP fallback) buffer.
 *
 * @param {Uint8Array} pixels  — 8-bit pixel values [0-255]
 * @param {number} width
 * @param {number} height
 * @param {number} [quality=70]  — JPEG quality (1-100)
 * @returns {Promise<Buffer>} — JPEG or BMP encoded buffer
 */
export async function renderToJpeg(pixels, width, height, quality = JPEG_QUALITY) {
  if (jpegEncoder) {
    return encodeJpeg(pixels, width, height, quality)
  }
  // Fallback to BMP if jpeg-js not available
  return encodeBmp(pixels, width, height)
}

/**
 * Render a 256x256 tile from a larger pixel buffer.
 *
 * @param {Uint8Array} fullPixels — Full slice pixels
 * @param {number} fullWidth  — Full slice width
 * @param {number} fullHeight — Full slice height
 * @param {number} tileX  — Tile column index
 * @param {number} tileY  — Tile row index
 * @param {number} [tileSize=256]
 * @returns {Uint8Array} — Tile pixel buffer
 */
export function extractTile(fullPixels, fullWidth, fullHeight, tileX, tileY, tileSize = 256) {
  const startX = tileX * tileSize
  const startY = tileY * tileSize
  const actualTileW = Math.min(tileSize, fullWidth - startX)
  const actualTileH = Math.min(tileSize, fullHeight - startY)

  if (actualTileW <= 0 || actualTileH <= 0) {
    return new Uint8Array(0)
  }

  const tilePixels = new Uint8Array(actualTileW * actualTileH)
  for (let y = 0; y < actualTileH; y++) {
    const srcOffset = (startY + y) * fullWidth + startX
    const dstOffset = y * actualTileW
    for (let x = 0; x < actualTileW; x++) {
      tilePixels[dstOffset + x] = fullPixels[srcOffset + x]
    }
  }

  return tilePixels
}

/**
 * Encode a grayscale pixel buffer as JPEG using jpeg-js.
 *
 * @param {Uint8Array} pixels  — 8-bit grayscale [0-255]
 * @param {number} width
 * @param {number} height
 * @param {number} quality  — JPEG quality (1-100)
 * @returns {Buffer} — JPEG encoded buffer
 */
function encodeJpeg(pixels, width, height, quality) {
  // jpeg-js expects RGB data (3 channels). Expand grayscale to RGB.
  const numPixels = width * height
  const rgbData = Buffer.alloc(numPixels * 3)
  for (let i = 0; i < numPixels; i++) {
    const p = pixels[i]
    const offset = i * 3
    rgbData[offset] = p       // R
    rgbData[offset + 1] = p   // G
    rgbData[offset + 2] = p   // B
  }

  const rawImage = {
    data: rgbData,
    width,
    height,
  }

  return jpegEncoder.encode(rawImage, quality).data
}

/**
 * Encode a grayscale pixel buffer as BMP.
 * BMP is used as fallback when jpeg-js is not available.
 *
 * @param {Uint8Array} pixels  — 8-bit grayscale [0-255]
 * @param {number} width
 * @param {number} height
 * @returns {Buffer} — BMP encoded buffer
 */
function encodeBmp(pixels, width, height) {
  const bytesPerPixel = 1
  const rowSize = Math.ceil((width * bytesPerPixel * 8) / 32) * 4 // BMP row padding to 4 bytes
  const paletteSize = 256 * 4 // 256 grayscale entries × 4 bytes (BGRA)
  const pixelDataOffset = 14 + 40 + paletteSize // BITMAPFILEHEADER + BITMAPINFOHEADER + palette
  const fileSize = pixelDataOffset + rowSize * height
  const buf = Buffer.alloc(fileSize)

  // -- BITMAPFILEHEADER (14 bytes) --
  buf.write('BM', 0)                                            // bfType
  buf.writeUInt32LE(fileSize, 2)                                 // bfSize
  buf.writeUInt16LE(0, 6)                                        // bfReserved1
  buf.writeUInt16LE(0, 8)                                        // bfReserved2
  buf.writeUInt32LE(pixelDataOffset, 10)                         // bfOffBits

  // -- BITMAPINFOHEADER (40 bytes) --
  buf.writeUInt32LE(40, 14)                                      // biSize
  buf.writeInt32LE(width, 18)                                    // biWidth
  buf.writeInt32LE(height, 22)                                   // biHeight (positive = bottom-up)
  buf.writeUInt16LE(1, 26)                                       // biPlanes
  buf.writeUInt16LE(8, 28)                                       // biBitCount (8-bit indexed)
  buf.writeUInt32LE(0, 30)                                       // biCompression (BI_RGB = 0)
  buf.writeUInt32LE(0, 34)                                       // biSizeImage (0 for BI_RGB)
  buf.writeInt32LE(2835, 38)                                     // biXPelsPerMeter (72 DPI)
  buf.writeInt32LE(2835, 42)                                     // biYPelsPerMeter (72 DPI)
  buf.writeUInt32LE(0, 46)                                       // biClrUsed (0 = use all)
  buf.writeUInt32LE(0, 50)                                       // biClrImportant

  // -- Color Palette (256 entries, palette index = pixel value) --
  for (let i = 0; i < 256; i++) {
    const offset = 54 + i * 4
    buf.writeUInt8(i, offset)      // blue
    buf.writeUInt8(i, offset + 1)  // green
    buf.writeUInt8(i, offset + 2)  // red
    buf.writeUInt8(0, offset + 3)  // reserved
  }

  // -- Pixel Data (bottom-up: last row first) --
  for (let y = 0; y < height; y++) {
    const srcRow = (height - 1 - y) * width  // BMP is bottom-up
    const dstOffset = pixelDataOffset + y * rowSize
    for (let x = 0; x < width; x++) {
      buf.writeUInt8(pixels[srcRow + x], dstOffset + x)
    }
  }

  return buf
}

