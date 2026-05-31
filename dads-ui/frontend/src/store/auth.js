import { create } from 'zustand'
import api from '../lib/api'

export const useAuthStore = create((set, get) => ({
  token: null,   // access token — kept in memory only, never localStorage
  user:  null,
  refreshing: false, // true while the initial silent refresh is in-flight
  ready: false,      // true once the startup refresh attempt has completed

  login: async (username, password) => {
    const { data } = await api.post('/auth/login', { username, password })
    set({ token: data.token, user: parseJwt(data.token), ready: true })
  },

  logout: async () => {
    try { await api.post('/auth/logout') } catch {}
    set({ token: null, user: null, ready: true })
  },

  // Called once on app startup to silently restore the session from the
  // httpOnly refresh-token cookie. Sets ready=true when done regardless.
  tryRefresh: async () => {
    if (get().refreshing) return
    set({ refreshing: true })
    try {
      const { data } = await api.post('/auth/refresh')
      set({ token: data.token, user: parseJwt(data.token) })
    } catch {
      // Cookie absent or expired — user will be redirected to login
    } finally {
      set({ refreshing: false, ready: true })
    }
  },

  isAuthenticated: () => !!useAuthStore.getState().token,
}))

function parseJwt(token) {
  try {
    return JSON.parse(atob(token.split('.')[1]))
  } catch {
    return null
  }
}
