import React, { useRef, useMemo } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { OrbitControls, Box, Cylinder, Environment, ContactShadows, Text } from '@react-three/drei';
import * as THREE from 'three';

export const AirCompressorModel = ({ state, tags }: { state: string, tags: Record<string, number> }) => {
  const fanRef = useRef<THREE.Group>(null);
  const pistonRef = useRef<THREE.Mesh>(null);
  const timeRef = useRef(0);
  
  const isRunning = state === 'running';
  
  // Tags
  const pressure = tags.tank_pressure || 0; 
  const rpm = isRunning ? 1500 : 0; // standard motor rpm, visual mapping

  useFrame((_, delta) => {
    if (isRunning) {
      timeRef.current += delta;
      
      // Rotate fan/pulley
      if (fanRef.current) {
        // High speed rotation, toned down slightly for visual clarity
        fanRef.current.rotation.z -= (rpm / 60) * Math.PI * 2 * delta * 0.1;
      }
      
      // Move piston up and down rapidly
      if (pistonRef.current) {
         const pistonCycle = (timeRef.current * 10) % (Math.PI * 2);
         pistonRef.current.position.y = 1.2 + Math.sin(pistonCycle) * 0.15;
      }
    }
  });

  const baseColor = "#556666";
  const machineryColor = state === 'fault' ? "#c85a4a" : "#7b8a8b";
  const copperColor = "#b87333";
  const tankColor = "#4477aa"; // Often blue for air compressors

  return (
    <group position={[0, -1, 0]}>
      {/* Main Air Tank (Horizontal Cylinder) */}
      <Cylinder args={[1.5, 1.5, 7, 32]} rotation={[0, 0, Math.PI / 2]} position={[0, 1.5, 0]} castShadow receiveShadow>
        <meshStandardMaterial color={tankColor} metalness={0.6} roughness={0.4} />
      </Cylinder>
      {/* Tank End Caps (Spheres or squashed cylinders) */}
      <mesh position={[-3.5, 1.5, 0]} castShadow receiveShadow>
        <sphereGeometry args={[1.5, 32, 16, 0, Math.PI*2, 0, Math.PI/2]} />
        <meshStandardMaterial color={tankColor} metalness={0.6} roughness={0.4} />
      </mesh>
      <mesh position={[3.5, 1.5, 0]} rotation={[0, 0, Math.PI]} castShadow receiveShadow>
        <sphereGeometry args={[1.5, 32, 16, 0, Math.PI*2, 0, Math.PI/2]} />
        <meshStandardMaterial color={tankColor} metalness={0.6} roughness={0.4} />
      </mesh>

      {/* Tank Feet */}
      {[-2.5, 2.5].map((x, i) => (
        <group key={i}>
          <Box args={[0.5, 1.0, 1.2]} position={[x, 0.5, 0.8]} castShadow receiveShadow>
            <meshStandardMaterial color="#333" />
          </Box>
          <Box args={[0.5, 1.0, 1.2]} position={[x, 0.5, -0.8]} castShadow receiveShadow>
            <meshStandardMaterial color="#333" />
          </Box>
        </group>
      ))}

      {/* Platform on top of tank for motor and pump */}
      <Box args={[4, 0.2, 2.5]} position={[0.5, 3.1, 0]} castShadow receiveShadow>
        <meshStandardMaterial color="#222" />
      </Box>

      {/* Motor */}
      <Cylinder args={[0.7, 0.7, 2, 32]} rotation={[Math.PI / 2, 0, 0]} position={[1.5, 3.8, 0]} castShadow receiveShadow>
        <meshStandardMaterial color={machineryColor} />
      </Cylinder>
      
      {/* Motor Pulley */}
      <Cylinder args={[0.3, 0.3, 0.2, 16]} rotation={[Math.PI / 2, 0, 0]} position={[1.5, 3.8, 1.1]} castShadow receiveShadow>
        <meshStandardMaterial color="#444" />
      </Cylinder>

      {/* Compressor Pump Housing */}
      <Box args={[1.5, 1.5, 1.5]} position={[-0.5, 3.85, 0]} castShadow receiveShadow>
        <meshStandardMaterial color={machineryColor} />
      </Box>
      
      {/* Cooling Fins / Cylinders */}
      <group position={[-0.5, 4.6, 0]}>
        {[0, 1, 2, 3, 4].map((i) => (
          <Box key={i} args={[1.2, 0.05, 1.2]} position={[0, i * 0.15, 0]} castShadow receiveShadow>
            <meshStandardMaterial color="#555" />
          </Box>
        ))}
        {/* Piston Head inside fins (mostly hidden but slightly visible) */}
        <Cylinder ref={pistonRef} args={[0.4, 0.4, 0.8, 16]} position={[0, 0.4, 0]}>
           <meshStandardMaterial color="#ccc" />
        </Cylinder>
      </group>

      {/* Large Pulley / Flywheel on Compressor with Fan Spokes */}
      <group position={[-0.5, 3.8, 1.1]} ref={fanRef}>
        <Cylinder args={[1.2, 1.2, 0.2, 32]} rotation={[Math.PI / 2, 0, 0]} castShadow receiveShadow>
          <meshStandardMaterial color="#222" wireframe={false} />
        </Cylinder>
        {/* Spokes to act as cooling fan */}
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <Box key={i} args={[2.4, 0.1, 0.1]} rotation={[0, 0, i * Math.PI / 3]} castShadow receiveShadow>
            <meshStandardMaterial color="#444" />
          </Box>
        ))}
      </group>

      {/* V-Belt connecting Motor and Compressor pulleys */}
      {/* Just a simple slanted box connecting the top and bottom of pulleys */}
      <group position={[0.5, 3.8, 1.1]} rotation={[0, 0, Math.atan2(0, 2)]}> 
         <Box args={[2.0, 0.8, 0.15]} position={[0, 0, 0]} castShadow receiveShadow>
            <meshStandardMaterial color="#111" />
         </Box>
      </group>

      {/* Copper Pipe connecting pump to tank */}
      <Cylinder args={[0.1, 0.1, 2, 8]} position={[-1.5, 3.5, 0]} rotation={[0, 0, Math.PI / 6]} castShadow receiveShadow>
         <meshStandardMaterial color={copperColor} roughness={0.3} metalness={0.8} />
      </Cylinder>
      
      {/* Pressure Gauge */}
      <group position={[-2.5, 3.5, 1.0]}>
        <Cylinder args={[0.3, 0.3, 0.1, 16]} rotation={[Math.PI / 2, 0, 0]} castShadow receiveShadow>
           <meshStandardMaterial color="#ddd" />
        </Cylinder>
        <Box args={[0.4, 0.1, 0.05]} position={[0, 0, 0.05]} rotation={[0, 0, -pressure * 0.5]}>
           <meshStandardMaterial color="#c85a4a" />
        </Box>
      </group>

      {/* Data display */}
      <group position={[-2.5, 4.5, 0]}>
        <Text fontSize={0.4} color="#ffffff" anchorX="center" anchorY="middle" position={[0, 0.2, 0]}>
          {`PRESSURE: ${pressure.toFixed(1)} bar`}
        </Text>
        <Text fontSize={0.3} color={isRunning ? "#8fd08a" : "#c85a4a"} anchorX="center" anchorY="middle" position={[0, -0.4, 0]}>
          {isRunning ? "RUNNING" : "STOP"}
        </Text>
      </group>
    </group>
  );
};

export default function AirCompressor3D({ state, tags }: { state: string, tags?: Record<string, number> }) {
  return (
    <Canvas shadows camera={{ position: [0, 6, 12], fov: 45 }} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", display: "block" }}>
      <OrbitControls 
        enablePan={true}
        enableZoom={true}
        enableRotate={true}
        target={[0, 2.5, 0]}
        maxPolarAngle={Math.PI / 2 - 0.05} 
      />
      <ambientLight intensity={0.5} />
      <directionalLight position={[10, 20, 10]} intensity={1.2} castShadow shadow-bias={-0.0001} />
      <pointLight position={[-10, 5, 10]} intensity={0.8} />
      
      <AirCompressorModel state={state} tags={tags || {}} />
      
      <ContactShadows position={[0, -0.99, 0]} opacity={0.6} scale={20} blur={2} far={10} />
      <Environment preset="warehouse" />

      {/* Floor */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -1, 0]} receiveShadow>
        <planeGeometry args={[50, 50]} />
        <meshStandardMaterial color="#e0e0e0" roughness={0.8} />
      </mesh>
    </Canvas>
  );
}
