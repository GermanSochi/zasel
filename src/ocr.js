/**
 * Распознаёт данные паспорта через Claude API (vision).
 * Возвращает { surname, name, patronymic, dob }
 */
export async function extractPassportData(imageDataUrl, apiKey) {
  const [header, base64Data] = imageDataUrl.split(',')
  const mediaType = header.match(/:(.*?);/)[1] || 'image/jpeg'

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
      max_tokens: 256,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: mediaType, data: base64Data },
            },
            {
              type: 'text',
              text: `Это фото страницы российского паспорта. Извлеки данные владельца.
Верни ТОЛЬКО JSON — без пояснений, без markdown:
{"surname":"ФАМИЛИЯ","name":"ИМЯ","patronymic":"ОТЧЕСТВО","dob":"ДД.ММ.ГГГГ"}
Если поле не читается — пустая строка. Все имена заглавными буквами.`,
            },
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

  const match = raw.match(/\{[\s\S]*?\}/)
  if (!match) throw new Error('Не удалось распознать данные паспорта')

  try {
    return JSON.parse(match[0])
  } catch {
    throw new Error('Ошибка разбора ответа API')
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
