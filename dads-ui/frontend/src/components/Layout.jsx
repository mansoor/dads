import { Link, useNavigate } from 'react-router-dom'
import { useAuthStore } from '../store/auth'

export default function Layout({ children }) {
  const user     = useAuthStore((s) => s.user)
  const logout   = useAuthStore((s) => s.logout)
  const navigate = useNavigate()

  async function handleLogout() {
    await logout()
    navigate('/login')
  }

  return (
    <div className="min-h-screen bg-gray-950 flex flex-col">
      {/* Nav */}
      <nav className="border-b border-gray-800 bg-gray-900">
        <div className="max-w-7xl mx-auto px-4 h-14 flex items-center justify-between">
          <Link to="/" className="flex items-center gap-2.5">
            <span className="text-xl">🐳</span>
            <span className="font-bold text-white text-lg tracking-tight">DADS</span>
            <span className="text-gray-500 text-sm font-normal hidden sm:inline">Docker App Deployment Simplified</span>
          </Link>
          <div className="flex items-center gap-4">
            <span className="text-gray-400 text-sm hidden sm:inline">
              {user?.sub}
            </span>
            <button
              onClick={handleLogout}
              className="text-sm text-gray-400 hover:text-white transition-colors"
            >
              Sign out
            </button>
          </div>
        </div>
      </nav>

      {/* Page content */}
      <main className="flex-1 max-w-7xl mx-auto w-full px-4 py-8">
        {children}
      </main>
    </div>
  )
}
