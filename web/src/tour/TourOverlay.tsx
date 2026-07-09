import { useEffect, useLayoutEffect, useState } from "react";
import { CourseStatus } from "../api";

/**
 * 🎮 新手導覽 —— 像遊戲開場的互動聚光燈教學。
 *
 * 從 App 外殼疊一層 overlay,用「聚光燈 + 指示卡」一步步高亮真實 UI 元件
 * (頂欄分頁、燈號摘要、時鐘、名詞鈕),並在需要時切分頁(onNav),
 * 帶學生走過「這座園區是什麼、每個分頁在幹嘛、怎麼開始」。
 *
 * 設計原則:
 *   - 純前端、無副作用、不碰後端狀態(只讀 DOM 位置畫聚光燈)。
 *   - 目標元件用 data-tour="key" 標記;找不到就把卡片置中(降級不崩)。
 *   - 首次進站自動開一次(localStorage flag),頂欄留「🎮 導覽」可重播。
 *   - 最後一步引導接續「▶ 範例示範」看完整故障處置迴圈。
 */

type View = "start" | "world" | "student" | "catalog" | "diag" | "oee" | "teacher";

interface Step {
  target?: string;       // data-tour 值;省略 = 置中大卡(開場 / 結尾)
  view?: View;           // 進入此步先切到的分頁
  title: string;
  body: React.ReactNode;
  emoji?: string;
}

const STEPS: Step[] = [
  {
    emoji: "🏭",
    title: "歡迎來到勤益智慧工業區",
    body: (
      <>
        你是這座<b>虛擬工業園區</b>的維運工程師。園區裡好幾間公司、數十台設備正在真實運轉,
        以標準的 <b style={{ color: "#5b9bd5" }}>Modbus / OPC-UA / MQTT</b> 工業協定對外。
        它們會健康地跑、也會慢慢退化甚至故障 —— 你的工作是<b>連上、監控、在壞掉前抓到徵兆</b>。
        <div style={{ marginTop: 8, color: "#f08c2e", fontSize: 12 }}>
          全部為合成數據(synthetic)、帶正解標籤,專為教學設計。放心動手、放心試錯。
        </div>
        <div style={{ marginTop: 10, color: "var(--muted)", fontSize: 12 }}>
          花 60 秒帶你認識介面,結束後可以直接看一個完整的故障處置範例。
        </div>
      </>
    ),
  },
  {
    target: "nav",
    title: "頂欄分頁 = 你的工作台",
    body: <>整個平台就這幾個分頁。左到右大致是「先認識 → 看世界 → 動手做 → 查規格 → 比成績」。接下來逐一介紹。</>,
  },
  {
    target: "tab-start",
    view: "start",
    emoji: "🚀",
    title: "開始 · 任務中心",
    body: (
      <>
        你的<b>大本營</b>。設定學號、認領公司,系統會依你認領的設備自動產出<b>可直接執行的連線程式(Python)</b>,
        再用真實狀態幫你的任務進度打勾。第一次玩,從這裡開始準沒錯。
      </>
    ),
  },
  {
    target: "tab-world",
    view: "world",
    emoji: "🗺️",
    title: "2D 世界 · 園區俯瞰",
    body: <>等距視角的園區地圖。點公司進廠內、再點設備看即時值。設備顏色就是健康狀態:<b style={{ color: "#37d67a" }}>綠</b>=運轉、<b style={{ color: "#f2c14e" }}>黃</b>=警告、<b style={{ color: "#e0503f" }}>紅</b>=故障。世界本身不存狀態,顏色全來自即時遙測。</>,
  },
  {
    target: "tab-catalog",
    view: "catalog",
    emoji: "📖",
    title: "設備目錄 · 你的接線圖",
    body: <>每台設備、每個資料點位的協定規格書:連哪個 <code>port / unit_id / register / node / topic</code>、是什麼型別。你自己寫 client 要抓什麼,全看這裡。</>,
  },
  {
    target: "tab-student",
    view: "student",
    emoji: "🎫",
    title: "學生面 · 認領與工單",
    body: <>認領公司、處置工單(故障會自動開單,你 ack 確認 → resolve 修復),還有故障管理與各種競賽榜。你這間廠的 OEE、MTTR 都算你的成績。</>,
  },
  {
    target: "tab-diag",
    view: "diag",
    emoji: "📡",
    title: "戰情版 · 三協定自測",
    body: <>不確定自己的程式有沒有連對?這裡即時自測 Modbus / OPC-UA / MQTT 三協定,拿它讀到的值和你工具裡的值對照,快速抓連線問題。</>,
  },
  {
    target: "tab-oee",
    view: "oee",
    emoji: "📊",
    title: "OEE 榜 · 誰的廠最會產",
    body: <>設備總效率排名:可用率 × 表現 × 良率。監控做得好、故障修得快、預測抓得早,名次就往上爬。</>,
  },
  {
    target: "lightsum",
    view: "world",
    title: "全域燈號摘要",
    body: <>頂欄右側永遠顯示整個園區此刻有幾台<b style={{ color: "#37d67a" }}>正常</b>、<b style={{ color: "#f2c14e" }}>警告</b>、<b style={{ color: "#e0503f" }}>故障</b>。紅點會閃 —— 一眼看出全場有沒有事。</>,
  },
  {
    target: "clock",
    title: "模擬時鐘 · 可加速",
    body: <>顯示模擬時間與時間倍率(如 <code>120×</code>)。所有退化都對<b>模擬時間</b>積分,老師加速時鐘,幾分鐘就能看完一台機器從健康到故障的一生。</>,
  },
  {
    target: "help",
    title: "名詞速查隨時在",
    body: <>被 Modbus、RUL、OEE 這些術語卡住?按這顆「❓ 名詞」隨時查白話解釋,任何分頁都能開。</>,
  },
  {
    emoji: "🎬",
    title: "準備好了 —— 來看一個完整範例",
    body: (
      <>
        介面就這些。理論說再多不如看一次:接下來的<b>範例示範</b>會帶你走完一台 CNC 的完整處置迴圈 ——
        <b>認領 → 運轉 → 故障 → 分析 → 診斷根因 → 排除復機</b>,全程動畫、不需要任何設定。
        <div style={{ marginTop: 10, color: "var(--muted)", fontSize: 12 }}>
          看完就換你上場,到「🚀 開始」認領一間公司,一切都準備好了。
        </div>
      </>
    ),
  },
];

const MARGIN = 12;        // 聚光燈 padding
const CARD_W = 340;
const CARD_GAP = 14;      // 卡片與高亮框的距離

export default function TourOverlay({
  onNav, onClose, onStartDemo, courseStatus,
}: {
  onNav: (v: View) => void;
  onClose: () => void;
  onStartDemo: () => void;
  courseStatus?: CourseStatus | null;
}) {
  const [i, setI] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const step = STEPS[i];
  const isLast = i === STEPS.length - 1;

  // 切分頁(若此步指定),讓目標元件先渲染出來。
  useEffect(() => { if (step.view) onNav(step.view); }, [i]);

  // 量測目標元件位置;切分頁後稍等一拍再量,並隨視窗變動重量。
  useLayoutEffect(() => {
    let raf = 0;
    const measure = () => {
      if (!step.target) { setRect(null); return; }
      const el = document.querySelector<HTMLElement>(`[data-tour="${step.target}"]`);
      setRect(el ? el.getBoundingClientRect() : null);
    };
    const t = setTimeout(() => { raf = requestAnimationFrame(measure); }, step.view ? 90 : 0);
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => { clearTimeout(t); cancelAnimationFrame(raf); window.removeEventListener("resize", measure); window.removeEventListener("scroll", measure, true); };
  }, [i]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowRight" || e.key === "Enter") next();
      else if (e.key === "ArrowLeft") setI((v) => Math.max(0, v - 1));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [i]);

  const next = () => { if (isLast) finish(); else setI((v) => Math.min(STEPS.length - 1, v + 1)); };
  const finish = () => { localStorage.setItem("tour_seen_v1", "1"); onClose(); };
  const launchDemo = () => { localStorage.setItem("tour_seen_v1", "1"); onClose(); onStartDemo(); };

  // 聚光燈框(含 padding),夾在畫面內。
  const hl = rect
    ? {
        left: Math.max(4, rect.left - MARGIN),
        top: Math.max(4, rect.top - MARGIN),
        width: rect.width + MARGIN * 2,
        height: rect.height + MARGIN * 2,
      }
    : null;

  // 指示卡定位:有目標→貼在下方(空間不夠改上方 / 靠左);無目標→置中。
  const cardStyle = computeCardPos(hl);

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 1200 }}>
      {/* 遮罩:有目標時用 box-shadow 挖洞做聚光燈;無目標時整片暗。 */}
      {hl ? (
        <div
          onClick={next}
          style={{
            position: "fixed", left: hl.left, top: hl.top, width: hl.width, height: hl.height,
            borderRadius: 10, boxShadow: "0 0 0 9999px rgba(4,8,14,0.74)",
            border: "2px solid var(--accent)", pointerEvents: "auto",
            transition: "all .28s cubic-bezier(.4,0,.2,1)", animation: "tourPulse 2s ease-in-out infinite",
          }}
        />
      ) : (
        <div onClick={next} style={{ position: "fixed", inset: 0, background: "rgba(4,8,14,0.78)" }} />
      )}

      {/* 指示卡 */}
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          position: "fixed", ...cardStyle, width: CARD_W, maxWidth: "calc(100vw - 24px)",
          background: "var(--panel)", border: "1px solid var(--line-2)", borderRadius: 12,
          boxShadow: "0 18px 50px rgba(0,0,0,.6)", padding: "16px 18px",
          transition: "all .28s cubic-bezier(.4,0,.2,1)",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
          <span className="mono" style={{ fontSize: 11, color: "var(--dim)", letterSpacing: 1 }}>
            導覽 {i + 1} / {STEPS.length}
          </span>
          <button onClick={finish} style={{ background: "none", border: "none", color: "var(--muted)", cursor: "pointer", fontSize: 12 }}>
            跳過 ✕
          </button>
        </div>

        {courseStatus?.current_week != null && (
          <div style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--accent)",
                        background: "var(--panel-3)", border: "1px solid var(--line-2)", borderRadius: 12,
                        padding: "2px 9px", margin: "4px 0 2px" }}>
            📅 本學期目前第 {courseStatus.current_week} 週{courseStatus.title ? ` · ${courseStatus.title}` : ""}
          </div>
        )}
        <div style={{ fontSize: 16, fontWeight: 700, color: "var(--text)", margin: "2px 0 8px" }}>
          {step.emoji ? `${step.emoji} ` : ""}{step.title}
        </div>
        <div style={{ fontSize: 13, lineHeight: 1.65, color: "var(--text-2)" }}>{step.body}</div>

        {/* 進度點 */}
        <div style={{ display: "flex", gap: 5, margin: "14px 0 12px", flexWrap: "wrap" }}>
          {STEPS.map((_, k) => (
            <span key={k} onClick={() => setI(k)}
              style={{ width: k === i ? 18 : 7, height: 7, borderRadius: 4, cursor: "pointer",
                       background: k === i ? "var(--accent)" : k < i ? "#2f7a4f" : "var(--line-2)",
                       transition: "all .2s" }} />
          ))}
        </div>

        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {i > 0 && (
            <button className="btn ghost" style={{ padding: "6px 12px" }} onClick={() => setI((v) => Math.max(0, v - 1))}>← 上一步</button>
          )}
          <div style={{ flex: 1 }} />
          {isLast ? (
            <>
              <button className="btn ghost" style={{ padding: "6px 12px" }} onClick={finish}>先自己逛逛</button>
              <button className="btn primary" style={{ padding: "6px 14px" }} onClick={launchDemo}>▶ 看範例示範</button>
            </>
          ) : (
            <button className="btn primary" style={{ padding: "6px 16px" }} onClick={next}>下一步 →</button>
          )}
        </div>
      </div>
    </div>
  );
}

// 依高亮框決定卡片位置:優先放下方,下方不夠放上方,再不夠靠右側置中。
function computeCardPos(hl: { left: number; top: number; width: number; height: number } | null): React.CSSProperties {
  const vw = window.innerWidth, vh = window.innerHeight;
  const estH = 300;
  if (!hl) {
    return { left: Math.max(12, vw / 2 - CARD_W / 2), top: Math.max(24, vh / 2 - estH / 2) };
  }
  const below = hl.top + hl.height + CARD_GAP;
  const above = hl.top - CARD_GAP - estH;
  let top: number, left: number;
  if (below + estH < vh) top = below;
  else if (above > 8) top = above;
  else top = Math.max(12, vh / 2 - estH / 2);
  // 水平:對齊高亮框左緣,超出右界就往左收。
  left = hl.left;
  if (left + CARD_W > vw - 12) left = vw - 12 - CARD_W;
  if (left < 12) left = 12;
  return { left, top };
}
