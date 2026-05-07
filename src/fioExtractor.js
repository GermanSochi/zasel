/**
 * FIO Extractor — Full OCR + Dictionary + Fuzzy Matching
 *
 * Стратегии (по убыванию приоритета):
 * 1. Label-anchors (ФАМИЛИЯ/ИМЯ/ОТЧЕСТВО) → берём слово рядом с меткой
 *    — если слово есть в словаре (fuzzy): высокий confidence
 *    — если нет в словаре: всё равно берём (редкие/кавказские/CIS имена)
 * 2. Fuzzy scan всех слов по словарю (для паспортов без видимых меток)
 * 3. Suffix-анализ для отчеств
 */

const DICT_URL = '/zasel/dict/fio.json'
const MAX_DIST = 2    // Levenshtein для fuzzy match
const MIN_LEN  = 3    // мин длина слова-кандидата
const MAX_LEN  = 30   // макс (защита от watermarks)

// dist=99 означает «слово найдено рядом с меткой, но не в словаре»
const DIST_NO_DICT = 99

let _dict = null

export async function loadDict() {
  if (_dict) return _dict
  try {
    const r = await fetch(DICT_URL)
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    _dict = await r.json()
    console.log(`[Dict] ${_dict.s.length} фамилий / ${_dict.m.length} м.имён / ${_dict.f.length} ж.имён / ${(_dict.p||[]).length} отчеств`)
  } catch (e) {
    console.warn('[Dict] не загружен:', e.message)
    _dict = { s: [], m: [], f: [], p: [] }
  }
  return _dict
}

// ── Levenshtein (row-only DP) ─────────────────────────────────────────────────

export function levenshtein(a, b) {
  if (a === b) return 0
  if (!a.length) return b.length
  if (!b.length) return a.length
  // row[j] = dp[i-1][j] до начала итерации, dp[i][j] после
  let row = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let diag = row[0]   // сохраняем dp[i-1][0] как диагональ для j=1
    row[0] = i          // dp[i][0] = i (цена удалить i символов из a)
    for (let j = 1; j <= b.length; j++) {
      const old = row[j]  // dp[i-1][j] — до перезаписи
      row[j] = Math.min(
        diag + (a[i-1] === b[j-1] ? 0 : 1),  // подстановка: dp[i-1][j-1]
        old  + 1,                               // удаление:    dp[i-1][j]
        row[j-1] + 1,                           // вставка:     dp[i][j-1]
      )
      diag = old  // диагональ для j+1 = dp[i-1][j]
    }
  }
  return row[b.length]
}

// Fuzzy поиск с фильтром по длине (оптимизация)
export function fuzzyFind(word, list, maxDist = MAX_DIST) {
  if (!list?.length) return null
  const wLen = word.length
  let best = null, bestDist = maxDist + 1
  for (const entry of list) {
    if (Math.abs(entry.length - wLen) > maxDist + 1) continue
    const d = levenshtein(word, entry)
    if (d < bestDist) { best = entry; bestDist = d }
    if (bestDist === 0) break
  }
  return best !== null ? { match: best, dist: bestDist } : null
}

// ── Patronymic suffix detection ───────────────────────────────────────────────

const PAT_SUFFIXES = [
  'ОВИЧ','ЕВИЧ','ОВНА','ЕВНА','ЬИЧ','ИЧНА','ИЕВИЧ','ИЕВНА','ЬЕВИЧ','ЬЕВНА',
  'УУЛУ','КЫЗЫ',           // Кыргызские
  'ОГЛЫ','УГЛИ','УЛЛИ',    // Казахские/Узбекские
  'ЗОДА','ЗАДА','ЗАДЕ',    // Таджикские
]
// Стоячие маркеры (само слово = патроним, короче 5 букв)
const PAT_EXACT = new Set(['КЫЗЫ','УУЛУ','ОГЛЫ','УГЛИ','УЛЛИ','ЗОДА','ЗАДА','ЗАДЕ'])

export function isPatronymic(word) {
  const w = word.toUpperCase()
  return PAT_EXACT.has(w) || (w.length >= 5 && PAT_SUFFIXES.some(s => w.endsWith(s)))
}

// ── OCR text cleaning ─────────────────────────────────────────────────────────

export function cleanOcrText(text) {
  return text
    .toUpperCase()
    .replace(/([А-ЯЁ])0/g, '$1О').replace(/0([А-ЯЁ])/g, 'О$1')  // 0→О рядом с кириллицей
    .replace(/([А-ЯЁ])3/g, '$1З').replace(/3([А-ЯЁ])/g, 'З$1')  // 3→З рядом с кириллицей
    .replace(/[^А-ЯЁA-Z0-9\s\-\n\.]/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .trim()
}

// ── Label / garbage detection ─────────────────────────────────────────────────

// \b не работает для кириллицы в JS — используем lookbehind/lookahead для коротких слов
const LABEL_RE = /ДАТА|(?<![А-ЯЁ])ПОЛ(?![А-ЯЁ])|МЕСТО|ГРАЖД|ОРГАН|ВЫДАН|СЕРИЯ|НОМЕР|ПОДПИС|РОССИЙСК|ФЕДЕРАЦ|ПАСПОРТ|МВД|ФМС|МИГРАЦ|РЕСПУБЛ|ОБЛАСТН|РАЙОНН|КОММУН|МОСКВ|КАЗАХСТАН|КЫРГЫЗСТАН|ТАДЖИКИСТАН|БЕЛАРУС|УЗБЕКИСТ|РОЖДЕНИ|ЗАРЕГИС|ПРОПИС|ПРОЖИВ|СНИЛС|(?<![А-ЯЁ])ИНН(?![А-ЯЁ])/
const PLACE_RE  = /РАЙОНА|ГОРОДА|УЛИЦА|ОБЛАСТЬ|ДЕРЕВНЯ|ПОСЕЛО|АУЛА|РАЙОНА|КИШЛАК/

export function isLabel(s) {
  const u = s.toUpperCase()
  return LABEL_RE.test(u) || PLACE_RE.test(u)
}

// Кириллические слова ≥ MIN_LEN, ≤ MAX_LEN
export function cyrWords(s) {
  return (s.match(/[А-ЯЁ\-]{3,}/g) || []).filter(w => w.length >= MIN_LEN && w.length <= MAX_LEN)
}

// ── Latin (Uzbek / Kazakh Latin / etc.) support ───────────────────────────────

// Суффиксы отчеств на латинице (Узбекистан, Кыргызстан латиница)
const LATIN_PAT_EXACT    = new Set(['OGLI','QIZI','OGLU','KIZI','UULU','KYZY','ULI'])
const LATIN_PAT_SUFFIXES = ['OGLI','QIZI','OGLU','KIZI','UULU','KYZY','ULI','OVICH','EVICH','OVNA','EVNA']

export function isLatinPatronymic(word) {
  const w = word.toUpperCase()
  return LATIN_PAT_EXACT.has(w) || (w.length >= 5 && LATIN_PAT_SUFFIXES.some(s => w.endsWith(s)))
}

// Латинские метки-мусор (заголовки полей в паспорте)
const LATIN_LABEL_RE = /FAMILIY|SURNAME|GIVEN\s*NAME|PATRONY|FATHER|ISMI|OTASIN|BIRTH|DATE|PLACE|GENDER|SEX\b|NATIONALITY|DOCUMENT|PASSPORT|REPUBLIC|MINISTRY|ISSUED|VALID/i

export function isLatinLabel(s) {
  return LATIN_LABEL_RE.test(s)
}

// Латинские слова ≥ MIN_LEN, ≤ MAX_LEN
export function latinWords(s) {
  return (s.match(/[A-Z\-]{3,}/g) || []).filter(w => w.length >= MIN_LEN && w.length <= MAX_LEN && !isLatinLabel(w))
}

// Определить преобладающий язык текста
function detectLang(text) {
  const cyr = (text.match(/[А-ЯЁа-яё]/g) || []).length
  const lat = (text.match(/[A-Za-z]/g) || []).length
  return (lat > cyr + 5 && lat > 8) ? 'latin' : 'cyrillic'
}

// Извлечение ФИО из латинского текста (позиционная стратегия)
function extractFIOLatin(lines) {
  // Убираем строки с метками
  const wordLines = []
  for (const line of lines) {
    const words = latinWords(line)
    if (words.length > 0 && !isLatinLabel(line)) wordLines.push(words)
  }

  let surname = '', name = '', patronymic = ''

  // Сначала ищем слово с суффиксом отчества
  let patLine = -1
  for (let i = 0; i < wordLines.length; i++) {
    const pw = wordLines[i].find(w => isLatinPatronymic(w))
    if (pw) { patronymic = toTitle(pw); patLine = i; break }
  }

  // Остальные строки: первая = фамилия, вторая = имя
  const nonPat = wordLines.filter((_, i) => i !== patLine)
  if (nonPat[0]?.length) surname = toTitle(nonPat[0][0])
  if (nonPat[1]?.length) name    = toTitle(nonPat[1][0])

  // Если нашли только 1 строку без отчества — это может быть "SURNAME GIVENNAME"
  if (!name && nonPat[0]?.length >= 2) name = toTitle(nonPat[0][1])

  const confidence = Math.round(
    (+(surname.length > 2) * 40 + +(name.length > 2) * 35 + +(patronymic.length > 2) * 25)
  )
  return { surname, name, patronymic, confidence, lang: 'latin' }
}

// ── Main extraction ───────────────────────────────────────────────────────────

export async function extractFIO(rawText) {
  const dict    = await loadDict()
  const cleaned = cleanOcrText(rawText)
  const lines   = cleaned.split('\n').map(l => l.trim()).filter(Boolean)

  // Если текст преимущественно латинский — используем Latin-стратегию
  if (detectLang(cleaned) === 'latin') {
    console.log('[FIO] Latin mode')
    const r = extractFIOLatin(lines)
    return { ...r, debug: { strategy: 'latin', cleaned, candidates: [] } }
  }

  const debug = { cleaned, candidates: [], anchors: {}, strategy: 'scan' }

  let surname = '', name = '', patronymic = ''
  let surnameScore = 0, nameScore = 0, patronymicScore = 0

  // ── Стратегия 1: Label anchors ────────────────────────────────────────────
  // Принцип: если нашли метку ФАМИЛИЯ/ИМЯ/ОТЧЕСТВО — берём ближайшее
  // кириллическое слово ВСЕГДА, даже если его нет в словаре.

  for (let i = 0; i < lines.length; i++) {
    const u = lines[i]

    // ФАМИЛИЯ
    if (!surname && /ФАМИЛИ/.test(u)) {
      const hit = wordNearLabel(lines, i, 'ФАМИЛИ', dict.s)
      if (hit) {
        surname = toTitle(hit.word)
        surnameScore = anchorScore(hit.dist)
        debug.anchors.surname = hit
        debug.strategy = 'anchor'
        console.log(`[FIO] ФАМИЛИЯ anchor: "${hit.word}" dist=${hit.dist}`)
      }
    }

    // ИМЯ (не ФАМИЛИЯ) — \b не работает для кириллицы, используем lookahead/lookbehind
    if (!name && /(?<![А-ЯЁ])ИМЯ(?![А-ЯЁ])/.test(u) && !/ФАМИЛИ/.test(u)) {
      const nameDict = [...dict.m, ...dict.f]
      // Исключаем уже найденную фамилию из кандидатов
      const excludeForName = new Set(surname ? [surname.toUpperCase()] : [])
      const hit = wordNearLabel(lines, i, 'ИМЯ', nameDict, excludeForName)
      if (hit) {
        name = toTitle(hit.word)
        nameScore = anchorScore(hit.dist)
        debug.anchors.name = hit
        debug.strategy = 'anchor'
        console.log(`[FIO] ИМЯ anchor: "${hit.word}" dist=${hit.dist}`)
      }
    }

    // ОТЧЕСТВО
    if (!patronymic && /ОТЧЕСТВ/.test(u)) {
      const words  = wordsNearLine(lines, i)
      const surU   = surname.toUpperCase()
      const nameU  = name.toUpperCase()
      // Предпочитаем слово с суффиксом отчества
      const patro  = words.find(w => w !== surU && w !== nameU && isPatronymic(w))
                  || words.find(w => w !== surU && w !== nameU && !isLabel(w) && w.length >= 5)
      if (patro) {
        // Уточняем через словарь если есть
        const dictHit = dict.p?.length ? fuzzyFind(patro, dict.p, MAX_DIST + 1) : null
        patronymic     = toTitle(dictHit ? dictHit.match : patro)
        patronymicScore = isPatronymic(patro) ? 0.9 : 0.6
        debug.anchors.patronymic = { word: patro, dict: dictHit?.match }
        debug.strategy = 'anchor'
        console.log(`[FIO] ОТЧЕСТВО anchor: "${patro}"`)
      }
    }
  }

  // ── Стратегия 2: Fuzzy scan (когда метки не видны) ───────────────────────

  // Собираем все слова, не являющиеся мусором
  const allWords = []
  for (let li = 0; li < lines.length; li++) {
    if (isLabel(lines[li])) continue
    for (const w of cyrWords(lines[li])) {
      allWords.push({ w, li })
    }
  }
  debug.candidates = allWords.map(x => x.w)

  // Фамилия по словарю
  if (!surname && dict.s.length) {
    let best = null, bestScore = 0
    for (const { w } of allWords) {
      const hit = fuzzyFind(w, dict.s)
      if (!hit) continue
      const sc = distToScore(hit.dist)
      if (sc > bestScore) { best = { word: hit.match, dist: hit.dist }; bestScore = sc }
    }
    if (best && bestScore >= 0.5) {
      surname = toTitle(best.word); surnameScore = bestScore
    }
  }

  // Имя по словарю (исключаем уже найденную фамилию)
  if (!name && (dict.m.length || dict.f.length)) {
    const surU = surname.toUpperCase()
    let best = null, bestScore = 0
    for (const { w } of allWords) {
      if (w === surU) continue
      const mH = fuzzyFind(w, dict.m)
      const fH = fuzzyFind(w, dict.f)
      const hit = pickBetter(mH, fH)
      if (!hit) continue
      const sc = distToScore(hit.dist)
      if (sc > bestScore) { best = { word: hit.match, dist: hit.dist }; bestScore = sc }
    }
    if (best && bestScore >= 0.5) {
      name = toTitle(best.word); nameScore = bestScore
    }
  }

  // Отчество: словарь → суффикс → позиция
  if (!patronymic) {
    const surU  = surname.toUpperCase()
    const nameU = name.toUpperCase()

    // Сначала словарь отчеств
    if (dict.p?.length) {
      let best = null, bestScore = 0
      for (const { w } of allWords) {
        if (w === surU || w === nameU) continue
        const hit = fuzzyFind(w, dict.p)
        if (!hit) continue
        const sc = distToScore(hit.dist)
        if (sc > bestScore) { best = { word: hit.match, dist: hit.dist }; bestScore = sc }
      }
      if (best && bestScore >= 0.4) {
        patronymic = toTitle(best.word); patronymicScore = bestScore
      }
    }

    // Суффикс-анализ
    if (!patronymic) {
      for (const { w } of allWords) {
        if (w === surU || w === nameU) continue
        if (isPatronymic(w)) {
          patronymic = toTitle(w); patronymicScore = 0.8; break
        }
      }
    }
  }

  // ── Стратегия 4: Позиционная (viewport OCR — мало слов, нет меток) ──────────
  // Когда пользователь навёлся на нужную область: первая строка=фамилия, вторая=имя, третья=отчество
  if (!surname && debug.strategy === 'scan' && allWords.length >= 1 && allWords.length <= 8) {
    const lineGroups = []
    let prevLi = -1
    for (const { w, li } of allWords) {
      if (li !== prevLi) { lineGroups.push({ li, words: [] }); prevLi = li }
      lineGroups[lineGroups.length - 1].words.push(w)
    }
    const patG = lineGroups.findIndex(g => g.words.some(w => isPatronymic(w)))
    const nonPatLines = lineGroups.filter((_, i) => i !== patG)
    if (!patronymic && patG >= 0) {
      const pw = lineGroups[patG].words.find(w => isPatronymic(w))
      patronymic = toTitle(pw); patronymicScore = 0.75
    }
    if (!surname && nonPatLines.length >= 1) {
      surname = toTitle(nonPatLines[0].words[0]); surnameScore = 0.4; debug.strategy = 'positional'
    }
    if (!name && nonPatLines.length >= 2) {
      name = toTitle(nonPatLines[1].words[0]); nameScore = 0.35
    }
  }

  // Confidence
  const confidence = Math.round(((surnameScore + nameScore + patronymicScore) / 3) * 100)
  debug.result = { surname, name, patronymic, confidence }

  return { surname, name, patronymic, confidence, debug }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Ищет слово рядом с меткой.
 * Возвращает { word, dist, line } где dist=DIST_NO_DICT если не в словаре.
 * НЕ возвращает null когда слово найдено рядом с меткой — всегда берём.
 */
function wordNearLabel(lines, anchorIdx, labelToken, dict, excludeWords = new Set()) {
  const candidates = []

  // 1. Слова на той же строке ПОСЛЕ метки
  const labelPos = lines[anchorIdx].indexOf(labelToken)
  if (labelPos >= 0) {
    const after = lines[anchorIdx].slice(labelPos + labelToken.length)
    for (const w of cyrWords(after)) {
      if (!isLabel(w) && !excludeWords.has(w)) candidates.push({ w, priority: 0 })
    }
  }

  // 2. Соседние строки (±1, ±2, ±3)
  for (const delta of [1, -1, 2, -2, 3, -3]) {
    const j = anchorIdx + delta
    if (j < 0 || j >= lines.length) continue
    if (isLabel(lines[j])) continue
    for (const w of cyrWords(lines[j])) {
      if (!isLabel(w) && !excludeWords.has(w)) candidates.push({ w, priority: Math.abs(delta) })
    }
  }

  if (!candidates.length) return null

  // Сортируем: сначала близкие к метке, длинные (имена обычно ≥5 букв)
  candidates.sort((a, b) => a.priority - b.priority || b.w.length - a.w.length)

  // Пробуем найти лучший match в словаре среди всех кандидатов
  if (dict.length) {
    let best = null, bestDist = MAX_DIST + 2, bestWord = null
    for (const { w } of candidates.slice(0, 8)) {  // проверяем первые 8
      const hit = fuzzyFind(w, dict, MAX_DIST + 1)
      if (hit && hit.dist < bestDist) {
        bestDist = hit.dist; best = hit; bestWord = w
      }
    }
    if (best && bestDist <= MAX_DIST) {
      return { word: best.match, dist: best.dist, rawWord: bestWord }
    }
  }

  // Нет совпадения в словаре → берём лучший кандидат по позиции
  // (редкие/кавказские/CIS имена которых нет в базе)
  const best = candidates[0]
  return { word: best.w, dist: DIST_NO_DICT, rawWord: best.w }
}

function wordsNearLine(lines, anchorIdx) {
  const result = []
  for (const delta of [0, 1, -1, 2, -2]) {
    const j = anchorIdx + delta
    if (j < 0 || j >= lines.length) continue
    result.push(...cyrWords(lines[j]))
  }
  return result
}

function pickBetter(a, b) {
  if (!a && !b) return null
  if (!a) return b
  if (!b) return a
  return a.dist <= b.dist ? a : b
}

function distToScore(dist) {
  if (dist === 0) return 1.0
  if (dist === 1) return 0.75
  if (dist === 2) return 0.5
  return 0.25
}

function anchorScore(dist) {
  if (dist === DIST_NO_DICT) return 0.55   // нет в словаре, но рядом с меткой → ok
  return Math.min(1.0, distToScore(dist) + 0.2)
}

function toTitle(s) {
  if (!s) return ''
  const u = s.toUpperCase()
  return u[0] + u.slice(1).toLowerCase()
}
