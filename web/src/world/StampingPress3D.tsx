import React, { useRef, useState, useMemo } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { OrbitControls, Box, Cylinder, Environment, ContactShadows, Text } from '@react-three/drei';
import * as THREE from 'three';

// Sparks Effect
const Sparks = ({ active, position }: { active: boolean, position: THREE.Vector3 }) => {
  const count = 30;
  const particles = useMemo(() => new Float32Array(count * 3), [count]);
  
  const velocities = useMemo(() => {
    const arr = [];
    for(let i=0; i<count; i++){
      arr.push(new THREE.Vector3((Math.random()-0.5)*8, Math.random()*2, (Math.random()-0.5)*8));
    }
    return arr;
  }, [count]);

  const pointsRef = useRef<THREE.Points>(null);

  useFrame((state, delta) => {
    if(!pointsRef.current) return;
    const positions = pointsRef.current.geometry.attributes.position.array as Float32Array;
    for(let i=0; i<count; i++) {
      if(active) {
        if(Math.random() < 0.2 || positions[i*3+1] < 0.1) {
          positions[i*3] = position.x;
          positions[i*3+1] = position.y;
          positions[i*3+2] = position.z;
          velocities[i].set((Math.random()-0.5)*15, Math.random()*5 + 2, (Math.random()-0.5)*15);
        } else {
          velocities[i].y -= 20 * delta; // Gravity
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
      <pointsMaterial size={0.2} color="#ffaa00" transparent opacity={0.8} blending={THREE.AdditiveBlending} depthWrite={false} />
    </points>
  );
};

export const StampingPressModel = ({ state, tags }: { state: string, tags: Record<string, number> }) => {
  const sliderRef = useRef<THREE.Group>(null);
  const timeRef = useRef(0);
  const isRunning = state === 'running';
  
  // Stamping press moves up and down
  useFrame((_, delta) => {
    if (isRunning) {
      timeRef.current += delta;
    }
    
    // Animation cycle is roughly 2 seconds
    const cycle = (timeRef.current * 0.5) % 1.0;
    
    if (sliderRef.current) {
      // 0.0 ~ 0.3: Move down fast
      // 0.3 ~ 0.4: Hit bottom
      // 0.4 ~ 1.0: Move up slowly
      let yOffset = 0;
      if (cycle < 0.3) {
        yOffset = 3.0 - (cycle / 0.3) * 3.0;
      } else if (cycle < 0.4) {
        yOffset = 0;
      } else {
        yOffset = ((cycle - 0.4) / 0.6) * 3.0;
      }
      sliderRef.current.position.y = yOffset;
    }
  });

  const baseColor = "#445555";
  const machineryColor = state === 'fault' ? "#c85a4a" : "#7b8a8b";
  const cycle = (timeRef.current * 0.5) % 1.0;
  const isHitting = isRunning && cycle > 0.28 && cycle < 0.4;
  const sparkPos = useMemo(() => new THREE.Vector3(0, 1.2, 0), []);

  return (
    <group position={[0, -1, 0]}>
      {/* Base */}
      <Box args={[6, 1, 4]} position={[0, 0.5, 0]} castShadow receiveShadow>
        <meshStandardMaterial color={baseColor} metalness={0.7} />
      </Box>
      <Box args={[4, 0.5, 3]} position={[0, 1, 0]} castShadow receiveShadow>
        <meshStandardMaterial color="#333" metalness={0.8} />
      </Box>

      {/* Side Pillars */}
      <Box args={[1.5, 8, 3]} position={[-2.25, 5, 0]} castShadow receiveShadow>
        <meshStandardMaterial color={machineryColor} />
      </Box>
      <Box args={[1.5, 8, 3]} position={[2.25, 5, 0]} castShadow receiveShadow>
        <meshStandardMaterial color={machineryColor} />
      </Box>
      
      {/* Top Crown */}
      <Box args={[6, 2, 4]} position={[0, 9.5, 0]} castShadow receiveShadow>
        <meshStandardMaterial color={baseColor} metalness={0.5} />
      </Box>

      {/* Slider (Moving Part) */}
      <group ref={sliderRef} position={[0, 3, 0]}>
        <Box args={[3, 2, 2.5]} position={[0, 3.5, 0]} castShadow receiveShadow>
          <meshStandardMaterial color="#889999" />
        </Box>
        {/* Upper Die */}
        <Box args={[2.5, 0.5, 2]} position={[0, 2.25, 0]} castShadow receiveShadow>
          <meshStandardMaterial color="#444" metalness={0.8} />
        </Box>
      </group>

      {/* Lower Die */}
      <Box args={[2.5, 0.5, 2]} position={[0, 1.5, 0]} castShadow receiveShadow>
        <meshStandardMaterial color="#444" metalness={0.8} />
      </Box>

      {/* Workpiece */}
      <Box args={[1.5, 0.1, 1.2]} position={[0, 1.8, 0]} castShadow receiveShadow>
        <meshStandardMaterial color={isHitting ? "#ffaa00" : "#d9a441"} emissive={isHitting ? "#ffaa00" : "#000"} emissiveIntensity={isHitting ? 1 : 0} />
      </Box>

      {/* Sparks */}
      <Sparks active={isHitting} position={sparkPos} />

      {/* Data display */}
      <group position={[0, 9.5, 2.1]}>
        <Text fontSize={0.4} color="#ffffff" anchorX="center" anchorY="middle" position={[0, 0.2, 0]}>
          {`STROKES: ${tags.stroke_count || 0}`}
        </Text>
        <Text fontSize={0.3} color={isRunning ? "#8fd08a" : "#c85a4a"} anchorX="center" anchorY="middle" position={[0, -0.4, 0]}>
          {isRunning ? "RUNNING" : "STOP"}
        </Text>
      </group>
    </group>
  );
};

export default function StampingPress3D({ state, tags }: { state: string, tags?: Record<string, number> }) {
  return (
    <Canvas shadows camera={{ position: [0, 8, 16], fov: 40 }} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", display: "block" }}>
      <OrbitControls 
        enablePan={true}
        enableZoom={true}
        enableRotate={true}
        target={[0, 4, 0]}
        maxPolarAngle={Math.PI / 2 - 0.05} 
      />
      <ambientLight intensity={0.5} />
      <directionalLight position={[10, 20, 10]} intensity={1.2} castShadow shadow-bias={-0.0001} />
      <pointLight position={[-10, 5, 5]} intensity={0.8} />
      
      <StampingPressModel state={state} tags={tags || {}} />
      
      <ContactShadows position={[0, -0.99, 0]} opacity={0.6} scale={30} blur={2} far={10} />
      <Environment preset="warehouse" />

      {/* Floor */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -1, 0]} receiveShadow>
        <planeGeometry args={[50, 50]} />
        <meshStandardMaterial color="#e0e0e0" roughness={0.8} />
      </mesh>
    </Canvas>
  );
}
