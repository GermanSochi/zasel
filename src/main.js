import './style.css'
import { preprocessImage, extractPassportData } from './ocr.js'
import { generateDocument } from './docx-gen.js'

// ── State ─────────────────────────────────────────────────────────────────────

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
    surname: '', name: '', patronymic: '', dob: '',
    specialty: 'Официант', customSpecialty: '',
    imageUrl: null, imageName: null,
    ocrStatus: 'idle',   // idle | loading | done | error
    ocrError: '',
    ocrProgress: 0,
  })
  render()
  setTimeout(() => {
    const cards = document.querySelectorAll('.person-card')
    cards[cards.length - 1]?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }, 50)
}

function removePerson(id) {
  state.persons = state.persons.filter(p => p.id !== id)
  render()
}

// ── OCR (офлайн, без API ключа) ───────────────────────────────────────────────

async function handlePassportFile(id, file) {
  if (!file) return

  const rawUrl = URL.createObjectURL(file)
  setPerson(id, { imageUrl: rawUrl, imageName: file.name, ocrStatus: 'loading', ocrError: '', ocrProgress: 5 })

  try {
    // Шаг 1: resize + grayscale + contrast (Canvas API)
    setPerson(id, { ocrProgress: 10 })
    const processed = await preprocessImage(file)

    // Шаг 2: Tesseract rus+eng → MRZ + визуальный парсинг
    const result = await extractPassportData(processed, null, (pct) => {
      setPerson(id, { ocrProgress: 10 + Math.round(pct * 0.9) })
    })

    const found = !!(result.surname || result.name)
    setPerson(id, {
      surname:    result.surname    || '',
      name:       result.name       || '',
      patronymic: result.patronymic || '',
      dob:        result.dob        || '',
      ocrStatus:  found ? 'done' : 'warn',
      ocrError:   found ? '' : 'Не распознано — проверь качество фото или заполни вручную',
      ocrProgress: 100,
    })
  } catch (err) {
    setPerson(id, { ocrStatus: 'error', ocrError: err.message, ocrProgress: 0 })
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

// ── Render ────────────────────────────────────────────────────────────────────

const SPECIALTIES = ['Официант', 'Кухонный работник', 'Горничная', 'Бармен', 'Администратор', 'Уборщик', '— другое —']

function render() {
  document.getElementById('root').innerHTML = buildApp()
  attachListeners()
}

function buildApp() {
  return `
    <div class="app-header">
      <div>
        <div class="app-title">Список на заселение</div>
        <div class="app-subtitle">ИП Калгунов → ООО ЛесРесорт</div>
      </div>
    </div>

    <div class="date-row">
      <label for="arrival-date">Дата прибытия</label>
      <input type="date" id="arrival-date" value="${state.arrivalDate}" />
    </div>

    <div class="persons-list" id="persons-list">
      ${state.persons.length
        ? state.persons.map((p, i) => buildCard(p, i)).join('')
        : buildEmptyState()}
    </div>

    <div class="bottom-bar">
      <button class="btn btn-secondary" id="btn-add">${iconPlus()} Добавить сотрудника</button>
      <button class="btn btn-primary" id="btn-download" ${!state.persons.length ? 'disabled' : ''}>${iconDownload()} Скачать .docx</button>
    </div>

    ${state.persons.length ? buildPreview() : ''}
    <div class="toast-container"></div>
  `
}

function buildEmptyState() {
  return `
    <div class="empty-state">
      <div class="empty-icon">🛂</div>
      <div class="empty-text">Нет сотрудников</div>
      <div class="empty-sub">Нажми «Добавить» и загрузи фото паспорта — ФИО распознаётся офлайн</div>
    </div>
  `
}

function buildCard(p, index) {
  const isCustom = p.specialty === '__custom__'
  return `
    <div class="person-card" data-id="${p.id}">
      <div class="card-top">
        <span class="card-index">Сотрудник ${index + 1}</span>
        <button class="btn-danger-ghost" data-action="remove" data-id="${p.id}">${iconTrash()} Удалить</button>
      </div>

      ${buildPassportZone(p)}

      <div class="fields-grid">
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
          <label>Дата рождения</label>
          <input type="text" data-field="dob" data-id="${p.id}" value="${esc(p.dob)}" placeholder="01.01.1990" />
        </div>
        <div class="field full-width">
          <label>Специальность</label>
          <select data-field="specialty" data-id="${p.id}">
            ${SPECIALTIES.map(s => {
              const val = s === '— другое —' ? '__custom__' : s
              return `<option value="${val}" ${p.specialty === val ? 'selected' : ''}>${s}</option>`
            }).join('')}
          </select>
          ${isCustom ? `
            <input class="specialty-custom" type="text"
              data-field="customSpecialty" data-id="${p.id}"
              value="${esc(p.customSpecialty)}"
              placeholder="Введи специальность..." style="margin-top:6px" />
          ` : ''}
        </div>
      </div>
    </div>
  `
}

function buildPassportZone(p) {
  if (p.ocrStatus === 'loading') {
    const pct = p.ocrProgress || 0
    return `
      <div class="ocr-progress-wrap">
        <div class="ocr-progress-label">
          <span class="spinner"></span>
          Распознаю паспорт… ${pct}%
        </div>
        <div class="ocr-progress-bar">
          <div class="ocr-progress-fill" style="width:${pct}%"></div>
        </div>
      </div>
      <input type="file" accept="image/*" data-action="file" data-id="${p.id}" id="file-${p.id}" style="display:none" />
    `
  }

  if (p.imageUrl) {
    const statusMap = {
      done: `<span class="status-ok">${iconCheck()} Данные распознаны</span>`,
      warn: `<span class="status-warn">⚠ ${esc(p.ocrError)}</span>`,
      error: `<span class="status-err">✕ ${esc(p.ocrError)}</span>`,
      idle: `<span class="status-muted">Загружено</span>`,
    }
    return `
      <div class="passport-thumb">
        <img src="${p.imageUrl}" alt="паспорт" />
        <div class="passport-thumb-info">
          <div class="passport-thumb-name">${esc(p.imageName || '')}</div>
          <div class="passport-thumb-status">${statusMap[p.ocrStatus] || ''}</div>
        </div>
        <button class="btn-reupload" data-action="reupload" data-id="${p.id}">Заменить</button>
      </div>
      <input type="file" accept="image/*" data-action="file" data-id="${p.id}" id="file-${p.id}" style="display:none" />
    `
  }

  return `
    <label class="passport-upload" for="file-${p.id}">
      <div class="passport-upload-icon">📷</div>
      <div class="passport-upload-text">
        <strong>Загрузить фото паспорта</strong>
        ФИО распознаётся офлайн — без интернета и API ключей
      </div>
      <input type="file" accept="image/*" capture="environment"
        data-action="file" data-id="${p.id}" id="file-${p.id}" />
    </label>
  `
}

function buildPreview() {
  return `
    <div class="preview-section">
      <h2>Предпросмотр</h2>
      <div class="preview-table-wrap">
        <table class="preview-table">
          <thead>
            <tr>
              <th>№</th><th>Фамилия</th><th>Имя</th>
              <th>Отчество</th><th>Дата прибытия</th><th>Специальность</th>
            </tr>
          </thead>
          <tbody>
            ${state.persons.map((p, i) => {
              const spec = p.specialty === '__custom__' ? p.customSpecialty : p.specialty
              return `<tr>
                <td>${i + 1}</td>
                <td>${esc(p.surname)}</td>
                <td>${esc(p.name)}</td>
                <td>${esc(p.patronymic)}</td>
                <td>${esc(fmtDate(state.arrivalDate))}</td>
                <td>${esc(spec)}</td>
              </tr>`
            }).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `
}

function fmtDate(iso) {
  if (!iso) return ''
  const [y, m, d] = iso.split('-')
  return `${d}.${m}.${y}`
}

function esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')
}

// ── Icons ─────────────────────────────────────────────────────────────────────
const iconPlus = () => `<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M7 1v12M1 7h12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`
const iconDownload = () => `<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M7 1v8M4 6l3 3 3-3M1 11h12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`
const iconTrash = () => `<svg width="13" height="13" viewBox="0 0 13 13" fill="none"><path d="M1 3h11M4 3V2h5v1M5 6v4M8 6v4M2 3l1 9h7l1-9" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`
const iconCheck = () => `<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M1 6l4 4 6-7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`

// ── Listeners ─────────────────────────────────────────────────────────────────

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
    } else if (t.dataset.field) {
      setPerson(id, { [t.dataset.field]: t.value })
    }
  })

  list?.addEventListener('input', e => {
    const t = e.target; const id = parseInt(t.dataset.id)
    if (!isNaN(id) && t.dataset.field) setPerson(id, { [t.dataset.field]: t.value })
  })

  list?.addEventListener('click', e => {
    const btn = e.target.closest('[data-action]')
    if (!btn) return
    const id = parseInt(btn.dataset.id)
    if (isNaN(id)) return
    if (btn.dataset.action === 'remove') removePerson(id)
    else if (btn.dataset.action === 'reupload') document.getElementById(`file-${id}`)?.click()
  })

  document.querySelectorAll('.passport-upload').forEach(zone => {
    zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drag-over') })
    zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'))
    zone.addEventListener('drop', e => {
      e.preventDefault(); zone.classList.remove('drag-over')
      const file = e.dataTransfer?.files?.[0]
      const id = parseInt(zone.querySelector('[data-id]')?.dataset.id)
      if (file && !isNaN(id)) handlePassportFile(id, file)
    })
  })
}

// ── Boot ──────────────────────────────────────────────────────────────────────
render()
