import { type PointerEvent, useState } from 'react'
import type { WaveformSummary } from '../../dicomweb/types'

type EcgWaveformViewportProps = {
  waveform: WaveformSummary
  isSelected: boolean
  onSelect: () => void
}

export function EcgWaveformViewport({ waveform, isSelected, onSelect }: EcgWaveformViewportProps) {
  const [cursor, setCursor] = useState<{ channelIndex: number; sampleIndex: number } | null>(null)
  const durationSeconds = waveform.sampleCount / waveform.samplingFrequency
  const activeChannel = waveform.channels[cursor?.channelIndex ?? 0]
  const cursorSampleIndex = Math.min(Math.max(cursor?.sampleIndex ?? 0, 0), Math.max(0, waveform.sampleCount - 1))
  const cursorValue = activeChannel?.samples[cursorSampleIndex] ?? 0

  return (
    <button className={isSelected ? 'ecg-viewport selected' : 'ecg-viewport'} type="button" onClick={onSelect}>
      <div className="ecg-header">
        <strong>ECG Waveform</strong>
        <span>{waveform.channels.length} leads · {formatDuration(durationSeconds)} · {formatNumber(waveform.samplingFrequency)} Hz</span>
      </div>
      {activeChannel && (
        <div className="ecg-quant-panel">
          <div>
            <strong>{activeChannel.label}</strong>
            <span>Minimum: {formatNumber(activeChannel.minimum)} mV</span>
            <span>Maximum: {formatNumber(activeChannel.maximum)} mV</span>
          </div>
          <div>
            <strong>Cursor</strong>
            <span>{formatNumber(cursorSampleIndex / waveform.samplingFrequency)} s</span>
            <span>{formatNumber(cursorValue)} mV</span>
          </div>
        </div>
      )}
      <div className="ecg-grid">
        {waveform.channels.map((channel, channelIndex) => (
          <div
            className={cursor?.channelIndex === channelIndex ? 'ecg-strip active' : 'ecg-strip'}
            key={channel.label}
            onPointerMove={(event) => setCursor(readCursor(event, channelIndex, waveform.sampleCount))}
            onPointerDown={(event) => setCursor(readCursor(event, channelIndex, waveform.sampleCount))}
          >
            <span className="ecg-lead-label">{channel.label}</span>
            {cursor?.channelIndex === channelIndex && <span className="ecg-cursor-line" style={{ left: `${(cursorSampleIndex / Math.max(1, waveform.sampleCount - 1)) * 100}%` }} />}
            <svg aria-label={`${channel.label} waveform`} preserveAspectRatio="none" viewBox="0 0 1000 100">
              <polyline points={toPolyline(channel.samples)} vectorEffect="non-scaling-stroke" />
            </svg>
          </div>
        ))}
      </div>
      {waveform.annotations.length > 0 && (
        <div className="ecg-annotations">
          <strong>Annotations</strong>
          <div className="ecg-annotation-table">
            {waveform.annotations.map((annotation) => (
              <div className="ecg-annotation-row" key={annotation.tag}>
                <span>{annotation.tag}</span>
                <span>{annotation.value}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </button>
  )
}

function readCursor(event: PointerEvent<HTMLDivElement>, channelIndex: number, sampleCount: number) {
  const bounds = event.currentTarget.getBoundingClientRect()
  const x = Math.min(Math.max(event.clientX - bounds.left, 0), bounds.width)
  const sampleIndex = Math.round((x / Math.max(1, bounds.width)) * Math.max(0, sampleCount - 1))

  return { channelIndex, sampleIndex }
}

function toPolyline(samples: number[]) {
  if (!samples.length) {
    return ''
  }

  const maxPoints = 1000
  const step = Math.max(1, Math.ceil(samples.length / maxPoints))
  const sampled = samples.filter((_, index) => index % step === 0)
  const min = Math.min(...sampled)
  const max = Math.max(...sampled)
  const range = max - min || 1
  const lastIndex = Math.max(1, sampled.length - 1)

  return sampled.map((sample, index) => {
    const x = (index / lastIndex) * 1000
    const y = 90 - ((sample - min) / range) * 80

    return `${x.toFixed(2)},${y.toFixed(2)}`
  }).join(' ')
}

function formatDuration(seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return '-'
  }

  return `${seconds.toFixed(1)}s`
}

function formatNumber(value: number) {
  if (!Number.isFinite(value)) {
    return '-'
  }

  return Number(value.toFixed(3)).toString()
}
