export type MasterRecord = {
  barcode: string;
  name: string;
  shortName: string;
  lineNumber: number;
  rawLine: string;
};

export type MasterFileSummary = {
  fileName: string;
  recordCount: number;
  fixedWidthRows: number;
  irregularRows: number;
  encodingLabel: string;
  importedAt: string;
};

export type BarcodeMatch = {
  record: MasterRecord;
  score: number;
  reasons: string[];
  matchType: 'exact' | 'barcode-similar' | 'text';
};

const BARCODE_BYTES = 13;
const NAME_BYTES = 30;
const SHORT_NAME_BYTES = 14;
const TOTAL_BYTES = BARCODE_BYTES + NAME_BYTES + SHORT_NAME_BYTES;
const CHOSEONG = ['ㄱ', 'ㄲ', 'ㄴ', 'ㄷ', 'ㄸ', 'ㄹ', 'ㅁ', 'ㅂ', 'ㅃ', 'ㅅ', 'ㅆ', 'ㅇ', 'ㅈ', 'ㅉ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ'];

export async function parseMasterFile(file: File): Promise<{ records: MasterRecord[]; summary: MasterFileSummary }> {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const decoder = createDecoder();
  const records: MasterRecord[] = [];
  let fixedWidthRows = 0;
  let irregularRows = 0;
  let start = 0;
  let lineNumber = 0;

  for (let index = 0; index <= bytes.length; index += 1) {
    const isEnd = index === bytes.length;
    if (!isEnd && bytes[index] !== 10) continue;

    let lineBytes = bytes.slice(start, index);
    if (lineBytes[lineBytes.length - 1] === 13) lineBytes = lineBytes.slice(0, -1);
    start = index + 1;
    lineNumber += 1;

    if (lineBytes.length === 0) continue;
    if (lineBytes.length === TOTAL_BYTES) fixedWidthRows += 1;
    else irregularRows += 1;

    const barcode = decodeAscii(lineBytes.slice(0, BARCODE_BYTES));
    if (!barcode) continue;

    records.push({
      barcode,
      name: decodeField(lineBytes.slice(BARCODE_BYTES, BARCODE_BYTES + NAME_BYTES), decoder),
      shortName: decodeField(
        lineBytes.slice(BARCODE_BYTES + NAME_BYTES, BARCODE_BYTES + NAME_BYTES + SHORT_NAME_BYTES),
        decoder,
      ),
      lineNumber,
      rawLine: decoder.decode(lineBytes),
    });
  }

  return {
    records,
    summary: {
      fileName: file.name,
      recordCount: records.length,
      fixedWidthRows,
      irregularRows,
      encodingLabel: 'CP949 (EUC-KR)',
      importedAt: new Date().toISOString(),
    },
  };
}

export function findBarcodeMatches(records: MasterRecord[], rawInput: string): BarcodeMatch[] {
  const input = rawInput.trim();
  if (!input || records.length === 0) return [];

  const textQuery = normalizeText(input);
  const textTokens = tokenizeText(input);
  const chosungQuery = extractChosung(textQuery);
  const chosungTokens = textTokens.map(extractChosung).filter(Boolean);
  const barcodeCandidates = extractBarcodeCandidates(input);
  const matches: BarcodeMatch[] = [];

  for (const record of records) {
    let bestScore = 0;
    let bestType: BarcodeMatch['matchType'] = 'barcode-similar';
    let reasons: string[] = [];

    const normalizedName = normalizeText(record.name);
    const normalizedShortName = normalizeText(record.shortName);
    const nameTokens = tokenizeText(record.name);
    const shortNameTokens = tokenizeText(record.shortName);
    const nameChosung = extractChosung(normalizedName);
    const shortNameChosung = extractChosung(normalizedShortName);

    const exactTextMatch =
      textQuery &&
      (normalizedName.includes(textQuery) || normalizedShortName.includes(textQuery));

    const combinedTokenMatch =
      textTokens.length > 1 &&
      (matchesAllTokens(textTokens, normalizedName) ||
        matchesAllTokens(textTokens, normalizedShortName) ||
        matchesAllTokens(textTokens, nameTokens) ||
        matchesAllTokens(textTokens, shortNameTokens));

    const chosungMatch =
      chosungQuery &&
      (nameChosung.includes(chosungQuery) ||
        shortNameChosung.includes(chosungQuery) ||
        matchesAllTokens(chosungTokens, nameChosung) ||
        matchesAllTokens(chosungTokens, shortNameChosung));

    if (exactTextMatch) {
      bestScore = 0.74;
      bestType = 'text';
      reasons = ['상품명 또는 축약명 일치'];
    } else if (combinedTokenMatch) {
      bestScore = 0.7;
      bestType = 'text';
      reasons = ['조합 검색 일치'];
    } else if (chosungMatch) {
      bestScore = 0.68;
      bestType = 'text';
      reasons = ['초성 검색 일치'];
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

export function formatSimilarity(score: number) {
  return `${Math.round(score * 100)}%`;
}

function createDecoder() {
  try {
    return new TextDecoder('euc-kr', { fatal: false });
  } catch {
    return new TextDecoder('utf-8', { fatal: false });
  }
}

function decodeAscii(bytes: Uint8Array) {
  return Array.from(bytes, (value) => String.fromCharCode(value)).join('').trim();
}

function decodeField(bytes: Uint8Array, decoder: TextDecoder) {
  return decoder.decode(bytes).replace(/\0/g, '').trim();
}

function extractBarcodeCandidates(value: string) {
  const candidates = new Set<string>();
  const rawDigits = normalizeDigits(value);
  if (rawDigits.length >= 8) candidates.add(rawDigits);
  for (const part of value.match(/\d{8,18}/g) ?? []) {
    candidates.add(normalizeDigits(part));
  }
  return [...candidates].filter(Boolean);
}

function normalizeDigits(value: string) {
  return value.replace(/\D/g, '');
}

function normalizeText(value: string) {
  return value.replace(/\s+/g, '').toLowerCase();
}

function tokenizeText(value: string) {
  return value
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .map((token) => normalizeText(token))
    .filter(Boolean);
}

function extractChosung(value: string) {
  let result = '';
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code >= 0xac00 && code <= 0xd7a3) {
      const index = Math.floor((code - 0xac00) / 588);
      result += CHOSEONG[index] ?? char;
    } else if (CHOSEONG.includes(char)) {
      result += char;
    } else if (/[a-z0-9]/.test(char)) {
      result += char;
    }
  }
  return result;
}

function matchesAllTokens(tokens: string[], target: string | string[]) {
  if (tokens.length === 0) return false;
  const values = Array.isArray(target) ? target : [target];
  return tokens.every((token) => values.some((value) => value.includes(token)));
}

function scoreBarcodeCandidate(input: string, target: string) {
  if (!input || !target) return { score: 0, reasons: [] as string[], matchType: 'barcode-similar' as const };
  if (input === target) return { score: 1, reasons: ['바코드 완전 일치'], matchType: 'exact' as const };

  const maxLength = Math.max(input.length, target.length);
  const distance = levenshtein(input, target);
  const editSimilarity = maxLength ? 1 - distance / maxLength : 0;
  const prefix = commonPrefixLength(input, target) / maxLength;
  const suffix = commonSuffixLength(input, target) / maxLength;
  const overlap = overlappingDigits(input, target) / maxLength;
  const contains = target.includes(input) || input.includes(target) ? 0.72 : 0;
  const score = Math.max(contains, editSimilarity * 0.55 + prefix * 0.2 + suffix * 0.15 + overlap * 0.1);

  const reasons: string[] = [];
  if (editSimilarity >= 0.84) reasons.push(`자리수 차이 ${distance}개`);
  if (prefix >= 0.5) reasons.push('앞자리 유사');
  if (suffix >= 0.3) reasons.push('뒷자리 유사');
  if (contains > 0) reasons.push('부분 포함');

  return { score, reasons, matchType: 'barcode-similar' as const };
}

function commonPrefixLength(left: string, right: string) {
  let index = 0;
  while (index < left.length && index < right.length && left[index] === right[index]) index += 1;
  return index;
}

function commonSuffixLength(left: string, right: string) {
  let index = 0;
  while (index < left.length && index < right.length && left[left.length - 1 - index] === right[right.length - 1 - index]) index += 1;
  return index;
}

function overlappingDigits(left: string, right: string) {
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

function levenshtein(left: string, right: string) {
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
