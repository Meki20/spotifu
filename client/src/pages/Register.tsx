import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuthStore } from '../stores/authStore'
import { getIsAdminFromToken } from '../authToken'
import { API } from '../api'

export default function Register() {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const { setAuth } = useAuthStore()
  const navigate = useNavigate()

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    try {
      const res = await fetch(`${API}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      })
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.detail || 'Registration failed')
      }
      const data = await res.json()
      const isAdmin = getIsAdminFromToken(data.access_token)
      setAuth(data.access_token, username, isAdmin)
      navigate('/')
    } catch (err) {
      setError(String(err))
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#121212]">
      <form onSubmit={handleSubmit} className="bg-[#181818] p-8 rounded-lg w-full max-w-sm space-y-4">
        <h1 className="text-2xl font-bold text-white mb-4">Create account</h1>
        {error && <p className="text-red-500 text-sm">{error}</p>}
        <input
          type="text"
          placeholder="Username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          className="w-full px-4 py-3 bg-[#282828] rounded-md text-white placeholder-[#b3b3b3] focus:outline-none focus:ring-2 focus:ring-[#1DB954]"
          required
        />
        <input
          type="password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full px-4 py-3 bg-[#282828] rounded-md text-white placeholder-[#b3b3b3] focus:outline-none focus:ring-2 focus:ring-[#1DB954]"
          required
        />
        <button
          type="submit"
          className="w-full py-3 bg-[#1DB954] hover:bg-[#1ed760] text-black font-bold rounded-full transition-colors"
        >
          Create account
        </button>
        <p className="text-center text-sm text-[#b3b3b3]">
          Already have an account?{' '}
          <Link to="/login" className="text-[#1DB954] hover:underline">Sign in</Link>
        </p>
      </form>
    </div>
  )
}