import axios from 'axios'
import { useAuthStore } from '../store/auth'

const api = axios.create({ baseURL: '/api' })

// Attach JWT to every request
api.interceptors.request.use((config) => {
  const token = useAuthStore.getState().token
  if (token) config.headers.Authorization = `Bearer ${token}`
  return config
})

// On 401, clear auth and redirect to login.
// Exception: /auth/refresh — a 401 there just means no session to restore;
// let tryRefresh() handle it silently without triggering a redirect loop.
api.interceptors.response.use(
  (res) => res,
  (err) => {
    const isRefreshCall = err.config?.url?.includes('/auth/refresh')
    if (err.response?.status === 401 && !isRefreshCall) {
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
export const fetchImageUpdates  = (name, env) => api.get(`/workspaces/${name}/envs/${env}/image-updates`).then(r => r.data)
export const fetchContainers    = (name, env) => api.get(`/workspaces/${name}/envs/${env}/containers`).then(r => r.data)
export const fetchActivity     = (name)      => api.get(`/workspaces/${name}/activity`).then(r => r.data)
export const fetchAllActivity  = ()          => api.get('/activity').then(r => r.data)
export const updateEnvVars     = (name, env, updates, deletes = []) =>
  api.patch(`/workspaces/${name}/envs/${env}/vars`, { updates, deletes }).then(r => r.data)
export const fetchCompose      = (name, env) => api.get(`/workspaces/${name}/envs/${env}/compose`).then(r => r.data)
export const putCompose        = (name, env, content) =>
  api.put(`/workspaces/${name}/envs/${env}/compose`, { content }).then(r => r.data)
export const fetchConfig       = (name)      => api.get(`/workspaces/${name}/config`).then(r => r.data)
export const changePassword    = (current_password, new_password) =>
  api.post('/auth/password', { current_password, new_password }).then(r => r.data)
export const fetchBackups      = ()          => api.get('/backups').then(r => r.data)
export const fetchStats        = ()          => api.get('/stats').then(r => r.data)
export const exportTemplate    = (name, body) => api.post(`/workspaces/${name}/export-template`, body).then(r => r.data)
export const deleteWorkspace   = (name)      => api.delete(`/workspaces/${name}`).then(r => r.data)
export const putConfig         = (name, content) =>
  api.put(`/workspaces/${name}/config`, { content }).then(r => r.data)

// ── Settings: Backup Targets ──────────────────────────────────────────────────

export const fetchBackupTargets   = ()          => api.get('/settings/backup-targets').then(r => r.data)
export const createBackupTarget   = (body)      => api.post('/settings/backup-targets', body).then(r => r.data)
export const updateBackupTarget   = (id, body)  => api.put(`/settings/backup-targets/${id}`, body).then(r => r.data)
export const deleteBackupTarget   = (id)        => api.delete(`/settings/backup-targets/${id}`)

// ── Settings: Docker Registries ───────────────────────────────────────────────

export const fetchRegistries      = ()          => api.get('/settings/registries').then(r => r.data)
export const createRegistry       = (body)      => api.post('/settings/registries', body).then(r => r.data)
export const updateRegistry       = (id, body)  => api.put(`/settings/registries/${id}`, body).then(r => r.data)
export const deleteRegistry       = (id)        => api.delete(`/settings/registries/${id}`)
export const testRegistry         = (id)        => api.post(`/settings/registries/${id}/test`).then(r => r.data)

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
