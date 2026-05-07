/**
 * Парсинг и валидация документов.
 *
 * MRZ-first стратегия (ICAO 9303):
 *  - Если MRZ найдена и check-digit валиден → фамилия / имя / ДР из неё
 *  - Отчество — всегда визуально (его нет в MRZ как отдельного поля в РФ)
 *  - Визуальный парсинг используется как fallback и для доп. полей
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export type DocumentType = 'passport_rf' | 'international_passport' | 'id_card' | 'unknown'

export interface DocumentData {
  documentType: DocumentType
  /** Фамилия */
  surname: string
  /** Имя */
  name: string
  /** Отчество (только в РФ-документах) */
  patronymic: string
  /** Дата рождения DD.MM.YYYY */
  dateOfBirth: string
  /** М / Ж / M / F / '' */
  gender: string
  /** Серия + номер */
  documentNumber: string
  /** Дата выдачи DD.MM.YYYY */
  issuedDate: string
  /** Срок действия DD.MM.YYYY */
  expiryDate: string
  /** Код гражданства (ISO 3166-1 alpha-3) */
  citizenship: string
  /** Место рождения (если распознано визуально) */
  placeOfBirth: string
  /** MRZ прошла проверку контрольных цифр */
  mrzValid: boolean
  /** Сырые строки MRZ */
  mrzLine1?: string
  mrzLine2?: string
  /** 0–100 */
  confidence: number
  /** Полный OCR-текст для дебага */
  rawOcr?: string
}

// ── Constants ─────────────────────────────────────────────────────────────────

const MIN_AGE = 14
const MAX_AGE = 100

// ── MRZ Parser (ICAO 9303 Type P) ─────────────────────────────────────────────

/**
 * Ищет две строки MRZ в тексте, нормализует, валидирует, извлекает поля.
 */
export function parseMRZ(rawText: string): Partial<DocumentData> {
  const lines = rawText
    .split('\n')
    .map(normalizeMrzLine)
    .filter(l => l.length >= 30)

  let line1 = '', line2 = ''
  for (const l of lines) {
    // Line 1: P + subtype(1) + country(3) + name(39)
    if (!line1 && /^P[A-Z<][A-Z]{3}/.test(l) && l.length >= 40)
      line1 = l.padEnd(44, '<').slice(0, 44)
    // Line 2: docNum(9) + check(1) + country(3) + dob(6) + check(1) + sex(1) + expiry(6) + check(1) + optional(14) + check(1)
    if (!line2 && /^[A-Z0-9]{9}[0-9][A-Z]{3}[0-9]{6}/.test(l) && l.length >= 40)
      line2 = l.padEnd(44, '<').slice(0, 44)
  }

  if (!line1 || !line2) return {}

  // Контрольные цифры ICAO 9303
  const docNumOk = checkDigit(line2.slice(0, 9),  line2[9])
  const dobOk    = checkDigit(line2.slice(13, 19), line2[19])
  const expiryOk = checkDigit(line2.slice(21, 27), line2[27])
  const mrzValid = dobOk // минимальное условие: дата рождения валидна

  const result: Partial<DocumentData> = {
    documentType: 'international_passport',
    mrzValid,
    mrzLine1: line1,
    mrzLine2: line2,
    confidence: [docNumOk, dobOk, expiryOk].filter(Boolean).length * 33,
  }

  // Поле имён: idx 5–43 → SURNAME<<FIRSTNAME<PATRONYMIC<<<...
  const nameField = line1.slice(5, 44)
  const sepIdx    = nameField.indexOf('<<')
  if (sepIdx !== -1) {
    result.surname    = toTitle(mrzToCyrillic(nameField.slice(0, sepIdx).replace(/</g, '')))
    const given       = nameField.slice(sepIdx + 2).split('<').filter(Boolean)
    result.name       = given[0] ? toTitle(mrzToCyrillic(given[0])) : ''
    result.patronymic = given[1] ? toTitle(mrzToCyrillic(given[1])) : ''
  }

  // Пол: idx 20
  const gChar = line2[20]
  result.gender = gChar === 'M' ? 'M' : gChar === 'F' ? 'F' : ''

  // Гражданство: idx 10–12
  result.citizenship = line2.slice(10, 13).replace(/</g, '')

  // ДР: idx 13–18, формат YYMMDD
  if (dobOk) {
    const d = parseMrzDate(line2.slice(13, 19), true)
    if (d && isValidDOB(d)) result.dateOfBirth = d
  }

  // Срок действия: idx 21–26
  if (expiryOk) result.expiryDate = parseMrzDate(line2.slice(21, 27), false)

  // Номер документа: idx 0–8
  if (docNumOk) result.documentNumber = line2.slice(0, 9).replace(/</g, '')

  return result
}

// ── Russian Passport Visual Parser ────────────────────────────────────────────

/**
 * Парсинг российского паспорта (внутренний) по визуальному тексту.
 * Используется как основной для РФ-паспорта или как fallback для загранпаспорта.
 */
export function parseRussianPassport(rawText: string): Partial<DocumentData> {
  const lines  = rawText.split('\n').map(l => l.trim()).filter(Boolean)
  const result: Partial<DocumentData> = { documentType: 'passport_rf' }

  for (let i = 0; i < lines.length; i++) {
    const u = lines[i].toUpperCase()

    // ── Фамилия ──────────────────────────────────────────────────────────────
    if (!result.surname) {
      const isSurnameAnchor = u.includes('ФАМИЛИ') || /^PNRU[S<]/.test(u)
      if (isSurnameAnchor) {
        const inline = u.includes('ФАМИЛИ') ? cyrAfterLabel(lines[i], 'ФАМИЛИ') : ''
        const above  = nearestCyrAbove(lines, i)
        result.surname = toTitle(inline || above)
      }
    }

    // ── Имя + Отчество ────────────────────────────────────────────────────────
    if (!result.name && /\bИМЯ\b/.test(u) && !u.includes('ФАМИЛИ')) {
      const inline = cyrAfterLabel(lines[i], 'ИМЯ')
      const window = linesWindow(lines, i, 2).join(' ')
      const words  = cyrWords(inline || window)
      if (words.length >= 2) {
        result.name       = toTitle(words[0])
        result.patronymic = toTitle(words[1])
      } else if (words.length === 1) {
        result.name = toTitle(words[0])
      }
    }

    // ── Отчество (отдельный якорь) ────────────────────────────────────────────
    if (!result.patronymic && u.includes('ОТЧЕСТВ')) {
      result.patronymic = findPatronymic(lines, i)
    }

    // ── Дата рождения ─────────────────────────────────────────────────────────
    if (!result.dateOfBirth && /ДАТА.{0,6}РОЖ|РОЖ.{0,6}ДАТА|РОЖДЕН/.test(u)) {
      const candidate = extractValidDOB(`${lines[i]} ${lines[i + 1] ?? ''}`)
      if (candidate) result.dateOfBirth = candidate
    }

    // ── Дата выдачи ───────────────────────────────────────────────────────────
    if (!result.issuedDate && /ДАТА.{0,6}ВЫД|ВЫДАН/.test(u)) {
      const candidate = extractAnyDate(`${lines[i]} ${lines[i + 1] ?? ''}`)
      if (candidate) result.issuedDate = candidate
    }

    // ── Серия / номер ─────────────────────────────────────────────────────────
    if (!result.documentNumber && /СЕРИЯ|НОМЕР/.test(u)) {
      const m = (lines[i] + ' ' + (lines[i + 1] ?? '')).match(/\d{2}\s*\d{2}\s*\d{6}/)
      if (m) result.documentNumber = m[0].replace(/\s/g, '')
    }

    // ── Пол ───────────────────────────────────────────────────────────────────
    if (!result.gender && /\bПОЛ\b/.test(u)) {
      if (u.includes('МУЖ')) result.gender = 'М'
      else if (u.includes('ЖЕН')) result.gender = 'Ж'
    }
  }

  if (!result.dateOfBirth) result.dateOfBirth = findBestDOB(lines)
  if (!result.surname)     result.surname     = findStandaloneSurname(lines)

  return result
}

// ── Merge ─────────────────────────────────────────────────────────────────────

/**
 * Объединяет MRZ и визуальные данные.
 * MRZ имеет приоритет для core-полей; визуальный — для отчества и доп. полей.
 */
export function mergeResults(
  mrzData:    Partial<DocumentData>,
  visualData: Partial<DocumentData>,
  rawOcr?:    string,
): DocumentData {
  return {
    documentType:   mrzData.documentType   || visualData.documentType   || 'unknown',
    surname:        mrzData.surname         || visualData.surname         || '',
    name:           mrzData.name            || visualData.name            || '',
    // Отчество — предпочитаем визуальный слой; MRZ-значение — fallback
    patronymic:     visualData.patronymic   || mrzData.patronymic         || '',
    dateOfBirth:    mrzData.dateOfBirth     || visualData.dateOfBirth     || '',
    gender:         mrzData.gender          || visualData.gender          || '',
    documentNumber: mrzData.documentNumber  || visualData.documentNumber  || '',
    issuedDate:     visualData.issuedDate   || '',
    expiryDate:     mrzData.expiryDate      || '',
    citizenship:    mrzData.citizenship     || '',
    placeOfBirth:   visualData.placeOfBirth || '',
    mrzValid:       mrzData.mrzValid ?? false,
    mrzLine1:       mrzData.mrzLine1,
    mrzLine2:       mrzData.mrzLine2,
    confidence:     Math.max(mrzData.confidence ?? 0, visualData.confidence ?? 0),
    rawOcr,
  }
}

// ── MRZ helpers ───────────────────────────────────────────────────────────────

function normalizeMrzLine(raw: string): string {
  return raw.toUpperCase().replace(/\s+/g, '<').replace(/[^A-Z0-9<]/g, '<')
}

/** Алгоритм контрольной цифры ICAO 9303 (весa 7-3-1) */
function checkDigit(s: string, expected: string): boolean {
  const W = [7, 3, 1]
  const val = (c: string): number => {
    if (c === '<') return 0
    if (c >= '0' && c <= '9') return +c
    return c.charCodeAt(0) - 55  // A=10, B=11…
  }
  const sum = s.split('').reduce((acc, c, i) => acc + val(c) * W[i % 3], 0)
  return (sum % 10) === +expected
}

function parseMrzDate(yymmdd: string, isDOB: boolean): string {
  if (!/^\d{6}$/.test(yymmdd)) return ''
  const yy   = parseInt(yymmdd.slice(0, 2))
  const mm   = yymmdd.slice(2, 4)
  const dd   = yymmdd.slice(4, 6)
  let yyyy: number
  if (isDOB) {
    // 2000+yy > currentYear+1 — явно будущее → это 1900-е
    const candidate = 2000 + yy
    yyyy = candidate > new Date().getFullYear() + 1 ? 1900 + yy : candidate
  } else {
    // Срок действия: всегда 2000+yy (после 2000)
    yyyy = 2000 + yy
  }
  return `${dd}.${mm}.${yyyy}`
}

// Транслитерация MRZ (лат.) → Кириллица по ГОСТ Р 52535.2-2006
const MRZ_MAP: [string, string][] = [
  ['SHCH', 'Щ'], ['ZHH', 'Ж'], ['KHH', 'Х'],
  ['ZH', 'Ж'], ['KH', 'Х'], ['TS', 'Ц'], ['TC', 'Ц'],
  ['CH', 'Ч'], ['SH', 'Ш'], ['IE', 'Ъ'], ['IU', 'Ю'],
  ['IA', 'Я'], ['JO', 'Ё'], ['YO', 'Ё'], ['YU', 'Ю'], ['YA', 'Я'],
  ['A', 'А'], ['B', 'Б'], ['V', 'В'], ['G', 'Г'], ['D', 'Д'], ['E', 'Е'],
  ['Z', 'З'], ['I', 'И'], ['J', 'Й'], ['K', 'К'], ['L', 'Л'], ['M', 'М'],
  ['N', 'Н'], ['O', 'О'], ['P', 'П'], ['R', 'Р'], ['S', 'С'], ['T', 'Т'],
  ['U', 'У'], ['F', 'Ф'], ['H', 'Х'], ['C', 'Ц'], ['Y', 'Ы'],
]

function mrzToCyrillic(s: string): string {
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

// ── Visual helpers ────────────────────────────────────────────────────────────

function findPatronymic(lines: string[], anchorIdx: number): string {
  // 1. Inline: текст на той же строке после слова "Отчество"
  const inline = cyrAfterLabel(lines[anchorIdx], 'ОТЧЕСТВ')
  if (inline) {
    const w = cyrWords(inline)[0]
    if (w) return toTitle(w)
  }
  // 2. Строки ±1, ±2 от якоря
  for (const delta of [-1, 1, -2, 2]) {
    const j = anchorIdx + delta
    if (j < 0 || j >= lines.length) continue
    const t = lines[j].trim().toUpperCase()
    if (/^[А-ЯЁ\-]{3,}$/.test(t) && !isLabel(lines[j]))
      return toTitle(t)
    const words = cyrWords(lines[j])
    if (words.length === 1 && !isLabel(lines[j]))
      return toTitle(words[0])
  }
  return ''
}

function nearestCyrAbove(lines: string[], anchor: number): string {
  for (let j = anchor - 1; j >= Math.max(0, anchor - 2); j--) {
    const t = lines[j].trim().toUpperCase()
    if (/^[А-ЯЁ\-]{4,}$/.test(t) && !isLabel(lines[j])) return t
  }
  return ''
}

function cyrAfterLabel(line: string, label: string): string {
  if (!label) return ''
  const idx = line.toUpperCase().indexOf(label)
  if (idx === -1) return ''
  return cyrWords(line.slice(idx + label.length)).join(' ')
}

function cyrWords(s: string): string[] {
  return (s.match(/[А-ЯЁа-яё\-]{2,}/g) ?? []).map(w => w.toUpperCase())
}

function linesWindow(lines: string[], idx: number, r: number): string[] {
  const out: string[] = []
  for (let j = Math.max(0, idx - r); j <= Math.min(lines.length - 1, idx + r); j++) {
    if (j !== idx) out.push(lines[j])
  }
  return out
}

// ── Date helpers ──────────────────────────────────────────────────────────────

function isValidDOB(dateStr: string): boolean {
  const parts = dateStr.split('.')
  if (parts.length !== 3) return false
  const year = parseInt(parts[2])
  if (isNaN(year)) return false
  const age = new Date().getFullYear() - year
  return age >= MIN_AGE && age <= MAX_AGE
}

function extractDateFromText(text: string, filter: (d: string) => boolean): string {
  const cleaned = text.replace(/[ОоOо]/g, '0')
  const re      = /\d{1,2}[.\s–\-\/]\d{1,2}[.\s–\-\/]\d{4}/g
  let m: RegExpExecArray | null
  while ((m = re.exec(cleaned)) !== null) {
    const d = m[0].replace(/[\s–\-\/]/g, '.')
    if (filter(d)) return d
  }
  return ''
}

function extractValidDOB(text: string): string {
  return extractDateFromText(text, isValidDOB)
}

function extractAnyDate(text: string): string {
  return extractDateFromText(text, () => true)
}

function findBestDOB(lines: string[]): string {
  for (const l of lines) {
    const d = extractValidDOB(l)
    if (d) return d
  }
  return ''
}

function findStandaloneSurname(lines: string[]): string {
  for (const line of lines) {
    const t = line.trim(), u = t.toUpperCase()
    if (u.length >= 4 && u.length <= 25 && /^[А-ЯЁ\-]+$/.test(u) && !isLabel(t))
      return toTitle(u)
  }
  return ''
}

function isLabel(s: string): boolean {
  return /ДАТА|ПОЛ\b|МЕСТО|ГРАЖД|ОРГАН|ВЫДАН|СЕРИЯ|НОМЕР|ПОДПИС|РОССИЙСК|ФЕДЕРАЦ|ПАСПОРТ|МВД|ФМС|МИГРАЦ/.test(
    s.toUpperCase()
  )
}

function toTitle(s: string): string {
  if (!s) return ''
  const u = s.toUpperCase()
  return u[0] + u.slice(1).toLowerCase()
}
