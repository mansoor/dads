import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { fetchTemplates, fetchTemplate, openCreateSocket } from '../lib/api'

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

function Step1({ data, onChange, errors }) {
  return (
    <div className="space-y-5">
      <StepHeader step={1} title="Project" subtitle="Name your project and configure the registry." />

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
        <Input
          value={data.registry} onChange={v => onChange('registry', v)}
          placeholder="registry.example.com" error={errors.registry}
        />
      </div>
    </div>
  )
}

// ── Step 2: Stack ─────────────────────────────────────────────────────────────

const STACK_TYPES = [
  { id: 'prebuilt', label: 'Pre-built template',  desc: 'Pick from curated stacks — NPM, WordPress, Vaultwarden, Uptime Kuma…' },
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

function Step2({ data, onChange }) {
  const { data: templates } = useQuery({ queryKey: ['templates'], queryFn: fetchTemplates })

  return (
    <div className="space-y-5">
      <StepHeader step={2} title="Application stack" subtitle="Choose how you want to configure your containers." />

      {/* Type selector */}
      <div className="grid grid-cols-2 gap-3">
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
                onClick={() => onChange('template', tmpl.name)}
              />
            ))}
          </div>
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

const DEFAULT_ENV = { name: '', domain: '', http_port: 8080, https_port: 8443, traefik: false, traefik_network: 'traefik_net', deployment: 'compose', backend_replicas: 1, frontend_replicas: 1, git_enabled: false, git_repo: '', git_branch: '' }
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
        <div>
          <Label>HTTP port</Label>
          <Input type="number" value={env.http_port} onChange={v => upd('http_port', parseInt(v) || 8080)} placeholder="8080" />
        </div>
        <div>
          <Label>HTTPS port</Label>
          <Input type="number" value={env.https_port} onChange={v => upd('https_port', parseInt(v) || 8443)} placeholder="8443" />
        </div>
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
          onChange={v => upd('traefik', v)}
        />
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

// ── Step 4: Review ────────────────────────────────────────────────────────────

function ReviewRow({ label, value }) {
  return (
    <div className="flex items-start justify-between py-2 border-b border-gray-800 last:border-0">
      <span className="text-sm text-gray-400">{label}</span>
      <span className="text-sm text-white font-medium text-right max-w-[60%]">{value || '—'}</span>
    </div>
  )
}

function Step4({ data }) {
  const stackDesc = data.stackType === 'prebuilt'
    ? `Pre-built: ${data.template || '(none selected)'}`
    : `Custom: ${[data.backend, data.frontend !== 'none' && data.frontend, data.database !== 'none' && data.database].filter(Boolean).join(' · ')}`

  return (
    <div className="space-y-5">
      <StepHeader step={4} title="Review" subtitle="Confirm your configuration before creating the workspace." />

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
      </div>

      <div className="bg-amber-950/40 border border-amber-800/50 rounded-xl px-4 py-3">
        <p className="text-sm text-amber-300">
          After creation, edit <code className="font-mono text-xs bg-amber-900/40 px-1 py-0.5 rounded">envs/&#123;env&#125;/.env</code> to fill in secrets before starting the stack.
        </p>
      </div>
    </div>
  )
}

// ── Step 5: Creating (live terminal) ─────────────────────────────────────────

function Step5({ workspace, onDone }) {
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
      <StepHeader step={5} title="Creating workspace" subtitle="Bootstrap output — this takes a few seconds." />
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

const STEPS = ['Project', 'Stack', 'Environments', 'Review', 'Creating']

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
  stackType: 'prebuilt', template: '', backend: 'laravel', frontend: 'none', database: 'postgres', redis: false, garage: false,
  environments: [{ ...DEFAULT_ENV, name: 'prod', http_port: 80, https_port: 443 }],
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
    if (step === 3 && data.environments.some(e => !e.name.trim())) e.envs = 'All environments need a name'
    setErrors(e)
    return Object.keys(e).length === 0
  }

  function next() {
    if (!validate()) return
    setStep(s => s + 1)
  }

  function buildPayload() {
    const type = data.stackType === 'prebuilt' ? 'image' : 'custom'
    return {
      name: data.name.trim(),
      registry: data.registry.trim(),
      type,
      template: data.stackType === 'prebuilt' ? data.template : '',
      backend: data.backend,
      frontend: data.frontend,
      database: data.database,
      redis: data.redis,
      garage: data.garage,
      environments: data.environments.filter(e => e.name),
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
          <div className="flex items-center gap-3">
            <div className="bg-brand-600 text-white text-xs font-bold px-2 py-1 rounded">DADS</div>
            <span className="text-gray-400 text-sm">New workspace</span>
          </div>
          <button onClick={() => navigate(-1)} className="text-sm text-gray-400 hover:text-white transition-colors">
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
            {step === 4 && <Step4 data={data} />}
            {step === 5 && <Step5 workspace={buildPayload()} onDone={handleDone} />}

            {/* Navigation buttons (hidden on step 5) */}
            {step < 5 && (
              <div className="flex items-center justify-between mt-8 pt-6 border-t border-gray-800">
                <button
                  type="button"
                  onClick={() => step > 1 ? setStep(s => s - 1) : navigate(-1)}
                  className="text-sm text-gray-400 hover:text-white transition-colors"
                >
                  {step === 1 ? '← Cancel' : '← Back'}
                </button>
                <button
                  type="button"
                  onClick={step === 4 ? () => { if (validate()) setStep(5) } : next}
                  className="bg-brand-600 hover:bg-brand-700 text-white text-sm font-semibold px-6 py-2 rounded-lg transition-colors"
                >
                  {step === 4 ? 'Create workspace' : 'Continue →'}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
