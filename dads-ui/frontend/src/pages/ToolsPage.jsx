import { useState } from 'react'
import Layout from '../components/Layout'

// ── docker-compose → DADS template converter ──────────────────────────────────
//
// Parses a docker-compose.yml (services block) into a DADS template JSON.
// Handles: image/tag, ports, volumes (named→bind), environment (list+map),
// depends_on (list+map), healthcheck.test, command, restart.

function unquote(s) {
  s = s.trim()
  if ((s.startsWith('"') && s.endsWith('"')) ||
      (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1)
  }
  return s
}

// Split "source:path" or "source:path:ro" correctly (source may contain colons on Windows)
function splitVolume(v) {
  const parts = v.split(':')
  if (parts.length >= 2) {
    const last = parts[parts.length - 1]
    const mode = (last === 'ro' || last === 'rw') ? last : 'rw'
    const pathParts = mode !== 'rw' ? parts.slice(1, -1) : parts.slice(1)
    return { source: parts[0], path: pathParts.join(':'), mode }
  }
  return { source: v, path: '', mode: 'rw' }
}

// Convert a named volume source to a bind mount path
function toBindMount(source, path, mode) {
  const isNamed = !source.startsWith('./') && !source.startsWith('/') && !source.startsWith('$')
  const mountSrc = isNamed ? `./volumes/${source}` : source
  return mode === 'ro' ? `${mountSrc}:${path}:ro` : `${mountSrc}:${path}`
}

// Split image ref into image + tag
function splitImage(ref) {
  ref = unquote(ref)
  // Handle registry/image:tag (don't split on registry colon with port)
  const lastSlash = ref.lastIndexOf('/')
  const afterSlash = ref.slice(lastSlash + 1)
  const colonIdx = afterSlash.lastIndexOf(':')
  if (colonIdx > 0) {
    const base = ref.slice(0, lastSlash + 1) + afterSlash.slice(0, colonIdx)
    const tag  = afterSlash.slice(colonIdx + 1)
    return { image: base, tag }
  }
  return { image: ref, tag: 'latest' }
}

// Extract CMD-SHELL string from healthcheck test formats:
//   test: ["CMD-SHELL", "command"]
//   test: ["CMD", "curl", "-f", "http://localhost"]
//   test: CMD-SHELL command
function extractHealthcheck(val) {
  val = val.trim()
  // Flow sequence: ["CMD-SHELL", "..."]
  const seqMatch = val.match(/^\["CMD(?:-SHELL)?",\s*"(.+)"\]$/)
  if (seqMatch) return seqMatch[1]
  // Simple string
  if (val.startsWith('CMD-SHELL ')) return val.slice(10)
  if (val.startsWith('CMD ')) return val.slice(4)
  return val
}

// Parse the services block from docker-compose YAML.
// Returns array of raw service objects.
function parseServices(text) {
  const lines = text.split('\n')
  const services = []
  let inServices = false
  let cur = null  // current service object

  // We process line by line, tracking indentation.
  // Services block: indent-2 keys are service names, indent-4 keys are properties,
  // indent-6+ are list items or nested map entries.

  let curBlock = null    // 'ports' | 'volumes' | 'environment' | 'depends_on' | 'healthcheck' | null
  let hcBlock  = null    // 'test' | other healthcheck sub-key

  for (let li = 0; li < lines.length; li++) {
    const raw = lines[li]
    const stripped = raw.trimEnd()
    if (!stripped || /^\s*#/.test(stripped)) continue

    const indent  = raw.search(/\S/)
    const content = stripped.trimStart()

    // Detect top-level blocks
    if (indent === 0) {
      inServices = content === 'services:'
      curBlock = null
      if (!inServices) cur = null
      continue
    }

    if (!inServices) continue

    // Service name (indent 2)
    if (indent === 2 && content.endsWith(':') && !content.startsWith('-')) {
      cur = {
        name: content.slice(0, -1),
        image: '', tag: 'latest',
        ports: [], volumes: [], environment: {},
        depends_on: [], healthcheck: '',
        command: '', restart: 'unless-stopped',
      }
      services.push(cur)
      curBlock = null
      continue
    }

    if (!cur) continue

    // Service property (indent 4)
    if (indent === 4 && !content.startsWith('-')) {
      curBlock = null
      hcBlock  = null
      const colon = content.indexOf(':')
      if (colon === -1) continue
      const key = content.slice(0, colon).trim()
      const val = content.slice(colon + 1).trim()

      switch (key) {
        case 'image':   { const p = splitImage(val); cur.image = p.image; cur.tag = p.tag; break }
        case 'command': cur.command = val; break
        case 'restart': cur.restart = val; break
        case 'ports':       curBlock = 'ports';       break
        case 'volumes':     curBlock = 'volumes';     break
        case 'environment': curBlock = 'environment'; break
        case 'depends_on':  curBlock = 'depends_on';  break
        case 'healthcheck': curBlock = 'healthcheck'; break
        default: break
      }
      continue
    }

    // Healthcheck sub-keys (indent 6 inside healthcheck block)
    if (curBlock === 'healthcheck' && indent === 6 && !content.startsWith('-')) {
      const colon = content.indexOf(':')
      if (colon !== -1) {
        const key = content.slice(0, colon).trim()
        const val = content.slice(colon + 1).trim()
        if (key === 'test') {
          cur.healthcheck = extractHealthcheck(val)
          hcBlock = 'test'
        }
      }
      continue
    }

    // List-form healthcheck test continuation (e.g. multi-line flow sequence)
    if (curBlock === 'healthcheck' && hcBlock === 'test' && indent >= 8) continue

    // Block items (indent 6, starting with "- " or map entries for depends_on/environment)
    if (indent === 6) {
      if (content.startsWith('- ')) {
        const item = unquote(content.slice(2).trim())

        if (curBlock === 'ports') {
          cur.ports.push(item)
        } else if (curBlock === 'volumes') {
          cur.volumes.push(item)
        } else if (curBlock === 'environment') {
          // List form: KEY=value or KEY=
          const eqIdx = item.indexOf('=')
          if (eqIdx !== -1) {
            cur.environment[item.slice(0, eqIdx)] = item.slice(eqIdx + 1)
          } else {
            cur.environment[item] = ''
          }
        } else if (curBlock === 'depends_on') {
          cur.depends_on.push(item)
        }
      } else if (!content.startsWith('-')) {
        // Map entry (e.g. environment: KEY: value, depends_on: svc: {condition: …})
        const colon = content.indexOf(':')
        if (colon !== -1) {
          const key = content.slice(0, colon).trim()
          const val = content.slice(colon + 1).trim()

          if (curBlock === 'environment') {
            cur.environment[key] = unquote(val)
          } else if (curBlock === 'depends_on') {
            // Map-form depends_on: service names are the keys
            if (!cur.depends_on.includes(key)) cur.depends_on.push(key)
          }
        }
      }
    }
  }

  return services
}

// Convert parsed services → DADS template
function buildTemplate(services, templateName) {
  const allEnvVars = {}   // collected from all services: key → default value

  const images = services.map(svc => {
    // Ports: first mapping → port/host_port, rest → extra_ports
    const portObjs = svc.ports.map(p => {
      p = unquote(p)
      const parts = p.split(':')
      if (parts.length >= 2) {
        return { host: parts[parts.length - 2], container: parts[parts.length - 1] }
      }
      return { host: '', container: parts[0] }
    })
    const firstPort   = portObjs[0] || { host: '', container: '' }
    const extraPorts  = portObjs.slice(1).map(p =>
      p.host ? `${p.host}:${p.container}` : p.container)

    // Volumes: convert named volumes to bind mounts
    const volumes = svc.volumes
      .map(v => {
        v = unquote(v)
        if (!v.includes(':')) return v  // bare volume name, keep as-is
        const { source, path, mode } = splitVolume(v)
        return toBindMount(source, path, mode)
      })
      .filter(Boolean)

    // Environment: build env_vars with ${VAR} refs; collect defaults
    const envVars = {}
    for (const [k, v] of Object.entries(svc.environment)) {
      // If value looks like it's already a variable ref, keep it
      if (v.startsWith('${') || v.startsWith('$')) {
        envVars[k] = v
      } else {
        envVars[k] = `\${${k}}`
        allEnvVars[k] = v  // original value becomes the default
      }
    }

    // Parse host_port — may be a var ref like ${GHOST_PORT}
    const rawHostPort = firstPort.host
    const hostPortRef = rawHostPort
      ? (rawHostPort.startsWith('$') ? rawHostPort : rawHostPort)
      : ''

    // If host_port was a bare number, keep it; if it's a ${VAR}, keep as env var ref
    return {
      name:      svc.name,
      image:     svc.image,
      tag:       svc.tag,
      port:      parseInt(firstPort.container) || 0,
      host_port: hostPortRef,
      volumes,
      env_vars:  envVars,
      depends_on: svc.depends_on,
      extra_ports: extraPorts,
      healthcheck: svc.healthcheck,
      healthcheck_config: svc.healthcheck ? {
        interval: '30s', timeout: '10s', retries: '3', start_period: '30s',
      } : {},
      restart: svc.restart || 'unless-stopped',
      command: svc.command,
    }
  })

  const name = templateName.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-') || 'my-stack'

  return {
    name,
    label: templateName.trim() || 'My Stack',
    description: '',
    tags: [],
    images,
    default_env_vars: allEnvVars,
  }
}

function convertCompose(yamlText, templateName) {
  try {
    const services = parseServices(yamlText)
    if (!services.length) return { error: 'No services found. Make sure the compose file has a "services:" block.' }
    return { result: buildTemplate(services, templateName) }
  } catch (e) {
    return { error: `Parse error: ${e.message}` }
  }
}

// ── UI ────────────────────────────────────────────────────────────────────────

const PLACEHOLDER = `services:
  app:
    image: ghost:5-alpine
    ports:
      - "\${GHOST_PORT}:2368"
    environment:
      url: \${GHOST_URL}
    volumes:
      - ghost_data:/var/lib/ghost/content
    depends_on:
      - db
    healthcheck:
      test: ["CMD-SHELL", "curl -sf http://localhost:2368/ -o /dev/null || exit 1"]

  db:
    image: mysql:8.0
    environment:
      MYSQL_ROOT_PASSWORD: changeme
      MYSQL_DATABASE: ghost
      MYSQL_USER: ghost_user
      MYSQL_PASSWORD: changeme
    volumes:
      - db_data:/var/lib/mysql`

function ComposeToTemplate() {
  const [input, setInput]         = useState('')
  const [templateName, setName]   = useState('')
  const [output, setOutput]       = useState(null)   // { result } | { error }
  const [copied, setCopied]       = useState(false)

  function convert() {
    if (!input.trim()) return
    setOutput(convertCompose(input, templateName || 'my-stack'))
    setCopied(false)
  }

  function copyResult() {
    if (!output?.result) return
    navigator.clipboard.writeText(JSON.stringify(output.result, null, 2)).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  function downloadResult() {
    if (!output?.result) return
    const blob = new Blob([JSON.stringify(output.result, null, 2)], { type: 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `${output.result.name}.json`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  function saveToTemplates() {
    if (!output?.result) return
    // Download to the templates/stacks/ directory (user must move it manually)
    downloadResult()
  }

  return (
    <div className="space-y-6">
      {/* Tool description */}
      <div className="bg-gray-800/50 border border-gray-700/60 rounded-xl p-4 text-sm text-gray-400 leading-relaxed">
        Paste a <code className="font-mono text-gray-300 text-xs">docker-compose.yml</code> file below.
        The converter extracts services, ports, volumes, environment variables, healthchecks and dependencies,
        and produces a DADS template JSON ready to save in <code className="font-mono text-gray-300 text-xs">templates/stacks/</code>.
        Named volumes are converted to bind mounts. Environment values become <code className="font-mono text-gray-300 text-xs">${'{VAR}'}</code> references
        with original values as defaults.
      </div>

      <div className="grid grid-cols-2 gap-6 items-start">
        {/* Input */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <label className="text-sm font-semibold text-gray-300">docker-compose.yml</label>
            <button onClick={() => setInput(PLACEHOLDER)} className="text-xs text-brand-400 hover:text-brand-300 transition-colors">
              Load example
            </button>
          </div>
          <textarea
            value={input}
            onChange={e => setInput(e.target.value)}
            placeholder={PLACEHOLDER}
            spellCheck={false}
            rows={28}
            className="w-full px-3 py-3 bg-gray-950 border border-gray-700 rounded-xl text-gray-200 text-xs font-mono placeholder-gray-700 focus:outline-none focus:border-brand-500 resize-y leading-relaxed"
          />
          <div className="flex items-center gap-3">
            <div className="flex-1">
              <input
                type="text"
                value={templateName}
                onChange={e => setName(e.target.value)}
                placeholder="Template name (e.g. Ghost CMS)"
                className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm placeholder-gray-500 focus:outline-none focus:border-brand-500"
              />
            </div>
            <button
              onClick={convert}
              disabled={!input.trim()}
              className={`px-5 py-2 text-sm font-semibold rounded-lg transition-colors ${
                input.trim()
                  ? 'bg-brand-600 hover:bg-brand-700 text-white'
                  : 'bg-gray-800 text-gray-600 cursor-not-allowed'
              }`}
            >Convert →</button>
          </div>
        </div>

        {/* Output */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <label className="text-sm font-semibold text-gray-300">DADS template JSON</label>
            {output?.result && (
              <div className="flex items-center gap-2">
                <button onClick={copyResult}
                  className={`text-xs px-2.5 py-1 rounded border transition-colors ${copied ? 'border-green-600 bg-green-950 text-green-400' : 'border-gray-700 text-gray-400 hover:text-gray-200'}`}>
                  {copied ? '✓ Copied' : 'Copy'}
                </button>
                <button onClick={downloadResult}
                  className="text-xs px-2.5 py-1 rounded border border-gray-700 text-gray-400 hover:text-gray-200 transition-colors">
                  ⬇ Download
                </button>
              </div>
            )}
          </div>

          {!output && (
            <div className="h-96 rounded-xl bg-gray-950 border border-gray-800 flex items-center justify-center">
              <p className="text-gray-700 text-sm">Output will appear here</p>
            </div>
          )}

          {output?.error && (
            <div className="rounded-xl bg-red-950/40 border border-red-700/40 p-4">
              <p className="text-red-400 text-sm font-medium">Conversion failed</p>
              <p className="text-red-300/70 text-xs mt-1">{output.error}</p>
            </div>
          )}

          {output?.result && (
            <>
              {/* Summary */}
              <div className="flex items-center gap-3 px-3 py-2 bg-green-950/30 border border-green-700/30 rounded-lg">
                <span className="text-green-400 text-sm">✓</span>
                <span className="text-green-300 text-xs">
                  {output.result.images.length} service{output.result.images.length !== 1 ? 's' : ''} converted
                  — {Object.keys(output.result.default_env_vars).length} env vars extracted
                </span>
              </div>

              {/* Services summary */}
              <div className="flex flex-wrap gap-2">
                {output.result.images.map(img => (
                  <span key={img.name} className="text-xs px-2 py-0.5 rounded-full bg-gray-800 text-gray-400 border border-gray-700 font-mono">
                    {img.name}: {img.image}:{img.tag}
                  </span>
                ))}
              </div>

              {/* JSON output */}
              <pre className="h-80 overflow-auto rounded-xl bg-gray-950 border border-gray-700 p-4 text-xs text-gray-200 font-mono leading-relaxed">
                {JSON.stringify(output.result, null, 2)}
              </pre>

              {/* Save hint */}
              <p className="text-xs text-gray-600">
                Save this file to <code className="font-mono text-gray-500">templates/stacks/{output.result.name}.json</code> to make it available in the New Workspace wizard.
                Rebuild is not required — templates are read from the live-mounted toolkit directory.
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

const TOOLS = [
  {
    id: 'compose-to-template',
    label: 'Compose → Template',
    description: 'Convert a docker-compose.yml into a reusable DADS prebuilt template.',
    component: ComposeToTemplate,
  },
]

export default function ToolsPage() {
  const [activeTool, setActiveTool] = useState(TOOLS[0].id)
  const ActiveComponent = TOOLS.find(t => t.id === activeTool)?.component

  return (
    <Layout>
      <div className="p-6 max-w-[1400px] mx-auto">
        <div className="mb-6">
          <h1 className="text-xl font-bold text-white">Tools</h1>
          <p className="text-sm text-gray-500 mt-0.5">Utilities for working with DADS workspaces and templates.</p>
        </div>

        {/* Tool tabs */}
        <div className="flex items-center gap-1 mb-6 border-b border-gray-800 pb-0">
          {TOOLS.map(tool => (
            <button
              key={tool.id}
              onClick={() => setActiveTool(tool.id)}
              className={`px-4 py-2 text-sm font-medium rounded-t-lg transition-colors border-b-2 -mb-px ${
                activeTool === tool.id
                  ? 'border-brand-500 text-white bg-gray-900'
                  : 'border-transparent text-gray-500 hover:text-gray-300 hover:bg-gray-800/50'
              }`}
            >{tool.label}</button>
          ))}
        </div>

        {/* Active tool */}
        <div className="bg-gray-900 border border-gray-800 rounded-2xl p-6">
          {ActiveComponent && <ActiveComponent />}
        </div>
      </div>
    </Layout>
  )
}
