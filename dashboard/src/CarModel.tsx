import { useRef } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import * as THREE from "three";

interface CarModelProps {
  pitch: number | null;
  roll: number | null;
  yaw: number | null;
}

/** Ease `current` toward `target` treating both as angles (rad), taking the short way round. */
function lerpAngle(current: number, target: number, t: number): number {
  let diff = target - current;
  diff = Math.atan2(Math.sin(diff), Math.cos(diff)); // wrap into (-π, π]
  return current + diff * t;
}

/**
 * The robot body. Modelled with the length along +Z (the front, with headlights),
 * width along X, up along +Y — so:
 *   pitch (nose up/down) → rotation about the lateral X axis,
 *   roll  (lean sideways) → rotation about the longitudinal Z axis,
 *   yaw   (heading/turn)  → rotation about the vertical Y axis.
 * YXZ order so yaw is applied first (like a car turning on the ground), then tilt.
 * Rotations are eased toward the latest reading each frame so motion looks smooth
 * rather than snapping at 5 readings/sec.
 */
function CarRobot({ pitch, roll, yaw }: { pitch: number; roll: number; yaw: number }) {
  const group = useRef<THREE.Group>(null);

  useFrame(() => {
    const g = group.current;
    if (!g) return;
    g.rotation.order = "YXZ";
    // Negative pitch so a positive reading raises the front (nose up).
    // Negative roll so tilting the sensor's right side down leans the car right
    // (the +Z view is mirrored otherwise — left/right came out swapped).
    g.rotation.x = THREE.MathUtils.lerp(g.rotation.x, THREE.MathUtils.degToRad(-pitch), 0.15);
    g.rotation.z = THREE.MathUtils.lerp(g.rotation.z, THREE.MathUtils.degToRad(-roll), 0.15);
    // yaw wraps at ±180°, so ease along the shortest arc.
    g.rotation.y = lerpAngle(g.rotation.y, THREE.MathUtils.degToRad(yaw), 0.15);
  });

  return (
    <group ref={group}>
      {/* chassis */}
      <mesh position={[0, 0.5, 0]} castShadow>
        <boxGeometry args={[2, 0.4, 3]} />
        <meshStandardMaterial color="#475569" />
      </mesh>

      {/* cabin */}
      <mesh position={[0, 0.95, -0.3]}>
        <boxGeometry args={[1.5, 0.6, 1.3]} />
        <meshStandardMaterial color="#38bdf8" />
      </mesh>

      {/* wheels — cylinders laid on their side (axis along X) */}
      {(
        [
          [1.05, 0.4, 0.95],
          [-1.05, 0.4, 0.95],
          [1.05, 0.4, -0.95],
          [-1.05, 0.4, -0.95],
        ] as const
      ).map(([x, y, z], i) => (
        <mesh key={i} position={[x, y, z]} rotation={[0, 0, Math.PI / 2]}>
          <cylinderGeometry args={[0.4, 0.4, 0.35, 24]} />
          <meshStandardMaterial color="#0f172a" />
        </mesh>
      ))}

      {/* headlights mark the FRONT (+Z) so the direction of tilt is obvious */}
      {([0.55, -0.55] as const).map((x) => (
        <mesh key={x} position={[x, 0.55, 1.52]}>
          <sphereGeometry args={[0.16, 16, 16]} />
          <meshStandardMaterial color="#fde68a" emissive="#fde68a" emissiveIntensity={0.6} />
        </mesh>
      ))}
    </group>
  );
}

export function CarModel({ pitch, roll, yaw }: CarModelProps) {
  return (
    <Canvas camera={{ position: [4.5, 3.5, 5.5], fov: 45 }} dpr={[1, 2]}>
      <ambientLight intensity={0.6} />
      <directionalLight position={[5, 8, 5]} intensity={1.1} />

      <CarRobot pitch={pitch ?? 0} roll={roll ?? 0} yaw={yaw ?? 0} />

      {/* ground reference so the tilt reads against a fixed horizon */}
      <gridHelper args={[20, 20, "#334155", "#1e293b"]} position={[0, 0, 0]} />

      {/* drag to orbit; zoom allowed, panning off to keep the robot centred */}
      <OrbitControls enablePan={false} minDistance={4} maxDistance={14} />
    </Canvas>
  );
}
