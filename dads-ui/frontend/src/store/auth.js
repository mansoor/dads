import { create } from 'zustand'
import api from '../lib/api'

export const useAuthStore = create((set) => ({
  token: null,   // access token — kept in memory only, never localStorage
  user: null,

  login: async (username, password) => {
    const { data } = await api.post('/auth/login', { username, password })
    set({ token: data.token, user: parseJwt(data.token) })
  },

  logout: async () => {
    try { await api.post('/auth/logout') } catch {}
    set({ token: null, user: null })
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
