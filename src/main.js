import './style.css'
import { generateDocument } from './docx-gen.js'
import { extractPassportData, fileToDataUrl, recognizeRegion } from './ocr.js'
import { extractFIO } from './fioExtractor.js'

// ── Persistent staff list (localStorage) ─────────────────────────────────────

let staff = []

function loadStaff() {
  try { staff = JSON.parse(localStorage.getItem('zasel_staff') || '[]') } catch { staff = [] }
}
function saveStaff() {
  localStorage.setItem('zasel_staff', JSON.stringify(staff))
}
function hireEmployee(id) {
  const p = state.persons.find(x => x.id === id)
  if (!p || (!p.surname && !p.name)) { showToast('Нет данных для сохранения', 'error'); return }
  const entry = {
    sid:       Date.now() + Math.random(),
    surname:   p.surname,
    name:      p.name,
    patronymic: p.patronymic,
    phone:     p.phone || '',
    addedDate: todayISO(),
  }
  staff.push(entry)
  saveStaff()
  showToast(`${[p.surname, p.name].filter(Boolean).join(' ')} добавлен в список`, 'success')
  renderStaff()
}
function dismissEmployee(sid) {
  staff = staff.filter(s => s.sid !== sid)
  saveStaff()
  renderStaff()
}
function updateStaffPhone(sid, phone) {
  const s = staff.find(x => x.sid === sid)
  if (s) { s.phone = phone; saveStaff() }
}

loadStaff()

// ── Session state ─────────────────────────────────────────────────────────────

let nextId = 1

const state = {
  arrivalDate: todayISO(),
  persons: [],
}

function todayISO() {
  return new Date().toISOString().split('T')[0]
}

function setPerson(id, patch) {
  const idx = state.persons.findIndex(p => p.id === id)
  if (idx === -1) return
  state.persons[idx] = { ...state.persons[idx], ...patch }
  render()
}

function addPerson() {
  state.persons.push({
    id: nextId++,
    surname: '', name: '', patronymic: '',
    phone: '', specialty: 'Официант', customSpecialty: '',
    imageUrl: null, imageName: null,
    ocrStatus: 'idle', ocrError: '', ocrProgress: 0,
    rawOcr: '', showDebug: false, confidence: null, mrzDebugUrl: null,
  })
  render()
  setTimeout(() => {
    const cards = document.querySelectorAll('.person')
    cards[cards.length - 1]?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }, 50)
}

function removePerson(id) {
  viewerState.delete(id)
  state.persons = state.persons.filter(p => p.id !== id)
  render()
}

// ── OCR ───────────────────────────────────────────────────────────────────────

async function handlePassportFile(id, file) {
  if (!file) return

  const rawUrl = URL.createObjectURL(file)
  setPerson(id, {
    imageUrl:    rawUrl,
    imageName:   file.name,
    ocrStatus:   'loading',
    ocrError:    '',
    ocrProgress: 5,
    rawOcr:      '',
    confidence:  null,
    mrzDebugUrl: null,
  })

  try {
    const dataUrl = await fileToDataUrl(file)
    const result  = await extractPassportData(dataUrl, null, pct => {
      const idx = state.persons.findIndex(p => p.id === id)
      if (idx !== -1) state.persons[idx].ocrProgress = pct
      const fill  = document.querySelector(`.person[data-id="${id}"] .ocr-progress-fill`)
      const label = document.querySelector(`.person[data-id="${id}"] .ocr-loading-label`)
      if (fill) fill.style.width = `${pct}%`
      if (label) {
        const txt = pct < 40 ? 'Обработка изображения…' : pct < 80 ? 'Распознавание текста…' : 'Парсинг данных…'
        label.innerHTML = `<span class="spinner"></span>${txt}`
      }
    })

    const surname      = result.surname    || ''
    const name         = result.name       || ''
    const patronymic   = result.patronymic || ''
    const rawOcr       = result._rawOcr    || ''
    const mrzRaw       = result._mrzRaw    || ''
    const mrzFound     = result._mrzFound  || false
    const bestStrategy = result._bestStrategy || '—'
    const found        = !!(surname || name)

    const diagText = [
      `MRZ: ${mrzFound ? '✓ найдена' : '✗ не найдена'} (стратегия: ${bestStrategy})`,
      `Фамилия:    ${surname    || '—'}`,
      `Имя:        ${name       || '—'}`,
      `Отчество:   ${patronymic || '—'}`,
      '',
      `── MRZ OCR (${mrzRaw.length} симв.) ──`,
      mrzRaw.trim() || '(пусто)',
      '',
      `── Полный OCR (${rawOcr.length} симв.) ──`,
      rawOcr.trim() || '(пусто)',
    ].join('\n')

    let ocrError = ''
    if (!found) {
      ocrError = 'Не удалось распознать — используй кнопку «Читать» в просмотре'
    } else if (!mrzFound) {
      ocrError = 'Распознано визуально'
    }

    setPerson(id, {
      surname, name, patronymic,
      ocrStatus:   found ? (mrzFound ? 'done' : 'warn') : 'warn',
      ocrError,
      ocrProgress: 100,
      rawOcr:      diagText,
      showDebug:   !found,
      mrzDebugUrl: result._mrzCropDataUrl || null,
    })
  } catch (err) {
    console.error('[OCR] Исключение:', err)
    setPerson(id, {
      ocrStatus:   'error',
      ocrError:    err.message,
      ocrProgress: 0,
      rawOcr:      `Ошибка: ${err.message}\n\n${err.stack || ''}`,
      showDebug:   true,
    })
  }
}

// ── Viewport OCR ─────────────────────────────────────────────────────────────

function captureViewerViewport(id, hPct = 1.0) {
  const stage = document.getElementById(`vstage-${id}`)
  const img   = document.getElementById(`vimg-${id}`)
  if (!stage || !img) return null

  const natW = img.naturalWidth
  const natH = img.naturalHeight
  if (!natW || !natH) return null

  const stageR = stage.getBoundingClientRect()
  const imgR   = img.getBoundingClientRect()

  if (!imgR.width || !imgR.height) return null

  // Вертикальный прицел: обрезаем боковые маски по hPct
  const stageW = stageR.right - stageR.left
  const hMask  = stageW * (1 - Math.min(1, Math.max(0, hPct))) / 2
  const effL   = stageR.left + hMask
  const effR   = stageR.right - hMask

  const visL = Math.max(0, effL - imgR.left)
  const visT = Math.max(0, stageR.top - imgR.top)
  const visR = Math.min(imgR.width,  effR - imgR.left)
  const visB = Math.min(imgR.height, stageR.bottom - imgR.top)

  if (visR <= visL || visB <= visT) return null

  // imgR.width = dispW * zoom  →  натуральные пиксели = экранные * (natW / imgR.width)
  const scaleX = natW / imgR.width
  const scaleY = natH / imgR.height

  const nx0 = Math.max(0, Math.round(visL * scaleX))
  const ny0 = Math.max(0, Math.round(visT * scaleY))
  const nx1 = Math.min(natW, Math.round(visR * scaleX))
  const ny1 = Math.min(natH, Math.round(visB * scaleY))
  const cropW = nx1 - nx0
  const cropH = ny1 - ny0
  if (cropW <= 10 || cropH <= 10) return null

  console.log(`[Capture] zoom area: ${nx0},${ny0} → ${nx1},${ny1} (${cropW}×${cropH} из ${natW}×${natH})`)

  const canvas = document.createElement('canvas')
  canvas.width  = cropW
  canvas.height = cropH
  canvas.getContext('2d').drawImage(img, nx0, ny0, cropW, cropH, 0, 0, cropW, cropH)
  return canvas.toDataURL('image/png')
}

async function handleViewportOcr(id) {
  const btn = document.getElementById(`vocr-${id}`)
  if (btn) { btn.disabled = true; btn.textContent = '…' }

  const vslider = document.getElementById(`vaim-vslider-${id}`)
  const hPct = vslider ? parseFloat(vslider.value) / 100 : 1.0
  const dataUrl = captureViewerViewport(id, hPct)
  if (!dataUrl) {
    showToast('Не удалось захватить область', 'error')
    if (btn) { btn.disabled = false; btn.innerHTML = iconEye() + ' Читать' }
    return
  }

  try {
    const text = await recognizeRegion(dataUrl)
    console.log('[ViewportOCR] текст:\n' + text.slice(0, 300))
    const fio = await extractFIO(text)
    console.log('[ViewportOCR] FIO:', fio.surname, fio.name, fio.patronymic, `conf:${fio.confidence}%`)

    const patch = {}
    if (fio.surname)    patch.surname    = fio.surname
    if (fio.name)       patch.name       = fio.name
    if (fio.patronymic) patch.patronymic = fio.patronymic

    // Показываем захваченный кроп в дебаге чтобы видеть что прочиталось
    const diagLines = [
      `Кроп вручную · FIO confidence: ${fio.confidence}%`,
      `Фамилия:  ${fio.surname || '—'}`,
      `Имя:      ${fio.name || '—'}`,
      `Отчество: ${fio.patronymic || '—'}`,
      '',
      `── OCR текст (${text.length} симв.) ──`,
      text.trim().slice(0, 500) || '(пусто)',
    ].join('\n')

    if (Object.keys(patch).length) {
      setPerson(id, {
        ...patch, ocrStatus: 'warn', ocrError: 'Прочитано вручную',
        rawOcr: diagLines, mrzDebugUrl: dataUrl, showDebug: false,
      })
      showToast('ФИО распознано', 'success')
    } else {
      setPerson(id, { rawOcr: diagLines, mrzDebugUrl: dataUrl, showDebug: true })
      showToast('ФИО не найдено — наведи точнее на строки ФИО', 'error')
      if (btn) { btn.disabled = false; btn.innerHTML = iconEye() + ' Читать' }
    }
  } catch (e) {
    console.error('[ViewportOCR]', e)
    showToast('Ошибка: ' + e.message, 'error')
    if (btn) { btn.disabled = false; btn.innerHTML = iconEye() + ' Читать' }
  }
}

// ── Download ──────────────────────────────────────────────────────────────────

async function handleDownload() {
  if (!state.persons.length) { showToast('Добавь хотя бы одного сотрудника', 'error'); return }
  const filled = state.persons.map(p => ({
    ...p,
    specialty: p.specialty === '__custom__' ? p.customSpecialty : p.specialty,
  }))
  try {
    await generateDocument(filled, state.arrivalDate)
    showToast('Документ скачан', 'success')
  } catch (err) {
    showToast('Ошибка: ' + err.message, 'error')
  }
}

// ── Toast ─────────────────────────────────────────────────────────────────────

function showToast(msg, type = '') {
  const el = document.createElement('div')
  el.className = `toast${type ? ` ${type}` : ''}`
  el.textContent = msg
  document.querySelector('.toast-container')?.appendChild(el)
  setTimeout(() => { el.classList.add('hiding'); setTimeout(() => el.remove(), 350) }, 3000)
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const MONTHS = ['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря']
const DAYS   = ['Воскресенье','Понедельник','Вторник','Среда','Четверг','Пятница','Суббота']

function fmtArrival(iso) {
  if (!iso) return { display: '—', day: '' }
  const [y, m, d] = iso.split('-').map(Number)
  const date = new Date(y, m - 1, d)
  return { display: `${d} ${MONTHS[m - 1]} ${y}`, day: DAYS[date.getDay()] }
}

function fmtDate(iso) {
  if (!iso) return ''
  const [y, m, d] = iso.split('-')
  return `${d}.${m}.${y}`
}

function esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')
}

// ── Render ────────────────────────────────────────────────────────────────────

const SPECIALTIES = ['Официант', 'Кухонный работник', 'Горничная', 'Бармен', 'Администратор', 'Уборщик', '— другое —']

function render() {
  document.getElementById('root').innerHTML = buildApp()
  attachListeners()
}

function renderStaff() {
  const el = document.getElementById('staff-section')
  if (el) el.outerHTML = buildStaffSection()
  // После замены снова вешаем слушатели на staff
  attachStaffListeners()
}

function buildApp() {
  const { display, day } = fmtArrival(state.arrivalDate)
  const n     = state.persons.length
  const ready = state.persons.filter(p => p.ocrStatus === 'done').length
  const summaryText = n === 0
    ? 'Добавь сотрудников'
    : `<strong>${ready} из ${n}</strong> ${n === 1 ? 'сотрудник' : 'сотрудников'} · заселение ${display}`

  return `
    <nav class="nav">
      <div class="nav-inner">
        <div class="brand">
          <div class="brand-mark">З</div>
          <div class="brand-name">Заселение</div>
          <span class="brand-sub">ИП Калгунов · ЛесРесорт</span>
        </div>
      </div>
    </nav>

    <main class="container">
      <div class="arrival-card">
        <div>
          <div class="arrival-label">Дата прибытия</div>
          <div class="arrival-date-display">${display}</div>
          <div class="arrival-day">${day}</div>
        </div>
        <div class="date-picker-wrap">
          <input type="date" id="arrival-date" value="${state.arrivalDate}" />
        </div>
      </div>

      <div class="persons" id="persons-list">
        ${n ? state.persons.map((p, i) => buildCard(p, i)).join('') : buildEmptyState()}
      </div>

      <button class="add-card" id="btn-add">
        <span class="add-plus">${iconPlus()}</span>
        Добавить сотрудника
      </button>

      <div class="action-bar">
        <div class="action-summary">${summaryText}</div>
        <button class="btn btn-primary" id="btn-download" ${!n ? 'disabled' : ''}>
          ${iconDownload()} Скачать .docx
        </button>
      </div>

      ${n ? buildPreview() : ''}

      ${buildStaffSection()}
    </main>

    <div class="toast-container"></div>
  `
}

function buildEmptyState() {
  return `
    <div class="empty-state">
      <div class="empty-icon">🛂</div>
      <div class="empty-text">Нет сотрудников</div>
      <div class="empty-sub">Нажми «Добавить» и загрузи фото паспорта — данные распознаются офлайн</div>
    </div>
  `
}

function buildCard(p, index) {
  const hasName = p.surname || p.name
  const title   = hasName
    ? [p.surname, p.name, p.patronymic].filter(Boolean).join(' ')
    : 'Новый сотрудник'

  const badge = p.ocrStatus === 'done'
    ? `<span class="badge badge-ok"><span class="badge-dot"></span>Распознано</span>`
    : p.ocrStatus === 'warn'
    ? `<span class="badge badge-warn"><span class="badge-dot"></span>Проверить</span>`
    : p.ocrStatus === 'error'
    ? `<span class="badge badge-err"><span class="badge-dot"></span>Ошибка</span>`
    : ''

  const isCustom = p.specialty === '__custom__'
  const canHire  = !!(p.surname || p.name)

  return `
    <article class="person" data-id="${p.id}">
      <header class="person-head">
        <div class="person-id">
          <div class="person-num">${index + 1}</div>
          <div class="person-title${hasName ? '' : ' empty'}">${esc(title)}</div>
          <div class="person-badges">${badge}</div>
        </div>
        <div class="person-head-actions">
          ${canHire ? `<button class="btn-hire" data-action="hire" data-id="${p.id}" title="Добавить в список работников">${iconCheck()} В список</button>` : ''}
          <button class="remove-btn" data-action="remove" data-id="${p.id}" title="Удалить">${iconTrash()}</button>
        </div>
      </header>

      <div class="person-body">
        ${buildPassportLeft(p)}
        <div class="fields">
          <div class="field">
            <label>Фамилия</label>
            <input type="text" data-field="surname" data-id="${p.id}" value="${esc(p.surname)}" placeholder="Иванов" />
          </div>
          <div class="field">
            <label>Имя</label>
            <input type="text" data-field="name" data-id="${p.id}" value="${esc(p.name)}" placeholder="Иван" />
          </div>
          <div class="field">
            <label>Отчество</label>
            <input type="text" data-field="patronymic" data-id="${p.id}" value="${esc(p.patronymic)}" placeholder="Иванович" />
          </div>
          <div class="field">
            <label>Телефон</label>
            <input type="tel" data-field="phone" data-id="${p.id}" value="${esc(p.phone)}" placeholder="+7 999 000-00-00" />
          </div>
          <div class="field full">
            <label>Специальность</label>
            <select data-field="specialty" data-id="${p.id}">
              ${SPECIALTIES.map(s => {
                const val = s === '— другое —' ? '__custom__' : s
                return `<option value="${val}"${p.specialty === val ? ' selected' : ''}>${s}</option>`
              }).join('')}
            </select>
            ${isCustom ? `
              <input class="specialty-custom" type="text"
                data-field="customSpecialty" data-id="${p.id}"
                value="${esc(p.customSpecialty)}"
                placeholder="Введи специальность…" />
            ` : ''}
          </div>
        </div>
      </div>

      ${p.imageUrl ? buildViewer(p) : ''}
      ${p.rawOcr   ? buildDebug(p)  : ''}
    </article>
  `
}

// ── Passport left column ──────────────────────────────────────────────────────

function buildPassportLeft(p) {
  if (p.ocrStatus === 'loading') {
    const pct   = p.ocrProgress || 0
    const label = pct < 40 ? 'Обработка изображения…' : pct < 80 ? 'Распознавание текста…' : 'Парсинг данных…'
    return `
      <div>
        <div class="ocr-loading">
          <div class="ocr-loading-label"><span class="spinner"></span>${label}</div>
          <div class="ocr-progress-bar"><div class="ocr-progress-fill" style="width:${pct}%"></div></div>
        </div>
        <input type="file" accept="image/*" data-action="file" data-id="${p.id}" id="file-${p.id}" style="display:none" />
      </div>
    `
  }

  if (p.imageUrl) {
    return `
      <div>
        <div class="passport-preview">
          <img src="${p.imageUrl}" alt="паспорт" />
          <div class="passport-overlay">
            <span>${esc(p.imageName || '')}</span>
            <button class="reupload-btn" data-action="reupload" data-id="${p.id}">Заменить</button>
          </div>
        </div>
        <input type="file" accept="image/*" data-action="file" data-id="${p.id}" id="file-${p.id}" style="display:none" />
      </div>
    `
  }

  return `
    <label class="passport-zone" for="file-${p.id}">
      <div class="pz-icon">
        <svg width="22" height="22" viewBox="0 0 22 22" fill="none">
          <rect x="2" y="5" width="18" height="14" rx="2" stroke="currentColor" stroke-width="1.5"/>
          <circle cx="11" cy="12" r="3" stroke="currentColor" stroke-width="1.5"/>
          <path d="M7 5l1.5-2h5L15 5" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>
        </svg>
      </div>
      <div class="pz-label">Загрузить паспорт</div>
      <div class="pz-sub">Перетащите фото<br/>или нажмите для съёмки</div>
      <input type="file" accept="image/*" capture="environment"
        data-action="file" data-id="${p.id}" id="file-${p.id}" />
    </label>
  `
}

// ── Viewer ────────────────────────────────────────────────────────────────────

function buildViewer(p) {
  return `
    <div class="passport-viewer" id="viewer-${p.id}">
      <div class="viewer-toolbar">
        <span class="viewer-title">Сверка документа</span>
        <div class="viewer-controls">
          <button class="viewer-btn" id="vout-${p.id}" title="Уменьшить">−</button>
          <span class="viewer-zoom" id="vzoom-${p.id}">100%</span>
          <button class="viewer-btn" id="vin-${p.id}" title="Увеличить">+</button>
          <button class="viewer-btn" id="vreset-${p.id}" title="По размеру">⊡</button>
          <div class="viewer-sep"></div>
          <button class="viewer-ocr-btn" id="vocr-${p.id}" title="Нажми, наведи на ФИО и подтверди. Можно повторить.">${iconEye()} Читать</button>
        </div>
      </div>
      <div class="viewer-stage" id="vstage-${p.id}">
        <img class="viewer-img" id="vimg-${p.id}" src="${p.imageUrl}" alt="паспорт" draggable="false" />
        <div class="viewer-hint">Колесо мыши — зум · Перетащи для панорамирования · 2× клик — сброс</div>
      </div>
    </div>
  `
}

// ── Debug panel ───────────────────────────────────────────────────────────────

function buildDebug(p) {
  const mrzImg = p.mrzDebugUrl && p.showDebug ? `
    <div class="debug-img-label">Кроп MRZ (вход в Tesseract):</div>
    <img src="${p.mrzDebugUrl}" style="width:100%;border-radius:6px;image-rendering:pixelated;background:#000" alt="MRZ кроп" />
  ` : ''
  return `
    <div class="ocr-debug">
      <button class="ocr-debug-toggle" data-action="toggle-debug" data-id="${p.id}">
        ${p.showDebug ? '▲ Скрыть диагностику' : '▼ Показать диагностику OCR'}
      </button>
      ${p.showDebug ? `${mrzImg}<pre class="ocr-debug-text">${esc(p.rawOcr)}</pre>` : ''}
    </div>
  `
}

// ── Staff section ─────────────────────────────────────────────────────────────

function buildStaffSection() {
  const active = staff
  return `
    <section class="staff-section" id="staff-section">
      <div class="staff-header">
        <h2 class="staff-title">Работники на месте</h2>
        ${active.length ? `<span class="staff-count">${active.length}</span>` : ''}
      </div>
      ${active.length ? `
        <div class="staff-list">
          ${active.map(s => buildStaffRow(s)).join('')}
        </div>
      ` : `
        <div class="staff-empty">Список пуст — добавь сотрудников кнопкой «В список» на карточке</div>
      `}
    </section>
  `
}

function buildStaffRow(s) {
  const fio = [s.surname, s.name, s.patronymic].filter(Boolean).join(' ')
  return `
    <div class="staff-row" data-sid="${s.sid}">
      <div class="staff-fio">${esc(fio || '—')}</div>
      <div class="staff-phone-wrap">
        <input class="staff-phone" type="tel" placeholder="+7 999 000-00-00"
          value="${esc(s.phone)}" data-sid="${s.sid}" />
        <button class="btn-save-phone" data-action="save-phone" data-sid="${s.sid}" title="Сохранить телефон">✓</button>
      </div>
      <button class="btn-dismiss" data-action="dismiss" data-sid="${s.sid}" title="Уволить">
        ${iconDismiss()} Уволить
      </button>
    </div>
  `
}

// ── Preview table ─────────────────────────────────────────────────────────────

function buildPreview() {
  return `
    <section class="preview">
      <div class="preview-head">
        <h2>Предпросмотр документа</h2>
        <span class="preview-count">${state.persons.length} ${state.persons.length === 1 ? 'строка' : 'строк'}</span>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>№</th><th>Фамилия</th><th>Имя</th>
              <th>Отчество</th><th>Дата прибытия</th><th>Специальность</th>
            </tr>
          </thead>
          <tbody>
            ${state.persons.map((p, i) => {
              const spec = p.specialty === '__custom__' ? p.customSpecialty : p.specialty
              const hasData = p.surname || p.name
              return `<tr>
                <td class="td-num">${i + 1}</td>
                <td class="${hasData ? 'td-name' : 'td-empty'}">${hasData ? esc(p.surname) : '— ожидает данных —'}</td>
                <td>${esc(p.name)}</td>
                <td>${esc(p.patronymic)}</td>
                <td>${esc(fmtDate(state.arrivalDate))}</td>
                <td>${esc(spec)}</td>
              </tr>`
            }).join('')}
          </tbody>
        </table>
      </div>
    </section>
  `
}

// ── Icons ─────────────────────────────────────────────────────────────────────

const iconPlus     = () => `<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M7 1.5v11M1.5 7h11" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`
const iconDownload = () => `<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M7 1.5v8M3.5 6L7 9.5 10.5 6M2 12h10" stroke="white" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`
const iconTrash    = () => `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M2 4h12M5 4V2.5A.5.5 0 015.5 2h5a.5.5 0 01.5.5V4M6 7v5M10 7v5M3.5 4l.6 9.5a1 1 0 001 .9h5.8a1 1 0 001-.9l.6-9.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>`
const iconCheck    = () => `<svg width="13" height="13" viewBox="0 0 13 13" fill="none"><path d="M2 6.5l3.5 3.5 5.5-6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`
const iconEye      = () => `<svg width="13" height="13" viewBox="0 0 13 13" fill="none"><ellipse cx="6.5" cy="6.5" rx="5" ry="3" stroke="currentColor" stroke-width="1.3"/><circle cx="6.5" cy="6.5" r="1.5" fill="currentColor"/></svg>`
const iconDismiss  = () => `<svg width="13" height="13" viewBox="0 0 13 13" fill="none"><path d="M9.5 3.5l-6 6M3.5 3.5l6 6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`

// ── Viewer state (вне render-цикла) ──────────────────────────────────────────

const viewerState = new Map()
let dragState = { active: false, id: null, lx: 0, ly: 0 }

document.addEventListener('mousemove', e => {
  if (!dragState.active) return
  const vs = viewerState.get(dragState.id)
  if (!vs) return
  vs.ox += e.clientX - dragState.lx
  vs.oy += e.clientY - dragState.ly
  dragState.lx = e.clientX
  dragState.ly = e.clientY
  applyViewer(dragState.id, vs)
})

document.addEventListener('mouseup', () => {
  if (!dragState.active) return
  dragState.active = false
  const stage = document.getElementById(`vstage-${dragState.id}`)
  const vs    = viewerState.get(dragState.id)
  if (stage && vs) stage.style.cursor = vs.zoom > 1 ? 'grab' : 'default'
})

function applyViewer(id, vs) {
  const img   = document.getElementById(`vimg-${id}`)
  const pctEl = document.getElementById(`vzoom-${id}`)
  const stage = document.getElementById(`vstage-${id}`)
  if (!img) return
  img.style.transform = `translate(${vs.ox}px, ${vs.oy}px) scale(${vs.zoom})`
  if (pctEl) pctEl.textContent = `${Math.round(vs.zoom * 100)}%`
  if (stage) stage.style.cursor = vs.zoom > 1 ? 'grab' : 'default'
}

function initViewer(id) {
  const stage  = document.getElementById(`vstage-${id}`)
  const img    = document.getElementById(`vimg-${id}`)
  const btnIn  = document.getElementById(`vin-${id}`)
  const btnOut = document.getElementById(`vout-${id}`)
  const btnRst = document.getElementById(`vreset-${id}`)
  const btnOcr = document.getElementById(`vocr-${id}`)
  if (!stage || !img) return

  if (!viewerState.has(id)) viewerState.set(id, { zoom: 1, ox: 0, oy: 0 })
  const vs = viewerState.get(id)
  applyViewer(id, vs)

  btnIn?.addEventListener('click', () => {
    vs.zoom = Math.min(6, parseFloat((vs.zoom + 0.5).toFixed(1)))
    applyViewer(id, vs)
  })
  btnOut?.addEventListener('click', () => {
    vs.zoom = Math.max(0.5, parseFloat((vs.zoom - 0.5).toFixed(1)))
    applyViewer(id, vs)
  })
  btnRst?.addEventListener('click', () => {
    vs.zoom = 1; vs.ox = 0; vs.oy = 0
    applyViewer(id, vs)
  })
  // Двухшаговый режим: Читать → прицел с 3 зонами → Подтвердить → OCR
  let aiming = false
  if (btnOcr) {
    btnOcr.addEventListener('click', () => {
      if (!aiming) {
        aiming = true
        btnOcr.innerHTML = iconCheck() + ' Подтвердить'
        btnOcr.classList.add('aiming')
        const overlay = document.createElement('div')
        overlay.className = 'viewer-aim-overlay'
        overlay.id = `vaim-${id}`
        overlay.innerHTML = `
          <div class="aim-v-zone" id="vaim-vzone-${id}" style="--vzone-w:65%"></div>
          <div class="aim-footer">
            <div class="viewer-aim-hint">Наведи строки на зоны · нажми «Подтвердить»</div>
          </div>
          <div class="aim-zones" id="vaim-zones-${id}" style="pointer-events:none">
            <div class="aim-zone"><span class="aim-zone-tag">ФАМИЛИЯ</span><div class="aim-zone-dash"></div></div>
            <div class="aim-zone"><span class="aim-zone-tag">ИМЯ</span><div class="aim-zone-dash"></div></div>
            <div class="aim-zone"><span class="aim-zone-tag">ОТЧЕСТВО</span><div class="aim-zone-dash"></div></div>
          </div>
          <div class="aim-controls">
            <span class="aim-controls-label">⇕</span>
            <input type="range" class="aim-slider" min="18" max="80" value="30" id="vaim-slider-${id}" onmousedown="event.stopPropagation()" ontouchstart="event.stopPropagation()" />
            <span class="aim-controls-sep"></span>
            <span class="aim-controls-label">↔</span>
            <input type="range" class="aim-slider" min="20" max="100" value="65" id="vaim-vslider-${id}" onmousedown="event.stopPropagation()" ontouchstart="event.stopPropagation()" />
          </div>
          <button class="viewer-aim-cancel" id="vaim-cancel-${id}" style="pointer-events:all">✕ Отмена</button>
        `
        stage.appendChild(overlay)
        document.getElementById(`vaim-cancel-${id}`)?.addEventListener('click', e => {
          e.stopPropagation()
          exitAiming()
        })
        document.getElementById(`vaim-slider-${id}`)?.addEventListener('input', e => {
          const h = e.target.value + 'px'
          document.querySelectorAll(`#vaim-${id} .aim-zone`).forEach(z => { z.style.height = h })
        })
        document.getElementById(`vaim-vslider-${id}`)?.addEventListener('input', e => {
          document.getElementById(`vaim-vzone-${id}`)?.style.setProperty('--vzone-w', e.target.value + '%')
        })
      } else {
        exitAiming()
        handleViewportOcr(id)
      }
    })
  }

  function exitAiming() {
    aiming = false
    if (btnOcr) {
      btnOcr.innerHTML = iconEye() + ' Читать'
      btnOcr.classList.remove('aiming')
    }
    document.getElementById(`vaim-${id}`)?.remove()
  }

  stage.addEventListener('wheel', e => {
    e.preventDefault()
    const delta = e.deltaY < 0 ? 0.15 : -0.15
    vs.zoom = Math.max(0.5, Math.min(6, parseFloat((vs.zoom + delta).toFixed(2))))
    applyViewer(id, vs)
  }, { passive: false })

  stage.addEventListener('mousedown', e => {
    if (e.target.closest('.aim-controls, .viewer-aim-cancel')) return
    e.preventDefault()
    dragState = { active: true, id, lx: e.clientX, ly: e.clientY }
    stage.style.cursor = 'grabbing'
  })

  stage.addEventListener('dblclick', () => {
    if (vs.zoom >= 2) { vs.zoom = 1; vs.ox = 0; vs.oy = 0 }
    else vs.zoom = Math.min(6, vs.zoom * 2)
    applyViewer(id, vs)
  })

  let lastTouchDist = null
  stage.addEventListener('touchstart', e => {
    if (e.touches.length === 2) {
      lastTouchDist = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      )
    }
  }, { passive: true })
  stage.addEventListener('touchmove', e => {
    if (e.touches.length !== 2 || lastTouchDist === null) return
    e.preventDefault()
    const dist = Math.hypot(
      e.touches[0].clientX - e.touches[1].clientX,
      e.touches[0].clientY - e.touches[1].clientY
    )
    vs.zoom = Math.max(0.5, Math.min(6, vs.zoom * (dist / lastTouchDist)))
    lastTouchDist = dist
    applyViewer(id, vs)
  }, { passive: false })
  stage.addEventListener('touchend', () => { lastTouchDist = null }, { passive: true })
}

// ── Listeners ─────────────────────────────────────────────────────────────────

function attachStaffListeners() {
  const section = document.getElementById('staff-section')
  if (!section) return

  section.addEventListener('click', e => {
    const saveBtn = e.target.closest('[data-action="save-phone"]')
    if (saveBtn) {
      const sid = parseFloat(saveBtn.dataset.sid)
      const inp = section.querySelector(`.staff-phone[data-sid="${sid}"]`)
      if (inp) {
        updateStaffPhone(sid, inp.value)
        saveBtn.classList.add('saved')
        setTimeout(() => saveBtn.classList.remove('saved'), 1500)
        showToast('Телефон сохранён', 'success')
      }
      return
    }
    const dismissBtn = e.target.closest('[data-action="dismiss"]')
    if (dismissBtn) dismissEmployee(parseFloat(dismissBtn.dataset.sid))
  })
}

function attachListeners() {
  document.getElementById('arrival-date')?.addEventListener('change', e => {
    state.arrivalDate = e.target.value; render()
  })
  document.getElementById('btn-add')?.addEventListener('click', addPerson)
  document.getElementById('btn-download')?.addEventListener('click', handleDownload)

  const list = document.getElementById('persons-list')

  list?.addEventListener('change', e => {
    const t = e.target; const id = parseInt(t.dataset.id)
    if (isNaN(id)) return
    if (t.dataset.action === 'file') {
      const file = t.files?.[0]; if (file) handlePassportFile(id, file)
    } else if (t.tagName === 'SELECT' && t.dataset.field) {
      setPerson(id, { [t.dataset.field]: t.value })
    }
  })

  list?.addEventListener('input', e => {
    const t = e.target
    if (t.tagName === 'SELECT') return
    const id = parseInt(t.dataset.id)
    if (!isNaN(id) && t.dataset.field) {
      const idx = state.persons.findIndex(p => p.id === id)
      if (idx !== -1) state.persons[idx][t.dataset.field] = t.value
    }
  })

  list?.addEventListener('click', e => {
    const btn = e.target.closest('[data-action]')
    if (!btn) return
    const id = parseInt(btn.dataset.id)
    if (isNaN(id)) return
    if (btn.dataset.action === 'remove')       removePerson(id)
    else if (btn.dataset.action === 'reupload') document.getElementById(`file-${id}`)?.click()
    else if (btn.dataset.action === 'hire')     hireEmployee(id)
    else if (btn.dataset.action === 'toggle-debug') {
      const p = state.persons.find(x => x.id === id)
      if (p) setPerson(id, { showDebug: !p.showDebug })
    }
  })

  document.querySelectorAll('.passport-zone').forEach(zone => {
    zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drag-over') })
    zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'))
    zone.addEventListener('drop', e => {
      e.preventDefault(); zone.classList.remove('drag-over')
      const file = e.dataTransfer?.files?.[0]
      const id   = parseInt(zone.querySelector('[data-id]')?.dataset.id)
      if (file && !isNaN(id)) handlePassportFile(id, file)
    })
  })

  state.persons.forEach(p => { if (p.imageUrl) initViewer(p.id) })
  attachStaffListeners()
}

// ── Boot ──────────────────────────────────────────────────────────────────────
render()
