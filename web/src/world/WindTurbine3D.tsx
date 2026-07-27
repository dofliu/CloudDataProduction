import React, { useRef } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { OrbitControls, Box, Cylinder, Environment, ContactShadows, Text } from '@react-three/drei';
import * as THREE from 'three';

export const WindTurbineModel = ({ state, tags }: { state: string, tags: Record<string, number> }) => {
  const rotorRef = useRef<THREE.Group>(null);
  
  const isRunning = state === 'running';
  // tags.rotor_rpm usually around 10-20. Let's map it to visual rotation speed.
  const rpm = tags.rotor_rpm || (isRunning ? 15 : 0);
  const yaw = tags.yaw_angle || 0; // Rotate the whole nacelle

  useFrame((_, delta) => {
    if (rotorRef.current) {
      // 1 RPM = 2PI radians / 60 seconds
      rotorRef.current.rotation.z -= (rpm * Math.PI * 2 / 60) * delta;
    }
  });

  const baseColor = "#dddddd";
  const bladeColor = "#ffffff";
  const faultColor = "#c85a4a";
  const towerColor = state === 'fault' ? faultColor : baseColor;

  return (
    <group position={[0, -1, 0]}>
      {/* Tower Base */}
      <Cylinder args={[1.5, 2.0, 1, 32]} position={[0, 0.5, 0]} castShadow receiveShadow>
        <meshStandardMaterial color="#666" />
      </Cylinder>

      {/* Tall Tower */}
      <Cylinder args={[0.8, 1.5, 14, 32]} position={[0, 8, 0]} castShadow receiveShadow>
        <meshStandardMaterial color={towerColor} />
      </Cylinder>

      {/* Nacelle & Rotor (Yaw control rotates this part around Y) */}
      <group position={[0, 15, 0]} rotation={[0, THREE.MathUtils.degToRad(yaw), 0]}>
        
        {/* Nacelle (Generator Housing) */}
        <Box args={[2, 2, 4.5]} position={[0, 0, -1]} castShadow receiveShadow>
          <meshStandardMaterial color={baseColor} />
        </Box>
        
        {/* Hub / Rotor Center */}
        <group position={[0, 0, 1.5]} ref={rotorRef}>
          <Cylinder args={[0.6, 0.8, 1.5, 16]} rotation={[Math.PI / 2, 0, 0]} castShadow receiveShadow>
             <meshStandardMaterial color="#ccc" />
          </Cylinder>

          {/* 3 Blades */}
          {[0, 1, 2].map((i) => {
            const angle = (i * Math.PI * 2) / 3;
            return (
              <group key={i} rotation={[0, 0, angle]}>
                {/* Blade geometry: we can use a flattened cylinder or box */}
                <Box args={[0.5, 10, 0.1]} position={[0, 5.5, 0]} castShadow receiveShadow>
                  <meshStandardMaterial color={bladeColor} />
                </Box>
              </group>
            );
          })}
        </group>

        {/* Data display on Nacelle */}
        <group position={[1.1, 0, -1]} rotation={[0, Math.PI / 2, 0]}>
          <Text fontSize={0.5} color="#333" anchorX="center" anchorY="middle" position={[0, 0, 0]}>
            {`${rpm.toFixed(1)} RPM`}
          </Text>
        </group>
        <group position={[-1.1, 0, -1]} rotation={[0, -Math.PI / 2, 0]}>
          <Text fontSize={0.5} color="#333" anchorX="center" anchorY="middle" position={[0, 0, 0]}>
            {`${rpm.toFixed(1)} RPM`}
          </Text>
        </group>
      </group>
    </group>
  );
};

export default function WindTurbine3D({ state, tags }: { state: string, tags?: Record<string, number> }) {
  return (
    <Canvas shadows camera={{ position: [15, 15, 25], fov: 40 }} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", display: "block" }}>
      <OrbitControls 
        enablePan={true}
        enableZoom={true}
        enableRotate={true}
        target={[0, 10, 0]}
        maxPolarAngle={Math.PI / 2 - 0.05} 
      />
      <ambientLight intensity={0.6} />
      <directionalLight position={[20, 30, 20]} intensity={1.0} castShadow shadow-bias={-0.0001} />
      <pointLight position={[-10, 15, 10]} intensity={0.5} />
      
      <WindTurbineModel state={state} tags={tags || {}} />
      
      <ContactShadows position={[0, -0.99, 0]} opacity={0.4} scale={40} blur={3} far={20} />
      
      {/* For a wind turbine, an outdoor environment might be nicer, but warehouse matches the factory. */}
      <Environment preset="city" />

      {/* Ground */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -1, 0]} receiveShadow>
        <planeGeometry args={[100, 100]} />
        <meshStandardMaterial color="#6a8a5a" roughness={1.0} /> {/* Grass-like color for outdoor turbine */}
      </mesh>
    </Canvas>
  );
}
