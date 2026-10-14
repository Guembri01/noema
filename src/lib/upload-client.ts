import { toast } from "sonner";
import { uploadPercent } from "@/lib/media";

export type UploadedAsset = {
  url: string;
  name: string;
  mimeType: string;
  size: number;
};

/** XHR so the browser reports body progress — `fetch` cannot. */
function sendUpload(
  file: File,
  workspaceId: string,
  onProgress: (percent: number) => void,
): Promise<UploadedAsset> {
  return new Promise((resolve, reject) => {
    const body = new FormData();
    body.append("workspaceId", workspaceId);
    body.append("file", file);

    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/upload");
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(uploadPercent(event.loaded, event.total));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText) as UploadedAsset);
        } catch {
          reject(new Error("Upload failed (invalid response)"));
        }
        return;
      }
      let message = `Upload failed (${xhr.status})`;
      try {
        const data = JSON.parse(xhr.responseText) as { error?: string };
        if (data.error) message = data.error;
      } catch {
        /* keep default */
      }
      reject(new Error(message));
    };
    xhr.onerror = () => reject(new Error("Upload failed (network error)"));
    xhr.onabort = () => reject(new Error("Upload aborted"));
    xhr.send(body);
  });
}

/**
 * Upload one file to the local asset store and return its public URL.
 *
 * While the request is in flight a progress toast is shown (a loading toast
 * updated from `xhr.upload.onprogress`, dismissed on settle) — the drag-drop
 * upload indicator lives here so every call site (editor drop/paste/file
 * picker, database file attach) gets it without wiring. Callers keep their
 * own success/error feedback, so this indicator never duplicates it.
 */
export async function uploadFile(
  file: File,
  workspaceId: string,
): Promise<UploadedAsset> {
  const toastId = `upload-${file.name}-${Date.now()}`;
  const label = (percent: number) => `Uploading ${file.name} — ${percent}%`;
  toast.loading(label(0), { id: toastId });
  try {
    return await sendUpload(file, workspaceId, (percent) => {
      toast.loading(label(percent), { id: toastId });
    });
  } finally {
    toast.dismiss(toastId);
  }
}

export function isImage(file: File): boolean {
  return file.type.startsWith("image/");
}
