import * as XLSX from 'xlsx';

export type ConvertedBarcodeItem = {
  barcode: string;
  name: string;
  rowNumber: number;
};

export type ConvertedBarcodeSummary = {
  fileName: string;
  importedAt: string;
  recordCount: number;
  skippedRows: number;
};

export type ConvertedBarcodeResult = {
  items: ConvertedBarcodeItem[];
  summary: ConvertedBarcodeSummary;
  warnings: string[];
};

const CODE_HEADER_ALIASES = ['상품코드', '바코드', 'barcode', 'productcode', 'code'];
const NAME_HEADER_ALIASES = ['상품명', '품명', 'name', 'productname'];

export async function parseConversionFile(file: File): Promise<ConvertedBarcodeResult> {
  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, {
    type: 'array',
    raw: true,
    cellDates: false,
    cellText: false,
  });
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];

  if (!sheet || !sheet['!ref']) {
    throw new Error('첫 번째 시트를 읽을 수 없습니다.');
  }

  const range = XLSX.utils.decode_range(sheet['!ref']);
  const rows: string[][] = [];

  for (let rowIndex = range.s.r; rowIndex <= range.e.r; rowIndex += 1) {
    const row: string[] = [];
    for (let columnIndex = range.s.c; columnIndex <= range.e.c; columnIndex += 1) {
      const address = XLSX.utils.encode_cell({ r: rowIndex, c: columnIndex });
      row.push(readCellText(sheet[address]));
    }
    rows.push(row);
  }

  if (rows.length < 2) {
    throw new Error('헤더와 데이터가 포함된 엑셀 또는 CSV 파일을 업로드해 주세요.');
  }

  const headers = rows[0].map((cell) => normalizeHeader(cell));
  const codeIndex = findHeaderIndex(headers, CODE_HEADER_ALIASES);
  const nameIndex = findHeaderIndex(headers, NAME_HEADER_ALIASES);

  if (codeIndex === -1 || nameIndex === -1) {
    throw new Error('헤더는 "상품코드", "상품명" 형식이어야 합니다.');
  }

  const items: ConvertedBarcodeItem[] = [];
  const warnings: string[] = [];

  for (let index = 1; index < rows.length; index += 1) {
    const row = rows[index] ?? [];
    const sourceRowNumber = index + 1;
    const displayRowNumber = index;
    const barcode = normalizeBarcodeValue(row[codeIndex]);
    const name = normalizeNameValue(row[nameIndex]);

    if (!barcode && !name) continue;

    if (!barcode || !name) {
      warnings.push(`${sourceRowNumber}행은 상품코드 또는 상품명이 비어 있어 제외했습니다.`);
      continue;
    }

    items.push({ barcode, name, rowNumber: displayRowNumber });
  }

  if (!items.length) {
    throw new Error('변환 가능한 데이터가 없습니다. 상품코드와 상품명을 확인해 주세요.');
  }

  return {
    items,
    summary: {
      fileName: file.name,
      importedAt: new Date().toISOString(),
      recordCount: items.length,
      skippedRows: warnings.length,
    },
    warnings,
  };
}

function readCellText(cell: XLSX.CellObject | undefined) {
  if (!cell) return '';

  if (typeof cell.v === 'number') {
    return formatNumericCell(cell.v);
  }

  return String(cell.v ?? '').trim();
}

function formatNumericCell(value: number) {
  if (Number.isInteger(value)) {
    return value.toString();
  }

  const text = value.toString();
  if (!/[eE]/.test(text)) {
    return text;
  }

  const [basePart, exponentPart] = text.toLowerCase().split('e');
  const exponent = Number(exponentPart);
  const [integerPart, decimalPart = ''] = basePart.split('.');
  const digits = `${integerPart.replace('-', '')}${decimalPart}`;
  const sign = integerPart.startsWith('-') ? '-' : '';

  if (exponent >= 0) {
    const zeroCount = Math.max(0, exponent - decimalPart.length);
    const whole = digits + '0'.repeat(zeroCount);
    const splitIndex = integerPart.replace('-', '').length + exponent;
    if (splitIndex >= digits.length) return sign + whole;
    return sign + whole.slice(0, splitIndex) + whole.slice(splitIndex);
  }

  const zeros = '0'.repeat(Math.max(0, Math.abs(exponent) - 1));
  return `${sign}0.${zeros}${digits}`;
}

function findHeaderIndex(headers: string[], aliases: string[]) {
  return headers.findIndex((header) => aliases.includes(header));
}

function normalizeHeader(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[()/_-]/g, '');
}

function normalizeBarcodeValue(value: string | undefined) {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) return '';
  if (/^\d+\.0+$/.test(trimmed)) {
    return trimmed.replace(/\.0+$/, '');
  }
  return trimmed.replace(/\s+/g, '');
}

function normalizeNameValue(value: string | undefined) {
  return String(value ?? '').trim();
}
