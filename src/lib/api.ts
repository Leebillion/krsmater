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
