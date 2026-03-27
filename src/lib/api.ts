import type { MasterFileSummary, MasterRecord } from './master';

type ActiveMasterPayload = {
  active: MasterFileSummary | null;
  records: MasterRecord[];
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
      throw new Error(
        `업로드 용량 제한에 걸렸습니다 (413). 현재 파일은 ${fileSizeMb}MB이며, nginx의 client_max_body_size를 더 크게 설정해야 합니다.`,
      );
    }

    const payload = await safeJson(response);
    throw new Error(payload?.error ?? `Upload failed: ${response.status}`);
  }

  return response.json();
}

async function safeJson(response: Response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}
