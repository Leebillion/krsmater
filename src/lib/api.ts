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

async function safeJson(response: Response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}
