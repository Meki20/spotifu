// Settings → Accounts tab: user management (admin) + logout + about.

import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuthStore } from '../../stores/authStore'
import { Toggle } from './Toggle'
import { SectionLabel } from './Section'
import {
  getUsers,
  updateUserPermissions,
  grantAllPermissions,
  revokeAllPermissions,
  deleteUser,
  type UserWithPermissions,
} from '../../api'

export default function SettingsAccounts() {
  const isAdmin = useAuthStore((s) => s.isAdmin)
  const clearAuth = useAuthStore((s) => s.clearAuth)
  const navigate = useNavigate()
  const [adminUsers, setAdminUsers] = useState<UserWithPermissions[]>([])
  const [adminUsersLoading, setAdminUsersLoading] = useState(false)
  const [expandedUserId, setExpandedUserId] = useState<number | null>(null)

  useEffect(() => {
    if (!isAdmin) return
    setAdminUsersLoading(true)
    getUsers()
      .then((data) => setAdminUsers(data.users))
      .catch(console.error)
      .finally(() => setAdminUsersLoading(false))
  }, [isAdmin])

  async function handlePermissionChange(userId: number, permission: keyof import('../../api').UserPermission, value: boolean) {
    try {
      await updateUserPermissions(userId, { [permission]: value })
      setAdminUsers((prev) =>
        prev.map((u) =>
          u.id === userId
            ? { ...u, permissions: u.permissions ? { ...u.permissions, [permission]: value } : null }
            : u,
        ),
      )
    } catch (err) {
      console.error('Failed to update permission:', err)
    }
  }

  async function handleGrantAll(userId: number) {
    try {
      await grantAllPermissions(userId)
      setAdminUsers((prev) =>
        prev.map((u) =>
          u.id === userId
            ? {
                ...u,
                permissions: {
                  can_play: true,
                  can_download: true,
                  can_use_soulseek: true,
                  can_access_apis: true,
                  can_view_recently_downloaded: true,
                },
              }
            : u,
        ),
      )
    } catch (err) {
      console.error('Failed to grant permissions:', err)
    }
  }

  async function handleRevokeAll(userId: number) {
    try {
      await revokeAllPermissions(userId)
      setAdminUsers((prev) =>
        prev.map((u) =>
          u.id === userId
            ? {
                ...u,
                permissions: {
                  can_play: false,
                  can_download: false,
                  can_use_soulseek: false,
                  can_access_apis: false,
                  can_view_recently_downloaded: false,
                },
              }
            : u,
        ),
      )
    } catch (err) {
      console.error('Failed to revoke permissions:', err)
    }
  }

  async function handleDeleteUser(userId: number) {
    if (!confirm('Are you sure you want to delete this user? This action cannot be undone.')) return
    try {
      await deleteUser(userId)
      setAdminUsers((prev) => prev.filter((u) => u.id !== userId))
    } catch (err) {
      console.error('Failed to delete user:', err)
    }
  }

  function handleLogout() {
    clearAuth()
    navigate('/login')
  }

  return (
    <div className="space-y-6">
      {isAdmin && (
        <section className="p-4 rounded" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}>
          <SectionLabel>User Management</SectionLabel>
          {adminUsersLoading ? (
            <p style={{ color: 'var(--text-secondary)' }}>Loading users...</p>
          ) : (
            <div className="space-y-2 mt-4">
              {adminUsers.map((user) => {
                const isExpanded = expandedUserId === user.id
                return (
                  <div
                    key={user.id}
                    className="rounded"
                    style={{ background: isExpanded ? 'var(--bg-surface-2)' : 'var(--bg-surface)', border: '1px solid var(--border)' }}
                  >
                    <button
                      onClick={() => setExpandedUserId(isExpanded ? null : user.id)}
                      className="w-full flex items-center justify-between p-3"
                      style={{ background: 'transparent', border: 'none', cursor: 'pointer', width: '100%' }}
                    >
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-full flex items-center justify-center" style={{ background: 'var(--accent)' }}>
                          <span style={{ color: 'var(--text-primary)', fontWeight: 700 }}>{user.username[0].toUpperCase()}</span>
                        </div>
                        <div className="text-left">
                          <span style={{ color: 'var(--text-primary)', fontWeight: 500 }}>{user.username}</span>
                          {user.is_admin && (
                            <span
                              className="ml-2 text-xs px-1.5 py-0.5 rounded"
                              style={{ background: 'var(--accent)', color: 'var(--text-primary)' }}
                            >
                              Admin
                            </span>
                          )}
                        </div>
                      </div>
                      <svg
                        xmlns="http://www.w3.org/2000/svg"
                        width="16"
                        height="16"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="var(--text-secondary)"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        style={{ transform: isExpanded ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.2s' }}
                      >
                        <path d="M6 9l6 6 6-6"></path>
                      </svg>
                    </button>

                    {isExpanded && (
                      <div className="px-3 pb-3">
                        {user.is_admin ? (
                          <div className="text-sm p-3 rounded" style={{ background: 'var(--bg-surface)', color: 'var(--text-secondary)' }}>
                            Has full access to all features
                          </div>
                        ) : (
                          <div className="space-y-2">
                            <PermRow label="Play tracks" userId={user.id} perm="can_play" value={user.permissions?.can_play ?? false} onChange={handlePermissionChange} />
                            <PermRow label="Download tracks" userId={user.id} perm="can_download" value={user.permissions?.can_download ?? false} onChange={handlePermissionChange} />
                            <PermRow label="Use Soulseek" userId={user.id} perm="can_use_soulseek" value={user.permissions?.can_use_soulseek ?? false} onChange={handlePermissionChange} />
                            <PermRow label="Access APIs" userId={user.id} perm="can_access_apis" value={user.permissions?.can_access_apis ?? false} onChange={handlePermissionChange} />
                            <PermRow label="View Recently Downloaded" userId={user.id} perm="can_view_recently_downloaded" value={user.permissions?.can_view_recently_downloaded ?? false} onChange={handlePermissionChange} />
                            <div className="flex gap-2 mt-2">
                              <button
                                onClick={() => void handleGrantAll(user.id)}
                                className="flex-1 p-2 rounded transition-colors text-sm"
                                style={{ background: 'var(--color-success-bg)', color: 'var(--color-success)', border: 'none', cursor: 'pointer' }}
                              >
                                Grant all
                              </button>
                              <button
                                onClick={() => void handleRevokeAll(user.id)}
                                className="flex-1 p-2 rounded transition-colors text-sm"
                                style={{ background: 'var(--bg-surface)', color: 'var(--text-secondary)', border: '1px solid var(--border)', cursor: 'pointer' }}
                              >
                                Revoke all
                              </button>
                            </div>
                            <button
                              onClick={() => void handleDeleteUser(user.id)}
                              className="w-full p-2 rounded transition-colors mt-2"
                              style={{ background: 'var(--color-danger-faint-bg, rgba(196, 48, 43, 0.15))', color: 'var(--color-danger)', border: 'none', cursor: 'pointer' }}
                            >
                              Delete user
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </section>
      )}

      <section className="p-4 rounded" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}>
        <h2
          className="text-lg uppercase mb-1"
          style={{ fontFamily: 'var(--font-display)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-primary)' }}
        >
          About SpotiFU
        </h2>
        <p className="text-xs mb-4" style={{ fontFamily: 'var(--font-body)', color: 'var(--text-secondary)' }}>
          Music streaming app powered by MusicBrainz metadata and Soulseek full-track downloads.
          Backend runs on port 1985, frontend on port 1984.
        </p>
        <button
          onClick={handleLogout}
          className="px-4 py-2 text-sm font-semibold border transition-colors"
          style={{ background: 'transparent', color: 'var(--accent)', borderColor: 'var(--accent)', borderRadius: 4, cursor: 'pointer', fontFamily: 'var(--font-display)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}
        >
          Logout
        </button>
      </section>
    </div>
  )
}

function PermRow({
  label,
  userId,
  perm,
  value,
  onChange,
}: {
  label: string
  userId: number
  perm: keyof import('../../api').UserPermission
  value: boolean
  onChange: (userId: number, perm: keyof import('../../api').UserPermission, value: boolean) => void
}) {
  return (
    <div className="flex items-center justify-between p-2 rounded" style={{ background: 'var(--bg-surface)' }}>
      <span className="text-sm" style={{ color: 'var(--text-primary)' }}>{label}</span>
      <Toggle on={value} onChange={(v) => onChange(userId, perm, v)} />
    </div>
  )
}
