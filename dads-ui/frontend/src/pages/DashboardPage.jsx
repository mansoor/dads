import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { fetchWorkspaces } from '../lib/api'
import Layout from '../components/Layout'

export default function DashboardPage() {
  const navigate = useNavigate()
  const { data: workspaces, isLoading } = useQuery({
    queryKey: ['workspaces'],
    queryFn: fetchWorkspaces,
  })

  // Redirect to the first workspace automatically
  useEffect(() => {
    if (workspaces && workspaces.length > 0) {
      navigate(`/workspaces/${workspaces[0].name}`, { replace: true })
    }
  }, [workspaces])

  if (isLoading) {
    return (
      <Layout>
        <div className="flex items-center justify-center h-full text-gray-500 text-sm p-16">
          Loading workspaces…
        </div>
      </Layout>
    )
  }

  return (
    <Layout>
      <div className="flex flex-col items-center justify-center h-full p-16 text-center">
        <p className="text-gray-400 text-lg mb-2">No workspaces yet</p>
        <p className="text-gray-500 text-sm mb-6">
          Run <code className="font-mono bg-gray-800 px-1.5 py-0.5 rounded text-gray-300">./init_workspace.sh</code> to create your first workspace,<br />
          or check that the <code className="font-mono bg-gray-800 px-1.5 py-0.5 rounded text-gray-300">workspaces/</code> directory is correctly mounted.
        </p>
      </div>
    </Layout>
  )
}
