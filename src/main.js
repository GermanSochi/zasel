import './style.css'
import { extractPassportData, fileToDataUrl } from './ocr.js'
import { generateDocument } from './docx-gen.js'

// ── State ─────────────────────────────────────────────────────────────────────

let nextId = 1

const state = {
  apiKey: localStorage.getItem('apiKey') || '',
  showSettings: false,
  arrivalDate: todayISO(),
  persons: [],
}

function todayISO() {
  return new Date().toISOString().split('T')[0]
}

function setState(patch) {
  Object.assign(state, patch)
  render()
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
    surname: '',
    name: '',
    patronymic: '',
    dob: '',
    specialty: 'Официант',
    customSpecialty: '',
    imageUrl: null,
    imageName: null,
    ocrStatus: 'idle', // idle | loading | done | error
    ocrError: '',
  })
  render()
  // Focus the upload zone of the new card
  setTimeout(() => {
    const cards = document.querySelectorAll('.person-card')
    const last = cards[cards.length - 1]
    last?.querySelector('.passport-upload input')?.focus()
    last?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }, 50)
}

function removePerson(id) {
  state.persons = state.persons.filter(p => p.id !== id)
  render()
}

// ── OCR ───────────────────────────────────────────────────────────────────────

async function handlePassportFile(id, file) {
  if (!file) return

  const dataUrl = await fileToDataUrl(file)
  setPerson(id, { imageUrl: dataUrl, imageName: file.name, ocrStatus: 'loading', ocrError: '' })

  if (!state.apiKey) {
    setPerson(id, {
      ocrStatus: 'error',
      ocrError: 'Нет API ключа — заполни данные вручную',
    })
    return
  }

  try {
    const result = await extractPassportData(dataUrl, state.apiKey)
    setPerson(id, {
      surname: toTitle(result.surname || ''),
      name: toTitle(result.name || ''),
      patronymic: toTitle(result.patronymic || ''),
      dob: result.dob || '',
      ocrStatus: 'done',
    })
  } catch (err) {
    setPerson(id, { ocrStatus: 'error', ocrError: err.message })
  }
}

function toTitle(str) {
  return str
    .toLowerCase()
    .split(' ')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

// ── Download ──────────────────────────────────────────────────────────────────

async function handleDownload() {
  const filled = state.persons.map(p => ({
    ...p,
    specialty: p.specialty === '__custom__' ? p.customSpecialty : p.specialty,
  }))

  if (!filled.length) {
    showToast('Добавь хотя бы одного сотрудника', 'error')
    return
  }

  try {
    await generateDocument(filled, state.arrivalDate)
    showToast('Документ скачан', 'success')
  } catch (err) {
    showToast('Ошибка генерации: ' + err.message, 'error')
  }
}

// ── Toast ─────────────────────────────────────────────────────────────────────

function showToast(msg, type = '') {
  const container = document.querySelector('.toast-container')
  if (!container) return

  const el = document.createElement('div')
  el.className = `toast${type ? ` ${type}` : ''}`
  el.textContent = msg
  container.appendChild(el)

  setTimeout(() => {
    el.classList.add('hiding')
    setTimeout(() => el.remove(), 350)
  }, 3000)
}

// ── Render ────────────────────────────────────────────────────────────────────

const SPECIALTIES = ['Официант', 'Кухонный работник', 'Горничная', 'Бармен', 'Администратор', 'Уборщик', '— другое —']

function render() {
  const root = document.getElementById('root')
  if (!root) return
  root.innerHTML = buildApp()
  attachListeners()
}

function buildApp() {
  return `
    <div class="app-header">
      <div>
        <div class="app-title">Список на заселение</div>
        <div class="app-subtitle">ИП Калгунов → ООО ЛесРесорт</div>
      </div>
      <button class="btn-icon" id="btn-settings" title="Настройки API ключа">
        ${iconGear()}
      </button>
    </div>

    ${state.showSettings ? buildSettings() : ''}

    <div class="date-row">
      <label for="arrival-date">Дата прибытия</label>
      <input type="date" id="arrival-date" value="${state.arrivalDate}" />
    </div>

    <div class="persons-list" id="persons-list">
      ${state.persons.map((p, i) => buildCard(p, i)).join('')}
    </div>

    <div class="bottom-bar">
      <div class="add-btn-wrap">
        <button class="btn btn-secondary" id="btn-add">
          ${iconPlus()} Добавить сотрудника
        </button>
      </div>
      <button class="btn btn-primary" id="btn-download" ${!state.persons.length ? 'disabled' : ''}>
        ${iconDownload()} Скачать документ
      </button>
    </div>

    ${state.persons.length ? buildPreview() : ''}

    <div class="toast-container"></div>
  `
}

function buildSettings() {
  const hasKey = !!state.apiKey
  return `
    <div class="settings-panel">
      <h3>Anthropic API ключ (для распознавания паспортов)</h3>
      <div class="settings-row">
        <input
          type="password"
          id="api-key-input"
          placeholder="sk-ant-..."
          value="${state.apiKey}"
          autocomplete="off"
        />
        <button class="btn btn-secondary" id="btn-save-key" style="white-space:nowrap">Сохранить</button>
      </div>
      <div class="key-status ${hasKey ? 'ok' : 'missing'}">
        ${hasKey
          ? `${iconCheck()} Ключ сохранён — паспорт распознаётся автоматически`
          : `${iconWarning()} Без ключа заполняй данные вручную`
        }
      </div>
    </div>
  `
}

function buildCard(p, index) {
  const isCustom = p.specialty === '__custom__'

  return `
    <div class="person-card" data-id="${p.id}">
      <div class="card-top">
        <span class="card-index">Сотрудник ${index + 1}</span>
        <div class="card-actions">
          <button class="btn btn-danger btn-ghost" data-action="remove" data-id="${p.id}" title="Удалить">
            ${iconTrash()} Удалить
          </button>
        </div>
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
          <div class="specialty-wrap">
            <select data-field="specialty" data-id="${p.id}">
              ${SPECIALTIES.map(s => {
                const val = s === '— другое —' ? '__custom__' : s
                return `<option value="${val}" ${p.specialty === val ? 'selected' : ''}>${s}</option>`
              }).join('')}
            </select>
            ${isCustom ? `
              <input
                class="specialty-custom"
                type="text"
                data-field="customSpecialty"
                data-id="${p.id}"
                value="${esc(p.customSpecialty)}"
                placeholder="Введи специальность..."
              />
            ` : ''}
          </div>
        </div>
      </div>
    </div>
  `
}

function buildPassportZone(p) {
  if (p.imageUrl) {
    const statusText = {
      loading: `<span class="spinner"></span>Распознаю...`,
      done: `${iconCheck()} Данные распознаны`,
      error: `⚠ ${esc(p.ocrError)}`,
      idle: 'Фото загружено',
    }[p.ocrStatus]

    const statusClass = { loading: 'loading', done: 'done', error: 'error', idle: '' }[p.ocrStatus]

    return `
      <div class="passport-thumb">
        <img src="${p.imageUrl}" alt="паспорт" />
        <div class="passport-thumb-info">
          <div class="passport-thumb-name">${esc(p.imageName || 'passport')}</div>
          <div class="passport-thumb-status ${statusClass}">${statusText}</div>
        </div>
        <button class="btn-reupload" data-action="reupload" data-id="${p.id}">
          Заменить
        </button>
      </div>
      <input type="file" accept="image/*" data-action="file" data-id="${p.id}" style="display:none" id="file-${p.id}" />
    `
  }

  return `
    <label class="passport-upload" for="file-${p.id}">
      <div class="passport-upload-icon">🛂</div>
      <div class="passport-upload-text">
        <strong>Загрузи паспорт</strong>
        Фото страницы с фотографией
      </div>
      <input type="file" accept="image/*" data-action="file" data-id="${p.id}" id="file-${p.id}" />
    </label>
  `
}

function buildPreview() {
  return `
    <div class="preview-section">
      <h2>Предпросмотр таблицы</h2>
      <div class="preview-table-wrap">
        <table class="preview-table">
          <thead>
            <tr>
              <th>№</th>
              <th>Фамилия</th>
              <th>Имя</th>
              <th>Отчество</th>
              <th>Дата прибытия</th>
              <th>Специальность</th>
            </tr>
          </thead>
          <tbody>
            ${state.persons.map((p, i) => {
              const spec = p.specialty === '__custom__' ? p.customSpecialty : p.specialty
              const arrival = formatArrival(state.arrivalDate)
              return `<tr>
                <td>${i + 1}</td>
                <td>${esc(p.surname)}</td>
                <td>${esc(p.name)}</td>
                <td>${esc(p.patronymic)}</td>
                <td>${esc(arrival)}</td>
                <td>${esc(spec)}</td>
              </tr>`
            }).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `
}

function formatArrival(iso) {
  if (!iso) return ''
  const [y, m, d] = iso.split('-')
  return `${d}.${m}.${y}`
}

function esc(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// ── Icons (inline SVG) ────────────────────────────────────────────────────────

const iconGear = () => `<svg width="15" height="15" viewBox="0 0 15 15" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M7.5 5a2.5 2.5 0 100 5 2.5 2.5 0 000-5zM1 7.5a6.5 6.5 0 1113 0 6.5 6.5 0 01-13 0z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M7.5 1v1M7.5 13v1M1 7.5h1M13 7.5h1M2.697 2.697l.707.707M11.596 11.596l.707.707M2.697 12.303l.707-.707M11.596 3.404l.707-.707" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>`

const iconPlus = () => `<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M7 1v12M1 7h12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`

const iconDownload = () => `<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M7 1v8M4 6l3 3 3-3M1 11h12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`

const iconTrash = () => `<svg width="13" height="13" viewBox="0 0 13 13" fill="none"><path d="M1 3h11M4 3V2h5v1M5 6v4M8 6v4M2 3l1 9h7l1-9" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`

const iconCheck = () => `<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M1 6l4 4 6-7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`

const iconWarning = () => `⚠`

// ── Event listeners ───────────────────────────────────────────────────────────

function attachListeners() {
  // Settings toggle
  document.getElementById('btn-settings')?.addEventListener('click', () => {
    setState({ showSettings: !state.showSettings })
  })

  // Save API key
  document.getElementById('btn-save-key')?.addEventListener('click', () => {
    const key = document.getElementById('api-key-input')?.value.trim() || ''
    state.apiKey = key
    localStorage.setItem('apiKey', key)
    setState({ showSettings: false })
    showToast('API ключ сохранён', 'success')
  })

  // Arrival date
  document.getElementById('arrival-date')?.addEventListener('change', e => {
    state.arrivalDate = e.target.value
    render()
  })

  // Add person
  document.getElementById('btn-add')?.addEventListener('click', addPerson)

  // Download
  document.getElementById('btn-download')?.addEventListener('click', handleDownload)

  // Card actions (remove, file upload, field change, reupload)
  document.getElementById('persons-list')?.addEventListener('change', e => {
    const t = e.target
    const id = parseInt(t.dataset.id)
    if (isNaN(id)) return

    if (t.dataset.action === 'file') {
      const file = t.files?.[0]
      if (file) handlePassportFile(id, file)
    } else if (t.dataset.field) {
      setPerson(id, { [t.dataset.field]: t.value })
    }
  })

  document.getElementById('persons-list')?.addEventListener('input', e => {
    const t = e.target
    const id = parseInt(t.dataset.id)
    if (isNaN(id) || !t.dataset.field) return
    setPerson(id, { [t.dataset.field]: t.value })
  })

  document.getElementById('persons-list')?.addEventListener('click', e => {
    const btn = e.target.closest('[data-action]')
    if (!btn) return
    const id = parseInt(btn.dataset.id)
    if (isNaN(id)) return

    if (btn.dataset.action === 'remove') {
      removePerson(id)
    } else if (btn.dataset.action === 'reupload') {
      document.getElementById(`file-${id}`)?.click()
    }
  })

  // Drag-and-drop on upload zones
  document.querySelectorAll('.passport-upload').forEach(zone => {
    zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drag-over') })
    zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'))
    zone.addEventListener('drop', e => {
      e.preventDefault()
      zone.classList.remove('drag-over')
      const file = e.dataTransfer?.files?.[0]
      const id = parseInt(zone.querySelector('input[data-id]')?.dataset.id)
      if (file && !isNaN(id)) handlePassportFile(id, file)
    })
  })
}

// ── Boot ──────────────────────────────────────────────────────────────────────

render()
