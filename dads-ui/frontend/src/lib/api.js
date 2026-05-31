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

export const fetchTemplates    = ()          => api.get('/templates').then(r => r.data)
export const fetchTemplate     = (name)      => api.get(`/templates/${name}`).then(r => r.data)
export const fetchWorkspaces   = ()          => api.get('/workspaces').then(r => r.data)
export const fetchWorkspace    = (name)      => api.get(`/workspaces/${name}`).then(r => r.data)
export const fetchEnvVars      = (name, env, reveal = false) => api.get(`/workspaces/${name}/envs/${env}/vars${reveal ? '?reveal=true' : ''}`).then(r => r.data)
export const fetchEnvStatus    = (name, env) => api.get(`/workspaces/${name}/envs/${env}/status`).then(r => r.data)
export const fetchActivity     = (name)      => api.get(`/workspaces/${name}/activity`).then(r => r.data)
export const updateEnvVars     = (name, env, updates) =>
  api.patch(`/workspaces/${name}/envs/${env}/vars`, updates).then(r => r.data)
export const fetchCompose      = (name, env) => api.get(`/workspaces/${name}/envs/${env}/compose`).then(r => r.data)
export const putCompose        = (name, env, content) =>
  api.put(`/workspaces/${name}/envs/${env}/compose`, { content }).then(r => r.data)
export const fetchConfig       = (name)      => api.get(`/workspaces/${name}/config`).then(r => r.data)
export const putConfig         = (name, content) =>
  api.put(`/workspaces/${name}/config`, { content }).then(r => r.data)

// ── WebSocket action helper ───────────────────────────────────────────────────

export function openCreateSocket(workspace) {
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
  const ws = new WebSocket(`${proto}://${window.location.host}/api/workspaces/create`)
  ws.addEventListener('open', () => {
    const token = useAuthStore.getState().token
    ws.send(JSON.stringify({ token, workspace }))
  })
  return ws
}

export function openActionSocket(name, command, env, extra = []) {
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
  const ws = new WebSocket(`${proto}://${window.location.host}/api/workspaces/${name}/action`)

  ws.addEventListener('open', () => {
    const token = useAuthStore.getState().token
    ws.send(JSON.stringify({ command, env, extra, token }))
  })

  return ws
}
