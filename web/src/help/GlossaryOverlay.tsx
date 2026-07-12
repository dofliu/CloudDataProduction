import { useEffect } from "react";

/**
 * 名詞速查浮層 —— 降低第一次接觸工業協定 / PdM 術語的門檻。
 * 全域(任何分頁都能開),點背景 / ✕ / Esc 關閉。純顯示、無副作用。
 */
type Term = { t: string; d: string };
type Group = { title: string; terms: Term[] };

const GROUPS: Group[] = [
  {
    title: "三種工業協定(同一份數據、三種讀法)",
    terms: [
      { t: "Modbus TCP", d: "最普遍的工業協定,用「暫存器位址 + 功能碼」讀值。本平台埠 6020。" },
      { t: "OPC-UA", d: "較新的工業協定,用樹狀節點(Objects/公司/設備/tag)瀏覽。埠 6041,連線選 Security = None。" },
      { t: "MQTT", d: "輕量發佈 / 訂閱訊息,整包 JSON 推送。埠 6083,訂 park/# 收全部。" },
      { t: "unit_id", d: "Modbus 用來分辨同一埠上不同設備的編號(共用埠 channel-mux)。目錄查得到每台的 unit_id。" },
    ],
  },
  {
    title: "Modbus 四種資料物件(依規格決定怎麼讀)",
    terms: [
      { t: "Holding Register(FC03)", d: "量測值。float32 佔 2 個暫存器、big-endian;int16 佔 1 個。設備第 1 格通常是 state。" },
      { t: "Discrete Input(FC02)", d: "唯讀狀態旗標 bit:running / fault / idle / warning / heartbeat。" },
      { t: "Input Register(FC04)", d: "唯讀整數:state_code、量測的縮放鏡像(工程單位 = 值 ÷ scale)。" },
      { t: "Coil(FC01 讀 / FC05 寫)", d: "命令線圈:run_enable(停 / 復機)、reset_fault(清故障)。學生唯讀,寫入限教師。" },
      { t: "big-endian(位元組序)", d: "float32 兩個暫存器的高低位排列。讀出來亂跳多半是 word / byte order 反了,改 AB CD。" },
    ],
  },
  {
    title: "數據誠信",
    terms: [
      { t: "合成數據(synthetic)", d: "本平台所有數據皆由模擬引擎產生、非真實場域量測,但帶正解標籤、彼此相關、可訓練。" },
      { t: "ground-truth(正解)", d: "設備的隱藏真實狀態(健康度 / 故障起始時刻),學生看不到,系統用它自動評分。" },
      { t: "隱藏健康狀態", d: "設備看不見的退化程度;觀測訊號(振動 / 溫度 / 電流…)是它的函數,故彼此相關。" },
    ],
  },
  {
    title: "健康、退化與預測",
    terms: [
      { t: "health(健康度)", d: "0~1,1=全新、0=失效。多個退化元件各有自己的健康度。" },
      { t: "RUL(剩餘壽命)", d: "Remaining Useful Life,距離失效還有多久;待機不退化時未定義(顯示 —)。" },
      { t: "lead time(提前量)", d: "階段二:你在故障真正發生前多久送出預測。越長分數越高。" },
      { t: "subtle fault(隱性故障)", d: "沒有單一警報跳的漸進劣化(如製程漂移→良率慢慢爛),要靠多訊號趨勢抓。" },
      { t: "感測器故障 vs 設備故障", d: "設備壞=健康度真的退化;感測器壞=讀值脫鉤真實(卡死 / 漂移 / 偏移),別被騙去誤報。" },
    ],
  },
  {
    title: "營運指標與流程",
    terms: [
      { t: "工單 / MTTR", d: "故障自動開工單;MTTR = 平均修復時間(從故障到 resolve)。" },
      { t: "偵測延遲", d: "故障發生到你察覺(開單 / 預測)之間的時間,越短越好。" },
      { t: "誤報(false alarm)", d: "設備其實沒壞卻報故障 / 預測;會扣分,別亂報。" },
      { t: "OEE", d: "設備總效率 = 可用率 × 表現 × 良率(各 0~1),衡量這台機真正產出好料的比例。" },
      { t: "sim_clock / 時間倍率", d: "模擬時鐘可加速(如 120× = 1 真實秒走 2 模擬分);退化都對模擬時間積分。" },
    ],
  },
];

export default function GlossaryOverlay({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div onClick={onClose}
         style={{ position: "fixed", inset: 0, background: "rgba(4,8,14,0.66)", zIndex: 1000,
                  display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "5vh 16px", overflowY: "auto" }}>
      <div onClick={(e) => e.stopPropagation()}
           style={{ background: "var(--panel)", border: "1px solid var(--line)", borderRadius: 12,
                    width: "min(860px, 100%)", padding: "18px 22px", boxShadow: "0 12px 40px rgba(0,0,0,.5)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
          <h2 style={{ margin: 0, fontSize: 18 }}>📖 名詞速查</h2>
          <button onClick={onClose}
                  style={{ background: "var(--panel2)", color: "var(--text)", border: "1px solid var(--line)",
                           borderRadius: 6, padding: "4px 12px", cursor: "pointer", fontWeight: 600 }}>✕ 關閉(Esc)</button>
        </div>
        <p className="hint" style={{ margin: "0 0 12px" }}>
          第一次看到工業協定 / PdM 術語卡住?這裡用白話快速查。詳細連線步驟見「設備目錄」與連線教學。
        </p>
        <div style={{ display: "grid", gap: 16 }}>
          {GROUPS.map((g) => (
            <div key={g.title}>
              <div style={{ fontWeight: 700, color: "var(--accent)", marginBottom: 6,
                            borderBottom: "1px solid var(--line)", paddingBottom: 4 }}>{g.title}</div>
              <div style={{ display: "grid", gap: 6 }}>
                {g.terms.map((term) => (
                  <div key={term.t} style={{ display: "grid", gridTemplateColumns: "180px 1fr", gap: 12, alignItems: "start" }}>
                    <div style={{ fontWeight: 600, color: "#453a29" }}>{term.t}</div>
                    <div className="hint" style={{ margin: 0 }}>{term.d}</div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
