import { useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { fetchWorkspace, fetchActivity, fetchEnvVars, fetchEnvStatus, updateEnvVars, openActionSocket } from '../lib/api'
import Layout from '../components/Layout'
import LogDrawer from '../components/LogDrawer'
import ComposeEditor from '../components/ComposeEditor'

// ── Env status badge ──────────────────────────────────────────────────────────

function StatusBadge({ label, color }) {
  const colors = {
    running:  'bg-green-500/20 text-green-400 border-green-500/30',
    partial:  'bg-amber-500/20 text-amber-400 border-amber-500/30',
    building: 'bg-amber-500/20 text-amber-400 border-amber-500/30',
    stopped:  'bg-gray-700/40 text-gray-400 border-gray-600/30',
    unknown:  'bg-gray-700/40 text-gray-500 border-gray-600/30',
  }
  const dot = {
    running:  'bg-green-400',
    partial:  'bg-amber-400 animate-pulse',
    building: 'bg-amber-400 animate-pulse',
    stopped:  'bg-gray-500',
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

function EnvCard({ name, ws, envName, cfg, onAction, onConfig, onCompose, onActionDone }) {
  const domain     = cfg?.domain || '—'
  const gitBranch  = cfg?.git?.branch || ''
  const deployment = cfg?.deployment || 'compose'
  const isImage    = ws?.config?.project?.type === 'image'

  // Poll container status every 15 seconds, refresh immediately after actions
  const { data: statusData, refetch: refetchStatus } = useQuery({
    queryKey: ['envstatus', name, envName],
    queryFn: () => fetchEnvStatus(name, envName),
    refetchInterval: 15_000,
    retry: false,
  })
  const containerStatus = statusData?.status || 'unknown'

  function handleAction(cmd) {
    onAction(cmd, envName, () => {
      // Refetch status a moment after action completes
      setTimeout(() => refetchStatus(), 2000)
    })
  }

  const actions = isImage
    ? [
        { cmd: 'start',   label: 'Deploy',  variant: 'primary' },
        { cmd: 'stop',    label: 'Stop',    variant: 'danger' },
        { cmd: 'restart', label: 'Restart', variant: 'default' },
        { cmd: 'logs',    label: 'Logs',    variant: 'default' },
      ]
    : [
        { cmd: 'start',   label: 'Deploy',  variant: 'primary' },
        { cmd: 'stop',    label: 'Stop',    variant: 'danger' },
        { cmd: 'restart', label: 'Restart', variant: 'default' },
        { cmd: 'logs',    label: 'Logs',    variant: 'default' },
      ]

  const btnClass = {
    primary: 'bg-brand-600 hover:bg-brand-700 text-white',
    danger:  'bg-red-900/60 hover:bg-red-800/80 text-red-300 hover:text-red-200',
    default: 'bg-gray-800 hover:bg-gray-700 text-gray-300 hover:text-white',
  }

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 flex flex-col gap-4">
      {/* Card header */}
      <div className="flex items-start justify-between">
        <h3 className="font-semibold text-white text-base">{envName}</h3>
        <StatusBadge
          label={containerStatus}
          color={containerStatus}
        />
      </div>

      {/* Details */}
      <div className="space-y-1.5 text-sm text-gray-400">
        <DetailRow icon="○" value={domain} />
        {gitBranch && <DetailRow icon="○" value={gitBranch} />}
        <DetailRow icon="○" value={deployment} />
      </div>

      {/* Actions */}
      <div className="grid grid-cols-2 gap-2 mt-auto">
        {actions.map(a => (
          <button
            key={a.cmd}
            onClick={() => handleAction(a.cmd)}
            className={`text-sm font-medium px-3 py-1.5 rounded-lg transition-colors flex items-center justify-center gap-1.5 ${btnClass[a.variant]}`}
          >
            <span className="text-xs opacity-60">○</span> {a.label}
          </button>
        ))}
      </div>

      {/* File editors */}
      <div className="flex gap-2 pt-3 border-t border-gray-800">
        <button onClick={onConfig}
          className="flex-1 text-xs text-gray-400 hover:text-gray-200 py-1.5 rounded-lg hover:bg-gray-800 transition-colors">
          Env Vars
        </button>
        <button onClick={onCompose}
          className="flex-1 text-xs text-gray-400 hover:text-gray-200 py-1.5 rounded-lg hover:bg-gray-800 transition-colors">
          Compose file
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

// ── Activity feed ─────────────────────────────────────────────────────────────

const CMD_COLOR = {
  start:   { dot: 'bg-green-500',  bg: 'bg-green-500/20' },
  stop:    { dot: 'bg-red-500',    bg: 'bg-red-500/20' },
  restart: { dot: 'bg-amber-400',  bg: 'bg-amber-400/20' },
  build:   { dot: 'bg-brand-500',  bg: 'bg-brand-500/20' },
  backup:  { dot: 'bg-gray-500',   bg: 'bg-gray-500/20' },
  promote: { dot: 'bg-purple-500', bg: 'bg-purple-500/20' },
  default: { dot: 'bg-gray-600',   bg: 'bg-gray-600/20' },
}

function timeAgo(ts) {
  if (!ts) return ''
  const diff = Math.floor((Date.now() - new Date(ts + 'Z').getTime()) / 1000)
  if (diff < 60)   return `${diff}s ago`
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  return `${Math.floor(diff / 86400)} days ago`
}

function ActivityFeed({ name }) {
  const { data: activity, isLoading } = useQuery({
    queryKey: ['activity', name],
    queryFn: () => fetchActivity(name),
    refetchInterval: 15_000,
  })

  const items = activity || []

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
      <h2 className="text-sm font-semibold text-gray-300 mb-4 flex items-center gap-2">
        <span className="text-xs">○</span> Recent activity
      </h2>

      {isLoading && <p className="text-sm text-gray-500">Loading…</p>}

      {!isLoading && items.length === 0 && (
        <p className="text-sm text-gray-500">No activity yet — actions you run will appear here.</p>
      )}

      <div className="space-y-0 divide-y divide-gray-800">
        {items.map((item, i) => {
          const c = CMD_COLOR[item.command] || CMD_COLOR.default
          const label = item.env ? `${item.command} for ${item.env}` : item.command
          return (
            <div key={i} className="flex items-center gap-3 py-3">
              <div className={`w-7 h-7 rounded-full ${c.bg} flex items-center justify-center shrink-0`}>
                <span className={`w-2 h-2 rounded-full ${c.dot}`} />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm text-gray-200">
                  {item.command === 'env-update'
                    ? `Env vars updated for ${item.env}`
                    : `${capitalize(item.command)} ${item.env ? `for <strong>${item.env}</strong>` : ''}`}
                </p>
              </div>
              <span className="text-xs text-gray-500 shrink-0">{timeAgo(item.created_at)}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function capitalize(s) {
  return s ? s[0].toUpperCase() + s.slice(1) : ''
}

// ── Env vars editor (modal) ───────────────────────────────────────────────────

function EnvVarsModal({ name, env, onClose }) {
  const qc = useQueryClient()
  const { data: vars, isLoading } = useQuery({
    queryKey: ['envvars', name, env],
    queryFn: () => fetchEnvVars(name, env),
  })
  const [edits, setEdits] = useState({})
  const [newKey, setNewKey] = useState('')
  const [newVal, setNewVal] = useState('')

  const mutation = useMutation({
    mutationFn: (updates) => updateEnvVars(name, env, updates),
    onSuccess: () => { setEdits({}); setNewKey(''); setNewVal(''); qc.invalidateQueries({ queryKey: ['envvars', name, env] }) },
  })

  function handleSave() {
    const updates = { ...edits }
    if (newKey.trim()) updates[newKey.trim()] = newVal
    mutation.mutate(updates)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-gray-900 border border-gray-800 rounded-xl w-full max-w-lg mx-4 p-6" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-semibold text-white">Env vars — {env}</h3>
          <button onClick={onClose} className="text-gray-500 hover:text-white text-xl">×</button>
        </div>
        <p className="text-xs text-gray-500 mb-4">Values are write-only. Leave blank to keep the existing value.</p>

        {isLoading ? <p className="text-gray-500 text-sm">Loading…</p> : (
          <div className="space-y-2 mb-4 max-h-72 overflow-y-auto">
            {Object.keys(vars || {}).map(k => (
              <div key={k} className="flex items-center gap-2">
                <span className="font-mono text-sm text-gray-300 w-44 shrink-0 truncate">{k}</span>
                <input
                  type="password" placeholder="••••••••"
                  onChange={e => setEdits(p => ({ ...p, [k]: e.target.value }))}
                  className="flex-1 px-2 py-1 bg-gray-800 border border-gray-700 rounded text-sm text-white font-mono focus:outline-none focus:border-brand-500"
                />
              </div>
            ))}
          </div>
        )}

        <div className="flex gap-2 mb-4 pt-3 border-t border-gray-800">
          <input type="text" placeholder="NEW_KEY" value={newKey} onChange={e => setNewKey(e.target.value)}
            className="w-44 px-2 py-1 bg-gray-800 border border-gray-700 rounded text-sm text-white font-mono focus:outline-none focus:border-brand-500" />
          <input type="text" placeholder="value" value={newVal} onChange={e => setNewVal(e.target.value)}
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
  const [logDrawer, setLogDrawer]       = useState(null)
  const [configModal, setConfigModal]   = useState(null) // {env}
  const [composeModal, setComposeModal] = useState(null) // {env}

  const { data: ws, isLoading, error } = useQuery({
    queryKey: ['workspace', name],
    queryFn: () => fetchWorkspace(name),
  })

  function runAction(cmd, env) {
    const socket = openActionSocket(name, cmd, env)
    setLogDrawer({ ws: socket, command: `${cmd} ${env}` })
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
            </div>
            <p className="text-sm text-gray-400 mt-1">
              {stackParts.join(' · ')}
              {vStr && <span className="ml-2 font-mono text-gray-500 text-xs">{vStr}</span>}
            </p>
          </div>

          {/* Global actions */}
          <div className="flex items-center gap-2 flex-wrap justify-end">
            <HeaderBtn label="Backup"         onClick={() => runAction('backup', envs[0])} />
            <HeaderBtn label="Env Vars"       onClick={() => setConfigModal({ env: envs[0] })} />
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
            />
          ))}
        </div>

        {/* Release pipeline (custom stacks only) */}
        {type !== 'image' && <ReleasePipeline ws={ws} />}

        {/* Activity feed */}
        <ActivityFeed name={name} />
      </div>

      {/* Modals / drawers */}
      {configModal && (
        <EnvVarsModal name={name} env={configModal.env} onClose={() => setConfigModal(null)} />
      )}
      {composeModal && (
        <ComposeEditor name={name} env={composeModal.env} onClose={() => setComposeModal(null)} />
      )}
      {logDrawer && (
        <LogDrawer ws={logDrawer.ws} title={logDrawer.command} onClose={() => setLogDrawer(null)} />
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
