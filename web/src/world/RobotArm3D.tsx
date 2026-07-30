/**
 * 六軸機械手臂 3D(綁定表見 docs/animation_binding.md §4.2)。
 *
 * 六軸角度**全部**直接吃引擎的 joint_angle_1..6(L1)。先前版本只用 J1,再自行合成
 * J2/J3/J5 —— 那是對著舊版引擎寫的;引擎後來改成 _KEYFRAMES 六點取放,J2/J3 是真值,
 * 前端再合成就會與 Modbus 讀值不符。現在移除合成邏輯。
 *
 * 控制器的關節零位與 mesh 骨架零位不同(真實世界也是:controller 的 DH 零位 ≠ CAD 零位),
 * 因此每軸套一組**固定**校正 JOINT_CAL(度)。這是換座標系,不是改資料 ——
 * 角度的變化量與 telemetry 完全 1:1,只有原點平移。
 *
 * 取放站的位置直接來自 setpoints(pick_x/pick_y/place_x/place_y ÷200)——
 * 引擎的逆運動學保證下探時 TCP 落在那個座標,所以夾爪必定落在檯面上;不必手調座標。
 * 反過來說,若教師對某軸注入 encoder_drift,畫面就會看到手臂「夾偏」—— 那正是要教的。
 */
import React, { useMemo, useRef, useState } from "react";
import { useFrame } from "@react-three/fiber";
import { Box, Cylinder } from "@react-three/drei";
import * as THREE from "three";
import MachineScene, { Readout, Row } from "./MachineScene";
import { FaultSmoke, HeatGlow, Shake, StatusBeacon, bodyColor } from "./MachineFx";
import { DeviceMotion, MachineProps, approachAngleDeg, clamp01, scaleNote } from "./deviceMotion";

// 骨架尺寸(必須與下方 mesh 一致,fk 才算得準)
const SHOULDER_Y = 2.0, L_UPPER = 3.2, L_FORE = 3.4, L_WRIST = 1.4;
// 控制器零位 → mesh 零位的校正(度)。調到「下探姿態時手腕朝下、端點落在料台高度」。
const JOINT_CAL = { j2: 40, j3: 15, j5: 25 };

/** 正運動學:回傳夾爪端點的世界座標(model 內座標,尚未套外層 -1 位移)。 */
function fk(j1: number, j2: number, j3: number, j5: number): [number, number, number] {
  const D = Math.PI / 180;
  const c2 = (j2 + JOINT_CAL.j2) * D;
  const c3 = c2 + (j3 + JOINT_CAL.j3) * D;
  const c5 = c3 + (j5 + JOINT_CAL.j5) * D;
  let x = 0, y = SHOULDER_Y;
  x += -Math.sin(c2) * L_UPPER; y += Math.cos(c2) * L_UPPER;
  x += -Math.sin(c3) * L_FORE; y += Math.cos(c3) * L_FORE;
  x += -Math.sin(c5) * L_WRIST; y += Math.cos(c5) * L_WRIST;
  const a = j1 * D;
  return [x * Math.cos(a), y, -x * Math.sin(a)];
}

// 引擎座標(mm)→ 模型單位:÷200,且引擎 +x 對模型 −X、引擎 +y 對模型 +Z
// (與 fk() 的座標約定一致 —— tests/animation 的 tcp 綁定就是用這組換算驗的)。
const MM_PER_UNIT = 200;
// 引擎的取放預設點與下探高度(engine/templates/robot_arm_6axis.py 的
// _DEFAULT_PICK / _DEFAULT_PLACE / _Z_DOWN)。setpoint 缺席(舊 telemetry)時用預設。
const DEFAULT_PICK_MM = { x: 820, y: -820 };
const DEFAULT_PLACE_MM = { x: 820, y: 820 };
const Z_DOWN_MM = 150;
const stationPos = (xMm: number, yMm: number): [number, number, number] =>
  [-xMm / MM_PER_UNIT, Z_DOWN_MM / MM_PER_UNIT, yMm / MM_PER_UNIT];

/**
 * **預設**取放點(模型單位,未套外層縮放)。產線佈局要拿它把上游機台的出料側對到
 * 取件點、把輸送帶對到放件點 —— 匯出來讓 processFlow.ts 用同一組數字,不要兩邊各寫
 * 一份。實際取放點可由學生寫 setpoints(pick_x/pick_y/place_x/place_y)移動,
 * 畫面裡的料檯會跟著搬;產線的機台佈局則錨定在預設點(空間對位,見 processFlow.ts)。
 */
export const ARM_PICK_LOCAL = stationPos(DEFAULT_PICK_MM.x, DEFAULT_PICK_MM.y);
export const ARM_PLACE_LOCAL = stationPos(DEFAULT_PLACE_MM.x, DEFAULT_PLACE_MM.y);

/** 在網址加 ?fkdebug=1 會畫出 fk() 算出的取放點,用來核對骨架與運動學是否一致(dev)。 */
const FK_DEBUG = typeof location !== "undefined" && new URLSearchParams(location.search).get("fkdebug") === "1";

export const RobotArmModel = ({ motion, stations }: MachineProps & {
  /** 取 / 放兩側要不要畫自己的料檯。產線視圖裡上下游是真的機台,就關掉。 */
  stations?: { pick?: boolean; place?: boolean };
}) => {
  const showPick = stations?.pick ?? true;
  const showPlace = stations?.place ?? true;
  const refs = {
    j1: useRef<THREE.Group>(null), j2: useRef<THREE.Group>(null), j3: useRef<THREE.Group>(null),
    j4: useRef<THREE.Group>(null), j5: useRef<THREE.Group>(null), j6: useRef<THREE.Group>(null),
  };
  const cur = useRef([0, 0, 0, 0, 0, 0]);
  const holdingRef = useRef(false);
  const [holding, setHolding] = useState(false);
  const [side, setSide] = useState(-1);

  // 取放點由 setpoints 決定(學生可寫);setpoint 缺席時退回引擎預設點
  const sp = motion.setpoints;
  const pickPos = stationPos(sp.pick_x ?? DEFAULT_PICK_MM.x, sp.pick_y ?? DEFAULT_PICK_MM.y);
  const placePos = stationPos(sp.place_x ?? DEFAULT_PLACE_MM.x, sp.place_y ?? DEFAULT_PLACE_MM.y);

  useFrame((_, delta) => {
    const t = motion.tags;
    const target = [
      t.joint_angle_1 ?? 0, t.joint_angle_2 ?? 0, t.joint_angle_3 ?? 0,
      t.joint_angle_4 ?? 0, t.joint_angle_5 ?? 0, t.joint_angle_6 ?? 0,
    ];
    // 故障 / 停機 → 引擎的 pre_step 不再推進,角度會凍在最後一筆:直接讓它停住即可
    const tau = 0.12;
    for (let i = 0; i < 6; i++) cur.current[i] = approachAngleDeg(cur.current[i], target[i], tau, delta);

    const D = THREE.MathUtils.degToRad;
    const [a1, a2, a3, a4, a5, a6] = cur.current;
    if (refs.j1.current) refs.j1.current.rotation.y = D(a1);
    if (refs.j2.current) refs.j2.current.rotation.z = D(a2 + JOINT_CAL.j2);
    if (refs.j3.current) refs.j3.current.rotation.z = D(a3 + JOINT_CAL.j3);
    if (refs.j4.current) refs.j4.current.rotation.x = D(a4);
    if (refs.j5.current) refs.j5.current.rotation.z = D(a5 + JOINT_CAL.j5);
    if (refs.j6.current) refs.j6.current.rotation.x = D(a6);

    // 夾取 / 放置事件由真實角度推得:fk() 的端點貼近下探高度就是「下探」,
    // 離哪個料檯近就是在哪一站(取放點可被 setpoint 移動,不能再靠 J1 正負判斷)
    const [ex, ey, ez] = fk(a1, a2, a3, a5);
    const down = ey < Z_DOWN_MM / MM_PER_UNIT + 0.55;
    if (motion.running && down) {
      const dPick = (ex - pickPos[0]) ** 2 + (ez - pickPos[2]) ** 2;
      const dPlace = (ex - placePos[0]) ** 2 + (ez - placePos[2]) ** 2;
      const nextHold = dPick <= dPlace;               // 下探在取件檯 → 夾起;在放件檯 → 放下
      if (nextHold !== holdingRef.current) { holdingRef.current = nextHold; setHolding(nextHold); }
      const s = nextHold ? -1 : 1;
      setSide((prev) => (prev === s ? prev : s));
    }
  });

  const armColor = bodyColor(motion, "#e68a00");
  const jointColor = "#222222";

  return (
    <Shake motion={motion} amount={0.7}>
      <group position={[0, -1, 0]}>
        <Cylinder args={[1.5, 2, 1, 32]} position={[0, 0.5, 0]} castShadow receiveShadow>
          <meshStandardMaterial color="#444444" metalness={0.5} roughness={0.5} />
        </Cylinder>

        <group ref={refs.j1} position={[0, 1, 0]}>
          <Cylinder args={[1.1, 1.4, 1.2, 32]} position={[0, 0.6, 0]} castShadow receiveShadow>
            <meshStandardMaterial color={armColor} />
          </Cylinder>

          {/* J2 肩部樞紐 —— 局部 y = 1.0,加上外層 j1 的 1.0 → SHOULDER_Y = 2.0 */}
          <group position={[0, 1.0, 0]}>
            <Cylinder args={[0.7, 0.7, 1.7, 32]} rotation={[Math.PI / 2, 0, 0]} castShadow receiveShadow>
              <meshStandardMaterial color={jointColor} metalness={0.6} />
            </Cylinder>
            <HeatGlow motion={motion} radius={1.2} />

            {/* 驗證探針:各軸樞紐(用來核對關節角是否直接來自 joint_angle_n) */}
            <object3D name="probe:j2_pivot" />
            <group ref={refs.j2}>
              {/* 上臂 L_UPPER */}
              <Box args={[1.1, L_UPPER, 1.1]} position={[0, L_UPPER / 2, 0]} castShadow receiveShadow>
                <meshStandardMaterial color={armColor} />
              </Box>

              <group position={[0, L_UPPER, 0]}>
                <Cylinder args={[0.62, 0.62, 1.4, 32]} rotation={[Math.PI / 2, 0, 0]} castShadow receiveShadow>
                  <meshStandardMaterial color={jointColor} metalness={0.6} />
                </Cylinder>

                <group ref={refs.j3}>
                  {/* 前臂 = 0.9(肘座)+ 2.5(臂管)= L_FORE 3.4 */}
                  <Box args={[0.9, 0.9, 0.9]} position={[0, 0.45, 0]} castShadow receiveShadow>
                    <meshStandardMaterial color={armColor} />
                  </Box>

                  <group position={[0, 0.9, 0]}>
                    <group ref={refs.j4}>
                      <Cylinder args={[0.44, 0.44, 2.5, 16]} position={[0, 1.25, 0]} castShadow receiveShadow>
                        <meshStandardMaterial color={armColor} />
                      </Cylinder>

                      <group position={[0, 2.5, 0]}>
                        <Cylinder args={[0.52, 0.52, 1.05, 16]} rotation={[Math.PI / 2, 0, 0]} castShadow receiveShadow>
                          <meshStandardMaterial color={jointColor} metalness={0.6} />
                        </Cylinder>

                        <group ref={refs.j5}>
                          {/* 腕部 = 0.85 + 0.18 + 0.38 ≈ L_WRIST 1.4 */}
                          <Box args={[0.7, 0.85, 0.7]} position={[0, 0.425, 0]} castShadow receiveShadow>
                            <meshStandardMaterial color={armColor} />
                          </Box>

                          <group position={[0, 0.85, 0]}>
                            <group ref={refs.j6}>
                              <Cylinder args={[0.36, 0.36, 0.18, 16]} position={[0, 0.09, 0]} castShadow receiveShadow>
                                <meshStandardMaterial color="#444444" metalness={0.8} roughness={0.2} />
                              </Cylinder>
                              <group position={[0, 0.18, 0]}>
                                <Box args={[0.7, 0.16, 0.2]} position={[0, 0.08, 0]} castShadow receiveShadow>
                                  <meshStandardMaterial color={jointColor} />
                                </Box>
                                <Box args={[0.1, 0.5, 0.2]} position={[holding ? -0.2 : -0.32, 0.33, 0]} castShadow receiveShadow>
                                  <meshStandardMaterial color={jointColor} />
                                </Box>
                                <Box args={[0.1, 0.5, 0.2]} position={[holding ? 0.2 : 0.32, 0.33, 0]} castShadow receiveShadow>
                                  <meshStandardMaterial color={jointColor} />
                                </Box>
                                {/* 驗證探針:夾爪中心(= fk() 的端點)*/}
                                <object3D name="probe:tcp" position={[0, 0.38, 0]} />
                                {holding && (
                                  <Box args={[0.5, 0.5, 0.5]} position={[0, 0.38, 0]} castShadow receiveShadow>
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

        {/* 取放站:位置 = setpoints 的取放座標 ÷200(引擎 IK 保證下探時夾爪落在站上) */}
        {showPick && <Station pos={pickPos} showBox={!holding} />}
        {showPlace && <Station pos={placePos} showBox={!holding && side > 0} />}
        {FK_DEBUG && (
          <>
            <mesh position={pickPos}><sphereGeometry args={[0.18, 12, 10]} /><meshBasicMaterial color="#ff0000" /></mesh>
            <mesh position={placePos}><sphereGeometry args={[0.18, 12, 10]} /><meshBasicMaterial color="#0000ff" /></mesh>
          </>
        )}

        <StatusBeacon motion={motion} position={[2.6, 0, 1.6]} scale={1.4} />
        <FaultSmoke motion={motion} position={[0, 3, 0]} />
      </group>
    </Shake>
  );
};

/** 取放輸送台:檯面高度由 fk() 算出的夾爪端點高度反推,夾爪必定落在檯面上。 */
function Station({ pos, showBox }: { pos: [number, number, number]; showBox: boolean }) {
  const top = Math.max(0.4, pos[1] - 0.3);
  return (
    <group position={[pos[0], 0, pos[2]]}>
      {/* 四支腳 */}
      {[[-0.6, -0.6], [0.6, -0.6], [-0.6, 0.6], [0.6, 0.6]].map((p, i) => (
        <Box key={i} args={[0.16, top, 0.16]} position={[p[0], top / 2, p[1]]} castShadow receiveShadow>
          <meshStandardMaterial color="#8d949a" metalness={0.5} />
        </Box>
      ))}
      {/* 檯面 */}
      <Box args={[1.7, 0.18, 1.7]} position={[0, top, 0]} castShadow receiveShadow>
        <meshStandardMaterial color="#5f676c" metalness={0.55} roughness={0.5} />
      </Box>
      {/* 滾輪 */}
      {[-0.55, -0.18, 0.18, 0.55].map((z, i) => (
        <Cylinder key={i} args={[0.09, 0.09, 1.6, 12]} rotation={[0, 0, Math.PI / 2]}
                  position={[0, top + 0.16, z]} castShadow>
          <meshStandardMaterial color="#3a4145" metalness={0.7} />
        </Cylinder>
      ))}
      {showBox && (
        <Box args={[0.6, 0.6, 0.6]} position={[0, top + 0.52, 0]} castShadow receiveShadow>
          <meshStandardMaterial color="#3a8a3a" />
        </Box>
      )}
    </group>
  );
}

export default function RobotArm3D({ motion, debug }: MachineProps) {
  return (
    <MachineScene camera={[13, 8.5, 1.5]} fov={45} target={[-2, 2.2, 0]} env="warehouse"
                  groundSize={50} shadowScale={30} note={scaleNote()}
                  overlay={<JointReadout motion={motion} />}>
      <RobotArmModel motion={motion} />
      {debug as React.ReactNode}
    </MachineScene>
  );
}

/** 六軸即時角度 —— 學生可拿它跟 OPC-UA 的 joint_angle_n 一格一格對照。 */
function JointReadout({ motion }: { motion: DeviceMotion }) {
  const t = motion.tags;
  const temps = [1, 2, 3, 4, 5, 6].map((i) => t[`joint_temp_${i}`] ?? 0);
  const sp = motion.setpoints;
  const rows: Row[] = [
    ...[1, 2, 3, 4, 5, 6].map((i) => [`J${i} ANGLE`, `${(t[`joint_angle_${i}`] ?? 0).toFixed(1)} °`] as Row),
    ["TCP X/Y/Z", `${(t.tcp_x ?? 0).toFixed(0)} / ${(t.tcp_y ?? 0).toFixed(0)} / ${(t.tcp_z ?? 0).toFixed(0)}`],
    ["PICK ⚙", `${(sp.pick_x ?? 820).toFixed(0)} / ${(sp.pick_y ?? -820).toFixed(0)} mm`],
    ["PLACE ⚙", `${(sp.place_x ?? 820).toFixed(0)} / ${(sp.place_y ?? 820).toFixed(0)} mm`],
    ["JOINT T max", `${Math.max(...temps).toFixed(1)} °C`, clamp01(motion.heat) > 0.6],
    ["VIB", `${(t.vibration_rms ?? 0).toFixed(2)} mm/s`, (t.vibration_rms ?? 0) > 4.5],
    ["CYCLES", `${Math.round(t.cycle_count ?? 0)}`],
  ];
  const hint = clamp01(motion.severity) > 0.5
    ? "⚠ 振動 + 各軸電流升高 → reducer_wear 退化" : undefined;
  return <Readout rows={rows} hint={hint} />;
}
