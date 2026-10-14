export type UploadedAsset = {
  url: string;
  name: string;
  mimeType: string;
  size: number;
};

/** Upload one file to the local asset store and return its public URL. */
export async function uploadFile(
  file: File,
  workspaceId: string,
): Promise<UploadedAsset> {
  const body = new FormData();
  body.append("workspaceId", workspaceId);
  body.append("file", file);

  const response = await fetch("/api/upload", { method: "POST", body });
  if (!response.ok) {
    let message = `Upload failed (${response.status})`;
    try {
      const data = (await response.json()) as { error?: string };
      if (data.error) message = data.error;
    } catch {
      /* keep default */
    }
    throw new Error(message);
  }
  return (await response.json()) as UploadedAsset;
}

export function isImage(file: File): boolean {
  return file.type.startsWith("image/");
}
