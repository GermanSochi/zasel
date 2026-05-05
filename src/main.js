import './style.css'
import { preprocessImage, extractPassportData } from './ocr.js'
import { generateDocument } from './docx-gen.js'

// ── State ─────────────────────────────────────────────────────────────────────

let nextId = 1

const state = {
  apiKey: localStorage.getItem('apiKey') || '',
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
    ocrStatus: 'idle',  // idle | loading | done | error
    ocrError: '',
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

// ── OCR ───────────────────────────────────────────────────────────────────────

async function handlePassportFile(id, file) {
  if (!file) return

  // Показываем превью сразу
  const rawUrl = URL.createObjectURL(file)
  setPerson(id, { imageUrl: rawUrl, imageName: file.name, ocrStatus: 'loading', ocrError: '' })

  if (!state.apiKey) {
    setPerson(id, {
      ocrStatus: 'error',
      ocrError: 'Введи API ключ Anthropic (кнопка ⚙️ вверху)',
    })
    return
  }

  try {
    // Шаг 1: resize/compress — как PIL.thumbnail + quality loop из ai-documents-parser
    const compressed = await preprocessImage(file)

    // Шаг 2: Claude vision API
    const result = await extractPassportData(compressed, state.apiKey)

    setPerson(id, {
      surname: result.surname || '',
      name: result.name || '',
      patronymic: result.patronymic || '',
      dob: result.dob || '',
      ocrStatus: result.surname || result.name ? 'done' : 'error',
      ocrError: result.surname || result.name ? '' : 'Данные не найдены — заполни вручную',
    })
  } catch (err) {
    setPerson(id, { ocrStatus: 'error', ocrError: err.message })
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
  const hasKey = !!state.apiKey
  return `
    <div class="app-header">
      <div>
        <div class="app-title">Список на заселение</div>
        <div class="app-subtitle">ИП Калгунов → ООО ЛесРесорт</div>
      </div>
      <button class="btn-icon ${!hasKey ? 'btn-icon-alert' : ''}" id="btn-settings" title="API ключ">
        ${hasKey ? iconGear() : iconKey()}
      </button>
    </div>

    ${buildApiKeyBanner()}

    <div id="settings-panel" style="display:none">
      ${buildSettings()}
    </div>

    <div class="date-row">
      <label for="arrival-date">Дата прибытия</label>
      <input type="date" id="arrival-date" value="${state.arrivalDate}" />
    </div>

    <div class="persons-list" id="persons-list">
      ${state.persons.length ? state.persons.map((p, i) => buildCard(p, i)).join('') : buildEmptyState()}
    </div>

    <div class="bottom-bar">
      <button class="btn btn-secondary" id="btn-add">${iconPlus()} Добавить сотрудника</button>
      <button class="btn btn-primary" id="btn-download" ${!state.persons.length ? 'disabled' : ''}>${iconDownload()} Скачать .docx</button>
    </div>

    ${state.persons.length ? buildPreview() : ''}

    <div class="toast-container"></div>
  `
}

function buildApiKeyBanner() {
  if (state.apiKey) return ''
  return `
    <div class="api-banner">
      <div class="api-banner-icon">🔑</div>
      <div class="api-banner-body">
        <strong>Для распознавания паспортов нужен API ключ Anthropic</strong>
        <span>Бесплатный ключ: <a href="https://console.anthropic.com" target="_blank" rel="noopener">console.anthropic.com</a> → $5 кредит</span>
      </div>
      <button class="btn btn-primary btn-sm" id="btn-open-settings">Ввести ключ</button>
    </div>
  `
}

function buildSettings() {
  const hasKey = !!state.apiKey
  return `
    <div class="settings-panel">
      <div class="settings-head">
        <strong>Anthropic API ключ</strong>
        <button class="btn-icon btn-icon-sm" id="btn-close-settings">✕</button>
      </div>
      <div class="settings-row">
        <input type="password" id="api-key-input" placeholder="sk-ant-api03-..." value="${state.apiKey}" autocomplete="off" spellcheck="false" />
        <button class="btn btn-primary btn-sm" id="btn-save-key">Сохранить</button>
      </div>
      <div class="key-status ${hasKey ? 'ok' : 'missing'}">
        ${hasKey
          ? `${iconCheck()} Ключ активен — паспорта распознаются автоматически`
          : `Получи бесплатный ключ на <a href="https://console.anthropic.com" target="_blank" rel="noopener">console.anthropic.com</a>`
        }
      </div>
    </div>
  `
}

function buildEmptyState() {
  const hint = state.apiKey
    ? 'Фото паспорта → ФИО распознаётся автоматически'
    : 'Сначала введи API ключ (кнопка 🔑 вверху), затем загружай паспорта'
  return `
    <div class="empty-state">
      <div class="empty-icon">🛂</div>
      <div class="empty-text">Нет сотрудников</div>
      <div class="empty-sub">${hint}</div>
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
          ${isCustom ? `<input class="specialty-custom" type="text" data-field="customSpecialty" data-id="${p.id}" value="${esc(p.customSpecialty)}" placeholder="Введи специальность..." style="margin-top:6px" />` : ''}
        </div>
      </div>
    </div>
  `
}

function buildPassportZone(p) {
  if (p.ocrStatus === 'loading') {
    return `
      <div class="ocr-loading">
        <span class="spinner"></span>
        <span>Распознаю паспорт…</span>
      </div>
      <input type="file" accept="image/*" data-action="file" data-id="${p.id}" id="file-${p.id}" style="display:none" />
    `
  }

  if (p.imageUrl) {
    const statusHtml = {
      done:  `<span class="status-ok">${iconCheck()} Распознано</span>`,
      error: `<span class="status-err">⚠ ${esc(p.ocrError)}</span>`,
      idle:  `<span class="status-muted">Загружено</span>`,
    }[p.ocrStatus] || ''

    return `
      <div class="passport-thumb">
        <img src="${p.imageUrl}" alt="паспорт" />
        <div class="passport-thumb-info">
          <div class="passport-thumb-name">${esc(p.imageName || '')}</div>
          <div class="passport-thumb-status">${statusHtml}</div>
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
        ФИО распознается автоматически
      </div>
      <input type="file" accept="image/*" capture="environment" data-action="file" data-id="${p.id}" id="file-${p.id}" />
    </label>
  `
}

function buildPreview() {
  return `
    <div class="preview-section">
      <h2>Предпросмотр</h2>
      <div class="preview-table-wrap">
        <table class="preview-table">
          <thead><tr><th>№</th><th>Фамилия</th><th>Имя</th><th>Отчество</th><th>Дата прибытия</th><th>Специальность</th></tr></thead>
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
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

// ── Icons ─────────────────────────────────────────────────────────────────────

const iconGear = () => `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`
const iconKey = () => `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>`
const iconPlus = () => `<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M7 1v12M1 7h12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`
const iconDownload = () => `<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M7 1v8M4 6l3 3 3-3M1 11h12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`
const iconTrash = () => `<svg width="13" height="13" viewBox="0 0 13 13" fill="none"><path d="M1 3h11M4 3V2h5v1M5 6v4M8 6v4M2 3l1 9h7l1-9" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`
const iconCheck = () => `<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M1 6l4 4 6-7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`

// ── Listeners ─────────────────────────────────────────────────────────────────

function attachListeners() {
  const panel = document.getElementById('settings-panel')

  document.getElementById('btn-settings')?.addEventListener('click', () => {
    const open = panel.style.display === 'block'
    panel.style.display = open ? 'none' : 'block'
    panel.innerHTML = buildSettings()
    attachSettingsListeners()
  })

  document.getElementById('btn-open-settings')?.addEventListener('click', () => {
    panel.style.display = 'block'
    panel.innerHTML = buildSettings()
    attachSettingsListeners()
    panel.scrollIntoView({ behavior: 'smooth', block: 'start' })
  })

  document.getElementById('btn-close-settings')?.addEventListener('click', () => {
    panel.style.display = 'none'
  })

  document.getElementById('arrival-date')?.addEventListener('change', e => {
    state.arrivalDate = e.target.value
    render()
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

  // Drag-and-drop
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

function attachSettingsListeners() {
  document.getElementById('btn-save-key')?.addEventListener('click', () => {
    const key = document.getElementById('api-key-input')?.value.trim() || ''
    state.apiKey = key
    localStorage.setItem('apiKey', key)
    document.getElementById('settings-panel').style.display = 'none'
    render()
    showToast(key ? 'API ключ сохранён ✓' : 'Ключ удалён', key ? 'success' : '')
  })

  document.getElementById('btn-close-settings')?.addEventListener('click', () => {
    document.getElementById('settings-panel').style.display = 'none'
  })

  document.getElementById('api-key-input')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('btn-save-key')?.click()
  })
}

// ── Boot ──────────────────────────────────────────────────────────────────────

render()
