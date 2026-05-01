/** Shared JWT expiry check for api + auth store. */
export function isTokenExpired(token: string): boolean {
  try {
    const payload = JSON.parse(atob(token.split('.')[1]))
    if (!payload.exp) return false
    return Date.now() >= payload.exp * 1000
  } catch {
    return true
  }
}

export function getIsAdminFromToken(token: string): boolean {
  try {
    const payload = JSON.parse(atob(token.split('.')[1]))
    return Boolean(payload.is_admin)
  } catch {
    return false
  }
}
