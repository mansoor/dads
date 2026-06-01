import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { fetchStats, fetchEnvStatus } from '../lib/api'
import Layout from '../components/Layout'

// ── Helpers ───────────────────────────────────────────────────────────────────

function safeNum(n) {
  const v = Number(n)
  return isFinite(v) ? v : 0
}

function fmt(n, decimals = 1) {
  const v = safeNum(n)
  return v === 0 && n == null ? '—' : v.toFixed(decimals)
}

function formatUptime(seconds) {
  const s = safeNum(seconds)
  if (s === 0) return '—'
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (d > 0) return `${d}d ${h}h ${m}m`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

// ── Stat card ─────────────────────────────────────────────────────────────────

function StatCard({ label, value, sub, accent }) {
  const styles = {
    green:  'border-green-500/25 bg-green-500/5 text-green-400',
    red:    'border-red-500/25   bg-red-500/5   text-red-400',
    blue:   'border-blue-500/25  bg-blue-500/5  text-blue-400',
    amber:  'border-amber-500/25 bg-amber-500/5 text-amber-400',
    purple: 'border-purple-500/25 bg-purple-500/5 text-purple-400',
    gray:   'border-gray-700     bg-gray-900    text-gray-300',
  }
  const cls = styles[accent] || styles.gray
  const [border, bg, valColor] = cls.split(' ')

  return (
    <div className={`rounded-xl border p-5 flex flex-col gap-1 ${border} ${bg}`}>
      <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1">{label}</p>
      <p className={`text-3xl font-bold tabular-nums ${valColor}`}>{value ?? '—'}</p>
      {sub && <p className="text-xs text-gray-500 mt-0.5">{sub}</p>}
    </div>
  )
}

// ── Progress bar ──────────────────────────────────────────────────────────────

function Bar({ pct }) {
  const p = safeNum(pct)
  const color = p > 85 ? 'bg-red-500' : p > 65 ? 'bg-amber-400' : 'bg-brand-500'
  return (
    <div className="h-2 bg-gray-800 rounded-full overflow-hidden">
      <div className={`h-full rounded-full transition-all ${color}`} style={{ width: `${Math.min(p, 100)}%` }} />
    </div>
  )
}

// ── Env status dot ────────────────────────────────────────────────────────────

function EnvDot({ wsName, envName }) {
  const { data } = useQuery({
    queryKey:      ['envstatus', wsName, envName],
    queryFn:       () => fetchEnvStatus(wsName, envName),
    refetchInterval: 60_000,
    retry: false,
  })
  const status = data?.status || 'unknown'
  const dot = { running: 'bg-green-400', partial: 'bg-amber-400 animate-pulse', stopped: 'bg-red-500', unknown: 'bg-gray-600' }
  return <span title={`${envName}: ${status}`} className={`w-2 h-2 rounded-full inline-block ${dot[status] || dot.unknown}`} />
}

// ── Info row ──────────────────────────────────────────────────────────────────

function InfoRow({ label, value, mono }) {
  return (
    <div className="flex items-start justify-between gap-2 py-1.5 border-b border-gray-800/60 last:border-0">
      <span className="text-xs text-gray-500 shrink-0">{label}</span>
      <span className={`text-xs text-gray-300 text-right truncate max-w-[55%] ${mono ? 'font-mono' : ''}`} title={String(value)}>{value ?? '—'}</span>
    </div>
  )
}

// ── Main ──────────────────────────────────────────────────────────────────────

export default function DashboardPage() {
  const { data: stats, isLoading } = useQuery({
    queryKey:      ['stats'],
    queryFn:       fetchStats,
    refetchInterval: 30_000,
  })

  const docker = stats?.docker || {}
  const host   = stats?.host   || {}
  const ws     = stats?.workspaces || {}
  const workspaces = ws.workspaces || []

  const memFreeMB  = safeNum(host.mem_avail_mb)
  const memTotalMB = safeNum(host.mem_total_mb)
  const diskFreeGB = safeNum(host.disk_free_gb)
  const diskTotalGB = safeNum(host.disk_total_gb)

  return (
    <Layout>
      <div className="p-6 space-y-6 w-full min-w-0 max-w-[1400px]">

        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-white">Dashboard</h1>
            <p className="text-sm text-gray-400 mt-0.5">Overview of your Docker stacks and host system</p>
          </div>
          {isLoading && <span className="text-xs text-gray-600 animate-pulse">Refreshing…</span>}
        </div>

        {/* ── Stat cards ── */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
          <StatCard
            label="Workspaces"
            value={ws.total ?? '—'}
            sub={`${ws.by_type?.image || 0} image · ${ws.by_type?.custom || 0} custom`}
            accent="blue"
          />
          <StatCard
            label="Environments"
            value={workspaces.reduce((n, w) => n + (w.envs?.length || 0), 0) || '—'}
            sub="across all workspaces"
            accent="purple"
          />
          <StatCard
            label="Running containers"
            value={docker.containers_running ?? '—'}
            sub={`${docker.containers_stopped ?? 0} stopped · ${docker.containers_paused ?? 0} paused`}
            accent={docker.containers_running > 0 ? 'green' : 'gray'}
          />
          <StatCard
            label="Docker images"
            value={docker.images_total ?? '—'}
            sub={`${docker.volumes_total ?? 0} volumes`}
            accent="gray"
          />
          <StatCard
            label="Docker networks"
            value={docker.networks_total ?? '—'}
            sub={docker.server_version ? `Engine v${docker.server_version}` : '—'}
            accent="gray"
          />
        </div>

        {/* ── Workspaces table ── */}
        <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
          <div className="px-5 py-4 border-b border-gray-800 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-gray-300">Workspaces</h2>
            <Link to="/new" className="text-xs text-brand-400 hover:text-brand-300 transition-colors font-medium">+ New workspace</Link>
          </div>

          {workspaces.length === 0 ? (
            <div className="px-5 py-10 text-center">
              <p className="text-sm text-gray-500">No workspaces yet.</p>
              <Link to="/new" className="text-xs text-brand-400 hover:text-brand-300 mt-2 inline-block">Create your first workspace →</Link>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-800">
                    <th className="px-5 py-2.5 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Name</th>
                    <th className="px-4 py-2.5 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Type</th>
                    <th className="px-4 py-2.5 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Environments</th>
                    <th className="px-4 py-2.5 text-center text-xs font-semibold text-gray-500 uppercase tracking-wider">Images</th>
                    <th className="px-4 py-2.5 text-center text-xs font-semibold text-gray-500 uppercase tracking-wider">Running</th>
                    <th className="px-4 py-2.5 text-right text-xs font-semibold text-gray-500 uppercase tracking-wider">Disk</th>
                    <th className="px-4 py-2.5 text-right text-xs font-semibold text-gray-500 uppercase tracking-wider">Memory</th>
                    <th className="px-4 py-2.5 text-right text-xs font-semibold text-gray-500 uppercase tracking-wider"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-800">
                  {workspaces.map(w => (
                    <tr key={w.name} className="hover:bg-gray-800/40 transition-colors group">
                      <td className="px-5 py-3">
                        <Link to={`/workspaces/${w.name}`} className="font-medium text-white group-hover:text-brand-400 transition-colors">
                          {w.name}
                        </Link>
                      </td>
                      <td className="px-4 py-3">
                        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                          w.type === 'image' ? 'bg-blue-950 text-blue-300' : 'bg-purple-950 text-purple-300'
                        }`}>{w.type}</span>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-3">
                          {(w.envs || []).map(env => (
                            <div key={env} className="flex items-center gap-1.5">
                              <EnvDot wsName={w.name} envName={env} />
                              <span className="text-xs text-gray-400">{env}</span>
                            </div>
                          ))}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-center">
                        <span className="text-sm text-gray-300 tabular-nums">
                          {w.image_count > 0 ? w.image_count : <span className="text-gray-600">—</span>}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-center">
                        <span className={`text-sm font-medium tabular-nums ${
                          w.running_containers > 0 ? 'text-green-400' : 'text-gray-600'
                        }`}>
                          {w.running_containers > 0 ? w.running_containers : '—'}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <span className="text-xs text-gray-400 tabular-nums">
                          {w.disk_mb >= 1024
                            ? `${(w.disk_mb / 1024).toFixed(1)} GB`
                            : w.disk_mb >= 0.1 ? `${w.disk_mb.toFixed(1)} MB`
                            : w.disk_mb > 0   ? `${(w.disk_mb * 1024).toFixed(0)} KB`
                            : <span className="text-gray-600">—</span>}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <span className={`text-xs tabular-nums ${w.mem_mb > 0 ? 'text-gray-400' : 'text-gray-600'}`}>
                          {w.mem_mb >= 1024
                            ? `${(w.mem_mb / 1024).toFixed(1)} GB`
                            : w.mem_mb >= 0.1 ? `${w.mem_mb.toFixed(1)} MB`
                            : w.mem_mb > 0   ? `${(w.mem_mb * 1024).toFixed(0)} KB`
                            : '—'}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <Link to={`/workspaces/${w.name}`} className="text-xs text-gray-600 group-hover:text-gray-400 transition-colors">
                          Open →
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* ── Bottom: Docker + Host system ── */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">

          {/* Docker info */}
          <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
            <div className="px-5 py-4 border-b border-gray-800">
              <h2 className="text-sm font-semibold text-gray-300">Docker engine</h2>
            </div>
            {docker.error ? (
              <p className="px-5 py-4 text-xs text-red-400">{docker.error}</p>
            ) : (
              <div className="px-5 py-2">
                <InfoRow label="Engine version"   value={docker.server_version ? `v${docker.server_version}` : null} />
                <InfoRow label="Storage driver"   value={docker.storage_driver} />
                <InfoRow label="Root directory"   value={docker.docker_root_dir} mono />
                <InfoRow label="Containers"       value={`${docker.containers_running ?? 0} running · ${docker.containers_stopped ?? 0} stopped · ${docker.containers_paused ?? 0} paused`} />
                <InfoRow label="Images"           value={docker.images_total} />
                <InfoRow label="Volumes"          value={docker.volumes_total} />
                <InfoRow label="Networks"         value={docker.networks_total} />
              </div>
            )}
          </div>

          {/* Host system */}
          <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
            <div className="px-5 py-4 border-b border-gray-800">
              <h2 className="text-sm font-semibold text-gray-300">Host system</h2>
            </div>
            <div className="px-5 py-2">
              <InfoRow label="Operating system" value={host.os} />
              <InfoRow label="Architecture"     value={host.arch} />
              <InfoRow label="CPU cores"        value={host.cpus} />
              <InfoRow label="Uptime"           value={formatUptime(host.uptime_seconds)} />
            </div>
            <div className="px-5 py-4 space-y-4 border-t border-gray-800">
              {/* Memory */}
              <div>
                <div className="flex justify-between mb-1.5">
                  <span className="text-xs text-gray-400 font-medium">Memory</span>
                  <span className="text-xs text-gray-500">
                    {fmt(memFreeMB / 1024)} GB free of {fmt(memTotalMB / 1024)} GB
                  </span>
                </div>
                <Bar pct={safeNum(host.mem_used_pct)} />
                <p className="text-xs text-gray-600 mt-1 text-right">{fmt(host.mem_used_pct, 0)}% used</p>
              </div>
              {/* Disk */}
              <div>
                <div className="flex justify-between mb-1.5">
                  <span className="text-xs text-gray-400 font-medium">Disk ( / )</span>
                  <span className="text-xs text-gray-500">
                    {fmt(diskFreeGB)} GB free of {fmt(diskTotalGB)} GB
                  </span>
                </div>
                <Bar pct={safeNum(host.disk_used_pct)} />
                <p className="text-xs text-gray-600 mt-1 text-right">{fmt(host.disk_used_pct, 0)}% used</p>
              </div>
            </div>
          </div>

        </div>
      </div>
    </Layout>
  )
}
