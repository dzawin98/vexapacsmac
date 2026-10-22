import type { ViewerConfig } from "@/lib/dicomService";

const normalizeViewerName = (value?: string | null) =>
  String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");

export const getViewerButtonLabel = (viewer?: Pick<ViewerConfig, "id" | "name"> | null) => {
  const id = normalizeViewerName(viewer?.id).replace(/[-_]+/g, " ");
  const name = normalizeViewerName(viewer?.name);
  const key = `${id} ${name}`;

  if (key.includes("ecg")) return "ECG";
  if (key.includes("mobile") || key.includes("mobility")) return "Mobile";
  if (key.includes("desktop")) return "Viewer";

  return viewer?.name?.trim() || "Viewer";
};
