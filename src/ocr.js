/**
 * OCR паспортов — подход из ai-documents-parser-main:
 * 1. Canvas resize/compress до 2000px и <5MB (как PIL.thumbnail в оригинале)
 * 2. Claude vision API с JSON-промптом
 * 3. Извлечение: surname, name, patronymic, dob
 */

// ── Image preprocessing (браузерный аналог PIL resize_and_compress) ───────────

export function preprocessImage(file, maxPx = 2000, maxBytes = 5 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()

    img.onerror = reject
    img.onload = () => {
      URL.revokeObjectURL(url)

      const canvas = document.createElement('canvas')
      let { naturalWidth: w, naturalHeight: h } = img

      // Сжимаем до maxPx с сохранением пропорций (как image.thumbnail в PIL)
      if (w > maxPx || h > maxPx) {
        const ratio = Math.min(maxPx / w, maxPx / h)
        w = Math.round(w * ratio)
        h = Math.round(h * ratio)
      }

      canvas.width = w
      canvas.height = h
      const ctx = canvas.getContext('2d')
      ctx.drawImage(img, 0, 0, w, h)

      // Итеративное сжатие JPEG (как в оригинале: quality -= 5 пока не < maxBytes)
      let quality = 0.85
      let dataUrl
      do {
        dataUrl = canvas.toDataURL('image/jpeg', quality)
        // base64 ~= 4/3 от бинарного
        if ((dataUrl.length * 3) / 4 <= maxBytes) break
        quality = Math.round((quality - 0.05) * 100) / 100
      } while (quality > 0.1)

      resolve(dataUrl)
    }

    img.src = url
  })
}

// ── Claude vision API (ai-documents-parser prompt + структура) ────────────────

export async function extractPassportData(imageDataUrl, apiKey) {
  const [header, base64Data] = imageDataUrl.split(',')
  const mediaType = header.match(/:(.*?);/)?.[1] || 'image/jpeg'

  // Промпт из ai-documents-parser-main/documents_parser.py — адаптирован под рус. паспорт
  const prompt = `Это фото российского паспорта. Извлеки данные и верни ТОЛЬКО JSON без пояснений:
{
  "surname": "Фамилия (только кириллица)",
  "name": "Имя (только кириллица)",
  "patronymic": "Отчество (только кириллица)",
  "dob": "Дата рождения ДД.ММ.ГГГГ",
  "passportNumber": "Серия и номер XX XX XXXXXX или null",
  "gender": "МУЖ или ЖЕН или null"
}
Если поле не читается — null. Только JSON, никакого другого текста.`

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 512,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: mediaType, data: base64Data },
            },
            { type: 'text', text: prompt },
          ],
        },
      ],
    }),
  })

  if (!response.ok) {
    const err = await response.json().catch(() => ({}))
    throw new Error(err?.error?.message || `HTTP ${response.status}`)
  }

  const data = await response.json()
  const raw = data.content?.[0]?.text?.trim() || ''

  // Как в оригинале: пробуем целиком, потом ищем JSON-блок
  try {
    return parseResult(JSON.parse(raw))
  } catch {
    const m = raw.match(/\{[\s\S]*?\}/)
    if (!m) throw new Error('Не удалось разобрать ответ API')
    return parseResult(JSON.parse(m[0]))
  }
}

function parseResult(obj) {
  const cap = s => (s && s !== 'null' && s !== 'None')
    ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase()
    : ''

  return {
    surname: cap(obj.surname),
    name: cap(obj.name),
    patronymic: cap(obj.patronymic),
    dob: obj.dob && obj.dob !== 'null' ? obj.dob : '',
    passportNumber: obj.passportNumber && obj.passportNumber !== 'null' ? obj.passportNumber : '',
  }
}

export function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}
