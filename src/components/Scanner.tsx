/**
 * Scanner — компонент распознавания документов с камеры или файла.
 *
 * Использование в Next.js:
 *   import Scanner from '@/components/Scanner'
 *   <Scanner onResult={(data) => console.log(data)} />
 *
 * Требует tessdata в public/tessdata/{rus,eng}.traineddata
 */

'use client'

import React, {
  useRef, useState, useEffect, useCallback,
  type ChangeEvent,
} from 'react'
import {
  analyzeFrame, preprocessFrame, preprocessFile,
  type FrameFeedback, type PreprocessedFrame,
} from '../utils/imageProcessor'
import { ocrManager, StabilityChecker } from '../utils/ocr'
import {
  parseMRZ, mergeResults,
  type DocumentData,
} from '../utils/documentParser'

// ── Config ────────────────────────────────────────────────────────────────────

const SCAN_INTERVAL_MS    = 900   // интервал захвата кадра для OCR
const FEEDBACK_INTERVAL   = 200   // интервал быстрого анализа (блики / темнота)
const STABILITY_REQUIRED  = 2     // сколько одинаковых результатов для уверенности
const DOC_ASPECT          = 1.42  // ширина / высота паспорта (ISO 7810 ID-3 ≈ 125×88мм)

// ── Feedback labels / colors ──────────────────────────────────────────────────

const FEEDBACK_LABEL: Record<FrameFeedback, string> = {
  ok:           'Хорошо — держите ровно',
  too_dark:     'Слишком темно — найдите лучшее освещение',
  glare_mild:   'Небольшие блики — слегка измените угол',
  glare_strong: 'Сильные блики — измените угол камеры',
}

const FEEDBACK_COLOR: Record<FrameFeedback, string> = {
  ok:           '#22c55e',
  too_dark:     '#f59e0b',
  glare_mild:   '#f59e0b',
  glare_strong: '#ef4444',
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface ScannerProps {
  onResult?: (data: DocumentData) => void
}

type Mode = 'camera' | 'file'

// ── Component ─────────────────────────────────────────────────────────────────

export default function Scanner({ onResult }: ScannerProps) {
  const videoRef      = useRef<HTMLVideoElement>(null)
  const overlayRef    = useRef<HTMLCanvasElement>(null)
  const streamRef     = useRef<MediaStream | null>(null)
  const processingRef = useRef(false)
  const stabilityRef  = useRef(
    new StabilityChecker<DocumentData>(
      STABILITY_REQUIRED,
      d => `${d.surname}|${d.name}|${d.dateOfBirth}`,
    )
  )

  const [mode,         setMode]         = useState<Mode>('camera')
  const [cameraActive, setCameraActive] = useState(false)
  const [cameraError,  setCameraError]  = useState<string | null>(null)
  const [feedback,     setFeedback]     = useState<FrameFeedback>('ok')
  const [ocrProgress,  setOcrProgress]  = useState(0)
  const [result,       setResult]       = useState<DocumentData | null>(null)
  const [showRaw,      setShowRaw]      = useState(false)
  const [warmingUp,    setWarmingUp]    = useState(false)

  // ── Camera ──────────────────────────────────────────────────────────────────

  const startCamera = useCallback(async () => {
    setCameraError(null)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: 'environment',
          width:  { ideal: 1920 },
          height: { ideal: 1080 },
        },
      })
      streamRef.current = stream
      const video = videoRef.current
      if (video) {
        video.srcObject = stream
        await video.play()
        setCameraActive(true)
      }
    } catch (err) {
      setCameraError('Нет доступа к камере: ' + (err as Error).message)
    }
  }, [])

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach(t => t.stop())
    streamRef.current = null
    setCameraActive(false)
  }, [])

  useEffect(() => {
    if (mode === 'camera') startCamera()
    else stopCamera()
    return stopCamera
  }, [mode, startCamera, stopCamera])

  // ── Warmup workers on mount ──────────────────────────────────────────────────

  useEffect(() => {
    setWarmingUp(true)
    ocrManager.warmup().finally(() => setWarmingUp(false))
    return () => { ocrManager.terminate() }
  }, [])

  // ── Canvas overlay (requestAnimationFrame loop) ───────────────────────────────

  useEffect(() => {
    if (!cameraActive) return
    let animId: number
    const draw = () => {
      const video  = videoRef.current
      const canvas = overlayRef.current
      if (video && canvas) {
        canvas.width  = video.clientWidth
        canvas.height = video.clientHeight
        drawOverlay(canvas.getContext('2d')!, canvas.width, canvas.height, feedback)
      }
      animId = requestAnimationFrame(draw)
    }
    animId = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(animId)
  }, [cameraActive, feedback])

  // ── Fast feedback loop (brightness / glare check) ────────────────────────────

  useEffect(() => {
    if (!cameraActive) return
    const id = setInterval(() => {
      const video = videoRef.current
      if (video && video.readyState >= 2) {
        const { feedback: fb } = analyzeFrame(video)
        setFeedback(fb)
      }
    }, FEEDBACK_INTERVAL)
    return () => clearInterval(id)
  }, [cameraActive])

  // ── OCR scan loop ─────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!cameraActive) return
    const id = setInterval(async () => {
      const video = videoRef.current
      if (!video || video.readyState < 2 || processingRef.current || warmingUp) return
      if (feedback === 'glare_strong') return  // блики → пропускаем
      processingRef.current = true
      try {
        const frame = await preprocessFrame(video)
        const data  = await runOCR(frame, setOcrProgress)
        const { stable, value } = stabilityRef.current.push(data)
        if (stable) {
          setResult(value)
          onResult?.(value)
          stabilityRef.current.reset()
        }
      } finally {
        processingRef.current = false
        setTimeout(() => setOcrProgress(0), 600)
      }
    }, SCAN_INTERVAL_MS)
    return () => clearInterval(id)
  }, [cameraActive, feedback, warmingUp, onResult])

  // ── File upload ───────────────────────────────────────────────────────────────

  const handleFile = useCallback(async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setOcrProgress(5)
    try {
      const frame = await preprocessFile(file)
      const data  = await runOCR(frame, setOcrProgress)
      setResult(data)
      onResult?.(data)
    } catch (err) {
      console.error('[Scanner] file error:', err)
    } finally {
      setTimeout(() => setOcrProgress(0), 600)
    }
  }, [onResult])

  // ── Render ────────────────────────────────────────────────────────────────────

  return (
    <div style={css.root}>

      {/* Mode toggle */}
      <div style={css.modeRow}>
        {(['camera', 'file'] as Mode[]).map(m => (
          <button
            key={m}
            style={{ ...css.modeBtn, ...(mode === m ? css.modeBtnActive : {}) }}
            onClick={() => setMode(m)}
          >
            {m === 'camera' ? 'Камера' : 'Файл'}
          </button>
        ))}
      </div>

      {/* Camera viewport */}
      {mode === 'camera' && (
        <div style={css.viewport}>
          {cameraError ? (
            <p style={css.error}>{cameraError}</p>
          ) : (
            <>
              <video ref={videoRef} playsInline muted style={css.video} />
              <canvas ref={overlayRef} style={css.canvas} />

              {/* Feedback badge */}
              <div style={{ ...css.badge, background: FEEDBACK_COLOR[feedback] }}>
                {warmingUp ? '⟳ Загрузка моделей…' : FEEDBACK_LABEL[feedback]}
              </div>

              {/* OCR progress bar */}
              {ocrProgress > 0 && ocrProgress < 100 && (
                <div style={css.progressTrack}>
                  <div style={{ ...css.progressFill, width: `${ocrProgress}%` }} />
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* File upload */}
      {mode === 'file' && (
        <label style={css.uploadZone}>
          <span style={{ fontSize: 36 }}>📄</span>
          <span>Загрузить фото документа</span>
          <span style={{ fontSize: 12, color: '#64748b' }}>паспорт РФ, загранпаспорт, ID-карта</span>
          <input type="file" accept="image/*" onChange={handleFile} style={{ display: 'none' }} />
          {ocrProgress > 0 && ocrProgress < 100 && (
            <div style={{ ...css.progressTrack, position: 'relative', marginTop: 12, borderRadius: 4 }}>
              <div style={{ ...css.progressFill, width: `${ocrProgress}%` }} />
            </div>
          )}
        </label>
      )}

      {/* Result card */}
      {result && (
        <div style={css.card}>
          <div style={css.cardHeader}>
            <span style={{ color: result.mrzValid ? '#22c55e' : '#f59e0b' }}>
              {result.mrzValid ? '✓ MRZ валидна' : '⚠ Визуальный разбор'}
            </span>
            <button onClick={() => { setResult(null); stabilityRef.current.reset() }} style={css.closeBtn}>✕</button>
          </div>

          <div style={css.fieldsGrid}>
            <Field label="Фамилия"         value={result.surname} />
            <Field label="Имя"             value={result.name} />
            <Field label="Отчество"        value={result.patronymic} />
            <Field label="Дата рождения"   value={result.dateOfBirth} />
            <Field label="Пол"             value={result.gender} />
            <Field label="Документ №"      value={result.documentNumber} />
            <Field label="Дата выдачи"     value={result.issuedDate} />
            <Field label="Действителен до" value={result.expiryDate} />
            <Field label="Гражданство"     value={result.citizenship} />
          </div>

          {result.mrzLine1 && (
            <div style={css.mrzBlock}>
              <div style={css.mrzLine}>{result.mrzLine1}</div>
              <div style={css.mrzLine}>{result.mrzLine2}</div>
            </div>
          )}

          {result.rawOcr && (
            <>
              <button style={css.debugBtn} onClick={() => setShowRaw(v => !v)}>
                {showRaw ? '▲ Скрыть' : '▼ Сырой OCR-текст'}
              </button>
              {showRaw && <pre style={css.rawPre}>{result.rawOcr}</pre>}
            </>
          )}
        </div>
      )}
    </div>
  )
}

// ── Field ─────────────────────────────────────────────────────────────────────

function Field({ label, value }: { label: string; value: string }) {
  if (!value) return null
  return (
    <div style={css.fieldRow}>
      <span style={css.fieldLabel}>{label}</span>
      <span style={css.fieldValue}>{value}</span>
    </div>
  )
}

// ── OCR pipeline ──────────────────────────────────────────────────────────────

async function runOCR(
  frame: PreprocessedFrame,
  onProgress: (pct: number) => void,
): Promise<DocumentData> {
  // Единственный проход: MRZ-зона, crop ПЕРВЫМ + upscale x3, eng + whitelist
  onProgress(20)
  const mrzResult = await ocrManager.recognizeMRZ(frame.mrzProcessedDataUrl)
  onProgress(90)
  const mrzData = parseMRZ(mrzResult.text)
  onProgress(100)
  return mergeResults(mrzData, {}, mrzResult.text)
}

// ── Canvas overlay ─────────────────────────────────────────────────────────────

function drawOverlay(
  ctx: CanvasRenderingContext2D,
  vw: number, vh: number,
  feedback: FrameFeedback,
): void {
  // Документ: 70% ширины вьюпорта, соотношение DOC_ASPECT
  const docW = Math.round(vw * 0.70)
  const docH = Math.round(docW / DOC_ASPECT)
  const docX = (vw - docW) / 2
  const docY = (vh - docH) / 2

  ctx.clearRect(0, 0, vw, vh)

  // Тёмный оверлей с прозрачным вырезом для документа
  ctx.fillStyle = 'rgba(0,0,0,0.52)'
  ctx.fillRect(0, 0, vw, vh)
  ctx.globalCompositeOperation = 'destination-out'
  rrect(ctx, docX, docY, docW, docH, 14)
  ctx.fill()
  ctx.globalCompositeOperation = 'source-over'

  // Рамка документа
  ctx.strokeStyle = FEEDBACK_COLOR[feedback]
  ctx.lineWidth   = 3
  rrect(ctx, docX, docY, docW, docH, 14)
  ctx.stroke()

  // Угловые скобки
  const bL = 32, bW = 4
  ctx.strokeStyle = '#ffffff'
  ctx.lineWidth   = bW
  const corners = [
    [docX,        docY,        1,  1],
    [docX + docW, docY,       -1,  1],
    [docX,        docY + docH, 1, -1],
    [docX + docW, docY + docH,-1, -1],
  ] as [number, number, number, number][]

  corners.forEach(([x, y, sx, sy]) => {
    ctx.beginPath()
    ctx.moveTo(x + sx * bL, y)
    ctx.lineTo(x, y)
    ctx.lineTo(x, y + sy * bL)
    ctx.stroke()
  })
}

function rrect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.lineTo(x + w - r, y)
  ctx.quadraticCurveTo(x + w, y,     x + w, y + r)
  ctx.lineTo(x + w, y + h - r)
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h)
  ctx.lineTo(x + r, y + h)
  ctx.quadraticCurveTo(x, y + h, x, y + h - r)
  ctx.lineTo(x, y + r)
  ctx.quadraticCurveTo(x, y, x + r, y)
  ctx.closePath()
}

// ── Styles ─────────────────────────────────────────────────────────────────────

const css: Record<string, React.CSSProperties> = {
  root: {
    maxWidth: 540, margin: '0 auto', padding: 16,
    fontFamily: 'system-ui, -apple-system, sans-serif',
    color: '#e2e8f0', background: '#0f172a', minHeight: '100vh',
  },
  modeRow: { display: 'flex', gap: 8, marginBottom: 12 },
  modeBtn: {
    flex: 1, padding: '9px 0', borderRadius: 8, cursor: 'pointer',
    border: '1px solid #334155', background: '#1e293b', color: '#94a3b8',
    fontSize: 14, fontWeight: 500, transition: 'all 0.15s',
  },
  modeBtnActive: { background: '#3b82f6', borderColor: '#3b82f6', color: '#fff' },
  viewport: {
    position: 'relative', borderRadius: 12, overflow: 'hidden',
    background: '#000', aspectRatio: '4/3',
  },
  video:  { width: '100%', height: '100%', objectFit: 'cover', display: 'block' },
  canvas: { position: 'absolute', inset: 0, pointerEvents: 'none' },
  badge:  {
    position: 'absolute', bottom: 16, left: '50%', transform: 'translateX(-50%)',
    padding: '5px 18px', borderRadius: 20, fontSize: 13, fontWeight: 600,
    color: '#fff', whiteSpace: 'nowrap', transition: 'background 0.25s',
  },
  progressTrack: { position: 'absolute', bottom: 0, left: 0, right: 0, height: 3, background: '#1e293b' },
  progressFill:  { height: '100%', background: '#3b82f6', transition: 'width 0.2s ease' },
  error:         { padding: 32, textAlign: 'center', color: '#f87171' },
  uploadZone:    {
    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
    gap: 8, border: '2px dashed #334155', borderRadius: 12, padding: '40px 20px',
    cursor: 'pointer', textAlign: 'center', color: '#94a3b8', marginBottom: 16,
  },
  card:          { marginTop: 16, background: '#1e293b', borderRadius: 12, padding: 16 },
  cardHeader:    {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    marginBottom: 10, fontSize: 13, fontWeight: 600,
  },
  closeBtn:      { background: 'none', border: 'none', color: '#64748b', cursor: 'pointer', fontSize: 18 },
  fieldsGrid:    { display: 'flex', flexDirection: 'column', gap: 0 },
  fieldRow:      { display: 'flex', justifyContent: 'space-between', padding: '7px 0', borderBottom: '1px solid #0f172a' },
  fieldLabel:    { color: '#64748b', fontSize: 13 },
  fieldValue:    { color: '#e2e8f0', fontSize: 13, fontWeight: 500, textAlign: 'right' },
  mrzBlock:      { marginTop: 12, background: '#0f172a', borderRadius: 6, padding: '8px 10px' },
  mrzLine:       { fontFamily: 'monospace', fontSize: 11, color: '#475569', letterSpacing: 1, lineHeight: 1.6 },
  debugBtn:      { background: 'none', border: 'none', color: '#475569', cursor: 'pointer', fontSize: 12, padding: '6px 0', marginTop: 6 },
  rawPre:        { fontSize: 10, color: '#475569', whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: 200, overflow: 'auto', marginTop: 4 },
}
