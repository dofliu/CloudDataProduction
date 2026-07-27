import React, { useRef, useState, useEffect } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { OrbitControls, Box, Cylinder, Environment, ContactShadows, Text } from '@react-three/drei';
import * as THREE from 'three';

export const InjectionMoldingModel = ({ state, tags }: { state: string, tags: Record<string, number> }) => {
  const movingPlatenRef = useRef<THREE.Group>(null);
  const screwRef = useRef<THREE.Mesh>(null);
  const meltRef = useRef<THREE.Mesh>(null);
  const hopperMaterialRef = useRef<THREE.Mesh>(null);
  const productInsideRef = useRef<THREE.Mesh>(null);

  const [fallingParts, setFallingParts] = useState<{ id: number, x: number, y: number, z: number, rot: number }[]>([]);
  
  const visualPhase = useRef(0);
  const lastPhase = useRef(0);

  useFrame((_, delta) => {
    if (state === 'running') {
      lastPhase.current = visualPhase.current;
      visualPhase.current = (visualPhase.current + delta / 6.0) % 1.0; // 6s cycle
    } else {
      visualPhase.current = 0; 
    }

    const phase = visualPhase.current;

    // 1. Material Injecting Effect (0.0 ~ 0.3)
    const isInjecting = phase >= 0.0 && phase < 0.3;
    if (meltRef.current && hopperMaterialRef.current && screwRef.current) {
      if (isInjecting) {
        // Screw moves forward
        screwRef.current.position.x = -7.5 + (phase / 0.3) * 0.5;
        // Screw rotates fast
        screwRef.current.rotation.x += delta * 10;
        
        // Melted plastic fills the nozzle
        meltRef.current.scale.y = 0.1 + (phase / 0.3) * 0.9;
        meltRef.current.position.x = -4.5 - (meltRef.current.scale.y * 1.5) / 2; // grow towards left? No, mold is at -4. Barrel is at -6.
        // Wait, Barrel is at -6, Mold at -4. Flow is from -6 to -4 (towards +X).
        // Cylinder is rotated Math.PI/2 around Z. So local Y is global X.
        meltRef.current.scale.y = Math.max(0.01, (phase / 0.3)); 
        meltRef.current.position.x = -5.0 + (meltRef.current.scale.y * 2) / 2;
        
        (meltRef.current.material as THREE.MeshStandardMaterial).emissiveIntensity = 2.0;
        (meltRef.current.material as THREE.MeshStandardMaterial).color.setHex(0xff5500);

        // Hopper material sinks
        hopperMaterialRef.current.scale.y = 1.0 - (phase / 0.3) * 0.2;
        hopperMaterialRef.current.position.y = 5.0 - (phase / 0.3) * 0.1;
      } else {
        // Retract screw
        screwRef.current.position.x = -7.5;
        meltRef.current.scale.y = 0.01;
        hopperMaterialRef.current.scale.y = 1.0;
        hopperMaterialRef.current.position.y = 5.0;
      }
    }

    // 2. Cooling Effect (0.3 ~ 0.5)
    if (phase >= 0.3 && phase < 0.5) {
       const coolProgress = (phase - 0.3) / 0.2;
       if (productInsideRef.current) {
         const mat = productInsideRef.current.material as THREE.MeshStandardMaterial;
         // Fade from bright orange to solid color
         mat.emissiveIntensity = 2.0 * (1.0 - coolProgress);
       }
    }

    // 3. Mold Opening & Closing (0.5 ~ 1.0)
    let moldOpenAmount = 0;
    if (phase >= 0.5 && phase < 0.65) {
      moldOpenAmount = ((phase - 0.5) / 0.15) * 2.0; // Open to 2.0
    } else if (phase >= 0.65 && phase < 0.8) {
      moldOpenAmount = 2.0; // Stay open
    } else if (phase >= 0.8 && phase <= 1.0) {
      moldOpenAmount = (1.0 - ((phase - 0.8) / 0.2)) * 2.0; // Close
    }

    if (movingPlatenRef.current) {
      // Move along X axis!
      movingPlatenRef.current.position.x = moldOpenAmount;
    }

    // Product Visibility inside mold
    if (productInsideRef.current) {
      if (phase >= 0.0 && phase < 0.65) {
        productInsideRef.current.visible = phase > 0.1; // becomes visible during injection
        if (phase < 0.3) {
            (productInsideRef.current.material as THREE.MeshStandardMaterial).emissiveIntensity = 2.0;
        }
      } else {
        productInsideRef.current.visible = false;
      }
    }

    // 4. Product Ejection (falling down)
    // Trigger exactly when crossing 0.65
    if (lastPhase.current < 0.65 && phase >= 0.65) {
      setFallingParts(prev => [...prev, { id: Date.now(), x: -2.0, y: 2.5, z: 0, rot: Math.random() }]);
    }

    // Update falling parts physics
    setFallingParts(prev => prev
      .map(p => ({ ...p, y: p.y - delta * 4, rot: p.rot + delta * 2 }))
      .filter(p => p.y > -2)
    );
  });

  const baseColor = "#506060";
  const machineryColor = state === 'fault' ? "#c85a4a" : "#7b8a8b";
  const moldColor = "#444444";
  const screwColor = "#aaaaaa";

  return (
    <group position={[0, -1, 0]}>
      {/* Base Frame */}
      <Box args={[12, 1, 4]} position={[0, 0.5, 0]} castShadow receiveShadow>
        <meshStandardMaterial color={baseColor} metalness={0.7} />
      </Box>

      {/* Stationary Platen (Left side of mold, global X = -3.5) */}
      <Box args={[1, 4, 3.5]} position={[-3.5, 3, 0]} castShadow receiveShadow>
        <meshStandardMaterial color={machineryColor} />
      </Box>
      {/* Fixed Mold Half */}
      <Box args={[0.8, 2.5, 2.5]} position={[-2.6, 3, 0]} castShadow receiveShadow>
        <meshStandardMaterial color={moldColor} metalness={0.8} />
      </Box>

      {/* Tie Bars (Guide rods) along X axis */}
      {[[-1.2, 1.2], [-1.2, -1.2], [1.2, 1.2], [1.2, -1.2]].map((pos, i) => (
        <Cylinder key={i} args={[0.1, 0.1, 6, 16]} rotation={[0, 0, Math.PI / 2]} position={[0, 3 + pos[0], pos[1]]} castShadow receiveShadow>
          <meshStandardMaterial color="#cccccc" metalness={0.9} />
        </Cylinder>
      ))}

      {/* Moving Platen Group */}
      <group position={[-1, 0, 0]} ref={movingPlatenRef}>
        {/* Moving Mold Half */}
        <Box args={[0.8, 2.5, 2.5]} position={[-0.8, 3, 0]} castShadow receiveShadow>
          <meshStandardMaterial color={moldColor} metalness={0.8} />
        </Box>
        {/* Main Platen Body */}
        <Box args={[1, 4, 3.5]} position={[0.1, 3, 0]} castShadow receiveShadow>
          <meshStandardMaterial color={machineryColor} />
        </Box>
        
        {/* Finished product stuck to moving half before ejection */}
        <Box ref={productInsideRef} args={[0.4, 1.5, 1.5]} position={[-1.4, 3, 0]} castShadow>
          <meshStandardMaterial color="#f09000" emissive="#ff5500" emissiveIntensity={0} />
        </Box>
      </group>

      {/* Clamping Unit Mechanism (Toggle shield) */}
      <Box args={[2, 3, 2]} position={[2, 2.5, 0]} castShadow receiveShadow>
        <meshStandardMaterial color={machineryColor} />
      </Box>

      {/* Injection Unit (Left Side of Stationary Platen) */}
      {/* Hopper */}
      <Cylinder args={[0.6, 0.1, 1.5, 16]} position={[-5.5, 5.5, 0]} castShadow receiveShadow>
        <meshStandardMaterial color="#ffffff" opacity={0.3} transparent />
      </Cylinder>
      {/* Hopper Material Level */}
      <Cylinder ref={hopperMaterialRef} args={[0.55, 0.15, 1.4, 16]} position={[-5.5, 5.5, 0]}>
        <meshStandardMaterial color="#f09000" />
      </Cylinder>
      
      {/* Barrel */}
      <Cylinder args={[0.5, 0.5, 4, 32]} rotation={[0, 0, Math.PI / 2]} position={[-6, 3, 0]} castShadow receiveShadow>
        <meshStandardMaterial color={machineryColor} />
      </Cylinder>
      
      {/* Melted Plastic Flowing (Inside/Through Barrel to Mold) */}
      <Cylinder ref={meltRef} args={[0.15, 0.15, 2, 16]} rotation={[0, 0, Math.PI / 2]} position={[-4.5, 3, 0]}>
        <meshStandardMaterial color="#ff5500" emissive="#ff5500" emissiveIntensity={2.0} />
      </Cylinder>

      {/* Screw Extrusion (visible window for animation) */}
      <Box args={[3, 1.1, 1.1]} position={[-8.5, 3, 0]} castShadow receiveShadow>
        <meshStandardMaterial color="#333333" />
      </Box>
      <Cylinder ref={screwRef} args={[0.3, 0.3, 2.5, 16]} rotation={[0, 0, Math.PI / 2]} position={[-7.5, 3, 0]}>
        <meshStandardMaterial color={screwColor} wireframe />
      </Cylinder>

      {/* Falling Parts Animation */}
      {fallingParts.map(part => (
        <group key={part.id} position={[part.x, part.y, part.z]} rotation={[part.rot, part.rot, 0]}>
          <Box args={[0.4, 1.5, 1.5]} castShadow>
            <meshStandardMaterial color="#f09000" />
          </Box>
        </group>
      ))}
      
      {/* Data display on machine */}
      <group position={[-3.5, 5.5, 1.8]}>
        <Text fontSize={0.3} color="#ffffff" anchorX="center" anchorY="middle" position={[0, 0.5, 0]}>
          {`SHOTS: ${tags.shot_count || 0}`}
        </Text>
        <Text fontSize={0.25} color="#aaddaa" anchorX="center" anchorY="middle" position={[0, 0, 0]}>
          {`FORCE: ${(tags.clamping_force || 0).toFixed(0)} T`}
        </Text>
      </group>
    </group>
  );
};

export default function InjectionMolding3D({ state, tags }: { state: string, tags?: Record<string, number> }) {
  return (
    <Canvas shadows camera={{ position: [0, 8, 16], fov: 40 }} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", display: "block" }}>
      <OrbitControls 
        enablePan={true}
        enableZoom={true}
        enableRotate={true}
        target={[-1, 3, 0]}
        maxPolarAngle={Math.PI / 2 - 0.05} 
      />
      <ambientLight intensity={0.5} />
      <directionalLight position={[10, 20, 10]} intensity={1.2} castShadow shadow-bias={-0.0001} />
      <pointLight position={[-10, 5, 5]} intensity={0.8} />
      
      <InjectionMoldingModel state={state} tags={tags || {}} />
      
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
