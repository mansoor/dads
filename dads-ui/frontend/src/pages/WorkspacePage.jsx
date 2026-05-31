import { useState, useRef, useEffect, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { fetchWorkspace, fetchEnvVars, fetchEnvStatus, fetchImageUpdates, fetchContainers, updateEnvVars, openActionSocket, exportTemplate } from '../lib/api'
import { useAuthStore } from '../store/auth'
import Layout from '../components/Layout'
import ComposeEditor from '../components/ComposeEditor'
import TerminalModal from '../components/TerminalModal'

// ── Env status badge ──────────────────────────────────────────────────────────

function StatusBadge({ label, color }) {
  const colors = {
    running:  'bg-green-500/20 text-green-400 border-green-500/30',
    partial:  'bg-amber-500/20 text-amber-400 border-amber-500/30',
    building: 'bg-amber-500/20 text-amber-400 border-amber-500/30',
    stopped:  'bg-red-500/15 text-red-400 border-red-500/30',
    unknown:  'bg-gray-700/40 text-gray-500 border-gray-600/30',
  }
  const dot = {
    running:  'bg-green-400',
    partial:  'bg-amber-400 animate-pulse',
    building: 'bg-amber-400 animate-pulse',
    stopped:  'bg-red-500',
    unknown:  'bg-gray-600',
  }
  const c = colors[color] || colors.unknown
  const d = dot[color] || dot.unknown
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-medium px-2 py-0.5 rounded-full border ${c}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${d}`} />
      {label}
    </span>
  )
}

// ── Environment card ──────────────────────────────────────────────────────────

// Returns { url, port } — url is null when nothing is configured
function envAccess(cfg, ws) {
  const host = window.location.hostname
  if (cfg?.domain) return { url: `http://${cfg.domain}`, port: null }
  const isImage = ws?.config?.project?.type === 'image'
  if (isImage) {
    const firstPort = (ws?.config?.images || []).map(i => i.host_port).find(p => p && String(p) !== '0')
    if (firstPort) return { url: `http://${host}:${firstPort}`, port: String(firstPort) }
  } else if (cfg?.http_port && cfg.http_port !== 80) {
    return { url: `http://${host}:${cfg.http_port}`, port: String(cfg.http_port) }
  }
  return { url: null, port: null }
}

// Keep old name for any remaining callers
function envUrl(cfg, ws) { return envAccess(cfg, ws).url }

function EnvCard({ name, ws, envName, cfg, onAction, onConfig, onCompose, onTerminal, onActionDone }) {
  const qc         = useQueryClient()
  const domain     = cfg?.domain || '—'
  const gitBranch  = cfg?.git?.branch || ''
  const deployment = cfg?.deployment || 'compose'
  const isImage    = ws?.config?.project?.type === 'image'
  const { url, port } = envAccess(cfg, ws)

  // Poll container status every 15 seconds, refresh immediately after actions
  const { data: statusData, refetch: refetchStatus } = useQuery({
    queryKey: ['envstatus', name, envName],
    queryFn: () => fetchEnvStatus(name, envName),
    refetchInterval: 120_000,
    retry: false,
  })
  const containerStatus = statusData?.status || 'unknown'

  // Image update check — results come from hourly background cache; poll every 10 min
  const { data: imgUpdates } = useQuery({
    queryKey: ['imageupdates', name, envName],
    queryFn: () => fetchImageUpdates(name, envName),
    enabled: isImage,
    refetchInterval: 10 * 60 * 1000,
    retry: false,
  })
  const hasImageUpdate = imgUpdates?.updates?.some(u => u.has_update) || false
  const updateServices = (imgUpdates?.updates || []).filter(u => u.has_update).map(u => `${u.service}: ${u.newer_tag}`)

  function handleAction(cmd) {
    onAction(cmd, envName, () => {
      setTimeout(() => {
        refetchStatus()
        // After an update, clear the image-updates cache so it re-checks
        if (cmd === 'update') {
          qc.invalidateQueries({ queryKey: ['imageupdates', name, envName] })
        }
      }, 2000)
    })
  }

  const [stopOpen, setStopOpen]       = useState(false)
  const [noUpdateMsg, setNoUpdateMsg] = useState(false)
  const stopRef = useRef(null)

  // Close dropdown when clicking outside
  useEffect(() => {
    if (!stopOpen) return
    function handler(e) { if (stopRef.current && !stopRef.current.contains(e.target)) setStopOpen(false) }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [stopOpen])

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 flex flex-col gap-4">
      {/* Card header */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 flex-wrap min-w-0">
          <h3 className="font-semibold text-white text-base shrink-0">{envName}</h3>

          {/* Port badge — shown when no domain is set but a port is configured */}
          {port && !cfg?.domain && url && (
            <a
              href={url} target="_blank" rel="noreferrer"
              title={`Open ${url}`}
              className="text-xs font-mono px-2 py-0.5 rounded-full bg-gray-800 hover:bg-brand-900 text-gray-400 hover:text-brand-300 border border-gray-700 hover:border-brand-600 transition-colors shrink-0"
            >
              :{port} ↗
            </a>
          )}

          {/* Domain link — shown when domain is configured */}
          {cfg?.domain && url && (
            <a
              href={url} target="_blank" rel="noreferrer"
              title={`Open ${url}`}
              className="text-xs px-2 py-0.5 rounded-full bg-gray-800 hover:bg-brand-900 text-gray-400 hover:text-brand-300 border border-gray-700 hover:border-brand-600 transition-colors shrink-0 truncate max-w-[120px]"
            >
              {cfg.domain} ↗
            </a>
          )}

          {hasImageUpdate && (
            <span
              title={updateServices.join('\n')}
              className="text-xs font-medium px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-300 border border-amber-500/30 animate-pulse shrink-0 cursor-default"
            >
              ↑ update available
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {/* > bash terminal button */}
          <button
            onClick={onTerminal}
            title="Open terminal"
            className="font-mono text-xs px-2 py-0.5 rounded bg-gray-800 hover:bg-gray-700 text-gray-400 hover:text-green-400 border border-gray-700 hover:border-green-700 transition-colors"
          >
            &gt; bash
          </button>
          <StatusBadge label={containerStatus} color={containerStatus} />
        </div>
      </div>

      {/* Details */}
      <div className="space-y-1.5 text-sm text-gray-400">
        {/* Only show domain/url row if neither badge above applies */}
        {!cfg?.domain && !port && <DetailRow icon="○" value="no url configured" />}
        {gitBranch && <DetailRow icon="○" value={gitBranch} />}
      </div>

      {/* Actions — 2×2 grid: [Deploy][Update] / [Restart][Stop▾] */}
      <div className="grid grid-cols-2 gap-2 mt-auto">

        {/* Row 1 col 1: Deploy */}
        <button
          onClick={() => handleAction('start')}
          className="text-sm font-medium px-3 py-1.5 rounded-lg transition-colors flex items-center justify-center gap-1.5 bg-brand-600 hover:bg-brand-700 text-white"
        >
          <span className="text-xs opacity-60">○</span> Deploy
        </button>

        {/* Row 1 col 2: Update (image stacks) or empty slot (custom) */}
        {isImage ? (() => {
          const checked  = imgUpdates && !imgUpdates.pending
          const upToDate = checked && !hasImageUpdate

          function handleUpdate() {
            if (upToDate) {
              setNoUpdateMsg(true)
              setTimeout(() => setNoUpdateMsg(false), 3000)
              return
            }
            handleAction('update')
          }

          return (
            <div className="relative">
              <button
                onClick={handleUpdate}
                className={`w-full text-sm font-medium px-3 py-1.5 rounded-lg transition-colors flex items-center justify-center gap-1.5 border ${
                  upToDate
                    ? 'bg-gray-800/60 text-gray-500 border-gray-700 cursor-default'
                    : 'bg-amber-500/15 hover:bg-amber-500/25 text-amber-300 hover:text-amber-200 border-amber-500/20'
                }`}
                title={upToDate ? 'All images are up to date' : 'Pull latest images and recreate containers'}
              >
                <span className="text-xs">{upToDate ? '✓' : '↑'}</span>
                {upToDate ? 'Up to date' : 'Update'}
                {hasImageUpdate && <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />}
              </button>
              {noUpdateMsg && (
                <div className="absolute left-0 right-0 -bottom-7 text-center text-xs text-gray-400 bg-gray-800 border border-gray-700 rounded px-2 py-1 z-10 pointer-events-none">
                  Already up to date
                </div>
              )}
            </div>
          )
        })() : <div />}

        {/* Row 2 col 1: Restart */}
        <button
          onClick={() => handleAction('restart')}
          className="text-sm font-medium px-3 py-1.5 rounded-lg transition-colors flex items-center justify-center gap-1.5 bg-gray-800 hover:bg-gray-700 text-gray-300 hover:text-white"
        >
          <span className="text-xs opacity-60">○</span> Restart
        </button>

        {/* Row 2 col 2: Stop / Down split button */}
        <div ref={stopRef} className="relative flex">
          <button
            onClick={() => handleAction('stop')}
            className="flex-1 text-sm font-medium px-3 py-1.5 rounded-l-lg transition-colors flex items-center justify-center gap-1.5 bg-red-900/60 hover:bg-red-800/80 text-red-300 hover:text-red-200"
          >
            <span className="text-xs opacity-60">○</span> Stop
          </button>
          <button
            onClick={() => setStopOpen(o => !o)}
            className="px-1.5 py-1.5 rounded-r-lg border-l border-red-900 bg-red-900/60 hover:bg-red-800/80 text-red-300 hover:text-red-200 transition-colors"
            title="More stop options"
          >
            ▾
          </button>
          {stopOpen && (
            <div className="absolute right-0 top-full mt-1 z-20 bg-gray-800 border border-gray-700 rounded-lg shadow-xl min-w-[160px] py-1">
              <button
                onClick={() => { setStopOpen(false); handleAction('stop') }}
                className="w-full text-left px-3 py-2 text-sm text-gray-200 hover:bg-gray-700 transition-colors"
              >
                Stop
                <p className="text-xs text-gray-500 mt-0.5">Pause containers (keep state)</p>
              </button>
              <button
                onClick={() => { setStopOpen(false); handleAction('down') }}
                className="w-full text-left px-3 py-2 text-sm text-red-300 hover:bg-gray-700 transition-colors"
              >
                Inactivate
                <p className="text-xs text-gray-500 mt-0.5">Remove containers (keep volumes)</p>
              </button>
            </div>
          )}
        </div>

      </div>{/* end grid */}

      {/* File editors + Backup */}
      <div className="flex gap-2 pt-3 border-t border-gray-800">
        <button onClick={onConfig}
          className="flex-1 text-xs text-gray-400 hover:text-gray-200 py-1.5 rounded-lg hover:bg-gray-800 transition-colors">
          Env Vars
        </button>
        <button onClick={onCompose}
          className="flex-1 text-xs text-gray-400 hover:text-gray-200 py-1.5 rounded-lg hover:bg-gray-800 transition-colors">
          Compose
        </button>
        <button onClick={() => handleAction('backup')}
          className="flex-1 text-xs text-gray-400 hover:text-gray-200 py-1.5 rounded-lg hover:bg-gray-800 transition-colors">
          Backup
        </button>
      </div>
    </div>
  )
}

function DetailRow({ icon, value }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-gray-600">{icon}</span>
      <span className="truncate">{value}</span>
    </div>
  )
}

// ── Release pipeline ──────────────────────────────────────────────────────────

function ReleasePipeline({ ws }) {
  const isImage = ws?.config?.project?.type === 'image'
  if (isImage) return null

  const v = ws?.config?.project?.version
  const vStr = v ? `v${v.major}.${v.minor}.${v.patch}-build.${v.build}` : '—'
  const envs = ws?.envs || []

  const steps = [
    { label: 'dev build',    status: 'done',    version: vStr },
    { label: 'stage build',  status: 'done',    version: vStr },
    { label: 'stage deploy', status: 'active',  version: null },
    { label: 'QA sign-off',  status: 'pending', version: null },
    { label: 'promote → prod', status: 'pending', version: null },
  ]

  const stepStyle = {
    done:    'bg-green-500 border-green-500 text-green-900',
    active:  'bg-amber-400 border-amber-400 text-amber-900 animate-pulse',
    pending: 'bg-gray-800 border-gray-700 text-gray-500',
  }

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
      <h2 className="text-sm font-semibold text-gray-300 mb-5 flex items-center gap-2">
        <span className="text-xs">○</span> Release pipeline
      </h2>

      <div className="flex items-center gap-0 mb-5 overflow-x-auto pb-2">
        {steps.map((step, i) => (
          <div key={step.label} className="flex items-center">
            <div className="flex flex-col items-center gap-1.5 min-w-[90px]">
              <div className={`w-9 h-9 rounded-full border-2 flex items-center justify-center text-xs font-bold ${stepStyle[step.status]}`}>
                {step.status === 'done' ? '✓' : step.status === 'active' ? '◎' : '○'}
              </div>
              <span className={`text-xs text-center leading-tight ${step.status === 'pending' ? 'text-gray-600' : 'text-gray-300'}`}>
                {step.label}
              </span>
              {step.version && (
                <span className="text-xs text-gray-500 font-mono">{step.version}</span>
              )}
              {step.status === 'active' && (
                <span className="text-xs text-amber-400">in progress</span>
              )}
              {step.status === 'pending' && (
                <span className="text-xs text-gray-600">—</span>
              )}
            </div>
            {i < steps.length - 1 && (
              <div className={`h-0.5 w-8 shrink-0 mx-1 ${i < 2 ? 'bg-green-500' : 'bg-gray-700'}`} />
            )}
          </div>
        ))}
      </div>

      <div className="flex items-center justify-between bg-gray-800/60 rounded-lg px-4 py-3">
        <p className="text-sm text-gray-300">
          Ready to promote? <span className="font-mono text-white">{vStr}</span> will be retagged and deployed to prod — no rebuild.
        </p>
        <button className="ml-4 shrink-0 bg-gray-700 hover:bg-gray-600 text-gray-300 hover:text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors flex items-center gap-1.5">
          <span className="text-xs">○</span> Promote to prod
        </button>
      </div>
    </div>
  )
}

// ── Inline action log — streams output from Deploy/Stop/Restart/Backup etc. ──

function ActionLog({ actionWs, actionTitle, onClear }) {
  const [lines, setLines] = useState([])
  const [running, setRunning] = useState(false)
  const bottomRef = useRef(null)
  const wsRef = useRef(null)

  useEffect(() => {
    if (!actionWs) return
    wsRef.current = actionWs
    setLines([])
    setRunning(true)

    actionWs.addEventListener('message', e => {
      const text = String(e.data || '')
      setLines(prev => {
        const newLines = text.split(/\r?\n/).filter(l => l !== '')
        const next = [...prev, ...newLines]
        return next.length > 2000 ? next.slice(-2000) : next
      })
    })
    actionWs.addEventListener('close', () => setRunning(false))
    actionWs.addEventListener('error', () => setRunning(false))
  }, [actionWs])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [lines])

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl flex flex-col overflow-hidden" style={{ height: 380 }}>
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800 shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-gray-300">Action output</span>
          {actionTitle && (
            <span className="text-xs text-gray-500 bg-gray-800 px-2 py-0.5 rounded font-mono">{actionTitle}</span>
          )}
          {running && <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />}
        </div>
        {lines.length > 0 && (
          <button onClick={onClear} className="text-xs text-gray-600 hover:text-gray-400 transition-colors">Clear</button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-3 font-mono text-xs leading-relaxed bg-gray-950/60 min-h-0">
        {lines.length === 0 ? (
          <p className="text-gray-700 pt-2">
            Run Deploy, Stop, Restart, Backup, Update or other actions — output will stream here.
          </p>
        ) : (
          lines.map((line, i) => (
            <div key={i} dangerouslySetInnerHTML={{ __html: ansiToHtml(line) }} />
          ))
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  )
}

function capitalize(s) {
  return s ? s[0].toUpperCase() + s.slice(1) : ''
}

// ── Inline log viewer ─────────────────────────────────────────────────────────

function LogViewer({ wsName, envs }) {
  const token       = useAuthStore(s => s.token)
  const [activeEnv, setActiveEnv]       = useState(envs[0] || '')
  const [activeContainer, setContainer] = useState(null) // null = all
  const [lines, setLines]               = useState([])
  const wsRef    = useRef(null)
  const bottomRef = useRef(null)

  const { data: containers } = useQuery({
    queryKey: ['containers', wsName, activeEnv],
    queryFn:  () => fetchContainers(wsName, activeEnv),
    enabled:  !!activeEnv,
    refetchInterval: 15_000,
    retry: false,
  })

  // Reconnect whenever env or container selection changes
  const connect = useCallback(() => {
    if (wsRef.current) {
      wsRef.current.close()
      wsRef.current = null
    }
    setLines([`\x1b[2m--- connecting to ${activeEnv}${activeContainer ? ` / ${activeContainer}` : ''} logs ---\x1b[0m`])

    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(`${proto}://${window.location.host}/api/workspaces/${wsName}/action`)
    wsRef.current = ws

    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({
        token,
        command: 'logs',
        env: activeEnv,
        extra: activeContainer ? [activeContainer] : [],
      }))
    })

    ws.addEventListener('message', e => {
      const text = e.data || ''
      // Split on newlines so each line is a separate entry, preserve ANSI codes
      const newLines = text.split(/\r?\n/)
      setLines(prev => {
        const next = [...prev, ...newLines.filter(l => l !== '')]
        return next.length > 2000 ? next.slice(-2000) : next
      })
    })

    ws.addEventListener('close', () => {
      setLines(prev => [...prev, '\x1b[2m--- stream closed ---\x1b[0m'])
    })

    ws.addEventListener('error', () => {
      setLines(prev => [...prev, '\x1b[31m--- connection error ---\x1b[0m'])
    })
  }, [wsName, activeEnv, activeContainer, token])

  useEffect(() => {
    connect()
    return () => { wsRef.current?.close() }
  }, [connect])

  // Auto-scroll to bottom when new lines arrive
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [lines])

  // Reset container selection when env changes
  function switchEnv(env) {
    setActiveEnv(env)
    setContainer(null)
  }

  const statusColor = { running: 'text-green-400', exited: 'text-red-400', paused: 'text-amber-400' }

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl flex flex-col overflow-hidden" style={{ height: 380 }}>
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3.5 border-b border-gray-800 shrink-0">
        <h2 className="text-sm font-semibold text-gray-300">Logs</h2>
        <button
          onClick={connect}
          className="text-xs text-gray-500 hover:text-gray-300 transition-colors"
          title="Reconnect"
        >↺ reconnect</button>
      </div>

      {/* Env tabs */}
      <div className="flex items-center gap-1 px-3 py-2 border-b border-gray-800/60 shrink-0 overflow-x-auto">
        {envs.map(env => (
          <button
            key={env}
            onClick={() => switchEnv(env)}
            className={`px-3 py-1 text-xs font-medium rounded-md transition-colors shrink-0 ${
              activeEnv === env
                ? 'bg-brand-600 text-white'
                : 'text-gray-400 hover:text-white hover:bg-gray-800'
            }`}
          >{env}</button>
        ))}
      </div>

      {/* Container pills */}
      {(containers || []).length > 0 && (
        <div className="flex items-center gap-1.5 px-3 py-2 border-b border-gray-800/40 shrink-0 overflow-x-auto">
          <button
            onClick={() => setContainer(null)}
            className={`px-2.5 py-0.5 text-xs rounded-full transition-colors shrink-0 ${
              activeContainer === null
                ? 'bg-gray-600 text-white'
                : 'text-gray-500 hover:text-gray-300 bg-gray-800/60'
            }`}
          >all</button>
          {(containers || []).map(c => (
            <button
              key={c.Name}
              onClick={() => setContainer(c.Service)}
              className={`flex items-center gap-1.5 px-2.5 py-0.5 text-xs rounded-full transition-colors shrink-0 ${
                activeContainer === c.Service
                  ? 'bg-gray-600 text-white'
                  : 'text-gray-500 hover:text-gray-300 bg-gray-800/60'
              }`}
            >
              <span className={`w-1.5 h-1.5 rounded-full ${
                c.State === 'running' ? 'bg-green-400' :
                c.State === 'exited'  ? 'bg-red-500' : 'bg-amber-400'
              }`} />
              <span className={statusColor[c.State] || 'text-gray-400'}>{c.Service}</span>
            </button>
          ))}
        </div>
      )}

      {/* Log output */}
      <div className="flex-1 overflow-y-auto p-3 font-mono text-xs leading-relaxed bg-gray-950/60">
        {lines.map((line, i) => (
          <div key={i} dangerouslySetInnerHTML={{ __html: ansiToHtml(line) }} />
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  )
}

// Minimal ANSI → HTML converter for the most common codes
function ansiToHtml(text) {
  const safe = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')

  return safe
    .replace(/\x1b\[0m/g, '</span>')
    .replace(/\x1b\[1m/g, '<span style="font-weight:bold">')
    .replace(/\x1b\[2m/g, '<span style="opacity:0.5">')
    .replace(/\x1b\[31m/g, '<span style="color:#f87171">')
    .replace(/\x1b\[32m/g, '<span style="color:#4ade80">')
    .replace(/\x1b\[33m/g, '<span style="color:#fbbf24">')
    .replace(/\x1b\[34m/g, '<span style="color:#60a5fa">')
    .replace(/\x1b\[35m/g, '<span style="color:#c084fc">')
    .replace(/\x1b\[36m/g, '<span style="color:#22d3ee">')
    .replace(/\x1b\[37m/g, '<span style="color:#e5e7eb">')
    .replace(/\x1b\[[0-9;]*m/g, '') // strip remaining codes
}

// ── Export as template modal ──────────────────────────────────────────────────

function ExportTemplateModal({ name, envs, onClose }) {
  const [label, setLabel]       = useState(name)
  const [desc, setDesc]         = useState('')
  const [tags, setTags]         = useState('')
  const [env, setEnv]           = useState(envs[0] || '')
  const [done, setDone]         = useState(false)
  const [error, setError]       = useState('')

  const mutation = useMutation({
    mutationFn: () => exportTemplate(name, {
      label,
      description: desc,
      tags: tags.split(',').map(t => t.trim()).filter(Boolean),
      env,
    }),
    onSuccess: () => setDone(true),
    onError: (e) => setError(e.response?.data?.error || 'Export failed'),
  })

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-gray-900 border border-gray-800 rounded-xl w-full max-w-md mx-4 p-6 space-y-4" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h3 className="font-semibold text-white">Export as prebuilt template</h3>
          <button onClick={onClose} className="text-gray-500 hover:text-white text-xl">×</button>
        </div>

        {done ? (
          <div className="space-y-3">
            <p className="text-sm text-green-400">✓ Template saved as <code className="font-mono text-xs bg-gray-800 px-1 py-0.5 rounded">{name}.json</code> in <code className="font-mono text-xs bg-gray-800 px-1 py-0.5 rounded">templates/stacks/</code>.</p>
            <p className="text-xs text-gray-500">It will appear in the "Pre-built template" picker when creating a new workspace.</p>
            <button onClick={onClose} className="w-full bg-brand-600 hover:bg-brand-700 text-white text-sm font-semibold py-2 rounded-lg transition-colors">Close</button>
          </div>
        ) : (
          <>
            {error && <p className="text-sm text-red-400 bg-red-950/40 border border-red-800/50 rounded-lg px-3 py-2">{error}</p>}

            <div>
              <label className="block text-xs font-semibold text-gray-400 uppercase tracking-wider mb-1">Template label</label>
              <input value={label} onChange={e => setLabel(e.target.value)}
                className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:border-brand-500" />
            </div>
            <div>
              <label className="block text-xs font-semibold text-gray-400 uppercase tracking-wider mb-1">Description</label>
              <textarea value={desc} onChange={e => setDesc(e.target.value)} rows={2}
                className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:border-brand-500 resize-none" />
            </div>
            <div>
              <label className="block text-xs font-semibold text-gray-400 uppercase tracking-wider mb-1">Tags <span className="normal-case font-normal text-gray-500">(comma-separated)</span></label>
              <input value={tags} onChange={e => setTags(e.target.value)} placeholder="nginx, proxy, ssl"
                className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:border-brand-500" />
            </div>
            {envs.length > 1 && (
              <div>
                <label className="block text-xs font-semibold text-gray-400 uppercase tracking-wider mb-1">Read env vars from</label>
                <select value={env} onChange={e => setEnv(e.target.value)}
                  className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:border-brand-500">
                  {envs.map(e => <option key={e} value={e}>{e}</option>)}
                </select>
              </div>
            )}
            <p className="text-xs text-gray-500">Secret values will be replaced with <code className="font-mono">CHANGE_ME</code> placeholders in the template.</p>
            <button
              onClick={() => mutation.mutate()}
              disabled={mutation.isPending || !label}
              className="w-full bg-brand-600 hover:bg-brand-700 disabled:opacity-50 text-white text-sm font-semibold py-2 rounded-lg transition-colors"
            >
              {mutation.isPending ? 'Exporting…' : 'Export template'}
            </button>
          </>
        )}
      </div>
    </div>
  )
}

// ── Env vars editor (modal) ───────────────────────────────────────────────────

function EnvVarsModal({ name, env, onClose }) {
  const qc = useQueryClient()
  const [reveal, setReveal] = useState(false)
  const [edits, setEdits]   = useState({})
  const [deletes, setDeletes] = useState(new Set())
  const [newKey, setNewKey] = useState('')
  const [newVal, setNewVal] = useState('')

  const { data: vars, isLoading } = useQuery({
    queryKey: ['envvars', name, env, reveal],
    queryFn: () => fetchEnvVars(name, env, reveal),
  })

  const mutation = useMutation({
    mutationFn: ({ updates, dels }) => updateEnvVars(name, env, updates, dels),
    onSuccess: () => {
      setEdits({})
      setDeletes(new Set())
      setNewKey('')
      setNewVal('')
      qc.invalidateQueries({ queryKey: ['envvars', name, env] })
    },
  })

  function toggleDelete(k) {
    setDeletes(prev => {
      const next = new Set(prev)
      next.has(k) ? next.delete(k) : next.add(k)
      return next
    })
    // Clear any pending edit for a key being deleted
    setEdits(prev => { const n = { ...prev }; delete n[k]; return n })
  }

  function handleSave() {
    const updates = { ...edits }
    if (newKey.trim()) updates[newKey.trim()] = newVal
    mutation.mutate({ updates, dels: [...deletes] })
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-gray-900 border border-gray-800 rounded-xl w-full max-w-lg mx-4 p-6" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-semibold text-white">Env vars — {env}</h3>
          <button onClick={onClose} className="text-gray-500 hover:text-white text-xl">×</button>
        </div>

        {/* Reveal toggle */}
        <div className="flex items-center justify-between mb-4">
          <p className="text-xs text-gray-500">
            {reveal ? 'Showing current values — edit to change.' : 'Values hidden. Edit inputs to change; leave blank to keep existing.'}
          </p>
          <label className="flex items-center gap-2 cursor-pointer shrink-0 ml-3">
            <input
              type="checkbox"
              checked={reveal}
              onChange={e => { setReveal(e.target.checked); setEdits({}) }}
              className="w-3.5 h-3.5 accent-brand-500"
            />
            <span className="text-xs text-gray-400 select-none">Show values</span>
          </label>
        </div>

        {isLoading ? <p className="text-gray-500 text-sm">Loading…</p> : (
          <div className="space-y-2 mb-4 max-h-72 overflow-y-auto pr-1">
            {Object.entries(vars || {}).map(([k, currentVal]) => {
              const markedForDelete = deletes.has(k)
              return (
                <div key={k} className={`flex items-center gap-2 rounded transition-colors ${markedForDelete ? 'opacity-40' : ''}`}>
                  <span className="font-mono text-xs text-gray-300 w-40 shrink-0 truncate" title={k}>{k}</span>
                  <input
                    type={reveal ? 'text' : 'password'}
                    placeholder={reveal ? currentVal : '••••••••'}
                    value={markedForDelete ? '' : (edits[k] ?? (reveal ? currentVal : ''))}
                    disabled={markedForDelete}
                    onChange={e => setEdits(p => ({ ...p, [k]: e.target.value }))}
                    className="flex-1 px-2 py-1 bg-gray-800 border border-gray-700 rounded text-sm text-white font-mono focus:outline-none focus:border-brand-500 disabled:opacity-40 disabled:cursor-not-allowed"
                  />
                  <button
                    type="button"
                    onClick={() => toggleDelete(k)}
                    title={markedForDelete ? 'Undo delete' : 'Delete this variable'}
                    className={`shrink-0 w-6 h-6 flex items-center justify-center rounded transition-colors text-xs ${
                      markedForDelete
                        ? 'bg-red-800 text-red-200 hover:bg-red-700'
                        : 'text-gray-600 hover:text-red-400 hover:bg-gray-700'
                    }`}
                  >
                    {markedForDelete ? '↩' : '×'}
                  </button>
                </div>
              )
            })}
          </div>
        )}

        <div className="flex gap-2 mb-4 pt-3 border-t border-gray-800">
          <input type="text" placeholder="NEW_KEY" value={newKey} onChange={e => setNewKey(e.target.value)}
            className="w-44 px-2 py-1 bg-gray-800 border border-gray-700 rounded text-sm text-white font-mono focus:outline-none focus:border-brand-500" />
          <input type={reveal ? 'text' : 'password'} placeholder="value" value={newVal} onChange={e => setNewVal(e.target.value)}
            className="flex-1 px-2 py-1 bg-gray-800 border border-gray-700 rounded text-sm text-white font-mono focus:outline-none focus:border-brand-500" />
        </div>

        <div className="flex items-center gap-3">
          <button onClick={handleSave} disabled={mutation.isPending}
            className="bg-brand-600 hover:bg-brand-700 disabled:opacity-50 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors">
            {mutation.isPending ? 'Saving…' : 'Save changes'}
          </button>
          {mutation.isSuccess && <span className="text-green-400 text-sm">Saved ✓</span>}
          {mutation.isError && <span className="text-red-400 text-sm">Failed</span>}
        </div>
      </div>
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function WorkspacePage() {
  const { name } = useParams()
  const navigate = useNavigate()
  const [actionWs, setActionWs]           = useState(null)   // current action WebSocket → ActionLog
  const [actionTitle, setActionTitle]     = useState('')
  const [configModal, setConfigModal]     = useState(null)
  const [composeModal, setComposeModal]   = useState(null)
  const [exportModal, setExportModal]     = useState(false)
  const [termModal, setTermModal]         = useState(null) // {env}

  const { data: ws, isLoading, error } = useQuery({
    queryKey: ['workspace', name],
    queryFn: () => fetchWorkspace(name),
  })

  function runAction(cmd, env, onComplete) {
    const socket = openActionSocket(name, cmd, env)
    if (onComplete) socket.addEventListener('close', onComplete)
    setActionWs(socket)
    setActionTitle(`${cmd} ${env}`)
  }

  if (isLoading) return <Layout><div className="p-8 text-gray-500 text-sm">Loading…</div></Layout>
  if (error)     return <Layout><div className="p-8 text-red-400 text-sm">Failed to load workspace: {error.message}</div></Layout>

  const cfg = ws?.config
  const envs = ws?.envs || []
  const type = cfg?.project?.type || 'custom'
  const version = cfg?.project?.version
  const vStr = version ? `v${version.major}.${version.minor}.${version.patch}-build.${version.build}` : ''

  // Build header stack description
  const stackParts = []
  if (type === 'image') {
    ;(cfg?.images || []).forEach(img => stackParts.push(img.image?.split('/').pop()))
  } else {
    const firstEnvCfg = cfg?.environments?.[envs[0]] || {}
    if (firstEnvCfg.backend) stackParts.push(capitalize(firstEnvCfg.backend))
    if (firstEnvCfg.frontend && firstEnvCfg.frontend !== 'none') stackParts.push(capitalize(firstEnvCfg.frontend))
    if (firstEnvCfg.database && firstEnvCfg.database !== 'none') stackParts.push(capitalize(firstEnvCfg.database))
    if (firstEnvCfg.redis_enabled) stackParts.push('Redis')
  }

  return (
    <Layout>
      <div className="p-6 space-y-5">
        {/* Header */}
        <div className="flex items-start justify-between">
          <div>
            <div className="flex items-center gap-3 flex-wrap">
              <h1 className="text-2xl font-bold text-white">{name}</h1>
              <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${
                type === 'image' ? 'bg-blue-950 text-blue-300' : 'bg-purple-950 text-purple-300'
              }`}>{type}</span>
              {(() => {
                const dep = cfg?.environments?.[envs[0]]?.deployment || 'compose'
                return <span className="text-xs px-2 py-0.5 rounded-full bg-gray-800 text-gray-400">{dep}</span>
              })()}
            </div>
            <p className="text-sm text-gray-400 mt-1">
              {stackParts.join(' · ')}
              {vStr && <span className="ml-2 font-mono text-gray-500 text-xs">{vStr}</span>}
            </p>
          </div>

          {/* Global actions */}
          <div className="flex items-center gap-2 flex-wrap justify-end">
            {type === 'image' && <HeaderBtn label="Export as template" onClick={() => setExportModal(true)} />}
            <HeaderBtn label="Edit workspace" onClick={() => navigate(`/workspaces/${name}/edit`)} />
            {type !== 'image' && <HeaderBtn label="Build ↗" onClick={() => runAction('build', envs[0])} primary />}
          </div>
        </div>

        {/* Environment cards */}
        <div className={`grid gap-4 ${envs.length === 1 ? 'grid-cols-1 max-w-sm' : envs.length === 2 ? 'grid-cols-2' : 'grid-cols-3'}`}>
          {envs.map(env => (
            <EnvCard
              key={env}
              name={name}
              ws={ws}
              envName={env}
              cfg={cfg?.environments?.[env]}
              onAction={runAction}
              onConfig={() => setConfigModal({ env })}
              onCompose={() => setComposeModal({ env })}
              onTerminal={() => setTermModal({ env })}
            />
          ))}
        </div>

        {/* Release pipeline (custom stacks only) */}
        {type !== 'image' && <ReleasePipeline ws={ws} />}

        {/* Bottom split: Action output + Logs — both fixed-height, scroll internally */}
        <div className="grid grid-cols-2 gap-5 items-start">
          <ActionLog
            actionWs={actionWs}
            actionTitle={actionTitle}
            onClear={() => { setActionWs(null); setActionTitle('') }}
          />
          <LogViewer wsName={name} envs={envs} />
        </div>
      </div>

      {/* Modals / drawers */}
      {configModal && (
        <EnvVarsModal name={name} env={configModal.env} onClose={() => setConfigModal(null)} />
      )}
      {composeModal && (
        <ComposeEditor name={name} env={composeModal.env} onClose={() => setComposeModal(null)} />
      )}
      {exportModal && (
        <ExportTemplateModal name={name} envs={envs} onClose={() => setExportModal(false)} />
      )}
      {termModal && (
        <TerminalModal wsName={name} envName={termModal.env} onClose={() => setTermModal(null)} />
      )}
    </Layout>
  )
}

function HeaderBtn({ label, onClick, primary }) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1.5 text-sm font-medium px-3 py-1.5 rounded-lg border transition-colors ${
        primary
          ? 'bg-brand-600 hover:bg-brand-700 text-white border-brand-600'
          : 'bg-transparent hover:bg-gray-800 text-gray-300 hover:text-white border-gray-700'
      }`}
    >
      <span className="text-xs opacity-60">○</span> {label}
    </button>
  )
}
