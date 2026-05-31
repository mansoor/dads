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
  return token ? children : <Navigate to="/login" replace />
}

export default function App() {
  return (
    <BrowserRouter>
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
    </BrowserRouter>
  )
}
