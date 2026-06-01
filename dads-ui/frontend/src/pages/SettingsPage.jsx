import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import Layout from '../components/Layout'
import {
  fetchBackupTargets, createBackupTarget, updateBackupTarget, deleteBackupTarget,
  fetchRegistries, createRegistry, updateRegistry, deleteRegistry, testRegistry,
  fetchGeneralSettings, updateGeneralSettings,
} from '../lib/api'

// ── Shared primitives ─────────────────────────────────────────────────────────

function Label({ children, required }) {
  return (
    <label className="block text-xs font-semibold text-gray-400 uppercase tracking-wider mb-1">
      {children}{required && <span className="text-red-400 ml-0.5">*</span>}
    </label>
  )
}

function Input({ value, onChange, placeholder, type = 'text', disabled, ...rest }) {
  return (
    <input
      type={type} value={value ?? ''} onChange={e => onChange(e.target.value)}
      placeholder={placeholder} disabled={disabled}
      className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white placeholder-gray-500 text-sm focus:outline-none focus:border-brand-500 transition-colors disabled:opacity-50"
      {...rest}
    />
  )
}

function Select({ value, onChange, options, disabled }) {
  return (
    <select
      value={value} onChange={e => onChange(e.target.value)} disabled={disabled}
      className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:border-brand-500 disabled:opacity-50"
    >
      {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  )
}

function Toggle({ checked, onChange, label }) {
  return (
    <label className="flex items-center gap-2 cursor-pointer select-none">
      <button
        type="button" onClick={() => onChange(!checked)}
        className={`relative w-9 h-5 rounded-full transition-colors ${checked ? 'bg-brand-600' : 'bg-gray-700'}`}
      >
        <span className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${checked ? 'translate-x-4' : ''}`} />
      </button>
      <span className="text-sm text-gray-300">{label}</span>
    </label>
  )
}

function Btn({ onClick, disabled, variant = 'primary', children, type = 'button', size = 'md' }) {
  const base = 'font-semibold rounded-lg transition-colors focus:outline-none'
  const sizes = { sm: 'px-3 py-1.5 text-xs', md: 'px-4 py-2 text-sm' }
  const variants = {
    primary:   'bg-brand-600 hover:bg-brand-700 text-white disabled:opacity-50',
    secondary: 'bg-gray-700 hover:bg-gray-600 text-gray-200 disabled:opacity-50',
    danger:    'bg-red-900/60 hover:bg-red-800 text-red-300 disabled:opacity-50',
    ghost:     'text-gray-400 hover:text-white hover:bg-gray-800 disabled:opacity-50',
  }
  return (
    <button type={type} onClick={onClick} disabled={disabled}
      className={`${base} ${sizes[size]} ${variants[variant]}`}>
      {children}
    </button>
  )
}

function EmptyState({ icon, title, description, action }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <div className="text-4xl mb-3 opacity-40">{icon}</div>
      <p className="text-gray-300 font-medium mb-1">{title}</p>
      <p className="text-sm text-gray-500 mb-4">{description}</p>
      {action}
    </div>
  )
}

function ConfirmDeleteModal({ name, onConfirm, onClose, loading }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-gray-900 border border-gray-800 rounded-xl w-full max-w-sm mx-4 p-6 space-y-4" onClick={e => e.stopPropagation()}>
        <h3 className="font-semibold text-white">Delete {name}?</h3>
        <p className="text-sm text-gray-400">This cannot be undone.</p>
        <div className="flex gap-2 justify-end pt-2">
          <Btn variant="secondary" onClick={onClose}>Cancel</Btn>
          <Btn variant="danger" onClick={onConfirm} disabled={loading}>
            {loading ? 'Deleting…' : 'Delete'}
          </Btn>
        </div>
      </div>
    </div>
  )
}

// ── Backup Targets ─────────────────────────────────────────────────────────────

const S3_DEFAULT = { endpoint: '', bucket: '', region: 'us-east-1', access_key: '', secret_key: '', path_prefix: 'backups/', use_ssl: true }
const SFTP_DEFAULT = { host: '', port: 22, username: '', auth_type: 'password', password: '', private_key: '', remote_path: '/backups' }

function BackupTargetForm({ initial, onSave, onCancel, saving }) {
  const isEdit = !!initial?.id
  const [name, setName]   = useState(initial?.name || '')
  const [type, setType]   = useState(initial?.type || 's3')
  const [cfg, setCfg]     = useState(() => {
    if (initial?.config) {
      try { return JSON.parse(typeof initial.config === 'string' ? initial.config : JSON.stringify(initial.config)) }
      catch { /* fallthrough */ }
    }
    return type === 's3' ? { ...S3_DEFAULT } : { ...SFTP_DEFAULT }
  })
  const [error, setError] = useState('')

  function setField(key, val) { setCfg(c => ({ ...c, [key]: val })) }

  function handleTypeChange(t) {
    setType(t)
    setCfg(t === 's3' ? { ...S3_DEFAULT } : { ...SFTP_DEFAULT })
  }

  async function submit(e) {
    e.preventDefault()
    setError('')
    if (!name.trim()) { setError('Name is required'); return }
    try {
      await onSave({ name: name.trim(), type, config: cfg })
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to save')
    }
  }

  return (
    <form onSubmit={submit} className="space-y-5">
      <div className="grid grid-cols-2 gap-4">
        <div>
          <Label required>Name</Label>
          <Input value={name} onChange={setName} placeholder="my-s3-backup" />
        </div>
        <div>
          <Label required>Type</Label>
          <Select value={type} onChange={handleTypeChange} disabled={isEdit}
            options={[{ value: 's3', label: 'S3 / Object Storage' }, { value: 'sftp', label: 'SFTP' }]} />
        </div>
      </div>

      {type === 's3' && (
        <div className="space-y-4 border border-gray-700/60 rounded-lg p-4">
          <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider">S3 Configuration</p>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label required>Endpoint</Label>
              <Input value={cfg.endpoint} onChange={v => setField('endpoint', v)} placeholder="s3.amazonaws.com" />
              <p className="text-xs text-gray-600 mt-1">Use custom endpoint for MinIO / Wasabi / R2</p>
            </div>
            <div>
              <Label required>Bucket</Label>
              <Input value={cfg.bucket} onChange={v => setField('bucket', v)} placeholder="my-backups" />
            </div>
            <div>
              <Label>Region</Label>
              <Input value={cfg.region} onChange={v => setField('region', v)} placeholder="us-east-1" />
            </div>
            <div>
              <Label>Path Prefix</Label>
              <Input value={cfg.path_prefix} onChange={v => setField('path_prefix', v)} placeholder="backups/" />
            </div>
            <div>
              <Label required>Access Key</Label>
              <Input value={cfg.access_key} onChange={v => setField('access_key', v)} placeholder="AKIAIOSFODNN7EXAMPLE" />
            </div>
            <div>
              <Label required>Secret Key</Label>
              <Input value={cfg.secret_key} onChange={v => setField('secret_key', v)} type="password" placeholder="••••••••" />
            </div>
          </div>
          <Toggle checked={cfg.use_ssl} onChange={v => setField('use_ssl', v)} label="Use SSL/TLS" />
        </div>
      )}

      {type === 'sftp' && (
        <div className="space-y-4 border border-gray-700/60 rounded-lg p-4">
          <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider">SFTP Configuration</p>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label required>Host</Label>
              <Input value={cfg.host} onChange={v => setField('host', v)} placeholder="backup.example.com" />
            </div>
            <div>
              <Label required>Port</Label>
              <Input value={cfg.port} onChange={v => setField('port', parseInt(v) || 22)} type="number" placeholder="22" />
            </div>
            <div>
              <Label required>Username</Label>
              <Input value={cfg.username} onChange={v => setField('username', v)} placeholder="backup" />
            </div>
            <div>
              <Label required>Remote Path</Label>
              <Input value={cfg.remote_path} onChange={v => setField('remote_path', v)} placeholder="/backups" />
            </div>
          </div>
          <div>
            <Label required>Authentication</Label>
            <Select value={cfg.auth_type} onChange={v => setField('auth_type', v)}
              options={[{ value: 'password', label: 'Password' }, { value: 'key', label: 'SSH Private Key' }]} />
          </div>
          {cfg.auth_type === 'password' && (
            <div>
              <Label required>Password</Label>
              <Input value={cfg.password} onChange={v => setField('password', v)} type="password" placeholder="••••••••" />
            </div>
          )}
          {cfg.auth_type === 'key' && (
            <div>
              <Label required>Private Key</Label>
              <textarea
                value={cfg.private_key} onChange={e => setField('private_key', e.target.value)}
                placeholder="-----BEGIN OPENSSH PRIVATE KEY-----&#10;..."
                rows={6}
                className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white placeholder-gray-500 text-xs font-mono focus:outline-none focus:border-brand-500 resize-none"
              />
            </div>
          )}
        </div>
      )}

      {error && <p className="text-sm text-red-400 bg-red-950/40 border border-red-800/50 rounded-lg px-3 py-2">{error}</p>}

      <div className="flex gap-2 justify-end pt-2">
        <Btn variant="secondary" onClick={onCancel}>Cancel</Btn>
        <Btn type="submit" disabled={saving}>{saving ? 'Saving…' : isEdit ? 'Save changes' : 'Add target'}</Btn>
      </div>
    </form>
  )
}

function BackupTargetsTab() {
  const qc = useQueryClient()
  const { data: targets = [], isLoading } = useQuery({ queryKey: ['backup-targets'], queryFn: fetchBackupTargets })
  const [modal, setModal] = useState(null) // null | 'new' | { editing: target }
  const [deleting, setDeleting] = useState(null)

  const saveMut = useMutation({
    mutationFn: ({ id, body }) => id ? updateBackupTarget(id, body) : createBackupTarget(body),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['backup-targets'] }); setModal(null) },
  })

  const delMut = useMutation({
    mutationFn: (id) => deleteBackupTarget(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['backup-targets'] }); setDeleting(null) },
  })

  function handleSave(body) {
    const id = modal?.editing?.id
    return saveMut.mutateAsync({ id, body })
  }

  if (isLoading) return <div className="py-12 text-center text-gray-500 text-sm">Loading…</div>

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-base font-semibold text-white">Backup Targets</h2>
          <p className="text-sm text-gray-500 mt-0.5">S3-compatible object storage and SFTP destinations for workspace backups.</p>
        </div>
        <Btn onClick={() => setModal('new')}>＋ Add target</Btn>
      </div>

      {targets.length === 0 ? (
        <EmptyState
          icon="🗄"
          title="No backup targets configured"
          description="Add an S3 bucket or SFTP server to enable off-site backups."
          action={<Btn onClick={() => setModal('new')}>＋ Add first target</Btn>}
        />
      ) : (
        <div className="space-y-2">
          {targets.map(t => (
            <div key={t.id} className="flex items-center gap-4 p-4 bg-gray-900 border border-gray-800 rounded-xl">
              <div className="flex-shrink-0">
                <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold uppercase tracking-wider
                  ${t.type === 's3' ? 'bg-amber-900/60 text-amber-300' : 'bg-cyan-900/60 text-cyan-300'}`}>
                  {t.type}
                </span>
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-white">{t.name}</p>
                <p className="text-xs text-gray-500 mt-0.5 truncate">
                  {t.type === 's3'
                    ? `${t.config?.endpoint || 's3'} / ${t.config?.bucket || '—'}`
                    : `${t.config?.username || ''}@${t.config?.host || '—'}:${t.config?.port || 22}`
                  }
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Btn variant="ghost" size="sm" onClick={() => setModal({ editing: t })}>Edit</Btn>
                <Btn variant="danger" size="sm" onClick={() => setDeleting(t)}>Delete</Btn>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Add / Edit modal */}
      {modal && (
        <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 backdrop-blur-sm overflow-y-auto py-8">
          <div className="bg-gray-900 border border-gray-800 rounded-xl w-full max-w-2xl mx-4 p-6" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-5">
              <h3 className="font-semibold text-white">{modal === 'new' ? 'Add backup target' : `Edit "${modal.editing.name}"`}</h3>
              <button onClick={() => setModal(null)} className="text-gray-500 hover:text-white text-xl">×</button>
            </div>
            <BackupTargetForm
              initial={modal === 'new' ? null : modal.editing}
              onSave={handleSave}
              onCancel={() => setModal(null)}
              saving={saveMut.isPending}
            />
          </div>
        </div>
      )}

      {/* Delete confirm */}
      {deleting && (
        <ConfirmDeleteModal
          name={`"${deleting.name}"`}
          onConfirm={() => delMut.mutate(deleting.id)}
          onClose={() => setDeleting(null)}
          loading={delMut.isPending}
        />
      )}
    </div>
  )
}

// ── Docker Registries ─────────────────────────────────────────────────────────

function RegistryForm({ initial, onSave, onCancel, saving }) {
  const isEdit = !!initial?.id
  const [name, setName]         = useState(initial?.name || '')
  const [url, setUrl]           = useState(initial?.url || '')
  const [username, setUsername] = useState(initial?.username || '')
  const [password, setPassword] = useState('')
  const [error, setError]       = useState('')

  async function submit(e) {
    e.preventDefault()
    setError('')
    if (!name.trim() || !url.trim() || !username.trim()) { setError('Name, URL, and username are required'); return }
    if (!isEdit && !password) { setError('Password is required'); return }
    try {
      await onSave({ name: name.trim(), url: url.trim(), username: username.trim(), password })
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to save')
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <div>
          <Label required>Display name</Label>
          <Input value={name} onChange={setName} placeholder="My Registry" />
        </div>
        <div>
          <Label required>Registry URL</Label>
          <Input value={url} onChange={setUrl} placeholder="registry.example.com" />
          <p className="text-xs text-gray-600 mt-1">e.g. docker.io, ghcr.io, registry.example.com</p>
        </div>
        <div>
          <Label required>Username</Label>
          <Input value={username} onChange={setUsername} placeholder="myuser" />
        </div>
        <div>
          <Label required={!isEdit}>Password / Token</Label>
          <Input value={password} onChange={setPassword} type="password" placeholder={isEdit ? '(unchanged)' : '••••••••'} />
          {isEdit && <p className="text-xs text-gray-600 mt-1">Leave blank to keep existing password</p>}
        </div>
      </div>

      {error && <p className="text-sm text-red-400 bg-red-950/40 border border-red-800/50 rounded-lg px-3 py-2">{error}</p>}

      <div className="flex gap-2 justify-end pt-2">
        <Btn variant="secondary" onClick={onCancel}>Cancel</Btn>
        <Btn type="submit" disabled={saving}>{saving ? 'Saving…' : isEdit ? 'Save changes' : 'Add registry'}</Btn>
      </div>
    </form>
  )
}

function RegistriesTab() {
  const qc = useQueryClient()
  const { data: regs = [], isLoading } = useQuery({ queryKey: ['registries'], queryFn: fetchRegistries })
  const [modal, setModal]   = useState(null)
  const [deleting, setDeleting] = useState(null)
  const [testStatus, setTestStatus] = useState({}) // id -> { loading, ok, error }

  const saveMut = useMutation({
    mutationFn: ({ id, body }) => id ? updateRegistry(id, body) : createRegistry(body),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['registries'] }); setModal(null) },
  })

  const delMut = useMutation({
    mutationFn: (id) => deleteRegistry(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['registries'] }); setDeleting(null) },
  })

  async function handleTest(id) {
    setTestStatus(s => ({ ...s, [id]: { loading: true } }))
    try {
      await testRegistry(id)
      setTestStatus(s => ({ ...s, [id]: { ok: true } }))
    } catch (err) {
      setTestStatus(s => ({ ...s, [id]: { error: err.response?.data?.error || 'Login failed' } }))
    }
    setTimeout(() => setTestStatus(s => { const n = { ...s }; delete n[id]; return n }), 5000)
  }

  function handleSave(body) {
    const id = modal?.editing?.id
    return saveMut.mutateAsync({ id, body })
  }

  if (isLoading) return <div className="py-12 text-center text-gray-500 text-sm">Loading…</div>

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-base font-semibold text-white">Docker Registries</h2>
          <p className="text-sm text-gray-500 mt-0.5">Pre-authenticated registries available when creating new workspaces.</p>
        </div>
        <Btn onClick={() => setModal('new')}>＋ Add registry</Btn>
      </div>

      {regs.length === 0 ? (
        <EmptyState
          icon="📦"
          title="No registries configured"
          description="Add a Docker registry to pull private images when creating workspaces."
          action={<Btn onClick={() => setModal('new')}>＋ Add first registry</Btn>}
        />
      ) : (
        <div className="space-y-2">
          {regs.map(r => {
            const ts = testStatus[r.id]
            return (
              <div key={r.id} className="flex items-center gap-4 p-4 bg-gray-900 border border-gray-800 rounded-xl">
                <div className="flex-shrink-0 w-8 h-8 rounded-lg bg-gray-800 flex items-center justify-center text-sm">
                  📦
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-white">{r.name}</p>
                  <p className="text-xs text-gray-500 mt-0.5">{r.url} · {r.username}</p>
                </div>
                <div className="flex items-center gap-2">
                  {ts?.loading && <span className="text-xs text-gray-500">Testing…</span>}
                  {ts?.ok && <span className="text-xs text-green-400">✓ Connected</span>}
                  {ts?.error && <span className="text-xs text-red-400 max-w-[180px] truncate" title={ts.error}>{ts.error}</span>}
                  <Btn variant="ghost" size="sm" onClick={() => handleTest(r.id)} disabled={ts?.loading}>Test</Btn>
                  <Btn variant="ghost" size="sm" onClick={() => setModal({ editing: r })}>Edit</Btn>
                  <Btn variant="danger" size="sm" onClick={() => setDeleting(r)}>Delete</Btn>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {modal && (
        <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 backdrop-blur-sm overflow-y-auto py-8">
          <div className="bg-gray-900 border border-gray-800 rounded-xl w-full max-w-lg mx-4 p-6" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-5">
              <h3 className="font-semibold text-white">{modal === 'new' ? 'Add registry' : `Edit "${modal.editing.name}"`}</h3>
              <button onClick={() => setModal(null)} className="text-gray-500 hover:text-white text-xl">×</button>
            </div>
            <RegistryForm
              initial={modal === 'new' ? null : modal.editing}
              onSave={handleSave}
              onCancel={() => setModal(null)}
              saving={saveMut.isPending}
            />
          </div>
        </div>
      )}

      {deleting && (
        <ConfirmDeleteModal
          name={`"${deleting.name}"`}
          onConfirm={() => delMut.mutate(deleting.id)}
          onClose={() => setDeleting(null)}
          loading={delMut.isPending}
        />
      )}
    </div>
  )
}

// ── General Settings Tab ──────────────────────────────────────────────────────

function GeneralTab() {
  const qc = useQueryClient()
  const { data: cfg = {}, isLoading } = useQuery({
    queryKey: ['general-settings'],
    queryFn: fetchGeneralSettings,
  })
  const [acmeEmail, setAcmeEmail] = useState('')
  const [dadsDomain, setDadsDomain] = useState('')

  // Seed local state once loaded
  useState(() => {
    if (cfg.acme_email !== undefined) setAcmeEmail(cfg.acme_email || '')
    if (cfg.dads_domain !== undefined) setDadsDomain(cfg.dads_domain || '')
  })

  const saveMut = useMutation({
    mutationFn: () => updateGeneralSettings({ acme_email: acmeEmail, dads_domain: dadsDomain }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['general-settings'] }),
  })

  // Sync from loaded data when it arrives
  const [synced, setSynced] = useState(false)
  if (!isLoading && !synced && cfg.acme_email !== undefined) {
    setAcmeEmail(cfg.acme_email || '')
    setDadsDomain(cfg.dads_domain || '')
    setSynced(true)
  }

  if (isLoading) return <div className="py-12 text-center text-gray-500 text-sm">Loading…</div>

  return (
    <div className="space-y-8 max-w-2xl">
      {/* SSL / Let's Encrypt */}
      <div>
        <h2 className="text-base font-semibold text-white mb-1">SSL Certificates — Let's Encrypt</h2>
        <p className="text-sm text-gray-500 mb-4">
          Traefik automatically issues and renews certificates via Let's Encrypt. Set your email
          below — it is sent to Let's Encrypt for cert expiry notifications and account recovery.
        </p>

        <div className="space-y-4 p-4 bg-gray-900 border border-gray-800 rounded-xl">
          <div>
            <Label required>ACME email address</Label>
            <Input
              value={acmeEmail}
              onChange={setAcmeEmail}
              placeholder="admin@example.com"
              type="email"
            />
            <p className="text-xs text-gray-500 mt-1">
              Must match the <code className="font-mono text-xs">ACME_EMAIL</code> value in{' '}
              <code className="font-mono text-xs">dads-ui/.env</code>. Traefik reads it from there;
              this field stores it for reference and future automation.
            </p>
          </div>

          <div className="px-4 py-3 bg-amber-950/40 border border-amber-800/50 rounded-lg">
            <p className="text-xs text-amber-300 font-semibold mb-1">Requirements for SSL to work</p>
            <ul className="text-xs text-amber-400 space-y-0.5 list-disc pl-4">
              <li>Port 80 must be publicly reachable (for the HTTP-01 ACME challenge)</li>
              <li>Each domain must have a DNS A record pointing to this server</li>
              <li>Let's Encrypt rate limits: max 5 certs per domain per week</li>
            </ul>
          </div>
        </div>
      </div>

      {/* DADS domain */}
      <div>
        <h2 className="text-base font-semibold text-white mb-1">DADS UI Domain</h2>
        <p className="text-sm text-gray-500 mb-4">
          Optionally expose the DADS UI itself through Traefik with an SSL cert.
          After setting this, uncomment the <code className="font-mono text-xs">labels</code> block
          in <code className="font-mono text-xs">dads-ui/docker-compose.yml</code> and rebuild.
        </p>

        <div className="p-4 bg-gray-900 border border-gray-800 rounded-xl">
          <Label>DADS UI domain</Label>
          <Input
            value={dadsDomain}
            onChange={setDadsDomain}
            placeholder="dads.example.com"
          />
          <p className="text-xs text-gray-500 mt-1">
            Leave blank to access DADS UI on port {' '}
            <code className="font-mono text-xs">DADS_UI_PORT</code> only.
          </p>
        </div>
      </div>

      {/* Save */}
      <div className="flex items-center gap-3">
        <Btn onClick={() => saveMut.mutate()} disabled={saveMut.isPending}>
          {saveMut.isPending ? 'Saving…' : 'Save settings'}
        </Btn>
        {saveMut.isSuccess && (
          <span className="text-xs text-green-400">✓ Saved</span>
        )}
      </div>
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

const TABS = [
  { id: 'general',        label: 'General' },
  { id: 'registries',     label: 'Docker Registries' },
  { id: 'backup-targets', label: 'Backup Targets' },
]

export default function SettingsPage() {
  const [tab, setTab] = useState('general')

  return (
    <Layout>
      <div className="max-w-4xl mx-auto px-6 py-8">
        {/* Page header */}
        <div className="mb-6">
          <h1 className="text-xl font-bold text-white">Settings</h1>
          <p className="text-sm text-gray-500 mt-0.5">Configure SSL, integrations, and backup destinations.</p>
        </div>

        {/* Tab bar */}
        <div className="flex gap-1 border-b border-gray-800 mb-6">
          {TABS.map(t => (
            <button
              key={t.id} onClick={() => setTab(t.id)}
              className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors -mb-px ${
                tab === t.id
                  ? 'border-brand-500 text-brand-400'
                  : 'border-transparent text-gray-500 hover:text-gray-300'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* Tab content */}
        {tab === 'general'        && <GeneralTab />}
        {tab === 'registries'     && <RegistriesTab />}
        {tab === 'backup-targets' && <BackupTargetsTab />}
      </div>
    </Layout>
  )
}
