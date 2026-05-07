/**
 * OCR-менеджер: два воркера Tesseract.js
 *  - mainWorker: rus+eng  — визуальный текст
 *  - mrzWorker:  eng + whitelist  — MRZ-зона
 *
 * StabilityChecker: требует N одинаковых результатов подряд.
 */

import { createWorker, type Worker } from 'tesseract.js'

// Путь к tessdata в Next.js public/ (изменить если нужно)
const LANG_PATH   = '/tessdata'
const MRZ_WHITELIST = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789<'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface OcrResult {
  text: string
  confidence: number
}

// ── OcrManager ────────────────────────────────────────────────────────────────

class OcrManager {
  private mainWorker: Worker | null = null
  private mrzWorker:  Worker | null = null

  /** Разогрев: инициализировать оба воркера заранее */
  async warmup(): Promise<void> {
    await Promise.all([this.ensureMainWorker(), this.ensureMrzWorker()])
  }

  /**
   * Визуальный текст (Кириллица + латиница).
   * Медленнее (~3–5 с), но охватывает весь документ.
   */
  async recognizeVisual(
    dataUrl: string,
    onProgress?: (pct: number) => void,
  ): Promise<OcrResult> {
    const w = await this.ensureMainWorker(onProgress)
    const { data } = await w.recognize(dataUrl)
    return { text: data.text, confidence: data.confidence }
  }

  /**
   * MRZ-зона: eng + символьный whitelist.
   * Быстро (~0.5–1 с), высокая точность на строчках MRZ.
   */
  async recognizeMRZ(cropDataUrl: string): Promise<OcrResult> {
    const w = await this.ensureMrzWorker()
    const { data } = await w.recognize(cropDataUrl)
    return { text: data.text, confidence: data.confidence }
  }

  async terminate(): Promise<void> {
    await Promise.all([
      this.mainWorker?.terminate(),
      this.mrzWorker?.terminate(),
    ])
    this.mainWorker = null
    this.mrzWorker  = null
  }

  private async ensureMainWorker(onProgress?: (n: number) => void): Promise<Worker> {
    if (this.mainWorker) return this.mainWorker
    this.mainWorker = await createWorker('rus+eng', 1, {
      langPath: LANG_PATH,
      logger: m => {
        if (onProgress && m.status === 'recognizing text')
          onProgress(Math.round(m.progress * 100))
      },
    })
    return this.mainWorker
  }

  private async ensureMrzWorker(): Promise<Worker> {
    if (this.mrzWorker) return this.mrzWorker
    this.mrzWorker = await createWorker('eng', 1, { langPath: LANG_PATH })
    await this.mrzWorker.setParameters({
      tessedit_char_whitelist: MRZ_WHITELIST,
      // PSM 6 — однородный блок текста (MRZ — строки фиксированной ширины)
      tessedit_pageseg_mode: '6',
    })
    return this.mrzWorker
  }
}

export const ocrManager = new OcrManager()

// ── StabilityChecker ──────────────────────────────────────────────────────────

/**
 * Буфер стабильности: принимает результаты OCR, выдаёт `stable=true`
 * только если `required` последних результатов дали одинаковый ключ.
 *
 * @example
 * const checker = new StabilityChecker<DocumentData>(2, d => `${d.surname}|${d.name}|${d.dateOfBirth}`)
 * const { stable, value } = checker.push(parsed)
 * if (stable) showResult(value)
 */
export class StabilityChecker<T> {
  private readonly history: Array<{ key: string; value: T }> = []

  constructor(
    private readonly required: number,
    private readonly keyFn: (v: T) => string,
  ) {}

  push(value: T): { stable: boolean; value: T } {
    const key = this.keyFn(value)
    this.history.push({ key, value })
    // Окно: максимум required*2 записей
    if (this.history.length > this.required * 2) this.history.shift()

    // Считаем вхождения каждого ключа
    const counts = new Map<string, { count: number; value: T }>()
    for (const h of this.history) {
      const prev = counts.get(h.key)
      counts.set(h.key, { count: (prev?.count ?? 0) + 1, value: h.value })
    }
    for (const [, entry] of counts) {
      if (entry.count >= this.required)
        return { stable: true, value: entry.value }
    }
    return { stable: false, value }
  }

  reset(): void {
    this.history.length = 0
  }
}
