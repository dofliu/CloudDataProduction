import React, { useRef } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { OrbitControls, Box, Cylinder, Environment, ContactShadows, Text, Line } from '@react-three/drei';
import * as THREE from 'three';

// -----------------------------------------------------
// Global payload state for visual simulation
// -----------------------------------------------------
let globalAgvHasPayload = false;

// -----------------------------------------------------
// Dummy CNC Machine (Visual Prop)
// -----------------------------------------------------
const DummyCNC = ({ position, rotation }: { position: [number, number, number], rotation: [number, number, number] }) => (
  <group position={position} rotation={rotation}>
    <Box args={[4, 5, 3]} position={[0, 2.5, 0]} castShadow receiveShadow>
      <meshStandardMaterial color="#7b8a8b" />
    </Box>
    {/* Window */}
    <Box args={[2.5, 2, 0.2]} position={[0, 2.5, 1.5]} castShadow>
      <meshStandardMaterial color="#222222" />
    </Box>
    {/* Station base extending forwards */}
    <Box args={[1.5, 1, 1.5]} position={[0, 0.5, 2.25]} castShadow receiveShadow>
      <meshStandardMaterial color="#555555" />
    </Box>
  </group>
);

// -----------------------------------------------------
// Dummy Robot Arm (Visual Prop, syncs with AGV stops)
// -----------------------------------------------------
const DummyRobotArm = ({ position, rotation, globalX, globalZ, agvX, agvZ, agvSpeed, isLoad }: { position: [number, number, number], rotation: [number, number, number], globalX: number, globalZ: number, agvX: number, agvZ: number, agvSpeed: number, isLoad: boolean }) => {
  const j1Ref = useRef<THREE.Group>(null);
  const j2Ref = useRef<THREE.Group>(null);
  const j3Ref = useRef<THREE.Group>(null);
  const gripperRef = useRef<THREE.Group>(null);
  const boxRef = useRef<THREE.Mesh>(null);
  const cncBoxRef = useRef<THREE.Mesh>(null);
  
  const timer = useRef(0);

  useFrame((_, delta) => {
    // Check distance to AGV based on global coordinates
    const dist = Math.sqrt(Math.pow(agvX - globalX, 2) + Math.pow(agvZ - globalZ, 2));
    
    // If AGV is stopped within radius (increased to 5.0 for robustness)
    if (dist < 5.0 && agvSpeed < 0.05) {
      timer.current += delta;
    } else {
      timer.current = 0;
    }

    let t = timer.current;
    if (t > 6.0) t = 6.0;
    
    // Animation phases (6 seconds total stop time)
    let j1 = 0, j2 = 20, j3 = 30;
    let hasBox = false;
    let cncHasBox = false;
    
    // Helper to map time to angles smoothly
    const smoothStep = (x: number) => x * x * (3 - 2 * x);
    const interp = (start: number, end: number, progress: number) => start + (end - start) * smoothStep(Math.max(0, Math.min(1, progress)));

    // CNC is at -Z (local +90 in j1), AGV is at +Z (local -90 in j1).
    if (t === 0) {
      // Idle
      cncHasBox = isLoad;
    } else if (t < 1.0) {
      // Swing to CNC (j1 -> 90)
      j1 = interp(0, 90, t);
      j2 = interp(20, 60, t);
      j3 = interp(30, 45, t);
      cncHasBox = isLoad;
    } else if (t < 2.0) {
      // At CNC (Pick/Place happens at 1.5s)
      j1 = 90; j2 = 60; j3 = 45;
      hasBox = t > 1.5 ? isLoad : !isLoad;
      cncHasBox = t > 1.5 ? !isLoad : isLoad;
    } else if (t < 4.0) {
      // Swing CNC -> AGV (j1 90 -> -90)
      const p = (t - 2.0) / 2.0;
      j1 = interp(90, -90, p);
      // Lift arm up during swing
      j2 = p < 0.5 ? interp(60, 20, p*2) : interp(20, 60, (p-0.5)*2);
      j3 = p < 0.5 ? interp(45, 30, p*2) : interp(30, 45, (p-0.5)*2);
      hasBox = isLoad;
    } else if (t < 5.0) {
      // At AGV (Pick/Place happens at 4.5s)
      j1 = -90; j2 = 60; j3 = 45;
      hasBox = t > 4.5 ? !isLoad : isLoad;
      if (t > 4.5) {
        globalAgvHasPayload = isLoad;
      }
    } else if (t <= 6.0) {
      // Swing AGV -> Home
      const p = (t - 5.0) / 1.0;
      j1 = interp(-90, 0, p);
      j2 = interp(60, 20, p);
      j3 = interp(45, 30, p);
      hasBox = !isLoad;
    }

    if (j1Ref.current) j1Ref.current.rotation.y = THREE.MathUtils.degToRad(j1);
    if (j2Ref.current) j2Ref.current.rotation.z = THREE.MathUtils.degToRad(j2);
    if (j3Ref.current) j3Ref.current.rotation.z = THREE.MathUtils.degToRad(j3);
    
    // Gripper must always point down (global angle offset)
    if (gripperRef.current) {
        gripperRef.current.rotation.z = THREE.MathUtils.degToRad(-(j2 + j3));
    }
    
    if (boxRef.current) boxRef.current.visible = hasBox;
    if (cncBoxRef.current) cncBoxRef.current.visible = cncHasBox;
  });

  return (
    <group position={position} rotation={rotation}>
      {/* CNC's resting box (simulated product on the station) */}
      {/* Matches the arm's reach when it swings to the CNC (j1 = -90). Reach is Z = -3.2, Height = 2.05 */}
      <Box ref={cncBoxRef} args={[0.5, 0.5, 0.5]} position={[0, 2.05, -3.2]} castShadow>
        <meshStandardMaterial color="#3a8a3a" />
      </Box>

      {/* Base */}
      <Cylinder args={[0.6, 0.8, 1.0, 32]} position={[0, 0.5, 0]} castShadow>
        <meshStandardMaterial color="#444" />
      </Cylinder>
      <group ref={j1Ref} position={[0, 1.0, 0]}>
        <Cylinder args={[0.5, 0.6, 1.0, 32]} position={[0, 0.5, 0]} castShadow>
           <meshStandardMaterial color="#f0b030" />
        </Cylinder>
        <group position={[0, 1.0, 0]}>
          <Cylinder args={[0.4, 0.4, 1.0, 32]} rotation={[Math.PI / 2, 0, 0]} castShadow>
             <meshStandardMaterial color="#222" />
          </Cylinder>
          <group ref={j2Ref}>
            <Box args={[0.6, 2.0, 0.6]} position={[0, 1.0, 0]} castShadow>
               <meshStandardMaterial color="#f0b030" />
            </Box>
            <group position={[0, 2.0, 0]}>
              <Cylinder args={[0.3, 0.3, 0.8, 32]} rotation={[Math.PI / 2, 0, 0]} castShadow>
                 <meshStandardMaterial color="#222" />
              </Cylinder>
              <group ref={j3Ref}>
                <Box args={[0.4, 1.5, 0.4]} position={[0, 0.75, 0]} castShadow>
                   <meshStandardMaterial color="#f0b030" />
                </Box>
                <group position={[0, 1.5, 0]}>
                  <Box args={[0.2, 0.2, 0.2]} castShadow>
                     <meshStandardMaterial color="#222" />
                  </Box>
                  <group ref={gripperRef}>
                    <Box args={[0.05, 0.4, 0.1]} position={[-0.15, 0.2, 0]}><meshStandardMaterial color="#222" /></Box>
                    <Box args={[0.05, 0.4, 0.1]} position={[0.15, 0.2, 0]}><meshStandardMaterial color="#222" /></Box>
                    <Box ref={boxRef} args={[0.5, 0.5, 0.5]} position={[0, 0.5, 0]} castShadow>
                      <meshStandardMaterial color="#3a8a3a" />
                    </Box>
                  </group>
                </group>
              </group>
            </group>
          </group>
        </group>
      </group>
    </group>
  );
};


// -----------------------------------------------------
// Main AGV Component
// -----------------------------------------------------
export const AgvModel = ({ state, tags }: { state: string, tags: Record<string, number> }) => {
  const agvRef = useRef<THREE.Group>(null);
  const payloadRef = useRef<THREE.Group>(null);
  
  useFrame(() => {
    if (agvRef.current) {
      const targetX = tags.pos_x || 0;
      const targetZ = tags.pos_y || 0; 
      
      agvRef.current.position.x += (targetX - agvRef.current.position.x) * 0.1;
      agvRef.current.position.z += (targetZ - agvRef.current.position.z) * 0.1;
      
      const targetHeading = THREE.MathUtils.degToRad(tags.heading || 0);
      let diff = targetHeading - agvRef.current.rotation.y;
      while (diff < -Math.PI) diff += Math.PI * 2;
      while (diff > Math.PI) diff -= Math.PI * 2;
      
      agvRef.current.rotation.y += diff * 0.1;
    }
    if (payloadRef.current) {
      // Sync with backend state when moving (handles hot-reloads)
      if (Math.abs(tags.speed || 0) > 0.01) {
        globalAgvHasPayload = (tags.payload || 0) > 0;
      }
      payloadRef.current.visible = globalAgvHasPayload;
    }
  });

  const bodyColor = state === 'fault' ? "#c85a4a" : (state === 'charging' ? "#44aa44" : "#ffaa00");
  const payloadVisible = (tags.payload || 0) > 0;
  const soc = tags.battery_soc || 0;

  return (
    <group ref={agvRef} position={[2, 0, 2]}>
      {/* AGV Base */}
      <Cylinder args={[1.2, 1.2, 0.5, 32]} position={[0, 0.4, 0]} castShadow receiveShadow>
        <meshStandardMaterial color={bodyColor} />
      </Cylinder>
      
      {/* AGV Central Pillar */}
      <Cylinder args={[0.3, 0.3, 1.2, 16]} position={[0, 1.2, 0]} castShadow receiveShadow>
        <meshStandardMaterial color="#888" />
      </Cylinder>

      {/* Wheels */}
      {[[-0.7, 0.7], [0.7, 0.7], [-0.7, -0.7], [0.7, -0.7]].map((pos, i) => (
        <Cylinder key={i} args={[0.2, 0.2, 0.2, 16]} rotation={[0, 0, Math.PI / 2]} position={[pos[0], 0.2, pos[1]]} castShadow receiveShadow>
          <meshStandardMaterial color="#222" />
        </Cylinder>
      ))}

      {/* Wafer FOUP Platform */}
      <Cylinder args={[0.9, 0.9, 0.1, 32]} position={[0, 1.8, 0]} castShadow receiveShadow>
        <meshStandardMaterial color="#444" />
      </Cylinder>

      {/* Payload (Green Cube) */}
      <group ref={payloadRef} position={[0, 2.1, 0]}>
        <Box args={[0.5, 0.5, 0.5]} castShadow receiveShadow>
          <meshStandardMaterial color="#3a8a3a" />
        </Box>
      </group>
      
      {/* Direction Indicator */}
      <Box args={[0.6, 0.1, 0.4]} position={[0, 0.55, 1.0]} castShadow receiveShadow>
        <meshStandardMaterial color="#fff" emissive={state === 'moving' ? "#ffffff" : "#000000"} emissiveIntensity={0.5} />
      </Box>

      {/* Floating Info Label */}
      <group position={[0, payloadVisible ? 2.2 : 1.2, 0]} rotation={[0, Math.PI, 0]}>
        <Text fontSize={0.3} color={soc < 30 ? "#ff4444" : "#ffffff"} anchorX="center" anchorY="bottom" position={[0, 0, 0]}>
          {`SOC: ${soc.toFixed(1)}%`}
        </Text>
      </group>
    </group>
  );
};

export default function AgvMobileRobot3D({ state, tags }: { state: string, tags?: Record<string, number> }) {
  // We need to pass the AGV's current position to the dummy arms to sync their animations
  const agvX = tags?.pos_x || 0;
  const agvZ = tags?.pos_y || 0;
  const agvSpeed = tags?.speed || 0;

  const pathPoints = React.useMemo(() => {
    const pts = [];
    pts.push(new THREE.Vector3(2, 0.05, 2));
    pts.push(new THREE.Vector3(18, 0.05, 2));
    pts.push(new THREE.Vector3(18, 0.05, 12));
    pts.push(new THREE.Vector3(2, 0.05, 12));
    pts.push(new THREE.Vector3(2, 0.05, 2));
    return pts;
  }, []);

  return (
    <Canvas shadows camera={{ position: [10, 20, 30], fov: 45 }} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", display: "block" }}>
      <OrbitControls 
        enablePan={true}
        enableZoom={true}
        enableRotate={true}
        target={[10, 0, 7]} // Center of the [2..18], [2..12] loop
        maxPolarAngle={Math.PI / 2 - 0.05} 
      />
      <ambientLight intensity={0.6} />
      <directionalLight position={[20, 30, 20]} intensity={1} castShadow shadow-bias={-0.0001} />
      
      {/* ------------------------------------------------------------- */}
      {/* PATH INDICATOR ON FLOOR */}
      {/* ------------------------------------------------------------- */}
      <Line points={pathPoints} color="#d4a373" lineWidth={4} dashed={true} dashSize={1} gapSize={0.5} dashScale={1} />
      
      {/* The Actual AGV */}
      <AgvModel state={state} tags={tags || {}} />
      
      {/* ------------------------------------------------------------- */}
      {/* OBSTACLE: Smart Shelf in the middle of the area */}
      {/* ------------------------------------------------------------- */}
      <group position={[10, 0, 7]}>
        <Box args={[1.5, 2.0, 1.0]} position={[0, 1.0, 0]} castShadow receiveShadow>
          <meshStandardMaterial color="#c0c0c0" />
        </Box>
        {/* Shelf layers */}
        <Box args={[1.6, 0.1, 1.1]} position={[0, 0.5, 0]}><meshStandardMaterial color="#555" /></Box>
        <Box args={[1.6, 0.1, 1.1]} position={[0, 1.2, 0]}><meshStandardMaterial color="#555" /></Box>
        <Box args={[1.6, 0.1, 1.1]} position={[0, 1.9, 0]}><meshStandardMaterial color="#555" /></Box>
        <Text position={[0, 2.3, 0]} fontSize={0.4} color="#ffaa00">Middle Shelf</Text>
      </group>

      {/* ------------------------------------------------------------- */}
      {/* WORKCELL INTEGRATION: Station 1 (Load) at X=18, Z=2 */}
      {/* ------------------------------------------------------------- */}
      <group position={[18, 0, -1.2]} rotation={[0, 0, 0]}>
        {/* CNC placed behind the arm */}
        <DummyCNC position={[0, 0, -3.2]} rotation={[0, 0, 0]} />
        {/* Arm at (18, 0, -1.2), facing +Z (AGV). AGV is at Z=2 (distance 3.2). CNC is at -Z. */}
        <DummyRobotArm 
          position={[0, 0, 0]} 
          globalX={18}
          globalZ={-1.2}
          rotation={[0, 0, 0]} 
          agvX={agvX} 
          agvZ={agvZ} 
          agvSpeed={agvSpeed} 
          isLoad={true} 
        />
      </group>

      {/* ------------------------------------------------------------- */}
      {/* WORKCELL INTEGRATION: Station 2 (Unload) at X=2, Z=12 */}
      {/* ------------------------------------------------------------- */}
      <group position={[2, 0, 15.2]} rotation={[0, Math.PI, 0]}>
        <DummyCNC position={[0, 0, -3.2]} rotation={[0, 0, 0]} />
        <DummyRobotArm 
          position={[0, 0, 0]} 
          globalX={2}
          globalZ={15.2}
          rotation={[0, 0, 0]} 
          agvX={agvX} 
          agvZ={agvZ} 
          agvSpeed={agvSpeed} 
          isLoad={false} 
        />
      </group>

      {/* Path outline to show where it goes */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[10, 0.01, 7]} receiveShadow>
        <planeGeometry args={[16.2, 10.2]} />
        <meshBasicMaterial color="#ffffaa" transparent opacity={0.1} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[10, 0.02, 7]} receiveShadow>
        <planeGeometry args={[15.8, 9.8]} />
        <meshBasicMaterial color="#e0e0e0" />
      </mesh>

      <ContactShadows position={[10, 0.03, 7]} opacity={0.4} scale={50} blur={2} far={10} />
      <Environment preset="warehouse" />

      {/* Main Floor */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[10, -0.1, 7]} receiveShadow>
        <planeGeometry args={[60, 60]} />
        <meshStandardMaterial color="#e0e0e0" roughness={0.8} />
      </mesh>
    </Canvas>
  );
}
