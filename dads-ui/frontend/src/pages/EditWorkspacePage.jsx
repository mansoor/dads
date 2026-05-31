import { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { fetchConfig, putConfig } from '../lib/api'
import Layout from '../components/Layout'

// ── Shared primitives ─────────────────────────────────────────────────────────

function Label({ children, required }) {
  return (
    <label className="block text-xs font-semibold text-gray-400 uppercase tracking-wider mb-1">
      {children}{required && <span className="text-red-400 ml-0.5">*</span>}
    </label>
  )
}

function Input({ value, onChange, placeholder, type = 'text', ...rest }) {
  return (
    <input
      type={type} value={value ?? ''} onChange={e => onChange(e.target.value)}
      placeholder={placeholder}
      className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm placeholder-gray-500 focus:outline-none focus:border-brand-500 transition-colors"
      {...rest}
    />
  )
}

function Toggle({ label, hint, checked, onChange }) {
  return (
    <div className="flex items-center justify-between">
      <div>
        <p className="text-sm text-gray-200">{label}</p>
        {hint && <p className="text-xs text-gray-500 mt-0.5">{hint}</p>}
      </div>
      <button
        type="button" onClick={() => onChange(!checked)}
        className={`relative w-10 h-5 rounded-full transition-colors shrink-0 ${checked ? 'bg-brand-600' : 'bg-gray-700'}`}
      >
        <span className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${checked ? 'translate-x-5' : ''}`} />
      </button>
    </div>
  )
}

function Select({ value, onChange, options }) {
  return (
    <select value={value ?? ''} onChange={e => onChange(e.target.value)}
      className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:border-brand-500">
      {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  )
}

const DEPLOYMENT_OPTIONS = [{ value: 'compose', label: 'Docker Compose' }, { value: 'swarm', label: 'Docker Swarm' }]
const BACKEND_OPTIONS    = [{ value: 'laravel', label: 'Laravel (PHP-FPM)' }, { value: 'nodejs', label: 'Node.js' }]
const FRONTEND_OPTIONS   = [{ value: 'none', label: 'None (API only)' }, { value: 'nextjs', label: 'Next.js' }, { value: 'react', label: 'React / Vite' }]
const DB_OPTIONS         = [{ value: 'none', label: 'None' }, { value: 'postgres', label: 'PostgreSQL' }, { value: 'mysql', label: 'MySQL' }]

// ── Image stack editor ────────────────────────────────────────────────────────

function ImagesEditor({ images, onChange }) {
  function update(idx, field, val) {
    onChange(images.map((img, i) => i === idx ? { ...img, [field]: val } : img))
  }
  function add() {
    onChange([...images, { name: '', image: '', tag: 'latest', port: 0, host_port: '', volumes: [], depends_on: [], extra_ports: [] }])
  }
  function remove(idx) {
    onChange(images.filter((_, i) => i !== idx))
  }

  return (
    <div className="space-y-3">
      {images.map((img, i) => (
        <div key={i} className="bg-gray-800/50 border border-gray-700 rounded-xl p-4 space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Service {i + 1}</p>
            {images.length > 1 && (
              <button type="button" onClick={() => remove(i)} className="text-xs text-red-400 hover:text-red-300 transition-colors">Remove</button>
            )}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label required>Service name</Label>
              <Input value={img.name} onChange={v => update(i, 'name', v)} placeholder="app" />
            </div>
            <div>
              <Label required>Image</Label>
              <Input value={img.image} onChange={v => update(i, 'image', v)} placeholder="nginx" />
            </div>
            <div>
              <Label>Tag</Label>
              <Input value={img.tag} onChange={v => update(i, 'tag', v)} placeholder="latest" />
            </div>
            <div>
              <Label>Container port</Label>
              <Input type="number" value={img.port || ''} onChange={v => update(i, 'port', parseInt(v) || 0)} placeholder="80" />
            </div>
            <div className="col-span-2">
              <Label>Host port</Label>
              <Input value={img.host_port} onChange={v => update(i, 'host_port', v)} placeholder="8080" />
            </div>
          </div>
          {/* Volumes — simple comma-separated for now */}
          <div>
            <Label>Volumes <span className="normal-case font-normal text-gray-500">(one per line: vol:/path)</span></Label>
            <textarea
              value={(img.volumes || []).join('\n')}
              onChange={e => update(i, 'volumes', e.target.value.split('\n').map(s => s.trim()).filter(Boolean))}
              rows={2}
              placeholder="data:/var/lib/data"
              className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm font-mono placeholder-gray-500 focus:outline-none focus:border-brand-500 resize-none"
            />
          </div>
        </div>
      ))}
      <button
        type="button" onClick={add}
        className="w-full py-2 border border-dashed border-gray-700 text-gray-400 hover:text-gray-200 hover:border-gray-500 rounded-xl text-sm transition-colors"
      >
        + Add service
      </button>
    </div>
  )
}

// ── Environment editor ────────────────────────────────────────────────────────

function EnvEditor({ envName, cfg, onChange, onRename, onRemove, isNew, projectType }) {
  const upd = (k, v) => onChange({ ...cfg, [k]: v })
  const updGit = (k, v) => onChange({ ...cfg, git: { ...(cfg.git || {}), [k]: v } })
  const updReplicas = (k, v) => onChange({ ...cfg, replicas: { ...(cfg.replicas || {}), [k]: parseInt(v) || 1 } })

  return (
    <div className="bg-gray-800/50 border border-gray-700 rounded-xl p-5 space-y-4">
      {/* Env name + remove */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3 flex-1">
          <div className="w-2 h-2 rounded-full bg-gray-500 shrink-0" />
          <input
            value={envName}
            onChange={e => onRename(e.target.value)}
            placeholder="prod"
            className="bg-transparent text-white font-semibold text-base border-b border-transparent focus:border-brand-500 focus:outline-none px-0 py-0.5 w-32"
          />
          {isNew && <span className="text-xs text-brand-400 bg-brand-950 px-2 py-0.5 rounded-full">new</span>}
        </div>
        <button type="button" onClick={onRemove} className="text-xs text-red-400 hover:text-red-300 transition-colors">Remove</button>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <Label>Domain</Label>
          <Input value={cfg.domain} onChange={v => upd('domain', v)} placeholder="example.com" />
        </div>
        <div>
          <Label>Deployment</Label>
          <Select value={cfg.deployment} onChange={v => upd('deployment', v)} options={DEPLOYMENT_OPTIONS} />
        </div>
        <div>
          <Label>HTTP port</Label>
          <Input type="number" value={cfg.http_port} onChange={v => upd('http_port', parseInt(v) || 80)} />
        </div>
        <div>
          <Label>HTTPS port</Label>
          <Input type="number" value={cfg.https_port} onChange={v => upd('https_port', parseInt(v) || 443)} />
        </div>
      </div>

      <div className="space-y-3 pt-3 border-t border-gray-700/50">
        <Toggle
          label="Traefik reverse proxy"
          hint="Route via Traefik instead of direct port binding"
          checked={!!cfg.traefik_enabled}
          onChange={v => upd('traefik_enabled', v)}
        />
        {cfg.traefik_enabled && (
          <div>
            <Label>Traefik network</Label>
            <Input value={cfg.traefik_network} onChange={v => upd('traefik_network', v)} placeholder="traefik_net" />
          </div>
        )}
      </div>

      {/* Custom-stack-only fields */}
      {projectType === 'custom' && (
        <div className="space-y-4 pt-3 border-t border-gray-700/50">
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Application stack</p>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <Label>Backend</Label>
              <Select value={cfg.backend} onChange={v => upd('backend', v)} options={BACKEND_OPTIONS} />
            </div>
            <div>
              <Label>Frontend</Label>
              <Select value={cfg.frontend} onChange={v => upd('frontend', v)} options={FRONTEND_OPTIONS} />
            </div>
            <div>
              <Label>Database</Label>
              <Select value={cfg.database} onChange={v => upd('database', v)} options={DB_OPTIONS} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Toggle label="Redis" checked={!!cfg.redis_enabled} onChange={v => upd('redis_enabled', v)} />
            <Toggle label="Garage S3" checked={!!cfg.garage_enabled} onChange={v => upd('garage_enabled', v)} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Backend replicas</Label>
              <Input type="number" value={cfg.replicas?.backend ?? 1} onChange={v => updReplicas('backend', v)} />
            </div>
            <div>
              <Label>Frontend replicas</Label>
              <Input type="number" value={cfg.replicas?.frontend ?? 1} onChange={v => updReplicas('frontend', v)} />
            </div>
          </div>
        </div>
      )}

      {/* Git */}
      <div className="space-y-3 pt-3 border-t border-gray-700/50">
        <Toggle
          label="Git sync"
          hint="Enable ./run.sh sync"
          checked={!!cfg.git?.enabled}
          onChange={v => updGit('enabled', v)}
        />
        {cfg.git?.enabled && (
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Repository</Label>
              <Input value={cfg.git?.repo} onChange={v => updGit('repo', v)} placeholder="git@github.com:org/repo.git" />
            </div>
            <div>
              <Label>Branch</Label>
              <Input value={cfg.git?.branch} onChange={v => updGit('branch', v)} placeholder="main" />
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function EditWorkspacePage() {
  const { name } = useParams()
  const navigate = useNavigate()
  const qc = useQueryClient()

  const { data: rawConfig, isLoading, error } = useQuery({
    queryKey: ['config', name],
    queryFn: () => fetchConfig(name),
  })

  // Local editable state
  const [envs, setEnvs]       = useState(null)
  const [project, setProject] = useState(null)
  const [images, setImages]   = useState(null)
  const [newEnvCounter, setNewEnvCounter] = useState(0)
  const [saveError, setSaveError] = useState('')

  useEffect(() => {
    if (rawConfig && envs === null) {
      setEnvs(rawConfig.environments || {})
      setProject(rawConfig.project || {})
      setImages(rawConfig.images || [])
    }
  }, [rawConfig])

  const mutation = useMutation({
    mutationFn: async () => {
      const updated = {
        ...rawConfig,
        project,
        environments: envs,
        ...(project?.type === 'image' && { images }),
      }
      await putConfig(name, JSON.stringify(updated, null, 2))
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['workspace', name] })
      qc.invalidateQueries({ queryKey: ['config', name] })
      navigate(`/workspaces/${name}`)
    },
    onError: (err) => setSaveError(err.response?.data?.error || err.message),
  })

  function updateEnv(envName, cfg) {
    setEnvs(prev => ({ ...prev, [envName]: cfg }))
  }

  function renameEnv(oldName, newName) {
    if (!newName || newName === oldName) return
    setEnvs(prev => {
      const next = {}
      for (const [k, v] of Object.entries(prev)) {
        next[k === oldName ? newName : k] = v
      }
      return next
    })
  }

  function removeEnv(envName) {
    setEnvs(prev => {
      const next = { ...prev }
      delete next[envName]
      return next
    })
  }

  function addEnv() {
    const n = `new-env-${newEnvCounter + 1}`
    setNewEnvCounter(c => c + 1)
    const isImage = project?.type === 'image'
    const firstEnv = Object.values(envs || {})[0] || {}
    const base = {
      domain: '',
      http_port: 8080,
      https_port: 8443,
      deployment: 'compose',
      traefik_enabled: false,
      traefik_network: 'traefik_net',
      git: { enabled: false, repo: '', branch: '' },
    }
    if (!isImage) {
      Object.assign(base, {
        backend: firstEnv.backend || 'laravel',
        frontend: firstEnv.frontend || 'none',
        database: firstEnv.database || 'none',
        redis_enabled: false,
        garage_enabled: false,
        replicas: { backend: 1, frontend: 1 },
      })
    }
    setEnvs(prev => ({ ...prev, [n]: base }))
  }

  const originalEnvNames = rawConfig ? Object.keys(rawConfig.environments || {}) : []
  const currentEnvNames = envs ? Object.keys(envs) : []

  if (isLoading) return <Layout><div className="p-8 text-gray-500 text-sm">Loading…</div></Layout>
  if (error)     return <Layout><div className="p-8 text-red-400 text-sm">{error.message}</div></Layout>

  return (
    <Layout>
      <div className="p-6 max-w-3xl">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-xl font-bold text-white">Edit workspace</h1>
            <p className="text-sm text-gray-400 mt-0.5">{name}</p>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={() => navigate(`/workspaces/${name}`)}
              className="text-sm text-gray-400 hover:text-white transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={() => { setSaveError(''); mutation.mutate() }}
              disabled={mutation.isPending}
              className="bg-brand-600 hover:bg-brand-700 disabled:opacity-50 text-white text-sm font-semibold px-5 py-2 rounded-lg transition-colors"
            >
              {mutation.isPending ? 'Saving…' : 'Save changes'}
            </button>
          </div>
        </div>

        {saveError && (
          <div className="mb-5 px-4 py-3 bg-red-950 border border-red-800 text-red-300 rounded-lg text-sm">{saveError}</div>
        )}

        {/* Project settings */}
        <section className="mb-6">
          <h2 className="text-sm font-semibold text-gray-300 mb-3">Project</h2>
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 grid grid-cols-2 gap-4">
            <div>
              <Label>Project name</Label>
              <Input value={project?.name} onChange={v => setProject(p => ({ ...p, name: v }))} />
            </div>
            <div>
              <Label>Registry</Label>
              <Input value={project?.registry} onChange={v => setProject(p => ({ ...p, registry: v }))} />
            </div>
          </div>
        </section>

        {/* Images (image stacks only) */}
        {project?.type === 'image' && (
          <section className="mb-6">
            <h2 className="text-sm font-semibold text-gray-300 mb-3">Services</h2>
            <ImagesEditor images={images || []} onChange={setImages} />
            <p className="text-xs text-gray-500 mt-2">After saving, redeploy each environment to pick up image changes.</p>
          </section>
        )}

        {/* Environments */}
        <section className="mb-6">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-gray-300">Environments</h2>
            <p className="text-xs text-gray-500">
              {currentEnvNames.length} environment{currentEnvNames.length !== 1 ? 's' : ''}
              {currentEnvNames.some(e => !originalEnvNames.includes(e)) && (
                <span className="ml-2 text-brand-400">· new environments will need bootstrapping after save</span>
              )}
            </p>
          </div>

          <div className="space-y-4">
            {Object.entries(envs || {}).map(([envName, cfg]) => (
              <EnvEditor
                key={envName}
                envName={envName}
                cfg={cfg}
                onChange={(updated) => updateEnv(envName, updated)}
                onRename={(newName) => renameEnv(envName, newName)}
                onRemove={() => removeEnv(envName)}
                isNew={!originalEnvNames.includes(envName)}
                projectType={project?.type || 'custom'}
              />
            ))}
          </div>

          <button
            type="button" onClick={addEnv}
            className="mt-4 w-full py-2.5 border border-dashed border-gray-700 text-gray-400 hover:text-gray-200 hover:border-gray-500 rounded-xl text-sm transition-colors"
          >
            + Add environment
          </button>
        </section>

        {/* After-save hint for new envs */}
        {currentEnvNames.some(e => !originalEnvNames.includes(e)) && (
          <div className="bg-amber-950/40 border border-amber-800/50 rounded-xl px-4 py-3 text-sm text-amber-300">
            After saving, go to the workspace and click <strong>Init</strong> for each new environment to generate its compose file and .env.
          </div>
        )}
      </div>
    </Layout>
  )
}
