import React, { useRef, useState, useEffect, useMemo } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { OrbitControls, Box, Cylinder, Environment, ContactShadows } from '@react-three/drei';
import * as THREE from 'three';

const MAX_LINES = 2000;

// Coolant Effect
const Coolant = ({ active }: { active: boolean }) => {
  const count = 40;
  const particles = useMemo(() => new Float32Array(count * 3), [count]);
  const velocities = useMemo(() => {
    const arr = [];
    for(let i=0; i<count; i++){
      arr.push(new THREE.Vector3((Math.random()-0.5)*0.5, -Math.random()*8 - 4, (Math.random()-0.5)*0.5));
    }
    return arr;
  }, [count]);

  const pointsRef = useRef<THREE.Points>(null);

  useFrame((state, delta) => {
    if(!pointsRef.current) return;
    const positions = pointsRef.current.geometry.attributes.position.array as Float32Array;
    for(let i=0; i<count; i++) {
      if(active) {
        if(positions[i*3+1] < -4.5 || Math.random() < 0.03) {
          positions[i*3] = (Math.random()-0.5)*0.4;
          positions[i*3+1] = -2.0;
          positions[i*3+2] = (Math.random()-0.5)*0.4;
        } else {
          positions[i*3] += velocities[i].x * delta;
          positions[i*3+1] += velocities[i].y * delta;
          positions[i*3+2] += velocities[i].z * delta;
        }
      } else {
        positions[i*3+1] = 100;
      }
    }
    pointsRef.current.geometry.attributes.position.needsUpdate = true;
  });

  return (
    <points ref={pointsRef}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" count={count} array={particles} itemSize={3} />
      </bufferGeometry>
      <pointsMaterial size={0.3} color="#88ccff" transparent opacity={0.6} depthWrite={false} blending={THREE.AdditiveBlending} />
    </points>
  );
};

// Sparks Effect
const Sparks = ({ active, position }: { active: boolean, position: THREE.Vector3 }) => {
  const count = 60;
  const particles = useMemo(() => new Float32Array(count * 3), [count]);
  
  const velocities = useMemo(() => {
    const arr = [];
    for(let i=0; i<count; i++){
      arr.push(new THREE.Vector3((Math.random()-0.5)*3, Math.random()*4, (Math.random()-0.5)*3));
    }
    return arr;
  }, [count]);

  const pointsRef = useRef<THREE.Points>(null);

  useFrame((state, delta) => {
    if(!pointsRef.current) return;
    const positions = pointsRef.current.geometry.attributes.position.array as Float32Array;
    for(let i=0; i<count; i++) {
      if(active) {
        if(Math.random() < 0.1 || positions[i*3+1] < 0.5) {
          positions[i*3] = position.x;
          positions[i*3+1] = position.y;
          positions[i*3+2] = position.z;
          velocities[i].set((Math.random()-0.5)*6, Math.random()*5 + 1, (Math.random()-0.5)*6);
        } else {
          velocities[i].y -= 9.8 * delta; 
          positions[i*3] += velocities[i].x * delta;
          positions[i*3+1] += velocities[i].y * delta;
          positions[i*3+2] += velocities[i].z * delta;
        }
      } else {
        positions[i*3+1] = -100;
      }
    }
    pointsRef.current.geometry.attributes.position.needsUpdate = true;
  });

  return (
    <points ref={pointsRef}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" count={count} array={particles} itemSize={3} />
      </bufferGeometry>
      <pointsMaterial size={0.15} color="#ffaa00" transparent opacity={0.8} blending={THREE.AdditiveBlending} depthWrite={false} />
    </points>
  );
};

const MAX_TRAIL_POINTS = 5000;

function get_target_pos(progress: number, pattern: number) {
  if (pattern === 1) {
    if (progress < 0.05 || progress > 0.95) return [0.0, -150.0, 50.0];
    const p = (progress - 0.05) / 0.9;
    return [Math.cos((p - 0.25) * Math.PI * 2) * 150, Math.sin((p - 0.25) * Math.PI * 2) * 150, -50.0];
  } else if (pattern === 2) {
    if (progress < 0.05 || progress > 0.95) return [-150.0, -150.0, 50.0];
    const p = (progress - 0.05) / 0.9;
    if (p < 0.25) return [-150.0 + 300.0 * (p / 0.25), -150.0, -50.0];
    else if (p < 0.5) return [150.0, -150.0 + 300.0 * ((p - 0.25) / 0.25), -50.0];
    else if (p < 0.75) return [150.0 - 300.0 * ((p - 0.5) / 0.25), 150.0, -50.0];
    else return [-150.0, 150.0 - 300.0 * ((p - 0.75) / 0.25), -50.0];
  } else {
    const strokes = [
      [[-220, -60], [-220, 60]],
      [[-220, 60], [-140, -60]],
      [[-140, -60], [-140, 60]],
      [[-40, 60], [-100, 60], [-100, -60], [-40, -60]], 
      [[40, 60], [40, -60], [100, -60], [100, 60]], 
      [[140, 60], [220, 60]], 
      [[180, 60], [180, -60]] 
    ];
    const total_segments = strokes.length;
    const seg_progress = progress * total_segments;
    const seg_idx = Math.min(Math.floor(seg_progress), total_segments - 1);
    const local_p = seg_progress - seg_idx;
    const stroke = strokes[seg_idx];
    const pts = stroke.length;

    if (local_p < 0.1) {
      return [stroke[0][0], stroke[0][1], 50.0 - 100.0 * (local_p / 0.1)];
    } else if (local_p > 0.9) {
      return [stroke[pts - 1][0], stroke[pts - 1][1], -50.0 + 100.0 * ((local_p - 0.9) / 0.1)];
    } else {
      const cut_p = (local_p - 0.1) / 0.8;
      const cut_segs = pts - 1;
      const c_idx = Math.min(Math.floor(cut_p * cut_segs), cut_segs - 1);
      const cc_p = (cut_p * cut_segs) - c_idx;
      const p1 = stroke[c_idx];
      const p2 = stroke[c_idx + 1];
      const x = p1[0] + (p2[0] - p1[0]) * cc_p;
      const y = p1[1] + (p2[1] - p1[1]) * cc_p;
      return [x, y, -50.0];
    }
  }
}

export const CNCModel = ({ state, tags }: { state: string, tags: Record<string, number> }) => {
  const gantryRef = useRef<THREE.Group>(null);
  const spindleHeadRef = useRef<THREE.Group>(null);
  const drillRef = useRef<THREE.Group>(null);
  const trailMeshRef = useRef<THREE.InstancedMesh>(null);
  
  const lastPartCount = useRef<number>(0);
  const isCutting = useRef<boolean>(false);
  const sparkPos = useRef<THREE.Vector3>(new THREE.Vector3());
  const progressRef = useRef(0);
  const pos = useRef({ x: 0, y: 0, z: 100 }); 
  
  const linesCount = useRef(0);
  const lastCutPos = useRef<THREE.Vector3 | null>(null);
  const dummy = useMemo(() => new THREE.Object3D(), []);

  useFrame((sceneState, delta) => {
    const isRunning = state === 'running';
    const rpm = tags.spindle_speed || 0;
    const pattern = tags.machining_pattern || 0;
    // Speed up the visual animation to 10 seconds per loop instead of actual cycle time 60s
    // so the user can see the shape being drawn quickly without waiting.
    const ct = 10.0; 
    
    if (isRunning) {
      progressRef.current += delta / ct;
      if (progressRef.current >= 1.0) progressRef.current -= 1.0;
    }

    const currentPartCount = tags.part_count || 0;
    if (currentPartCount !== lastPartCount.current) {
        linesCount.current = 0;
        if (trailMeshRef.current) trailMeshRef.current.count = 0;
        lastPartCount.current = currentPartCount;
        lastCutPos.current = null;
        progressRef.current = 0; // sync progress
    }

    // Use continuous local calculation instead of 1Hz telemetry for smooth shape
    let targetX = 0, targetY = 0, targetZ = 1;
    if (isRunning) {
       const [tx, ty, tz] = get_target_pos(progressRef.current, pattern);
       targetX = tx / 50;
       targetY = ty / 50;
       targetZ = tz / 50;
    }

    pos.current.x += (targetX - pos.current.x) * 0.4;
    pos.current.y += (targetY - pos.current.y) * 0.4;
    pos.current.z += (targetZ - pos.current.z) * 0.4;
    
    if (isRunning) {
      const px = pos.current.x;
      const py = pos.current.y;
      const pz = pos.current.z;

      isCutting.current = pz < -0.5; // Only cut when drill is significantly down
      sparkPos.current.set(px, 1.25, py); 
      
      if (isCutting.current) {
        const pt = new THREE.Vector3(px, 1.25, py); 
        if (lastCutPos.current && lastCutPos.current.distanceTo(pt) > 0.08) {
          if (linesCount.current < MAX_TRAIL_POINTS) {
            dummy.position.copy(pt);
            dummy.scale.set(1.4, 0.5, 1.4); // flat wide spheres look like engraved lines
            dummy.updateMatrix();
            if (trailMeshRef.current) {
                trailMeshRef.current.setMatrixAt(linesCount.current, dummy.matrix);
                trailMeshRef.current.instanceMatrix.needsUpdate = true;
                trailMeshRef.current.count = linesCount.current + 1;
            }
            linesCount.current += 1;
          }
          lastCutPos.current.copy(pt);
        } else if (!lastCutPos.current) {
          lastCutPos.current = pt.clone();
        }
      } else {
        lastCutPos.current = null;
      }
    } else {
      isCutting.current = false;
      lastCutPos.current = null;
    }

    if (gantryRef.current) gantryRef.current.position.z = pos.current.y;
    if (spindleHeadRef.current) spindleHeadRef.current.position.x = pos.current.x;
    if (drillRef.current) {
      drillRef.current.position.y = pos.current.z + 0.75; 
      if (isRunning) {
        drillRef.current.rotation.y -= (rpm / 60) * Math.PI * 2 * delta;
      }
    }
  });

  return (
    <group scale={0.5}>
      <ambientLight intensity={0.4} />
      <directionalLight position={[10, 20, 10]} intensity={0.8} castShadow shadow-bias={-0.0001} />
      <pointLight position={[-10, 10, -10]} intensity={0.3} />

      <Box args={[14, 0.5, 14]} position={[0, 0, 0]} receiveShadow>
        <meshStandardMaterial color="#c5bcae" roughness={0.7} metalness={0.2} />
      </Box>

      <Box args={[10, 1, 10]} position={[0, 0.75, 0]} receiveShadow castShadow>
        <meshStandardMaterial color="#e6dfd3" roughness={0.8} />
      </Box>

      <instancedMesh ref={trailMeshRef} args={[undefined, undefined, MAX_TRAIL_POINTS]} castShadow receiveShadow>
        <sphereGeometry args={[0.15, 8, 8]} />
        <meshStandardMaterial color="#7a6b58" roughness={0.9} metalness={0.4} />
      </instancedMesh>

      <Sparks active={isCutting.current} position={sparkPos.current} />

      <group ref={gantryRef} position={[0, 0, 0]}>
        <Box args={[1, 5, 2]} position={[-6.5, 2.5, 0]} castShadow receiveShadow>
          <meshStandardMaterial color="#d8d0c2" />
        </Box>
        <Box args={[1, 5, 2]} position={[6.5, 2.5, 0]} castShadow receiveShadow>
          <meshStandardMaterial color="#d8d0c2" />
        </Box>
        <Box args={[14, 1.5, 2]} position={[0, 5.75, 0]} castShadow receiveShadow>
          <meshStandardMaterial color="#b8ae9a" roughness={0.6} metalness={0.4} />
        </Box>

        <group ref={spindleHeadRef} position={[0, 5, 1]}>
          <Box args={[2, 2.5, 2.5]} position={[0, 0, 0]} castShadow receiveShadow>
            <meshStandardMaterial color={state === 'fault' ? '#c85a4a' : '#b5622e'} roughness={0.4} metalness={0.1} />
          </Box>
          
          <group ref={drillRef} position={[0, 0, 0]}>
            <Cylinder args={[0.4, 0.4, 3, 16]} position={[0, -0.5, 0]} castShadow>
              <meshStandardMaterial color="#8a7c63" metalness={0.6} roughness={0.2} />
            </Cylinder>
            <Cylinder args={[0.1, 0.1, 2, 8]} position={[0, -2.5, 0]} castShadow>
              <meshStandardMaterial color="#5a4c36" metalness={0.8} roughness={0.1} />
            </Cylinder>
            {/* Added stripes to make rotation highly visible */}
            <Box args={[0.12, 1.9, 0.05]} position={[0, -2.5, 0]}>
               <meshStandardMaterial color="#3a3022" />
            </Box>
            <Box args={[0.05, 1.9, 0.12]} position={[0, -2.5, 0]}>
               <meshStandardMaterial color="#3a3022" />
            </Box>
            <Coolant active={state === 'running'} />
          </group>
        </group>
      </group>

      <ContactShadows position={[0, 0.26, 0]} opacity={0.5} scale={20} blur={2} far={10} />
      <Environment preset="city" />
    </group>
  );
};

export default function CncMachine3D({ state, tags }: { state: string, tags?: Record<string, number> }) {
  return (
    <Canvas shadows camera={{ position: [12, 15, 18], fov: 45 }} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", display: "block" }}>
      <OrbitControls 
        enablePan={true}
        enableZoom={true}
        enableRotate={true}
        target={[0, 2, 0]}
        maxPolarAngle={Math.PI / 2 - 0.05} 
      />
      <CNCModel state={state} tags={tags || {}} />
    </Canvas>
  );
}
