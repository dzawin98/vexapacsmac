import { useEffect, useRef, useState, type PointerEvent } from 'react'
import { Check, Edit3, Plus, Trash2, X } from 'lucide-react'
import { appUrl } from '../../config/appBase'

type Printer = { id: string; name: string; aet: string; host: string; port: number; enabled: boolean }
type ElementKey = 'logo' | 'facilityName' | 'patientName' | 'patientId' | 'birthDate' | 'sex' | 'studyDate' | 'accessionNumber'
type FilmElement = { enabled: boolean; x: number; y: number; align: 'left' | 'center' | 'right' }
type Orientation = 'portrait' | 'landscape'
type FilmIdentity = { facilityName: string; logoDataUrl: string; templates: Record<string, Record<ElementKey, FilmElement>>; footerHeights: Record<string, number>; logoSizes: Record<string, number>; elements?: Record<ElementKey, FilmElement> }
type Settings = { callingAet: string; printers: Printer[]; filmProfiles: Array<{ id: string; label: string; filmSizeId: string }>; identity: FilmIdentity }

const labels: Record<ElementKey, string> = { logo: 'Logo', facilityName: 'Facility Name', patientName: 'Patient Name', patientId: 'Medical Record No.', birthDate: 'Birth Date / Age', sex: 'Sex', studyDate: 'Study Date', accessionNumber: 'Accession No.' }
const sample: Record<ElementKey, string> = { logo: '', facilityName: 'VEXA GENERAL HOSPITAL', patientName: 'DOE^JOHN', patientId: 'MRN 00123456', birthDate: '01 Jan 1970 · 56Y', sex: 'Male', studyDate: '16 Aug 2026', accessionNumber: 'ACC 20260816001' }
const element = (x: number, y: number, align: FilmElement['align'] = 'left'): FilmElement => ({ enabled: true, x, y, align })
const footerElements = (): Record<ElementKey, FilmElement> => ({ logo: element(3, 92), facilityName: element(12, 89), patientName: element(12, 93), patientId: element(12, 97), birthDate: element(52, 93, 'center'), sex: element(52, 97, 'center'), studyDate: element(97, 93, 'right'), accessionNumber: element(97, 97, 'right') })
const templateKey = (filmSizeId: string, orientation: Orientation) => `${filmSizeId}:${orientation}`
const alignmentX = (align: FilmElement['align']) => align === 'left' ? 3 : align === 'center' ? 50 : 97
const footerOrder: ElementKey[] = ['logo', 'facilityName', 'patientName', 'patientId', 'birthDate', 'sex', 'studyDate', 'accessionNumber']
function reflowFooter(elements: Record<ElementKey, FilmElement>) {
  const next = { ...elements }
  for (const align of ['left', 'center', 'right'] as FilmElement['align'][]) {
    const fields = footerOrder.filter((key) => next[key].enabled && next[key].align === align)
    const total = fields.reduce((sum, key) => sum + (key === 'logo' ? 2.5 : 1), 0)
    let cursor = 0
    for (const key of fields) {
      const weight = key === 'logo' ? 2.5 : 1
      next[key] = { ...next[key], x: alignmentX(align), y: 81 + ((cursor + weight / 2) / Math.max(1, total)) * 17 }
      cursor += weight
    }
  }
  return next
}
const defaults = (): FilmIdentity => ({ facilityName: 'VEXA GENERAL HOSPITAL', logoDataUrl: '', templates: {}, footerHeights: {}, logoSizes: {} })

export function DicomPrinterConfigPanel({ onMessage }: { onMessage: (message: string) => void }) {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [draft, setDraft] = useState<Printer | null>(null)
  const [selectedFilmSize, setSelectedFilmSize] = useState('')
  const [selectedOrientation, setSelectedOrientation] = useState<Orientation>('portrait')
  const previewRef = useRef<HTMLDivElement>(null)
  async function load() { const r = await fetch(appUrl('/api/viewer/dicom-print/config'), { credentials: 'same-origin' }); const p = await r.json(); if (!r.ok) throw new Error(p.error); const filmSize = p.filmProfiles?.[0]?.filmSizeId || '14INX17IN'; setSelectedFilmSize(filmSize); setSettings({ ...p, identity: normalizeIdentity(p.identity, p.filmProfiles || []) }) }
  async function persist(next: Settings, message = 'DICOM printer settings saved successfully.') { const r = await fetch(appUrl('/api/viewer/dicom-print/config'), { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(next) }); const p = await r.json(); if (!r.ok) throw new Error(p.error); setSettings({ ...p, identity: normalizeIdentity(p.identity, p.filmProfiles || []) }); onMessage(message) }
  async function save() { if (settings) await persist(settings) }
  useEffect(() => { void load() }, [])
  if (!settings) return <section className="service-panel"><div className="service-message">Loading printer settings...</div></section>
  const savePrinter = () => { if (!draft?.name.trim() || !draft.aet.trim() || !draft.host.trim() || !draft.port) return onMessage('Printer name, AE Title, IP address, and port are required.'); const exists = settings.printers.some((p) => p.id === draft.id); const next = { ...settings, printers: exists ? settings.printers.map((p) => p.id === draft.id ? draft : p) : [...settings.printers, draft] }; setDraft(null); void persist(next, 'DICOM printer saved and available in the viewer.').catch((e) => onMessage(e instanceof Error ? e.message : 'Unable to save printer.')) }
  const activeKey = templateKey(selectedFilmSize, selectedOrientation)
  const activeElements = settings.identity.templates[activeKey] || footerElements()
  const footerHeight = settings.identity.footerHeights[activeKey] || 18
  const logoSize = settings.identity.logoSizes[activeKey] || 38
  const updateElement = (key: ElementKey, patch: Partial<FilmElement>) => setSettings((s) => s && ({ ...s, identity: { ...s.identity, templates: { ...s.identity.templates, [activeKey]: { ...(s.identity.templates[activeKey] || footerElements()), [key]: { ...(s.identity.templates[activeKey]?.[key] || footerElements()[key]), ...patch } } } } }))
  const placeElement = (key: ElementKey, align: FilmElement['align']) => setSettings((s) => { if (!s) return s; const current = s.identity.templates[activeKey] || footerElements(); const elements = reflowFooter({ ...current, [key]: { ...current[key], align, x: alignmentX(align) } }); return { ...s, identity: { ...s.identity, templates: { ...s.identity.templates, [activeKey]: elements } } } })
  const applyToAll = () => setSettings((s) => { if (!s) return s; const templates = { ...s.identity.templates }; const footerHeights = { ...s.identity.footerHeights }; const logoSizes = { ...s.identity.logoSizes }; for (const profile of s.filmProfiles) for (const orientation of ['portrait', 'landscape'] as Orientation[]) { const key = templateKey(profile.filmSizeId, orientation); templates[key] = structuredClone(activeElements); footerHeights[key] = footerHeight; logoSizes[key] = logoSize } return { ...s, identity: { ...s.identity, templates, footerHeights, logoSizes } } })
  const drag = (key: ElementKey, event: PointerEvent<HTMLDivElement>) => { const bounds = previewRef.current?.getBoundingClientRect(); if (!bounds) return; const move = (x: number, y: number) => updateElement(key, { x: Math.max(2, Math.min(98, (x - bounds.left) / bounds.width * 100)), y: Math.max(81, Math.min(98, (y - bounds.top) / bounds.height * 100)) }); move(event.clientX, event.clientY); const onMove = (e: globalThis.PointerEvent) => move(e.clientX, e.clientY); const onUp = () => { window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp) }; window.addEventListener('pointermove', onMove); window.addEventListener('pointerup', onUp) }
  return <section className="service-panel">
    <header><div><h2>DICOM Printers</h2><p>Direct printer destinations and the global film identity template.</p></div><button className="service-primary-button" type="button" onClick={() => setDraft({ id: `printer-${Date.now()}`, name: '', aet: '', host: '', port: 104, enabled: true })}><Plus size={16}/>Add Printer</button></header>
    <div className="service-config-form"><label><span>Calling AE Title</span><input maxLength={16} value={settings.callingAet} onChange={(e) => setSettings({ ...settings, callingAet: e.currentTarget.value.toUpperCase() })}/></label></div>
    <div className="service-table-wrap"><table className="service-table"><thead><tr><th>Printer</th><th>AE Title</th><th>IP Address</th><th>Port</th><th>Status</th><th/></tr></thead><tbody>{settings.printers.length ? settings.printers.map((p) => <tr key={p.id}><td><strong>{p.name}</strong></td><td>{p.aet}</td><td>{p.host}</td><td>{p.port}</td><td><span className={p.enabled ? 'service-status active' : 'service-status'}>{p.enabled ? 'Active' : 'Disabled'}</span></td><td className="service-row-actions"><button type="button" onClick={() => setDraft({ ...p })}><Edit3 size={14}/> Edit</button><button type="button" title="Delete printer" onClick={() => setSettings({ ...settings, printers: settings.printers.filter((x) => x.id !== p.id) })}><Trash2 size={15}/></button></td></tr>) : <tr><td colSpan={6}>No DICOM printers configured.</td></tr>}</tbody></table></div>
    <header><div><h2>Film Identity</h2><p>Configure a dedicated footer for each film size and orientation.</p></div></header>
    <div className="service-config-form"><label><span>Facility name</span><input value={settings.identity.facilityName} onChange={(e) => setSettings({ ...settings, identity: { ...settings.identity, facilityName: e.currentTarget.value } })}/></label><label><span>Facility logo</span><input type="file" accept="image/png,image/jpeg,image/svg+xml" onChange={(e) => { const file = e.currentTarget.files?.[0]; if (!file) return; const reader = new FileReader(); reader.onload = () => setSettings({ ...settings, identity: { ...settings.identity, logoDataUrl: String(reader.result || '') } }); reader.readAsDataURL(file) }}/></label></div>
    <div className="service-config-form"><label><span>Film size</span><select value={selectedFilmSize} onChange={(e) => setSelectedFilmSize(e.currentTarget.value)}>{settings.filmProfiles.map((profile) => <option key={profile.id} value={profile.filmSizeId}>{profile.label}</option>)}</select></label><label><span>Orientation</span><select value={selectedOrientation} onChange={(e) => setSelectedOrientation(e.currentTarget.value as Orientation)}><option value="portrait">Portrait</option><option value="landscape">Landscape</option></select></label></div>
    <div className="service-config-note" style={{ margin: '0 14px 16px', display: 'grid', gap: 16 }}><div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,minmax(220px,1fr)) auto', gap: 16, alignItems: 'end' }}><label><span>Footer height · {footerHeight}%</span><input type="range" min={10} max={26} value={footerHeight} onChange={(e) => setSettings({ ...settings, identity: { ...settings.identity, footerHeights: { ...settings.identity.footerHeights, [activeKey]: Number(e.currentTarget.value) } } })}/></label><label><span>Logo size · {logoSize}px</span><input type="range" min={24} max={96} value={logoSize} onChange={(e) => setSettings({ ...settings, identity: { ...settings.identity, logoSizes: { ...settings.identity.logoSizes, [activeKey]: Number(e.currentTarget.value) } } })}/></label><button type="button" onClick={applyToAll}>Apply to All Film Sizes</button></div></div>
    <div style={{ padding: '0 14px' }}><div ref={previewRef} style={{ position: 'relative', aspectRatio: filmAspectRatio(selectedFilmSize, selectedOrientation), margin: '0 auto', background: '#050708', border: '1px solid #36404a', borderRadius: 4, overflow: 'hidden', width: selectedOrientation === 'portrait' ? 'min(100%, 420px)' : 'min(100%, 720px)' }}><div style={{ position: 'absolute', inset: `5% 5% ${footerHeight + 1}%`, border: '1px solid #29323a', background: 'radial-gradient(circle,#26323a 0,#080b0d 66%)' }}/><div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: `${footerHeight}%`, background: '#10161a', borderTop: '1px solid #52616b' }}/>{(Object.keys(labels) as ElementKey[]).map((key) => { const item = activeElements[key]; if (!item.enabled) return null; return <div key={key} onPointerDown={(e) => drag(key, e)} title={`Drag ${labels[key]} within the footer`} style={{ position: 'absolute', left: `${item.x}%`, top: `${item.y}%`, transform: `translate(${item.align === 'left' ? '0' : item.align === 'center' ? '-50%' : '-100%'},-50%)`, color: '#e7f0f3', fontSize: key === 'facilityName' ? 12 : 10, fontWeight: key === 'facilityName' ? 700 : 500, whiteSpace: 'nowrap', cursor: 'move', userSelect: 'none', padding: 4 }}>{key === 'logo' ? (settings.identity.logoDataUrl ? <img src={settings.identity.logoDataUrl} alt="Facility logo" style={{ width: logoSize, height: logoSize, objectFit: 'contain' }}/> : 'LOGO') : key === 'facilityName' ? settings.identity.facilityName : sample[key]}</div> })}</div></div>
    <div className="service-config-note" style={{ margin: 14 }}><strong>Footer Fields</strong><p>Choose a column for each field. Rows are arranged automatically.</p><div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(240px,1fr))', gap: 10 }}>{(Object.keys(labels) as ElementKey[]).map((key) => <div key={key} style={{ display: 'grid', gridTemplateColumns: '1fr 110px', gap: 8, alignItems: 'center' }}><label><input type="checkbox" checked={activeElements[key].enabled} onChange={(e) => updateElement(key, { enabled: e.currentTarget.checked })}/> {labels[key]}</label><select value={activeElements[key].align} onChange={(e) => placeElement(key, e.currentTarget.value as FilmElement['align'])}><option value="left">Left</option><option value="center">Center</option><option value="right">Right</option></select></div>)}</div></div>
    <footer style={{ display: 'flex', justifyContent: 'flex-end', padding: 14, borderTop: '1px solid #303030' }}><button className="service-primary-button" type="button" onClick={() => void save().catch((e) => onMessage(e instanceof Error ? e.message : 'Unable to save settings.'))}><Check size={16}/>Save Changes</button></footer>
    {draft && <div className="export-center-backdrop"><section className="export-center-dialog" role="dialog" aria-modal="true"><header className="export-center-header"><strong>{settings.printers.some((p) => p.id === draft.id) ? 'Edit DICOM Printer' : 'Add DICOM Printer'}</strong><button type="button" onClick={() => setDraft(null)}><X size={16}/></button></header><div className="export-center-body"><div className="service-config-form"><label><span>Printer name</span><input autoFocus value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.currentTarget.value })}/></label><label><span>AE Title</span><input maxLength={16} value={draft.aet} onChange={(e) => setDraft({ ...draft, aet: e.currentTarget.value.toUpperCase() })}/></label><label><span>IP address / host</span><input value={draft.host} onChange={(e) => setDraft({ ...draft, host: e.currentTarget.value })}/></label><label><span>Port</span><input type="number" min={1} max={65535} value={draft.port} onChange={(e) => setDraft({ ...draft, port: Number(e.currentTarget.value) })}/></label><label><span><input type="checkbox" checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.currentTarget.checked })}/> Enabled</span></label></div></div><footer className="export-center-footer"><button type="button" onClick={() => setDraft(null)}>Cancel</button><button className="primary" type="button" onClick={savePrinter}><Check size={15}/>Save Printer</button></footer></section></div>}
  </section>
}

function normalizeIdentity(value: Partial<FilmIdentity> | undefined, profiles: Settings['filmProfiles']): FilmIdentity {
  const d = defaults()
  const templates: FilmIdentity['templates'] = {}
  for (const profile of profiles) for (const orientation of ['portrait', 'landscape'] as Orientation[]) {
    const key = templateKey(profile.filmSizeId, orientation)
    const source = value?.templates?.[key] || value?.elements
    templates[key] = Object.fromEntries((Object.keys(labels) as ElementKey[]).map((field) => [field, { ...footerElements()[field], ...(source?.[field] || {}), y: Math.max(81, Math.min(98, Number(source?.[field]?.y ?? footerElements()[field].y))) }])) as Record<ElementKey, FilmElement>
  }
  return { facilityName: String(value?.facilityName || d.facilityName), logoDataUrl: String(value?.logoDataUrl || ''), templates, footerHeights: { ...(value?.footerHeights || {}) }, logoSizes: { ...(value?.logoSizes || {}) } }
}

function filmAspectRatio(filmSizeId: string, orientation: Orientation) {
  const match = filmSizeId.match(/(\d+)INX(\d+)IN/i)
  const short = Number(match?.[1] || 14)
  const long = Number(match?.[2] || 17)
  return orientation === 'portrait' ? `${short}/${long}` : `${long}/${short}`
}
