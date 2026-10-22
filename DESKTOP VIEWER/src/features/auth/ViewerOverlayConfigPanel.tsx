import { ArrowDown, ArrowUp, Check, RotateCcw } from 'lucide-react'
import { useMemo, useState } from 'react'
import {
  defaultOverlayProfileId,
  getOverlayFieldDefinitions,
  getViewerOverlayLayout,
  normalizeViewerOverlayConfig,
  overlayCorners,
  overlayFieldById,
  overlayModalityDefinitions,
  type ViewerOverlayConfig,
  type ViewerOverlayCorner,
} from '../viewer/overlayConfig'

type ViewerOverlayConfigPanelProps = {
  value: ViewerOverlayConfig
  onChange: (value: ViewerOverlayConfig) => void
  onSave: () => void
}

const groups = ['Patient', 'Study', 'Series', 'Acquisition', 'Image'] as const

export function ViewerOverlayConfigPanel({ value, onChange, onSave }: ViewerOverlayConfigPanelProps) {
  const [activeCorner, setActiveCorner] = useState<ViewerOverlayCorner>('topLeft')
  const [activeProfileId, setActiveProfileId] = useState('CT')
  const config = normalizeViewerOverlayConfig(value)
  const activeLayout = getViewerOverlayLayout(config, activeProfileId)
  const selectedFields = activeLayout[activeCorner]
  const selectedModality = activeProfileId === defaultOverlayProfileId
    ? null
    : overlayModalityDefinitions.find((modality) => modality.code === activeProfileId)
  const fieldsByGroup = useMemo(() => new Map(groups.map((group) => [
    group,
    getOverlayFieldDefinitions(activeProfileId).filter((field) => field.group === group),
  ])), [activeProfileId])
  const modalitiesByCategory = useMemo(() => {
    const result = new Map<string, typeof overlayModalityDefinitions>()
    for (const modality of overlayModalityDefinitions) {
      const items = result.get(modality.category) ?? []
      items.push(modality)
      result.set(modality.category, items)
    }
    return result
  }, [])

  function updateCorner(nextFields: string[]) {
    onChange({
      version: 2,
      profiles: {
        ...config.profiles,
        [activeProfileId]: {
          ...activeLayout,
          [activeCorner]: nextFields,
        },
      },
    })
  }

  function resetActiveProfile() {
    const profiles = { ...config.profiles }
    delete profiles[activeProfileId]
    onChange({ version: 2, profiles })
  }

  function toggleField(fieldId: string, checked: boolean) {
    updateCorner(checked
      ? [...selectedFields, fieldId]
      : selectedFields.filter((id) => id !== fieldId))
  }

  function moveField(fieldId: string, direction: -1 | 1) {
    const currentIndex = selectedFields.indexOf(fieldId)
    const nextIndex = currentIndex + direction
    if (currentIndex < 0 || nextIndex < 0 || nextIndex >= selectedFields.length) return
    const nextFields = [...selectedFields]
    ;[nextFields[currentIndex], nextFields[nextIndex]] = [nextFields[nextIndex], nextFields[currentIndex]]
    updateCorner(nextFields)
  }

  return (
    <section className="service-panel service-overlay-panel">
      <header>
        <div className="service-overlay-heading">
          <h2>Text Overlay</h2>
          <label className="service-overlay-profile-select">
            <span>Modality</span>
            <select value={activeProfileId} onChange={(event) => setActiveProfileId(event.currentTarget.value)}>
              <option value={defaultOverlayProfileId}>Default fallback</option>
              {[...modalitiesByCategory.entries()].map(([category, modalities]) => (
                <optgroup key={category} label={category}>
                  {modalities.map((modality) => <option key={modality.code} value={modality.code}>{modality.code} - {modality.label}</option>)}
                </optgroup>
              ))}
            </select>
          </label>
          <small>{selectedModality ? `${selectedModality.code} profile` : 'Fallback for unknown modalities'}</small>
        </div>
        <div className="service-overlay-actions">
          <button type="button" title="Restore selected modality defaults" onClick={resetActiveProfile}><RotateCcw size={15} />Reset</button>
          <button className="service-primary-button" type="button" onClick={onSave}><Check size={16} />Save</button>
        </div>
      </header>

      <div className="service-overlay-layout">
        <div className="service-overlay-editor">
          <div className="service-overlay-corners" role="tablist" aria-label="Overlay position">
            {overlayCorners.map((corner) => (
              <button
                className={activeCorner === corner.id ? 'active' : ''}
                type="button"
                role="tab"
                aria-selected={activeCorner === corner.id}
                key={corner.id}
                onClick={() => setActiveCorner(corner.id)}
              >
                {corner.label}
              </button>
            ))}
          </div>

          <div className="service-overlay-field-groups">
            {groups.map((group) => (
              <section className="service-overlay-field-group" key={group}>
                <h3>{group}</h3>
                <div>
                  {fieldsByGroup.get(group)?.map((field) => {
                    const fieldIndex = selectedFields.indexOf(field.id)
                    const checked = fieldIndex >= 0
                    return (
                      <label className={checked ? 'selected' : ''} key={field.id}>
                        <input checked={checked} type="checkbox" onChange={(event) => toggleField(field.id, event.currentTarget.checked)} />
                        <span>{field.label}</span>
                        {checked && (
                          <span className="service-overlay-field-order">
                            <button type="button" title="Move up" aria-label={`Move ${field.label} up`} disabled={fieldIndex === 0} onClick={(event) => { event.preventDefault(); moveField(field.id, -1) }}><ArrowUp size={13} /></button>
                            <button type="button" title="Move down" aria-label={`Move ${field.label} down`} disabled={fieldIndex === selectedFields.length - 1} onClick={(event) => { event.preventDefault(); moveField(field.id, 1) }}><ArrowDown size={13} /></button>
                          </span>
                        )}
                      </label>
                    )
                  })}
                </div>
              </section>
            ))}
          </div>
        </div>

        <aside className="service-overlay-preview" aria-label="Overlay preview">
          <div className="service-overlay-preview-viewport">
            <span className="service-overlay-preview-marker top">A</span>
            <span className="service-overlay-preview-marker right">L</span>
            <span className="service-overlay-preview-marker bottom">P</span>
            <span className="service-overlay-preview-marker left">R</span>
            {overlayCorners.map((corner) => (
              <div className={`service-overlay-preview-corner ${corner.id}`} key={corner.id}>
                {activeLayout[corner.id].map((fieldId) => <span key={fieldId}>{overlayFieldById.get(fieldId)?.preview}</span>)}
              </div>
            ))}
            <span className="service-overlay-preview-ruler"><em>10 cm</em></span>
          </div>
        </aside>
      </div>
    </section>
  )
}
