import axios from 'axios'
import { useAuthStore } from '../store/auth'

const api = axios.create({ baseURL: '/api' })

// Attach JWT to every request
api.interceptors.request.use((config) => {
  const token = useAuthStore.getState().token
  if (token) config.headers.Authorization = `Bearer ${token}`
  return config
})

// On 401, clear auth and redirect to login
api.interceptors.response.use(
  (res) => res,
  (err) => {
    if (err.response?.status === 401) {
      useAuthStore.getState().logout()
      window.location.href = '/login'
    }
    return Promise.reject(err)
  }
)

export default api

// ── Workspace helpers ─────────────────────────────────────────────────────────

export const fetchWorkspaces   = ()          => api.get('/workspaces').then(r => r.data)
export const fetchWorkspace    = (name)      => api.get(`/workspaces/${name}`).then(r => r.data)
export const fetchEnvVars      = (name, env) => api.get(`/workspaces/${name}/envs/${env}/vars`).then(r => r.data)
export const fetchEnvStatus    = (name, env) => api.get(`/workspaces/${name}/envs/${env}/status`).then(r => r.data)
export const fetchActivity     = (name)      => api.get(`/workspaces/${name}/activity`).then(r => r.data)
export const updateEnvVars     = (name, env, updates) =>
  api.patch(`/workspaces/${name}/envs/${env}/vars`, updates).then(r => r.data)

// ── WebSocket action helper ───────────────────────────────────────────────────

export function openActionSocket(name, command, env, extra = []) {
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
  const ws = new WebSocket(`${proto}://${window.location.host}/api/workspaces/${name}/action`)

  ws.addEventListener('open', () => {
    const token = useAuthStore.getState().token
    ws.send(JSON.stringify({ command, env, extra, token }))
  })

  return ws
}
