export const inventoryImportLimit = 500
export const inventoryFileLimit = 256 * 1024

export function validateInventoryCodes(codes: string[]) {
  if (!codes.length) throw new Error('请至少填写一个兑换码')
  if (codes.length > inventoryImportLimit) throw new Error('每次最多导入 500 个兑换码，请分批导入')
  return codes.map((value, index) => {
    const code = value.trim()
    if (code.length < 8 || code.length > 200 || /[\r\n\x00-\x1f\x7f]/.test(code))
      throw new Error(`第 ${index + 1} 个兑换码格式不正确，应为 8–200 个字符`)
    return code
  })
}

export function parseInventoryText(text: string) {
  return validateInventoryCodes(
    text
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean),
  )
}

// AICDK batch exports use a single `code` column. Parse CSV before extracting
// cells so headers, quoted commas and escaped quotes never become extra cards.
export function parseAicdkCSV(text: string) {
  if (new TextEncoder().encode(text).length > inventoryFileLimit)
    throw new Error('CSV 文件不能超过 256 KB')
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  let closed = false
  const source = text.replace(/^\uFEFF/, '')
  const endCell = () => {
    row.push(cell)
    cell = ''
    closed = false
  }
  for (let i = 0; i < source.length; i++) {
    const ch = source[i]
    if (quoted) {
      if (ch !== '"') cell += ch
      else if (source[i + 1] === '"') {
        cell += '"'
        i++
      } else {
        quoted = false
        closed = true
      }
    } else if (ch === ',') endCell()
    else if (ch === '\n' || ch === '\r') {
      endCell()
      rows.push(row)
      row = []
      if (ch === '\r' && source[i + 1] === '\n') i++
    } else if (ch === '"' && cell === '' && !closed) quoted = true
    else {
      if (closed || ch === '"') throw new Error('CSV 引号格式错误，请重新从 AICDK 导出')
      cell += ch
    }
  }
  if (quoted) throw new Error('CSV 引号未闭合，请重新从 AICDK 导出')
  if (cell || row.length || closed) {
    endCell()
    rows.push(row)
  }
  if (rows[0]?.length !== 1 || rows[0][0].trim().toLowerCase() !== 'code')
    throw new Error('请选择 AICDK 导出的 CSV，表头应为单列 code')
  const codes = rows.slice(1).map((cells, index) => {
    if (cells.length !== 1 || !cells[0].trim())
      throw new Error(`CSV 第 ${index + 2} 行为空或包含多余列，请检查后重试`)
    return cells[0]
  })
  return validateInventoryCodes(codes)
}
