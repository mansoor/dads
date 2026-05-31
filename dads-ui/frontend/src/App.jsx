import { useEffect } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { useAuthStore } from './store/auth'
import LoginPage from './pages/LoginPage'
import SetupPage from './pages/SetupPage'
import DashboardPage from './pages/DashboardPage'
import WorkspacePage from './pages/WorkspacePage'
import NewWorkspacePage from './pages/NewWorkspacePage'
import EditWorkspacePage from './pages/EditWorkspacePage'
import BackupHistoryPage from './pages/BackupHistoryPage'
import VersionLogPage from './pages/VersionLogPage'

function RequireAuth({ children }) {
  const token = useAuthStore((s) => s.token)
  const ready  = useAuthStore((s) => s.ready)

  // Wait for the silent refresh attempt to complete before deciding
  if (!ready) return null

  return token ? children : <Navigate to="/login" replace />
}

function AppRoutes() {
  const tryRefresh = useAuthStore((s) => s.tryRefresh)
  const ready      = useAuthStore((s) => s.ready)

  // On first mount, attempt to restore the session silently from the cookie.
  // This runs once; subsequent navigation never triggers it again.
  useEffect(() => {
    tryRefresh()
  }, [])

  // Show a blank screen while the refresh is in-flight to avoid
  // a flash of the login page on page reload.
  if (!ready) {
    return (
      <div className="min-h-screen bg-gray-950 flex items-center justify-center">
        <span className="text-gray-700 text-sm">Loading…</span>
      </div>
    )
  }

  return (
    <Routes>
      <Route path="/setup"  element={<SetupPage />} />
      <Route path="/login"  element={<LoginPage />} />
      <Route path="/" element={
        <RequireAuth><DashboardPage /></RequireAuth>
      } />
      <Route path="/workspaces/:name" element={
        <RequireAuth><WorkspacePage /></RequireAuth>
      } />
      <Route path="/new" element={
        <RequireAuth><NewWorkspacePage /></RequireAuth>
      } />
      <Route path="/workspaces/:name/edit" element={
        <RequireAuth><EditWorkspacePage /></RequireAuth>
      } />
      <Route path="/backups" element={
        <RequireAuth><BackupHistoryPage /></RequireAuth>
      } />
      <Route path="/versions" element={
        <RequireAuth><VersionLogPage /></RequireAuth>
      } />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}

export default function App() {
  return (
    <BrowserRouter>
      <AppRoutes />
    </BrowserRouter>
  )
}
