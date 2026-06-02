import { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { fetchConfig, putConfig, deleteWorkspace, fetchEnvVars, updateEnvVars } from '../lib/api'
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

function Toggle({ label, hint, checked, onChange, disabled = false }) {
  return (
    <div className={`flex items-center justify-between ${disabled ? 'opacity-50' : ''}`}>
      <div>
        <p className="text-sm text-gray-200">{label}</p>
        {hint && <p className="text-xs text-gray-500 mt-0.5">{hint}</p>}
      </div>
      <button
        type="button"
        onClick={() => !disabled && onChange(!checked)}
        disabled={disabled}
        className={`relative w-10 h-5 rounded-full transition-colors shrink-0 disabled:cursor-not-allowed ${
          checked && !disabled ? 'bg-brand-600' : checked ? 'bg-brand-800' : 'bg-gray-700'
        }`}
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

// ── Helpers: port rows ↔ img fields ──────────────────────────────────────────

function imgToPortRows(img) {
  const rows = []
  if (img.host_port || img.port)
    rows.push({ host: String(img.host_port || ''), container: String(img.port || '') })
  for (const ep of (img.extra_ports || [])) {
    const p = ep.split(':')
    rows.push(p.length === 2 ? { host: p[0], container: p[1] } : { host: '', container: p[0] })
  }
  return rows.length ? rows : [{ host: '', container: '' }]
}

function portRowsToFields(rows) {
  // Only rows with a container port contribute to config
  const valid = rows.filter(r => r.container.trim())
  if (!valid.length) return { port: 0, host_port: '', extra_ports: [] }
  const [first, ...rest] = valid
  return {
    port:        parseInt(first.container) || 0,
    host_port:   first.host.trim(),
    extra_ports: rest.map(r =>
      r.host.trim() ? `${r.host.trim()}:${r.container.trim()}` : r.container.trim()),
  }
}

// ── Helpers: volume rows ↔ volumes array ──────────────────────────────────────

function imgToVolumeRows(img) {
  const vols = img.volumes || []
  if (!vols.length) return [{ source: '', path: '' }]
  return vols.map(v => {
    const c = v.indexOf(':')
    return c === -1 ? { source: v, path: '' } : { source: v.slice(0, c), path: v.slice(c + 1) }
  })
}

function volumeRowsToArray(rows) {
  return rows
    .filter(r => r.source.trim() || r.path.trim())
    .map(r => (r.source.trim() && r.path.trim())
      ? `${r.source.trim()}:${r.path.trim()}`
      : r.source.trim() || r.path.trim())
}

// ── Image stack editor ────────────────────────────────────────────────────────

const RESTART_OPTIONS = [
  { value: 'unless-stopped', label: 'Unless stopped (recommended)' },
  { value: 'always',         label: 'Always' },
  { value: 'on-failure',     label: 'On failure' },
  { value: 'no',             label: 'No (never restart)' },
]

// ServiceCard keeps local row state so empty rows added by + buttons survive
// until the user types into them. Without local state, portRowsToFields() would
// immediately filter out the empty new row and Add would appear broken.
function ServiceCard({ img, idx, allImages, onUpdate, onRemove }) {
  const [portRows,   setPortRows]   = useState(() => imgToPortRows(img))
  const [volumeRows, setVolumeRows] = useState(() => imgToVolumeRows(img))

  function syncPorts(rows) {
    setPortRows(rows)
    onUpdate(idx, { ...img, ...portRowsToFields(rows) })
  }
  function syncVolumes(rows) {
    setVolumeRows(rows)
    onUpdate(idx, { ...img, volumes: volumeRowsToArray(rows) })
  }
  function upd(field, val) {
    onUpdate(idx, { ...img, [field]: val })
  }

  const otherNames = allImages.map((m, j) => j !== idx ? m.name : null).filter(Boolean)

  const monoInput = 'px-2 py-1.5 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm font-mono focus:outline-none focus:border-brand-500'

  return (
    <div className="bg-gray-800/50 border border-gray-700 rounded-xl p-4 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Service {idx + 1}</p>
        {allImages.length > 1 && (
          <button type="button" onClick={() => onRemove(idx)} className="text-xs text-red-400 hover:text-red-300 transition-colors">Remove</button>
        )}
      </div>

      {/* Identity */}
      <div className="grid grid-cols-3 gap-3">
        <div><Label required>Service name</Label>
          <Input value={img.name} onChange={v => upd('name', v)} placeholder="app" /></div>
        <div><Label required>Image</Label>
          <Input value={img.image} onChange={v => upd('image', v)} placeholder="nginx" /></div>
        <div><Label>Tag</Label>
          <Input value={img.tag} onChange={v => upd('tag', v)} placeholder="latest" /></div>
      </div>

      {/* Port mappings */}
      <div>
        <Label>Port mappings</Label>
        <p className="text-xs text-gray-500 mb-2">
          <code className="font-mono text-xs">HOST PORT</code> : <code className="font-mono text-xs">CONTAINER PORT</code> — leave host blank to expose internally only.
        </p>
        <div className="space-y-1.5">
          {portRows.map((row, ri) => (
            <div key={ri} className="flex items-center gap-2">
              <input type="text" value={row.host}
                onChange={e => { const r = portRows.map((x,j)=>j===ri?{...x,host:e.target.value}:x); syncPorts(r) }}
                placeholder="8080" className={`flex-1 ${monoInput}`} />
              <span className="text-gray-500 font-bold shrink-0">:</span>
              <input type="text" value={row.container}
                onChange={e => { const r = portRows.map((x,j)=>j===ri?{...x,container:e.target.value}:x); syncPorts(r) }}
                placeholder="80" className={`flex-1 ${monoInput}`} />
              <span className="text-xs text-gray-500 w-32 shrink-0 hidden sm:block">
                {ri === 0 ? 'primary (Traefik)' : ''}
              </span>
              {portRows.length > 1 && (
                <button type="button" onClick={() => syncPorts(portRows.filter((_,j)=>j!==ri))}
                  className="text-gray-600 hover:text-red-400 text-sm shrink-0">×</button>
              )}
            </div>
          ))}
          <button type="button" onClick={() => setPortRows(r => [...r, { host: '', container: '' }])}
            className="text-xs text-brand-400 hover:text-brand-300 transition-colors flex items-center gap-1 mt-1">
            <span className="text-base leading-none">＋</span> Add port mapping
          </button>
        </div>
      </div>

      {/* Volume mappings */}
      <div>
        <Label>Volume mappings</Label>
        <p className="text-xs text-gray-500 mb-2">
          <code className="font-mono text-xs">SOURCE</code> : <code className="font-mono text-xs">CONTAINER PATH</code> —
          use <code className="font-mono text-xs">./volumes/name</code> for a bind mount scoped to this env, or a plain name for a Docker named volume.
        </p>
        <div className="space-y-1.5">
          {volumeRows.map((row, ri) => {
            const isBind = row.source.startsWith('./') || row.source.startsWith('/')
            return (
              <div key={ri} className="flex items-center gap-2">
                <span className={`text-xs px-1.5 py-0.5 rounded font-medium shrink-0 ${
                  isBind ? 'bg-blue-950 text-blue-300' : 'bg-purple-950 text-purple-300'
                }`}>{isBind ? 'bind' : 'named'}</span>
                <input type="text" value={row.source}
                  onChange={e => { const r = volumeRows.map((x,j)=>j===ri?{...x,source:e.target.value}:x); syncVolumes(r) }}
                  placeholder="./volumes/app_data" className={`flex-1 ${monoInput}`} />
                <span className="text-gray-500 font-bold shrink-0">:</span>
                <input type="text" value={row.path}
                  onChange={e => { const r = volumeRows.map((x,j)=>j===ri?{...x,path:e.target.value}:x); syncVolumes(r) }}
                  placeholder="/var/lib/data" className={`flex-1 ${monoInput}`} />
                <button type="button" onClick={() => syncVolumes(volumeRows.filter((_,j)=>j!==ri))}
                  className="text-gray-600 hover:text-red-400 text-sm shrink-0">×</button>
              </div>
            )
          })}
          <button type="button" onClick={() => setVolumeRows(r => [...r, { source: './volumes/', path: '' }])}
            className="text-xs text-brand-400 hover:text-brand-300 transition-colors flex items-center gap-1 mt-1">
            <span className="text-base leading-none">＋</span> Add volume
          </button>
        </div>
      </div>

      {/* Restart policy — half width */}
      <div className="w-1/2">
        <Label>Restart policy</Label>
        <Select value={img.restart || 'unless-stopped'} onChange={v => upd('restart', v)} options={RESTART_OPTIONS} />
      </div>

      {/* Healthcheck */}
      <div className="space-y-3">
        <div>
          <Label>Healthcheck command</Label>
          <p className="text-xs text-gray-500 mb-2">
            Shell command Docker runs to test container health. Leave blank to disable.
            Example: <code className="font-mono text-xs">curl -sf http://localhost/health || exit 1</code>
          </p>
          <input
            type="text"
            value={img.healthcheck || ''}
            onChange={e => upd('healthcheck', e.target.value)}
            placeholder="curl -sf http://localhost/health || exit 1"
            className="w-full px-2 py-1.5 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm font-mono placeholder-gray-600 focus:outline-none focus:border-brand-500"
          />
        </div>
        {/* Time parameters — only shown when a command is set */}
        {img.healthcheck && (
          <div>
            <p className="text-xs text-gray-500 mb-2">
              Timing parameters — enter seconds only (numbers). <code className="font-mono text-xs">start_interval</code> requires Docker Engine 25+.
            </p>
            <div className="grid grid-cols-5 gap-2">
              {[
                { key: 'interval',       label: 'Interval',        placeholder: '30' },
                { key: 'timeout',        label: 'Timeout',         placeholder: '10' },
                { key: 'retries',        label: 'Retries',         placeholder: '3',  noSuffix: true },
                { key: 'start_period',   label: 'Start period',    placeholder: '30' },
                { key: 'start_interval', label: 'Start interval',  placeholder: '5'  },
              ].map(({ key, label, placeholder, noSuffix }) => {
                const raw = (img.healthcheck_config || {})[key] || ''
                // Strip trailing 's' for display; store with 's' (except retries)
                const display = raw.replace(/s$/, '')
                return (
                  <div key={key}>
                    <label className="block text-xs text-gray-500 mb-1">
                      {label}{!noSuffix && <span className="text-gray-600"> (s)</span>}
                    </label>
                    <input
                      type="number"
                      min="1"
                      value={display}
                      placeholder={placeholder}
                      onChange={e => {
                        const v = e.target.value.replace(/[^0-9]/g, '')
                        const stored = v ? (noSuffix ? v : `${v}s`) : ''
                        upd('healthcheck_config', {
                          ...(img.healthcheck_config || {}),
                          [key]: stored,
                        })
                      }}
                      className="w-full px-2 py-1.5 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm font-mono focus:outline-none focus:border-brand-500"
                    />
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </div>

      {/* depends_on */}
      {otherNames.length > 0 && (
        <div>
          <Label>Depends on</Label>
          <p className="text-xs text-gray-500 mb-2">
            This service waits for selected services before starting.
            Compose waits for healthy status if the dependency has a healthcheck.
          </p>
          <div className="flex flex-wrap gap-3">
            {otherNames.map(svcName => {
              const checked = (img.depends_on || []).includes(svcName)
              return (
                <label key={svcName} className="flex items-center gap-1.5 cursor-pointer select-none">
                  <input type="checkbox" checked={checked}
                    onChange={e => {
                      const deps = img.depends_on || []
                      upd('depends_on', e.target.checked
                        ? [...deps, svcName]
                        : deps.filter(d => d !== svcName))
                    }}
                    className="rounded border-gray-600 bg-gray-700 text-brand-500 focus:ring-brand-500"
                  />
                  <span className="text-sm text-gray-300 font-mono">{svcName}</span>
                </label>
              )
            })}
          </div>
        </div>
      )}

      {/* Advanced — extra_compose YAML */}
      <details className="group">
        <summary className="text-xs text-gray-500 cursor-pointer hover:text-gray-300 transition-colors select-none list-none flex items-center gap-1">
          <span className="group-open:rotate-90 transition-transform inline-block">▶</span>
          Advanced YAML overrides
        </summary>
        <div className="mt-2 space-y-1">
          <p className="text-xs text-gray-500">
            Raw YAML appended to this service in the generated compose file.
            Use for: <code className="font-mono text-xs">mem_limit</code>,{' '}
            <code className="font-mono text-xs">cpus</code>,{' '}
            <code className="font-mono text-xs">logging</code>,{' '}
            <code className="font-mono text-xs">command</code>, etc.
            Run <strong>Refresh</strong> after saving to apply.
          </p>
          <textarea
            value={img.extra_compose || ''}
            onChange={e => upd('extra_compose', e.target.value)}
            rows={4}
            placeholder={"mem_limit: 512m\ncpus: '0.5'\nlogging:\n  driver: json-file"}
            spellCheck={false}
            className="w-full px-3 py-2 bg-gray-950 border border-gray-700 rounded-lg text-green-300 text-xs font-mono placeholder-gray-600 focus:outline-none focus:border-brand-500 resize-y"
          />
        </div>
      </details>
    </div>
  )
}

function ImagesEditor({ images, onChange }) {
  return (
    <div className="space-y-3">
      {images.map((img, i) => (
        <ServiceCard
          key={i}
          img={img}
          idx={i}
          allImages={images}
          onUpdate={(idx, updated) => onChange(images.map((m, j) => j === idx ? updated : m))}
          onRemove={idx => onChange(images.filter((_, j) => j !== idx))}
        />
      ))}
      <button
        type="button"
        onClick={() => onChange([...images, {
          name: '', image: '', tag: 'latest', port: 0, host_port: '',
          volumes: [], depends_on: [], extra_ports: [],
          restart: 'unless-stopped', extra_compose: '',
        }])}
        className="w-full py-2 border border-dashed border-gray-700 text-gray-400 hover:text-gray-200 hover:border-gray-500 rounded-xl text-sm transition-colors"
      >
        + Add service
      </button>
    </div>
  )
}

// ── Environment editor ────────────────────────────────────────────────────────

function EnvEditor({ envName, cfg, onChange, onRename, onRemove, isNew, projectType, workspaceName, isOnlyEnv }) {
  const upd = (k, v) => onChange({ ...cfg, [k]: v })
  const updGit = (k, v) => onChange({ ...cfg, git: { ...(cfg.git || {}), [k]: v } })
  const updReplicas = (k, v) => onChange({ ...cfg, replicas: { ...(cfg.replicas || {}), [k]: parseInt(v) || 1 } })

  return (
    <div className="bg-gray-800/50 border border-gray-700 rounded-xl p-5 space-y-4">
      {/* Env name + remove */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3 flex-1">
          <div className="w-2 h-2 rounded-full bg-gray-500 shrink-0" />
          {/* defaultValue (uncontrolled) — React never updates this input's DOM value
              while the user is typing, so focus is never lost. onBlur fires rename. */}
          <input
            key={envName}
            defaultValue={envName}
            onBlur={e => { if (e.target.value !== envName) onRename(e.target.value) }}
            placeholder="prod"
            className="bg-transparent text-white font-semibold text-base border-b border-transparent focus:border-brand-500 focus:outline-none px-0 py-0.5 w-32"
          />
          {isNew && <span className="text-xs text-brand-400 bg-brand-950 px-2 py-0.5 rounded-full">new</span>}
        </div>
        <button
          type="button"
          onClick={onRemove}
          disabled={isOnlyEnv}
          title={isOnlyEnv ? 'Cannot remove the only environment' : undefined}
          className={`text-xs transition-colors ${isOnlyEnv ? 'text-gray-600 cursor-not-allowed' : 'text-red-400 hover:text-red-300'}`}
        >Remove</button>
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
          onChange={v => {
            upd('traefik_enabled', v)
            if (!v) onChange({ ...cfg, traefik_enabled: false, ssl_enabled: false })
          }}
        />
        {cfg.traefik_enabled && (
          <>
            <div>
              <Label>Traefik network</Label>
              <Input value={cfg.traefik_network} onChange={v => upd('traefik_network', v)} placeholder="traefik_net" />
            </div>

            {/* SSL toggle — enabled only when domain is set */}
            <div className={`pl-3 border-l-2 ${cfg.ssl_enabled ? 'border-green-700' : 'border-gray-700'}`}>
              <Toggle
                label="SSL certificate (Let's Encrypt)"
                hint={cfg.domain
                  ? `Traefik will request a cert for ${cfg.domain}`
                  : 'Set a domain above to enable SSL'}
                checked={!!cfg.ssl_enabled && !!cfg.domain}
                onChange={v => upd('ssl_enabled', v)}
                disabled={!cfg.domain}
              />
              {cfg.ssl_enabled && cfg.domain && (
                <p className="text-xs text-green-400/70 mt-1">
                  🔒 Run <code className="font-mono text-xs">./run.sh refresh {'{env}'}</code> after saving to regenerate the compose file with TLS labels.
                </p>
              )}
            </div>
          </>
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

      {/* Environment variables */}
      {isNew
        ? <NewEnvVarsEditor cfg={cfg} onChange={onChange} />
        : <EnvVarsInline workspaceName={workspaceName} envName={envName} />
      }
    </div>
  )
}

// ── New env vars editor — same look as EnvVarsInline for new (unsaved) envs ───
// Stores vars in cfg._initial_vars (written to .env after save).
// Matches EnvVarsInline appearance: collapsible, show/hide values toggle.
function NewEnvVarsEditor({ cfg, onChange }) {
  const vars = cfg._initial_vars || {}
  const [open, setOpen]     = useState(false)
  const [reveal, setReveal] = useState(false)
  const [newKey, setNewKey] = useState('')
  const [newVal, setNewVal] = useState('')

  function setVar(k, v) { onChange({ ...cfg, _initial_vars: { ...vars, [k]: v } }) }
  function removeVar(k) { const n = { ...vars }; delete n[k]; onChange({ ...cfg, _initial_vars: n }) }
  function addVar() {
    const k = newKey.trim(); if (!k) return
    setVar(k, newVal); setNewKey(''); setNewVal('')
  }

  const entries = Object.entries(vars)

  return (
    <div className="pt-3 border-t border-gray-700/50">
      <button type="button" onClick={() => setOpen(o => !o)}
        className="flex items-center gap-2 text-xs font-semibold text-gray-400 uppercase tracking-wider hover:text-gray-200 transition-colors w-full">
        <span className={`transition-transform ${open ? 'rotate-90' : ''}`}>▶</span>
        Environment Variables
        {entries.length > 0 && <span className="ml-1 text-brand-400 normal-case font-normal">{entries.length} inherited</span>}
        <span className="ml-auto text-gray-600 normal-case font-normal">.env file</span>
      </button>
      {open && (
        <div className="mt-3 space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-xs text-amber-400/80 flex items-center gap-1">
              <span>⚠</span> These will be written to <code className="font-mono">.env</code> on save.
            </p>
            <label className="flex items-center gap-1.5 cursor-pointer shrink-0">
              <input type="checkbox" checked={reveal} onChange={e => setReveal(e.target.checked)}
                className="w-3 h-3 accent-brand-500" />
              <span className="text-xs text-gray-400 select-none">Show values</span>
            </label>
          </div>
          <div className="space-y-1.5">
            {entries.map(([k, v]) => (
              <div key={k} className="flex items-center gap-2">
                <span className="font-mono text-xs text-gray-300 w-44 shrink-0 truncate">{k}</span>
                <input type={reveal ? 'text' : 'password'} value={v}
                  onChange={e => setVar(k, e.target.value)}
                  className="flex-1 px-2 py-1 bg-gray-800 border border-gray-700 rounded text-sm font-mono text-white focus:outline-none focus:border-brand-500" />
                <button type="button" onClick={() => removeVar(k)}
                  className="text-gray-600 hover:text-red-400 text-sm shrink-0">×</button>
              </div>
            ))}
          </div>
          <div className="flex gap-2 pt-1">
            <input type="text" placeholder="KEY" value={newKey} onChange={e => setNewKey(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && addVar()}
              className="w-44 px-2 py-1 bg-gray-800 border border-gray-700 rounded text-sm font-mono text-white focus:outline-none focus:border-brand-500" />
            <input type="text" placeholder="value" value={newVal} onChange={e => setNewVal(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && addVar()}
              className="flex-1 px-2 py-1 bg-gray-800 border border-gray-700 rounded text-sm font-mono text-white focus:outline-none focus:border-brand-500" />
            <button type="button" onClick={addVar}
              className="text-xs text-brand-400 hover:text-brand-300 shrink-0 px-2">Add</button>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Inline env vars editor (used inside EnvEditor) ────────────────────────────

function EnvVarsInline({ workspaceName, envName }) {
  const [open, setOpen]       = useState(false)
  const [reveal, setReveal]   = useState(false)
  const [edits, setEdits]     = useState({})
  const [deletes, setDeletes] = useState(new Set())
  const [newKey, setNewKey]   = useState('')
  const [newVal, setNewVal]   = useState('')
  const qc = useQueryClient()

  const { data: vars, isLoading } = useQuery({
    queryKey: ['envvars', workspaceName, envName, reveal],
    queryFn:  () => fetchEnvVars(workspaceName, envName, reveal),
    enabled:  open,
  })

  const saveMut = useMutation({
    mutationFn: ({ updates, dels }) => updateEnvVars(workspaceName, envName, updates, dels),
    onSuccess: () => {
      setEdits({}); setDeletes(new Set()); setNewKey(''); setNewVal('')
      qc.invalidateQueries({ queryKey: ['envvars', workspaceName, envName] })
    },
  })

  function toggleDelete(k) {
    setDeletes(prev => { const n = new Set(prev); n.has(k) ? n.delete(k) : n.add(k); return n })
    setEdits(prev => { const n = { ...prev }; delete n[k]; return n })
  }

  function handleSave() {
    const updates = { ...edits }
    if (newKey.trim()) updates[newKey.trim()] = newVal
    saveMut.mutate({ updates, dels: [...deletes] })
  }

  return (
    <div className="pt-3 border-t border-gray-700/50">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-2 text-xs font-semibold text-gray-400 uppercase tracking-wider hover:text-gray-200 transition-colors w-full"
      >
        <span className={`transition-transform ${open ? 'rotate-90' : ''}`}>▶</span>
        Environment Variables
        <span className="ml-auto text-gray-600 normal-case font-normal">.env file</span>
      </button>

      {open && (
        <div className="mt-3 space-y-3">
          {/* Reveal + hint */}
          <div className="flex items-center justify-between">
            <p className="text-xs text-amber-400/80 flex items-center gap-1">
              <span>⚠</span> Use <strong>Deploy ▾ → Refresh</strong> after saving to apply.
            </p>
            <label className="flex items-center gap-1.5 cursor-pointer shrink-0">
              <input type="checkbox" checked={reveal}
                onChange={e => { setReveal(e.target.checked); setEdits({}) }}
                className="w-3 h-3 accent-brand-500" />
              <span className="text-xs text-gray-400 select-none">Show values</span>
            </label>
          </div>

          {/* Existing vars */}
          {isLoading
            ? <p className="text-xs text-gray-500">Loading…</p>
            : (
              <div className="space-y-1.5 max-h-48 overflow-y-auto pr-1">
                {Object.entries(vars || {}).map(([k, v]) => {
                  const marked = deletes.has(k)
                  return (
                    <div key={k} className={`flex items-center gap-2 ${marked ? 'opacity-40' : ''}`}>
                      <span className="font-mono text-xs text-gray-400 w-36 shrink-0 truncate" title={k}>{k}</span>
                      <input
                        type={reveal ? 'text' : 'password'}
                        placeholder={reveal ? v : '••••••••'}
                        value={marked ? '' : (edits[k] ?? (reveal ? v : ''))}
                        disabled={marked}
                        onChange={e => setEdits(p => ({ ...p, [k]: e.target.value }))}
                        className="flex-1 px-2 py-1 bg-gray-800 border border-gray-700 rounded text-xs text-white font-mono focus:outline-none focus:border-brand-500 disabled:opacity-40"
                      />
                      <button type="button" onClick={() => toggleDelete(k)}
                        className={`shrink-0 w-5 h-5 flex items-center justify-center rounded text-xs transition-colors ${
                          marked ? 'bg-red-800 text-red-200 hover:bg-red-700' : 'text-gray-600 hover:text-red-400 hover:bg-gray-700'
                        }`}>
                        {marked ? '↩' : '×'}
                      </button>
                    </div>
                  )
                })}
              </div>
            )
          }

          {/* Add new variable */}
          <div className="flex gap-2 pt-2 border-t border-gray-700/40">
            <input type="text" placeholder="NEW_KEY" value={newKey}
              onChange={e => setNewKey(e.target.value)}
              className="w-36 px-2 py-1 bg-gray-800 border border-gray-700 rounded text-xs text-white font-mono focus:outline-none focus:border-brand-500" />
            <input type={reveal ? 'text' : 'password'} placeholder="value" value={newVal}
              onChange={e => setNewVal(e.target.value)}
              className="flex-1 px-2 py-1 bg-gray-800 border border-gray-700 rounded text-xs text-white font-mono focus:outline-none focus:border-brand-500" />
            <button type="button" onClick={() => newKey.trim() && handleSave()}
              disabled={!newKey.trim() || saveMut.isPending}
              className="px-2.5 py-1 bg-gray-700 hover:bg-gray-600 disabled:opacity-40 text-white text-xs rounded transition-colors shrink-0">
              Add
            </button>
          </div>

          {/* Save */}
          <div className="flex items-center gap-3">
            <button type="button" onClick={handleSave} disabled={saveMut.isPending}
              className="px-3 py-1.5 bg-brand-600 hover:bg-brand-700 disabled:opacity-50 text-white text-xs font-medium rounded-lg transition-colors">
              {saveMut.isPending ? 'Saving…' : 'Save changes'}
            </button>
            {saveMut.isSuccess && <span className="text-green-400 text-xs">Saved ✓</span>}
            {saveMut.isError   && <span className="text-red-400 text-xs">Failed</span>}
          </div>
        </div>
      )}
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
  const [firstEnvVars, setFirstEnvVars] = useState({})

  useEffect(() => {
    if (rawConfig && envs === null) {
      // Inject a stable _id into every env so EnvEditor keys never change on rename
      const withIds = {}
      Object.entries(rawConfig.environments || {}).forEach(([k, v], i) => {
        withIds[k] = { ...v, _id: `env-orig-${i}` }
      })
      setEnvs(withIds)
      setProject(rawConfig.project || {})
      setImages(rawConfig.images || [])
      // Pre-load vars from first env for use when adding new environments
      const firstEnvName = Object.keys(rawConfig.environments || {})[0]
      if (firstEnvName) {
        fetchEnvVars(name, firstEnvName, false)
          .then(vars => setFirstEnvVars(vars || {}))
          .catch(() => {})
      }
    }
  }, [rawConfig])

  const mutation = useMutation({
    mutationFn: async () => {
      // Strip _initial_vars from the config before saving — it's a UI-only field
      const cleanEnvs = {}
      for (const [k, v] of Object.entries(envs || {})) {
        // eslint-disable-next-line no-unused-vars
        const { _initial_vars: _iv, _id: _id2, ...rest } = v
        cleanEnvs[k] = rest
      }
      const updated = {
        ...rawConfig,
        project,
        environments: cleanEnvs,
        ...(project?.type === 'image' && { images }),
      }
      await putConfig(name, JSON.stringify(updated, null, 2))

      // Write initial env vars for new environments.
      // UpdateEnvVars now creates the .env file if it doesn't exist.
      const newEnvNames = Object.keys(envs || {}).filter(e => !originalEnvNames.includes(e))
      for (const envName of newEnvNames) {
        const initialVars = envs[envName]?._initial_vars || {}
        if (Object.keys(initialVars).length > 0) {
          try { await updateEnvVars(name, envName, initialVars) } catch { /* non-fatal */ }
        }
      }
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
      ssl_enabled: false,
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
    setEnvs(prev => ({ ...prev, [n]: { ...base, _id: `env-new-${newEnvCounter + 1}`, _initial_vars: { ...firstEnvVars } } }))
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
              className="text-sm font-medium px-4 py-2 rounded-lg border border-amber-700/60 bg-amber-900/30 hover:bg-amber-800/50 text-amber-300 transition-colors"
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
                key={cfg._id || envName}
                envName={envName}
                cfg={cfg}
                onChange={(updated) => updateEnv(envName, updated)}
                onRename={(newName) => renameEnv(envName, newName)}
                onRemove={() => removeEnv(envName)}
                isNew={!originalEnvNames.includes(envName)}
                isOnlyEnv={Object.keys(envs || {}).length === 1}
                projectType={project?.type || 'custom'}
                workspaceName={name}
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

        {/* Danger zone */}
        <DangerZone name={name} />
      </div>
    </Layout>
  )
}

function DangerZone({ name }) {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [open, setOpen]       = useState(false)
  const [confirm, setConfirm] = useState('')
  const [error, setError]     = useState('')

  const mutation = useMutation({
    mutationFn: () => deleteWorkspace(name),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['workspaces'] })
      navigate('/', { replace: true })
    },
    onError: (e) => setError(e.response?.data?.error || 'Delete failed'),
  })

  function handleDelete() {
    if (confirm !== name) {
      setError(`Type "${name}" exactly to confirm`)
      return
    }
    mutation.mutate()
  }

  return (
    <section className="mt-8">
      <div className="border border-red-900/50 rounded-xl overflow-hidden">
        <div className="px-5 py-3 bg-red-950/30 border-b border-red-900/50 flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold text-red-400">Danger zone</h2>
            <p className="text-xs text-red-400/70 mt-0.5">Irreversible actions — proceed with caution</p>
          </div>
        </div>
        <div className="px-5 py-4 flex items-center justify-between">
          <div>
            <p className="text-sm text-gray-200">Delete this workspace</p>
            <p className="text-xs text-gray-500 mt-0.5">Permanently removes all files, configs, and backups for <strong className="text-gray-400">{name}</strong>. Running containers are not stopped automatically.</p>
          </div>
          <button
            onClick={() => { setOpen(true); setConfirm(''); setError('') }}
            className="ml-6 shrink-0 px-4 py-2 bg-red-900/60 hover:bg-red-800/80 text-red-300 hover:text-red-200 text-sm font-medium rounded-lg border border-red-800/50 transition-colors"
          >
            Delete workspace
          </button>
        </div>
      </div>

      {/* Confirmation modal */}
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm" onClick={() => setOpen(false)}>
          <div className="bg-gray-900 border border-red-900/60 rounded-xl w-full max-w-md mx-4 p-6 space-y-4" onClick={e => e.stopPropagation()}>
            <div className="flex items-center gap-3">
              <span className="text-2xl">⚠️</span>
              <h3 className="font-semibold text-white">Delete <span className="text-red-400">{name}</span>?</h3>
            </div>
            <p className="text-sm text-gray-400">
              This will permanently delete the workspace directory and all its contents including configs, environment files, and backups.
              <strong className="text-gray-300 block mt-1">This cannot be undone.</strong>
            </p>
            {error && <p className="text-sm text-red-400 bg-red-950/40 border border-red-800/50 rounded-lg px-3 py-2">{error}</p>}
            <div>
              <label className="block text-xs font-semibold text-gray-400 uppercase tracking-wider mb-1.5">
                Type <span className="text-red-400 font-mono">{name}</span> to confirm
              </label>
              <input
                type="text"
                value={confirm}
                onChange={e => { setConfirm(e.target.value); setError('') }}
                onKeyDown={e => e.key === 'Enter' && handleDelete()}
                placeholder={name}
                autoFocus
                className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm font-mono focus:outline-none focus:border-red-500 transition-colors"
              />
            </div>
            <div className="flex gap-3">
              <button
                onClick={handleDelete}
                disabled={mutation.isPending || confirm !== name}
                className="flex-1 bg-red-700 hover:bg-red-600 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-semibold py-2 rounded-lg transition-colors"
              >
                {mutation.isPending ? 'Deleting…' : 'Delete permanently'}
              </button>
              <button
                onClick={() => setOpen(false)}
                className="px-4 py-2 bg-gray-800 hover:bg-gray-700 text-gray-300 text-sm rounded-lg transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}
