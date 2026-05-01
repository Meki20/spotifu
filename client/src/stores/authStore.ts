import { create } from 'zustand'
import { persist, createJSONStorage, type StateStorage } from 'zustand/middleware'
import { isTokenExpired } from '../authToken'

const hybridStorage: StateStorage = {
  getItem: (name) => localStorage.getItem(name) ?? sessionStorage.getItem(name),
  setItem: (name, value) => {
    let remember = false
    try {
      remember = Boolean(JSON.parse(value)?.state?.remember)
    } catch {
      /* ignore */
    }
    if (remember) {
      localStorage.setItem(name, value)
      sessionStorage.removeItem(name)
    } else {
      sessionStorage.setItem(name, value)
      localStorage.removeItem(name)
    }
  },
  removeItem: (name) => {
    localStorage.removeItem(name)
    sessionStorage.removeItem(name)
  },
}

interface AuthState {
  token: string | null
  username: string | null
  isAdmin: boolean
  remember: boolean
  setAuth: (token: string, username: string, isAdmin: boolean, remember?: boolean) => void
  clearAuth: () => void
  isExpired: () => boolean
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      token: null,
      username: null,
      isAdmin: false,
      remember: false,
      setAuth: (token, username, isAdmin = false, remember = false) => set({ token, username, isAdmin, remember }),
      clearAuth: () => set({ token: null, username: null, isAdmin: false, remember: false }),
      isExpired: () => {
        const { token } = get()
        if (!token) return true
        return isTokenExpired(token)
      },
    }),
    { name: 'spotifu-auth', storage: createJSONStorage(() => hybridStorage) }
  )
)
