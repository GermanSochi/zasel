/**
 * OCR оркестратор — офлайн распознавание паспортов СНГ
 *
 * Стратегии (по убыванию приоритета):
 *  1. ONNX (TextFields YOLOv8 + OCR RUS) — лучший результат на чётких фото
 *  2. Full OCR (Tesseract rus+eng) + FIO Extractor (словари + fuzzy) — ОСНОВНОЙ FALLBACK
 *  3. MRZ (Tesseract eng) — только для даты рождения или крайний случай
 */

import { createWorker } from 'tesseract.js'
import { initTextFieldsModel, detectFields } from './fieldDetector.js'
import { initOcrRusModel, ocrField } from './ocrRusModel.js'
import { loadDict, extractFIO, cleanOcrText } from './fioExtractor.js'

const LANG_PATH = '/zasel/tessdata'
const MAX_DIM   = 1920

// Eager: грузим ONNX + словарь при импорте модуля
initTextFieldsModel()
initOcrRusModel()
loadDict()

// ── Tesseract workers (lazy, singleton) ───────────────────────────────────────

let _fullP = null  // rus+eng, полный документ
let _mrzP  = null  // eng, MRZ-зона

function getFullWorker() {
  if (!_fullP) {
    console.log('[OCR] инициализация full worker (rus+eng)...')
    _fullP = createWorker('rus+eng', 1, {
      langPath: LANG_PATH,
    })
    _fullP
      .then(() => console.log('[OCR] full worker готов'))
      .catch(e  => { console.error('[OCR] full worker ошибка:', e); _fullP = null })
  }
  return _fullP
}

function getMrzWorker() {
  if (!_mrzP) {
    console.log('[OCR] инициализация mrz worker (eng)...')
    _mrzP = createWorker('eng', 1, { langPath: LANG_PATH })
    _mrzP
      .then(() => console.log('[OCR] mrz worker готов'))
      .catch(e  => { console.error('[OCR] mrz worker ошибка:', e); _mrzP = null })
  }
  return _mrzP
}

// ── Image helpers ─────────────────────────────────────────────────────────────

function loadImageToCanvas(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onerror = reject
    img.onload  = () => {
      let w = img.naturalWidth, h = img.naturalHeight
      if (w > MAX_DIM || h > MAX_DIM) {
        const r = Math.min(MAX_DIM / w, MAX_DIM / h)
        w = Math.round(w * r); h = Math.round(h * r)
      }
      const canvas = document.createElement('canvas')
      canvas.width = w; canvas.height = h
      canvas.getContext('2d').drawImage(img, 0, 0, w, h)
      resolve({ canvas, width: w, height: h })
    }
    img.src = dataUrl
  })
}

// Кроп заданной зоны → grayscale → [опционально: масштаб] → JPEG/PNG
function cropPreprocess(canvas, y0, y1, { scale = 1, binarize = false, format = 'jpeg' } = {}) {
  const cropH = Math.max(1, y1 - y0)
  const out   = document.createElement('canvas')
  out.width   = Math.round(canvas.width * scale)
  out.height  = Math.round(cropH * scale)
  const ctx   = out.getContext('2d')
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(canvas, 0, y0, canvas.width, cropH, 0, 0, out.width, out.height)

  // Grayscale
  const id = ctx.getImageData(0, 0, out.width, out.height)
  const d  = id.data
  for (let i = 0; i < d.length; i += 4) {
    const g = (0.299 * d[i] + 0.587 * d[i+1] + 0.114 * d[i+2]) | 0
    d[i] = d[i+1] = d[i+2] = g
  }
  if (binarize) binarizeOtsu(d, out.width, out.height)
  ctx.putImageData(id, 0, 0)

  return format === 'png'
    ? out.toDataURL('image/png')
    : out.toDataURL('image/jpeg', 0.88)
}

// Grayscale + Otsu binarize (только для MRZ)
function binarizeOtsu(data, w, h) {
  const n = w * h
  const gray = new Uint8Array(n)
  for (let i = 0; i < n; i++)
    gray[i] = (0.299 * data[i*4] + 0.587 * data[i*4+1] + 0.114 * data[i*4+2]) | 0
  const hist = new Array(256).fill(0)
  for (const g of gray) hist[g]++
  let sum = 0
  for (let t = 0; t < 256; t++) sum += t * hist[t]
  let sumB = 0, wB = 0, varMax = 0, threshold = 128
  for (let t = 0; t < 256; t++) {
    wB += hist[t]
    if (!wB || wB === n) continue
    const wF = n - wB
    sumB += t * hist[t]
    const mB = sumB / wB, mF = (sum - sumB) / wF
    const v = wB * wF * (mB - mF) ** 2
    if (v > varMax) { varMax = v; threshold = t }
  }
  for (let i = 0; i < n; i++) {
    const v = gray[i] <= threshold ? 0 : 255
    data[i*4] = data[i*4+1] = data[i*4+2] = v; data[i*4+3] = 255
  }
}

// ── MRZ helpers ───────────────────────────────────────────────────────────────

function normalizeMrzLine(raw) {
  return raw.toUpperCase().replace(/\s+/g, '<').replace(/[^A-Z0-9<]/g, '<')
}

function findMRZ(text) {
  const lines = text.split('\n').map(normalizeMrzLine).filter(l => l.length >= 30)
  let line1 = '', line2 = ''
  for (const l of lines) {
    if (!line1 && /^P[A-Z<][A-Z]{3}/.test(l) && l.length >= 40)
      line1 = l.padEnd(44, '<').slice(0, 44)
    if (!line2 && /^[A-Z0-9]{9}[0-9][A-Z]{3}[0-9]{6}/.test(l) && l.length >= 40)
      line2 = l.padEnd(44, '<').slice(0, 44)
  }
  if (!line1 || !line2) return { valid: false }
  const dobValid = mrzCheckDigit(line2.slice(13, 19)) === Number(line2[19])
  return { valid: dobValid, line1, line2 }
}

function mrzCheckDigit(s) {
  const W = [7, 3, 1]
  const val = c => {
    if (c === '<') return 0
    if (c >= '0' && c <= '9') return Number(c)
    return c.charCodeAt(0) - 55
  }
  return s.split('').reduce((sum, c, i) => sum + val(c) * W[i % 3], 0) % 10
}

function parseICAO9303(line1, line2) {
  const result = { surname: '', name: '', patronymic: '', dob: '' }
  const nameField = line1.slice(5, 44)
  const sepIdx    = nameField.indexOf('<<')
  if (sepIdx !== -1) {
    result.surname    = toTitle(mrzToCyr(nameField.slice(0, sepIdx).replace(/</g, '')))
    const given       = nameField.slice(sepIdx + 2).split('<').filter(Boolean)
    result.name       = given[0] ? toTitle(mrzToCyr(given[0])) : ''
    result.patronymic = given[1] ? toTitle(mrzToCyr(given[1])) : ''
  }
  const dobRaw = line2.slice(13, 19)
  if (/^\d{6}$/.test(dobRaw)) {
    const yy   = parseInt(dobRaw.slice(0, 2))
    const mm   = dobRaw.slice(2, 4)
    const dd   = dobRaw.slice(4, 6)
    const nowYY = new Date().getFullYear() % 100
    const yyyy  = yy > nowYY + 10 ? 1900 + yy : 2000 + yy
    result.dob = `${dd}.${mm}.${yyyy}`
  }
  return result
}

const MRZ_MAP = [
  ['SHCH','Щ'],['ZHH','Ж'],['KHH','Х'],
  ['ZH','Ж'],['KH','Х'],['TS','Ц'],['TC','Ц'],
  ['CH','Ч'],['SH','Ш'],['IE','Ъ'],['IU','Ю'],
  ['IA','Я'],['JO','Ё'],['YO','Ё'],['YU','Ю'],['YA','Я'],
  ['A','А'],['B','Б'],['V','В'],['G','Г'],['D','Д'],['E','Е'],
  ['Z','З'],['I','И'],['J','Й'],['K','К'],['L','Л'],['M','М'],
  ['N','Н'],['O','О'],['P','П'],['R','Р'],['S','С'],['T','Т'],
  ['U','У'],['F','Ф'],['H','Х'],['C','Ц'],['Y','Ы'],
]

function mrzToCyr(s) {
  s = s.replace(/[<0-9]/g, '').toUpperCase()
  let out = '', i = 0
  while (i < s.length) {
    let matched = false
    for (const [lat, cyr] of MRZ_MAP) {
      if (s.startsWith(lat, i)) { out += cyr; i += lat.length; matched = true; break }
    }
    if (!matched) i++
  }
  return out
}

// ── Date helpers ──────────────────────────────────────────────────────────────

function findValidDOB(text) {
  const c = text.replace(/[ОоOо]/g, '0')
  const re = /\d{1,2}[.\s–\-\/]\d{1,2}[.\s–\-\/]\d{4}/g
  let m
  while ((m = re.exec(c)) !== null) {
    const d = m[0].replace(/[\s–\-\/]/g, '.')
    if (isValidDOB(d)) return d
  }
  return null
}

function findBestDOB(lines) {
  for (const l of lines) {
    const d = findValidDOB(l)
    if (d) return d
  }
  return ''
}

function isValidDOB(dateStr) {
  const parts = dateStr.split('.')
  if (parts.length !== 3) return false
  const year = parseInt(parts[2])
  if (isNaN(year)) return false
  const age = new Date().getFullYear() - year
  return age >= 14 && age <= 80
}

function toTitle(s) {
  if (!s) return ''
  const u = s.toUpperCase()
  return u[0] + u.slice(1).toLowerCase()
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function extractPassportData(imageDataUrl, _apiKey, onProgress) {
  onProgress?.(5)

  const { canvas, width, height } = await loadImageToCanvas(imageDataUrl)
  onProgress?.(12)

  // Кроп для MRZ — нижние 22%, grayscale (Otsu бинаризация портит WhatsApp фото)
  const mrzCropUrl = cropPreprocess(canvas, Math.round(height * 0.78), height, {
    scale: 1, binarize: false, format: 'png',
  })

  // ── 1. ONNX ───────────────────────────────────────────────────────────────
  let onnxResult = null
  try {
    onProgress?.(16)
    const detections = await detectFields(canvas)
    onProgress?.(48)

    const hasAny = detections.surname || detections.name || detections.patronymic
    if (hasAny) {
      const [surname, name, patronymic] = await Promise.all([
        detections.surname    ? ocrField(canvas, detections.surname)    : Promise.resolve(''),
        detections.name       ? ocrField(canvas, detections.name)       : Promise.resolve(''),
        detections.patronymic ? ocrField(canvas, detections.patronymic) : Promise.resolve(''),
      ])
      onProgress?.(72)
      console.log('[ONNX] фамилия:', surname, '| имя:', name, '| отчество:', patronymic)

      if (surname || name || patronymic) {
        onnxResult = {
          surname:    toTitle(surname),
          name:       toTitle(name),
          patronymic: toTitle(patronymic),
          dob: '',
        }
      }
    }
  } catch (e) {
    console.warn('[ONNX] ошибка:', e.message)
  }

  // ── 2. Full OCR + MRZ (параллельно) ──────────────────────────────────────

  // Full OCR — ПОЛНОЕ изображение, без кропа, grayscale, PNG (без JPEG-деградации)
  const fullCropUrl = cropPreprocess(canvas, 0, height, {
    scale: 1, binarize: false, format: 'png',
  })

  onProgress?.(75)

  const [fullOcrResult, mrzOcrResult] = await Promise.allSettled([
    getFullWorker().then(w => w.recognize(fullCropUrl)),
    getMrzWorker().then(w => w.recognize(mrzCropUrl)),
  ])

  const fullText = fullOcrResult.status === 'fulfilled' ? fullOcrResult.value.data.text : ''
  const mrzText  = mrzOcrResult.status  === 'fulfilled' ? mrzOcrResult.value.data.text  : ''

  if (fullText) console.log('[FullOCR] текст:\n' + fullText.slice(0, 500))

  // MRZ парсинг (только для даты рождения)
  let mrzParsed = { valid: false }
  let mrzData   = { dob: '', surname: '', name: '', patronymic: '' }
  if (mrzText) {
    mrzParsed = findMRZ(mrzText)
    if (mrzParsed.valid) {
      mrzData = parseICAO9303(mrzParsed.line1, mrzParsed.line2)
      console.log('[MRZ] найдена, ДР:', mrzData.dob)
    }
  }

  // ── 3. ONNX + MRZ dob → финальный результат ──────────────────────────────
  if (onnxResult) {
    // Дополняем датой из MRZ или из визуального OCR
    if (!onnxResult.dob) {
      if (mrzParsed.valid && mrzData.dob) {
        onnxResult.dob = mrzData.dob
      } else if (fullText) {
        onnxResult.dob = findBestDOB(fullText.split('\n').map(l => l.trim()).filter(Boolean))
      }
    }
    onProgress?.(100)
    return {
      ...onnxResult,
      _rawOcr:         fullText,
      _mrzRaw:         mrzText,
      _mrzFound:       mrzParsed.valid,
      _bestStrategy:   'onnx',
      _mrzCropDataUrl: mrzCropUrl,
    }
  }

  // ── 4. FIO Extractor (Full OCR + Dict + Fuzzy) ────────────────────────────
  onProgress?.(82)

  let fioResult = { surname: '', name: '', patronymic: '', confidence: 0, debug: {} }
  if (fullText) {
    try {
      fioResult = await extractFIO(fullText)
      console.log('[FIO] результат:', fioResult.surname, fioResult.name, fioResult.patronymic,
        `(confidence: ${fioResult.confidence}%)`)
      if (fioResult.debug) {
        console.group('[FIO Debug]')
        console.log('Кандидаты:', fioResult.debug.candidates?.join(', '))
        console.log('Метки:', JSON.stringify(fioResult.debug.anchors))
        console.log('Стратегия:', fioResult.debug.strategy)
        console.groupEnd()
      }
    } catch (e) {
      console.warn('[FIO] ошибка извлечения:', e)
    }
  }

  // ── 5. Если FIO слабый — MRZ как fallback для ФИО ────────────────────────
  let surname    = fioResult.surname
  let name       = fioResult.name
  let patronymic = fioResult.patronymic
  let strategy   = 'fio-dict'

  if (mrzParsed.valid && fioResult.confidence < 40) {
    // MRZ дала ФИО через транслитерацию
    if (!surname    && mrzData.surname)    { surname    = mrzData.surname;    strategy = 'mrz' }
    if (!name       && mrzData.name)       { name       = mrzData.name;       strategy = 'mrz' }
    if (!patronymic && mrzData.patronymic) { patronymic = mrzData.patronymic; strategy = 'mrz' }
  }

  // Дата рождения — из MRZ или из OCR текста
  const dob = mrzParsed.valid ? mrzData.dob
    : findBestDOB((fullText || '').split('\n').map(l => l.trim()).filter(Boolean))

  onProgress?.(100)

  // Диагностический текст
  const diagText = buildDiagText({
    strategy, fullText, mrzText, mrzParsed,
    fio: { surname, name, patronymic, dob },
    fioDebug: fioResult.debug,
    confidence: fioResult.confidence,
  })

  return {
    surname,
    name,
    patronymic,
    dob,
    _rawOcr:         diagText,
    _mrzRaw:         mrzText,
    _mrzFound:       mrzParsed.valid,
    _bestStrategy:   strategy,
    _mrzCropDataUrl: mrzCropUrl,
  }
}

// ── Diagnostic text builder ───────────────────────────────────────────────────

function buildDiagText({ strategy, fullText, mrzText, mrzParsed, fio, fioDebug, confidence }) {
  return [
    `═══ Стратегия: ${strategy} ═══`,
    `Фамилия:  ${fio.surname    || '—'}`,
    `Имя:      ${fio.name       || '—'}`,
    `Отчество: ${fio.patronymic || '—'}`,
    `Дата рожд.: ${fio.dob     || '—'}`,
    `Confidence FIO: ${confidence}%`,
    '',
    `MRZ: ${mrzParsed.valid ? '✓ найдена' : '✗ не найдена'}`,
    fioDebug?.anchors ? `Метки найдены: ${JSON.stringify(fioDebug.anchors)}` : '',
    fioDebug?.strategy ? `Стратегия FIO: ${fioDebug.strategy}` : '',
    '',
    `── Кандидаты OCR (${fioDebug?.candidates?.length || 0} слов) ──`,
    fioDebug?.candidates?.join(', ') || '(нет)',
    '',
    `── MRZ OCR (${mrzText.length} симв.) ──`,
    mrzText.trim() || '(пусто)',
    '',
    `── Full OCR (${fullText.length} симв.) ──`,
    fullText.trim().slice(0, 1000) || '(пусто)',
  ].filter(l => l !== undefined).join('\n')
}

// ── Viewport OCR (для кнопки "Читать" в вьювере) ─────────────────────────────

export async function recognizeRegion(dataUrl) {
  const worker = await getFullWorker()
  const result = await worker.recognize(dataUrl)
  return result.data.text
}

// ── Утилита для main.js ───────────────────────────────────────────────────────

export function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload  = () => resolve(reader.result)
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}
