import type { ViewerConfig } from "@/lib/dicomService";
import { resolveBackendUrl } from "@/lib/backendUrl";

type ViewerWindowHandle = Window | null;
type VeloLaunchStudyPayload = {
  StudyInstanceUID?: string | null;
  accession?: string | null;
  patientId?: string | null;
  mode?: "stack";
};

const viewerWindowRegistry = new Map<string, ViewerWindowHandle>();
const BACKEND_URL = resolveBackendUrl();

const withStoredUserHeaders = () => {
  if (typeof window === "undefined") return {};
  try {
    const stored = window.localStorage.getItem("nexia_auth_user");
    const user = stored ? JSON.parse(stored) as { username?: string; role?: string } : null;
    return {
      ...(user?.role ? { "x-user-role": user.role } : {}),
      ...(user?.username ? { "x-user-username": user.username } : {}),
    };
  } catch {
    return {};
  }
};

const sanitizeWindowName = (value: string): string =>
  value.replace(/[^a-zA-Z0-9_-]/g, "-");

const resolveViewerBaseUrl = (baseUrl?: string | null): string => {
  const value = String(baseUrl || "").trim();
  const fallbackOrigin = typeof window !== "undefined" ? window.location.origin : "http://127.0.0.1";
  if (!value) return fallbackOrigin;
  if (/^https?:\/\//i.test(value)) return value;
  if (value.startsWith("/")) return `${fallbackOrigin}${value}`;
  return value;
};

const resolveViewerUrl = (baseUrl?: string | null, path?: string | null): URL => {
  const resolvedBase = new URL(resolveViewerBaseUrl(baseUrl));
  const pathValue = String(path || "/viewer").trim();
  if (/^https?:\/\//i.test(pathValue)) return new URL(pathValue);

  const basePath = resolvedBase.pathname.replace(/\/+$/, "");
  const childPath = pathValue.replace(/^\/+/, "");
  resolvedBase.pathname = `${basePath}/${childPath}`.replace(/\/{2,}/g, "/");
  resolvedBase.search = "";
  resolvedBase.hash = "";
  return resolvedBase;
};

const buildViewerUrl = (
  viewer: ViewerConfig,
  studyInstanceUid: string,
  options?: { metadataRefresh?: boolean; viewerSlot?: string }
) => {
  const url = resolveViewerUrl(viewer.baseUrl, viewer.path || "/viewer");
  const param = viewer.queryParam || "StudyInstanceUIDs";
  url.searchParams.set(param, studyInstanceUid);
  if (options?.viewerSlot) {
    url.searchParams.set("_viewerSlot", options.viewerSlot);
  }
  if (options?.metadataRefresh !== false) {
    url.searchParams.set("_metadataRefresh", String(Date.now()));
  }
  return url.toString();
};

const buildViewerTargetOrigin = (viewer: ViewerConfig) => {
  try {
    return new URL(resolveViewerBaseUrl(viewer.baseUrl)).origin;
  } catch {
    return "*";
  }
};

export const isViewerAllowedForModality = (viewer: ViewerConfig, modality?: string | null) => {
  if (!viewer.modalityFilter?.length) return true;
  const normalizedModality = String(modality || "").trim().toUpperCase();
  return viewer.modalityFilter.map(value => String(value).trim().toUpperCase()).includes(normalizedModality);
};

const postViewerStudyChange = (
  targetWindow: Window,
  viewer: ViewerConfig,
  studyInstanceUid: string,
  options?: { metadataRefresh?: boolean; viewerSlot?: string }
) => {
  const viewerUrl = buildViewerUrl(viewer, studyInstanceUid, options);
  const targetOrigin = buildViewerTargetOrigin(viewer);

  targetWindow.postMessage(
    {
      type: "nexia-open-study",
      viewerUrl,
      studyInstanceUid,
      metadataRefresh: options?.metadataRefresh !== false,
    },
    targetOrigin === "*" ? "*" : targetOrigin
  );
};

const escapeXml = (value: unknown): string =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

const xmlMember = (name: string, value: unknown) => `
          <member>
            <name>${escapeXml(name)}</name>
            <value><string>${escapeXml(value)}</string></value>
          </member>`;

const buildInobitecRpcXml = (viewer: ViewerConfig, studyInstanceUid: string, commandOverride?: string) => {
  const command = commandOverride || viewer.command || "DownloadAndOpenStudy";
  const commandType = viewer.commandType || "WADO-RS";
  const port = commandType === "WADO-RS" ? viewer.wadoPort || "5001" : viewer.pacsPort;
  const members = [xmlMember("StudyInstanceUID", studyInstanceUid)];

  if (command === "DownloadAndOpenStudy") {
    if (viewer.pacsAet) members.push(xmlMember("AET", viewer.pacsAet));
    if (viewer.pacsIp) members.push(xmlMember("IP", viewer.pacsIp));
    if (port) members.push(xmlMember("port", port));
    if (commandType === "WADO-RS") {
      members.push(xmlMember("WadoServiceRootPath", viewer.wadoServiceRootPath || "/rs"));
      members.push(xmlMember("IsWadoSecured", viewer.isWadoSecured ? "true" : "false"));
      members.push(xmlMember("WadoPort", viewer.wadoPort || viewer.pacsPort || "5001"));
      members.push(xmlMember("WadoAuthLogin", viewer.wadoAuthLogin || ""));
      members.push(xmlMember("WadoAuthPassword", viewer.wadoAuthPassword || ""));
    }
    members.push(xmlMember("CommandType", commandType));
  }

  return `<?xml version="1.0" encoding="utf-8"?>
<methodCall>
  <methodName>${escapeXml(command)}</methodName>
  <params>
    <param>
      <value>
        <struct>${members.join("")}
        </struct>
      </value>
    </param>
  </params>
</methodCall>`;
};

const sleep = (milliseconds: number) => new Promise(resolve => window.setTimeout(resolve, milliseconds));

const postInobitecDirect = async (
  viewer: ViewerConfig,
  studyInstanceUid: string,
  commandOverride?: string
) => {
  const rpcUrl = viewer.rpcUrl || viewer.baseUrl || "http://127.0.0.1:9090";
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: buildInobitecRpcXml(viewer, studyInstanceUid, commandOverride),
  });

  if (!response.ok) {
    throw new Error(`Inobitec RPC failed with HTTP ${response.status}.`);
  }
};

const postInobitecViaBackend = async (
  viewer: ViewerConfig,
  studyInstanceUid: string,
  commandOverride?: string
) => {
  const response = await fetch(`${BACKEND_URL}/viewer/inobitec-rpc`, {
    method: "POST",
    headers: {
      ...withStoredUserHeaders(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      viewer: commandOverride ? { ...viewer, command: commandOverride } : viewer,
      studyInstanceUid,
    }),
  });

  if (response.ok) {
    return;
  }

  let message = "Failed to contact Inobitec RPC service.";
  try {
    const payload = await response.json();
    if (payload?.error) message = payload.error;
  } catch {}
  throw new Error(message);
};

const openInobitecRpcViewer = async (viewer: ViewerConfig, studyInstanceUid: string) => {
  try {
    await postInobitecDirect(viewer, studyInstanceUid);
    if ((viewer.command || "DownloadAndOpenStudy") === "DownloadAndOpenStudy") {
      await sleep(Number(viewer.displayAfterMs || 3000));
      await postInobitecDirect(viewer, studyInstanceUid, "DisplayStudy");
    }
    return null;
  } catch (directError) {
    try {
      await postInobitecViaBackend(viewer, studyInstanceUid);
      if ((viewer.command || "DownloadAndOpenStudy") === "DownloadAndOpenStudy") {
        await sleep(Number(viewer.displayAfterMs || 3000));
        await postInobitecViaBackend(viewer, studyInstanceUid, "DisplayStudy");
      }
      return null;
    } catch (backendError) {
      let message = backendError instanceof Error
        ? backendError.message
        : "Failed to contact Inobitec RPC service.";
      if (directError instanceof Error) {
        message = `${message} Direct browser call also failed: ${directError.message}`;
      }
      throw new Error(message);
    }
  }
};

const extractVeloErrorMessage = (payload: { error?: string; message?: string; details?: unknown } | null) => {
  if (!payload) return "";
  if (payload.error) return payload.error;
  if (payload.message) return payload.message;
  const details = payload.details as { error?: string; message?: string; details?: { error?: string; message?: string } } | undefined;
  return details?.error || details?.message || details?.details?.error || details?.details?.message || "";
};

const openVeloRisLaunchViewer = async (viewer: ViewerConfig, study: VeloLaunchStudyPayload) => {
  const StudyInstanceUID = String(study.StudyInstanceUID || "").trim();
  const accession = String(study.accession || "").trim();
  const patientId = String(study.patientId || "").trim();

  if (!StudyInstanceUID && !accession) {
    throw new Error("A StudyInstanceUID or Accession Number is required to open the Viewer.");
  }

  const response = await fetch(`${BACKEND_URL}/viewer/velo/launch`, {
    method: "POST",
    headers: {
      ...withStoredUserHeaders(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      viewerId: viewer.id,
      StudyInstanceUID,
      accession,
      patientId,
      mode: "stack",
    }),
  });

  const responseText = await response.text();
  let payload: { launchUrl?: string; error?: string; message?: string; details?: unknown } | null = null;
  try {
    payload = responseText ? JSON.parse(responseText) : null;
  } catch {
    payload = { error: responseText };
  }

  if (!response.ok) {
    console.error("VEXAPACS launch failed", response.status, payload);
    throw new Error(extractVeloErrorMessage(payload) || "Could not open the Viewer");
  }

  if (!payload?.launchUrl) {
    throw new Error("The Viewer did not return a launchUrl");
  }

  const targetName = sanitizeWindowName(`nexia-viewer-${viewer.id || viewer.name || "default"}`);
  const targetWindow = window.open(payload.launchUrl, targetName);

  if (!targetWindow) {
    throw new Error("Popup blocked or viewer tab could not be opened.");
  }

  viewerWindowRegistry.set(targetName, targetWindow);
  targetWindow.focus();
  return targetWindow;
};

const sendViewerWindowCommand = async (
  slot: string,
  viewer: ViewerConfig,
  studyInstanceUid: string,
  options?: { metadataRefresh?: boolean }
) => {
  const viewerUrl = buildViewerUrl(viewer, studyInstanceUid, {
    ...options,
    viewerSlot: slot,
  });

  await fetch(`${BACKEND_URL}/viewer/window-command/${encodeURIComponent(slot)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ viewerUrl, studyInstanceUid }),
  }).catch(() => undefined);
};

const getViewerWindowSession = async (slot: string) => {
  try {
    const response = await fetch(
      `${BACKEND_URL}/viewer/window-session/${encodeURIComponent(slot)}`
    );
    if (!response.ok) {
      return { active: false };
    }
    return response.json() as Promise<{ active?: boolean }>;
  } catch {
    return { active: false };
  }
};

export const openViewerInNamedWindow = async (
  viewer: ViewerConfig,
  studyInstanceUid: string,
  options?: {
    metadataRefresh?: boolean;
    accessionNumber?: string | null;
    patientId?: string | null;
  }
) => {
  if (viewer.type === "inobitec-rpc") {
    return openInobitecRpcViewer(viewer, studyInstanceUid);
  }

  if (viewer.type === "vexa-ris-launch" || viewer.type === "velo-ris-launch") {
    return openVeloRisLaunchViewer(viewer, {
      StudyInstanceUID: studyInstanceUid,
      accession: options?.accessionNumber,
      patientId: options?.patientId,
      mode: "stack",
    });
  }

  const targetName = sanitizeWindowName(`nexia-viewer-${viewer.id || viewer.name || "default"}`);
  const viewerUrl = buildViewerUrl(viewer, studyInstanceUid, {
    ...options,
    viewerSlot: targetName,
  });
  if (viewer.id === "ecg-viewer") {
    const targetWindow = window.open(viewerUrl, "_blank");
    if (!targetWindow) {
      throw new Error("Popup blocked or viewer tab could not be opened.");
    }
    targetWindow.focus();
    return targetWindow;
  }

  const existingWindow = viewerWindowRegistry.get(targetName);

  if (existingWindow && !existingWindow.closed) {
    try {
      existingWindow.location.href = viewerUrl;
    } catch {
      window.open(viewerUrl, targetName);
    }
    postViewerStudyChange(existingWindow, viewer, studyInstanceUid, {
      ...options,
      viewerSlot: targetName,
    });
    void sendViewerWindowCommand(targetName, viewer, studyInstanceUid, options);
    existingWindow.focus();
    return existingWindow;
  }

  const targetWindow = window.open(viewerUrl, targetName);

  if (!targetWindow) {
    const session = await getViewerWindowSession(targetName);
    if (session.active) {
      await sendViewerWindowCommand(targetName, viewer, studyInstanceUid, options);
      return null;
    }
    throw new Error("Popup blocked or viewer tab could not be opened.");
  }

  viewerWindowRegistry.set(targetName, targetWindow);
  targetWindow.focus();
  return targetWindow;
};
