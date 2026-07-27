/**
 * 單機 3D 場景外殼(契約見 docs/animation_binding.md §5)。
 *
 * 兩個硬性規定:
 *
 * 1. **燈光 / 環境 / 接地陰影 / 地板只能出現在這裡**(以及 FactoryLine3D 的 Canvas)。
 *    機種 model 元件內部一律不得自帶,否則產線視圖放 N 台就會建 N 份環境貼圖與陰影
 *    render target —— 那正是先前 WebGL context lost 的來源。
 *
 * 2. **不得依賴外網資源**。本平台常駐校內 5090 主機、學生走 LAN,無外網時畫面必須照跑。
 *    因此:
 *      · 不用 drei `<Environment preset>` —— 它會去 githack CDN 抓 .hdr,抓不到會讓整個
 *        Canvas 拋錯、被 error boundary 收掉,畫面全黑。改用本地程序化產生的環境貼圖。
 *      · 不用 drei `<Text>` —— troika 會去 jsdelivr 抓字型資料(中文更是一定要抓),
 *        離線時字全部消失。所有文字改走 HTML overlay(用網頁本身的字體)或 CanvasLabel。
 */
import React, { useEffect, useMemo } from "react";
import { Canvas, useThree } from "@react-three/fiber";
import { OrbitControls, ContactShadows } from "@react-three/drei";
import * as THREE from "three";

export type EnvTone = "warehouse" | "city" | "outdoor";

const TONES: Record<EnvTone, { sky: string; horizon: string; ground: string; key: string }> = {
  warehouse: { sky: "#cfd6db", horizon: "#9aa3ab", ground: "#4e5459", key: "#ffffff" },
  city: { sky: "#d9dfe6", horizon: "#a8b0b8", ground: "#5a5f64", key: "#fff6e6" },
  outdoor: { sky: "#a8c8e8", horizon: "#dbe6ef", ground: "#6a7a5a", key: "#fffaf0" },
};

/**
 * 程序化環境貼圖:一張 equirectangular 漸層 + 一塊高光區(模擬廠房天窗)。
 * 純本地生成,無任何網路請求;金屬件仍有可信的反射層次。
 */
function makeEnvTexture(tone: EnvTone): THREE.Texture {
  const c = TONES[tone];
  const cv = document.createElement("canvas");
  cv.width = 256; cv.height = 128;
  const ctx = cv.getContext("2d")!;
  const g = ctx.createLinearGradient(0, 0, 0, 128);
  g.addColorStop(0, c.sky);
  g.addColorStop(0.48, c.horizon);
  g.addColorStop(0.52, c.ground);
  g.addColorStop(1, c.ground);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 256, 128);
  // 天窗高光:讓金屬面有方向性反射,而不是死白
  const key = ctx.createRadialGradient(80, 26, 2, 80, 26, 46);
  key.addColorStop(0, c.key);
  key.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = key;
  ctx.fillRect(0, 0, 256, 70);
  const fill = ctx.createRadialGradient(196, 34, 2, 196, 34, 34);
  fill.addColorStop(0, "rgba(255,255,255,0.55)");
  fill.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = fill;
  ctx.fillRect(120, 0, 136, 70);

  const tex = new THREE.CanvasTexture(cv);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/** 把程序化環境掛到 scene.environment(取代 drei 的 <Environment preset>)。 */
export function StudioEnvironment({ tone = "warehouse" }: { tone?: EnvTone }) {
  const { scene } = useThree();
  const tex = useMemo(() => makeEnvTexture(tone), [tone]);
  useEffect(() => {
    const prev = scene.environment;
    scene.environment = tex;
    return () => { scene.environment = prev; tex.dispose(); };
  }, [scene, tex]);
  return null;
}

/** 場景標準燈光(一組,全場共用)。 */
export function SceneLights() {
  return (
    <>
      <ambientLight intensity={0.5} />
      <directionalLight position={[10, 20, 10]} intensity={1.15} castShadow shadow-bias={-0.0001} />
      <pointLight position={[-10, 8, 8]} intensity={0.6} />
    </>
  );
}

export function MachineScene({
  children, camera = [0, 6, 12], fov = 45, target = [0, 2, 0],
  env = "warehouse", ground = "#e0e0e0", groundSize = 50,
  shadowScale = 20, shadowY = -0.99, note, overlay,
}: {
  children: React.ReactNode;
  camera?: [number, number, number];
  fov?: number;
  target?: [number, number, number];
  env?: EnvTone;
  ground?: string;
  groundSize?: number;
  shadowScale?: number;
  shadowY?: number;
  /** L3 視覺換算說明(轉速降頻 / 動畫慢放…),契約要求必須標示 */
  note?: string;
  /** 即時讀值面板等 HTML 疊層(走網頁字體,離線也正常) */
  overlay?: React.ReactNode;
}) {
  return (
    <div style={{ position: "absolute", inset: 0 }}>
      <Canvas shadows camera={{ position: camera, fov }}
              style={{ position: "absolute", inset: 0, width: "100%", height: "100%", display: "block" }}>
        <OrbitControls enablePan enableZoom enableRotate target={target} maxPolarAngle={Math.PI / 2 - 0.05} />
        <SceneLights />
        <StudioEnvironment tone={env} />

        {children}

        <ContactShadows position={[0, shadowY, 0]} opacity={0.55} scale={shadowScale} blur={2} far={10} />
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, shadowY - 0.01, 0]} receiveShadow>
          <planeGeometry args={[groundSize, groundSize]} />
          <meshStandardMaterial color={ground} roughness={0.85} />
        </mesh>
      </Canvas>

      <div style={{ position: "absolute", left: 14, top: 12, display: "flex", flexDirection: "column", gap: 4,
                    pointerEvents: "none", fontSize: 11.5 }}>
        <span style={{ background: "rgba(255,250,240,.78)", color: "var(--muted)", padding: "4px 10px",
                       borderRadius: 8, alignSelf: "flex-start" }}>
          拖曳旋轉 · 滾輪縮放
        </span>
        {note && (
          <span className="mono" style={{ background: "rgba(212,122,63,.14)", color: "var(--pred)",
                                          padding: "4px 10px", borderRadius: 8, alignSelf: "flex-start" }}>
            {note} · 數值以點位為準
          </span>
        )}
      </div>
      {overlay}
    </div>
  );
}

export type Row = [label: string, value: string, warn?: boolean];

/**
 * 即時讀值面板(HTML,不是 3D 文字)。
 * 每一列都直接對應一支 telemetry tag —— 學生可拿它跟 Modbus / OPC-UA / MQTT 讀到的值對照。
 */
export function Readout({ rows, hint }: { rows: Row[]; hint?: string }) {
  return (
    <div style={{ position: "absolute", right: 12, top: 12, width: 218, pointerEvents: "none",
                  background: "rgba(255,250,240,.86)", border: "1px solid var(--line)", borderRadius: 10,
                  padding: "9px 11px", boxShadow: "0 2px 10px rgba(90,70,40,.10)" }}>
      {rows.map(([k, v, warn]) => (
        <div key={k} style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "baseline",
                              padding: "2.5px 0", borderBottom: "1px solid rgba(216,198,168,.45)" }}>
          <span style={{ fontSize: 10.5, color: "var(--dim)", letterSpacing: ".2px" }}>{k}</span>
          <span className="mono" style={{ fontSize: 11.5, fontWeight: 600, color: warn ? "var(--fault, #c85a4a)" : "var(--text)" }}>
            {v}
          </span>
        </div>
      ))}
      {hint && (
        <div style={{ fontSize: 10.5, lineHeight: 1.45, color: "var(--pred)", marginTop: 7 }}>{hint}</div>
      )}
    </div>
  );
}

export default MachineScene;
