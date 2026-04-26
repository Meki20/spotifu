import { useEffect } from 'react'
import * as controller from '../playback/controller'

export function useAudioPlayer() {
  useEffect(() => {
    controller.init()
  }, [])
}

// Legacy export for PlayerBar — delegates to controller
export function seekAudio(time: number) {
  controller.seek(time)
}
