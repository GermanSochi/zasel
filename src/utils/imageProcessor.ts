/**
 * Предобработка изображений для OCR документов.
 *
 * Две независимые pipeline:
 *  - Full image: grayscale + optional sharpen + optional adaptive threshold (превью + визуальный OCR)
 *  - MRZ pipeline: crop FIRST → grayscale → contrast stretch → upscale x3 (для Tesseract MRZ)
 *
 * Glare логика интегрирована: strong glare → skip sharpen/threshold, reduce contrast.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export type FrameFeedback = 'too_dark' | 'glare_strong' | 'glare_mild' | 'ok'

export interface GlareAnalysis {
  level: 'none' | 'mild' | 'strong'
  /** Доля пикселей с яркостью > GLARE_THRESHOLD */
  hotspotRatio: number
  meanBrightness: number
}

export interface PreprocessedFrame {
  fullDataUrl: string
  /** Нижние 28% — raw crop БЕЗ обработки */
  mrzRawDataUrl: string
  /** Нижние 28% — оптимизировано для Tesseract (upscale x3, contrast stretch) */
  mrzProcessedDataUrl: string
  feedback: FrameFeedback
  glare: GlareAnalysis
}

// ── Constants ─────────────────────────────────────────────────────────────────

const GLARE_THRESHOLD    = 245
const GLARE_STRONG_RATIO = 0.04
const GLARE_MILD_RATIO   = 0.01
const TOO_DARK_MEAN      = 55
const MAX_DIM            = 1920
const MRZ_CROP_FRACTION  = 0.35
const MRZ_UPSCALE        = 3      // x3 — критично для точности Tesseract на мелком тексте
const ADAPTIVE_BLOCK     = 31
const ADAPTIVE_C         = 10
const SHARPEN_AMOUNT     = 0.35   // умеренный sharpen для full preview

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Быстрый анализ кадра с камеры — вызывается каждые ~200 мс для фидбека.
 * Работает на 1/4 разрешения для скорости.
 */
export function analyzeFrame(video: HTMLVideoElement): { feedback: FrameFeedback; glare: GlareAnalysis } {
  const vw = video.videoWidth, vh = video.videoHeight
  if (!vw || !vh) return okAnalysis()

  const sw = Math.max(1, Math.round(vw / 4))
  const sh = Math.max(1, Math.round(vh / 4))
  const canvas = createCanvas(sw, sh)
  canvas.getContext('2d')!.drawImage(video, 0, 0, sw, sh)
  const { data } = canvas.getContext('2d')!.getImageData(0, 0, sw, sh)

  const glare = detectGlare(data, sw, sh)
  return { feedback: glareToFeedback(glare), glare }
}

/**
 * Полная предобработка кадра с камеры.
 */
export async function preprocessFrame(video: HTMLVideoElement): Promise<PreprocessedFrame> {
  const { canvas, w, h } = captureVideo(video)
  return processCanvas(canvas, w, h)
}

/**
 * Полная предобработка из файла.
 */
export async function preprocessFile(file: File): Promise<PreprocessedFrame> {
  const img = await loadImage(file)
  let w = img.naturalWidth, h = img.naturalHeight
  if (w > MAX_DIM || h > MAX_DIM) {
    const r = Math.min(MAX_DIM / w, MAX_DIM / h)
    w = Math.round(w * r); h = Math.round(h * r)
  }
  const canvas = createCanvas(w, h)
  canvas.getContext('2d')!.drawImage(img, 0, 0, w, h)
  return processCanvas(canvas, w, h)
}

// ── Core pipeline (два потока) ────────────────────────────────────────────────

function processCanvas(canvas: HTMLCanvasElement, w: number, h: number): PreprocessedFrame {
  const ctx = canvas.getContext('2d')!
  const imageData = ctx.getImageData(0, 0, w, h)

  // Анализ бликов до любой обработки — нужны оригинальные цвета
  const glare = detectGlare(imageData.data, w, h)

  // Pipeline 1: Full image (превью + визуальный OCR)
  const fullDataUrl = processFullImage(w, h, imageData, glare)

  // Pipeline 2: MRZ — сначала crop, потом обработка
  const mrzRawDataUrl      = cropBottomDataUrl(canvas, MRZ_CROP_FRACTION)
  const mrzProcessedDataUrl = processMrz(canvas, w, h, MRZ_CROP_FRACTION, glare)

  return {
    fullDataUrl,
    mrzRawDataUrl,
    mrzProcessedDataUrl,
    feedback: glareToFeedback(glare),
    glare,
  }
}

// ── Pipeline 1: Full image ────────────────────────────────────────────────────

function processFullImage(
  w: number, h: number,
  imageData: ImageData,
  glare: GlareAnalysis,
): string {
  let gray = toGrayscale(imageData.data, w * h)

  // Sharpen только при отсутствии сильных бликов
  if (glare.level !== 'strong' && SHARPEN_AMOUNT > 0) {
    gray = unsharpMask(gray, w, h, SHARPEN_AMOUNT)
  }

  let output: Uint8Array
  if (glare.level === 'strong') {
    // Сильные блики: оставляем grayscale без бинаризации
    output = gray
  } else {
    // Mild glare: ослабляем порог; none: стандартный
    const c = glare.level === 'mild' ? ADAPTIVE_C - 3 : ADAPTIVE_C
    const blurred = gaussianBlur5(gray, w, h)
    output = adaptiveThreshold(blurred, w, h, ADAPTIVE_BLOCK, c)
  }

  const outCanvas = createCanvas(w, h)
  const outCtx    = outCanvas.getContext('2d')!
  const outData   = outCtx.createImageData(w, h)
  writeGrayToImageData(output, outData.data)
  outCtx.putImageData(outData, 0, 0)
  return outCanvas.toDataURL('image/png')
}

// ── Pipeline 2: MRZ ───────────────────────────────────────────────────────────

/**
 * MRZ-специализированный pipeline для Tesseract.
 *
 * Критичный порядок:
 * 1. Crop ПЕРВЫМ (до любой обработки) — сохраняет "<" и граничные символы
 * 2. Grayscale
 * 3. Contrast stretch (histogram normalization)
 * 4. Лёгкое размытие (убирает шум, пропускаем при strong glare)
 * 5. Upscale x3 — ключевой фактор точности Tesseract
 * 6. Чистый grayscale на выходе (не hard binary)
 */
export function processMrz(
  sourceCanvas: HTMLCanvasElement,
  w: number, h: number,
  cropFraction: number,
  glare: GlareAnalysis,
): string {
  // Шаг 1: Crop MRZ-зоны из оригинального canvas (до любой обработки)
  const cropH = Math.round(h * cropFraction)
  const cropY = h - cropH
  const mrzCanvas = createCanvas(w, cropH)
  mrzCanvas.getContext('2d')!.drawImage(sourceCanvas, 0, cropY, w, cropH, 0, 0, w, cropH)

  // Шаг 2: Pixel data из raw crop
  const mrzCtx  = mrzCanvas.getContext('2d')!
  const mrzData = mrzCtx.getImageData(0, 0, w, cropH)

  // Шаг 3: Grayscale
  let gray = toGrayscale(mrzData.data, w * cropH)

  // Шаг 4: Нормализация контраста — ослабляем при сильных бликах
  const contrastStrength = glare.level === 'strong' ? 0.6 : 1.0
  gray = normalizeContrast(gray, contrastStrength)

  // Шаг 5: Лёгкое размытие для шумоподавления (пропускаем при strong glare)
  if (glare.level !== 'strong') {
    gray = gaussianBlur5(gray, w, cropH)
  }

  // Шаг 6: Записываем обработанный grayscale во временный canvas
  const procCanvas = createCanvas(w, cropH)
  const procCtx    = procCanvas.getContext('2d')!
  const procData   = procCtx.createImageData(w, cropH)
  writeGrayToImageData(gray, procData.data)
  procCtx.putImageData(procData, 0, 0)

  // Шаг 7: Upscale x3 через canvas.drawImage — GPU-ускорено, мгновенно
  const upW = w * MRZ_UPSCALE
  const upH = cropH * MRZ_UPSCALE
  const outCanvas = createCanvas(upW, upH)
  const outCtx    = outCanvas.getContext('2d')!
  outCtx.imageSmoothingEnabled = true
  outCtx.imageSmoothingQuality = 'high'
  outCtx.drawImage(procCanvas, 0, 0, upW, upH)

  return outCanvas.toDataURL('image/png')
}

// ── Contrast normalization (histogram stretch) ────────────────────────────────

function normalizeContrast(gray: Uint8Array, strength: number): Uint8Array {
  let min = 255, max = 0
  for (let i = 0; i < gray.length; i++) {
    if (gray[i] < min) min = gray[i]
    if (gray[i] > max) max = gray[i]
  }
  const range = max - min
  if (range < 10) return gray  // уже очень низкий контраст — пропускаем

  const out = new Uint8Array(gray.length)
  for (let i = 0; i < gray.length; i++) {
    const stretched = Math.round(((gray[i] - min) / range) * 255)
    out[i] = Math.max(0, Math.min(255,
      Math.round(gray[i] * (1 - strength) + stretched * strength)
    ))
  }
  return out
}


// ── Glare detection ───────────────────────────────────────────────────────────

function detectGlare(data: Uint8ClampedArray, w: number, h: number): GlareAnalysis {
  const total = w * h
  let hotspots = 0, sumBrightness = 0
  for (let i = 0; i < data.length; i += 4) {
    const b = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]
    sumBrightness += b
    if (b >= GLARE_THRESHOLD) hotspots++
  }
  const hotspotRatio   = hotspots / total
  const meanBrightness = sumBrightness / total
  const level =
    hotspotRatio >= GLARE_STRONG_RATIO ? 'strong' :
    hotspotRatio >= GLARE_MILD_RATIO   ? 'mild'   : 'none'
  return { level, hotspotRatio, meanBrightness }
}

function glareToFeedback(g: GlareAnalysis): FrameFeedback {
  if (g.level === 'strong')              return 'glare_strong'
  if (g.level === 'mild')               return 'glare_mild'
  if (g.meanBrightness < TOO_DARK_MEAN) return 'too_dark'
  return 'ok'
}

// ── Grayscale ─────────────────────────────────────────────────────────────────

function toGrayscale(data: Uint8ClampedArray, n: number): Uint8Array {
  const gray = new Uint8Array(n)
  for (let i = 0; i < n; i++)
    gray[i] = Math.round(0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2])
  return gray
}

// ── Gaussian blur (5-tap separable) ──────────────────────────────────────────

function gaussianBlur5(gray: Uint8Array, w: number, h: number): Uint8Array {
  const K   = [1, 4, 6, 4, 1]
  const tmp = new Uint8Array(gray.length)
  const out = new Uint8Array(gray.length)

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0, wt = 0
      for (let k = -2; k <= 2; k++) {
        const xi = Math.max(0, Math.min(w - 1, x + k))
        const kw = K[k + 2]
        sum += gray[y * w + xi] * kw
        wt  += kw
      }
      tmp[y * w + x] = Math.round(sum / wt)
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0, wt = 0
      for (let k = -2; k <= 2; k++) {
        const yi = Math.max(0, Math.min(h - 1, y + k))
        const kw = K[k + 2]
        sum += tmp[yi * w + x] * kw
        wt  += kw
      }
      out[y * w + x] = Math.round(sum / wt)
    }
  }
  return out
}

// ── Unsharp mask ──────────────────────────────────────────────────────────────

function unsharpMask(gray: Uint8Array, w: number, h: number, amount: number): Uint8Array {
  const blurred = gaussianBlur5(gray, w, h)
  const out = new Uint8Array(gray.length)
  for (let i = 0; i < gray.length; i++) {
    out[i] = Math.max(0, Math.min(255,
      Math.round(gray[i] + amount * (gray[i] - blurred[i]))
    ))
  }
  return out
}

// ── Adaptive threshold (integral image, O(n)) ─────────────────────────────────

function adaptiveThreshold(
  gray: Uint8Array, w: number, h: number,
  blockSize: number, C: number,
): Uint8Array {
  const integral = new Float64Array((w + 1) * (h + 1))
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      integral[(y + 1) * (w + 1) + (x + 1)] =
        gray[y * w + x] +
        integral[y * (w + 1) + (x + 1)] +
        integral[(y + 1) * (w + 1) + x] -
        integral[y * (w + 1) + x]
    }
  }

  const half = Math.floor(blockSize / 2)
  const out  = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const x1 = Math.max(0, x - half), x2 = Math.min(w - 1, x + half)
      const y1 = Math.max(0, y - half), y2 = Math.min(h - 1, y + half)
      const area = (x2 - x1 + 1) * (y2 - y1 + 1)
      const sum  =
        integral[(y2 + 1) * (w + 1) + (x2 + 1)] -
        integral[y1 * (w + 1) + (x2 + 1)] -
        integral[(y2 + 1) * (w + 1) + x1] +
        integral[y1 * (w + 1) + x1]
      out[y * w + x] = gray[y * w + x] < (sum / area) - C ? 0 : 255
    }
  }
  return out
}

// ── Utils ─────────────────────────────────────────────────────────────────────

function writeGrayToImageData(gray: Uint8Array, data: Uint8ClampedArray): void {
  for (let i = 0; i < gray.length; i++) {
    data[i * 4]     = gray[i]
    data[i * 4 + 1] = gray[i]
    data[i * 4 + 2] = gray[i]
    data[i * 4 + 3] = 255
  }
}

function captureVideo(video: HTMLVideoElement): { canvas: HTMLCanvasElement; w: number; h: number } {
  let w = video.videoWidth, h = video.videoHeight
  if (w > MAX_DIM || h > MAX_DIM) {
    const r = Math.min(MAX_DIM / w, MAX_DIM / h)
    w = Math.round(w * r); h = Math.round(h * r)
  }
  const canvas = createCanvas(w, h)
  canvas.getContext('2d')!.drawImage(video, 0, 0, w, h)
  return { canvas, w, h }
}

function cropBottomDataUrl(canvas: HTMLCanvasElement, fraction: number): string {
  const cropH = Math.round(canvas.height * fraction)
  const cropY = canvas.height - cropH
  const out   = createCanvas(canvas.width, cropH)
  out.getContext('2d')!.drawImage(canvas, 0, cropY, canvas.width, cropH, 0, 0, canvas.width, cropH)
  return out.toDataURL('image/png')
}

function createCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = w; c.height = h
  return c
}

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload  = () => { URL.revokeObjectURL(url); resolve(img) }
    img.onerror = reject
    img.src     = url
  })
}

function okAnalysis() {
  return {
    feedback: 'ok' as FrameFeedback,
    glare: { level: 'none' as const, hotspotRatio: 0, meanBrightness: 128 },
  }
}
