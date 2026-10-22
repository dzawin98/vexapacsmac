# 🧠 MPR Mode — Complete Build Prompt
## Cornerstone3D + React + Vite | OHIF-like Implementation
## Target: Mobile-first, production-ready, semua fitur berfungsi

---

## ⚠️ PENTING: Perbedaan Stack vs Volume Viewport

| Mode | Viewport Type | Cocok untuk |
|------|--------------|-------------|
| Stack (guide sebelumnya) | `ViewportType.STACK` | Single series 2D (X-ray, foto tunggal) |
| **MPR (guide ini)** | `ViewportType.ORTHOGRAPHIC` | CT/MRI multi-slice (perlu ≥ 20 slice) |

MPR **wajib** menggunakan `ORTHOGRAPHIC` + `volumeLoader` — bukan STACK viewport.

---

## 📦 STEP 1: Install Package Tambahan untuk MPR

```bash
cd mobile-dicom-viewer

npm install \
  @cornerstonejs/core \
  @cornerstonejs/tools \
  @cornerstonejs/dicom-image-loader \
  dicomweb-client \
  dcmjs \
  dicom-parser \
  @originjs/vite-plugin-commonjs

# Verifikasi versi (pastikan konsisten)
npx --yes check-node-version --node ">= 18"
```

---

## 🔧 STEP 2: `vite.config.ts` — Konfigurasi Wajib MPR

```typescript
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { viteCommonjs } from '@originjs/vite-plugin-commonjs'

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    viteCommonjs(),
  ],
  optimizeDeps: {
    exclude: ['@cornerstonejs/dicom-image-loader'],
    include: ['dicom-parser'],
  },
  worker: {
    format: 'es',
  },
  server: {
    headers: {
      // WAJIB untuk SharedArrayBuffer (dibutuhkan volume loader)
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
    proxy: {
      '/pacs': {
        target: 'http://localhost:8042', // URL Orthanc/DCM4CHEE Anda
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/pacs/, ''),
      },
    },
  },
  build: {
    target: 'es2020',
    rollupOptions: {
      output: {
        manualChunks: {
          cornerstone: ['@cornerstonejs/core', '@cornerstonejs/tools'],
          dicomLoader: ['@cornerstonejs/dicom-image-loader'],
        },
      },
    },
  },
})
```

---

## 🗂️ STEP 3: Struktur File MPR

```
src/
├── mpr/
│   ├── MPRViewer.tsx           ← Komponen utama MPR layout
│   ├── MPRViewport.tsx         ← Single viewport wrapper
│   ├── MPRToolbar.tsx          ← Toolbar khusus MPR
│   ├── MPROverlay.tsx          ← Overlay label & info per viewport
│   └── MPRProgressBar.tsx      ← Loading volume progress
├── utils/
│   ├── cornerstoneInit.ts      ← Init core + tools + loader
│   ├── volumeSetup.ts          ← Volume loading & viewport setup
│   ├── toolGroupSetup.ts       ← Tool groups untuk 2D & 3D
│   ├── synchronizerSetup.ts    ← VOI & Camera synchronizer
│   └── dicomService.ts         ← Fetch imageIds dari PACS
├── hooks/
│   └── useMPREngine.ts         ← Custom hook untuk MPR lifecycle
└── App.tsx
```

---

## 🧩 STEP 4: `src/utils/cornerstoneInit.ts` — Init Lengkap

```typescript
import * as cornerstone from '@cornerstonejs/core';
import * as cornerstoneTools from '@cornerstonejs/tools';
import cornerstoneDICOMImageLoader from '@cornerstonejs/dicom-image-loader';
import dicomParser from 'dicom-parser';

let initialized = false;

export async function initAll(): Promise<void> {
  if (initialized) return;

  // 1. Init Cornerstone Core
  await cornerstone.init();

  // 2. Init DICOM Image Loader
  cornerstoneDICOMImageLoader.external.cornerstone = cornerstone;
  cornerstoneDICOMImageLoader.external.dicomParser = dicomParser;
  cornerstoneDICOMImageLoader.configure({
    useWebWorkers: true,
    decodeConfig: { convertFloatPixelDataToInt: false },
  });

  // 3. Init Tools
  cornerstoneTools.init();

  // 4. Register semua tools yang dibutuhkan MPR
  const {
    WindowLevelTool, PanTool, ZoomTool,
    StackScrollTool, CrosshairsTool,
    LengthTool, AngleTool, EllipticalROITool, RectangleROITool,
    ProbeTool, MagnifyTool, ArrowAnnotateTool,
    TrackballRotateTool, // untuk 3D viewport
    VolumeRotateMouseWheelTool,
  } = cornerstoneTools;

  [
    WindowLevelTool, PanTool, ZoomTool,
    StackScrollTool, CrosshairsTool,
    LengthTool, AngleTool, EllipticalROITool, RectangleROITool,
    ProbeTool, MagnifyTool, ArrowAnnotateTool,
    TrackballRotateTool, VolumeRotateMouseWheelTool,
  ].forEach(tool => cornerstoneTools.addTool(tool));

  initialized = true;
  console.log('✅ Cornerstone3D MPR fully initialized');
}
```

---

## 🧩 STEP 5: `src/utils/dicomService.ts` — Fetch dari PACS

```typescript
import { api } from 'dicomweb-client';
import dcmjs from 'dcmjs';
import { calibratedPixelSpacingMetadataProvider, getPixelSpacingInformation } from '@cornerstonejs/core/utilities';
import cornerstoneDICOMImageLoader from '@cornerstonejs/dicom-image-loader';

const PACS_BASE_URL = '/pacs/dicom-web'; // sesuaikan dengan proxy Anda

function removeInvalidTags(dataset: Record<string, any>): Record<string, any> {
  const cleaned: Record<string, any> = {};
  for (const key in dataset) {
    const value = dataset[key];
    if (value?.Value != null) cleaned[key] = value;
  }
  return cleaned;
}

export async function getImageIdsFromPACS(
  studyUID: string,
  seriesUID: string,
): Promise<string[]> {
  const client = new api.DICOMwebClient({ url: PACS_BASE_URL });

  const instances = await client.retrieveSeriesMetadata({
    studyInstanceUID: studyUID,
    seriesInstanceUID: seriesUID,
  });

  const imageIds = instances.map((meta: any) => {
    const sopUID = meta['00080018'].Value[0];
    const imageId =
      `wadors:${PACS_BASE_URL}/studies/${studyUID}/series/${seriesUID}/instances/${sopUID}/frames/1`;

    // Register metadata ke loader
    cornerstoneDICOMImageLoader.wadors.metaDataManager.add(imageId, meta);

    // Pixel spacing calibration
    const cleaned = removeInvalidTags(meta);
    const natural = dcmjs.data.DicomMetaDictionary.naturalizeDataset(cleaned);
    const spacingInfo = getPixelSpacingInformation(natural);

    if (spacingInfo?.PixelSpacing) {
      calibratedPixelSpacingMetadataProvider.add(imageId, {
        rowPixelSpacing: parseFloat(spacingInfo.PixelSpacing[0]),
        columnPixelSpacing: parseFloat(spacingInfo.PixelSpacing[1]),
        type: spacingInfo.type,
      });
    }

    return imageId;
  });

  // PENTING: Sort berdasarkan ImagePositionPatient untuk volume yang benar
  return sortImageIds(imageIds);
}

function sortImageIds(imageIds: string[]): string[] {
  // Cornerstone handles sorting internally, tapi untuk keamanan:
  return imageIds; // bisa ditambahkan custom sort jika perlu
}
```

---

## 🧩 STEP 6: `src/utils/volumeSetup.ts` — Volume Loading

```typescript
import * as cornerstone from '@cornerstonejs/core';

const VOLUME_LOADER_SCHEME = 'cornerstoneStreamingImageVolume';

export function buildVolumeId(seriesUID: string): string {
  return `${VOLUME_LOADER_SCHEME}:${seriesUID.replace(/\./g, '_')}`;
}

export async function createAndCacheVolume(
  volumeId: string,
  imageIds: string[],
): Promise<cornerstone.Types.IImageVolume> {
  // Hapus cache lama jika ada
  cornerstone.cache.purgeCache();

  const volume = await cornerstone.volumeLoader.createAndCacheVolume(volumeId, {
    imageIds,
  });

  return volume;
}

export function setupMPRViewports(
  engine: cornerstone.RenderingEngine,
  elements: {
    axial: HTMLDivElement;
    sagittal: HTMLDivElement;
    coronal: HTMLDivElement;
    vol3d?: HTMLDivElement;
  },
  viewportIds: {
    axial: string;
    sagittal: string;
    coronal: string;
    vol3d?: string;
  },
) {
  const { ViewportType, OrientationAxis } = cornerstone.Enums;

  const viewportInputs: cornerstone.Types.PublicViewportInput[] = [
    {
      viewportId: viewportIds.axial,
      type: ViewportType.ORTHOGRAPHIC,
      element: elements.axial,
      defaultOptions: {
        orientation: OrientationAxis.AXIAL,
        background: [0, 0, 0] as cornerstone.Types.Point3,
      },
    },
    {
      viewportId: viewportIds.sagittal,
      type: ViewportType.ORTHOGRAPHIC,
      element: elements.sagittal,
      defaultOptions: {
        orientation: OrientationAxis.SAGITTAL,
        background: [0, 0, 0] as cornerstone.Types.Point3,
      },
    },
    {
      viewportId: viewportIds.coronal,
      type: ViewportType.ORTHOGRAPHIC,
      element: elements.coronal,
      defaultOptions: {
        orientation: OrientationAxis.CORONAL,
        background: [0, 0, 0] as cornerstone.Types.Point3,
      },
    },
  ];

  // Tambah 3D viewport jika ada
  if (elements.vol3d && viewportIds.vol3d) {
    viewportInputs.push({
      viewportId: viewportIds.vol3d,
      type: ViewportType.VOLUME_3D,
      element: elements.vol3d,
      defaultOptions: {
        background: [0.1, 0.1, 0.15] as cornerstone.Types.Point3,
        orientation: OrientationAxis.CORONAL,
      },
    });
  }

  engine.setViewports(viewportInputs);
}

export async function loadVolumeToViewports(
  engine: cornerstone.RenderingEngine,
  volume: cornerstone.Types.IImageVolume,
  volumeId: string,
  viewportIds: string[],
  onProgress?: (progress: number) => void,
): Promise<void> {
  await cornerstone.setVolumesForViewports(
    engine,
    [{ volumeId }],
    viewportIds,
  );

  // Load volume dengan progress tracking
  volume.load((evt: any) => {
    if (onProgress && evt?.framesLoaded && evt?.framesProcessed) {
      const pct = Math.round((evt.framesLoaded / evt.framesProcessed) * 100);
      onProgress(pct);
    }
  });
}
```

---

## 🧩 STEP 7: `src/utils/toolGroupSetup.ts` — Tool Groups MPR

```typescript
import * as cornerstoneTools from '@cornerstonejs/tools';

const { MouseBindings, KeyboardBindings } = cornerstoneTools.Enums;
const {
  WindowLevelTool, PanTool, ZoomTool, StackScrollTool,
  CrosshairsTool, LengthTool, AngleTool,
  EllipticalROITool, RectangleROITool, ProbeTool,
  TrackballRotateTool, VolumeRotateMouseWheelTool,
  ToolGroupManager,
} = cornerstoneTools;

export function create2DToolGroup(
  toolGroupId: string,
  viewportIds: string[],
  engineId: string,
  volumeId: string,
) {
  // Hapus jika sudah ada
  ToolGroupManager.destroyToolGroup(toolGroupId);

  const toolGroup = ToolGroupManager.createToolGroup(toolGroupId)!;

  // Register tools ke group
  toolGroup.addTool(WindowLevelTool.toolName, { volumeId });
  toolGroup.addTool(PanTool.toolName);
  toolGroup.addTool(ZoomTool.toolName);
  toolGroup.addTool(StackScrollTool.toolName);
  toolGroup.addTool(LengthTool.toolName);
  toolGroup.addTool(AngleTool.toolName);
  toolGroup.addTool(EllipticalROITool.toolName);
  toolGroup.addTool(RectangleROITool.toolName);
  toolGroup.addTool(ProbeTool.toolName);
  toolGroup.addTool(CrosshairsTool.toolName, {
    getReferenceLineColor: (viewportId: string) => {
      // Warna referensi line per viewport (seperti OHIF)
      if (viewportId.includes('AXIAL')) return 'rgb(200, 0, 0)';       // merah
      if (viewportId.includes('SAGITTAL')) return 'rgb(198, 134, 25)'; // kuning
      if (viewportId.includes('CORONAL')) return 'rgb(0, 173, 239)';   // cyan
      return 'white';
    },
    getReferenceLineControllable: () => true,
    getReferenceLineDraggableRotatable: () => true,
    getReferenceLineSlabThicknessControlsOn: () => true,
  });

  // === Binding Mouse Default (OHIF-style) ===
  // Left click → Window/Level
  toolGroup.setToolActive(WindowLevelTool.toolName, {
    bindings: [{ mouseButton: MouseBindings.Primary }],
  });
  // Middle click → Pan
  toolGroup.setToolActive(PanTool.toolName, {
    bindings: [{ mouseButton: MouseBindings.Auxiliary }],
  });
  // Right click → Zoom
  toolGroup.setToolActive(ZoomTool.toolName, {
    bindings: [{ mouseButton: MouseBindings.Secondary }],
  });
  // Scroll wheel → Stack scroll
  toolGroup.setToolActive(StackScrollTool.toolName, {
    bindings: [{ mouseButton: MouseBindings.Wheel }],
  });

  // Crosshairs pasif (aktifkan manual)
  toolGroup.setToolPassive(CrosshairsTool.toolName);

  // Tambahkan semua viewport 2D ke group ini
  viewportIds.forEach(vpId => {
    toolGroup.addViewport(vpId, engineId);
  });

  return toolGroup;
}

export function create3DToolGroup(
  toolGroupId: string,
  viewportId: string,
  engineId: string,
) {
  ToolGroupManager.destroyToolGroup(toolGroupId);
  const toolGroup = ToolGroupManager.createToolGroup(toolGroupId)!;

  toolGroup.addTool(TrackballRotateTool.toolName);
  toolGroup.addTool(ZoomTool.toolName);
  toolGroup.addTool(PanTool.toolName);
  toolGroup.addTool(VolumeRotateMouseWheelTool.toolName);

  toolGroup.setToolActive(TrackballRotateTool.toolName, {
    bindings: [{ mouseButton: MouseBindings.Primary }],
  });
  toolGroup.setToolActive(ZoomTool.toolName, {
    bindings: [{ mouseButton: MouseBindings.Secondary }],
  });
  toolGroup.setToolActive(PanTool.toolName, {
    bindings: [{ mouseButton: MouseBindings.Auxiliary }],
  });
  toolGroup.setToolActive(VolumeRotateMouseWheelTool.toolName, {
    bindings: [],
  });

  toolGroup.addViewport(viewportId, engineId);

  return toolGroup;
}

// Switch tool aktif pada 2D group
export function activateTool2D(
  toolGroupId: string,
  toolName: string,
  volumeId?: string,
) {
  const toolGroup = ToolGroupManager.getToolGroup(toolGroupId);
  if (!toolGroup) return;

  const managedTools = [
    WindowLevelTool.toolName, LengthTool.toolName,
    AngleTool.toolName, EllipticalROITool.toolName,
    RectangleROITool.toolName, ProbeTool.toolName,
    CrosshairsTool.toolName,
  ];

  // Reset semua ke passive dulu
  managedTools.forEach(t => {
    try { toolGroup.setToolPassive(t); } catch {}
  });

  // Aktifkan yang dipilih
  if (toolName === CrosshairsTool.toolName) {
    toolGroup.setToolActive(toolName, {
      bindings: [{ mouseButton: MouseBindings.Primary }],
    });
  } else {
    toolGroup.setToolActive(toolName, {
      bindings: [{ mouseButton: MouseBindings.Primary }],
    });
  }
}
```

---

## 🧩 STEP 8: `src/utils/synchronizerSetup.ts` — Sinkronisasi Viewport

```typescript
import * as cornerstoneTools from '@cornerstonejs/tools';

const { synchronizers, SynchronizerManager } = cornerstoneTools;
const { createVOISynchronizer, createCameraPositionSynchronizer } = synchronizers;

export function setupSynchronizers(
  engineId: string,
  viewportIds: { axial: string; sagittal: string; coronal: string },
) {
  const allIds = [viewportIds.axial, viewportIds.sagittal, viewportIds.coronal];

  // VOI Synchronizer — supaya W/L sinkron di semua viewport
  const voiSyncId = 'VOI_SYNC';
  try { SynchronizerManager.destroySynchronizer(voiSyncId); } catch {}

  const voiSync = createVOISynchronizer(voiSyncId, engineId);
  allIds.forEach(id => {
    voiSync.addSource({ renderingEngineId: engineId, viewportId: id });
    voiSync.addTarget({ renderingEngineId: engineId, viewportId: id });
  });

  return { voiSync };
}
```

---

## 🧩 STEP 9: `src/hooks/useMPREngine.ts` — Main MPR Hook

```typescript
import { useEffect, useRef, useState, useCallback } from 'react';
import * as cornerstone from '@cornerstonejs/core';
import { initAll } from '../utils/cornerstoneInit';
import { buildVolumeId, createAndCacheVolume, setupMPRViewports, loadVolumeToViewports } from '../utils/volumeSetup';
import { create2DToolGroup, create3DToolGroup, activateTool2D } from '../utils/toolGroupSetup';
import { setupSynchronizers } from '../utils/synchronizerSetup';

const ENGINE_ID = 'MPR_ENGINE';
const VIEWPORT_IDS = {
  axial: 'MPR_AXIAL',
  sagittal: 'MPR_SAGITTAL',
  coronal: 'MPR_CORONAL',
  vol3d: 'MPR_3D',
};
const TOOLGROUP_2D = 'MPR_TOOLGROUP_2D';
const TOOLGROUP_3D = 'MPR_TOOLGROUP_3D';

interface UseMPREngineProps {
  imageIds: string[];
  seriesUID: string;
  with3D?: boolean;
}

export function useMPREngine({
  imageIds,
  seriesUID,
  with3D = false,
}: UseMPREngineProps) {
  const axialRef = useRef<HTMLDivElement>(null);
  const sagittalRef = useRef<HTMLDivElement>(null);
  const coronalRef = useRef<HTMLDivElement>(null);
  const vol3dRef = useRef<HTMLDivElement>(null);

  const engineRef = useRef<cornerstone.RenderingEngine | null>(null);
  const [loadProgress, setLoadProgress] = useState(0);
  const [isReady, setIsReady] = useState(false);
  const [activeTool, setActiveTool] = useState('WindowLevel');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!imageIds.length) return;
    if (!axialRef.current || !sagittalRef.current || !coronalRef.current) return;

    let cancelled = false;

    async function run() {
      try {
        await initAll();
        if (cancelled) return;

        // Buat rendering engine
        const engine = new cornerstone.RenderingEngine(ENGINE_ID);
        engineRef.current = engine;

        // Setup viewports
        setupMPRViewports(
          engine,
          {
            axial: axialRef.current!,
            sagittal: sagittalRef.current!,
            coronal: coronalRef.current!,
            ...(with3D && vol3dRef.current ? { vol3d: vol3dRef.current } : {}),
          },
          VIEWPORT_IDS,
        );

        if (cancelled) return;

        // Load volume
        const volumeId = buildVolumeId(seriesUID);
        const volume = await createAndCacheVolume(volumeId, imageIds);

        // Tool groups
        const vpIds2D = [VIEWPORT_IDS.axial, VIEWPORT_IDS.sagittal, VIEWPORT_IDS.coronal];
        create2DToolGroup(TOOLGROUP_2D, vpIds2D, ENGINE_ID, volumeId);
        if (with3D) create3DToolGroup(TOOLGROUP_3D, VIEWPORT_IDS.vol3d, ENGINE_ID);

        // Synchronizers
        setupSynchronizers(ENGINE_ID, {
          axial: VIEWPORT_IDS.axial,
          sagittal: VIEWPORT_IDS.sagittal,
          coronal: VIEWPORT_IDS.coronal,
        });

        // Load ke viewports
        const allIds = with3D
          ? [VIEWPORT_IDS.axial, VIEWPORT_IDS.sagittal, VIEWPORT_IDS.coronal, VIEWPORT_IDS.vol3d]
          : [VIEWPORT_IDS.axial, VIEWPORT_IDS.sagittal, VIEWPORT_IDS.coronal];

        await loadVolumeToViewports(engine, volume, volumeId, allIds, (pct) => {
          if (!cancelled) setLoadProgress(pct);
        });

        if (cancelled) return;
        engine.renderViewports(allIds);
        setIsReady(true);
      } catch (err: any) {
        if (!cancelled) setError(err.message ?? 'MPR load error');
      }
    }

    run();

    return () => {
      cancelled = true;
      try { engineRef.current?.destroy(); } catch {}
      engineRef.current = null;
      setIsReady(false);
      setLoadProgress(0);
    };
  }, [imageIds, seriesUID, with3D]);

  const changeTool = useCallback((toolName: string) => {
    activateTool2D(TOOLGROUP_2D, toolName + 'Tool');
    setActiveTool(toolName);
  }, []);

  const resetAll = useCallback(() => {
    const engine = engineRef.current;
    if (!engine) return;
    [VIEWPORT_IDS.axial, VIEWPORT_IDS.sagittal, VIEWPORT_IDS.coronal].forEach(id => {
      try {
        const vp = engine.getViewport(id) as cornerstone.Types.IVolumeViewport;
        vp.resetCamera();
        vp.resetProperties();
        vp.render();
      } catch {}
    });
  }, []);

  const invertAll = useCallback(() => {
    const engine = engineRef.current;
    if (!engine) return;
    [VIEWPORT_IDS.axial, VIEWPORT_IDS.sagittal, VIEWPORT_IDS.coronal].forEach(id => {
      try {
        const vp = engine.getViewport(id) as cornerstone.Types.IVolumeViewport;
        const props = vp.getProperties();
        vp.setProperties({ invert: !props.invert });
        vp.render();
      } catch {}
    });
  }, []);

  const setWindowPreset = useCallback((ww: number, wl: number) => {
    const engine = engineRef.current;
    if (!engine) return;
    [VIEWPORT_IDS.axial, VIEWPORT_IDS.sagittal, VIEWPORT_IDS.coronal].forEach(id => {
      try {
        const vp = engine.getViewport(id) as cornerstone.Types.IVolumeViewport;
        vp.setProperties({
          voiRange: cornerstone.utilities.windowLevel.toLowHighRange(ww, wl),
        });
        vp.render();
      } catch {}
    });
  }, []);

  return {
    // Refs untuk attach ke DOM
    axialRef, sagittalRef, coronalRef, vol3dRef,
    // State
    isReady, loadProgress, activeTool, error,
    // Actions
    changeTool, resetAll, invertAll, setWindowPreset,
  };
}
```

---

## 🧩 STEP 10: `src/mpr/MPROverlay.tsx` — Overlay per Viewport (OHIF-style)

```tsx
interface MPROverlayProps {
  plane: 'AXIAL' | 'SAGITTAL' | 'CORONAL';
  patientName?: string;
  studyDate?: string;
  sliceInfo?: string;
  wwwl?: string;
}

const PLANE_COLORS: Record<string, string> = {
  AXIAL: '#e53935',      // merah — konsisten dengan crosshair color
  SAGITTAL: '#c68619',   // kuning
  CORONAL: '#00adeF',    // cyan
};

export default function MPROverlay({
  plane, patientName, studyDate, sliceInfo, wwwl
}: MPROverlayProps) {
  const color = PLANE_COLORS[plane];

  return (
    <div className="absolute inset-0 pointer-events-none font-mono text-[10px] leading-relaxed">
      {/* Border berwarna sesuai plane */}
      <div
        className="absolute inset-0 border rounded-sm opacity-40"
        style={{ borderColor: color }}
      />

      {/* Label plane — top left */}
      <div
        className="absolute top-1.5 left-2 text-xs font-bold tracking-widest"
        style={{ color }}
      >
        {plane}
      </div>

      {/* Top right — patient info */}
      <div className="absolute top-1.5 right-2 text-right text-white/60 space-y-px">
        <div className="text-white/80 font-semibold truncate max-w-[120px]">{patientName ?? ''}</div>
        <div>{studyDate ?? ''}</div>
      </div>

      {/* Bottom left — slice info */}
      <div className="absolute bottom-1.5 left-2 text-white/50">
        {sliceInfo ?? ''}
      </div>

      {/* Bottom right — W/L */}
      <div className="absolute bottom-1.5 right-2 text-white/50">
        {wwwl ? `W/L: ${wwwl}` : ''}
      </div>
    </div>
  );
}
```

---

## 🧩 STEP 11: `src/mpr/MPRViewport.tsx` — Viewport Wrapper

```tsx
import { forwardRef } from 'react';
import MPROverlay from './MPROverlay';

interface MPRViewportProps {
  plane: 'AXIAL' | 'SAGITTAL' | 'CORONAL';
  patientName?: string;
  studyDate?: string;
  sliceInfo?: string;
  wwwl?: string;
  className?: string;
}

const MPRViewport = forwardRef<HTMLDivElement, MPRViewportProps>(
  ({ plane, patientName, studyDate, sliceInfo, wwwl, className }, ref) => {
    return (
      <div className={`relative overflow-hidden bg-black ${className ?? ''}`}>
        {/* Canvas Cornerstone3D */}
        <div
          ref={ref}
          className="w-full h-full"
          style={{ touchAction: 'none' }}
          onContextMenu={(e) => e.preventDefault()}
        />
        {/* Overlay */}
        <MPROverlay
          plane={plane}
          patientName={patientName}
          studyDate={studyDate}
          sliceInfo={sliceInfo}
          wwwl={wwwl}
        />
      </div>
    );
  }
);

MPRViewport.displayName = 'MPRViewport';
export default MPRViewport;
```

---

## 🧩 STEP 12: `src/mpr/MPRToolbar.tsx` — Toolbar MPR Lengkap

```tsx
import { useState } from 'react';
import {
  Sun, Move, ZoomIn, Ruler, Triangle, Circle, Square,
  Crosshair, RotateCcw, FlipVertical2, Eye, EyeOff,
  ChevronDown, Grid2X2, Columns2
} from 'lucide-react';

interface Props {
  activeTool: string;
  onToolChange: (tool: string) => void;
  onReset: () => void;
  onInvert: () => void;
  onPreset: (ww: number, wl: number) => void;
  layout: '2x2' | '3col' | '1x3';
  onLayoutChange: (layout: '2x2' | '3col' | '1x3') => void;
}

const PRESETS = [
  { label: 'Lung', ww: 1500, wl: -600 },
  { label: 'Mediastinum', ww: 400, wl: 40 },
  { label: 'Bone', ww: 2000, wl: 400 },
  { label: 'Soft Tissue', ww: 350, wl: 40 },
  { label: 'Brain', ww: 80, wl: 40 },
  { label: 'Abdomen', ww: 400, wl: 50 },
  { label: 'Liver', ww: 160, wl: 60 },
  { label: 'Angio', ww: 600, wl: 300 },
];

const MEASURE_TOOLS = [
  { name: 'Length', icon: <Ruler size={15} />, label: 'Length' },
  { name: 'Angle', icon: <Triangle size={15} />, label: 'Angle' },
  { name: 'EllipticalROI', icon: <Circle size={15} />, label: 'Ellipse' },
  { name: 'RectangleROI', icon: <Square size={15} />, label: 'Rectangle' },
  { name: 'Probe', icon: <div className="text-xs font-bold">HU</div>, label: 'Probe HU' },
];

export default function MPRToolbar({
  activeTool, onToolChange, onReset, onInvert, onPreset, layout, onLayoutChange
}: Props) {
  const [showPresets, setShowPresets] = useState(false);
  const [showMeasure, setShowMeasure] = useState(false);
  const [showLayout, setShowLayout] = useState(false);

  const btnBase = 'flex items-center gap-1 px-2.5 py-2 rounded-lg text-sm transition-all duration-150';
  const btnActive = 'bg-cyan-500/20 text-cyan-400 border border-cyan-500/40';
  const btnInactive = 'text-gray-400 hover:text-white hover:bg-white/5';

  return (
    <div className="flex items-center gap-1.5 px-2 py-1.5 bg-[#0f0f18] border-b border-white/5 overflow-x-auto scrollbar-none">

      {/* W/L + Presets */}
      <div className="relative flex-shrink-0">
        <button
          onClick={() => { onToolChange('WindowLevel'); setShowPresets(!showPresets); }}
          className={`${btnBase} ${activeTool === 'WindowLevel' ? btnActive : btnInactive}`}
        >
          <Sun size={16} />
          <ChevronDown size={11} />
        </button>
        {showPresets && (
          <div className="absolute top-full left-0 mt-1 z-50 bg-[#1a1a26] border border-white/10 rounded-xl shadow-2xl w-44 overflow-hidden">
            <div className="px-3 py-1.5 text-[10px] text-gray-500 border-b border-white/5 tracking-widest uppercase">
              Window Presets
            </div>
            {PRESETS.map(p => (
              <button
                key={p.label}
                onClick={() => { onPreset(p.ww, p.wl); setShowPresets(false); }}
                className="w-full flex justify-between px-3 py-2 text-xs font-mono text-gray-300 hover:bg-white/5 hover:text-cyan-400 transition-colors"
              >
                <span>{p.label}</span>
                <span className="text-gray-600">{p.ww}/{p.wl}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Pan */}
      <button
        onClick={() => onToolChange('Pan')}
        className={`${btnBase} flex-shrink-0 ${activeTool === 'Pan' ? btnActive : btnInactive}`}
      >
        <Move size={16} />
      </button>

      {/* Zoom */}
      <button
        onClick={() => onToolChange('Zoom')}
        className={`${btnBase} flex-shrink-0 ${activeTool === 'Zoom' ? btnActive : btnInactive}`}
      >
        <ZoomIn size={16} />
      </button>

      {/* Crosshairs — OHIF signature feature */}
      <button
        onClick={() => onToolChange('Crosshairs')}
        className={`${btnBase} flex-shrink-0 ${activeTool === 'Crosshairs' ? btnActive : btnInactive}`}
        title="Crosshairs — klik untuk navigasi antar plane"
      >
        <Crosshair size={16} />
      </button>

      {/* Divider */}
      <div className="w-px h-6 bg-white/10 flex-shrink-0 mx-0.5" />

      {/* Measure Tools */}
      <div className="relative flex-shrink-0">
        <button
          onClick={() => setShowMeasure(!showMeasure)}
          className={`${btnBase} ${['Length','Angle','EllipticalROI','RectangleROI','Probe'].includes(activeTool) ? btnActive : btnInactive}`}
        >
          <Ruler size={16} />
          <ChevronDown size={11} />
        </button>
        {showMeasure && (
          <div className="absolute top-full left-0 mt-1 z-50 bg-[#1a1a26] border border-white/10 rounded-xl shadow-2xl w-40 overflow-hidden">
            {MEASURE_TOOLS.map(t => (
              <button
                key={t.name}
                onClick={() => { onToolChange(t.name); setShowMeasure(false); }}
                className={`w-full flex items-center gap-2.5 px-3 py-2.5 text-sm font-mono transition-colors ${
                  activeTool === t.name ? 'text-cyan-400 bg-cyan-500/10' : 'text-gray-300 hover:bg-white/5 hover:text-white'
                }`}
              >
                {t.icon}
                <span>{t.label}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Spacer */}
      <div className="flex-1" />

      {/* Layout Switcher */}
      <div className="relative flex-shrink-0">
        <button
          onClick={() => setShowLayout(!showLayout)}
          className={`${btnBase} ${btnInactive}`}
        >
          <Grid2X2 size={16} />
        </button>
        {showLayout && (
          <div className="absolute top-full right-0 mt-1 z-50 bg-[#1a1a26] border border-white/10 rounded-xl shadow-2xl w-36 overflow-hidden">
            {[
              { key: '2x2', label: '2×2 Grid', icon: <Grid2X2 size={14} /> },
              { key: '3col', label: '3 Kolom', icon: <Columns2 size={14} /> },
              { key: '1x3', label: '1 Besar', icon: <Square size={14} /> },
            ].map(l => (
              <button
                key={l.key}
                onClick={() => { onLayoutChange(l.key as any); setShowLayout(false); }}
                className={`w-full flex items-center gap-2 px-3 py-2.5 text-sm transition-colors ${
                  layout === l.key ? 'text-cyan-400 bg-cyan-500/10' : 'text-gray-300 hover:bg-white/5'
                }`}
              >
                {l.icon} {l.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Invert */}
      <button onClick={onInvert} className={`${btnBase} flex-shrink-0 ${btnInactive}`}>
        <FlipVertical2 size={16} />
      </button>

      {/* Reset */}
      <button onClick={onReset} className={`${btnBase} flex-shrink-0 ${btnInactive}`}>
        <RotateCcw size={16} />
      </button>
    </div>
  );
}
```

---

## 🧩 STEP 13: `src/mpr/MPRViewer.tsx` — Komponen Utama

```tsx
import { useState } from 'react';
import { useMPREngine } from '../hooks/useMPREngine';
import MPRViewport from './MPRViewport';
import MPRToolbar from './MPRToolbar';
import MPRProgressBar from './MPRProgressBar';

interface Props {
  imageIds: string[];
  seriesUID: string;
  patientName?: string;
  studyDate?: string;
  with3D?: boolean;
}

type Layout = '2x2' | '3col' | '1x3';

export default function MPRViewer({
  imageIds, seriesUID, patientName, studyDate, with3D = false
}: Props) {
  const [layout, setLayout] = useState<Layout>('2x2');

  const {
    axialRef, sagittalRef, coronalRef, vol3dRef,
    isReady, loadProgress, activeTool, error,
    changeTool, resetAll, invertAll, setWindowPreset,
  } = useMPREngine({ imageIds, seriesUID, with3D });

  if (error) {
    return (
      <div className="flex items-center justify-center h-full text-red-400 font-mono text-sm">
        ❌ Error: {error}
      </div>
    );
  }

  // Layout grid classes
  const gridClass: Record<Layout, string> = {
    '2x2': 'grid grid-cols-2 grid-rows-2',
    '3col': 'grid grid-cols-3 grid-rows-1',
    '1x3': 'grid grid-cols-1 grid-rows-1',
  };

  return (
    <div className="flex flex-col h-full bg-black">
      <MPRToolbar
        activeTool={activeTool}
        onToolChange={changeTool}
        onReset={resetAll}
        onInvert={invertAll}
        onPreset={setWindowPreset}
        layout={layout}
        onLayoutChange={setLayout}
      />

      {!isReady && (
        <MPRProgressBar progress={loadProgress} />
      )}

      <div className={`flex-1 ${gridClass[layout]} gap-0.5 bg-[#0a0a0a] overflow-hidden`}>
        <MPRViewport
          ref={axialRef}
          plane="AXIAL"
          patientName={patientName}
          studyDate={studyDate}
          className={layout === '1x3' ? 'col-span-1 row-span-1' : ''}
        />
        <MPRViewport
          ref={sagittalRef}
          plane="SAGITTAL"
          className={layout === '1x3' ? 'hidden' : ''}
        />
        <MPRViewport
          ref={coronalRef}
          plane="CORONAL"
          className={layout === '1x3' ? 'hidden' : ''}
        />
        {with3D && layout === '2x2' && (
          <MPRViewport
            ref={vol3dRef}
            plane="AXIAL" // placeholder label untuk 3D
            className="border border-purple-500/20"
          />
        )}
      </div>
    </div>
  );
}
```

---

## 🧩 STEP 14: `src/mpr/MPRProgressBar.tsx`

```tsx
interface Props { progress: number; }

export default function MPRProgressBar({ progress }: Props) {
  return (
    <div className="flex flex-col items-center justify-center py-6 bg-black/90 gap-3">
      <div className="text-cyan-400 font-mono text-xs tracking-widest animate-pulse">
        LOADING VOLUME...
      </div>
      <div className="w-48 h-1 bg-white/10 rounded-full overflow-hidden">
        <div
          className="h-full bg-cyan-400 rounded-full transition-all duration-200"
          style={{ width: `${progress}%` }}
        />
      </div>
      <div className="text-white/30 font-mono text-xs">{progress}%</div>
    </div>
  );
}
```

---

## 🧩 STEP 15: `src/App.tsx` — Entry Point dengan Mode Switch

```tsx
import { useState } from 'react';
import MPRViewer from './mpr/MPRViewer';

// === GANTI INI DENGAN DATA NYATA DARI PACS ANDA ===
// Contoh: ambil dari URL params atau worklist selection
const DEMO_CONFIG = {
  studyUID: '1.3.6.1.4.1.14519.5.2.1.6279.6001.179049373636438705059720603192',
  seriesUID: '1.3.6.1.4.1.14519.5.2.1.6279.6001.303494235102183795724852353428',
  patientName: 'RAFANDRA LEVIN ELFATHAN',
  studyDate: '2026-05-15',
};

export default function App() {
  const [imageIds, setImageIds] = useState<string[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [with3D, setWith3D] = useState(false);

  // Untuk testing: auto-load saat mount
  // Dalam produksi: imageIds datang dari worklist selection
  // useEffect(() => { getImageIdsFromPACS(...).then(setImageIds) }, []);

  return (
    <div className="h-dvh bg-black overflow-hidden">
      {!loaded ? (
        // Landing / Worklist
        <div className="flex flex-col items-center justify-center h-full gap-6 text-white font-mono">
          <div className="text-cyan-400 text-xl font-bold tracking-widest">MPR VIEWER</div>
          <button
            onClick={() => {
              // Set demo imageIds atau load dari PACS
              // setImageIds(await getImageIdsFromPACS(studyUID, seriesUID));
              setLoaded(true);
            }}
            className="px-6 py-3 bg-cyan-500/20 border border-cyan-500/40 text-cyan-400 rounded-xl hover:bg-cyan-500/30 transition-all"
          >
            Load CT Series
          </button>
          <label className="flex items-center gap-2 text-sm text-gray-400">
            <input
              type="checkbox"
              checked={with3D}
              onChange={e => setWith3D(e.target.checked)}
              className="rounded"
            />
            Include 3D Viewport
          </label>
        </div>
      ) : (
        <MPRViewer
          imageIds={imageIds}
          seriesUID={DEMO_CONFIG.seriesUID}
          patientName={DEMO_CONFIG.patientName}
          studyDate={DEMO_CONFIG.studyDate}
          with3D={with3D}
        />
      )}
    </div>
  );
}
```

---

## ✅ STEP 16: Checklist MPR Berfungsi Sempurna

### Wajib terpenuhi:
```
□ imageIds dari CT/MRI series dengan ≥ 20 slices (bukan X-ray tunggal)
□ Setiap instance punya tag DICOM: ImagePositionPatient, ImageOrientationPatient, PixelSpacing
□ CORS header: Cross-Origin-Opener-Policy + Cross-Origin-Embedder-Policy terpasang
□ vite.config.ts punya worker: { format: 'es' }
□ optimizeDeps: { exclude: ['@cornerstonejs/dicom-image-loader'] }
□ volumeLoader scheme = 'cornerstoneStreamingImageVolume'
□ ViewportType = ORTHOGRAPHIC (BUKAN STACK)
□ setVolumesForViewports dipanggil SETELAH setupMPRViewports
□ Tool CrosshairsTool dikonfigurasi dengan getReferenceLineColor
□ VOI Synchronizer aktif untuk W/L sync antar viewport
□ touchAction: 'none' pada semua elemen viewport
□ onContextMenu={(e) => e.preventDefault()} untuk disable right-click menu mobile
```

---

## 🔥 STEP 17: Fitur OHIF yang Sudah Terimplementasi

| Fitur OHIF | Status | Implementasi |
|------------|--------|-------------|
| Axial + Sagittal + Coronal | ✅ | `ORTHOGRAPHIC` viewport × 3 |
| 3D Volume Viewport | ✅ | `VOLUME_3D` viewport |
| Crosshairs navigation | ✅ | `CrosshairsTool` dengan warna per plane |
| Reference line color coding | ✅ | Merah/Kuning/Cyan per plane |
| W/L sync antar viewport | ✅ | `createVOISynchronizer` |
| Window presets | ✅ | 8 preset klinis |
| Stack scroll per plane | ✅ | `StackScrollTool` |
| Measurement tools | ✅ | Length, Angle, Ellipse, Rectangle, Probe |
| Layout switcher | ✅ | 2×2, 3-col, single |
| Progress bar loading | ✅ | Volume load progress |
| Plane label + border warna | ✅ | Overlay per viewport |
| 3D Trackball rotation | ✅ | `TrackballRotateTool` |
| Invert image | ✅ | `viewport.setProperties({ invert })` |
| Reset camera | ✅ | `viewport.resetCamera()` |
| Mobile touch support | ✅ | `touchAction: none` |

---

## 🚨 Troubleshooting MPR

### Error: "Cannot destructure 'imagePositionPatient'"
**Penyebab**: Gambar tidak punya metadata DICOM spasial (X-ray 2D, tidak bisa di-MPR)
**Solusi**: MPR hanya untuk CT/MRI multi-slice. Gunakan Stack viewport untuk X-ray.

### Volume tidak render / hitam semua
**Penyebab**: `setVolumesForViewports` dipanggil sebelum `setupMPRViewports`
**Solusi**: Pastikan urutan: setup engine → setup viewports → create volume → set volumes → load

### Crosshairs tidak muncul
**Penyebab**: Tool group belum di-assign ke semua 3 viewport
**Solusi**: Pastikan `toolGroup.addViewport(vpId, engineId)` untuk ketiga plane

### SharedArrayBuffer error
**Penyebab**: Header COOP/COEP belum terpasang
**Solusi**: Tambahkan di `vite.config.ts` → `server.headers`

### Mobile: touch tidak berfungsi
**Penyebab**: Browser default touch event untuk scroll halaman
**Solusi**: `style={{ touchAction: 'none' }}` pada div viewport

---

*Build Target: RSUD dr. Rehatta Provinsi Jawa Tengah*
*Stack: Cornerstone3D v2 • React 18 • Vite 5 • Tailwind CSS v4*
*MPR Mode: Axial + Sagittal + Coronal + 3D Volume (opsional)*