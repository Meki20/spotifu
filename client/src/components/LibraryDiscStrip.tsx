import { useRef, useState, useEffect, Suspense, useCallback } from 'react'
import { Canvas, useFrame } from '@react-three/fiber'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { Environment } from '@react-three/drei'
import * as THREE from 'three'
import { useTexture, RoundedBox } from '@react-three/drei'

interface LibraryAlbum {
  id: string
  title: string
  artist: string
  cover: string | null
  track_count: number
  cached_count: number
  tracks: unknown[]
  position?: number
  album_key?: string
}

interface LibraryDiscStripProps {
  albums: LibraryAlbum[]
  onDiscClick: (album: LibraryAlbum) => void
}

function albumColor(albumId: string): string {
  let hash = 0
  for (let i = 0; i < albumId.length; i++) {
    hash = albumId.charCodeAt(i) + ((hash << 5) - hash)
  }
  return `hsl(${Math.abs(hash % 360)}, 30%, 50%)`
}

const normalizedTextureCache = new Map<string, THREE.CanvasTexture>()

function buildNormalizedTexture(url: string): Promise<THREE.CanvasTexture> {
  return new Promise((resolve) => {
    const SIZE = 512
    const offscreen = document.createElement('canvas')
    offscreen.width = SIZE
    offscreen.height = SIZE
    const ctx = offscreen.getContext('2d')!
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      const scale = Math.max(SIZE / img.width, SIZE / img.height)
      const w = img.width * scale
      const h = img.height * scale
      ctx.drawImage(img, (SIZE - w) / 2, (SIZE - h) / 2, w, h)
      const tex = new THREE.CanvasTexture(offscreen)
      tex.colorSpace = THREE.SRGBColorSpace
      normalizedTextureCache.set(url, tex)
      resolve(tex)
    }
    img.onerror = () => {
      ctx.fillStyle = '#222'
      ctx.fillRect(0, 0, SIZE, SIZE)
      const tex = new THREE.CanvasTexture(offscreen)
      normalizedTextureCache.set(url, tex)
      resolve(tex)
    }
    img.src = url
  })
}

function useNormalizedTexture(url: string | null): THREE.Texture {
  const FALLBACK = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M+/HgAFdwI2QmLB8AAAAABJRU5ErkJggg=='
  const key = url ?? FALLBACK
  const [, setVersion] = useState(0)
  useEffect(() => {
    if (!normalizedTextureCache.has(key)) {
      buildNormalizedTexture(key).then(() => setVersion((v) => v + 1))
    }
  }, [key])
  return normalizedTextureCache.get(key) ?? new THREE.Texture()
}

function useContainerWidth(ref: React.RefObject<HTMLDivElement | null>): number {
  const [width, setWidth] = useState(800)
  useEffect(() => {
    if (!ref.current) return
    const ro = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width))
    ro.observe(ref.current)
    setWidth(ref.current.getBoundingClientRect().width)
    return () => ro.disconnect()
  }, [ref])
  return width
}

// Compute how many discs fit and the spacing between them given container width.
// MIN_SPACING ensures discs never overlap (disc body is DISC_WIDTH wide).
const CANVAS_HEIGHT = 240
const DISC_WIDTH = 3.2
const MIN_SPACING = 3.35
const FILL_FACTOR = 0.90
const CAM_Z = 6
const FOV_RAD = 45 * (Math.PI / 180)

function computeLayout(containerWidth: number) {
  const aspect = containerWidth / CANVAS_HEIGHT
  const halfWorld = CAM_Z * Math.tan(FOV_RAD / 2) * aspect
  const available = 2 * halfWorld * FILL_FACTOR
  const n = Math.max(1, Math.min(8, Math.floor((available - DISC_WIDTH) / MIN_SPACING + 1)))
  const spacing = n > 1 ? (available - DISC_WIDTH) / (n - 1) : MIN_SPACING
  return { visibleCount: n, spacing, halfWorld }
}

interface DiscProps {
  album: LibraryAlbum
  position: [number, number, number]
  onClick: () => void
}

function Disc({ album, position, onClick }: DiscProps) {
  const meshRef = useRef<THREE.Group>(null!)
  const sticker = useNormalizedTexture(album.cover)
  const grunge = useTexture('/textures/grunge.jpg', (tex) => {
    tex.colorSpace = THREE.SRGBColorSpace
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping
    tex.repeat.set(1, 1)
  })
  const scratches = useTexture('/textures/scratches.png', (tex) => {
    tex.colorSpace = THREE.SRGBColorSpace
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping
    tex.repeat.set(1, 1)
  })

  const floatOffset = album.id.charCodeAt(0) * 0.1

  useFrame((state) => {
    if (!meshRef.current) return
    const limit = Math.PI / 16
    const worldPos = new THREE.Vector3(...position)
    worldPos.project(state.camera)
    const relX = state.pointer.x - worldPos.x
    const relY = state.pointer.y - worldPos.y
    meshRef.current.rotation.x = THREE.MathUtils.lerp(
      meshRef.current.rotation.x,
      THREE.MathUtils.clamp((-relY * Math.PI) / 2, -limit, limit),
      0.08
    )
    meshRef.current.rotation.y = THREE.MathUtils.lerp(
      meshRef.current.rotation.y,
      THREE.MathUtils.clamp((relX * Math.PI) / 2, -limit, limit),
      0.08
    )
    meshRef.current.position.y = Math.sin(state.clock.elapsedTime * 1.5 + floatOffset) * 0.08
  })

  const corners: [number, number][] = [[-1.45, 1.25], [1.45, 1.25], [-1.45, -1.25], [1.45, -1.25]]
  const tintColor = albumColor(album.id)

  return (
    <group position={position}>
      <group ref={meshRef}>
        <RoundedBox args={[3.2, 2.8, 0.05]} radius={0.02} position={[0, 0, 0.15]}>
          <meshPhysicalMaterial color={tintColor} transparent opacity={0.05} roughness={0.1} metalness={0.05} depthWrite={false} side={THREE.DoubleSide} />
        </RoundedBox>

        <mesh position={[-0.4, -0.4, 0.1812]} onClick={onClick}>
          <planeGeometry args={[1.5, 1.5]} />
          <meshBasicMaterial map={sticker} transparent opacity={0.95} toneMapped={false} />
        </mesh>

        <mesh position={[0, 0, 0.182]}>
          <planeGeometry args={[3.15, 2.75]} />
          <meshBasicMaterial map={grunge} transparent opacity={0.15} toneMapped={false} depthWrite={false} />
        </mesh>

        <mesh position={[0, 0, 0.183]}>
          <planeGeometry args={[3.15, 2.75]} />
          <meshBasicMaterial map={scratches} transparent opacity={0.25} toneMapped={false} depthWrite={false} />
        </mesh>

        <mesh position={[-1.35, 0.3, 0.181]}>
          <planeGeometry args={[0.35, 1.0]} />
          <meshStandardMaterial color="#f0f0f0" metalness={0.95} roughness={0.15} />
        </mesh>

        <mesh position={[0.2, 0, 0]} rotation={[Math.PI / 2, 0, 0]}>
          <cylinderGeometry args={[1.15, 1.15, 0.018, 48]} />
          <meshPhysicalMaterial color="#e8e8f0" metalness={1} roughness={0.02} clearcoat={1} clearcoatRoughness={0.05} iridescence={1} iridescenceIOR={3.0} iridescenceThicknessRange={[60, 250]} />
        </mesh>

        {[0.42, 0.55, 0.68, 0.82, 0.95].map((radius, i) => (
          <mesh key={i} position={[0.2, 0, 0.010 + i * 0.002]}>
            <torusGeometry args={[radius, 0.0015, 4, 48]} />
            <meshStandardMaterial color="#c0c0d0" metalness={0.8} roughness={0.3} transparent opacity={0.35} />
          </mesh>
        ))}

        <mesh position={[0.2, 0, 0.028]}>
          <torusGeometry args={[1.14, 0.008, 8, 48]} />
          <meshStandardMaterial color="#eeeeee" metalness={0.9} roughness={0.08} emissive="#111122" emissiveIntensity={0.15} />
        </mesh>

        <mesh position={[0.2, 0, 0.030]}>
          <ringGeometry args={[0.38, 0.55, 48]} />
          <meshStandardMaterial color="#e0e0e8" metalness={0.9} roughness={0.1} side={THREE.DoubleSide} />
        </mesh>

        <mesh position={[0.2, 0, 0.032]}>
          <ringGeometry args={[0.15, 0.38, 32]} />
          <meshStandardMaterial color="#080808" metalness={0.2} roughness={0.9} side={THREE.DoubleSide} />
        </mesh>

        <mesh position={[0.2, 0, 0.034]} rotation={[Math.PI / 2, 0, 0]}>
          <cylinderGeometry args={[0.14, 0.14, 0.004, 32]} />
          <meshStandardMaterial color="#000000" roughness={1} />
        </mesh>

        {corners.map(([x, y], i) => (
          <mesh key={i} position={[x, y, 0.18]}>
            <cylinderGeometry args={[0.06, 0.06, 0.02, 16]} />
            <meshStandardMaterial color="#1a1a1a" metalness={0.6} roughness={0.4} />
          </mesh>
        ))}

        <RoundedBox args={[3.15, 2.75, 0.08]} radius={0.01} position={[0, 0, -0.08]}>
          <meshStandardMaterial color="#000000" roughness={0.95} />
        </RoundedBox>
      </group>
    </group>
  )
}

// Wraps discs and animates the group's X position using the offset ref.
// On navigation, parent sets offsetRef to the slide-in amount; this lerps it back to 0.
function AnimatedGroup({
  offsetRef,
  children,
}: {
  offsetRef: React.MutableRefObject<number>
  children: React.ReactNode
}) {
  const groupRef = useRef<THREE.Group>(null!)
  useFrame(() => {
    const v = offsetRef.current
    offsetRef.current = Math.abs(v) < 0.001 ? 0 : THREE.MathUtils.lerp(v, 0, 0.14)
    if (groupRef.current) groupRef.current.position.x = offsetRef.current
  })
  return <group ref={groupRef}>{children}</group>
}

function DiscScene({
  albums,
  visibleCount,
  spacing,
  offsetRef,
  onDiscClick,
}: {
  albums: LibraryAlbum[]
  visibleCount: number
  spacing: number
  offsetRef: React.MutableRefObject<number>
  onDiscClick: (a: LibraryAlbum) => void
}) {
  return (
    <>
      <ambientLight intensity={0.4} />
      <directionalLight position={[2, 2, 5]} intensity={0.8} />
      <Environment preset="city" blur={0.5} />
      <AnimatedGroup offsetRef={offsetRef}>
        {albums.map((album, i) => (
          <Disc
            key={album.id}
            album={album}
            position={[(i - (visibleCount - 1) / 2) * spacing, 0, 0]}
            onClick={() => onDiscClick(album)}
          />
        ))}
      </AnimatedGroup>
    </>
  )
}

export default function LibraryDiscStrip({ albums, onDiscClick }: LibraryDiscStripProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const containerWidth = useContainerWidth(containerRef)
  const { visibleCount, spacing, halfWorld } = computeLayout(containerWidth)

  const [startIndex, setStartIndex] = useState(0)
  const animOffsetRef = useRef(0)

  const maxStart = Math.max(0, albums.length - visibleCount)
  const effectiveStart = Math.min(startIndex, maxStart)
  const stepSize = Math.ceil(visibleCount / 2)
  const canScrollLeft = effectiveStart > 0
  const canScrollRight = effectiveStart + visibleCount < albums.length

  const scrollLeft = useCallback(() => {
    const next = Math.max(0, effectiveStart - stepSize)
    if (next === effectiveStart) return
    animOffsetRef.current = -stepSize * spacing
    setStartIndex(next)
  }, [effectiveStart, stepSize, spacing])

  const scrollRight = useCallback(() => {
    const next = Math.min(maxStart, effectiveStart + stepSize)
    if (next === effectiveStart) return
    animOffsetRef.current = stepSize * spacing
    setStartIndex(next)
  }, [maxStart, effectiveStart, stepSize, spacing])

  if (albums.length === 0) return null

  const visibleAlbums = albums.slice(effectiveStart, effectiveStart + visibleCount)

  // Convert each disc's world X position to a CSS percentage of the canvas width.
  // This gives pixel-accurate alignment regardless of spacing or fill factor.
  const slotWidthPct = (spacing / (2 * halfWorld)) * 100
  const titlePositions = visibleAlbums.map((_, i) => {
    const worldX = (i - (visibleCount - 1) / 2) * spacing
    return ((worldX / halfWorld + 1) / 2) * 100
  })

  return (
    <div className="relative w-full" ref={containerRef}>
      {canScrollLeft && (
        <button
          onClick={scrollLeft}
          className="absolute left-0 z-10 w-8 h-8 rounded-full flex items-center justify-center"
          style={{
            top: CANVAS_HEIGHT / 2 - 16,
            background: 'rgba(26,18,16,0.9)',
            border: '1px solid #3D2820',
            color: '#9A8E84',
            boxShadow: '0 2px 8px rgba(0,0,0,0.4)',
          }}
        >
          <ChevronLeft size={18} />
        </button>
      )}

      <Canvas
        camera={{ position: [0, 0, CAM_Z], fov: 45 }}
        style={{ width: '100%', height: CANVAS_HEIGHT, background: 'transparent', display: 'block' }}
        gl={{ alpha: true, antialias: true }}
      >
        <Suspense fallback={null}>
          <DiscScene
            albums={visibleAlbums}
            visibleCount={visibleCount}
            spacing={spacing}
            offsetRef={animOffsetRef}
            onDiscClick={onDiscClick}
          />
        </Suspense>
      </Canvas>

      {/* Title labels absolutely positioned to match each disc's projected center */}
      <div className="relative w-full" style={{ height: 20 }}>
        {visibleAlbums.map((album, i) => (
          <div
            key={album.id}
            className="absolute cursor-pointer overflow-hidden text-center"
            style={{
              left: `${titlePositions[i]}%`,
              transform: 'translateX(-50%)',
              width: `${slotWidthPct * 0.85}%`,
            }}
            onClick={() => onDiscClick(album)}
          >
            <p
              className="text-xs truncate"
              style={{ fontFamily: "'Barlow Semi Condensed', sans-serif", color: '#9A8E84' }}
            >
              {album.title}
            </p>
          </div>
        ))}
      </div>

      {canScrollRight && (
        <button
          onClick={scrollRight}
          className="absolute right-0 z-10 w-8 h-8 rounded-full flex items-center justify-center"
          style={{
            top: CANVAS_HEIGHT / 2 - 16,
            background: 'rgba(26,18,16,0.9)',
            border: '1px solid #3D2820',
            color: '#9A8E84',
            boxShadow: '0 2px 8px rgba(0,0,0,0.4)',
          }}
        >
          <ChevronRight size={18} />
        </button>
      )}
    </div>
  )
}
