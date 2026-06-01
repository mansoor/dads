import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { fetchTemplates, fetchTemplate, recordTemplateUse, openCreateSocket, fetchRegistries, fetchBackupTargets } from '../lib/api'

// ── Shared UI primitives ──────────────────────────────────────────────────────

function Label({ children, required }) {
  return (
    <label className="block text-sm font-medium text-gray-300 mb-1">
      {children}{required && <span className="text-red-400 ml-0.5">*</span>}
    </label>
  )
}

function Input({ value, onChange, placeholder, type = 'text', error, ...rest }) {
  return (
    <>
      <input
        type={type} value={value} onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        className={`w-full px-3 py-2 bg-gray-800 border rounded-lg text-white placeholder-gray-500 text-sm focus:outline-none transition-colors ${
          error ? 'border-red-500 focus:border-red-400' : 'border-gray-700 focus:border-brand-500'
        }`}
        {...rest}
      />
      {error && <p className="text-red-400 text-xs mt-1">{error}</p>}
    </>
  )
}

function Select({ value, onChange, options }) {
  return (
    <select
      value={value} onChange={e => onChange(e.target.value)}
      className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:border-brand-500"
    >
      {options.map(o => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </select>
  )
}

function Toggle({ label, checked, onChange, hint }) {
  return (
    <div className="flex items-center justify-between">
      <div>
        <p className="text-sm text-gray-200">{label}</p>
        {hint && <p className="text-xs text-gray-500">{hint}</p>}
      </div>
      <button
        type="button" onClick={() => onChange(!checked)}
        className={`relative w-10 h-5 rounded-full transition-colors ${checked ? 'bg-brand-600' : 'bg-gray-700'}`}
      >
        <span className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${checked ? 'translate-x-5' : ''}`} />
      </button>
    </div>
  )
}

function StepHeader({ step, title, subtitle }) {
  return (
    <div className="mb-6">
      <p className="text-xs font-semibold text-brand-400 uppercase tracking-wider mb-1">Step {step}</p>
      <h2 className="text-xl font-semibold text-white">{title}</h2>
      {subtitle && <p className="text-sm text-gray-400 mt-0.5">{subtitle}</p>}
    </div>
  )
}

// ── Step 1: Project ───────────────────────────────────────────────────────────

const CUSTOM_REGISTRY = '__custom__'

function Step1({ data, onChange, errors }) {
  const { data: registries = [], isLoading } = useQuery({
    queryKey: ['registries'],
    queryFn: fetchRegistries,
  })

  // Once registries load, default to first one if registry not yet set
  useEffect(() => {
    if (!isLoading && registries.length > 0 && !data.registry) {
      onChange('registry', registries[0].url)
    }
  }, [isLoading, registries.length]) // eslint-disable-line react-hooks/exhaustive-deps

  // Determine whether the current registry value matches a known registry URL
  const isCustom = !isLoading && registries.length > 0 && !registries.some(r => r.url === data.registry)
  const selectValue = isCustom ? CUSTOM_REGISTRY : (data.registry || '')

  function handleSelectChange(val) {
    if (val === CUSTOM_REGISTRY) {
      onChange('registry', '')
    } else {
      onChange('registry', val)
    }
  }

  const hasRegistries = !isLoading && registries.length > 0

  return (
    <div className="space-y-5">
      <StepHeader step={1} title="Project" subtitle="Name your project and choose a container registry." />

      <div>
        <Label required>Project name</Label>
        <Input
          value={data.name} onChange={v => onChange('name', v)}
          placeholder="my-app" error={errors.name}
        />
        <p className="text-xs text-gray-500 mt-1">Lowercase letters, numbers, hyphens. Becomes the Docker resource prefix.</p>
      </div>

      <div>
        <Label required>Container registry</Label>

        {/* No registries configured — show hint + freetext fallback */}
        {!isLoading && !hasRegistries && (
          <div className="mb-3 flex items-start gap-2 px-3 py-2.5 bg-amber-950/40 border border-amber-800/50 rounded-lg">
            <span className="text-amber-400 mt-0.5 shrink-0">⚠</span>
            <p className="text-xs text-amber-300">
              No registries configured.{' '}
              <a href="/settings" target="_blank" rel="noreferrer"
                className="underline underline-offset-2 hover:text-amber-200 transition-colors">
                Add one in Settings
              </a>{' '}
              to reuse credentials across workspaces.
            </p>
          </div>
        )}

        {/* Dropdown when registries exist */}
        {hasRegistries && (
          <select
            value={selectValue}
            onChange={e => handleSelectChange(e.target.value)}
            className={`w-full px-3 py-2 bg-gray-800 border rounded-lg text-white text-sm focus:outline-none focus:border-brand-500 transition-colors ${
              errors.registry ? 'border-red-500' : 'border-gray-700'
            }`}
          >
            {registries.map(r => (
              <option key={r.id} value={r.url}>
                {r.name} — {r.url}
              </option>
            ))}
            <option value={CUSTOM_REGISTRY}>Other (enter manually)…</option>
          </select>
        )}

        {/* Freetext input: always shown when no registries, or when "Other" is selected */}
        {(!hasRegistries || isCustom || selectValue === CUSTOM_REGISTRY) && (
          <div className={hasRegistries ? 'mt-2' : ''}>
            <Input
              value={data.registry} onChange={v => onChange('registry', v)}
              placeholder="registry.example.com"
              error={errors.registry}
            />
            {hasRegistries && (
              <p className="text-xs text-gray-500 mt-1">
                To save this registry for reuse,{' '}
                <a href="/settings" target="_blank" rel="noreferrer"
                  className="text-brand-400 hover:text-brand-300 underline underline-offset-2 transition-colors">
                  add it in Settings
                </a>{' '}
                first.
              </p>
            )}
          </div>
        )}

        {/* Show error for dropdown-only mode */}
        {errors.registry && hasRegistries && !isCustom && selectValue !== CUSTOM_REGISTRY && (
          <p className="text-red-400 text-xs mt-1">{errors.registry}</p>
        )}
      </div>
    </div>
  )
}

// ── Step 2: Stack ─────────────────────────────────────────────────────────────

const STACK_TYPES = [
  { id: 'prebuilt', label: 'Pre-built template',  desc: 'Pick from curated stacks — NPM, WordPress, Vaultwarden, Uptime Kuma…' },
  { id: 'image',    label: 'Image stack',          desc: 'Deploy any Docker images — specify your own image names, tags, and ports.' },
  { id: 'custom',   label: 'Custom application',  desc: 'Your own code — Laravel, Node.js, Next.js, React with a database.' },
]

const BACKEND_OPTIONS  = [{ value: 'laravel', label: 'Laravel (PHP-FPM)' }, { value: 'nodejs', label: 'Node.js (Express / Fastify)' }]
const FRONTEND_OPTIONS = [{ value: 'none', label: 'None (API only)' }, { value: 'nextjs', label: 'Next.js' }, { value: 'react', label: 'React / Vite SPA' }]
const DB_OPTIONS       = [{ value: 'none', label: 'None' }, { value: 'postgres', label: 'PostgreSQL' }, { value: 'mysql', label: 'MySQL' }]

function TemplateCard({ tmpl, selected, onClick }) {
  const tagColors = ['bg-blue-950 text-blue-300', 'bg-purple-950 text-purple-300', 'bg-green-950 text-green-300']
  return (
    <button
      type="button" onClick={onClick}
      className={`text-left w-full p-4 rounded-xl border transition-all ${
        selected
          ? 'border-brand-500 bg-brand-950/30'
          : 'border-gray-700 bg-gray-800/40 hover:border-gray-500'
      }`}
    >
      <div className="flex items-start justify-between gap-2 mb-1">
        <p className="font-medium text-white text-sm">{tmpl.label}</p>
        <span className="text-xs text-gray-500 shrink-0">{tmpl.image_count} container{tmpl.image_count !== 1 ? 's' : ''}</span>
      </div>
      <p className="text-xs text-gray-400 mb-2">{tmpl.description}</p>
      <div className="flex flex-wrap gap-1">
        {(tmpl.tags || []).slice(0, 3).map((tag, i) => (
          <span key={tag} className={`text-xs px-1.5 py-0.5 rounded ${tagColors[i % tagColors.length]}`}>{tag}</span>
        ))}
      </div>
    </button>
  )
}

const DEFAULT_IMAGE = { name: '', image: '', tag: 'latest', container_port: '', host_port: '' }

function ImageEditor({ images, onChange }) {
  function update(idx, field, val) {
    const next = images.map((img, i) => i === idx ? { ...img, [field]: val } : img)
    onChange(next)
  }
  function add() { onChange([...images, { ...DEFAULT_IMAGE }]) }
  function remove(idx) { onChange(images.filter((_, i) => i !== idx)) }

  return (
    <div className="space-y-3">
      {images.map((img, i) => (
        <div key={i} className="bg-gray-800/50 border border-gray-700 rounded-xl p-4 space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Service {i + 1}</p>
            {images.length > 1 && (
              <button type="button" onClick={() => remove(i)} className="text-xs text-red-400 hover:text-red-300">Remove</button>
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
              <Input type="number" value={img.container_port} onChange={v => update(i, 'container_port', v)} placeholder="80" />
            </div>
            <div className="col-span-2">
              <Label>Host port</Label>
              <Input value={img.host_port} onChange={v => update(i, 'host_port', v)} placeholder="8080" />
            </div>
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

function EnvVarEditor({ envVars, onChange }) {
  const [newKey, setNewKey] = useState('')
  const [newVal, setNewVal] = useState('')
  const entries = Object.entries(envVars)

  function update(k, v) { onChange({ ...envVars, [k]: v }) }
  function remove(k) { const next = { ...envVars }; delete next[k]; onChange(next) }
  function add() {
    const k = newKey.trim()
    if (!k) return
    onChange({ ...envVars, [k]: newVal })
    setNewKey('')
    setNewVal('')
  }

  return (
    <div className="space-y-2">
      {entries.map(([k, v]) => (
        <div key={k} className="flex items-center gap-2">
          <span className="font-mono text-xs text-gray-300 w-44 shrink-0 truncate">{k}</span>
          <input
            type="text" value={v} onChange={e => update(k, e.target.value)}
            className="flex-1 px-2 py-1 bg-gray-800 border border-gray-700 rounded text-sm text-white font-mono focus:outline-none focus:border-brand-500"
          />
          <button type="button" onClick={() => remove(k)} className="text-gray-600 hover:text-red-400 text-sm shrink-0">×</button>
        </div>
      ))}
      <div className="flex gap-2 pt-1">
        <input
          type="text" placeholder="KEY" value={newKey} onChange={e => setNewKey(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && add()}
          className="w-44 px-2 py-1 bg-gray-800 border border-gray-700 rounded text-sm text-white font-mono focus:outline-none focus:border-brand-500"
        />
        <input
          type="text" placeholder="value" value={newVal} onChange={e => setNewVal(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && add()}
          className="flex-1 px-2 py-1 bg-gray-800 border border-gray-700 rounded text-sm text-white font-mono focus:outline-none focus:border-brand-500"
        />
        <button type="button" onClick={add} className="text-xs text-brand-400 hover:text-brand-300 shrink-0 px-2">Add</button>
      </div>
    </div>
  )
}

// ── Template picker section (popular + recently used + Browse all modal) ──────

function TemplatePickerSection({ templates, selected, onSelect }) {
  const [modalOpen, setModalOpen] = useState(false)
  const [search, setSearch] = useState('')

  // Popular: templates with popular=true, sorted by popular_rank
  const popular = templates
    .filter(t => t.popular)
    .sort((a, b) => a.popular_rank - b.popular_rank)
    .slice(0, 4)

  // Recently used: templates with last_used_at, sorted newest first, excluding popular ones
  const popularNames = new Set(popular.map(t => t.name))
  const recentlyUsed = templates
    .filter(t => t.last_used_at && !popularNames.has(t.name))
    .sort((a, b) => new Date(b.last_used_at) - new Date(a.last_used_at))
    .slice(0, 4)

  // All templates for modal, filtered by search
  const filtered = templates.filter(t =>
    !search ||
    t.label.toLowerCase().includes(search.toLowerCase()) ||
    t.name.toLowerCase().includes(search.toLowerCase()) ||
    (t.tags || []).some(tag => tag.toLowerCase().includes(search.toLowerCase()))
  )

  const selectedTmpl = templates.find(t => t.name === selected)

  function handleSelect(tmpl) {
    onSelect(tmpl)
    setModalOpen(false)
  }

  return (
    <div className="space-y-4">
      {/* Popular */}
      <div>
        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Popular</p>
        <div className="grid grid-cols-2 gap-3">
          {popular.map(tmpl => (
            <TemplateCard key={tmpl.name} tmpl={tmpl} selected={selected === tmpl.name} onClick={() => handleSelect(tmpl)} />
          ))}
        </div>
      </div>

      {/* Recently used — only shown when there's history */}
      {recentlyUsed.length > 0 && (
        <div>
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Recently used</p>
          <div className="grid grid-cols-2 gap-3">
            {recentlyUsed.map(tmpl => (
              <TemplateCard key={tmpl.name} tmpl={tmpl} selected={selected === tmpl.name} onClick={() => handleSelect(tmpl)} />
            ))}
          </div>
        </div>
      )}

      {/* Browse all button */}
      <button
        type="button"
        onClick={() => { setSearch(''); setModalOpen(true) }}
        className="w-full py-2.5 border border-dashed border-gray-700 text-gray-400 hover:text-gray-200 hover:border-gray-500 rounded-xl text-sm transition-colors"
      >
        Browse all templates ({templates.length}) →
      </button>

      {/* Selected template confirmation */}
      {selectedTmpl && (
        <p className="text-xs text-gray-500 flex items-center gap-1.5">
          <span className="text-brand-400">✓</span>
          <strong className="text-gray-300">{selectedTmpl.label}</strong> selected —
          env vars and volumes pre-filled in Step 4. Review secrets before creating.
        </p>
      )}

      {/* Browse all modal */}
      {modalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70">
          <div className="bg-gray-900 border border-gray-700 rounded-2xl w-full max-w-2xl max-h-[80vh] flex flex-col shadow-2xl">
            {/* Modal header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800">
              <h3 className="text-base font-semibold text-white">All templates</h3>
              <button
                type="button"
                onClick={() => setModalOpen(false)}
                className="text-gray-500 hover:text-white transition-colors text-xl leading-none"
              >×</button>
            </div>
            {/* Search */}
            <div className="px-5 py-3 border-b border-gray-800">
              <input
                type="text"
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Search templates…"
                autoFocus
                className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm placeholder-gray-500 focus:outline-none focus:border-brand-500"
              />
            </div>
            {/* Template grid */}
            <div className="overflow-y-auto p-5">
              {filtered.length === 0 ? (
                <p className="text-sm text-gray-500 text-center py-8">No templates match "{search}"</p>
              ) : (
                <div className="grid grid-cols-2 gap-3">
                  {filtered.map(tmpl => (
                    <TemplateCard
                      key={tmpl.name}
                      tmpl={tmpl}
                      selected={selected === tmpl.name}
                      onClick={() => handleSelect(tmpl)}
                    />
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function Step2({ data, onChange }) {
  const { data: templates } = useQuery({ queryKey: ['templates'], queryFn: fetchTemplates })

  return (
    <div className="space-y-5">
      <StepHeader step={2} title="Application stack" subtitle="Choose how you want to configure your containers." />

      {/* Type selector */}
      <div className="grid grid-cols-3 gap-3">
        {STACK_TYPES.map(t => (
          <button
            key={t.id} type="button" onClick={() => onChange('stackType', t.id)}
            className={`text-left p-4 rounded-xl border transition-all ${
              data.stackType === t.id
                ? 'border-brand-500 bg-brand-950/30'
                : 'border-gray-700 bg-gray-800/40 hover:border-gray-500'
            }`}
          >
            <p className="font-medium text-white text-sm mb-1">{t.label}</p>
            <p className="text-xs text-gray-400">{t.desc}</p>
          </button>
        ))}
      </div>

      {/* Image stack: custom image list + env vars */}
      {data.stackType === 'image' && (
        <div className="space-y-5">
          <div>
            <Label>Services</Label>
            <p className="text-xs text-gray-500 mb-2">Add each Docker image you want to deploy.</p>
            <ImageEditor images={data.images} onChange={v => onChange('images', v)} />
          </div>
          <div>
            <Label>Environment variables</Label>
            <p className="text-xs text-gray-500 mb-2">These will be written to <code className="font-mono text-xs">.env</code>. Secrets can be set now or edited after creation.</p>
            <EnvVarEditor envVars={data.customEnvVars} onChange={v => onChange('customEnvVars', v)} />
          </div>
        </div>
      )}

      {/* Pre-built template picker */}
      {data.stackType === 'prebuilt' && (
        <TemplatePickerSection
          templates={templates || []}
          selected={data.template}
          onSelect={async (tmpl) => {
            onChange('template', tmpl.name)
            try {
              recordTemplateUse(tmpl.name).catch(() => {}) // fire-and-forget
              const detail = await fetchTemplate(tmpl.name)
              // Pre-populate Step 4 env vars from template defaults.
              const envs = detail?.default_envs || detail?.default_env_vars || {}
              if (Object.keys(envs).length > 0) onChange('initialEnvVars', envs)
              // Pre-populate wizard images from template.
              if (detail?.images?.length > 0) {
                onChange('images', detail.images.map(img => ({
                  name:           img.name      || '',
                  image:          img.image     || '',
                  tag:            img.tag       || 'latest',
                  container_port: img.port ? String(img.port) : '',
                  host_port:      img.host_port || '',
                })))
                // Build read-only templateVolumes list for Step 4 info display.
                // Collects ALL volume mounts (bind and named) across all images,
                // deduplicated by source path.
                const seen = new Set()
                const templateVols = []
                for (const img of detail.images) {
                  for (const v of (img.volumes || [])) {
                    const colonIdx = v.indexOf(':')
                    if (colonIdx < 0) continue
                    const source = v.slice(0, colonIdx)
                    const mountPath = v.slice(colonIdx + 1).split(':')[0] // strip :ro etc
                    if (!seen.has(source)) {
                      seen.add(source)
                      templateVols.push({ source, mountPath })
                    }
                  }
                }
                onChange('templateVolumes', templateVols)
              }
            } catch { /* non-fatal */ }
          }}
        />
      )}

      {/* Custom stack options */}
      {data.stackType === 'custom' && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label>Backend</Label>
              <Select value={data.backend} onChange={v => onChange('backend', v)} options={BACKEND_OPTIONS} />
            </div>
            <div>
              <Label>Frontend</Label>
              <Select value={data.frontend} onChange={v => onChange('frontend', v)} options={FRONTEND_OPTIONS} />
            </div>
            <div>
              <Label>Database</Label>
              <Select value={data.database} onChange={v => onChange('database', v)} options={DB_OPTIONS} />
            </div>
          </div>
          <div className="space-y-3 pt-2 border-t border-gray-800">
            <Toggle label="Redis cache" hint="redis:7-alpine" checked={data.redis} onChange={v => onChange('redis', v)} />
            <Toggle label="Garage S3" hint="Self-hosted S3-compatible object storage" checked={data.garage} onChange={v => onChange('garage', v)} />
          </div>
        </div>
      )}
    </div>
  )
}

// ── Step 3: Environments ──────────────────────────────────────────────────────

const DEFAULT_ENV = { name: '', domain: '', http_port: 8080, https_port: 8443, traefik: false, traefik_network: 'traefik_net', ssl_enabled: false, deployment: 'compose', backend_replicas: 1, frontend_replicas: 1, git_enabled: false, git_repo: '', git_branch: '' }
const DEPLOYMENT_OPTIONS = [{ value: 'compose', label: 'Docker Compose' }, { value: 'swarm', label: 'Docker Swarm' }]

function EnvForm({ env, idx, onChange, onRemove, canRemove }) {
  const upd = (k, v) => onChange(idx, { ...env, [k]: v })
  return (
    <div className="bg-gray-800/50 border border-gray-700 rounded-xl p-4 space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold text-white">Environment {idx + 1}</p>
        {canRemove && (
          <button type="button" onClick={() => onRemove(idx)} className="text-xs text-red-400 hover:text-red-300">Remove</button>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label required>Name</Label>
          <Input value={env.name} onChange={v => upd('name', v)} placeholder="prod" />
        </div>
        <div>
          <Label>Domain</Label>
          <Input value={env.domain} onChange={v => upd('domain', v)} placeholder="example.com" />
        </div>
        {!env.traefik && (
          <>
            <div>
              <Label>HTTP port</Label>
              <Input type="number" value={env.http_port} onChange={v => upd('http_port', parseInt(v) || 8080)} placeholder="8080" />
              <p className="text-xs text-gray-500 mt-1">Host port Nginx binds to directly — access your app at <code className="font-mono text-xs">host:{env.http_port || 8080}</code></p>
            </div>
            <div>
              <Label>HTTPS port</Label>
              <Input type="number" value={env.https_port} onChange={v => upd('https_port', parseInt(v) || 8443)} placeholder="8443" />
              <p className="text-xs text-gray-500 mt-1">Only needed if you manage your own SSL cert (optional)</p>
            </div>
          </>
        )}
        {env.traefik && (
          <div className="col-span-2">
            <p className="text-xs text-gray-500 flex items-center gap-1.5 px-3 py-2 bg-gray-800/60 rounded-lg border border-gray-700/60">
              <span>ℹ</span> Traefik handles ports 80 / 443 — set a domain above for routing.
            </p>
          </div>
        )}
        <div>
          <Label>Deployment</Label>
          <Select value={env.deployment} onChange={v => upd('deployment', v)} options={DEPLOYMENT_OPTIONS} />
        </div>
      </div>

      <div className="space-y-3 pt-2 border-t border-gray-700/60">
        <Toggle
          label="Traefik reverse proxy"
          hint="Route traffic via Traefik instead of direct port binding"
          checked={env.traefik}
          onChange={v => {
            upd('traefik', v)
            // Clear SSL when Traefik is disabled
            if (!v) upd('ssl_enabled', false)
          }}
        />

        {/* SSL checkbox — only shown when Traefik is on AND a domain is entered */}
        {env.traefik && (
          <div className={`pl-4 border-l-2 ${env.ssl_enabled ? 'border-green-700' : 'border-gray-700'}`}>
            <div className="flex items-start justify-between">
              <div>
                <p className="text-sm text-gray-200">Request SSL certificate</p>
                <p className="text-xs text-gray-500 mt-0.5">
                  {!env.domain
                    ? 'Enter a domain above to enable SSL'
                    : 'Traefik will issue a Let\'s Encrypt cert for this domain'}
                </p>
              </div>
              <button
                type="button"
                disabled={!env.domain}
                onClick={() => upd('ssl_enabled', !env.ssl_enabled)}
                className={`relative w-10 h-5 rounded-full transition-colors shrink-0 ml-4 ${
                  env.ssl_enabled && env.domain ? 'bg-green-600' : 'bg-gray-700'
                } disabled:opacity-40`}
              >
                <span className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${
                  env.ssl_enabled && env.domain ? 'translate-x-5' : ''
                }`} />
              </button>
            </div>

            {env.ssl_enabled && env.domain && (
              <div className="mt-2 flex items-start gap-2 px-3 py-2 bg-green-950/40 border border-green-800/50 rounded-lg">
                <span className="text-green-400 shrink-0 mt-0.5">🔒</span>
                <div className="text-xs text-green-300 space-y-0.5">
                  <p>SSL will be active for <strong>{env.domain}</strong></p>
                  <p className="text-green-400/70">
                    Port 80 must be publicly reachable for the Let's Encrypt HTTP-01 challenge.
                    Set <code className="font-mono text-xs">ACME_EMAIL</code> in{' '}
                    <code className="font-mono text-xs">dads-ui/.env</code> before deploying.
                  </p>
                </div>
              </div>
            )}
          </div>
        )}
        <Toggle
          label="Git sync"
          hint="Enable ./run.sh sync for this environment"
          checked={env.git_enabled}
          onChange={v => upd('git_enabled', v)}
        />
        {env.git_enabled && (
          <div className="grid grid-cols-2 gap-3 pl-1">
            <div>
              <Label>Git repo</Label>
              <Input value={env.git_repo} onChange={v => upd('git_repo', v)} placeholder="git@github.com:org/repo.git" />
            </div>
            <div>
              <Label>Branch</Label>
              <Input value={env.git_branch} onChange={v => upd('git_branch', v)} placeholder="main" />
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function Step3({ data, onChange }) {
  function updateEnv(idx, updated) {
    const envs = [...data.environments]
    envs[idx] = updated
    onChange('environments', envs)
  }
  function addEnv() {
    onChange('environments', [...data.environments, { ...DEFAULT_ENV }])
  }
  function removeEnv(idx) {
    onChange('environments', data.environments.filter((_, i) => i !== idx))
  }

  return (
    <div className="space-y-4">
      <StepHeader step={3} title="Environments" subtitle="Configure the environments for this workspace." />
      {data.environments.map((env, i) => (
        <EnvForm
          key={i} idx={i} env={env}
          onChange={updateEnv}
          onRemove={removeEnv}
          canRemove={data.environments.length > 1}
        />
      ))}
      <button
        type="button" onClick={addEnv}
        className="w-full py-2 border border-dashed border-gray-700 text-gray-400 hover:text-gray-200 hover:border-gray-500 rounded-xl text-sm transition-colors"
      >
        + Add environment
      </button>
    </div>
  )
}

// ── Step 4: Env Vars & Volumes ────────────────────────────────────────────────

const DEFAULT_VOLUME = { name: '', mountPath: '' }

// Returns 'bind' if source starts with . or /, otherwise 'named'
function volType(source) {
  return (source.startsWith('./') || source.startsWith('/')) ? 'bind' : 'named'
}

function VolTypeBadge({ source }) {
  const t = volType(source)
  return (
    <span className={`text-xs px-1.5 py-0.5 rounded font-medium shrink-0 ${
      t === 'bind' ? 'bg-blue-950 text-blue-300' : 'bg-purple-950 text-purple-300'
    }`}>{t === 'bind' ? 'bind' : 'named'}</span>
  )
}

function VolumeEditor({ volumes, onChange }) {
  function update(idx, field, val) {
    onChange(volumes.map((v, i) => i === idx ? { ...v, [field]: val } : v))
  }
  function add() { onChange([...volumes, { name: './volumes/', mountPath: '' }]) }
  function remove(idx) { onChange(volumes.filter((_, i) => i !== idx)) }

  return (
    <div className="space-y-2">
      {volumes.map((vol, i) => (
        <div key={i} className="flex items-center gap-2">
          <VolTypeBadge source={vol.name || ''} />
          <input
            type="text" value={vol.name} onChange={e => update(i, 'name', e.target.value)}
            placeholder="./volumes/db_data or db_data"
            className="flex-1 px-2 py-1.5 bg-gray-800 border border-gray-700 rounded text-sm text-white font-mono focus:outline-none focus:border-brand-500"
          />
          <span className="text-gray-600 text-xs shrink-0">→</span>
          <input
            type="text" value={vol.mountPath} onChange={e => update(i, 'mountPath', e.target.value)}
            placeholder="/var/lib/mysql"
            className="flex-1 px-2 py-1.5 bg-gray-800 border border-gray-700 rounded text-sm text-white font-mono focus:outline-none focus:border-brand-500"
          />
          <button type="button" onClick={() => remove(i)} className="text-gray-600 hover:text-red-400 text-sm shrink-0 px-1">×</button>
        </div>
      ))}
      <p className="text-xs text-gray-600">
        Paths starting with <code className="font-mono">./</code> or <code className="font-mono">/</code> = bind mount (scoped to workspace). Plain names = Docker named volume.
      </p>
      <button
        type="button" onClick={add}
        className="text-xs text-brand-400 hover:text-brand-300 transition-colors"
      >
        + Add volume
      </button>
    </div>
  )
}

function Step4({ data, onChange }) {
  return (
    <div className="space-y-6">
      <StepHeader step={4} title="Env Vars & Volumes" subtitle="Review environment variables and add any extra volumes." />

      {/* Environment variables */}
      <div>
        <div className="flex items-center justify-between mb-1">
          <Label>Initial environment variables</Label>
        </div>
        <p className="text-xs text-gray-500 mb-3">
          Applied to every environment's <code className="font-mono text-xs">.env</code> file at creation.
          {data.stackType === 'image' && ' These are merged with the per-service vars from Step 2.'}
        </p>
        <EnvVarEditor envVars={data.initialEnvVars} onChange={v => onChange('initialEnvVars', v)} />
      </div>

      {/* Template volumes info — read-only list of volumes baked into the template */}
      {data.stackType === 'prebuilt' && data.templateVolumes?.length > 0 && (
        <div className="pt-4 border-t border-gray-800">
          <Label>Template volumes</Label>
          <p className="text-xs text-gray-500 mb-3">
            These volumes are defined by the template and will be created automatically.
            Bind mounts (<code className="font-mono text-xs">./volumes/…</code>) are scoped to each environment's directory — no collisions between workspaces or environments.
            You can change the volume type after creation in Edit Workspace.
          </p>
          <div className="space-y-1.5">
            {data.templateVolumes.map((v, i) => (
              <div key={i} className="flex items-center gap-2 px-3 py-2 bg-gray-800/40 rounded-lg">
                <VolTypeBadge source={v.source} />
                <code className="text-xs text-gray-300 font-mono flex-1">{v.source}</code>
                <span className="text-gray-600 text-xs">→</span>
                <code className="text-xs text-gray-500 font-mono">{v.mountPath}</code>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Extra volumes — user-declared additions on top of template defaults */}
      <div className="pt-4 border-t border-gray-800">
        <Label>Extra volumes</Label>
        <p className="text-xs text-gray-500 mb-3">
          Add additional volumes beyond what the template declares.
          Use <code className="font-mono text-xs">./volumes/name</code> for a bind mount or a plain name for a Docker named volume.
        </p>
        {data.volumes.length === 0 && (
          <p className="text-xs text-gray-600 mb-2 italic">No extra volumes added.</p>
        )}
        <VolumeEditor volumes={data.volumes} onChange={v => onChange('volumes', v)} />
      </div>
    </div>
  )
}

// ── Step 5: Backup Configuration ──────────────────────────────────────────────

const SCHEDULE_OPTIONS = [
  { value: 'daily',  label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'manual', label: 'Manual only' },
]

const RETENTION_OPTIONS = [
  { value: 3,  label: '3 backups' },
  { value: 7,  label: '7 backups' },
  { value: 14, label: '14 backups' },
  { value: 30, label: '30 backups' },
]

function Step5({ data, onChange }) {
  const { data: targets = [], isLoading } = useQuery({
    queryKey: ['backup-targets'],
    queryFn: fetchBackupTargets,
  })

  const backup = data.backup
  function upd(key, val) { onChange('backup', { ...backup, [key]: val }) }

  // When a target is selected, store both id and name
  function handleTargetChange(val) {
    if (val === 'local') {
      upd('targetId', null)
      onChange('backup', { ...backup, targetId: null, targetName: 'local' })
    } else {
      const t = targets.find(t => String(t.id) === val)
      onChange('backup', { ...backup, targetId: t?.id ?? null, targetName: t?.name ?? val })
    }
  }

  const selectedTargetVal = backup.targetId ? String(backup.targetId) : 'local'

  return (
    <div className="space-y-6">
      <StepHeader step={5} title="Backup Configuration" subtitle="Configure where and how often this workspace is backed up." />

      {/* Enable toggle */}
      <Toggle
        label="Enable backups"
        hint="Backup all environment databases and volumes"
        checked={backup.enabled}
        onChange={v => upd('enabled', v)}
      />

      {backup.enabled && (
        <div className="space-y-5 pt-2">
          {/* Backup destination */}
          <div>
            <Label required>Backup destination</Label>
            {isLoading ? (
              <p className="text-sm text-gray-500">Loading targets…</p>
            ) : (
              <>
                <select
                  value={selectedTargetVal}
                  onChange={e => handleTargetChange(e.target.value)}
                  className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:border-brand-500"
                >
                  <option value="local">Local filesystem (default)</option>
                  {targets.map(t => (
                    <option key={t.id} value={String(t.id)}>
                      {t.name} ({t.type.toUpperCase()})
                    </option>
                  ))}
                </select>
                {targets.length === 0 && (
                  <p className="text-xs text-gray-500 mt-1.5">
                    Only local backups available.{' '}
                    <a href="/settings" target="_blank" rel="noreferrer"
                      className="text-brand-400 hover:text-brand-300 underline underline-offset-2">
                      Add an S3 or SFTP target in Settings
                    </a>{' '}
                    to enable remote backups.
                  </p>
                )}
                {selectedTargetVal === 'local' && (
                  <p className="text-xs text-gray-500 mt-1.5">
                    Stored in <code className="font-mono text-xs">workspaces/{data.name || '<name>'}/backups/</code>
                  </p>
                )}
              </>
            )}
          </div>

          {/* Schedule */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label>Schedule</Label>
              <Select
                value={backup.schedule}
                onChange={v => upd('schedule', v)}
                options={SCHEDULE_OPTIONS}
              />
            </div>
            <div>
              <Label>Retention</Label>
              <Select
                value={backup.retention}
                onChange={v => upd('retention', parseInt(v))}
                options={RETENTION_OPTIONS}
              />
              <p className="text-xs text-gray-500 mt-1">Older backups are pruned automatically.</p>
            </div>
          </div>
        </div>
      )}

      {!backup.enabled && (
        <div className="px-4 py-3 bg-gray-800/60 border border-gray-700/60 rounded-lg">
          <p className="text-sm text-gray-400">Backups disabled — you can enable them later from the workspace settings.</p>
        </div>
      )}
    </div>
  )
}

// ── Step 6: Review ────────────────────────────────────────────────────────────

function ReviewRow({ label, value }) {
  return (
    <div className="flex items-start justify-between py-2 border-b border-gray-800 last:border-0">
      <span className="text-sm text-gray-400">{label}</span>
      <span className="text-sm text-white font-medium text-right max-w-[60%]">{value || '—'}</span>
    </div>
  )
}

function Step6({ data }) {
  const stackDesc = data.stackType === 'prebuilt'
    ? `Pre-built: ${data.template || '(none selected)'}`
    : data.stackType === 'image'
    ? `Image stack: ${data.images.filter(i => i.name).map(i => `${i.name} (${i.image}:${i.tag || 'latest'})`).join(', ') || '(no services)'}`
    : `Custom: ${[data.backend, data.frontend !== 'none' && data.frontend, data.database !== 'none' && data.database].filter(Boolean).join(' · ')}`

  return (
    <div className="space-y-5">
      <StepHeader step={6} title="Review" subtitle="Confirm your configuration before creating the workspace." />

      <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 space-y-0">
        <ReviewRow label="Project name" value={data.name} />
        <ReviewRow label="Registry" value={data.registry} />
        <ReviewRow label="Stack" value={stackDesc} />
        <ReviewRow label="Environments" value={data.environments.map(e => e.name || '(unnamed)').join(', ')} />
        {data.environments.map((e, i) => e.domain && (
          <ReviewRow key={i} label={`  ${e.name} domain`} value={e.domain} />
        ))}
        {data.redis  && <ReviewRow label="Redis" value="Enabled" />}
        {data.garage && <ReviewRow label="Garage S3" value="Enabled" />}
        {Object.keys(data.initialEnvVars).length > 0 && (
          <ReviewRow label="Initial env vars" value={`${Object.keys(data.initialEnvVars).length} variable(s)`} />
        )}
        {data.volumes.filter(v => v.name).length > 0 && (
          <ReviewRow label="Named volumes" value={data.volumes.filter(v => v.name).map(v => v.name).join(', ')} />
        )}
        <ReviewRow label="Backup" value={
          !data.backup.enabled ? 'Disabled' :
          `${data.backup.targetName === 'local' ? 'Local' : data.backup.targetName} · ${data.backup.schedule} · keep ${data.backup.retention}`
        } />
      </div>

      <div className="bg-amber-950/40 border border-amber-800/50 rounded-xl px-4 py-3">
        <p className="text-sm text-amber-300">
          After creation, edit <code className="font-mono text-xs bg-amber-900/40 px-1 py-0.5 rounded">envs/&#123;env&#125;/.env</code> to fill in secrets before starting the stack.
        </p>
      </div>
    </div>
  )
}

// ── Step 7: Creating (live terminal) ─────────────────────────────────────────

function Step7({ workspace, onDone }) {
  const termRef = useRef(null)
  const containerRef = useRef(null)
  const [done, setDone] = useState(false)

  useEffect(() => {
    const term = new Terminal({
      theme: { background: '#030712', foreground: '#f3f4f6', cursor: '#6366f1', selectionBackground: '#374151' },
      fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
      fontSize: 13, lineHeight: 1.5, convertEol: true, scrollback: 2000,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(containerRef.current)
    fit.fit()
    termRef.current = term

    const ws = openCreateSocket(workspace)
    ws.addEventListener('message', e => {
      term.write(e.data)
      if (e.data.includes('is ready!')) setDone(true)
    })
    ws.addEventListener('error', () => term.write('\r\n\x1b[31m[connection error]\x1b[0m\r\n'))
    ws.addEventListener('close', () => { if (!done) setDone(true) })

    return () => { term.dispose(); ws.close() }
  }, [])

  return (
    <div className="space-y-4">
      <StepHeader step={7} title="Creating workspace" subtitle="Bootstrap output — this takes a few seconds." />
      <div ref={containerRef} className="rounded-xl overflow-hidden" style={{ height: 320 }} />
      {done && (
        <button
          onClick={onDone}
          className="w-full py-2.5 bg-brand-600 hover:bg-brand-700 text-white font-medium rounded-lg transition-colors"
        >
          Open workspace →
        </button>
      )}
    </div>
  )
}

// ── Stepper nav ───────────────────────────────────────────────────────────────

const STEPS = ['Project', 'Stack', 'Environments', 'Env Vars', 'Backup', 'Review', 'Creating']

function Stepper({ current }) {
  return (
    <div className="flex items-center gap-0 mb-8">
      {STEPS.map((label, i) => {
        const n = i + 1
        const state = n < current ? 'done' : n === current ? 'active' : 'pending'
        return (
          <div key={label} className="flex items-center flex-1 last:flex-none">
            <div className="flex flex-col items-center gap-1">
              <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold transition-colors ${
                state === 'done'   ? 'bg-brand-600 text-white' :
                state === 'active' ? 'bg-brand-600 text-white ring-2 ring-brand-400 ring-offset-2 ring-offset-gray-950' :
                'bg-gray-800 text-gray-500 border border-gray-700'
              }`}>
                {state === 'done' ? '✓' : n}
              </div>
              <span className={`text-xs ${state === 'active' ? 'text-white' : 'text-gray-500'}`}>{label}</span>
            </div>
            {i < STEPS.length - 1 && (
              <div className={`flex-1 h-px mx-2 mb-4 ${n < current ? 'bg-brand-600' : 'bg-gray-700'}`} />
            )}
          </div>
        )
      })}
    </div>
  )
}

// ── Main wizard page ──────────────────────────────────────────────────────────

const DEFAULT_DATA = {
  name: '', registry: '',
  stackType: 'prebuilt', template: '', images: [{ ...DEFAULT_IMAGE }], customEnvVars: {},
  backend: 'laravel', frontend: 'none', database: 'postgres', redis: false, garage: false,
  environments: [{ ...DEFAULT_ENV, name: 'prod', http_port: 80, https_port: 443 }],
  initialEnvVars: {},
  volumes: [],
  templateVolumes: [], // read-only display list populated from selected prebuilt template
  backup: { enabled: true, targetId: null, targetName: 'local', schedule: 'daily', retention: 7 },
}

export default function NewWorkspacePage() {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [step, setStep] = useState(1)
  const [data, setData] = useState(DEFAULT_DATA)
  const [errors, setErrors] = useState({})

  function update(key, value) {
    setData(prev => ({ ...prev, [key]: value }))
    setErrors(prev => ({ ...prev, [key]: undefined }))
  }

  function validate() {
    const e = {}
    if (!data.name.trim()) e.name = 'Required'
    else if (!/^[a-z0-9][a-z0-9\-]{0,62}$/.test(data.name)) e.name = 'Lowercase letters, numbers, hyphens only'
    if (!data.registry.trim()) e.registry = 'Required'
    if (step === 2 && data.stackType === 'prebuilt' && !data.template) e.template = 'Select a template'
    if (step === 2 && data.stackType === 'image' && data.images.every(img => !img.name || !img.image)) e.images = 'Add at least one service with a name and image'
    if (step === 3 && data.environments.some(e => !e.name.trim())) e.envs = 'All environments need a name'
    if (step === 4) {
      const badVols = data.volumes.filter(v => v.name && !v.mountPath)
      if (badVols.length > 0) e.volumes = 'Each volume needs a mount path'
    }
    setErrors(e)
    return Object.keys(e).length === 0
  }

  function next() {
    if (!validate()) return
    setStep(s => s + 1)
  }

  function buildPayload() {
    const isImage = data.stackType === 'prebuilt' || data.stackType === 'image'
    return {
      name: data.name.trim(),
      registry: data.registry.trim(),
      type: isImage ? 'image' : 'custom',
      template: data.stackType === 'prebuilt' ? data.template : '',
      images: data.stackType === 'image'
        ? data.images.filter(img => img.name && img.image).map(img => ({
            name: img.name, image: img.image, tag: img.tag || 'latest',
            port: parseInt(img.container_port) || 0,
            host_port: img.host_port, volumes: [], depends_on: [], extra_ports: [],
          }))
        : [],
      custom_env_vars: data.stackType === 'image' ? data.customEnvVars : {},
      initial_env_vars: data.initialEnvVars,
      named_volumes: data.volumes.filter(v => v.name && v.mountPath),
      backup: {
        enabled: data.backup.enabled,
        target_id: data.backup.targetId,
        target_name: data.backup.targetName,
        schedule: data.backup.schedule,
        retention: data.backup.retention,
      },
      backend: isImage ? '' : data.backend,
      frontend: isImage ? 'none' : data.frontend,
      database: isImage ? 'none' : data.database,
      redis: isImage ? false : data.redis,
      garage: isImage ? false : data.garage,
      environments: data.environments.filter(e => e.name).map(e => ({
        ...e,
        // ssl_enabled is only valid when Traefik is on and a domain is set
        ssl_enabled: e.traefik && !!e.domain && !!e.ssl_enabled,
      })),
      versions: {},
    }
  }

  function handleDone() {
    qc.invalidateQueries({ queryKey: ['workspaces'] })
    navigate(`/workspaces/${data.name}`)
  }

  return (
    <div className="min-h-screen bg-gray-950 flex flex-col">
      {/* Nav bar (same style as Layout) */}
      <nav className="border-b border-gray-800 bg-gray-900 shrink-0">
        <div className="px-6 h-12 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <img src="/dads-icon.png" alt="DADS" className="w-8 h-8 rounded-lg" />
            <span className="text-gray-400 text-sm">New workspace</span>
          </div>
          <button onClick={() => navigate(-1)} className="text-sm font-medium px-4 py-1.5 rounded-lg border border-amber-700/60 bg-amber-900/30 hover:bg-amber-800/50 text-amber-300 transition-colors">
            Cancel
          </button>
        </div>
      </nav>

      {/* Wizard body */}
      <div className="flex-1 flex items-start justify-center p-8">
        <div className="w-full max-w-2xl">
          <Stepper current={step} />

          <div className="bg-gray-900 border border-gray-800 rounded-2xl p-8">
            {step === 1 && <Step1 data={data} onChange={update} errors={errors} />}
            {step === 2 && <Step2 data={data} onChange={update} />}
            {step === 3 && <Step3 data={data} onChange={update} />}
            {step === 4 && <Step4 data={data} onChange={update} errors={errors} />}
            {step === 5 && <Step5 data={data} onChange={update} />}
            {step === 6 && <Step6 data={data} />}
            {step === 7 && <Step7 workspace={buildPayload()} onDone={handleDone} />}

            {/* Navigation buttons (hidden on step 7) */}
            {step < 7 && (
              <div className="flex items-center justify-between mt-8 pt-6 border-t border-gray-800">
                <button
                  type="button"
                  onClick={() => step > 1 ? setStep(s => s - 1) : navigate(-1)}
                  className={`text-sm font-medium px-4 py-2 rounded-lg border transition-colors ${
                    step === 1
                      ? 'border-amber-700/60 bg-amber-900/30 hover:bg-amber-800/50 text-amber-300'
                      : 'border-gray-700 bg-gray-800 hover:bg-gray-700 text-gray-300'
                  }`}
                >
                  {step === 1 ? 'Cancel' : '← Back'}
                </button>
                <button
                  type="button"
                  onClick={step === 6 ? () => { if (validate()) setStep(7) } : next}
                  className="bg-brand-600 hover:bg-brand-700 text-white text-sm font-semibold px-6 py-2 rounded-lg transition-colors"
                >
                  {step === 6 ? 'Create workspace' : 'Continue →'}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
