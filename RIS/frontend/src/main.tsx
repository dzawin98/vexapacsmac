import { createRoot } from "react-dom/client";
import "./index.css";

const loadRuntimeConfig = async () => {
  try {
    const response = await fetch(`/settings.json?ts=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) return;
    const config = await response.json();
    window.__NEXIA_RUNTIME_CONFIG__ = config && typeof config === "object" ? config : {};
  } catch {
    window.__NEXIA_RUNTIME_CONFIG__ = {};
  }
};

loadRuntimeConfig().finally(async () => {
  const { default: App } = await import("./App.tsx");
  createRoot(document.getElementById("root")!).render(<App />);
});
