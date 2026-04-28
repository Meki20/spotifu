import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import ContextMenu from '../components/ContextMenu'
import AddToPlaylistModal, { type AddToPlaylistTrack } from '../components/AddToPlaylistModal'
import { useContextMenuState, useContextMenuActions } from '../contexts/ContextMenuProvider'
import { authFetch } from '../api'
import { requestMbDownload } from '../stores/downloadBusyStore'
import { toTrack } from '../utils/trackHelpers'
import * as controller from '../playback/controller'

type TrackLike = Record<string, unknown>

function asTrackLike(t: unknown): TrackLike | null {
  return t != null && typeof t === 'object' ? (t as TrackLike) : null
}

function toAddPayload(t: unknown): AddToPlaylistTrack | null {
  const obj = asTrackLike(t)
  if (!obj) return null
  const mb = obj.mb_id
  if (typeof mb !== 'string' || !mb) return null
  return {
    title: String(obj.title ?? ''),
    artist: String(obj.artist_credit ?? obj.artist ?? ''),
    album: obj.album != null ? String(obj.album) : undefined,
    album_cover: typeof obj.album_cover === 'string' ? obj.album_cover : (obj.album_cover == null ? null : String(obj.album_cover)),
    mb_id: mb,
    mb_artist_id: typeof obj.mb_artist_id === 'string' ? obj.mb_artist_id : null,
    mb_release_id: typeof obj.mb_release_id === 'string' ? obj.mb_release_id : null,
    mb_release_group_id: typeof obj.mb_release_group_id === 'string' ? obj.mb_release_group_id : null,
  }
}

export default function ContextMenuRenderer() {
  const state = useContextMenuState()
  const { closeContextMenu } = useContextMenuActions()
  const navigate = useNavigate()
  const [addPlOpen, setAddPlOpen] = useState(false)
  const [addPlTrack, setAddPlTrack] = useState<AddToPlaylistTrack | null>(null)
  const track = state?.track
  const canAddToPlaylist = Boolean(track && toAddPayload(track))

  function playTrack() {
    if (track) controller.play(toTrack(track))
  }

  function downloadTrack() {
    if (!track?.mb_id) return
    requestMbDownload(authFetch, track.mb_id).catch(console.error)
  }

  function addToQueue() {
    if (track) controller.addToQueue(toTrack(track))
  }

  function goToArtist() {
    if (track?.mb_artist_id) {
      navigate(`/artist/${track.mb_artist_id}`)
      closeContextMenu()
    }
  }

  function goToAlbum() {
    const albumId = track?.mb_release_group_id || track?.mb_release_id
    if (albumId) {
      navigate(`/album/${albumId}`)
      closeContextMenu()
    }
  }

  return (
    <>
      {state && (
        <ContextMenu
          x={state.x}
          y={state.y}
          track={track}
          onPlay={playTrack}
          onDownload={downloadTrack}
          onAddToQueue={addToQueue}
          onGoToArtist={goToArtist}
          onGoToAlbum={goToAlbum}
          onAddToPlaylist={
            canAddToPlaylist
              ? () => {
                  const p = track ? toAddPayload(track) : null
                  if (p) {
                    setAddPlTrack(p)
                    setAddPlOpen(true)
                  }
                }
              : undefined
          }
          onClose={closeContextMenu}
        />
      )}
      <AddToPlaylistModal
        open={addPlOpen}
        track={addPlTrack}
        onClose={() => {
          setAddPlOpen(false)
          setAddPlTrack(null)
        }}
      />
    </>
  )
}