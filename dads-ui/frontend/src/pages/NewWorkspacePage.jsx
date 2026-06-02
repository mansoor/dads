import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { fetchTemplates, fetchTemplate, openCreateSocket, fetchRegistries, fetchBackupTargets } from '../lib/api'

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

const DEFAULT_IMAGE = {
  name: '', image: '', tag: 'latest',
  portMappings: [{ host: '', container: '' }], // moved from Step 2 to Step 4
  volumes: [],
  healthcheck: '',
  healthcheck_config: { interval: '30', timeout: '10', retries: '3', start_period: '30' },
}

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
          <div className="grid grid-cols-3 gap-3">
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
          </div>
          <p className="text-xs text-gray-600">Port mappings, volumes, and healthcheck configured in Step 4.</p>
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
        <div>
          <Label>Select template</Label>
          <div className="grid grid-cols-2 gap-3 mt-1">
            {(templates || []).map(tmpl => (
              <TemplateCard
                key={tmpl.name}
                tmpl={tmpl}
                selected={data.template === tmpl.name}
                onClick={async () => {
                  onChange('template', tmpl.name)
                  try {
                    const detail = await fetchTemplate(tmpl.name)
                    // Pre-populate per-environment vars from template defaults.
                    // Distribute to ALL current environments so each gets the same starting vars.
                    const envs = detail?.default_envs || detail?.default_env_vars || {}
                    if (Object.keys(envs).length > 0) {
                      // Use a callback-style update to get current environments
                      onChange('_distributeVars', envs) // handled specially in update()
                    }
                    // Pre-populate wizard images so container ports are visible in Step 2.
                    // Template ImageDef uses `port` (int) — map to wizard's `container_port` (string).
                    if (detail?.images?.length > 0) {
                      onChange('images', detail.images.map(img => ({
                        name:           img.name           || '',
                        image:          img.image          || '',
                        tag:            img.tag            || 'latest',
                        container_port: img.port ? String(img.port) : '',
                        host_port:      img.host_port      || '',
                      })))
                      // Pre-populate Step 4 named volumes extracted from template image definitions.
                      // Template volumes are in "volname:/mount/path" format; extract name + mountPath.
                      const seen = new Set()
                      const namedVols = []
                      for (const img of detail.images) {
                        for (const v of (img.volumes || [])) {
                          const parts = v.split(':')
                          // Only named volumes — skip bind mounts (start with . or /)
                          if (parts.length >= 2 && !parts[0].startsWith('.') && !parts[0].startsWith('/')) {
                            const volName = parts[0]
                            const mountPath = parts[1]
                            if (!seen.has(volName)) {
                              seen.add(volName)
                              namedVols.push({ name: volName, mountPath })
                            }
                          }
                        }
                      }
                      if (namedVols.length > 0) onChange('volumes', namedVols)
                    }
                  } catch { /* non-fatal */ }
                }}
              />
            ))}
          </div>
          {data.template && (
            <p className="text-xs text-gray-500 mt-2 flex items-center gap-1.5">
              <span>ℹ</span> Default environment variables and named volumes for this template have been pre-filled in Step 4. Review and update secrets before creating.
            </p>
          )}
        </div>
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

const DEFAULT_ENV = { name: '', domain: '', http_port: 8080, https_port: 8443, traefik: false, traefik_network: 'traefik_net', ssl_enabled: false, deployment: 'compose', backend_replicas: 1, frontend_replicas: 1, git_enabled: false, git_repo: '', git_branch: '', vars: {} }
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

      {/* Per-environment variables */}
      <div className="pt-3 border-t border-gray-700/60">
        <EnvVarsSection vars={env.vars || {}} onChange={v => upd('vars', v)} />
      </div>
    </div>
  )
}

// Collapsible env vars section used inside EnvForm
function EnvVarsSection({ vars, onChange }) {
  const [open, setOpen] = useState(false)
  const count = Object.keys(vars).length
  return (
    <div>
      <button type="button" onClick={() => setOpen(o => !o)}
        className="flex items-center gap-2 text-xs font-semibold text-gray-400 uppercase tracking-wider hover:text-gray-200 transition-colors w-full">
        <span className={`transition-transform ${open ? 'rotate-90' : ''}`}>▶</span>
        Environment Variables
        {count > 0 && <span className="ml-1 text-brand-400 normal-case font-normal">{count} set</span>}
        <span className="ml-auto text-gray-600 normal-case font-normal">per-environment .env values</span>
      </button>
      {open && (
        <div className="mt-3">
          <EnvVarEditor envVars={vars} onChange={onChange} />
        </div>
      )}
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

function VolumeEditor({ volumes, onChange }) {
  function update(idx, field, val) {
    onChange(volumes.map((v, i) => i === idx ? { ...v, [field]: val } : v))
  }
  function add() { onChange([...volumes, { ...DEFAULT_VOLUME }]) }
  function remove(idx) { onChange(volumes.filter((_, i) => i !== idx)) }

  return (
    <div className="space-y-2">
      {volumes.map((vol, i) => (
        <div key={i} className="flex items-center gap-2">
          <input
            type="text" value={vol.name} onChange={e => update(i, 'name', e.target.value)}
            placeholder="db_data"
            className="w-40 px-2 py-1.5 bg-gray-800 border border-gray-700 rounded text-sm text-white font-mono focus:outline-none focus:border-brand-500"
          />
          <span className="text-gray-600 text-xs">→</span>
          <input
            type="text" value={vol.mountPath} onChange={e => update(i, 'mountPath', e.target.value)}
            placeholder="/var/lib/mysql"
            className="flex-1 px-2 py-1.5 bg-gray-800 border border-gray-700 rounded text-sm text-white font-mono focus:outline-none focus:border-brand-500"
          />
          <button type="button" onClick={() => remove(i)} className="text-gray-600 hover:text-red-400 text-sm shrink-0 px-1">×</button>
        </div>
      ))}
      <button
        type="button" onClick={add}
        className="text-xs text-brand-400 hover:text-brand-300 transition-colors"
      >
        + Add volume
      </button>
    </div>
  )
}

const monoInput = 'px-2 py-1.5 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm font-mono focus:outline-none focus:border-brand-500'

function ServiceConfigCard({ img, idx, allImages, onChange }) {
  const upd = (field, val) => onChange(idx, { ...img, [field]: val })
  const portMappings = img.portMappings || [{ host: '', container: '' }]
  const volumes = img.volumes || []
  const hcConfig = img.healthcheck_config || {}

  return (
    <div className="bg-gray-800/50 border border-gray-700 rounded-xl p-4 space-y-4">
      <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
        {img.name || `Service ${idx + 1}`}
        <span className="ml-2 text-gray-600 font-mono font-normal normal-case">{img.image}:{img.tag || 'latest'}</span>
      </p>

      {/* Port mappings */}
      <div>
        <Label>Port mappings</Label>
        <p className="text-xs text-gray-500 mb-2">HOST : CONTAINER — leave host blank for internal-only.</p>
        <div className="space-y-1.5">
          {portMappings.map((row, ri) => (
            <div key={ri} className="flex items-center gap-2">
              <input type="text" value={row.host} placeholder="8080"
                onChange={e => { const r = portMappings.map((x,j) => j===ri ? {...x,host:e.target.value} : x); upd('portMappings', r) }}
                className={`flex-1 ${monoInput}`} />
              <span className="text-gray-500 font-bold shrink-0">:</span>
              <input type="text" value={row.container} placeholder="80"
                onChange={e => { const r = portMappings.map((x,j) => j===ri ? {...x,container:e.target.value} : x); upd('portMappings', r) }}
                className={`flex-1 ${monoInput}`} />
              {portMappings.length > 1 && (
                <button type="button" onClick={() => upd('portMappings', portMappings.filter((_,j)=>j!==ri))}
                  className="text-gray-600 hover:text-red-400 shrink-0">×</button>
              )}
            </div>
          ))}
          <button type="button" onClick={() => upd('portMappings', [...portMappings, {host:'',container:''}])}
            className="text-xs text-brand-400 hover:text-brand-300 transition-colors">＋ Add port</button>
        </div>
      </div>

      {/* Volume mappings */}
      <div>
        <Label>Volume mappings</Label>
        <p className="text-xs text-gray-500 mb-2">SOURCE : CONTAINER PATH — use <code className="font-mono text-xs">./volumes/name</code> for bind mount.</p>
        <div className="space-y-1.5">
          {volumes.map((row, ri) => {
            const parts = typeof row === 'string' ? row.split(':') : [row.source||'', row.path||'']
            return (
              <div key={ri} className="flex items-center gap-2">
                <input type="text" value={parts[0]} placeholder="./volumes/data"
                  onChange={e => { const r=[...volumes]; r[ri]=`${e.target.value}:${parts[1]||''}`; upd('volumes',r) }}
                  className={`flex-1 ${monoInput}`} />
                <span className="text-gray-500 font-bold shrink-0">:</span>
                <input type="text" value={parts[1]||''} placeholder="/var/lib/data"
                  onChange={e => { const r=[...volumes]; r[ri]=`${parts[0]}:${e.target.value}`; upd('volumes',r) }}
                  className={`flex-1 ${monoInput}`} />
                <button type="button" onClick={() => upd('volumes', volumes.filter((_,j)=>j!==ri))}
                  className="text-gray-600 hover:text-red-400 shrink-0">×</button>
              </div>
            )
          })}
          <button type="button" onClick={() => upd('volumes', [...volumes, './volumes/:'])}
            className="text-xs text-brand-400 hover:text-brand-300 transition-colors">＋ Add volume</button>
        </div>
      </div>

      {/* Healthcheck */}
      <div>
        <Label>Healthcheck command</Label>
        <input type="text" value={img.healthcheck || ''} placeholder="curl -sf http://localhost/health || exit 1"
          onChange={e => upd('healthcheck', e.target.value)}
          className={`w-full ${monoInput}`} />
        {img.healthcheck && (
          <div className="grid grid-cols-4 gap-2 mt-2">
            {[['interval','30'],['timeout','10'],['retries','3'],['start_period','30']].map(([k, ph]) => (
              <div key={k}>
                <label className="block text-xs text-gray-500 mb-1">{k.replace('_',' ')} (s)</label>
                <input type="number" min="1" value={(hcConfig[k]||'').replace(/s$/,'')} placeholder={ph}
                  onChange={e => upd('healthcheck_config', {...hcConfig, [k]: e.target.value ? `${e.target.value}s` : ''})}
                  className={`w-full ${monoInput}`} />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function Step4({ data, onChange }) {
  const isImageStack = data.stackType === 'image' || data.stackType === 'prebuilt'
  const showServices = data.stackType === 'image' // prebuilt services come from template, not editable here

  function updateImage(idx, updated) {
    onChange('images', data.images.map((img, i) => i === idx ? updated : img))
  }

  return (
    <div className="space-y-6">
      <StepHeader step={4} title="Ports, Volumes & Healthcheck" subtitle="Configure port mappings, volume mounts, and healthchecks per service." />

      {/* Per-service config (image stacks only — prebuilt comes from template) */}
      {showServices && data.images.filter(img => img.name && img.image).length > 0 && (
        <div className="space-y-4">
          {data.images.filter(img => img.name && img.image).map((img, i) => (
            <ServiceConfigCard key={i} img={img} idx={i} allImages={data.images} onChange={updateImage} />
          ))}
        </div>
      )}

      {data.stackType === 'prebuilt' && data.template && (
        <div className="px-4 py-3 bg-blue-950/30 border border-blue-800/40 rounded-xl">
          <p className="text-xs text-blue-300">
            Port mappings and volumes for <strong>{data.template}</strong> are defined in the template.
            You can adjust them after creation in Edit Workspace.
          </p>
        </div>
      )}

      {/* Extra named volumes (all stack types) */}
      <div className={showServices && data.images.filter(img => img.name).length > 0 ? 'pt-4 border-t border-gray-800' : ''}>
        <Label>Extra named volumes</Label>
        <p className="text-xs text-gray-500 mb-3">
          Additional volumes beyond what services declare above. Use <code className="font-mono text-xs">./volumes/name</code> for bind mount or a plain name for a Docker named volume.
        </p>
        {data.volumes.length === 0 && (
          <p className="text-xs text-gray-600 mb-2 italic">None — add if you need shared or extra volumes.</p>
        )}
        <VolumeEditor volumes={data.volumes} onChange={v => onChange('volumes', v)} />
      </div>

      {/* Template volumes info */}
      {data.stackType === 'prebuilt' && data.templateVolumes?.length > 0 && (
        <div className="pt-4 border-t border-gray-800">
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Template volumes (from {data.template})</p>
          <div className="space-y-1">
            {data.templateVolumes.map((v, i) => (
              <div key={i} className="flex items-center gap-2 px-3 py-1.5 bg-gray-800/40 rounded text-xs font-mono">
                <span className={`px-1.5 py-0.5 rounded text-xs ${v.source.startsWith('./') || v.source.startsWith('/') ? 'bg-blue-950 text-blue-300' : 'bg-purple-950 text-purple-300'}`}>
                  {v.source.startsWith('./') || v.source.startsWith('/') ? 'bind' : 'named'}
                </span>
                <span className="text-gray-300">{v.source}</span>
                <span className="text-gray-600">→</span>
                <span className="text-gray-500">{v.mountPath}</span>
              </div>
            ))}
          </div>
        </div>
      )}
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
        {data.environments.filter(e => Object.keys(e.vars || {}).length > 0).map((e, i) => (
          <ReviewRow key={i} label={`  ${e.name} env vars`} value={`${Object.keys(e.vars).length} variable(s)`} />
        ))}
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
  volumes: [],
  backup: { enabled: true, targetId: null, targetName: 'local', schedule: 'daily', retention: 7 },
}

export default function NewWorkspacePage() {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [step, setStep] = useState(1)
  const [data, setData] = useState(DEFAULT_DATA)
  const [errors, setErrors] = useState({})

  function update(key, value) {
    if (key === '_distributeVars') {
      // Special: distribute template default vars to all current environments
      setData(prev => ({
        ...prev,
        environments: prev.environments.map(e => ({ ...e, vars: { ...value, ...(e.vars || {}) } })),
      }))
      return
    }
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
        ? data.images.filter(img => img.name && img.image).map(img => {
            const ports = (img.portMappings || []).filter(p => p.container)
            return {
              name: img.name, image: img.image, tag: img.tag || 'latest',
              port: parseInt((ports[0] || {}).container) || 0,
              host_port: (ports[0] || {}).host || '',
              extra_ports: ports.slice(1).filter(p => p.host && p.container).map(p => `${p.host}:${p.container}`),
              volumes: (img.volumes || []).filter(v => typeof v === 'string' ? v.includes(':') : v.source),
              depends_on: [],
              healthcheck: img.healthcheck || '',
              healthcheck_config: img.healthcheck_config || {},
            }
          })
        : [],
      custom_env_vars: data.stackType === 'image' ? data.customEnvVars : {},
      initial_env_vars: {}, // env vars now per-environment (in environments[].vars)
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
        ssl_enabled: e.traefik && !!e.domain && !!e.ssl_enabled,
        vars: e.vars || {},
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
