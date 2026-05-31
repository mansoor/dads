import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { fetchStats, fetchWorkspaces, fetchEnvStatus } from '../lib/api'
import Layout from '../components/Layout'

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt(n, decimals = 1) {
  return n == null ? '—' : Number(n).toFixed(decimals)
}

function formatUptime(seconds) {
  if (!seconds) return '—'
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (d > 0) return `${d}d ${h}h ${m}m`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

// ── Stat card ─────────────────────────────────────────────────────────────────

function StatCard({ label, value, sub, accent, icon }) {
  const colors = {
    green:  { card: 'border-green-500/20  bg-green-500/5',  val: 'text-green-400'  },
    red:    { card: 'border-red-500/20    bg-red-500/5',    val: 'text-red-400'    },
    blue:   { card: 'border-blue-500/20   bg-blue-500/5',   val: 'text-blue-400'   },
    amber:  { card: 'border-amber-500/20  bg-amber-500/5',  val: 'text-amber-400'  },
    purple: { card: 'border-purple-500/20 bg-purple-500/5', val: 'text-purple-400' },
    gray:   { card: 'border-gray-700      bg-gray-900',     val: 'text-gray-300'   },
  }
  const c = colors[accent] || colors.gray

  return (
    <div className={`rounded-xl border p-5 flex flex-col gap-1 ${c.card}`}>
      <div className="flex items-center justify-between mb-1">
        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider">{label}</p>
        {icon && <span className="text-lg text-gray-600">{icon}</span>}
      </div>
      <p className={`text-3xl font-bold tabular-nums ${c.val}`}>{value ?? '—'}</p>
      {sub && <p className="text-xs text-gray-500 mt-0.5">{sub}</p>}
    </div>
  )
}

// ── Progress bar ──────────────────────────────────────────────────────────────

function ProgressBar({ pct, color = 'brand' }) {
  const colors = {
    brand: 'bg-brand-500',
    green: 'bg-green-500',
    amber: 'bg-amber-400',
    red:   'bg-red-500',
  }
  const barColor = pct > 85 ? colors.red : pct > 65 ? colors.amber : colors[color]
  return (
    <div className="h-1.5 bg-gray-800 rounded-full overflow-hidden">
      <div className={`h-full rounded-full transition-all ${barColor}`} style={{ width: `${Math.min(pct, 100)}%` }} />
    </div>
  )
}

// ── Env status dot (mini) ─────────────────────────────────────────────────────

function EnvDot({ wsName, envName }) {
  const { data } = useQuery({
    queryKey: ['envstatus', wsName, envName],
    queryFn:  () => fetchEnvStatus(wsName, envName),
    refetchInterval: 60_000,
    retry: false,
  })
  const status = data?.status || 'unknown'
  const dot = {
    running: 'bg-green-400',
    partial: 'bg-amber-400 animate-pulse',
    stopped: 'bg-red-500',
    unknown: 'bg-gray-600',
  }
  return (
    <span title={`${envName}: ${status}`} className={`w-2 h-2 rounded-full inline-block shrink-0 ${dot[status] || dot.unknown}`} />
  )
}

// ── Workspace row in the stacks table ─────────────────────────────────────────

function WorkspaceRow({ ws }) {
  const type = ws.type || 'custom'
  return (
    <Link
      to={`/workspaces/${ws.name}`}
      className="flex items-center gap-4 px-4 py-3 hover:bg-gray-800/60 transition-colors rounded-lg group"
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-white group-hover:text-brand-400 transition-colors truncate">{ws.name}</span>
          <span className={`text-xs px-1.5 py-0.5 rounded shrink-0 ${type === 'image' ? 'bg-blue-950 text-blue-300' : 'bg-purple-950 text-purple-300'}`}>
            {type}
          </span>
        </div>
        <p className="text-xs text-gray-500 mt-0.5">{ws.envs?.length || 0} environment{ws.envs?.length !== 1 ? 's' : ''}</p>
      </div>
      <div className="flex items-center gap-1.5 shrink-0">
        {(ws.envs || []).map(env => (
          <div key={env} className="flex flex-col items-center gap-1">
            <EnvDot wsName={ws.name} envName={env} />
            <span className="text-xs text-gray-600">{env}</span>
          </div>
        ))}
      </div>
      <span className="text-gray-600 text-xs group-hover:text-gray-400 transition-colors shrink-0">→</span>
    </Link>
  )
}

// ── Main dashboard ─────────────────────────────────────────────────────────────

export default function DashboardPage() {
  const { data: stats, isLoading: statsLoading } = useQuery({
    queryKey: ['stats'],
    queryFn: fetchStats,
    refetchInterval: 30_000,
  })

  const { data: workspaces } = useQuery({
    queryKey: ['workspaces'],
    queryFn: fetchWorkspaces,
    refetchInterval: 30_000,
  })

  const docker = stats?.docker || {}
  const host   = stats?.host   || {}
  const wsSummary = stats?.workspaces || {}

  const totalEnvs = (workspaces || []).reduce((n, ws) => n + (ws.envs?.length || 0), 0)

  return (
    <Layout>
      <div className="p-6 space-y-6 max-w-6xl">

        {/* Page header */}
        <div>
          <h1 className="text-2xl font-bold text-white">Dashboard</h1>
          <p className="text-sm text-gray-400 mt-0.5">Overview of your Docker stacks and host system</p>
        </div>

        {/* ── Top stat cards ── */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <StatCard
            label="Total stacks"
            value={wsSummary.total ?? '—'}
            sub={`${wsSummary.by_type?.image || 0} image · ${wsSummary.by_type?.custom || 0} custom`}
            accent="blue"
            icon="⬡"
          />
          <StatCard
            label="Environments"
            value={totalEnvs || '—'}
            sub="across all workspaces"
            accent="purple"
            icon="◈"
          />
          <StatCard
            label="Containers running"
            value={docker.containers_running ?? '—'}
            sub={`${docker.containers_stopped ?? '—'} stopped · ${docker.containers_paused ?? '—'} paused`}
            accent={docker.containers_running > 0 ? 'green' : 'gray'}
            icon="▶"
          />
          <StatCard
            label="Docker images"
            value={docker.images_total ?? '—'}
            sub={`${docker.volumes_total ?? '—'} volumes · ${docker.networks_total ?? '—'} networks`}
            accent="gray"
            icon="◻"
          />
        </div>

        {/* ── Middle row: stacks table + docker info ── */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">

          {/* Stacks list */}
          <div className="lg:col-span-2 bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
            <div className="px-5 py-4 border-b border-gray-800 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-gray-300">Stacks</h2>
              <Link to="/new" className="text-xs text-brand-400 hover:text-brand-300 transition-colors">+ New</Link>
            </div>

            {(!workspaces || workspaces.length === 0) ? (
              <div className="px-5 py-8 text-center">
                <p className="text-sm text-gray-500">No workspaces yet.</p>
                <Link to="/new" className="text-xs text-brand-400 hover:text-brand-300 mt-1 inline-block">Create your first →</Link>
              </div>
            ) : (
              <div className="divide-y divide-gray-800/60 px-1 py-1">
                {(wsSummary.workspaces || []).map(ws => (
                  <WorkspaceRow key={ws.name} ws={ws} />
                ))}
              </div>
            )}
          </div>

          {/* Docker info */}
          <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
            <div className="px-5 py-4 border-b border-gray-800">
              <h2 className="text-sm font-semibold text-gray-300">Docker</h2>
            </div>
            {docker.error ? (
              <p className="px-5 py-4 text-xs text-red-400">{docker.error}</p>
            ) : (
              <div className="px-5 py-4 space-y-3 text-sm">
                <InfoRow label="Engine" value={docker.server_version ? `v${docker.server_version}` : '—'} />
                <InfoRow label="Storage driver" value={docker.storage_driver || '—'} />
                <InfoRow label="Root dir" value={docker.docker_root_dir || '—'} mono />
                <div className="pt-2 border-t border-gray-800 space-y-2">
                  <div className="flex justify-between text-xs">
                    <span className="text-gray-500">Containers</span>
                    <div className="flex gap-2">
                      <span className="text-green-400">{docker.containers_running} running</span>
                      <span className="text-gray-600">·</span>
                      <span className="text-gray-400">{docker.containers_stopped} stopped</span>
                    </div>
                  </div>
                  <div className="flex justify-between text-xs">
                    <span className="text-gray-500">Images</span>
                    <span className="text-gray-300">{docker.images_total}</span>
                  </div>
                  <div className="flex justify-between text-xs">
                    <span className="text-gray-500">Volumes</span>
                    <span className="text-gray-300">{docker.volumes_total}</span>
                  </div>
                  <div className="flex justify-between text-xs">
                    <span className="text-gray-500">Networks</span>
                    <span className="text-gray-300">{docker.networks_total}</span>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* ── Bottom row: host system info ── */}
        <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
          <div className="px-5 py-4 border-b border-gray-800">
            <h2 className="text-sm font-semibold text-gray-300">Host system</h2>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-0 divide-y md:divide-y-0 md:divide-x divide-gray-800">

            {/* CPU / System */}
            <div className="px-5 py-4 space-y-2">
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">System</p>
              <InfoRow label="OS" value={host.os || '—'} />
              <InfoRow label="Architecture" value={host.arch || '—'} />
              <InfoRow label="CPU cores" value={host.cpus ?? '—'} />
              <InfoRow label="Uptime" value={formatUptime(host.uptime_seconds)} />
            </div>

            {/* Memory */}
            <div className="px-5 py-4 space-y-3">
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">Memory</p>
              <div className="flex items-end justify-between mb-1">
                <span className="text-2xl font-bold text-white tabular-nums">{fmt(host.mem_used_pct, 0)}<span className="text-sm font-normal text-gray-500">%</span></span>
                <span className="text-xs text-gray-500">used</span>
              </div>
              <ProgressBar pct={host.mem_used_pct} />
              <div className="flex justify-between text-xs text-gray-500 mt-1">
                <span>{fmt(host.mem_avail_mb / 1024, 1)} GB free</span>
                <span>{fmt(host.mem_total_mb / 1024, 1)} GB total</span>
              </div>
            </div>

            {/* Disk */}
            <div className="px-5 py-4 space-y-3">
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">Disk ( / )</p>
              <div className="flex items-end justify-between mb-1">
                <span className="text-2xl font-bold text-white tabular-nums">{fmt(host.disk_used_pct, 0)}<span className="text-sm font-normal text-gray-500">%</span></span>
                <span className="text-xs text-gray-500">used</span>
              </div>
              <ProgressBar pct={host.disk_used_pct} />
              <div className="flex justify-between text-xs text-gray-500 mt-1">
                <span>{fmt(host.disk_total_gb - host.disk_used_gb, 1)} GB free</span>
                <span>{fmt(host.disk_total_gb, 1)} GB total</span>
              </div>
            </div>
          </div>
        </div>

      </div>
    </Layout>
  )
}

function InfoRow({ label, value, mono }) {
  return (
    <div className="flex items-start justify-between gap-2">
      <span className="text-xs text-gray-500 shrink-0">{label}</span>
      <span className={`text-xs text-gray-300 text-right truncate max-w-[60%] ${mono ? 'font-mono' : ''}`} title={value}>{value}</span>
    </div>
  )
}
