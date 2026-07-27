import React, { useRef } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { OrbitControls, Box, Environment, ContactShadows, Text } from '@react-three/drei';
import * as THREE from 'three';

export const EnergyMeterModel = ({ state, tags }: { state: string, tags: Record<string, number> }) => {
  const ledRef1 = useRef<THREE.Mesh>(null);
  const ledRef2 = useRef<THREE.Mesh>(null);
  const ledRef3 = useRef<THREE.Mesh>(null);
  const timeRef = useRef(0);
  
  // Tags
  const kw = tags.active_power || 0;
  const v = tags.voltage || 220;
  const a = tags.current || 0;

  useFrame((_, delta) => {
    timeRef.current += delta;
    
    // Blinking LEDs
    if (ledRef1.current) {
      const mat = ledRef1.current.material as THREE.MeshStandardMaterial;
      const pulse = Math.sin(timeRef.current * 8) > 0 ? 1 : 0;
      mat.emissiveIntensity = pulse * 2;
    }
    if (ledRef2.current) {
      const mat = ledRef2.current.material as THREE.MeshStandardMaterial;
      const pulse = Math.sin(timeRef.current * 4) > 0 ? 1 : 0.2;
      mat.emissiveIntensity = pulse * 2;
    }
    if (ledRef3.current) {
      const mat = ledRef3.current.material as THREE.MeshStandardMaterial;
      mat.emissiveIntensity = 2; // Always on (Power indicator)
    }
  });

  const cabinetColor = "#cccccc";

  return (
    <group position={[0, -1, 0]}>
      {/* Electrical Cabinet */}
      <Box args={[4, 6, 2]} position={[0, 3, 0]} castShadow receiveShadow>
        <meshStandardMaterial color={cabinetColor} metalness={0.4} roughness={0.6} />
      </Box>
      {/* Base Plinth */}
      <Box args={[4.2, 0.5, 2.2]} position={[0, 0.25, 0]} castShadow receiveShadow>
        <meshStandardMaterial color="#444" />
      </Box>
      
      {/* Door panel grooves */}
      <Box args={[3.6, 5.6, 0.1]} position={[0, 3, 1.01]}>
        <meshStandardMaterial color="#d4d4d4" />
      </Box>

      {/* Meter Display Unit */}
      <group position={[0, 4, 1.05]}>
        {/* Bezel */}
        <Box args={[2.5, 1.5, 0.2]} castShadow receiveShadow>
          <meshStandardMaterial color="#222" />
        </Box>
        {/* Screen */}
        <Box args={[2.3, 1.3, 0.1]} position={[0, 0, 0.1]}>
          <meshStandardMaterial color="#1a2a1a" emissive="#051505" emissiveIntensity={1} />
        </Box>

        {/* Text Display */}
        <Text fontSize={0.3} color="#5a9e5a" anchorX="right" anchorY="top" position={[1.0, 0.5, 0.16]}>
          {`${kw.toFixed(1)} kW`}
        </Text>
        <Text fontSize={0.15} color="#5a9e5a" anchorX="right" anchorY="top" position={[1.0, 0.1, 0.16]}>
          ACTIVE POWER
        </Text>
        <Text fontSize={0.2} color="#5a9e5a" anchorX="left" anchorY="bottom" position={[-1.0, -0.2, 0.16]}>
          {`${v.toFixed(0)} V`}
        </Text>
        <Text fontSize={0.2} color="#5a9e5a" anchorX="right" anchorY="bottom" position={[1.0, -0.2, 0.16]}>
          {`${a.toFixed(1)} A`}
        </Text>
      </group>

      {/* Indicator LEDs */}
      <group position={[-1.3, 2.8, 1.05]}>
        <mesh ref={ledRef1} position={[0, 0, 0]}>
          <circleGeometry args={[0.1, 16]} />
          <meshStandardMaterial color="#c85a4a" emissive="#c85a4a" emissiveIntensity={0} />
        </mesh>
        <mesh ref={ledRef2} position={[0.4, 0, 0]}>
          <circleGeometry args={[0.1, 16]} />
          <meshStandardMaterial color="#d9a441" emissive="#d9a441" emissiveIntensity={0} />
        </mesh>
        <mesh ref={ledRef3} position={[0.8, 0, 0]}>
          <circleGeometry args={[0.1, 16]} />
          <meshStandardMaterial color="#5a9e5a" emissive="#5a9e5a" emissiveIntensity={2} />
        </mesh>
      </group>
      
      {/* Breaker Handles / Switches */}
      <Box args={[0.6, 0.4, 0.2]} position={[1.0, 2.8, 1.05]} castShadow>
        <meshStandardMaterial color="#333" />
      </Box>
      <Box args={[0.4, 0.8, 0.1]} position={[1.0, 2.8, 1.15]} rotation={[Math.PI/4, 0, 0]} castShadow>
        <meshStandardMaterial color="#cc4444" />
      </Box>
      
      {/* Warning Label */}
      <group position={[0, 1.5, 1.06]}>
        <Box args={[1.5, 0.8, 0.02]}>
          <meshStandardMaterial color="#e6c229" />
        </Box>
        <Text fontSize={0.2} color="#000" anchorX="center" anchorY="middle" position={[0, 0, 0.02]}>
          DANGER
        </Text>
        <Text fontSize={0.15} color="#000" anchorX="center" anchorY="middle" position={[0, -0.2, 0.02]}>
          HIGH VOLTAGE
        </Text>
      </group>
    </group>
  );
};

export default function EnergyMeter3D({ state, tags }: { state: string, tags?: Record<string, number> }) {
  return (
    <Canvas shadows camera={{ position: [5, 5, 10], fov: 45 }} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", display: "block" }}>
      <OrbitControls 
        enablePan={true}
        enableZoom={true}
        enableRotate={true}
        target={[0, 3, 0]}
        maxPolarAngle={Math.PI / 2 - 0.05} 
      />
      <ambientLight intensity={0.5} />
      <directionalLight position={[10, 20, 10]} intensity={1.2} castShadow shadow-bias={-0.0001} />
      <pointLight position={[-5, 5, 5]} intensity={0.6} />
      
      <EnergyMeterModel state={state} tags={tags || {}} />
      
      <ContactShadows position={[0, -0.99, 0]} opacity={0.6} scale={15} blur={2} far={5} />
      <Environment preset="warehouse" />

      {/* Floor */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -1, 0]} receiveShadow>
        <planeGeometry args={[30, 30]} />
        <meshStandardMaterial color="#e0e0e0" roughness={0.8} />
      </mesh>
    </Canvas>
  );
}
