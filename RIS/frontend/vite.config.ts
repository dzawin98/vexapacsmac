import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { componentTagger } from "lovable-tagger";

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  const backendTarget = process.env.VITE_DEV_BACKEND_TARGET || "http://127.0.0.1:3001";
  const backupAgentTarget = process.env.VITE_DEV_BACKUP_AGENT_TARGET || "http://127.0.0.1:3099";
  const dicomwebTarget = process.env.VITE_DEV_DICOMWEB_TARGET || "http://127.0.0.1:5001";
  const mobileViewerTarget = process.env.VITE_DEV_MOBILE_VIEWER_TARGET || "http://127.0.0.1:5992";
  const ecgViewerTarget = process.env.VITE_DEV_ECG_VIEWER_TARGET || "http://127.0.0.1:7771";

  return {
    server: {
      host: "::",
      port: 8080,
      hmr: {
        overlay: false,
      },
      proxy: {
        "/api/system/backup": {
          target: backupAgentTarget,
          changeOrigin: true,
        },
        "/api/system/restore": {
          target: backupAgentTarget,
          changeOrigin: true,
        },
        // `public/settings.json` uses relative URLs in local installs,
        // so dev mode needs a proxy for the backend API.
        "/api": {
          target: backendTarget,
          changeOrigin: true,
        },
        "/rs": {
          target: dicomwebTarget,
          changeOrigin: true,
        },
        "/viewer": {
          target: dicomwebTarget,
          changeOrigin: true,
          bypass(req) {
            if (req.url?.startsWith("/viewer/token/")) {
              return req.url;
            }
          },
        },
        // Keep viewer configuration relative in the RIS app while development
        // services continue to run on their own local ports.
        "/mobile": {
          target: mobileViewerTarget,
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/mobile/, "") || "/",
        },
        "/ecg": {
          target: ecgViewerTarget,
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/ecg/, "") || "/",
        },
      },
    },
    plugins: [react(), mode === "development" && componentTagger()].filter(Boolean),
    optimizeDeps: {
      exclude: ["xlsx-js-style"],
    },
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src"),
        "xlsx-js-style": path.resolve(__dirname, "./node_modules/xlsx-js-style/dist/xlsx.bundle.js"),
      },
    },
    build: {
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (!id.includes("node_modules")) return;

            if (id.includes("tinymce") || id.includes("@tinymce")) {
              return "tinymce-vendor";
            }

            if (id.includes("react") || id.includes("react-dom") || id.includes("react-router")) {
              return "react-vendor";
            }

            if (id.includes("@radix-ui")) {
              return "radix-vendor";
            }

            if (id.includes("@tanstack/react-query")) {
              return "query-vendor";
            }
          },
        },
      },
    },
  };
});
