import { createWorker } from 'tesseract.js'

let _worker = null
let _workerReady = false

async function getWorker(onProgress) {
  if (_worker && _workerReady) return _worker

  _worker = await createWorker('rus', 1, {
    logger: (m) => {
      if (onProgress && m.status === 'recognizing text') {
        onProgress(Math.round(m.progress * 100))
      }
    },
  })
  _workerReady = true
  return _worker
}

/**
 * Распознаёт данные паспорта через Tesseract.js (браузерный OCR, без API ключа).
 * Возвращает { surname, name, patronymic, dob }
 * onProgress(0..100) — колбэк прогресса
 */
export async function extractPassportData(imageDataUrl, onProgress) {
  onProgress?.(5)
  const worker = await getWorker(onProgress)
  const { data: { text } } = await worker.recognize(imageDataUrl)
  onProgress?.(100)
  return parsePassportText(text)
}

// ── Парсинг текста паспорта ────────────────────────────────────────────────

function parsePassportText(raw) {
  const lines = raw
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)

  let surname = ''
  let name = ''
  let patronymic = ''
  let dob = ''

  for (let i = 0; i < lines.length; i++) {
    const cur = lines[i]
    const curU = cur.toUpperCase()
    const next = lines[i + 1] || ''
    const next2 = lines[i + 2] || ''

    // ── ФАМИЛИЯ ──
    if (/ФАМИЛИ/.test(curU) || /SURNAME/.test(curU)) {
      const v = firstCyrillicWord(next)
      if (v.length >= 2) surname = v
    }

    // ── ИМЯ / ИМЯ ОТЧЕСТВО ──
    if (/^ИМЯ/.test(curU) || /^NAME/.test(curU)) {
      const parts = cyrillicWords(next)
      if (parts.length >= 2) {
        ;[name, patronymic] = parts
      } else if (parts.length === 1) {
        name = parts[0]
        const p2 = firstCyrillicWord(next2)
        if (p2.length >= 3 && !isLabel(next2)) patronymic = p2
      }
    }

    // ── ОТЧЕСТВО (отдельный лейбл) ──
    if (/^ОТЧЕСТВ/.test(curU) || /^PATRONYMIC/.test(curU)) {
      if (!patronymic) {
        const v = firstCyrillicWord(next)
        if (v.length >= 2) patronymic = v
      }
    }

    // ── ДАТА РОЖДЕНИЯ ──
    if (/ДАТА.{0,5}РОЖ/.test(curU) || /DATE.{0,5}BIRTH/.test(curU)) {
      dob = findDate(next) || findDate(cur) || dob
    }

    // Подхватываем дату в строке с "РОЖДЕН"
    if (/РОЖДЕН/.test(curU) && !dob) {
      dob = findDate(cur) || findDate(next) || dob
    }
  }

  // Fallback: если дату не нашли по лейблу — ищем первую дату в тексте
  if (!dob) {
    for (const l of lines) {
      const d = findDate(l)
      if (d) { dob = d; break }
    }
  }

  return {
    surname: toTitle(surname),
    name: toTitle(name),
    patronymic: toTitle(patronymic),
    dob,
  }
}

function firstCyrillicWord(str) {
  const m = str.match(/[А-ЯЁа-яё][А-ЯЁа-яё\-]+/)
  return m ? m[0].toUpperCase() : ''
}

function cyrillicWords(str) {
  return (str.match(/[А-ЯЁа-яё\-]+/g) || [])
    .map(w => w.toUpperCase())
    .filter(w => w.length >= 2)
}

function findDate(str) {
  // DD.MM.YYYY or DD MM YYYY or DD-MM-YYYY, also OCR mixes О/0
  const clean = str.replace(/[ОоOо]/g, '0')
  const m = clean.match(/\d{1,2}[\.\s\-]\d{1,2}[\.\s\-]\d{4}/)
  if (!m) return null
  return m[0].replace(/[\s\-]/g, '.')
}

function isLabel(str) {
  return /ДАТА|ПОЛА?|МЕСТО|ГРАЖД|ОРГАН|ВЫДАН|СЕРИЯ|НОМЕР|АДРЕС/.test(str.toUpperCase())
}

function toTitle(s) {
  if (!s) return ''
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase()
}

export function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}
