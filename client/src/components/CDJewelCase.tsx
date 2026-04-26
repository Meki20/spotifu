import { useRef } from 'react'
import { useTexture, RoundedBox } from '@react-three/drei'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'

interface CDJewelCaseProps {
  coverArtUrl: string
  floatOffset?: number
  tintColor?: string
  tintOpacity?: number
  groupPosition?: [number, number, number]
}

export default function CDJewelCase({
  coverArtUrl,
  floatOffset = 0,
  tintColor = '#ffffff',
  tintOpacity = 0.05,
  groupPosition = [0, 0, 0],
}: CDJewelCaseProps) {
  const groupRef = useRef<THREE.Group>(null!)
  const meshRef = useRef<THREE.Group>(null!)

  const sticker = useTexture(coverArtUrl)
  const grunge = useTexture('/textures/grunge.jpg')
  const scratches = useTexture('/textures/scratches.png')

  sticker.colorSpace = THREE.SRGBColorSpace
  grunge.colorSpace = THREE.SRGBColorSpace
  scratches.colorSpace = THREE.SRGBColorSpace

  grunge.wrapS = grunge.wrapT = THREE.RepeatWrapping
  grunge.repeat.set(1, 1)

  scratches.wrapS = scratches.wrapT = THREE.RepeatWrapping
  scratches.repeat.set(1, 1)

  useFrame((state) => {
    if (!meshRef.current || !groupRef.current) return

    const limit = Math.PI / 16

    const worldPos = new THREE.Vector3(...groupPosition)
    worldPos.project(state.camera)

    const relativeX = state.pointer.x - worldPos.x
    const relativeY = state.pointer.y - worldPos.y

    const targetX = THREE.MathUtils.clamp(
      (-relativeY * Math.PI) / 2,
      -limit,
      limit
    )
    const targetY = THREE.MathUtils.clamp(
      (relativeX * Math.PI) / 2,
      -limit,
      limit
    )

    meshRef.current.rotation.x = THREE.MathUtils.lerp(
      meshRef.current.rotation.x,
      targetX,
      0.08
    )
    meshRef.current.rotation.y = THREE.MathUtils.lerp(
      meshRef.current.rotation.y,
      targetY,
      0.08
    )

    meshRef.current.position.y =
      Math.sin(state.clock.elapsedTime * 1.5 + floatOffset) * 0.08
  })

  const corners = [
    [-1.45, 1.25],
    [1.45, 1.25],
    [-1.45, -1.25],
    [1.45, -1.25],
  ]

  return (
    <group ref={groupRef} position={groupPosition}>
      <group ref={meshRef}>
        {/* FRONT COVER */}
        <RoundedBox args={[3.2, 2.8, 0.05]} radius={0.02} position={[0, 0, 0.15]}>
          <meshPhysicalMaterial
            color={tintColor}
            transparent
            opacity={tintOpacity}
            roughness={0.1}
            metalness={0.05}
            depthWrite={false}
            side={THREE.DoubleSide}
          />
        </RoundedBox>

        {/* COVER ART */}
        <mesh position={[-0.4, -0.4, 0.1812]}>
          <planeGeometry args={[1.5, 1.5]} />
          <meshBasicMaterial
            map={sticker}
            transparent
            opacity={0.95}
            toneMapped={false}
          />
        </mesh>

        {/* GRUNGE OVERLAY */}
        <mesh position={[0, 0, 0.182]}>
          <planeGeometry args={[3.15, 2.75]} />
          <meshBasicMaterial
            map={grunge}
            transparent
            opacity={0.15}
            toneMapped={false}
            depthWrite={false}
          />
        </mesh>

        {/* SCRATCHES OVERLAY */}
        <mesh position={[0, 0, 0.183]}>
          <planeGeometry args={[3.15, 2.75]} />
          <meshBasicMaterial
            map={scratches}
            transparent
            opacity={0.25}
            toneMapped={false}
            depthWrite={false}
          />
        </mesh>

        {/* SILVER CLIP */}
        <mesh position={[-1.35, 0.3, 0.181]}>
          <planeGeometry args={[0.35, 1.0]} />
          <meshStandardMaterial
            color="#f0f0f0"
            metalness={0.95}
            roughness={0.15}
          />
        </mesh>

        {/* ==================== DISC ==================== */}

        {/* Main silver disc body */}
        <mesh position={[0.2, 0, 0]} rotation={[Math.PI / 2, 0, 0]}>
          <cylinderGeometry args={[1.15, 1.15, 0.018, 64]} />
          <meshPhysicalMaterial
            color="#e8e8f0"
            metalness={1}
            roughness={0.02}
            clearcoat={1}
            clearcoatRoughness={0.05}
            iridescence={1}
            iridescenceIOR={3.0}
            iridescenceThicknessRange={[60, 250]}
          />
        </mesh>

        {/* DATA TRACK RINGS */}
        {[0.42, 0.55, 0.68, 0.82, 0.95].map((radius, i) => (
          <mesh key={i} position={[0.2, 0, 0.010 + i * 0.002]}>
            <torusGeometry args={[radius, 0.0015, 4, 64]} />
            <meshStandardMaterial
              color="#c0c0d0"
              metalness={0.8}
              roughness={0.3}
              transparent
              opacity={0.35}
            />
          </mesh>
        ))}

        {/* RIM */}
        <mesh position={[0.2, 0, 0.032]}>
          <torusGeometry args={[1.14, 0.008, 8, 64]} />
          <meshStandardMaterial
            color="#eeeeee"
            metalness={0.9}
            roughness={0.08}
            emissive="#111122"
            emissiveIntensity={0.15}
          />
        </mesh>

        {/* INNER MIRROR BAND */}
        <mesh position={[0.2, 0, 0.034]}>
          <ringGeometry args={[0.38, 0.55, 48]} />
          <meshStandardMaterial
            color="#e0e0e8"
            metalness={0.9}
            roughness={0.1}
            side={THREE.DoubleSide}
          />
        </mesh>

        {/* CENTER HOLE RING */}
        <mesh position={[0.2, 0, 0.036]}>
          <ringGeometry args={[0.15, 0.38, 32]} />
          <meshStandardMaterial
            color="#080808"
            metalness={0.2}
            roughness={0.9}
            side={THREE.DoubleSide}
          />
        </mesh>

        {/* CENTER HUB */}
        <mesh position={[0.2, 0, 0.038]} rotation={[Math.PI / 2, 0, 0]}>
          <cylinderGeometry args={[0.14, 0.14, 0.004, 32]} />
          <meshStandardMaterial color="#000000" roughness={1} />
        </mesh>

        {/* CORNER POSTS */}
        {corners.map(([x, y], i) => (
          <mesh key={i} position={[x, y, 0.18]}>
            <cylinderGeometry args={[0.06, 0.06, 0.02, 16]} />
            <meshStandardMaterial color="#1a1a1a" metalness={0.6} roughness={0.4} />
          </mesh>
        ))}

        {/* DARK TRAY */}
        <RoundedBox args={[3.15, 2.75, 0.08]} radius={0.01} position={[0, 0, -0.08]}>
          <meshStandardMaterial color="#000000" roughness={0.95} />
        </RoundedBox>
      </group>
    </group>
  )
}