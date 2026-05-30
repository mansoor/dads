import { Link, useNavigate, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { useAuthStore } from '../store/auth'
import { fetchWorkspaces, fetchEnvStatus } from '../lib/api'

const STATUS_DOT = {
  running: 'bg-green-400',
  partial: 'bg-amber-400 animate-pulse',
  stopped: 'bg-gray-500',
  building: 'bg-amber-400 animate-pulse',
  unknown:  'bg-gray-600',
}

// Polls the first environment of a workspace to determine its dot color
function WorkspaceStatusDot({ name, envs }) {
  const firstEnv = envs?.[0]
  const { data } = useQuery({
    queryKey: ['envstatus', name, firstEnv],
    queryFn: () => fetchEnvStatus(name, firstEnv),
    enabled: !!firstEnv,
    refetchInterval: 30_000,
    retry: false,
  })
  const status = data?.status || 'unknown'
  return <span className={`w-2 h-2 rounded-full shrink-0 ${STATUS_DOT[status] || STATUS_DOT.unknown}`} />
}

function WorkspaceSidebarItem({ ws, active }) {
  const cfg = ws.config
  const type = cfg?.project?.type || 'custom'
  const envs = ws.envs || []

  // Derive a short stack description from config
  let stackLine = ''
  if (type === 'image') {
    const images = cfg?.images || []
    stackLine = images.map(i => i.image?.split('/').pop()).join(' · ')
  } else {
    const firstEnv = cfg?.environments?.[envs[0]] || {}
    const parts = [firstEnv.backend, firstEnv.frontend].filter(Boolean)
    stackLine = parts.join(' · ') || type
  }

  return (
    <Link
      to={`/workspaces/${ws.name}`}
      className={`block px-3 py-2.5 rounded-lg transition-colors ${
        active
          ? 'bg-gray-800 text-white'
          : 'text-gray-400 hover:bg-gray-800/60 hover:text-gray-200'
      }`}
    >
      <div className="flex items-center gap-2.5">
        <WorkspaceStatusDot name={ws.name} envs={ws.envs} />
        <span className="font-medium text-sm truncate">{ws.name}</span>
      </div>
      {stackLine && (
        <p className="text-xs text-gray-500 mt-0.5 ml-4.5 truncate pl-4">{stackLine}</p>
      )}
    </Link>
  )
}

export default function Layout({ children }) {
  const user     = useAuthStore((s) => s.user)
  const logout   = useAuthStore((s) => s.logout)
  const navigate = useNavigate()
  const { name: activeName } = useParams()

  const { data: workspaces } = useQuery({
    queryKey: ['workspaces'],
    queryFn: fetchWorkspaces,
    refetchInterval: 30_000,
  })

  async function handleLogout() {
    await logout()
    navigate('/login')
  }

  return (
    <div className="min-h-screen bg-gray-950 flex flex-col">
      {/* Top nav */}
      <nav className="border-b border-gray-800 bg-gray-900 shrink-0 z-10">
        <div className="px-4 h-12 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="bg-brand-600 text-white text-xs font-bold px-2 py-1 rounded">DADS</div>
            <span className="text-gray-400 text-sm hidden sm:inline">Docker App Deployment Simplified</span>
          </div>
          <div className="flex items-center gap-1">
            <NavBtn to="/" label="Dashboard" />
            <NavBtn to="/settings" label="Settings" />
            <a
              href="https://github.com" target="_blank" rel="noreferrer"
              className="px-3 py-1.5 text-sm text-gray-400 hover:text-white rounded-lg hover:bg-gray-800 transition-colors flex items-center gap-1"
            >
              Docs <span className="text-xs">↗</span>
            </a>
            <div className="w-px h-4 bg-gray-700 mx-1" />
            <button
              onClick={handleLogout}
              className="px-3 py-1.5 text-sm text-gray-400 hover:text-white rounded-lg hover:bg-gray-800 transition-colors"
            >
              {user?.sub} · Sign out
            </button>
          </div>
        </div>
      </nav>

      <div className="flex flex-1 min-h-0">
        {/* Sidebar */}
        <aside className="w-56 shrink-0 border-r border-gray-800 bg-gray-900 flex flex-col">
          <div className="p-3 border-b border-gray-800">
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider px-1 mb-2">Workspaces</p>
            <div className="space-y-0.5">
              {(workspaces || []).map(ws => (
                <WorkspaceSidebarItem key={ws.name} ws={ws} active={ws.name === activeName} />
              ))}
            </div>
          </div>

          <div className="p-3 space-y-0.5">
            <SidebarAction to="/new" label="New workspace" icon="＋" />
            <SidebarAction to="/backups" label="Backup history" icon="○" />
            <SidebarAction to="/versions" label="Version log" icon="○" />
          </div>
        </aside>

        {/* Main content */}
        <main className="flex-1 overflow-auto">
          {children}
        </main>
      </div>
    </div>
  )
}

function NavBtn({ to, label }) {
  return (
    <Link
      to={to}
      className="px-3 py-1.5 text-sm text-gray-300 hover:text-white rounded-lg hover:bg-gray-800 transition-colors border border-gray-700 hover:border-gray-600"
    >
      {label}
    </Link>
  )
}

function SidebarAction({ to, label, icon }) {
  return (
    <Link
      to={to}
      className="flex items-center gap-2 px-3 py-2 text-sm text-gray-500 hover:text-gray-300 rounded-lg hover:bg-gray-800/60 transition-colors"
    >
      <span className="text-xs">{icon}</span>
      {label}
    </Link>
  )
}
