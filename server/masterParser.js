import iconv from 'iconv-lite';

const BARCODE_BYTES = 13;
const NAME_BYTES = 30;
const SHORT_NAME_BYTES = 14;
const TOTAL_BYTES = BARCODE_BYTES + NAME_BYTES + SHORT_NAME_BYTES;

export function parseMasterBuffer(buffer, fileName = 'upload.txt') {
  const bytes = new Uint8Array(buffer);
  const records = [];
  let fixedWidthRows = 0;
  let irregularRows = 0;
  let start = 0;
  let lineNumber = 0;

  for (let index = 0; index <= bytes.length; index += 1) {
    const isEnd = index === bytes.length;
    if (!isEnd && bytes[index] !== 10) continue;

    let lineBytes = bytes.slice(start, index);
    if (lineBytes[lineBytes.length - 1] === 13) {
      lineBytes = lineBytes.slice(0, -1);
    }

    start = index + 1;
    lineNumber += 1;

    if (lineBytes.length === 0) continue;
    if (lineBytes.length === TOTAL_BYTES) fixedWidthRows += 1;
    else irregularRows += 1;

    const barcode = decodeAscii(lineBytes.slice(0, BARCODE_BYTES));
    if (!barcode) continue;

    records.push({
      barcode,
      name: decodeCp949(lineBytes.slice(BARCODE_BYTES, BARCODE_BYTES + NAME_BYTES)),
      shortName: decodeCp949(lineBytes.slice(BARCODE_BYTES + NAME_BYTES, BARCODE_BYTES + NAME_BYTES + SHORT_NAME_BYTES)),
      lineNumber,
      rawLine: decodeCp949(lineBytes),
    });
  }

  return {
    records,
    summary: {
      fileName,
      recordCount: records.length,
      fixedWidthRows,
      irregularRows,
      encodingLabel: 'CP949 (EUC-KR)',
      importedAt: new Date().toISOString(),
    },
  };
}

export function findBarcodeMatches(records, rawInput) {
  const input = String(rawInput ?? '').trim();
  if (!input || records.length === 0) return [];

  const textQuery = normalizeText(input);
  const barcodeCandidates = extractBarcodeCandidates(input);
  const matches = [];

  for (const record of records) {
    let bestScore = 0;
    let bestType = 'barcode-similar';
    let reasons = [];

    if (
      textQuery &&
      (normalizeText(record.name).includes(textQuery) || normalizeText(record.shortName).includes(textQuery))
    ) {
      bestScore = 0.74;
      bestType = 'text';
      reasons = ['상품명 또는 축약명 일치'];
    }

    for (const candidate of barcodeCandidates) {
      const scored = scoreBarcodeCandidate(candidate, record.barcode);
      if (scored.score > bestScore) {
        bestScore = scored.score;
        bestType = scored.matchType;
        reasons = scored.reasons;
      }
    }

    if (bestScore >= 0.42) {
      matches.push({ record, score: bestScore, reasons, matchType: bestType });
    }
  }

  return matches
    .sort((left, right) => (right.score !== left.score ? right.score - left.score : left.record.lineNumber - right.record.lineNumber))
    .slice(0, 8);
}

function decodeAscii(bytes) {
  return Array.from(bytes, (value) => String.fromCharCode(value)).join('').trim();
}

function decodeCp949(bytes) {
  return iconv.decode(Buffer.from(bytes), 'cp949').replace(/\0/g, '').trim();
}

function extractBarcodeCandidates(value) {
  const candidates = new Set();
  const rawDigits = normalizeDigits(value);
  if (rawDigits.length >= 8) candidates.add(rawDigits);
  for (const part of value.match(/\d{8,18}/g) ?? []) {
    candidates.add(normalizeDigits(part));
  }
  return [...candidates].filter(Boolean);
}

function normalizeDigits(value) {
  return value.replace(/\D/g, '');
}

function normalizeText(value) {
  return value.replace(/\s+/g, '').toLowerCase();
}

function scoreBarcodeCandidate(input, target) {
  if (!input || !target) return { score: 0, reasons: [], matchType: 'barcode-similar' };
  if (input === target) return { score: 1, reasons: ['바코드 완전 일치'], matchType: 'exact' };

  const maxLength = Math.max(input.length, target.length);
  const distance = levenshtein(input, target);
  const editSimilarity = maxLength ? 1 - distance / maxLength : 0;
  const prefix = commonPrefixLength(input, target) / maxLength;
  const suffix = commonSuffixLength(input, target) / maxLength;
  const overlap = overlappingDigits(input, target) / maxLength;
  const contains = target.includes(input) || input.includes(target) ? 0.72 : 0;
  const score = Math.max(contains, editSimilarity * 0.55 + prefix * 0.2 + suffix * 0.15 + overlap * 0.1);

  const reasons = [];
  if (editSimilarity >= 0.84) reasons.push(`자리수 차이 ${distance}개`);
  if (prefix >= 0.5) reasons.push('앞자리 유사');
  if (suffix >= 0.3) reasons.push('뒷자리 유사');
  if (contains > 0) reasons.push('부분 포함');

  return { score, reasons, matchType: 'barcode-similar' };
}

function commonPrefixLength(left, right) {
  let index = 0;
  while (index < left.length && index < right.length && left[index] === right[index]) index += 1;
  return index;
}

function commonSuffixLength(left, right) {
  let index = 0;
  while (index < left.length && index < right.length && left[left.length - 1 - index] === right[right.length - 1 - index]) index += 1;
  return index;
}

function overlappingDigits(left, right) {
  const remaining = right.split('');
  let total = 0;
  for (const digit of left) {
    const index = remaining.indexOf(digit);
    if (index >= 0) {
      remaining.splice(index, 1);
      total += 1;
    }
  }
  return total;
}

function levenshtein(left, right) {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    let diagonal = previous[0];
    previous[0] = row;
    for (let col = 1; col <= right.length; col += 1) {
      const temp = previous[col];
      const cost = left[row - 1] === right[col - 1] ? 0 : 1;
      previous[col] = Math.min(previous[col] + 1, previous[col - 1] + 1, diagonal + cost);
      diagonal = temp;
    }
  }
  return previous[right.length];
}
