export const permissions = [
  { id: 'service.manage', label: 'Manage users and roles', group: 'Administration' },
  { id: 'study.view', label: 'Open studies and series', group: 'Studies' },
  { id: 'study.view_related_history', label: 'View related patient history', group: 'Studies' },
  { id: 'viewer.layout.change', label: 'Change viewport layout', group: 'Viewer' },
  { id: 'viewer.series.drag_drop', label: 'Drag series into a viewport', group: 'Viewer' },
  { id: 'viewer.intellilink.use', label: 'Use IntelliLink', group: 'Viewer' },
  { id: 'viewer.export.use', label: 'Export images, PDF, cine, and DICOM Print', group: 'Export & Print' },
  { id: 'settings.toolbar.customize', label: 'Customize toolbar favorites', group: 'Settings' },
  { id: 'settings.appearance.customize', label: 'Customize viewer appearance', group: 'Settings' },
  { id: 'settings.hotkeys.customize', label: 'Customize hotkeys', group: 'Settings' },
  { id: 'tool.navigation.use', label: 'Use navigation tools', group: 'Tools' },
  { id: 'tool.window_level.use', label: 'Use Window/Level', group: 'Tools' },
  { id: 'tool.preset.use', label: 'Use window presets', group: 'Tools' },
  { id: 'tool.measurement.use', label: 'Use measurements', group: 'Tools' },
  { id: 'tool.annotation.use', label: 'Use annotations', group: 'Tools' },
  { id: 'tool.orientation.use', label: 'Use orientation tools', group: 'Tools' },
  { id: 'tool.overlay.toggle', label: 'Toggle image overlay', group: 'Tools' },
  { id: 'tool.reference_lines.use', label: 'Use reference lines', group: 'Tools' },
  { id: 'ich.segmentation.use', label: 'Create and edit ICH segmentation', group: 'ICH Segmentation' },
  { id: 'ich.segmentation.save', label: 'Save ICH SEG and volume report to PACS', group: 'ICH Segmentation' },
  { id: 'ich.cine.export', label: 'Preview and export ICH 3D cine', group: 'ICH Segmentation' },
  { id: 'dicom.upload', label: 'Upload DICOM files', group: 'DICOM' },
  { id: 'mpr.open', label: 'Open MPR/Reformat', group: 'MPR/Reformat' },
  { id: 'mpr.bone_3d.open', label: 'Open 3D Bone', group: 'MPR/Reformat' },
  { id: 'mpr.cursor_3d.use', label: 'Use 3D Cursor', group: 'MPR/Reformat' },
  { id: 'mpr.crosshair.use', label: 'Use Crosshair', group: 'MPR/Reformat' },
  { id: 'mpr.reformat_tools.use', label: 'Use MPR plane controls', group: 'MPR/Reformat' },
  { id: 'dicom_tags.view', label: 'View DICOM tags', group: 'DICOM' },
] as const

export type PermissionId = typeof permissions[number]['id']

export const allPermissionIds = permissions.map((permission) => permission.id)

const navigationTools = new Set(['pan', 'scroll', 'cine', 'zoom', 'magnify', 'zoom-in', 'zoom-out', 'zoom-fit', 'zoom-1x'])
const presetTools = new Set(['lung', 'bone', 'brain', 'mediastinum', 'soft'])
const measurementTools = new Set(['length', 'probe', 'angle', 'cobb', 'ctr', 'bidirectional', 'circle-roi', 'rectangle', 'ellipse', 'freehand'])
const annotationTools = new Set(['text', 'arrow', 'circle-marker'])
const saveTools = new Set(['save-gsps', 'save-secondary-capture'])
const orientationTools = new Set(['rotate-cw', 'rotate-ccw', 'rotate-180', 'flip-h', 'flip-v'])

export function getMenuItemPermission(itemId: string): PermissionId {
  if (navigationTools.has(itemId)) return 'tool.navigation.use'
  if (presetTools.has(itemId)) return 'tool.preset.use'
  if (measurementTools.has(itemId)) return 'tool.measurement.use'
  if (itemId === 'ich-segment') return 'ich.segmentation.use'
  if (annotationTools.has(itemId)) return 'tool.annotation.use'
  if (saveTools.has(itemId)) return 'tool.annotation.use'
  if (orientationTools.has(itemId)) return 'tool.orientation.use'

  switch (itemId) {
    case 'window-level': return 'tool.window_level.use'
    case 'invert': return 'tool.window_level.use'
    case 'overlay': return 'tool.overlay.toggle'
    case 'mpr': return 'mpr.open'
    case 'bone-3d': return 'mpr.bone_3d.open'
    case '3d-cursor': return 'mpr.cursor_3d.use'
    case 'crosshair': return 'mpr.crosshair.use'
    case 'reference-lines': return 'tool.reference_lines.use'
    case 'cycle-planes': return 'mpr.reformat_tools.use'
    case 'reset-mpr-rotate': return 'mpr.reformat_tools.use'
    case 'tag-browser': return 'dicom_tags.view'
    default: return 'study.view'
  }
}

export function getActiveToolPermission(toolId: string): PermissionId {
  switch (toolId) {
    case 'WindowLevel': return 'tool.window_level.use'
    case 'Pan':
    case 'Scroll':
    case 'Zoom':
    case 'Magnify': return 'tool.navigation.use'
    case 'Length':
    case 'Probe':
    case 'Angle':
    case 'CobbAngle':
    case 'CTR4Point':
    case 'Bidirectional':
    case 'CircleROI':
    case 'RectangleROI':
    case 'EllipticalROI':
    case 'PlanarFreehandROI':
    case 'ICHSegment':
    case 'ICHEraser': return 'ich.segmentation.use'
    case 'TextMarker':
    case 'ArrowMarker':
    case 'CircleMarker': return 'tool.annotation.use'
    case 'Stack3DCursor': return 'mpr.cursor_3d.use'
    case 'Crosshairs': return 'mpr.crosshair.use'
    case 'CycleOrthogonalPlanes': return 'mpr.reformat_tools.use'
    case 'Rotate3D': return 'mpr.bone_3d.open'
    default: return 'study.view'
  }
}
