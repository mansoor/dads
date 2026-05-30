import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { fetchWorkspaces } from '../lib/api'
import Layout from '../components/Layout'

function statusDot(envs) {
  // Placeholder — real status comes from ps command
  return <span className="w-2 h-2 rounded-full bg-gray-600 inline-block" />
}

function WorkspaceCard({ ws }) {
  const envNames = ws.envs || Object.keys(ws.config?.environments || {})
  const type = ws.config?.project?.type || 'custom'

  return (
    <Link
      to={`/workspaces/${ws.name}`}
      className="block bg-gray-900 border border-gray-800 hover:border-gray-600 rounded-xl p-5 transition-colors group"
    >
      <div className="flex items-start justify-between mb-3">
        <div>
          <h3 className="font-semibold text-white group-hover:text-brand-400 transition-colors">
            {ws.name}
          </h3>
          <p className="text-xs text-gray-500 mt-0.5">{ws.config?.project?.registry}</p>
        </div>
        <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${
          type === 'image'
            ? 'bg-blue-950 text-blue-300'
            : 'bg-purple-950 text-purple-300'
        }`}>
          {type}
        </span>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        {envNames.map(env => (
          <span key={env} className="flex items-center gap-1.5 text-xs bg-gray-800 text-gray-300 px-2 py-1 rounded-md">
            {statusDot(env)}
            {env}
          </span>
        ))}
      </div>

      <div className="mt-3 pt-3 border-t border-gray-800 flex items-center justify-between text-xs text-gray-500">
        <span>
          v{ws.config?.project?.version?.major}.{ws.config?.project?.version?.minor}.{ws.config?.project?.version?.patch}
        </span>
        <span className="text-gray-600 group-hover:text-gray-400 transition-colors">View →</span>
      </div>
    </Link>
  )
}

export default function DashboardPage() {
  const { data: workspaces, isLoading, error } = useQuery({
    queryKey: ['workspaces'],
    queryFn: fetchWorkspaces,
    refetchInterval: 30_000,
  })

  return (
    <Layout>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-white">Workspaces</h1>
          <p className="text-gray-400 text-sm mt-0.5">
            {workspaces ? `${workspaces.length} workspace${workspaces.length !== 1 ? 's' : ''}` : ''}
          </p>
        </div>
      </div>

      {isLoading && (
        <div className="text-gray-500 text-sm">Loading workspaces…</div>
      )}

      {error && (
        <div className="bg-red-950 border border-red-800 text-red-300 rounded-lg px-4 py-3 text-sm">
          Failed to load workspaces: {error.message}
        </div>
      )}

      {workspaces?.length === 0 && (
        <div className="text-center py-16 text-gray-500">
          <p className="text-lg mb-2">No workspaces found</p>
          <p className="text-sm">Run <code className="font-mono bg-gray-800 px-1.5 py-0.5 rounded">./init_workspace.sh</code> to create one.</p>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {workspaces?.map(ws => <WorkspaceCard key={ws.name} ws={ws} />)}
      </div>
    </Layout>
  )
}
