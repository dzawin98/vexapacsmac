import type { StructuredReportItem, StructuredReportSummary } from '../../dicomweb/types'

type StructuredReportViewportProps = {
  report: StructuredReportSummary
  isSelected: boolean
  onSelect: () => void
}

export function StructuredReportViewport({ report, isSelected, onSelect }: StructuredReportViewportProps) {
  return (
    <button className={isSelected ? 'sr-viewport selected' : 'sr-viewport'} type="button" onClick={onSelect}>
      <div className="sr-panel">
        <div className="sr-header">
          <span>SR Report</span>
          <strong>{report.title}</strong>
        </div>
        <div className="sr-content">
          {report.items.length ? report.items.map((item, index) => <StructuredReportNode item={item} key={`${item.name}-${index}`} />) : <p>No readable SR content.</p>}
        </div>
      </div>
    </button>
  )
}

function StructuredReportNode({ item }: { item: StructuredReportItem }) {
  return (
    <div className="sr-item">
      <div className="sr-row">
        <span>{item.name}</span>
        {item.value && <strong>{item.value}</strong>}
      </div>
      {item.children.length > 0 && (
        <div className="sr-children">
          {item.children.map((child, index) => <StructuredReportNode item={child} key={`${child.name}-${index}`} />)}
        </div>
      )}
    </div>
  )
}
