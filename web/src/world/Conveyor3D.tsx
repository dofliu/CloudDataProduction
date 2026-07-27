import React, { useRef, useMemo } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { OrbitControls, Box, Cylinder, Environment, ContactShadows, Text } from '@react-three/drei';
import * as THREE from 'three';

export const ConveyorModel = ({ state, tags }: { state: string, tags: Record<string, number> }) => {
  const partsRef = useRef<THREE.InstancedMesh>(null);
  const beltRef = useRef<THREE.Mesh>(null);
  const timeRef = useRef(0);
  
  const isRunning = state === 'running';
  const speed = tags.belt_speed || 1.0;
  
  // Conveyor dimension
  const length = 12;
  const width = 2;
  const height = 1.5;
  
  // Instance parts (boxes moving along conveyor)
  const partCount = 8;
  const dummy = useMemo(() => new THREE.Object3D(), []);
  
  // Belt texture
  const beltTexture = useMemo(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 256;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.fillStyle = '#333';
      ctx.fillRect(0, 0, 256, 256);
      ctx.strokeStyle = '#222';
      ctx.lineWidth = 10;
      for (let i = 0; i < 10; i++) {
        ctx.beginPath();
        ctx.moveTo(0, i * 25.6);
        ctx.lineTo(256, i * 25.6);
        ctx.stroke();
      }
    }
    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(1, 4);
    return tex;
  }, []);

  useFrame((_, delta) => {
    if (isRunning) {
      timeRef.current += delta * speed;
      
      // Animate belt UV
      if (beltRef.current) {
        const mat = beltRef.current.material as THREE.MeshStandardMaterial;
        if (mat.map) {
          mat.map.offset.y -= delta * speed * 0.5;
        }
      }
    }

    if (partsRef.current) {
      for (let i = 0; i < partCount; i++) {
        // Offset each part in time
        let progress = ((timeRef.current * 0.5 + i / partCount) % 1.0);
        
        // Map 0~1 progress to X coordinate along conveyor
        const xPos = -length / 2 + progress * length;
        
        dummy.position.set(xPos, height + 0.3, 0);
        
        // Parts bob up slightly or rotate if they hit edges? No, just straight move
        dummy.updateMatrix();
        partsRef.current.setMatrixAt(i, dummy.matrix);
      }
      partsRef.current.instanceMatrix.needsUpdate = true;
    }
  });

  const baseColor = "#506060";
  const machineryColor = state === 'fault' ? "#c85a4a" : "#7b8a8b";

  return (
    <group position={[0, -1, 0]}>
      {/* Conveyor Main Body */}
      <Box args={[length + 0.5, height - 0.2, width + 0.5]} position={[0, height / 2 - 0.1, 0]} castShadow receiveShadow>
        <meshStandardMaterial color={machineryColor} metalness={0.6} />
      </Box>

      {/* Belt */}
      <Box ref={beltRef} args={[length, 0.2, width]} position={[0, height - 0.1, 0]} receiveShadow>
        <meshStandardMaterial map={beltTexture} roughness={0.9} metalness={0.1} />
      </Box>
      
      {/* End Rollers */}
      <Cylinder args={[0.2, 0.2, width, 16]} rotation={[Math.PI/2, 0, 0]} position={[-length/2 - 0.1, height - 0.2, 0]} castShadow receiveShadow>
        <meshStandardMaterial color="#333" />
      </Cylinder>
      <Cylinder args={[0.2, 0.2, width, 16]} rotation={[Math.PI/2, 0, 0]} position={[length/2 + 0.1, height - 0.2, 0]} castShadow receiveShadow>
        <meshStandardMaterial color="#333" />
      </Cylinder>

      {/* Legs */}
      {[-length/2 + 1, length/2 - 1].map((x, i) => (
        <group key={i}>
          <Cylinder args={[0.1, 0.1, height, 16]} position={[x, height/2, width/2]} castShadow receiveShadow>
            <meshStandardMaterial color="#aaaaaa" />
          </Cylinder>
          <Cylinder args={[0.1, 0.1, height, 16]} position={[x, height/2, -width/2]} castShadow receiveShadow>
            <meshStandardMaterial color="#aaaaaa" />
          </Cylinder>
        </group>
      ))}

      {/* Moving Parts */}
      <instancedMesh ref={partsRef} args={[undefined, undefined, partCount]} castShadow receiveShadow>
        <boxGeometry args={[0.8, 0.6, 0.8]} />
        <meshStandardMaterial color="#f09000" roughness={0.3} metalness={0.8} />
      </instancedMesh>

      {/* Sensor/Control Box */}
      <Box args={[0.5, 1.5, 0.5]} position={[0, height, width/2 + 0.3]} castShadow receiveShadow>
         <meshStandardMaterial color={baseColor} />
      </Box>
      <group position={[0, height + 0.5, width/2 + 0.56]}>
        <Text fontSize={0.25} color={isRunning ? "#8fd08a" : "#c85a4a"} anchorX="center" anchorY="middle" position={[0, 0, 0]}>
          {isRunning ? "RUNNING" : "STOP"}
        </Text>
      </group>
    </group>
  );
};

export default function Conveyor3D({ state, tags }: { state: string, tags?: Record<string, number> }) {
  return (
    <Canvas shadows camera={{ position: [0, 8, 12], fov: 40 }} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", display: "block" }}>
      <OrbitControls 
        enablePan={true}
        enableZoom={true}
        enableRotate={true}
        target={[0, 2, 0]}
        maxPolarAngle={Math.PI / 2 - 0.05} 
      />
      <ambientLight intensity={0.5} />
      <directionalLight position={[10, 20, 10]} intensity={1.2} castShadow shadow-bias={-0.0001} />
      <pointLight position={[-5, 5, 5]} intensity={0.8} />
      
      <ConveyorModel state={state} tags={tags || {}} />
      
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
