/**
 * Offline OCR паспортов без API ключа.
 *
 * Стратегия:
 *  1. MRZ — пробелы → '<' (OCR читает fill-символ как пробел)
 *  2. Визуальные лейблы + поиск в радиусе 2 строк (до и после)
 *  3. Standalone: заглавная строка перед "ФАМИЛИЯ" / "ИМЯ" / "PNRUS"
 *  4. Дата: год > 1940 && год < (currentYear - 14) — не берём дату выдачи
 *  5. Canvas: grayscale → threshold Отсу (выжигает серый фон паспорта)
 */

import { createWorker } from 'tesseract.js'

let _worker = null

async function getWorker(onProgress) {
  if (_worker) return _worker
  _worker = await createWorker('rus+eng', 1, {
    logger: m => {
      if (onProgress && m.status === 'recognizing text')
        onProgress(Math.round(m.progress * 100))
    },
  })
  return _worker
}

// ── 1. Предобработка изображения ─────────────────────────────────────────────

export function preprocessImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onerror = reject
    img.onload = () => {
      URL.revokeObjectURL(url)
      const MAX = 2000
      let w = img.naturalWidth, h = img.naturalHeight
      if (w > MAX || h > MAX) {
        const r = Math.min(MAX / w, MAX / h)
        w = Math.round(w * r); h = Math.round(h * r)
      }
      const canvas = document.createElement('canvas')
      canvas.width = w; canvas.height = h
      const ctx = canvas.getContext('2d')
      ctx.drawImage(img, 0, 0, w, h)

      const id = ctx.getImageData(0, 0, w, h)
      const d = id.data

      // Шаг 1: Grayscale
      for (let i = 0; i < d.length; i += 4) {
        const g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]
        d[i] = d[i + 1] = d[i + 2] = g
      }

      // Шаг 2: Threshold по методу Отсу — выжигает серый фон паспорта
      applyThreshold(d, w, h)

      ctx.putImageData(id, 0, 0)
      resolve(canvas.toDataURL('image/png'))
    }
    img.src = url
  })
}

// Метод Отсу: автоматически находит порог между фоном и текстом
function applyThreshold(d, w, h) {
  const hist = new Array(256).fill(0)
  for (let i = 0; i < d.length; i += 4) hist[d[i]]++

  const total = w * h
  let sum = 0
  for (let t = 0; t < 256; t++) sum += t * hist[t]

  let sumB = 0, wB = 0, varMax = 0, threshold = 128

  for (let t = 0; t < 256; t++) {
    wB += hist[t]
    if (wB === 0) continue
    const wF = total - wB
    if (wF === 0) break
    sumB += t * hist[t]
    const mB = sumB / wB
    const mF = (sum - sumB) / wF
    const v = wB * wF * (mB - mF) ** 2
    if (v > varMax) { varMax = v; threshold = t }
  }

  for (let i = 0; i < d.length; i += 4) {
    const v = d[i] > threshold ? 255 : 0
    d[i] = d[i + 1] = d[i + 2] = v
  }
}

// ── 2. Главная функция ────────────────────────────────────────────────────────

export async function extractPassportData(imageDataUrl, _apiKey, onProgress) {
  onProgress?.(5)
  const worker = await getWorker(onProgress)
  const { data: { text } } = await worker.recognize(imageDataUrl)
  onProgress?.(100)

  console.log('[OCR raw]\n' + text)

  const result = parsePassportText(text)
  result._rawOcr = text
  return result
}

// ── 3. Парсинг ────────────────────────────────────────────────────────────────

function parsePassportText(raw) {
  const lines = raw.split('\n').map(l => l.trim()).filter(Boolean)
  const mrz = parseMRZ(lines)
  const vis = parseVisual(lines)

  return {
    surname:    vis.surname    || mrz.surname    || '',
    name:       vis.name       || mrz.name       || '',
    patronymic: vis.patronymic || mrz.patronymic || '',
    dob:        vis.dob        || mrz.dob        || '',
  }
}

// ── 3a. MRZ ───────────────────────────────────────────────────────────────────

function parseMRZ(lines) {
  const result = { surname: '', name: '', patronymic: '', dob: '' }
  let mrz1 = '', mrz2 = ''

  for (const line of lines) {
    const s = line
      .replace(/\s/g, '<')          // OCR читает '<' как пробел — восстанавливаем
      .replace(/[^A-Za-z0-9<]/g, '<')
      .toUpperCase()

    if (/^P[A-Z<][A-Z]{3}[A-Z<]{5,}/.test(s) && (s.match(/</g) || []).length >= 5) {
      mrz1 = s
    }
    if (/^[A-Z0-9]{9}[0-9][A-Z]{3}[0-9]{6}/.test(s)) {
      mrz2 = s
    }
  }

  if (mrz1) {
    const afterCountry = mrz1.slice(5)
    const [surnameRaw, givenRaw = ''] = afterCountry.split('<<')
    result.surname    = mrzToCyr(surnameRaw)
    const given = givenRaw.split('<').filter(Boolean)
    result.name       = given[0] ? mrzToCyr(given[0]) : ''
    result.patronymic = given[1] ? mrzToCyr(given[1]) : ''
  }

  if (mrz2) {
    const raw6 = mrz2.slice(13, 19)
    if (/^\d{6}$/.test(raw6)) {
      const yy = parseInt(raw6.slice(0, 2), 10)
      const mm = raw6.slice(2, 4)
      const dd = raw6.slice(4, 6)
      const yyyy = yy > 30 ? 1900 + yy : 2000 + yy
      result.dob = `${dd}.${mm}.${yyyy}`
    }
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
  return out ? out[0] + out.slice(1).toLowerCase() : ''
}

// ── 3b. Визуальный парсинг ────────────────────────────────────────────────────

function parseVisual(lines) {
  const result = { surname: '', name: '', patronymic: '', dob: '' }

  for (let i = 0; i < lines.length; i++) {
    const u = lines[i].toUpperCase()

    // ── ФАМИЛИЯ: ищем в радиусе 2 строк ──────────────────────────────────────
    // Ключевые маркеры: "ФАМИЛИ", "SURNAME", начало MRZ "PNRUS"
    const isSurnameAnchor = u.includes('ФАМИЛИ') || u.includes('SURNAME') || /^PNRU[S<]/.test(u)
    if (isSurnameAnchor) {
      const inline = u.includes('ФАМИЛИ') ? cyrAfterLabel(lines[i], 'ФАМИЛИ')
                   : u.includes('SURNAME') ? cyrAfterLabel(lines[i], 'SURNAME') : ''

      // Строка непосредственно ДО якоря — главный кандидат на фамилию
      const prevCandidate = surnameFromRadius(lines, i, 2)
      result.surname = toTitle(inline || prevCandidate)
    }

    // ── ИМЯ: поиск в радиусе 2 строк от лейбла ───────────────────────────────
    if (/\bИМЯ\b/.test(u) && !u.includes('ФАМИЛИ')) {
      const inline = cyrAfterLabel(lines[i], 'ИМЯ')
      // Берём строки [-2..+2] относительно "Имя", собираем кириллические слова
      const nearby = getNearbyText(lines, i, 2)
      const words  = cyrWords(inline || nearby)
      if (words.length >= 2) {
        result.name       = toTitle(words[0])
        result.patronymic = toTitle(words[1])
      } else if (words.length === 1) {
        result.name = toTitle(words[0])
      }
    }

    // ── ОТЧЕСТВО ──────────────────────────────────────────────────────────────
    if (u.includes('ОТЧЕСТВ') && !result.patronymic) {
      const inline = cyrAfterLabel(lines[i], 'ОТЧЕСТВ')
      const nearby = getNearbyText(lines, i, 2)
      result.patronymic = toTitle(inline || firstCyr(nearby))
    }

    // ── ДАТА РОЖДЕНИЯ ─────────────────────────────────────────────────────────
    if (/ДАТА.{0,6}РОЖ|РОЖ.{0,6}ДАТА/.test(u)) {
      const d = findDOBDate(lines[i]) || findDOBDate(lines[i + 1] || '')
      if (d) result.dob = d
    }
    if (u.includes('РОЖДЕН') && !result.dob) {
      const d = findDOBDate(lines[i]) || findDOBDate(lines[i + 1] || '')
      if (d) result.dob = d
    }
  }

  if (!result.dob)     result.dob     = findBestDOB(lines)
  if (!result.surname) result.surname = findStandaloneSurname(lines)

  return result
}

// Ищем фамилию в строках ПЕРЕД якорем (радиус r): берём ближайшую Кириллическую строку
function surnameFromRadius(lines, anchorIdx, r) {
  for (let j = anchorIdx - 1; j >= Math.max(0, anchorIdx - r); j--) {
    const t = lines[j].trim().toUpperCase()
    if (/^[А-ЯЁ\-]{4,}$/.test(t) && !isLabel(lines[j])) return t
  }
  return ''
}

// Объединяем текст строк вокруг индекса (исключая сам лейбл)
function getNearbyText(lines, idx, r) {
  const parts = []
  for (let j = Math.max(0, idx - r); j <= Math.min(lines.length - 1, idx + r); j++) {
    if (j !== idx) parts.push(lines[j])
  }
  return parts.join(' ')
}

// ── Хелперы ───────────────────────────────────────────────────────────────────

function cyrAfterLabel(line, label) {
  const idx = line.toUpperCase().indexOf(label.toUpperCase())
  if (idx === -1) return ''
  return cyrWords(line.slice(idx + label.length)).join(' ')
}

function firstCyr(s) {
  const m = s.match(/[А-ЯЁа-яё][А-ЯЁа-яё\-]{1,}/)
  return m ? m[0].toUpperCase() : ''
}

function cyrWords(s) {
  return (s.match(/[А-ЯЁа-яё\-]{2,}/g) || []).map(w => w.toUpperCase())
}

// Динамический диапазон ДР: год > 1940 && год < (currentYear - 14)
function isDOBYear(year) {
  const minAge = 14
  return year > 1940 && year < (new Date().getFullYear() - minAge)
}

function findDOBDate(s) {
  if (!s) return null
  const c = s.replace(/[ОоOо]/g, '0')
  const re = /\d{1,2}[.\s–\-]\d{1,2}[.\s–\-]\d{4}/g
  let m
  while ((m = re.exec(c)) !== null) {
    const dateStr = m[0].replace(/[\s–\-]/g, '.')
    if (isDOBYear(parseInt(dateStr.slice(-4)))) return dateStr
  }
  return null
}

function findDate(s) {
  if (!s) return null
  const c = s.replace(/[ОоOо]/g, '0')
  const m = c.match(/\d{1,2}[.\s–\-]\d{1,2}[.\s–\-]\d{4}/)
  return m ? m[0].replace(/[\s–\-]/g, '.') : null
}

function findBestDOB(lines) {
  const all = []
  for (const l of lines) { const d = findDate(l); if (d) all.push(d) }
  return all.find(d => isDOBYear(parseInt(d.slice(-4)))) || all[0] || ''
}

// Standalone заглавная Кириллическая строка (новый формат паспорта РФ)
function findStandaloneSurname(lines) {
  for (const line of lines) {
    const t = line.trim()
    const u = t.toUpperCase()
    if (u.length >= 5 && u.length <= 25 && /^[А-ЯЁ\-]+$/.test(u) && !isLabel(t)) {
      return toTitle(u)
    }
  }
  return ''
}

function isLabel(s) {
  return /ДАТА|ПОЛ\b|МЕСТО|ГРАЖД|ОРГАН|ВЫДАН|СЕРИЯ|НОМЕР|ПОДПИС|РОССИЙСК|ФЕДЕРАЦ|ПАСПОРТ|ОТДЕЛОМ|ВНУТРЕН|РЕСПУБЛ|ОБЛАСТ|РАЙОН|КОММУН|МВД|ФМС|МИГРАЦ|ЧЕЧЕНСК|ДАГЕСТАН|МОСКВ/.test(s.toUpperCase())
}

function toTitle(s) {
  if (!s) return ''
  const u = s.toUpperCase()
  return u[0] + u.slice(1).toLowerCase()
}

export function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}
