/**
 * 跨機種共用的視覺語彙(契約見 docs/animation_binding.md §2)。
 *
 * 目的:同一件事在每台設備上長得一樣 —— 學生一眼就能讀「這台在動 / 待機 / 被停機 / 故障 /
 * 正在退化」,不必每台重新學一套顏色。所有元件都只讀 DeviceMotion,不自行判斷 state 字串。
 */
import React, { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { Cylinder } from "@react-three/drei";
import * as THREE from "three";
import { DeviceMotion, clamp01 } from "./deviceMotion";

export const FX = {
  ok: "#5a9e5a", warn: "#d9a441", fault: "#c85a4a", stopped: "#8a7c63",
  hot: "#ff7a2f", steel: "#7b8a8b", dark: "#333333",
};

// ── 工件視覺語彙(全站統一,2026-08-13)──────────────────────
// 同一個工件在 CNC 裡是白色大板、手臂夾著是綠色小塊、輸送帶上又變橘色 ——
// 學生看不出「誰是誰」。統一成兩種身分、各一種顏色與尺寸:
//   · 站間「流動中的工件」(緩衝堆 / 手臂在手 / 棧板 / 輸送帶上 / AGV 載貨):
//     一律綠色 WORKPIECE、0.5 立方 —— 綠色只給工件,機身沒有這個顏色。
//   · 機內「加工中的胚料」(CNC 刻字板 / 沖壓模台料):一律胚料黃 BLANK ——
//     大板是材料,加工完的「件」才變綠色進入流動。
export const WORKPIECE = "#3a8a3a";
export const WORKPIECE_SIZE = 0.5;
export const BLANK = "#cbb98f";

/** 機身主色:故障轉警示紅、被停機轉灰、其餘維持原色。 */
export function bodyColor(motion: DeviceMotion, base = FX.steel) {
  if (motion.fault) return FX.fault;
  if (motion.stopped) return "#6f7676";
  return base;
}

/** 狀態燈的顏色(柱燈 / 面板燈共用)。 */
export function statusColor(motion: DeviceMotion) {
  if (motion.fault) return FX.fault;
  if (motion.stopped) return FX.stopped;
  if (motion.idle) return FX.warn;
  return motion.severity > 0.55 ? FX.warn : FX.ok;
}

/**
 * 三色柱燈。fault 快閃紅、教師停機慢閃黃、退化過半亮黃、正常亮綠。
 * 每台設備都掛一支,位置由呼叫端給。
 */
export function StatusBeacon({ motion, position = [0, 0, 0], scale = 1 }:
  { motion: DeviceMotion; position?: [number, number, number]; scale?: number }) {
  const redRef = useRef<THREE.MeshStandardMaterial>(null);
  const amberRef = useRef<THREE.MeshStandardMaterial>(null);
  const greenRef = useRef<THREE.MeshStandardMaterial>(null);

  useFrame((st) => {
    const t = st.clock.elapsedTime;
    // 閃爍的暗相不歸零:紅燈快閃時仍要維持在「看得出是紅的」的亮度,否則截到暗相
    // 那一瞬間整支柱燈是黑的,故障就沒有隨時可辨識。
    const blinkFast = Math.sin(t * 9) > 0 ? 1 : 0.42;
    const blinkSlow = Math.sin(t * 2.2) > 0 ? 1 : 0.3;
    if (redRef.current) redRef.current.emissiveIntensity = motion.fault ? blinkFast * 2.4 : 0.04;
    if (amberRef.current) {
      // fault 時黃燈必須熄掉,讓紅燈獨佔柱燈(andon 慣例:最高優先級的燈號獨佔)。
      // 先前沒有這條:故障必然伴隨 severity 拉滿 → 黃燈恆亮,而紅燈是閃的,
      // 於是有一半的瞬間「故障」看起來跟「警告」一模一樣。
      const on = motion.fault ? 0.04
        : motion.stopped ? blinkSlow
        : motion.idle ? 0.9
        : motion.severity > 0.55 ? 0.6 + motion.severity
        : 0.04;
      amberRef.current.emissiveIntensity = on * 2.0;
    }
    if (greenRef.current) greenRef.current.emissiveIntensity = motion.running && !motion.fault ? 1.8 : 0.04;
  });

  return (
    <group position={position} scale={scale}>
      <Cylinder args={[0.07, 0.07, 1.0, 10]} position={[0, 0.5, 0]}>
        <meshStandardMaterial color="#444" metalness={0.6} />
      </Cylinder>
      <Cylinder args={[0.17, 0.17, 0.26, 14]} position={[0, 1.45, 0]}>
        <meshStandardMaterial name="probe:beacon_red" ref={redRef} color={FX.fault} emissive={FX.fault} emissiveIntensity={0} toneMapped={false} />
      </Cylinder>
      <Cylinder args={[0.17, 0.17, 0.26, 14]} position={[0, 1.18, 0]}>
        <meshStandardMaterial name="probe:beacon_amber" ref={amberRef} color={FX.warn} emissive={FX.warn} emissiveIntensity={0} toneMapped={false} />
      </Cylinder>
      <Cylinder args={[0.17, 0.17, 0.26, 14]} position={[0, 0.91, 0]}>
        <meshStandardMaterial name="probe:beacon_green" ref={greenRef} color={FX.ok} emissive={FX.ok} emissiveIntensity={0} toneMapped={false} />
      </Cylinder>
    </group>
  );
}

/**
 * 故障冒煙。只在 fault 時噴,是「機構停了」以外的第二個遠距可辨識線索
 * —— 學生在產線俯瞰就能一眼找出壞掉那台。
 */
export function FaultSmoke({ motion, position = [0, 0, 0], scale = 1 }:
  { motion: DeviceMotion; position?: [number, number, number]; scale?: number }) {
  const COUNT = 40;
  const ref = useRef<THREE.Points>(null);
  const positions = useMemo(() => {
    const a = new Float32Array(COUNT * 3);
    for (let i = 0; i < COUNT; i++) a[i * 3 + 1] = -999;
    return a;
  }, []);
  const life = useMemo(() => new Float32Array(COUNT).fill(-1), []);
  const drift = useMemo(
    () => Array.from({ length: COUNT }, () => new THREE.Vector2((Math.random() - 0.5) * 0.5, (Math.random() - 0.5) * 0.5)),
    [],
  );

  useFrame((_, delta) => {
    const pts = ref.current;
    if (!pts) return;
    const arr = pts.geometry.attributes.position.array as Float32Array;
    for (let i = 0; i < COUNT; i++) {
      if (life[i] < 0) {
        if (motion.fault && Math.random() < delta * 8) {
          life[i] = 0;
          arr[i * 3] = (Math.random() - 0.5) * 0.5;
          arr[i * 3 + 1] = 0;
          arr[i * 3 + 2] = (Math.random() - 0.5) * 0.5;
        } else {
          arr[i * 3 + 1] = -999;
        }
        continue;
      }
      life[i] += delta;
      arr[i * 3] += drift[i].x * delta;
      arr[i * 3 + 1] += 1.1 * delta;
      arr[i * 3 + 2] += drift[i].y * delta;
      if (life[i] > 2.4) life[i] = -1;
    }
    pts.geometry.attributes.position.needsUpdate = true;
    pts.visible = motion.fault;
    (pts.material as THREE.PointsMaterial).opacity = motion.fault ? 0.42 : 0;
  });

  return (
    <points frustumCulled={false} ref={ref} position={position} scale={scale} visible={false}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" count={COUNT} array={positions} itemSize={3} />
      </bufferGeometry>
      {/* 深灰:場景是暖色淺底,淺灰煙會看不見 */}
      <pointsMaterial size={0.6} color="#4a453e" transparent opacity={0} depthWrite={false} />
    </points>
  );
}

/**
 * 依 vibration_rms 抖動整台機器(L2)。振動越大抖越兇,故障瞬間加一記重震。
 * 包在最外層 group,不影響內部相對幾何。
 */
export function Shake({ motion, children, amount = 1 }:
  { motion: DeviceMotion; children: React.ReactNode; amount?: number }) {
  const ref = useRef<THREE.Group>(null);
  useFrame((st) => {
    if (!ref.current) return;
    const t = st.clock.elapsedTime;
    // 只有在動的時候才抖(停機的機器不會振動)
    const sev = motion.running ? clamp01(motion.severity) : 0;
    const a = sev * sev * 0.13 * amount;
    ref.current.position.x = Math.sin(t * 47) * a;
    ref.current.position.y = Math.sin(t * 61 + 1.3) * a * 0.6;
    ref.current.position.z = Math.cos(t * 53 + 0.7) * a;
    ref.current.rotation.z = Math.sin(t * 43) * a * 0.02;
  });
  return <group ref={ref}>{children}</group>;
}

/**
 * 過熱輝光:heat 越高越亮越紅。掛在主要熱源部位。
 * 用一顆低不透明度的加成球;heat=0 時完全不畫(避免在淺色場景蓋出一團霧)。
 */
export function HeatGlow({ motion, position = [0, 0, 0], radius = 1 }:
  { motion: DeviceMotion; position?: [number, number, number]; radius?: number }) {
  const ref = useRef<THREE.Mesh>(null);
  useFrame((st) => {
    const mesh = ref.current;
    if (!mesh) return;
    const h = clamp01(motion.heat);
    mesh.visible = h > 0.05;
    const pulse = 0.85 + 0.15 * Math.sin(st.clock.elapsedTime * 3);
    (mesh.material as THREE.MeshBasicMaterial).opacity = h * h * 0.16 * pulse;
  });
  return (
    <mesh ref={ref} position={position} visible={false}>
      <sphereGeometry args={[radius, 16, 12]} />
      <meshBasicMaterial color={FX.hot} transparent opacity={0} depthWrite={false}
                         blending={THREE.AdditiveBlending} toneMapped={false} />
    </mesh>
  );
}

/**
 * 場景內文字牌。用 CanvasTexture 自己畫,**不用 drei 的 <Text>** ——
 * troika 會去 jsdelivr 抓字型資料(中文一定要抓),校內 LAN 無外網時字會整片消失。
 * 自己畫則走瀏覽器系統字體,中英文都穩,且離線可用。
 */
export function CanvasLabel({
  text, position = [0, 0, 0], rotation = [0, 0, 0], height = 0.4,
  color = "#4a3f2f", bg = "rgba(255,250,240,0.88)", bold = true,
}: {
  text: string;
  position?: [number, number, number];
  rotation?: [number, number, number];
  /** 牌子在世界座標的高度(寬度依文字長度自動算) */
  height?: number;
  color?: string;
  bg?: string;
  bold?: boolean;
}) {
  const { texture, aspect } = useMemo(() => {
    const PX = 64, PAD = 18;
    const probe = document.createElement("canvas").getContext("2d")!;
    const font = `${bold ? "700 " : ""}${PX}px "Noto Sans TC","PingFang TC","Microsoft JhengHei",system-ui,sans-serif`;
    probe.font = font;
    const w = Math.ceil(probe.measureText(text).width) + PAD * 2;
    const h = PX + PAD * 2;
    const cv = document.createElement("canvas");
    cv.width = Math.max(8, w); cv.height = h;
    const ctx = cv.getContext("2d")!;
    if (bg !== "none") {
      ctx.fillStyle = bg;
      ctx.beginPath();
      const r = 14;
      ctx.roundRect(0, 0, cv.width, cv.height, r);
      ctx.fill();
    }
    ctx.font = font;
    ctx.fillStyle = color;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, cv.width / 2, cv.height / 2 + 2);
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    return { texture: tex, aspect: cv.width / cv.height };
  }, [text, color, bg, bold]);

  useEffect(() => () => texture.dispose(), [texture]);

  return (
    <mesh position={position} rotation={rotation}>
      <planeGeometry args={[height * aspect, height]} />
      <meshBasicMaterial map={texture} transparent toneMapped={false} depthWrite={false} />
    </mesh>
  );
}

/** 機台上的小型狀態文字(RUNNING / IDLE / STOPPED / FAULT)。 */
export function StatusText({ motion, position = [0, 0, 0], size = 0.3 }:
  { motion: DeviceMotion; position?: [number, number, number]; size?: number }) {
  const label = motion.fault ? "FAULT" : motion.stopped ? "STOPPED"
    : motion.charging ? "CHARGING" : motion.running ? "RUNNING" : "IDLE";
  return <CanvasLabel text={label} position={position} height={size * 1.5} color={statusColor(motion)} bg="none" />;
}
