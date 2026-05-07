import * as ort from 'onnxruntime-web'

// ort.env.wasm уже настроен в fieldDetector.js

const MODEL_URL = '/zasel/models/ocr_rus.onnx'
const ALPHABET  = 'АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ.-'
const TH = 31, TW = 200

let _p = null

export function initOcrRusModel() {
  if (!_p) {
    _p = ort.InferenceSession.create(MODEL_URL, { executionProviders: ['wasm'] })
    _p.then(() => console.log('[ONNX] OCR RUS загружен'))
      .catch(e => { console.error('[ONNX] OCR RUS ошибка:', e); _p = null })
  }
  return _p
}

// Подготовка кропа: grayscale → resize+pad → float32 [1,31,200,1] [0-255]
function preprocessCrop(canvas, x1, y1, x2, y2) {
  const cw = Math.max(1, x2 - x1), ch = Math.max(1, y2 - y1)

  // Оригинальный кроп → получаем цвет фона из последнего пикселя
  const origC = document.createElement('canvas')
  origC.width = cw; origC.height = ch
  const origCtx = origC.getContext('2d')
  origCtx.drawImage(canvas, x1, y1, cw, ch, 0, 0, cw, ch)
  const corner = origCtx.getImageData(cw-1, ch-1, 1, 1).data
  const bg = Math.round(0.299*corner[0] + 0.587*corner[1] + 0.114*corner[2])

  // Вычисляем новые размеры (сохраняем пропорции, H≤31, W≤200)
  let newH = TH
  let newW = Math.floor(cw * (newH / ch))
  if (newW > TW) {
    newW = TW
    newH = Math.floor(ch * (newW / cw))
  }
  newH = Math.max(1, newH); newW = Math.max(1, newW)

  // Ресайз через canvas
  const resC = document.createElement('canvas')
  resC.width = newW; resC.height = newH
  const resCtx = resC.getContext('2d')
  resCtx.imageSmoothingEnabled = true
  resCtx.imageSmoothingQuality = 'high'
  resCtx.drawImage(canvas, x1, y1, cw, ch, 0, 0, newW, newH)
  const resData = resCtx.getImageData(0, 0, newW, newH).data

  // Тензор [1, TH, TW, 1], заполнен bg (паддинг справа и снизу)
  const tensor = new Float32Array(TH * TW).fill(bg)
  for (let y = 0; y < newH; y++) {
    for (let x = 0; x < newW; x++) {
      const i = (y * newW + x) * 4
      const g = Math.round(0.299*resData[i] + 0.587*resData[i+1] + 0.114*resData[i+2])
      tensor[y * TW + x] = g
    }
  }
  return tensor
}

// Распознать текст в bbox на canvas
export async function ocrField(canvas, bbox) {
  const session = await initOcrRusModel()
  const tensor  = preprocessCrop(canvas, bbox.x1, bbox.y1, bbox.x2, bbox.y2)

  const input   = new ort.Tensor('float32', tensor, [1, TH, TW, 1])
  const outputs = await session.run({ input_1: input })
  const raw     = Object.values(outputs)[0].data  // BigInt64Array [1*50]

  let text = ''
  for (const bigIdx of raw) {
    const i = Number(bigIdx)
    if (i >= 0 && i < ALPHABET.length) text += ALPHABET[i]
  }
  return text.replace(/^\.+/, '').trim()
}
