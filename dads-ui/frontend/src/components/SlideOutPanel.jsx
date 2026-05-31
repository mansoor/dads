import { useState, useEffect, useRef } from 'react'
import { useQuery } from '@tanstack/react-query'
import { fetchAllActivity, fetchBackups, fetchWorkspaces } from '../lib/api'

// ── Shared helpers ─────────────────────────────────────────────────────────────

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B'
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function timeAgo(ts) {
  if (!ts) return ''
  let ms = NaN
  for (const attempt of [ts.replace(' ', 'T') + (ts.includes('Z') ? '' : 'Z'), ts, ts + 'Z']) {
    const t = new Date(attempt).getTime()
    if (!isNaN(t)) { ms = t; break }
  }
  if (isNaN(ms)) return ts.slice(0, 16)
  const diff = Math.floor((Date.now() - ms) / 1000)
  if (diff < 60)    return `${diff}s ago`
  if (diff < 3600)  return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  return `${Math.floor(diff / 86400)}d ago`
}

function formatDate(dateStr) {
  const [date, time] = (dateStr || '').split('_')
  if (!date) return dateStr
  return `${date} ${(time || '').replace(/-/g, ':')}`
}

const CMD_COLOR = {
  start:   'bg-green-500/20 text-green-400',
  deploy:  'bg-green-500/20 text-green-400',
  stop:    'bg-red-500/20   text-red-400',
  down:    'bg-red-500/20   text-red-400',
  restart: 'bg-amber-400/20 text-amber-300',
  update:  'bg-amber-400/20 text-amber-300',
  backup:  'bg-gray-500/20  text-gray-400',
  build:   'bg-brand-500/20 text-brand-400',
  promote: 'bg-purple-500/20 text-purple-400',
  delete:  'bg-red-700/20   text-red-500',
}

// ── Filter bar — workspace search + type selector ─────────────────────────────

function FilterBar({ workspaceFilter, setWorkspaceFilter, typeFilter, setTypeFilter }) {
  return (
    <div className="flex items-center gap-2 px-5 py-3 border-b border-gray-800 bg-gray-900/60 shrink-0">
      <input
        type="text"
        placeholder="Filter by workspace…"
        value={workspaceFilter}
        onChange={e => setWorkspaceFilter(e.target.value)}
        className="flex-1 px-3 py-1.5 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white placeholder-gray-500 focus:outline-none focus:border-brand-500"
      />
      <select
        value={typeFilter}
        onChange={e => setTypeFilter(e.target.value)}
        className="px-3 py-1.5 bg-gray-800 border border-gray-700 rounded-lg text-sm text-gray-300 focus:outline-none focus:border-brand-500"
      >
        <option value="all">All types</option>
        <option value="image">Image stacks</option>
        <option value="custom">Custom apps</option>
      </select>
      {(workspaceFilter || typeFilter !== 'all') && (
        <button
          onClick={() => { setWorkspaceFilter(''); setTypeFilter('all') }}
          className="text-xs text-gray-500 hover:text-gray-300 transition-colors px-2"
        >
          Clear
        </button>
      )}
    </div>
  )
}

// ── Activity content ──────────────────────────────────────────────────────────

function ActivityContent({ workspaceFilter, typeFilter, wsTypes }) {
  const { data, isLoading } = useQuery({
    queryKey: ['allActivity'],
    queryFn: fetchAllActivity,
    refetchInterval: 15_000,
  })

  const items = (data || []).filter(item => {
    if (workspaceFilter && !item.workspace?.toLowerCase().includes(workspaceFilter.toLowerCase())) return false
    if (typeFilter !== 'all') {
      const wsType = wsTypes[item.workspace]
      if (wsType && wsType !== typeFilter) return false
    }
    return true
  })

  if (isLoading) return <p className="text-sm text-gray-500 p-5">Loading…</p>
  if (items.length === 0) return <p className="text-sm text-gray-500 p-5">No activity matches the current filter.</p>

  return (
    <div className="divide-y divide-gray-800">
      {items.map((item, i) => {
        const cls = CMD_COLOR[item.command] || 'bg-gray-700/20 text-gray-400'
        return (
          <div key={i} className="flex items-center gap-4 px-5 py-3 hover:bg-gray-800/40 transition-colors">
            <span className={`text-xs font-medium px-2 py-0.5 rounded-full shrink-0 ${cls}`}>
              {item.command}
            </span>
            <div className="flex-1 min-w-0">
              <p className="text-sm text-white font-medium truncate">{item.workspace}</p>
              <p className="text-xs text-gray-500">
                {item.env && <span className="mr-2">env: <span className="text-gray-400">{item.env}</span></span>}
                by <span className="text-gray-400">{item.username}</span>
              </p>
            </div>
            <span className="text-xs text-gray-600 shrink-0" title={item.created_at}>{timeAgo(item.created_at)}</span>
          </div>
        )
      })}
    </div>
  )
}

// ── Backup content ────────────────────────────────────────────────────────────

function BackupContent({ workspaceFilter, typeFilter, wsTypes }) {
  const { data, isLoading } = useQuery({ queryKey: ['backups'], queryFn: fetchBackups, refetchInterval: 60_000 })
  const [expanded, setExpanded] = useState(null)

  const items = (data || []).filter(b => {
    if (workspaceFilter && !b.workspace?.toLowerCase().includes(workspaceFilter.toLowerCase())) return false
    if (typeFilter !== 'all') {
      const wsType = wsTypes[b.workspace]
      if (wsType && wsType !== typeFilter) return false
    }
    return true
  })

  if (isLoading) return <p className="text-sm text-gray-500 p-5">Loading…</p>
  if (items.length === 0) return <p className="text-sm text-gray-500 p-5">No backups match the current filter.</p>

  return (
    <div className="divide-y divide-gray-800">
      {items.map((snap, i) => {
        const key = `${snap.workspace}-${snap.env}-${snap.date}`
        const isOpen = expanded === key
        return (
          <div key={i}>
            <button
              className="w-full flex items-center gap-4 px-5 py-3 hover:bg-gray-800/40 transition-colors text-left"
              onClick={() => setExpanded(isOpen ? null : key)}
            >
              <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-gray-700/40 text-gray-300 shrink-0">
                {snap.env}
              </span>
              <div className="flex-1 min-w-0">
                <p className="text-sm text-white font-medium truncate">{snap.workspace}</p>
                <p className="text-xs text-gray-500 font-mono">{formatDate(snap.date)}</p>
              </div>
              <div className="flex items-center gap-3 shrink-0">
                <span className="text-xs text-gray-500">{formatBytes(snap.size_bytes)}</span>
                <span className="text-xs text-gray-600">{isOpen ? '▲' : '▼'}</span>
              </div>
            </button>
            {isOpen && (
              <div className="px-5 pb-3 bg-gray-900/40">
                {(snap.files || []).map((f, fi) => (
                  <div key={fi} className="flex justify-between py-1 border-b border-gray-800/40 last:border-0">
                    <span className="font-mono text-xs text-gray-400">{f.name}</span>
                    <span className="text-xs text-gray-600">{formatBytes(f.size)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ── Version log content ───────────────────────────────────────────────────────

function VersionContent({ workspaceFilter, typeFilter, wsTypes }) {
  const { data, isLoading } = useQuery({ queryKey: ['allActivity'], queryFn: fetchAllActivity, refetchInterval: 15_000 })
  const { data: stats } = useQuery({ queryKey: ['stats'], queryFn: () => import('../lib/api').then(m => m.fetchStats()) })

  const wsList = stats?.workspaces?.workspaces || []

  const filtered = wsList.filter(ws => {
    if (workspaceFilter && !ws.name?.toLowerCase().includes(workspaceFilter.toLowerCase())) return false
    if (typeFilter !== 'all' && ws.type !== typeFilter) return false
    return true
  })

  const activityByWs = {}
  ;(data || []).forEach(a => {
    if (!activityByWs[a.workspace]) activityByWs[a.workspace] = []
    if (['build', 'promote', 'version'].includes(a.command)) {
      activityByWs[a.workspace].push(a)
    }
  })

  if (isLoading) return <p className="text-sm text-gray-500 p-5">Loading…</p>
  if (filtered.length === 0) return <p className="text-sm text-gray-500 p-5">No workspaces match the current filter.</p>

  return (
    <div className="divide-y divide-gray-800">
      {filtered.map(ws => {
        const events = activityByWs[ws.name] || []
        const isImage = ws.type === 'image'
        return (
          <div key={ws.name} className="px-5 py-3">
            <div className="flex items-center justify-between mb-1">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-white">{ws.name}</span>
                <span className={`text-xs px-1.5 py-0.5 rounded ${isImage ? 'bg-blue-950 text-blue-300' : 'bg-purple-950 text-purple-300'}`}>
                  {ws.type}
                </span>
              </div>
              {isImage
                ? <span className="text-xs text-gray-600">image stack — no semver</span>
                : <span className="text-xs text-gray-400 font-mono">
                    {/* version would come from config — use stats */}
                  </span>
              }
            </div>
            {!isImage && events.length > 0 ? (
              <div className="mt-1.5 space-y-1">
                {events.slice(0, 5).map((e, i) => (
                  <div key={i} className="flex items-center gap-3 text-xs">
                    <span className={`px-1.5 py-0.5 rounded ${CMD_COLOR[e.command] || 'bg-gray-700/20 text-gray-500'}`}>{e.command}</span>
                    {e.env && <span className="text-gray-500">{e.env}</span>}
                    <span className="text-gray-600 ml-auto">{timeAgo(e.created_at)}</span>
                  </div>
                ))}
              </div>
            ) : !isImage ? (
              <p className="text-xs text-gray-600 mt-1">No build/promote events recorded yet.</p>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}

// ── Main SlideOutPanel ────────────────────────────────────────────────────────

const PANEL_CONFIG = {
  activity: { title: 'Recent Activity',  icon: '◎' },
  backup:   { title: 'Backup History',   icon: '○' },
  version:  { title: 'Version Log',      icon: '○' },
}

export default function SlideOutPanel({ panel, onClose }) {
  const [workspaceFilter, setWorkspaceFilter] = useState('')
  const [typeFilter, setTypeFilter]           = useState('all')
  const panelRef = useRef(null)

  // Build a ws-name → type map for cross-content filtering
  const { data: workspaces } = useQuery({ queryKey: ['workspaces'], queryFn: fetchWorkspaces })
  const wsTypes = {}
  ;(workspaces || []).forEach(ws => { wsTypes[ws.name] = ws.config?.project?.type || 'custom' })

  // Reset filters when switching panels
  useEffect(() => {
    setWorkspaceFilter('')
    setTypeFilter('all')
  }, [panel])

  // Close on Escape
  useEffect(() => {
    function onKey(e) { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const cfg = PANEL_CONFIG[panel] || {}

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Panel — slides in from the right, 70% width */}
      <div
        ref={panelRef}
        className="fixed top-0 right-0 bottom-0 z-50 flex flex-col bg-gray-950 border-l border-gray-800 shadow-2xl"
        style={{ width: '70%' }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800 shrink-0">
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-500">{cfg.icon}</span>
            <h2 className="text-base font-semibold text-white">{cfg.title}</h2>
          </div>
          <button
            onClick={onClose}
            className="text-gray-500 hover:text-white transition-colors text-xl leading-none"
          >
            ×
          </button>
        </div>

        {/* Filter bar */}
        <FilterBar
          workspaceFilter={workspaceFilter}
          setWorkspaceFilter={setWorkspaceFilter}
          typeFilter={typeFilter}
          setTypeFilter={setTypeFilter}
        />

        {/* Scrollable content */}
        <div className="flex-1 overflow-y-auto min-h-0">
          {panel === 'activity' && (
            <ActivityContent workspaceFilter={workspaceFilter} typeFilter={typeFilter} wsTypes={wsTypes} />
          )}
          {panel === 'backup' && (
            <BackupContent workspaceFilter={workspaceFilter} typeFilter={typeFilter} wsTypes={wsTypes} />
          )}
          {panel === 'version' && (
            <VersionContent workspaceFilter={workspaceFilter} typeFilter={typeFilter} wsTypes={wsTypes} />
          )}
        </div>
      </div>
    </>
  )
}
