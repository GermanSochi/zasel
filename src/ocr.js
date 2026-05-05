/**
 * Offline OCR паспортов без API ключа.
 *
 * Стратегия (в порядке надёжности):
 *  1. MRZ-зона — OCR-B шрифт, нет голограмм, Tesseract читает ~99%.
 *     ФИКС: пробелы заменяются на '<' (OCR читает fill-символ как пробел).
 *  2. Визуальные лейблы (ФАМИЛИЯ / ИМЯ / ОТЧЕСТВО) + обратный поиск.
 *  3. Standalone: крупная заглавная кириллическая строка (новый паспорт РФ).
 *  4. Дата рождения: предпочитаем год 1940–2010 (не дату выдачи паспорта).
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

// ── 1. Предобработка ──────────────────────────────────────────────────────────

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
      // Grayscale
      for (let i = 0; i < d.length; i += 4) {
        const g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]
        d[i] = d[i + 1] = d[i + 2] = g
      }
      // Contrast +40
      const f = (259 * 295) / (255 * 219)
      for (let i = 0; i < d.length; i += 4) {
        const v = Math.max(0, Math.min(255, f * (d[i] - 128) + 128))
        d[i] = d[i + 1] = d[i + 2] = v
      }
      ctx.putImageData(id, 0, 0)
      resolve(canvas.toDataURL('image/png'))
    }
    img.src = url
  })
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

  // Визуальный Кириллица приоритетнее MRZ-транслитерации для имён
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
    // КЛЮЧЕВОЙ ФИКС: пробелы → '<', а не удаление.
    // OCR читает fill-символ '<' как пробел. Если удалить — теряются разделители <<
    const s = line
      .replace(/\s/g, '<')
      .replace(/[^A-Za-z0-9<]/g, '<')
      .toUpperCase()

    // Строка 1: P<RUS... или PNRUS...
    if (/^P[A-Z<][A-Z]{3}[A-Z<]{5,}/.test(s) && (s.match(/</g) || []).length >= 5) {
      mrz1 = s
    }
    // Строка 2: 9 цифробукв + 1 + 3 буквы страны + 6 цифр ДР
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

// Транслитерация MRZ Latin → Кириллица (ИКАО/МВД России)
const MRZ_MAP = [
  ['SHCH', 'Щ'], ['ZHH', 'Ж'], ['KHH', 'Х'],
  ['ZH',  'Ж'],  ['KH',  'Х'],  ['TS',  'Ц'],  ['TC',  'Ц'],
  ['CH',  'Ч'],  ['SH',  'Ш'],  ['IE',  'Ъ'],  ['IU',  'Ю'],
  ['IA',  'Я'],  ['JO',  'Ё'],  ['YO',  'Ё'],  ['YU',  'Ю'],
  ['YA',  'Я'],
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
    const next  = lines[i + 1] || ''
    const next2 = lines[i + 2] || ''

    // ── ФАМИЛИЯ ──
    if (u.includes('ФАМИЛИ')) {
      const inline = cyrAfterLabel(lines[i], 'ФАМИЛИ')
      // Новые паспорта РФ печатают фамилию КРУПНО над лейблом → смотрим назад
      let prevSurname = ''
      for (let j = Math.max(0, i - 5); j < i && !prevSurname; j++) {
        const t = lines[j].trim().toUpperCase()
        if (/^[А-ЯЁ\-]{5,}$/.test(t) && !isLabel(lines[j])) prevSurname = t
      }
      result.surname = toTitle(inline || firstCyr(next) || prevSurname)
    }

    // ── ИМЯ (не путать с ФАМИЛИЯ) ──
    if (/\bИМЯ\b/.test(u) && !u.includes('ФАМИЛИ')) {
      const inline = cyrAfterLabel(lines[i], 'ИМЯ')
      // В новых паспортах значения могут быть на строке ДО лейбла
      const prevLine = i > 0 ? lines[i - 1] : ''
      const src = inline || next || (cyrWords(prevLine).length >= 2 ? prevLine : '')
      const words = cyrWords(src)
      if (words.length >= 2) {
        result.name       = toTitle(words[0])
        result.patronymic = toTitle(words[1])
      } else if (words.length === 1) {
        result.name = toTitle(words[0])
        if (!result.patronymic) {
          const p = firstCyr(next2)
          if (p.length >= 3 && !isLabel(next2)) result.patronymic = toTitle(p)
        }
      }
    }

    // ── ОТЧЕСТВО ──
    if (u.includes('ОТЧЕСТВ') && !result.patronymic) {
      const inline = cyrAfterLabel(lines[i], 'ОТЧЕСТВ')
      const prevLine = i > 0 ? lines[i - 1] : ''
      result.patronymic = toTitle(inline || firstCyr(next) || firstCyr(prevLine))
    }

    // ── ДАТА РОЖДЕНИЯ (фильтруем дату выдачи паспорта) ──
    if (/ДАТА.{0,6}РОЖ|РОЖ.{0,6}ДАТА/.test(u)) {
      const d = findDOBDate(lines[i]) || findDOBDate(next)
      if (d) result.dob = d
    }
    if (u.includes('РОЖДЕН') && !result.dob) {
      const d = findDOBDate(lines[i]) || findDOBDate(next)
      if (d) result.dob = d
    }
  }

  // Fallback: лучшая дата с годом в диапазоне ДР (1940–2010)
  if (!result.dob) result.dob = findBestDOB(lines)

  // Fallback: standalone заглавная кириллическая строка (новый формат паспорта)
  if (!result.surname) result.surname = findStandaloneSurname(lines)

  return result
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

// Дата рождения: год 1940–2010 (чтобы не захватить дату выдачи ~2000–2025)
function findDOBDate(s) {
  if (!s) return null
  const c = s.replace(/[ОоOо]/g, '0')
  const re = /\d{1,2}[.\s–\-]\d{1,2}[.\s–\-]\d{4}/g
  let m
  while ((m = re.exec(c)) !== null) {
    const dateStr = m[0].replace(/[\s–\-]/g, '.')
    const year = parseInt(dateStr.slice(-4))
    if (year >= 1940 && year <= 2010) return dateStr
  }
  return null
}

function findDate(s) {
  if (!s) return null
  const c = s.replace(/[ОоOо]/g, '0')
  const m = c.match(/\d{1,2}[.\s–\-]\d{1,2}[.\s–\-]\d{4}/)
  return m ? m[0].replace(/[\s–\-]/g, '.') : null
}

// Выбираем дату с наиболее правдоподобным годом рождения
function findBestDOB(lines) {
  const all = []
  for (const l of lines) {
    const d = findDate(l)
    if (d) all.push(d)
  }
  return all.find(d => {
    const y = parseInt(d.slice(-4))
    return y >= 1940 && y <= 2010
  }) || all[0] || ''
}

// В новых паспортах РФ фамилия напечатана ЗАГЛАВНЫМИ буквами отдельной строкой
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
