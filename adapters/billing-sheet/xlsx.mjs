// Reads an .xlsx download of the billing dashboard into the same value grids Apps Script's
// Range.getValues() returns: numbers, strings, booleans, Dates, and '' for empty cells.
import ExcelJS from 'exceljs';

function cellValue(cell) {
  if (cell.isMerged && cell.master && cell.master.address !== cell.address) return '';  // getValues gives '' off the top-left
  let v = cell.value;
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v;
  if (typeof v === 'object') {
    // Formula: use the cached result. Google's .xlsx export leaves the cached value out when a
    // formula comes to 0 (e.g. a SUMIF with no matches), where getValues() gives 0.
    if ('formula' in v || 'sharedFormula' in v) v = 'result' in v ? v.result : 0;
    else if ('result' in v) v = v.result;
    else if ('richText' in v) return v.richText.map((t) => t.text).join('');
    else if ('text' in v) return v.text;                   // hyperlink
    else if ('error' in v) return v.error;
    if (v === null || v === undefined) return '';
    if (typeof v === 'object' && 'error' in v) return v.error;
  }
  return v;
}

function grid(ws, rows, cols) {
  const out = [];
  for (let r = 1; r <= rows; r++) {
    const row = [];
    for (let c = 1; c <= cols; c++) row.push(cellValue(ws.getCell(r, c)));
    out.push(row);
  }
  return out;
}

/** Last row and column that hold a value, like getDataRange(). */
function extent(ws) {
  let rows = 0, cols = 0;
  ws.eachRow({ includeEmpty: false }, (row, r) => {
    row.eachCell({ includeEmpty: false }, (cell, c) => {
      if (cellValue(cell) !== '') { rows = Math.max(rows, r); cols = Math.max(cols, c); }
    });
  });
  return { rows, cols };
}

/**
 * Mirrors the Margin Board's readBilling_(): the whole MSTR tab, plus the top-left 12x8 of every
 * tab whose name starts with a job number.
 * @returns {{ mstr: any[][], tabs: Record<string, any[][]> }}
 */
export async function readBillingWorkbook(file, { mstrTab }) {
  if (!mstrTab) throw new Error("readBillingWorkbook: pass the summary tab name (the board config's BILLING_TAB).");
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const sheet = wb.getWorksheet(mstrTab);
  if (!sheet) throw new Error(`Billing dashboard has no "${mstrTab}" tab.`);
  const { rows, cols } = extent(sheet);
  const tabs = {};
  wb.eachSheet((ws) => { if (/^\s*\d+/.test(ws.name)) tabs[ws.name] = grid(ws, 12, 8); });
  return { mstr: grid(sheet, rows, cols), tabs };
}
