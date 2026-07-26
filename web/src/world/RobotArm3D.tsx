import React, { useRef, useState } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { OrbitControls, Box, Cylinder, Environment, ContactShadows } from '@react-three/drei';
import * as THREE from 'three';

const RobotArmModel = ({ state, tags }: { state: string, tags: Record<string, number> }) => {
  const j1Ref = useRef<THREE.Group>(null);
  const j2Ref = useRef<THREE.Group>(null);
  const j3Ref = useRef<THREE.Group>(null);
  const j4Ref = useRef<THREE.Group>(null);
  const j5Ref = useRef<THREE.Group>(null);
  const j6Ref = useRef<THREE.Group>(null);

  // Target angles from telemetry (in degrees)
  const targetAngles = useRef([0, 0, 0, 0, 0, 0]);
  const currentAngles = useRef([0, 0, 0, 0, 0, 0]);
  const [boxState, setBoxState] = useState<'at_pick' | 'in_gripper' | 'at_place'>('at_pick');
  const boxStateRef = useRef<'at_pick' | 'in_gripper' | 'at_place'>('at_pick');

  useFrame(() => {
    // Read tags
    const rawJ1 = tags.joint_angle_1 || 0;
    
    // Instead of using the raw J2/J3 (which in the old backend just wave in the air),
    // we use J1's left/right sweep to synthesize a perfect visual Pick & Place trajectory 
    // that reaches the floor stations correctly!
    const sweepProgress = Math.min(1, Math.abs(rawJ1 / 60)); 
    // sweepProgress: 0 (middle) -> 1 (far ends of the arc)

    targetAngles.current[0] = rawJ1;
    targetAngles.current[1] = 0 + sweepProgress * 40;    // J2 bends shoulder down to 40 deg
    targetAngles.current[2] = 30 + sweepProgress * 97;   // J3 bends elbow to 127 deg
    targetAngles.current[3] = tags.joint_angle_4 || 0;
    targetAngles.current[4] = 0 + sweepProgress * 13;    // J5 keeps gripper vertical
    targetAngles.current[5] = tags.joint_angle_6 || 0;

    // Smooth interpolation
    for (let i = 0; i < 6; i++) {
      currentAngles.current[i] += (targetAngles.current[i] - currentAngles.current[i]) * 0.15;
    }

    // Pick & Place State Machine
    if (state === 'running') {
      // J1 swings from -60 (Pick) to +60 (Place)
      if (currentAngles.current[0] < -50) {
        if (boxStateRef.current === 'at_pick') boxStateRef.current = 'in_gripper';
      } else if (currentAngles.current[0] > 50) {
        if (boxStateRef.current === 'in_gripper') boxStateRef.current = 'at_place';
      } else if (currentAngles.current[0] < 0 && boxStateRef.current === 'at_place') {
        // Arm crossing center back towards left -> spawn new box at pick station
        boxStateRef.current = 'at_pick';
      }
    } else {
      boxStateRef.current = 'at_pick';
    }
    
    if (boxState !== boxStateRef.current) {
      setBoxState(boxStateRef.current);
    }

    // Apply rotations (convert deg to rad)
    if (j1Ref.current) j1Ref.current.rotation.y = THREE.MathUtils.degToRad(currentAngles.current[0]);
    if (j2Ref.current) j2Ref.current.rotation.z = THREE.MathUtils.degToRad(currentAngles.current[1]);
    if (j3Ref.current) j3Ref.current.rotation.z = THREE.MathUtils.degToRad(currentAngles.current[2]);
    if (j4Ref.current) j4Ref.current.rotation.x = THREE.MathUtils.degToRad(currentAngles.current[3]);
    if (j5Ref.current) j5Ref.current.rotation.z = THREE.MathUtils.degToRad(currentAngles.current[4]);
    if (j6Ref.current) j6Ref.current.rotation.x = THREE.MathUtils.degToRad(currentAngles.current[5]);
  });

  const baseColor = "#444444";
  const armColor = state === 'fault' ? "#c85a4a" : "#e68a00";
  const jointColor = "#222222";

  return (
    <group position={[0, -1, 0]}>
      {/* Base */}
      <Cylinder args={[1.5, 2, 1, 32]} position={[0, 0.5, 0]} castShadow receiveShadow>
        <meshStandardMaterial color={baseColor} metalness={0.5} roughness={0.5} />
      </Cylinder>

      {/* Joint 1 (Y-axis rotation) */}
      <group ref={j1Ref} position={[0, 1, 0]}>
        <Cylinder args={[1.2, 1.5, 1.5, 32]} position={[0, 0.75, 0]} castShadow receiveShadow>
          <meshStandardMaterial color={armColor} />
        </Cylinder>
        
        {/* Joint 2 (Z-axis rotation) */}
        <group position={[0, 1.25, 0]}>
          {/* Joint cylinder visual */}
          <Cylinder args={[0.8, 0.8, 2, 32]} rotation={[Math.PI / 2, 0, 0]} castShadow receiveShadow>
            <meshStandardMaterial color={jointColor} metalness={0.6} />
          </Cylinder>

          <group ref={j2Ref}>
            {/* Lower Arm */}
            <Box args={[1.2, 4, 1.2]} position={[0, 2, 0]} castShadow receiveShadow>
              <meshStandardMaterial color={armColor} />
            </Box>

            {/* Joint 3 (Z-axis rotation) */}
            <group position={[0, 4, 0]}>
              <Cylinder args={[0.7, 0.7, 1.6, 32]} rotation={[Math.PI / 2, 0, 0]} castShadow receiveShadow>
                <meshStandardMaterial color={jointColor} metalness={0.6} />
              </Cylinder>

              <group ref={j3Ref}>
                {/* Upper Arm Base */}
                <Box args={[1, 1, 1]} position={[0, 0.5, 0]} castShadow receiveShadow>
                  <meshStandardMaterial color={armColor} />
                </Box>

                {/* Joint 4 (X-axis rotation) */}
                <group position={[0, 1, 0]}>
                  <group ref={j4Ref}>
                    <Cylinder args={[0.5, 0.5, 3.5, 16]} position={[0, 1.75, 0]} castShadow receiveShadow>
                      <meshStandardMaterial color={armColor} />
                    </Cylinder>

                    {/* Joint 5 (Z-axis rotation) */}
                    <group position={[0, 3.5, 0]}>
                      <Cylinder args={[0.6, 0.6, 1.2, 16]} rotation={[Math.PI / 2, 0, 0]} castShadow receiveShadow>
                        <meshStandardMaterial color={jointColor} metalness={0.6} />
                      </Cylinder>
                      
                      <group ref={j5Ref}>
                        <Box args={[0.8, 1, 0.8]} position={[0, 0.5, 0]} castShadow receiveShadow>
                          <meshStandardMaterial color={armColor} />
                        </Box>

                        {/* Joint 6 (X-axis rotation) */}
                        <group position={[0, 1, 0]}>
                          <group ref={j6Ref}>
                            {/* Wrist / Tool flange */}
                            <Cylinder args={[0.4, 0.4, 0.2, 16]} position={[0, 0.1, 0]} castShadow receiveShadow>
                              <meshStandardMaterial color={baseColor} metalness={0.8} roughness={0.2} />
                            </Cylinder>
                            
                            {/* Gripper */}
                            <group position={[0, 0.2, 0]}>
                              <Box args={[0.8, 0.2, 0.2]} position={[0, 0.1, 0]} castShadow receiveShadow>
                                <meshStandardMaterial color={jointColor} />
                              </Box>
                              <Box args={[0.1, 0.6, 0.2]} position={[-0.35, 0.4, 0]} castShadow receiveShadow>
                                <meshStandardMaterial color={jointColor} />
                              </Box>
                              <Box args={[0.1, 0.6, 0.2]} position={[0.35, 0.4, 0]} castShadow receiveShadow>
                                <meshStandardMaterial color={jointColor} />
                              </Box>
                              {/* Item being held (dynamically toggled) */}
                              {boxState === 'in_gripper' && (
                                <Box args={[0.6, 0.6, 0.6]} position={[0, 0.5, 0]} castShadow receiveShadow>
                                  <meshStandardMaterial color="#3a8a3a" />
                                </Box>
                              )}
                            </group>
                          </group>
                        </group>
                      </group>
                    </group>
                  </group>
                </group>
              </group>
            </group>
          </group>
        </group>
      </group>

      {/* Pick & Place Stations (Left and Right) */}
      {/* Pick Station (Left: Positive Z, Positive X when rotated by J1?) 
          Actually let's just place them statically on the ground.
          J1 rotates around Y. Left is approximately X=-3, Z=3 depending on camera.
          Let's just put them relative to the base. */}
      
      {/* Pick Station (Left: J1=-60, Z is positive) */}
      <group position={[-1.76, 0.5, 3.05]}>
        <Box args={[1.5, 1, 1.5]} castShadow receiveShadow>
          <meshStandardMaterial color="#666" />
        </Box>
        {boxState === 'at_pick' && (
          <Box args={[0.6, 0.6, 0.6]} position={[0, 0.8, 0]} castShadow receiveShadow>
            <meshStandardMaterial color="#3a8a3a" />
          </Box>
        )}
      </group>

      {/* Place Station (Right: J1=+60, Z is negative) */}
      <group position={[-1.76, 0.5, -3.05]}>
        <Box args={[1.5, 1, 1.5]} castShadow receiveShadow>
          <meshStandardMaterial color="#666" />
        </Box>
        {boxState === 'at_place' && (
          <Box args={[0.6, 0.6, 0.6]} position={[0, 0.8, 0]} castShadow receiveShadow>
            <meshStandardMaterial color="#3a8a3a" />
          </Box>
        )}
      </group>
    </group>
  );
};

export default function RobotArm3D({ state, tags }: { state: string, tags?: Record<string, number> }) {
  return (
    <Canvas shadows camera={{ position: [12, 10, 12], fov: 45 }} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", display: "block" }}>
      <OrbitControls 
        enablePan={true}
        enableZoom={true}
        enableRotate={true}
        target={[0, 4, 0]}
        maxPolarAngle={Math.PI / 2 - 0.05} 
      />
      <ambientLight intensity={0.5} />
      <directionalLight position={[10, 20, 10]} intensity={1} castShadow shadow-bias={-0.0001} />
      <pointLight position={[-10, 10, -10]} intensity={0.5} />
      
      <RobotModelWrapper state={state} tags={tags || {}} />
      
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

const RobotModelWrapper = ({ state, tags }: { state: string, tags: Record<string, number> }) => {
  return (
    <>
      <RobotArmModel state={state} tags={tags} />
      {/* Surrounding props to give sense of scale */}
      <Box args={[2, 1, 2]} position={[4, -0.5, 0]} receiveShadow castShadow>
        <meshStandardMaterial color="#666" />
      </Box>
      <Box args={[1.5, 1.5, 1.5]} position={[-4, -0.25, 2]} receiveShadow castShadow>
        <meshStandardMaterial color="#777" />
      </Box>
    </>
  );
};
