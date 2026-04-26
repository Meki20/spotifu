import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { QueryClientProvider } from '@tanstack/react-query'
import { queryClient } from './queryClient'
import MainLayout from './components/MainLayout'
import RequireAuth from './components/RequireAuth'
import { ContextMenuProvider } from './contexts/ContextMenuProvider'
import { useCloseContextMenuOnOutsideClick } from './hooks/useContextMenu'
import ContextMenuRenderer from './components/ContextMenuRenderer'
import './index.css'
import { lazy, Suspense } from 'react'
import RouteErrorBoundary from './components/RouteErrorBoundary'

const Home = lazy(() => import('./pages/Home'))
const Search = lazy(() => import('./pages/Search'))
const Library = lazy(() => import('./pages/Library'))
const Settings = lazy(() => import('./pages/Settings'))
const Login = lazy(() => import('./pages/Login'))
const Register = lazy(() => import('./pages/Register'))
const AlbumPage = lazy(() => import('./pages/AlbumPage'))
const ArtistPage = lazy(() => import('./pages/ArtistPage'))
const PlaylistPage = lazy(() => import('./pages/PlaylistPage'))

function ContextMenuLayer() {
  useCloseContextMenuOnOutsideClick()
  return <ContextMenuRenderer />
}

function LoadingSpinner() {
  return (
    <div className="flex items-center justify-center h-full" style={{ color: '#4A413C', fontFamily: "'Space Mono', monospace" }}>
      loading...
    </div>
  )
}

function AppContent() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/register" element={<Register />} />
      <Route path="/" element={
        <RequireAuth>
          <MainLayout />
        </RequireAuth>
      }>
        <Route index element={<Suspense fallback={<LoadingSpinner />}><RouteErrorBoundary name="Home"><Home /></RouteErrorBoundary></Suspense>} />
        <Route path="/search" element={<Suspense fallback={<LoadingSpinner />}><RouteErrorBoundary name="Search"><Search /></RouteErrorBoundary></Suspense>} />
        <Route path="/library" element={<Suspense fallback={<LoadingSpinner />}><RouteErrorBoundary name="Library"><Library /></RouteErrorBoundary></Suspense>} />
        <Route path="/settings" element={<Suspense fallback={<LoadingSpinner />}><RouteErrorBoundary name="Settings"><Settings /></RouteErrorBoundary></Suspense>} />
        <Route path="/album/:albumId" element={<Suspense fallback={<LoadingSpinner />}><RouteErrorBoundary name="Album"><AlbumPage /></RouteErrorBoundary></Suspense>} />
        <Route path="/artist/:artistId" element={<Suspense fallback={<LoadingSpinner />}><RouteErrorBoundary name="Artist"><ArtistPage /></RouteErrorBoundary></Suspense>} />
        <Route path="/playlist/:playlistId" element={<Suspense fallback={<LoadingSpinner />}><RouteErrorBoundary name="Playlist"><PlaylistPage /></RouteErrorBoundary></Suspense>} />
      </Route>
    </Routes>
  )
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ContextMenuProvider>
        <BrowserRouter>
          <ContextMenuLayer />
          <AppContent />
        </BrowserRouter>
      </ContextMenuProvider>
    </QueryClientProvider>
  )
}

export default App