import { useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { fetchWorkspace, fetchEnvVars, updateEnvVars, openActionSocket } from '../lib/api'
import Layout from '../components/Layout'
import LogDrawer from '../components/LogDrawer'

const ACTIONS = [
  { cmd: 'start',   label: 'Start',   color: 'bg-green-700 hover:bg-green-600' },
  { cmd: 'stop',    label: 'Stop',    color: 'bg-red-800 hover:bg-red-700' },
  { cmd: 'restart', label: 'Restart', color: 'bg-amber-700 hover:bg-amber-600' },
  { cmd: 'refresh', label: 'Refresh', color: 'bg-brand-700 hover:bg-brand-600' },
  { cmd: 'backup',  label: 'Backup',  color: 'bg-gray-700 hover:bg-gray-600' },
  { cmd: 'ps',      label: 'Status',  color: 'bg-gray-700 hover:bg-gray-600' },
]

function ActionButton({ cmd, label, color, onClick }) {
  return (
    <button
      onClick={() => onClick(cmd)}
      className={`${color} text-white text-sm font-medium px-3 py-1.5 rounded-lg transition-colors`}
    >
      {label}
    </button>
  )
}

function EnvVarsEditor({ name, env }) {
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
    onSuccess: () => {
      setEdits({})
      setNewKey('')
      setNewVal('')
      qc.invalidateQueries({ queryKey: ['envvars', name, env] })
    },
  })

  function handleSave() {
    const updates = { ...edits }
    if (newKey.trim()) updates[newKey.trim()] = newVal
    mutation.mutate(updates)
  }

  if (isLoading) return <p className="text-gray-500 text-sm">Loading…</p>

  return (
    <div>
      <div className="space-y-2 mb-4">
        {Object.entries(vars || {}).map(([k, v]) => (
          <div key={k} className="flex items-center gap-2">
            <span className="font-mono text-sm text-gray-300 w-48 shrink-0">{k}</span>
            <input
              type="password"
              defaultValue={edits[k] ?? ''}
              placeholder={v /* shows •••••••• */}
              onChange={e => setEdits(prev => ({ ...prev, [k]: e.target.value }))}
              className="flex-1 px-2 py-1 bg-gray-800 border border-gray-700 rounded text-sm text-white font-mono focus:outline-none focus:border-brand-500"
            />
          </div>
        ))}
      </div>

      {/* Add new key */}
      <div className="flex items-center gap-2 mb-4 pt-3 border-t border-gray-800">
        <input
          type="text" placeholder="NEW_KEY" value={newKey} onChange={e => setNewKey(e.target.value)}
          className="w-48 px-2 py-1 bg-gray-800 border border-gray-700 rounded text-sm text-white font-mono focus:outline-none focus:border-brand-500"
        />
        <input
          type="text" placeholder="value" value={newVal} onChange={e => setNewVal(e.target.value)}
          className="flex-1 px-2 py-1 bg-gray-800 border border-gray-700 rounded text-sm text-white font-mono focus:outline-none focus:border-brand-500"
        />
      </div>

      <button
        onClick={handleSave}
        disabled={mutation.isPending}
        className="bg-brand-600 hover:bg-brand-700 disabled:opacity-50 text-white text-sm font-medium px-4 py-1.5 rounded-lg transition-colors"
      >
        {mutation.isPending ? 'Saving…' : 'Save changes'}
      </button>
      {mutation.isSuccess && (
        <span className="ml-3 text-green-400 text-sm">Saved ✓</span>
      )}
      {mutation.isError && (
        <span className="ml-3 text-red-400 text-sm">Save failed</span>
      )}
    </div>
  )
}

export default function WorkspacePage() {
  const { name } = useParams()
  const [activeEnv, setActiveEnv] = useState(null)
  const [activeTab, setActiveTab] = useState('overview') // overview | envvars
  const [logDrawer, setLogDrawer] = useState(null) // { ws, command }

  const { data: workspace, isLoading, error } = useQuery({
    queryKey: ['workspace', name],
    queryFn: () => fetchWorkspace(name),
  })

  function runAction(cmd) {
    const env = activeEnv || envNames[0]
    const ws = openActionSocket(name, cmd, env)
    setLogDrawer({ ws, command: `${cmd} ${env}` })
  }

  if (isLoading) return (
    <Layout>
      <p className="text-gray-500 text-sm">Loading…</p>
    </Layout>
  )

  if (error) return (
    <Layout>
      <div className="text-red-400">Failed to load workspace: {error.message}</div>
    </Layout>
  )

  const envNames = workspace.envs || []
  const selectedEnv = activeEnv || envNames[0]
  const cfg = workspace.config
  const type = cfg?.project?.type || 'custom'

  return (
    <Layout>
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-sm text-gray-500 mb-6">
        <Link to="/" className="hover:text-gray-300 transition-colors">Workspaces</Link>
        <span>/</span>
        <span className="text-white font-medium">{name}</span>
      </div>

      {/* Header */}
      <div className="flex items-start justify-between mb-6">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold text-white">{name}</h1>
            <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${
              type === 'image' ? 'bg-blue-950 text-blue-300' : 'bg-purple-950 text-purple-300'
            }`}>{type}</span>
          </div>
          <p className="text-gray-400 text-sm mt-1">{cfg?.project?.registry}</p>
        </div>
        <span className="text-gray-500 text-sm">
          v{cfg?.project?.version?.major}.{cfg?.project?.version?.minor}.{cfg?.project?.version?.patch}
        </span>
      </div>

      {/* Environment tabs */}
      <div className="flex gap-1 mb-6 bg-gray-900 border border-gray-800 rounded-lg p-1 w-fit">
        {envNames.map(env => (
          <button
            key={env}
            onClick={() => setActiveEnv(env)}
            className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors ${
              env === selectedEnv
                ? 'bg-gray-700 text-white'
                : 'text-gray-400 hover:text-gray-200'
            }`}
          >
            {env}
          </button>
        ))}
      </div>

      {/* Actions */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 mb-5">
        <h2 className="text-sm font-semibold text-gray-300 mb-3">Actions — {selectedEnv}</h2>
        <div className="flex flex-wrap gap-2">
          {ACTIONS.map(a => (
            <ActionButton key={a.cmd} {...a} onClick={runAction} />
          ))}
        </div>
      </div>

      {/* Tabs: Overview | Env Vars */}
      <div className="flex gap-1 border-b border-gray-800 mb-5">
        {['overview', 'envvars'].map(tab => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              activeTab === tab
                ? 'border-brand-500 text-white'
                : 'border-transparent text-gray-500 hover:text-gray-300'
            }`}
          >
            {tab === 'overview' ? 'Overview' : 'Env Vars'}
          </button>
        ))}
      </div>

      {activeTab === 'overview' && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          <InfoCard label="Project type" value={type} />
          <InfoCard label="Deployment" value={cfg?.environments?.[selectedEnv]?.deployment || '—'} />
          <InfoCard label="Domain" value={cfg?.environments?.[selectedEnv]?.domain || '—'} />
          <InfoCard label="Traefik" value={cfg?.environments?.[selectedEnv]?.traefik_enabled ? 'Enabled' : 'Disabled'} />
          {type !== 'image' && <>
            <InfoCard label="Backend" value={cfg?.environments?.[selectedEnv]?.backend || '—'} />
            <InfoCard label="Database" value={cfg?.environments?.[selectedEnv]?.database || '—'} />
          </>}
        </div>
      )}

      {activeTab === 'envvars' && selectedEnv && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
          <p className="text-xs text-gray-500 mb-4">
            Values are write-only — existing values shown masked. Leave a field blank to keep its current value.
          </p>
          <EnvVarsEditor name={name} env={selectedEnv} />
        </div>
      )}

      {/* Log drawer */}
      {logDrawer && (
        <LogDrawer
          ws={logDrawer.ws}
          title={logDrawer.command}
          onClose={() => setLogDrawer(null)}
        />
      )}
    </Layout>
  )
}

function InfoCard({ label, value }) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
      <p className="text-xs text-gray-500 mb-1">{label}</p>
      <p className="text-sm font-medium text-white">{value}</p>
    </div>
  )
}
