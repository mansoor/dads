import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { useAuthStore } from './store/auth'
import LoginPage from './pages/LoginPage'
import SetupPage from './pages/SetupPage'
import DashboardPage from './pages/DashboardPage'
import WorkspacePage from './pages/WorkspacePage'

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
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  )
}
