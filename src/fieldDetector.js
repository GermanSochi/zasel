import * as ort from 'onnxruntime-web'

ort.env.wasm.wasmPaths = '/zasel/ort/'
ort.env.wasm.numThreads = 1

const MODEL_URL  = '/zasel/models/textfields.onnx'
const INPUT_SIZE = 640
const CONF       = 0.7
const IOU        = 0.2
const N_CLS      = 22
// class index → field name
const TARGET = new Map([[1, 'surname'], [2, 'name'], [17, 'patronymic']])

let _p = null

export function initTextFieldsModel() {
  if (!_p) {
    _p = ort.InferenceSession.create(MODEL_URL, { executionProviders: ['wasm'] })
    _p.then(() => console.log('[ONNX] TextFields загружен'))
      .catch(e => { console.error('[ONNX] TextFields ошибка:', e); _p = null })
  }
  return _p
}

// Letterbox: canvas → float32 NHWC [1,640,640,3] с паддингом 114
function letterbox(canvas) {
  const sw = canvas.width, sh = canvas.height
  const r   = Math.min(INPUT_SIZE / sw, INPUT_SIZE / sh)
  const nw  = Math.round(sw * r), nh = Math.round(sh * r)
  const dw  = (INPUT_SIZE - nw) / 2  // float — используется для unscaling
  const dh  = (INPUT_SIZE - nh) / 2
  const pl  = Math.round(dw - 0.1)   // integer — для drawImage
  const pt  = Math.round(dh - 0.1)

  const c = document.createElement('canvas')
  c.width = INPUT_SIZE; c.height = INPUT_SIZE
  const ctx = c.getContext('2d')
  ctx.fillStyle = 'rgb(114,114,114)'
  ctx.fillRect(0, 0, INPUT_SIZE, INPUT_SIZE)
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(canvas, pl, pt, nw, nh)

  const px   = ctx.getImageData(0, 0, INPUT_SIZE, INPUT_SIZE).data
  const flat = new Float32Array(INPUT_SIZE * INPUT_SIZE * 3)
  for (let i = 0; i < INPUT_SIZE * INPUT_SIZE; i++) {
    flat[i*3]   = px[i*4]
    flat[i*3+1] = px[i*4+1]
    flat[i*3+2] = px[i*4+2]
  }
  return { flat, r, dw, dh }
}

function calcIou(a, b) {
  const x1 = Math.max(a[0], b[0]), y1 = Math.max(a[1], b[1])
  const x2 = Math.min(a[2], b[2]), y2 = Math.min(a[3], b[3])
  const inter = Math.max(0, x2-x1) * Math.max(0, y2-y1)
  const u = (a[2]-a[0])*(a[3]-a[1]) + (b[2]-b[0])*(b[3]-b[1]) - inter
  return u > 0 ? inter / u : 0
}

function nms(dets) {
  dets.sort((a, b) => b.score - a.score)
  const kept = [], suppressed = new Set()
  for (let i = 0; i < dets.length; i++) {
    if (suppressed.has(i)) continue
    kept.push(dets[i])
    for (let j = i+1; j < dets.length; j++) {
      if (!suppressed.has(j) && calcIou(dets[i].box, dets[j].box) >= IOU)
        suppressed.add(j)
    }
  }
  return kept
}

// Возвращает { surname?, name?, patronymic? } — каждое: {x1,y1,x2,y2,conf}
export async function detectFields(canvas) {
  const session = await initTextFieldsModel()
  const { flat, r, dw, dh } = letterbox(canvas)

  const input   = new ort.Tensor('float32', flat, [1, INPUT_SIZE, INPUT_SIZE, 3])
  const outputs = await session.run({ Image_input: input })
  const raw     = Object.values(outputs)[0].data  // Float32Array [1*8400*26]

  const byClass = {}
  for (let i = 0; i < 8400; i++) {
    const b  = i * 26
    const cx = raw[b], cy = raw[b+1], bw = raw[b+2], bh = raw[b+3]
    let bestCls = -1, bestScore = 0
    for (let c = 0; c < N_CLS; c++) {
      const s = raw[b+4+c]
      if (s > bestScore) { bestScore = s; bestCls = c }
    }
    if (bestScore < CONF || !TARGET.has(bestCls)) continue
    const box = [cx-bw/2, cy-bh/2, cx+bw/2, cy+bh/2]
    ;(byClass[bestCls] ||= []).push({ box, score: bestScore })
  }

  const result = {}
  for (const [cls, field] of TARGET) {
    const dets = byClass[cls]
    if (!dets?.length) continue
    const best = nms(dets)[0]
    const [x1, y1, x2, y2] = best.box
    result[field] = {
      x1: Math.max(0, Math.round((x1-dw)/r)),
      y1: Math.max(0, Math.round((y1-dh)/r)),
      x2: Math.min(canvas.width,  Math.round((x2-dw)/r)),
      y2: Math.min(canvas.height, Math.round((y2-dh)/r)),
      conf: best.score,
    }
  }
  console.log('[ONNX] поля найдены:', JSON.stringify(
    Object.fromEntries(Object.entries(result).map(([k,v]) => [k, `(${v.x1},${v.y1})-(${v.x2},${v.y2}) ${(v.conf*100).toFixed(0)}%`]))
  ))
  return result
}
