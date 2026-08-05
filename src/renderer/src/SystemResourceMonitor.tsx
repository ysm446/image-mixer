import { useEffect, useState } from 'react'
import type { SystemResources } from '../../main/types'

function formatBytes(bytes: number): string {
  const gibibytes = bytes / (1024 ** 3)
  return gibibytes >= 1 ? `${gibibytes.toFixed(1)} GB` : `${(bytes / (1024 ** 2)).toFixed(0)} MB`
}

function formatMegabytes(megabytes: number): string {
  return megabytes >= 1024 ? `${(megabytes / 1024).toFixed(1)} GB` : `${megabytes.toFixed(0)} MB`
}

function ResourceBar({ label, percentage, detail }: { label: string; percentage: number; detail: string }): React.JSX.Element {
  const value = Math.min(100, Math.max(0, percentage))
  const level = value > 85 ? 'critical' : value > 65 ? 'warning' : 'normal'
  return (
    <div className='resource-item' title={`${label}: ${detail}`}>
      <span className='resource-label'>{label}</span>
      <div className='resource-track' role='progressbar' aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(value)}>
        <div className={`resource-fill ${level}`} style={{ width: `${value}%` }} />
      </div>
      <span className='resource-detail'>{detail}</span>
    </div>
  )
}

export function SystemResourceMonitor(): React.JSX.Element {
  const [resources, setResources] = useState<SystemResources | null>(null)

  useEffect(() => window.imageMixer.onSystemResources(setResources), [])

  if (!resources) return <div className='resource-loading'>リソース取得中…</div>
  return (
    <div className='resource-monitor' aria-label='システムリソース'>
      <ResourceBar label='CPU' percentage={resources.cpuUsage} detail={`${resources.cpuUsage}%`} />
      <ResourceBar label='RAM' percentage={(resources.ramUsed / resources.ramTotal) * 100} detail={`${formatBytes(resources.ramUsed)} / ${formatBytes(resources.ramTotal)}`} />
      {resources.gpuUsage != null && <ResourceBar label='GPU' percentage={resources.gpuUsage} detail={`${resources.gpuUsage}%`} />}
      {resources.vramUsed != null && resources.vramTotal != null && (
        <ResourceBar label='VRAM' percentage={(resources.vramUsed / resources.vramTotal) * 100} detail={`${formatMegabytes(resources.vramUsed)} / ${formatMegabytes(resources.vramTotal)}`} />
      )}
    </div>
  )
}
