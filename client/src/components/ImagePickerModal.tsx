import { useState } from 'react'
import { X } from 'lucide-react'

interface ImagePickerModalProps {
  isOpen: boolean
  onClose: () => void
  banners: string[]
  thumbs: string[]
  bannerIdx: number
  pictureIdx: number
  onSave: (bannerIdx: number, pictureIdx: number) => void
}

export default function ImagePickerModal({
  isOpen,
  onClose,
  banners,
  thumbs,
  bannerIdx,
  pictureIdx,
  onSave,
}: ImagePickerModalProps) {
  const [localBannerIdx, setLocalBannerIdx] = useState(bannerIdx)
  const [localPictureIdx, setLocalPictureIdx] = useState(pictureIdx)

  if (!isOpen) return null

  const handleSave = () => {
    onSave(localBannerIdx, localPictureIdx)
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70">
      <div className="bg-[#282828] rounded-lg w-[700px] max-h-[80vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-[#3a3a3a]">
          <h2 className="text-white font-bold text-lg">Choose Artist Images</h2>
          <button onClick={onClose} className="text-[#b3b3b3] hover:text-white">
            <X size={20} />
          </button>
        </div>

        {/* Body */}
        <div className="flex gap-6 p-6 overflow-auto">
          {/* Banner picker */}
          <div className="flex-1">
            <p className="text-xs text-[#b3b3b3] uppercase font-semibold mb-3">Banner</p>
            <div className="space-y-2">
              {banners.length === 0 && (
                <p className="text-[#6a6a6a] text-sm">No banners available</p>
              )}
              {banners.map((url, i) => (
                <div
                  key={i}
                  onClick={() => setLocalBannerIdx(i)}
                  className={`relative cursor-pointer rounded overflow-hidden border-2 transition-colors ${
                    i === localBannerIdx ? 'border-[#1DB954]' : 'border-transparent hover:border-[#555]'
                  }`}
                >
                  <img src={url} alt={`Banner ${i + 1}`} className="w-full h-24 object-cover" loading="lazy" />
                  {i === localBannerIdx && (
                    <div className="absolute inset-0 bg-[#1DB954]/20" />
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* Thumbnail picker */}
          <div className="flex-1">
            <p className="text-xs text-[#b3b3b3] uppercase font-semibold mb-3">Thumbnail</p>
            <div className="space-y-2">
              {thumbs.length === 0 && (
                <p className="text-[#6a6a6a] text-sm">No thumbnails available</p>
              )}
              {thumbs.map((url, i) => (
                <div
                  key={i}
                  onClick={() => setLocalPictureIdx(i)}
                  className={`relative cursor-pointer rounded overflow-hidden border-2 transition-colors ${
                    i === localPictureIdx ? 'border-[#1DB954]' : 'border-transparent hover:border-[#555]'
                  }`}
                >
                  <img src={url} alt={`Thumbnail ${i + 1}`} className="w-full h-24 object-cover" loading="lazy" />
                  {i === localPictureIdx && (
                    <div className="absolute inset-0 bg-[#1DB954]/20" />
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-3 p-4 border-t border-[#3a3a3a]">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded text-[#b3b3b3] hover:text-white transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            className="px-4 py-2 rounded bg-[#1DB954] text-black font-semibold hover:bg-[#1ed760] transition-colors"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  )
}