import { useEffect } from 'react'
import { Navigate } from 'react-router-dom'
import { useAuthStore } from '../stores/authStore'

function isTokenExpired(token: string): boolean {
  try {
    const payload = JSON.parse(atob(token.split('.')[1]))
    if (!payload.exp) return false
    return Date.now() >= payload.exp * 1000
  } catch {
    return true
  }
}

export default function RequireAuth({ children }: { children: React.ReactNode }) {
  const token = useAuthStore((s) => s.token)
  const remember = useAuthStore((s) => s.remember)
  const clearAuth = useAuthStore((s) => s.clearAuth)

  useEffect(() => {
    if (!token || (!remember && isTokenExpired(token))) {
      clearAuth()
      window.location.href = '/login'
    }
  }, [token, remember, clearAuth])

  if (!token || (!remember && isTokenExpired(token))) {
    return <Navigate to="/login" replace />
  }

  return <>{children}</>
}
