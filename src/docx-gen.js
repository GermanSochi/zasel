import {
  Document,
  Paragraph,
  Table,
  TableRow,
  TableCell,
  TextRun,
  WidthType,
  AlignmentType,
  Packer,
  BorderStyle,
  HeightRule,
  VerticalAlign,
} from 'docx'
import { saveAs } from 'file-saver'

const FONT = 'Calibri'

function cell(text, opts = {}) {
  const {
    bold = false,
    fontSize = 20,
    width,
    center = false,
  } = opts

  return new TableCell({
    width: width ? { size: width, type: WidthType.DXA } : undefined,
    verticalAlign: VerticalAlign.CENTER,
    margins: { left: 114, right: 114, top: 0, bottom: 0 },
    borders: {
      top:    { style: BorderStyle.SINGLE, size: 4, color: '000000' },
      bottom: { style: BorderStyle.SINGLE, size: 4, color: '000000' },
      left:   { style: BorderStyle.SINGLE, size: 4, color: '000000' },
      right:  { style: BorderStyle.SINGLE, size: 4, color: '000000' },
    },
    children: [
      new Paragraph({
        alignment: center ? AlignmentType.CENTER : AlignmentType.LEFT,
        spacing: { after: 160, line: 259, lineRule: 'auto' },
        children: [
          new TextRun({
            text,
            font: FONT,
            size: fontSize,
            bold,
          }),
        ],
      }),
    ],
  })
}

function para(text, { fontSize = 24, center = false } = {}) {
  return new Paragraph({
    alignment: center ? AlignmentType.CENTER : AlignmentType.LEFT,
    spacing: { after: 160, line: 259, lineRule: 'auto' },
    children: [
      new TextRun({ text, font: FONT, size: fontSize }),
    ],
  })
}

function formatDate(isoOrDot) {
  if (!isoOrDot) return ''
  if (isoOrDot.includes('-')) {
    const [y, m, d] = isoOrDot.split('-')
    return `${d}.${m}.${y}`
  }
  return isoOrDot
}

export async function generateDocument(persons, arrivalDate) {
  const headerRow = new TableRow({
    tableHeader: true,
    height: { value: 400, rule: HeightRule.ATLEAST },
    children: [
      cell('№ п/п',        { width: 993,  center: true }),
      cell('фамилия',      { width: 1842, center: true }),
      cell('имя',          { width: 1985, center: true }),
      cell('отчество',     { width: 1843, center: true }),
      cell('Дата прибытия',{ width: 1803, center: true }),
      cell('специальность',{ width: 1882, center: true }),
    ],
  })

  const dataRows = persons.map((p, i) =>
    new TableRow({
      height: { value: 400, rule: HeightRule.ATLEAST },
      children: [
        cell(String(i + 1),             { width: 993,  center: true }),
        cell(p.surname || '',           { width: 1842 }),
        cell(p.name || '',              { width: 1985 }),
        cell(p.patronymic || '',        { width: 1843 }),
        cell(formatDate(arrivalDate),   { width: 1803, center: true }),
        cell(p.specialty || '',         { width: 1882 }),
      ],
    })
  )

  const extraRows = []
  for (let i = persons.length; i < Math.max(persons.length, 2); i++) {
    extraRows.push(
      new TableRow({
        height: { value: 400, rule: HeightRule.ATLEAST },
        children: [
          cell(String(i + 1), { width: 993,  center: true }),
          cell('',            { width: 1842 }),
          cell('',            { width: 1985 }),
          cell('',            { width: 1843 }),
          cell('',            { width: 1803 }),
          cell('',            { width: 1882 }),
        ],
      })
    )
  }

  const table = new Table({
    width: { size: 0, type: WidthType.AUTO },
    indent: { size: 114, type: WidthType.DXA },
    rows: [headerRow, ...dataRows, ...extraRows],
  })

  const doc = new Document({
    sections: [
      {
        properties: {},
        children: [
          para('ИП Калгунов Сергей Михайлович', { fontSize: 32, center: true }),
          para('', { fontSize: 24, center: true }),
          para('Список сотрудников от Компании ИП Калгунов С.М.', { fontSize: 24, center: true }),
          para('Направляемых для оказания услуг ООО "ЛесРесорт"', { fontSize: 24, center: true }),
          table,
          para(''),
          new Paragraph({
            alignment: AlignmentType.LEFT,
            spacing: { after: 160, line: 259, lineRule: 'auto' },
            children: [
              new TextRun({ text: 'ИП Калгунов С.М', font: FONT, size: 24 }),
              new TextRun({ text: '\t_____________/ С.М. Калгунов /', font: FONT, size: 24 }),
            ],
          }),
        ],
      },
    ],
  })

  const blob = await Packer.toBlob(doc)
  const dateStr = formatDate(arrivalDate) || 'Заселение'
  saveAs(blob, `Заселение_${dateStr}.docx`)
}
