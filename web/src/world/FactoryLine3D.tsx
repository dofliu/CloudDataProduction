import React, { useRef, useMemo, useState } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { OrbitControls, Box, Environment, ContactShadows, Text } from '@react-three/drei';
import * as THREE from 'three';

// Import all Models
import { CNCModel } from './CncMachine3D';
import { RobotArmModel } from './RobotArm3D';
import { ConveyorModel } from './Conveyor3D';
import { AgvModel } from './AgvMobileRobot3D';
import { InjectionMoldingModel } from './InjectionMolding3D';
import { StampingPressModel } from './StampingPress3D';
import { WindTurbineModel } from './WindTurbine3D';
import { AirCompressorModel } from './AirCompressor3D';
import { EnergyMeterModel } from './EnergyMeter3D';


const CameraController = ({ cameraY, cameraZ }: { cameraY: number, cameraZ: number }) => {
  const { camera } = useThree();
  React.useEffect(() => {
    camera.position.set(0, cameraY, cameraZ);
    camera.lookAt(0, 0, 0);
  }, [cameraY, cameraZ, camera]);
  return null;
};

export default function FactoryLine3D({ devices, snapshots, onDeviceClick }: { devices: {id: string, template: string}[], snapshots: any, onDeviceClick?: (id: string) => void }) {
  const lineLength = devices.length;
  const startX = -((lineLength - 1) * 8) / 2;
  const cameraZ = Math.max(25, lineLength * 12);
  const cameraY = Math.max(12, lineLength * 5);

  return (
    <div style={{ width: '100%', height: '100%', background: 'linear-gradient(to bottom, #1a1a2e, #16213e)', position: 'relative' }}>
      <Canvas shadows camera={{ position: [0, cameraY, cameraZ], fov: 45 }}>
        <CameraController cameraY={cameraY} cameraZ={cameraZ} />
        <Environment preset="city" />
        <ambientLight intensity={0.4} />
        <directionalLight castShadow position={[5, 10, 5]} intensity={1.5} shadow-mapSize={[1024, 1024]} />
        <directionalLight position={[-5, 5, -5]} intensity={0.5} color="#4ea8de" />

        <OrbitControls makeDefault autoRotate autoRotateSpeed={0.5} maxPolarAngle={Math.PI / 2 - 0.05} />

        {/* Floor */}
        <Box args={[lineLength * 8 + 4, 0.2, 12]} position={[0, -0.1, 0]} receiveShadow>
          <meshStandardMaterial color="#2d3748" metalness={0.2} roughness={0.8} />
        </Box>
        {/* Floor Grid markings */}
        <gridHelper args={[lineLength * 8 + 4, (lineLength * 8 + 4)*2, 0x4a5568, 0x2d3748]} position={[0, 0.01, 0]} />

        {/* Machines */}
        {devices.map((dev, idx) => {
          const x = startX + idx * 8;
          const snap = snapshots[dev.id] || { state: 'stop', tags: {} };
          
          let Model = null;
          switch (dev.template) {
            case 'cnc_machining_center': Model = CNCModel; break;
            case 'robot_arm_6axis': Model = RobotArmModel; break;
            case 'conveyor': Model = ConveyorModel; break;
            case 'agv_mobile_robot': Model = AgvModel; break;
            case 'injection_molding': Model = InjectionMoldingModel; break;
            case 'stamping_press': Model = StampingPressModel; break;
            case 'wind_turbine': Model = WindTurbineModel; break;
            case 'air_compressor': Model = AirCompressorModel; break;
            case 'energy_meter': Model = EnergyMeterModel; break;
          }

          if (!Model) return null;

          return (
            <group key={dev.id} position={[x, 0, 0]}
              onClick={(e) => {
                e.stopPropagation();
                if (onDeviceClick) onDeviceClick(dev.id);
              }}
              onPointerOver={() => document.body.style.cursor = 'pointer'}
              onPointerOut={() => document.body.style.cursor = 'default'}
            >
              <Model state={snap.state} tags={snap.tags} />
              {/* Machine ID Label */}
              <Box position={[0, -0.05, 2.5]} args={[1.8, 0.05, 0.6]}>
                <meshStandardMaterial color="#e2e8f0" />
              </Box>
              <Text position={[0, 0.01, 2.5]} rotation={[-Math.PI / 2, 0, 0]} fontSize={0.2} color="#1e293b" anchorX="center" anchorY="middle">
                {dev.id}
              </Text>
            </group>
          );
        })}


        <ContactShadows resolution={1024} scale={20} blur={2} opacity={0.5} far={10} color="#000000" />
      </Canvas>
      <div style={{ position: 'absolute', top: 12, left: 16, color: '#94a3b8', fontSize: 13, fontFamily: 'Noto Sans TC' }}>
        拖曳可旋轉視角 · 滾輪縮放
      </div>
    </div>
  );
}
