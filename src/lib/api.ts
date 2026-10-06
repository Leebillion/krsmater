import type { MasterFileSummary, MasterRecord } from './master';

export type BundleReportInput = {
  bundleName: string;
  bundleBarcode: string;
  quantity: string;
  itemBarcode: string;
  itemName: string;
};

export type BundleReportRow = {
  id: number;
  bundleName: string;
  bundleBarcode: string;
  quantity: number;
  itemBarcode: string;
  itemName: string;
  createdAt: string;
};

export type BundleMasterSummary = {
  fileName: string;
  importedAt: string;
  recordCount: number;
};

export type BundleMasterRecord = {
  bundleName: string;
  bundleBarcode: string;
  quantity: number;
  itemBarcode: string;
  itemName: string;
  rowNumber: number;
};

export type BundleMasterImportResponse = {
  ok: true;
  summary: BundleMasterSummary;
  warnings: string[];
};

export type InventoryPhotoRow = {
  barcode: string;
  name: string;
  rowNumber: number;
};

export type InventoryPhotoSummary = {
  fileName: string;
  importedAt: string;
  recordCount: number;
  savedName?: string;
};

export type InventoryPhotoParseResponse = {
  ok: true;
  summary: InventoryPhotoSummary;
  items: InventoryPhotoRow[];
  warnings: string[];
};

export type ConvertSaveSourceType = 'file' | 'photo';

export type SavedConvertRow = {
  barcode: string;
  name: string;
  rowNumber: number;
};

export type SavedConvertSetSummary = {
  id: number;
  name: string;
  sourceType: ConvertSaveSourceType;
  sourceFileName: string;
  recordCount: number;
  createdAt: string;
  updatedAt: string;
};

export type SavedConvertSetDetail = SavedConvertSetSummary & {
  rows: SavedConvertRow[];
};

export type SaveConvertPayload = {
  name: string;
  sourceType: ConvertSaveSourceType;
  sourceFileName: string;
  rows: SavedConvertRow[];
};

type ActiveMasterPayload = {
  active: MasterFileSummary | null;
  records: MasterRecord[];
};

type BundleMasterSearchPayload = {
  active: BundleMasterSummary | null;
  items: BundleMasterRecord[];
};

type BundleReportListPayload = {
  items: BundleReportRow[];
};

type SavedConvertListPayload = {
  items: SavedConvertSetSummary[];
};

type SavedConvertDetailPayload = {
  item: SavedConvertSetDetail;
};

export async function fetchServerMaster() {
  const response = await fetch('/api/master/full');
  if (!response.ok) {
    throw new Error(`Failed to fetch master: ${response.status}`);
  }

  return (await response.json()) as ActiveMasterPayload;
}

export async function uploadMasterToServer(file: File) {
  const formData = new FormData();
  formData.append('masterFile', file);

  const response = await fetch('/api/master/import', {
    method: 'POST',
    body: formData,
  });

  if (!response.ok) {
    if (response.status === 413) {
      const fileSizeMb = (file.size / (1024 * 1024)).toFixed(2);
      throw new Error(`업로드 제한을 넘었습니다. 현재 파일은 ${fileSizeMb}MB 입니다.`);
    }

    const payload = await safeJson(response);
    throw new Error(payload?.error ?? `Upload failed: ${response.status}`);
  }

  return response.json() as Promise<{ ok: true; summary: MasterFileSummary }>;
}

export async function createBundleReport(payload: BundleReportInput) {
  const response = await fetch('/api/bundles/report', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const error = await safeJson(response);
    throw new Error(error?.error ?? '번들 제보 저장에 실패했습니다.');
  }

  return response.json();
}

export async function downloadBundleReportDb() {
  const response = await fetch('/api/bundles/report/export');
  if (!response.ok) {
    const error = await safeJson(response);
    throw new Error(error?.error ?? '번들 DB 다운로드에 실패했습니다.');
  }

  return response.blob();
}

export async function listBundleReports() {
  const response = await fetch('/api/bundles/report');
  if (!response.ok) {
    const error = await safeJson(response);
    throw new Error(error?.error ?? '번들 제보 목록을 불러오지 못했습니다.');
  }

  return (await response.json()) as BundleReportListPayload;
}

export async function updateBundleReport(id: number, payload: BundleReportInput) {
  const response = await fetch(`/api/bundles/report/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const error = await safeJson(response);
    throw new Error(error?.error ?? '번들 제보 수정에 실패했습니다.');
  }

  return response.json();
}

export async function deleteBundleReport(id: number) {
  const response = await fetch(`/api/bundles/report/${id}`, {
    method: 'DELETE',
  });

  if (!response.ok) {
    const error = await safeJson(response);
    throw new Error(error?.error ?? '번들 제보 삭제에 실패했습니다.');
  }

  return response.json();
}

export async function fetchBundleMasterStatus() {
  const response = await fetch('/api/bundles/master/status');
  if (!response.ok) {
    const error = await safeJson(response);
    throw new Error(error?.error ?? '번들 마스터 상태를 불러오지 못했습니다.');
  }

  return (await response.json()) as { active: BundleMasterSummary | null };
}

export async function uploadBundleMaster(file: File) {
  const formData = new FormData();
  formData.append('bundleFile', file);

  const response = await fetch('/api/bundles/master/import', {
    method: 'POST',
    body: formData,
  });

  if (!response.ok) {
    const error = await safeJson(response);
    throw new Error(error?.error ?? '번들 마스터 업로드에 실패했습니다.');
  }

  return (await response.json()) as BundleMasterImportResponse;
}

export async function searchBundleMaster(query: string) {
  const url = new URL('/api/bundles/master/search', window.location.origin);
  if (query.trim()) {
    url.searchParams.set('q', query.trim());
  }

  const response = await fetch(url);
  if (!response.ok) {
    const error = await safeJson(response);
    throw new Error(error?.error ?? '번들 마스터 조회에 실패했습니다.');
  }

  return (await response.json()) as BundleMasterSearchPayload;
}

export async function uploadInventoryPhoto(file: File) {
  const formData = new FormData();
  formData.append('photoFile', file);

  const response = await fetch('/api/convert/inventory-photo', {
    method: 'POST',
    body: formData,
  });

  if (!response.ok) {
    const error = await safeJson(response);
    throw new Error(error?.error ?? '재고현황 표 사진 변환에 실패했습니다.');
  }

  return (await response.json()) as InventoryPhotoParseResponse;
}

export async function listSavedConvertSets() {
  const response = await fetch('/api/convert/saved');
  if (!response.ok) {
    const error = await safeJson(response);
    throw new Error(error?.error ?? '저장된 변환 결과 목록을 불러오지 못했습니다.');
  }

  return (await response.json()) as SavedConvertListPayload;
}

export async function fetchSavedConvertSet(id: number) {
  const response = await fetch(`/api/convert/saved/${id}`);
  if (!response.ok) {
    const error = await safeJson(response);
    throw new Error(error?.error ?? '저장된 변환 결과를 불러오지 못했습니다.');
  }

  return (await response.json()) as SavedConvertDetailPayload;
}

export async function saveConvertSet(payload: SaveConvertPayload) {
  const response = await fetch('/api/convert/saved', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const error = await safeJson(response);
    throw new Error(error?.error ?? '변환 결과 저장에 실패했습니다.');
  }

  return (await response.json()) as SavedConvertDetailPayload & { ok: true };
}

export async function deleteSavedConvertSet(id: number) {
  const response = await fetch(`/api/convert/saved/${id}`, {
    method: 'DELETE',
  });

  if (!response.ok) {
    const error = await safeJson(response);
    throw new Error(error?.error ?? '저장된 변환 결과 삭제에 실패했습니다.');
  }

  return response.json() as Promise<{ ok: true }>;
}

// ---- 마스터 편집(관리자) ------------------------------------------------------
// 로그인은 마스터 편집 서버(/editor/)가 맡는다. 로그인하면 그 쿠키로 이 사이트의
// 관리자 기능(현재 마스터·번들 마스터 업로드)도 열린다.
const EDITOR_HEADERS = { 'X-Requested-With': 'master-reducer' };

export async function fetchAdminStatus() {
  try {
    const response = await fetch('/api/admin/status', { credentials: 'same-origin' });
    if (!response.ok) return false;
    const payload = (await response.json()) as { admin?: boolean };
    return Boolean(payload.admin);
  } catch {
    return false;
  }
}

export async function adminLogin(password: string) {
  const response = await fetch('/editor/api/login', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...EDITOR_HEADERS },
    body: JSON.stringify({ password }),
  });
  if (!response.ok) {
    const payload = await safeJson(response);
    if (response.status === 502 || response.status === 504 || response.status === 404) {
      throw new Error('마스터 편집 서버에 연결하지 못했습니다. 서버가 실행 중인지 확인하세요.');
    }
    throw new Error(payload?.message ?? '로그인에 실패했습니다.');
  }
}

export type EditorDbReplaceResult = {
  ok: true;
  message: string;
  before: Record<string, number | null>;
  after: Record<string, number | null>;
  backup: string;
};

// PC 앱의 master_management.db로 마스터 편집 서버의 공유 상품 DB를 교체한다(서버가 기존 DB를 자동 백업).
export async function uploadEditorDb(file: File) {
  const formData = new FormData();
  formData.append('file', file);
  const response = await fetch('/editor/api/db/replace', {
    method: 'POST',
    credentials: 'same-origin',
    headers: EDITOR_HEADERS,
    body: formData,
  });
  if (!response.ok) {
    const payload = await safeJson(response);
    if (response.status === 401) throw new Error('로그인이 만료되었습니다. 다시 로그인하세요.');
    if (response.status === 413) throw new Error('파일이 너무 큽니다.');
    throw new Error(payload?.message ?? `DB 업데이트에 실패했습니다 (${response.status}).`);
  }
  return (await response.json()) as EditorDbReplaceResult;
}

export async function adminLogout() {
  await fetch('/editor/api/logout', { method: 'POST', credentials: 'same-origin', headers: EDITOR_HEADERS }).catch(() => undefined);
}

async function safeJson(response: Response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}
