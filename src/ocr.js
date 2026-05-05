/**
 * Offline OCR паспортов без API ключа.
 *
 * Стратегия (в порядке надёжности):
 *  1. MRZ-зона (две нижние строки паспорта) — OCR-B шрифт, нет голограмм,
 *     Tesseract читает ~99%. Имена транслитерируем Latin→Кириллица.
 *  2. Визуальные лейблы (ФАМИЛИЯ / ИМЯ / ОТЧЕСТВО) — Tesseract rus.
 *  3. Fallback: первые крупные кириллические слова на странице.
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

// ── 1. Предобработка изображения ──────────────────────────────────────────────
// Браузерный аналог PIL: resize → grayscale → contrast (как в ai-documents-parser)

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

      // Grayscale
      const id = ctx.getImageData(0, 0, w, h)
      const d = id.data
      for (let i = 0; i < d.length; i += 4) {
        const g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]
        d[i] = d[i + 1] = d[i + 2] = g
      }
      // Contrast +40
      const f = (259 * 295) / (255 * 219) // factor for contrast=40
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

  // Для отладки в консоли браузера
  console.log('[OCR raw]\n' + text)

  return parsePassportText(text)
}

// ── 3. Парсинг ────────────────────────────────────────────────────────────────

function parsePassportText(raw) {
  const lines = raw.split('\n').map(l => l.trim()).filter(Boolean)

  // Стратегия 1: MRZ
  const mrz = parseMRZ(lines)

  // Стратегия 2: визуальные лейблы (даёт Кириллицу напрямую — приоритет для имён)
  const vis = parseVisual(lines)

  // Собираем: Кириллица из визуала > MRZ транслитерация; дата — из обоих
  return {
    surname:    vis.surname    || mrz.surname    || '',
    name:       vis.name       || mrz.name       || '',
    patronymic: vis.patronymic || mrz.patronymic || '',
    dob:        vis.dob        || mrz.dob        || '',
  }
}

// ── 3a. MRZ (Machine Readable Zone) ──────────────────────────────────────────

function parseMRZ(lines) {
  const result = { surname: '', name: '', patronymic: '', dob: '' }

  let mrz1 = '', mrz2 = ''

  for (const line of lines) {
    // Нормализуем: убираем пробелы, похожие символы → <
    const s = line
      .replace(/\s/g, '')
      .replace(/[^A-Za-z0-9<]/g, '<')
      .toUpperCase()

    // Строка 1: P<RUS... — тип + страна + имя
    if (/^P.{1}[A-Z]{3}[A-Z<]{5,}/.test(s) && (s.match(/</g) || []).length >= 5) {
      mrz1 = s
    }
    // Строка 2: 9 символов номер + контрольная + 3 страна + 6 ДР + ...
    if (/^[A-Z0-9]{9}[0-9][A-Z]{3}[0-9]{6}/.test(s)) {
      mrz2 = s
    }
  }

  if (mrz1) {
    // P<RUS IVANOV << IVAN < IVANOVICH <<<<
    const afterCountry = mrz1.slice(5)           // обрезаем "P<RUS"
    const [surnameRaw, givenRaw = ''] = afterCountry.split('<<')
    result.surname    = mrzToCyr(surnameRaw)
    const given = givenRaw.split('<').filter(Boolean)
    result.name       = given[0] ? mrzToCyr(given[0]) : ''
    result.patronymic = given[1] ? mrzToCyr(given[1]) : ''
  }

  if (mrz2) {
    // позиции 14-19 (0-based: 13-18) — YYMMDD
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

// Транслитерация MRZ (Latin) → Кириллица по стандарту ИКАО/МВД России
const MRZ_MAP = [
  ['SHCH', 'Щ'], ['ZHH', 'Ж'], ['KHH', 'Х'],
  ['ZH',  'Ж'],  ['KH',  'Х'],  ['TS',  'Ц'],  ['TC',  'Ц'],
  ['CH',  'Ч'],  ['SH',  'Ш'],  ['IE',  'Ъ'],  ['IU',  'Ю'],
  ['IA',  'Я'],  ['JO',  'Ё'],
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

// ── 3b. Визуальные лейблы (Кириллица) ────────────────────────────────────────

function parseVisual(lines) {
  const result = { surname: '', name: '', patronymic: '', dob: '' }

  for (let i = 0; i < lines.length; i++) {
    const u = lines[i].toUpperCase()
    const next  = lines[i + 1] || ''
    const next2 = lines[i + 2] || ''

    // ── ФАМИЛИЯ ──
    if (u.includes('ФАМИЛИ')) {
      const inline = cyrAfterLabel(lines[i], 'ФАМИЛИ')
      result.surname = toTitle(inline || firstCyr(next))
    }

    // ── ИМЯ (не путать с ФАМИЛИЯ) ──
    if (/\bИМЯ\b/.test(u) && !u.includes('ФАМИЛИ')) {
      const inline = cyrAfterLabel(lines[i], 'ИМЯ')
      const words  = cyrWords(inline || next)
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
      result.patronymic = toTitle(inline || firstCyr(next))
    }

    // ── ДАТА РОЖДЕНИЯ ──
    if (/ДАТА.{0,6}РОЖ|РОЖ.{0,6}ДАТА/.test(u)) {
      result.dob = findDate(lines[i]) || findDate(next) || result.dob
    }

    // Дата на строке с "РОЖДЕН"
    if (u.includes('РОЖДЕН') && !result.dob) {
      result.dob = findDate(lines[i]) || findDate(next) || ''
    }
  }

  // Fallback: первая дата в тексте
  if (!result.dob) {
    for (const l of lines) {
      const d = findDate(l)
      if (d) { result.dob = d; break }
    }
  }

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

function findDate(s) {
  // OCR часто путает О и 0 — нормализуем
  const c = s.replace(/[ОоOо]/g, '0')
  const m = c.match(/\d{1,2}[.\s–\-]\d{1,2}[.\s–\-]\d{4}/)
  return m ? m[0].replace(/[\s–\-]/g, '.') : null
}

function isLabel(s) {
  return /ДАТА|ПОЛ\b|МЕСТО|ГРАЖД|ОРГАН|ВЫДАН|СЕРИЯ|НОМЕР|ПОДПИС/.test(s.toUpperCase())
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
