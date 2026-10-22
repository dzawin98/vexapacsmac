import { annotation } from '@cornerstonejs/tools'

export function deleteSelectedAnnotations(confirmDelete = false) {
  const selected = annotation.selection.getAnnotationsSelected()

  if (!selected.length) {
    return 0
  }

  if (confirmDelete && !window.confirm('Do You want to delete this annot?')) {
    return 0
  }

  selected.forEach((annotationUID) => annotation.state.removeAnnotation(annotationUID))
  annotation.selection.deselectAnnotation()

  return selected.length
}

export function clearAllAnnotations() {
  annotation.state.removeAllAnnotations()
  annotation.selection.deselectAnnotation()
}
