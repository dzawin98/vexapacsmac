export interface RuntimeNetworkConfig {
  backendUrl?: string;
  dicomwebBaseUrl?: string;
  viewerBaseUrl?: string;
  appBaseUrl?: string;
}

declare global {
  interface Window {
    __NEXIA_RUNTIME_CONFIG__?: RuntimeNetworkConfig;
  }
}

const cleanUrl = (value: unknown): string => String(value || "").trim().replace(/\/+$/, "");

const toAbsoluteBrowserUrl = (value: string): string => {
  if (!value) {
    return "";
  }

  if (/^https?:\/\//i.test(value)) {
    return value;
  }

  if (typeof window !== "undefined" && value.startsWith("/")) {
    return `${window.location.origin}${value}`;
  }

  return value;
};

const runtimeValue = (key: keyof RuntimeNetworkConfig): string => {
  if (typeof window === "undefined") {
    return "";
  }
  return toAbsoluteBrowserUrl(cleanUrl(window.__NEXIA_RUNTIME_CONFIG__?.[key]));
};

const isLoopbackUrlForAnotherBrowser = (value: string): boolean => {
  if (typeof window === "undefined" || !/^https?:\/\//i.test(value)) {
    return false;
  }
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    const browserHost = window.location.hostname.toLowerCase();
    return (
      (host === "localhost" || host === "127.0.0.1") &&
      browserHost !== "localhost" &&
      browserHost !== "127.0.0.1"
    );
  } catch {
    return false;
  }
};

export const resolveBackendUrl = (): string => {
  const runtimeBackendUrl = runtimeValue("backendUrl");
  if (runtimeBackendUrl) {
    return runtimeBackendUrl;
  }

  const configured = String(import.meta.env.VITE_BACKEND_URL || "").trim().replace(/\/+$/, "");
  if (configured && !isLoopbackUrlForAnotherBrowser(configured)) {
    return toAbsoluteBrowserUrl(configured);
  }

  if (typeof window !== "undefined") {
    return `${window.location.origin}/api`;
  }

  return "/api";
};

export const resolveDicomwebBaseUrl = (): string => {
  const runtimeDicomwebBaseUrl = runtimeValue("dicomwebBaseUrl");
  if (runtimeDicomwebBaseUrl) {
    return runtimeDicomwebBaseUrl;
  }

  const configured = cleanUrl(import.meta.env.VITE_DICOMWEB_BASE_URL);
  if (configured) {
    return toAbsoluteBrowserUrl(configured);
  }

  if (typeof window !== "undefined") {
    return `${window.location.origin}/rs`;
  }

  return "/rs";
};
