import { useEffect, useMemo, useState } from "react";
import {
  Park, Company, Catalog, CatalogDevice, DeviceSnapshot, TelemetryMsg, Ticket, PredScoreRow,
  getPark, getCatalog, getTickets, getPredictionScores, claimCompany, STATUS_COLOR_CSS,
} from "../api";

/**
 * 🚀 任務中心 / 開始這裡 —— 學生的落地頁。
 *
 * 設計目標:學生第一次打開就知道「我是誰、要幹嘛、怎麼連上設備」。
 * 不再只是丟一座漂亮的 2D 世界讓人發呆。三個支柱:
 *   1. 故事 + 任務弧線(認領 → 連線 → 監控 → 偵測 → 開單 → 預測)。
 *   2. 即時任務進度:用系統真實狀態自動打勾(認領了沒、開過單沒、送過預測沒),進度是「掙來的」。
 *   3. 個人化連線包:依你認領的公司,直接產出填好 host/port/unit_id/register 的可執行 Python。
 *      移除整個平台最嚇人的門檻 —— 「我到底怎麼寫 client 連上去?」
 */

type View = "start" | "world" | "student" | "catalog" | "diag" | "oee" | "teacher";

// 挑一個最有戲的「招牌 tag」當連線包示範(退化主指標優先)。
const SIGNATURE_PREF = [
  "vibration_rms", "particle_count", "active_power", "vacuum_pump_current",
  "spindle_current", "motor_current", "oil_temp", "battery_soc",
];

export default function OnboardingView({
  park, telemetry, catalog, onNav,
}: {
  park: Park; telemetry: TelemetryMsg | null; catalog: Catalog | null; onNav: (v: View) => void;
}) {
  const [me, setMe] = useState(localStorage.getItem("student_id") || "");
  const [meInput, setMeInput] = useState(me);
  const [companies, setCompanies] = useState<Company[]>(park.companies);
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [predScores, setPredScores] = useState<PredScoreRow[]>([]);
  const [claimPick, setClaimPick] = useState("");
  const [connected, setConnected] = useState(localStorage.getItem(`quest_connected_${me}`) === "1");
  const [copied, setCopied] = useState("");
  const [kitMode, setKitMode] = useState<"read" | "monitor">("read");
  const [msg, setMsg] = useState("");

  // 輪詢真實狀態:認領、工單、預測榜(和學生面同節奏)。
  useEffect(() => {
    const refresh = () => {
      getPark().then((p) => setCompanies(p.companies)).catch(() => {});
      getTickets().then((r) => setTickets(r.tickets)).catch(() => {});
      getPredictionScores().then((r) => setPredScores(r.ranking)).catch(() => {});
    };
    refresh();
    const id = setInterval(refresh, 4000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => { setConnected(localStorage.getItem(`quest_connected_${me}`) === "1"); }, [me]);

  const saveMe = () => {
    const v = meInput.trim();
    setMe(v);
    localStorage.setItem("student_id", v);
    setMsg(v ? `身分設定為 ${v}` : "");
  };

  const myCompany = useMemo(
    () => (me ? companies.find((c) => c.owner === me) || null : null),
    [companies, me],
  );
  const myFaulted = myCompany
    ? (myCompany.device_ids || []).filter((d) => telemetry?.devices[d]?.state === "fault")
    : [];

  const claim = async (cid: string) => {
    if (!me) { setMsg("請先設定你的學生 id"); return; }
    if (!cid) { setMsg("先選一間要認領的公司"); return; }
    try { await claimCompany(cid, me); setMsg(`已認領 ${cid} 🎉`); getPark().then((p) => setCompanies(p.companies)); }
    catch { setMsg("認領失敗(可能已被別人認領)"); }
  };

  // ── 連線包:依認領公司的第一台設備,從目錄產出可執行片段 ──────────
  const kit = useMemo(() => buildKit(myCompany, catalog, window.location.hostname), [myCompany, catalog]);
  const stage2 = useMemo(() => buildStage2(myCompany, catalog, window.location.hostname, me), [myCompany, catalog, me]);
  const liveVal = kit && telemetry ? telemetry.devices[kit.deviceId]?.tags?.[kit.tag] : undefined;

  const copy = async (text: string, label: string) => {
    try { await navigator.clipboard.writeText(text); setCopied(label); setTimeout(() => setCopied(""), 1600); }
    catch { setMsg("複製失敗,請手動選取"); }
  };

  const markConnected = () => {
    localStorage.setItem(`quest_connected_${me}`, "1");
    setConnected(true);
    setMsg("太好了!你已成功讀到設備數值 ✅");
  };

  // ── 任務進度:盡量用真實狀態自動判定 ───────────────────────────
  const myCompanyIds = new Set(companies.filter((c) => c.owner === me && !!me).map((c) => c.id));
  const myResolved = tickets.some((t) => myCompanyIds.has(t.company || "") && t.status === "resolved");
  const myPred = predScores.find((r) => r.student === me);
  const steps: Step[] = [
    { done: !!me, title: "設定你的學生 id", desc: "課堂用它記分、認領公司、上競賽榜。" },
    { done: !!myCompany, title: "認領一間公司", desc: "你負責這間廠的設備維運;它的工單、OEE 都算你的。" },
    { done: connected, title: "連上你的第一台設備", desc: "用下方連線包,在自己的 Python/工具讀到一個即時數值。" },
    { done: myResolved, title: "偵測故障 → 開單處置", desc: "設備退化或被注入故障會自動開單;ack 確認、resolve 修復。" },
    { done: !!myPred && myPred.predictions > 0, title: "訓練模型 → 送出預測(階段二)", desc: "撈歷史訓練,在故障前 POST 預測,拚 lead time 上榜。" },
  ];
  const doneN = steps.filter((s) => s.done).length;
  const allDone = doneN === steps.length;

  const unclaimed = companies.filter((c) => !c.owner);

  return (
    <div className="catalog" style={{ maxWidth: 1080 }}>
      {/* Hero */}
      <div style={{ background: "linear-gradient(135deg,#16233a,#1a2230)", border: "1px solid var(--line)",
                    borderRadius: 12, padding: "18px 22px", marginBottom: 18 }}>
        <div style={{ fontSize: 22, fontWeight: 800, letterSpacing: 0.3 }}>
          🏭 歡迎來到{park.name}
        </div>
        <p style={{ margin: "8px 0 0", color: "#c7d2e0", lineHeight: 1.7, maxWidth: 760 }}>
          你是這座虛擬工業區的<b style={{ color: "#5b9bd5" }}>維運工程師</b>。園區裡 {companies.length} 間公司、
          數十台真實運轉的設備(以標準 <b>Modbus / OPC-UA / MQTT</b> 協定對外),
          會健康地跑、也會慢慢退化甚至故障。你的任務:<b style={{ color: "#e6ecf5" }}>連上它們、監控它們、在壞掉前抓到徵兆</b>。
        </p>
        <div style={{ marginTop: 10, fontSize: 12, color: "#f08c2e" }}>
          ⚠ 全部為合成數據(synthetic),帶 ground-truth 標籤,專為教學設計 —— 放心動手、放心試錯。
        </div>
      </div>

      {/* 身分 */}
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 6 }}>
        <span className="hint" style={{ margin: 0 }}>我的學生 id:</span>
        <input value={meInput} onChange={(e) => setMeInput(e.target.value)} placeholder="例:S001 / kiwi"
               onKeyDown={(e) => e.key === "Enter" && saveMe()}
               style={inp} />
        <button onClick={saveMe} style={btn("#5b9bd5")}>設定</button>
        {me && <span style={{ color: "#37d67a", fontWeight: 600 }}>目前:{me}</span>}
        {msg && <span className="hint" style={{ margin: 0, color: "#5b9bd5" }}>· {msg}</span>}
      </div>

      {/* 任務進度 */}
      <h3 style={{ marginTop: 20, display: "flex", alignItems: "center", gap: 10 }}>
        你的任務進度
        <span style={{ fontSize: 13, color: allDone ? "#37d67a" : "var(--muted)", fontWeight: 600 }}>
          {doneN} / {steps.length} {allDone ? "· 全部完成,你已是合格的園區維運工程師 🏅" : ""}
        </span>
      </h3>
      <div style={{ height: 8, background: "#0f1620", border: "1px solid var(--line)", borderRadius: 6, overflow: "hidden", marginBottom: 12 }}>
        <div style={{ width: `${(doneN / steps.length) * 100}%`, height: "100%",
                      background: allDone ? "#37d67a" : "linear-gradient(90deg,#5b9bd5,#37d67a)", transition: "width .4s" }} />
      </div>
      <ol style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 8 }}>
        {steps.map((s, i) => (
          <li key={i} style={{ display: "flex", gap: 12, alignItems: "flex-start",
                               border: `1px solid ${s.done ? "#2f7a4f" : "var(--line)"}`, borderRadius: 8,
                               padding: "10px 12px", background: s.done ? "#13241b" : "var(--panel)" }}>
            <div style={{ width: 26, height: 26, flex: "0 0 26px", borderRadius: 26, fontWeight: 700,
                          display: "flex", alignItems: "center", justifyContent: "center",
                          background: s.done ? "#37d67a" : "#2a3648", color: s.done ? "#08121e" : "#8a93a6" }}>
              {s.done ? "✓" : i + 1}
            </div>
            <div>
              <div style={{ fontWeight: 600, color: s.done ? "#9be7bd" : "#e6ecf5" }}>{s.title}</div>
              <div className="hint" style={{ margin: "2px 0 0" }}>{s.desc}</div>
            </div>
          </li>
        ))}
      </ol>

      {/* 認領(未認領時內嵌,不必跳頁) */}
      {me && !myCompany && (
        <div style={card}>
          <div style={cardTitle}>① 先認領一間公司</div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <select value={claimPick} onChange={(e) => setClaimPick(e.target.value)} style={inp}>
              <option value="">選一間未認領的公司…</option>
              {unclaimed.map((c) => (
                <option key={c.id} value={c.id}>{c.name}（{c.device_ids?.length ?? 0} 台）</option>
              ))}
            </select>
            <button onClick={() => claim(claimPick)} style={btn("#37d67a")}>認領</button>
            <span className="hint" style={{ margin: 0 }}>或到「學生面」分頁看每間公司狀態再挑。</span>
          </div>
        </div>
      )}

      {/* 連線包 */}
      {myCompany && kit && (
        <div style={card}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
            <div style={cardTitle}>🔌 你的連線包 —— {myCompany.name} / <code>{kit.deviceId}</code></div>
            {liveVal !== undefined && (
              <div style={{ fontSize: 13 }}>
                <span className="hint" style={{ margin: 0 }}>此刻園區實值 </span>
                <b style={{ color: "#37d67a" }}>{kit.tag} = {liveVal.toFixed(2)} {kit.tagUnit}</b>
                <span className="hint" style={{ margin: 0 }}> ← 你的程式讀到的應該接近這個</span>
              </div>
            )}
          </div>

          <div style={{ display: "flex", gap: 14, flexWrap: "wrap", margin: "10px 0" }}>
            <Fact label="主機 host" value={kit.host} />
            <Fact label="Modbus 埠" value={String(kit.port)} />
            <Fact label="unit_id" value={String(kit.unit)} />
            <Fact label={`${kit.tag} register`} value={`${kit.reg}(${kit.datatype})`} />
          </div>

          <div style={{ display: "flex", gap: 6, margin: "4px 0 8px", flexWrap: "wrap" }}>
            <button onClick={() => setKitMode("read")} style={toggleBtn(kitMode === "read")}>① 讀一個值(入門)</button>
            <button onClick={() => setKitMode("monitor")} style={toggleBtn(kitMode === "monitor")}>② 監控多訊號 + 門檻告警</button>
          </div>
          <div style={{ position: "relative" }}>
            <button onClick={() => copy(kitMode === "read" ? kit.python : kit.pythonMonitor, "python")}
                    style={{ ...btn("#5b9bd5"), position: "absolute", right: 8, top: 8, zIndex: 1 }}>
              {copied === "python" ? "已複製 ✓" : "複製 Python"}
            </button>
            <pre style={pre}>{kitMode === "read" ? kit.python : kit.pythonMonitor}</pre>
          </div>

          <div style={{ display: "grid", gap: 8, marginTop: 10 }}>
            <CopyLine label="OPC-UA" text={kit.opcua} onCopy={() => copy(kit.opcua, "opcua")} copied={copied === "opcua"} />
            <CopyLine label="MQTT" text={kit.mqtt} onCopy={() => copy(kit.mqtt, "mqtt")} copied={copied === "mqtt"} />
          </div>

          <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 12, flexWrap: "wrap" }}>
            <button onClick={markConnected} disabled={connected} style={btn(connected ? "#2f7a4f" : "#37d67a")}>
              {connected ? "✓ 已標記連上" : "我讀到數值了 → 完成任務 ③"}
            </button>
            <span className="hint" style={{ margin: 0 }}>
              存成 <code>{kitMode === "read" ? "read.py" : "monitor.py"}</code> 直接 <code>python</code> 跑,每秒印一次。
              {kitMode === "read" ? "讀通了就切到 ② 練監控 + 告警。" : "門檻先觀察正常區間再自己調,別照抄。"}完整規格見「設備目錄」。
            </span>
          </div>
        </div>
      )}

      {/* 我的設備現況:認領後立刻看到自己的設備在即時呼吸 */}
      {myCompany && (
        <>
          <h3 style={{ marginTop: 22, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            我的設備現況 · {myCompany.name}
            <span className="hint" style={{ margin: 0, fontWeight: 400 }}>綠=運轉 · 灰=待機 · 黃=警告 · 紅=故障</span>
          </h3>
          {myFaulted.length > 0 && (
            <div style={{ margin: "0 0 10px", padding: "10px 14px", borderRadius: 8, background: "#2a1518",
                          border: "1px solid #6b2f34", color: "#ffb4b4", display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              ⚠ 你有 {myFaulted.length} 台設備故障（{myFaulted.join("、")}）——
              到「學生面」ack 確認並 resolve 處置,完成任務 ④。
              <button onClick={() => onNav("student")} style={btn("#e24c4c", "#fff")}>去處置工單</button>
            </div>
          )}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(200px,1fr))", gap: 10 }}>
            {(myCompany.device_ids || []).map((did) => (
              <DeviceCard key={did} id={did} snap={telemetry?.devices[did]} />
            ))}
          </div>
        </>
      )}

      {/* 階段二:訓練模型 → 在故障前送預測 */}
      {myCompany && (
        <>
          <h3 style={{ marginTop: 22 }}>🔮 階段二 · 在故障前送出預測</h3>
          {stage2 ? (
            <div style={card}>
              <div style={cardTitle}>
                預測目標 <code>{stage2.deviceId}</code> · 盯招牌指標 <b>{stage2.sig}</b>(門檻起始 {stage2.threshold})
              </div>
              <p className="hint" style={{ margin: "0 0 8px" }}>
                訂閱(輪詢)遙測 → 在設備真正故障<b>之前</b> <code>POST /api/predictions</code> → 命中就上預測榜、按 lead time(提前量)給分。
                下面是可跑的啟發式骨架;把門檻換成你用 Historian 歷史訓練的 <b>RUL / 故障機率模型</b>,提前量更長、分數更高。
              </p>
              <div style={{ position: "relative" }}>
                <button onClick={() => copy(stage2.python, "stage2")}
                        style={{ ...btn("#f08c2e"), position: "absolute", right: 8, top: 8, zIndex: 1 }}>
                  {copied === "stage2" ? "已複製 ✓" : "複製 Python"}
                </button>
                <pre style={pre}>{stage2.python}</pre>
              </div>
              <span className="hint" style={{ margin: 0 }}>
                存成 <code>predict.py</code> 直接跑;命中會在 2D 世界看到設備翻橘、事件列出現 🔮 預測命中。歷史資料:<code>/api/history</code> 或直接連 DB。
              </span>
            </div>
          ) : (
            <p className="hint">
              你認領的公司以分析 / 動力節點為主(不會故障),不適合當階段二預測目標。
              到「學生面」認領一間有明顯退化的機台公司(CNC / 空壓機 / 機械手臂 / 半導體腔體),這裡就會長出你的預測器範例。
            </p>
          )}
        </>
      )}

      {/* 導覽 */}
      <h3 style={{ marginTop: 22 }}>接下來去哪</h3>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(230px,1fr))", gap: 10 }}>
        <NavCard emoji="🗺️" title="2D 世界" desc="俯瞰園區、點公司進廠內、看設備即時燈號與數值。" onClick={() => onNav("world")} />
        <NavCard emoji="📖" title="設備目錄" desc="每台設備每個點位的協定規格書 —— 你的接線圖。" onClick={() => onNav("catalog")} />
        <NavCard emoji="🎫" title="學生面(工單 / 榜)" desc="認領、處置工單、看故障管理 / 預測 / OEE 競賽榜。" onClick={() => onNav("student")} />
        <NavCard emoji="📡" title="戰情版" desc="三協定連線自測,對照你自己工具讀到的值。" onClick={() => onNav("diag")} />
        <NavCard emoji="📊" title="OEE 榜" desc="設備總效率排名:可用率 × 表現 × 良率。" onClick={() => onNav("oee")} />
      </div>

      {allDone && (
        <div style={{ marginTop: 18, padding: "14px 18px", borderRadius: 10, background: "#13241b",
                      border: "1px solid #2f7a4f", color: "#9be7bd", fontWeight: 600 }}>
          🏅 五項任務全數完成!你已跑通「連線 → 監控 → 偵測 → 處置 → 預測」完整維運迴圈。
          接下來就是把偵測做得更早、預測 lead time 拉更長 —— 上競賽榜卡位吧。
        </div>
      )}
    </div>
  );
}

// ── 連線包產生器 ───────────────────────────────────────────────
interface Kit {
  deviceId: string; host: string; port: number; unit: number;
  tag: string; reg: number; datatype: string; tagUnit: string;
  python: string; pythonMonitor: string; opcua: string; mqtt: string;
}

// 招牌指標的「起始門檻建議」——只給有單一明顯退化指標的 tag;其餘留 None 讓學生自訂。
const FAULT_HINT_THRESH: Record<string, number> = {
  vibration_rms: 6.0, particle_count: 30.0, vacuum_pump_current: 12.0,
  spindle_current: 12.0, motor_current: 30.0,
  spindle_temp: 90.0, motor_temp: 85.0, oil_temp: 75.0, pump_temp: 80.0,
};

function dedupeBy<T>(arr: T[], key: (t: T) => string): T[] {
  const seen = new Set<string>();
  return arr.filter((x) => { const k = key(x); if (seen.has(k)) return false; seen.add(k); return true; });
}

// 招牌指標 → 預測時填的故障標籤(僅顯示 / 記錄用,命中與否只看設備真的有沒有壞)。
const FAULT_LABEL: Record<string, string> = {
  vibration_rms: "bearing_fault", particle_count: "process_drift",
  vacuum_pump_current: "vacuum_pump_wear", spindle_current: "spindle_fault",
  motor_current: "motor_fault", spindle_temp: "overheat", motor_temp: "overheat",
  oil_temp: "overheat", pump_temp: "overheat",
};

interface Stage2 {
  deviceId: string; sig: string; reg: number; threshold: number;
  port: number; unit: number; python: string;
}

// 階段二預測器:挑認領公司裡「會故障、可預測」的設備(招牌指標在 FAULT_HINT_THRESH),
// 產出可跑的 Modbus 輪詢 → 在故障前 POST /api/predictions 範例。電表等純分析節點不會被選中。
function buildStage2(company: Company | null, catalog: Catalog | null, host: string, student: string): Stage2 | null {
  if (!company || !catalog) return null;
  for (const did of company.device_ids || []) {
    const dev = catalog.devices.find((d) => d.id === did);
    if (!dev) continue;
    const sig = SIGNATURE_PREF.map((n) => dev.tags.find((t) => t.name === n)).find(Boolean);
    if (!sig || !(sig.name in FAULT_HINT_THRESH)) continue;   // 沒有明顯退化指標 → 不適合當階段二目標
    const conn = dev.connection?.modbus || {};
    const port = conn.port ?? 6020;
    const unit = conn.unit_id ?? 1;
    const reg = sig.modbus_register;
    const threshold = FAULT_HINT_THRESH[sig.name];
    const who = student || "你的學號";
    const fault = FAULT_LABEL[sig.name] || "degradation_fault";
    const python = `# ${company.name} · ${did} · 階段二:在故障前送出預測
# pip install pymodbus==3.6.9   |   python predict.py
from pymodbus.client import ModbusTcpClient
from pymodbus.constants import Endian
from pymodbus.payload import BinaryPayloadDecoder
import urllib.request, json, time

API = "http://${host}:8077"
STUDENT = "${who}"
DEVICE, HOST, PORT, UNIT = "${did}", "${host}", ${port}, ${unit}
SIGNAL, REG, THRESHOLD = "${sig.name}", ${reg}, ${threshold}   # 招牌指標超門檻就預測(先用啟發式,再換成你訓練的模型)

def post_prediction(eta_h, conf):
    body = {"device": DEVICE, "student": STUDENT, "predicted_fault": "${fault}",
            "eta_sim_s": eta_h * 3600, "confidence": conf}
    req = urllib.request.Request(API + "/api/predictions", data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req) as r:
        return json.load(r)

cli = ModbusTcpClient(HOST, port=PORT); cli.connect()
sent = False
print(f"[{STUDENT}] 盯 {DEVICE}.{SIGNAL},超過 {THRESHOLD} 就在故障前送預測 …")
while not sent:
    rr = cli.read_holding_registers(address=REG, count=2, slave=UNIT)
    if not rr.isError():
        v = BinaryPayloadDecoder.fromRegisters(rr.registers, byteorder=Endian.BIG, wordorder=Endian.BIG).decode_32bit_float()
        print(f"{SIGNAL} = {v:.2f}")
        if v > THRESHOLD:                       # ← 換成你的模型輸出(RUL / 故障機率)會更準、lead time 更長
            print("→ 送出預測:", post_prediction(eta_h=2, conf=0.8)); sent = True
    time.sleep(2)
cli.close()
`;
    return { deviceId: did, sig: sig.name, reg, threshold, port, unit, python };
  }
  return null;
}

function buildKit(company: Company | null, catalog: Catalog | null, host: string): Kit | null {
  if (!company || !catalog) return null;
  const devId = company.device_ids?.[0];
  const dev: CatalogDevice | undefined = catalog.devices.find((d) => d.id === devId);
  if (!dev) return null;

  const conn = dev.connection?.modbus || {};
  const port = conn.port ?? catalog.devices[0]?.connection?.modbus?.port ?? 6020;
  const unit = conn.unit_id ?? 1;

  // 招牌 tag:偏好退化主指標,否則第一個 float32,否則第一個 tag。
  const floatTags = dev.tags.filter((t) => t.datatype === "float32");
  const sig = SIGNATURE_PREF.map((n) => dev.tags.find((t) => t.name === n)).find(Boolean)
    || floatTags[0] || dev.tags[0];
  const reg = sig.modbus_register;
  const dtype = sig.datatype;
  const width = dtype === "int16" ? 1 : 2;
  const decode = dtype === "int16" ? "decode_16bit_int()" : dtype === "int32" ? "decode_32bit_int()" : "decode_32bit_float()";

  const folder = dev.connection?.opcua?.node_folder ?? `${company.id}/${devId}`;
  const opcuaEp = dev.connection?.opcua?.endpoint ?? `opc.tcp://${host}:6041/clouddata/`;
  const mqttPort = dev.connection?.mqtt?.port ?? 6083;

  const python = `# ${company.name} · ${devId} · 讀 ${sig.name}(${sig.unit || "—"})
# 需求:pip install pymodbus==3.6.9   |   直接執行:python read.py
from pymodbus.client import ModbusTcpClient
from pymodbus.constants import Endian
from pymodbus.payload import BinaryPayloadDecoder
import time

HOST, PORT, UNIT = "${host}", ${port}, ${unit}
client = ModbusTcpClient(HOST, port=PORT)
client.connect()

while True:
    rr = client.read_holding_registers(address=${reg}, count=${width}, slave=UNIT)
    if rr.isError():
        print("讀取失敗,檢查 host/port/unit 與防火牆"); break
    dec = BinaryPayloadDecoder.fromRegisters(rr.registers, byteorder=Endian.BIG, wordorder=Endian.BIG)
    ${sig.name} = dec.${decode}
    print(f"${sig.name} = {${sig.name}:.3f} ${sig.unit || ""}")
    time.sleep(1)
`;

  const opcua = `${opcuaEp}  →  Objects/${folder}/${sig.name}（Security: None/None）`;
  const mqtt = `mosquitto_sub -h ${host} -p ${mqttPort} -t "park/${company.id}/${devId}/state" -v`;

  // ── 進階片段:多訊號監控 + 門檻告警(步驟 ③→④ monitor→detect)──────
  const monPref = [
    sig.name, "vibration_rms", "particle_count", "vacuum_pump_current", "spindle_current",
    "motor_current", "spindle_temp", "motor_temp", "oil_temp", "pump_temp",
    "chamber_pressure", "power_factor", "active_power", "battery_soc", "tool_wear",
  ];
  const monTags = dedupeBy(
    monPref.map((n) => dev.tags.find((t) => t.name === n)).filter(Boolean) as typeof dev.tags,
    (t) => t.name,
  ).slice(0, 4);
  const monLines = monTags.map((t) => `    "${t.name}": (${t.modbus_register}, "${t.datatype}"),`).join("\n");
  const hasThresh = sig.name in FAULT_HINT_THRESH;
  const alarmLevel = hasThresh ? String(FAULT_HINT_THRESH[sig.name]) : "None";
  const alarmComment = hasThresh
    ? `超過視為異常(門檻是起始建議,依你觀察到的正常區間自己調)`
    : `這台沒有單一明顯門檻;先把多訊號一起畫出來觀察趨勢,再自訂 ALARM_LEVEL`;

  const pythonMonitor = `# ${company.name} · ${devId} · 多訊號監控 + 門檻告警
# pip install pymodbus==3.6.9   |   python monitor.py
from pymodbus.client import ModbusTcpClient
from pymodbus.constants import Endian
from pymodbus.payload import BinaryPayloadDecoder
import time

HOST, PORT, UNIT = "${host}", ${port}, ${unit}
# tag -> (起始 register, 型別)   來源:設備目錄 /api/catalog
TAGS = {
${monLines}
}
ALARM_TAG, ALARM_LEVEL = "${sig.name}", ${alarmLevel}   # ${alarmComment}

def read(cli, reg, dtype):
    w = 1 if dtype == "int16" else 2
    rr = cli.read_holding_registers(address=reg, count=w, slave=UNIT)
    if rr.isError():
        return None
    d = BinaryPayloadDecoder.fromRegisters(rr.registers, byteorder=Endian.BIG, wordorder=Endian.BIG)
    return d.decode_16bit_int() if dtype == "int16" else d.decode_32bit_int() if dtype == "int32" else d.decode_32bit_float()

cli = ModbusTcpClient(HOST, port=PORT); cli.connect()
while True:
    vals = {n: read(cli, r, t) for n, (r, t) in TAGS.items()}
    v = vals.get(ALARM_TAG)
    hot = ALARM_LEVEL is not None and v is not None and v > ALARM_LEVEL
    line = "  ".join(f"{n}={x:.2f}" if isinstance(x, float) else f"{n}={x}" for n, x in vals.items())
    print(line + ("   ⚠ 異常！考慮開工單" if hot else ""))
    time.sleep(1)
`;

  return { deviceId: devId, host, port, unit, tag: sig.name, reg, datatype: dtype, tagUnit: sig.unit || "", python, pythonMonitor, opcua, mqtt };
}

// ── 小組件 / 樣式 ──────────────────────────────────────────────
interface Step { done: boolean; title: string; desc: string; }

// 我的設備小卡:狀態燈 + 招牌訊號值(最多 3 個),認領後立刻有生命力。
function DeviceCard({ id, snap }: { id: string; snap?: DeviceSnapshot }) {
  const state = snap?.state ?? "—";
  const col = STATUS_COLOR_CSS[state] ?? "#8a93a6";
  const tags = snap?.tags ?? {};
  const headline = SIGNATURE_PREF.filter((n) => n in tags).slice(0, 3);
  const shown = headline.length ? headline : Object.keys(tags).slice(0, 3);
  return (
    <div style={{ border: `1px solid ${state === "fault" ? "#6b2f34" : "var(--line)"}`, borderRadius: 8,
                  padding: "10px 12px", background: state === "fault" ? "#1e1416" : "var(--panel)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6 }}>
        <b style={{ fontFamily: "monospace" }}>{id}</b>
        <span className="badge" style={{ background: col }}>{state}</span>
      </div>
      <div style={{ marginTop: 6, display: "grid", gap: 2 }}>
        {snap ? shown.map((k) => (
          <div key={k} style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}>
            <span style={{ color: "var(--muted)" }}>{k}</span>
            <span style={{ fontVariantNumeric: "tabular-nums" }}>{typeof tags[k] === "number" ? tags[k].toFixed(2) : String(tags[k])}</span>
          </div>
        )) : <span className="hint" style={{ margin: 0 }}>等待遙測…</span>}
      </div>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ background: "#0f1620", border: "1px solid var(--line)", borderRadius: 8, padding: "6px 12px" }}>
      <div className="hint" style={{ margin: 0, fontSize: 11 }}>{label}</div>
      <div style={{ fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{value}</div>
    </div>
  );
}

function CopyLine({ label, text, onCopy, copied }: { label: string; text: string; onCopy: () => void; copied: boolean }) {
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
      <span style={{ width: 60, flex: "0 0 60px", color: "var(--muted)", fontSize: 12 }}>{label}</span>
      <code style={{ flex: 1, background: "var(--panel2)", padding: "5px 8px", borderRadius: 6, overflowX: "auto", whiteSpace: "nowrap" }}>{text}</code>
      <button onClick={onCopy} style={btn("#2a3648", "#c7d2e0")}>{copied ? "✓" : "複製"}</button>
    </div>
  );
}

function NavCard({ emoji, title, desc, onClick }: { emoji: string; title: string; desc: string; onClick: () => void }) {
  return (
    <button onClick={onClick} style={{ textAlign: "left", cursor: "pointer", background: "var(--panel)",
             border: "1px solid var(--line)", borderRadius: 10, padding: "12px 14px", color: "var(--text)" }}
            onMouseEnter={(e) => (e.currentTarget.style.borderColor = "#5b9bd5")}
            onMouseLeave={(e) => (e.currentTarget.style.borderColor = "var(--line)")}>
      <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 4 }}>{emoji} {title}</div>
      <div className="hint" style={{ margin: 0 }}>{desc}</div>
    </button>
  );
}

const inp: React.CSSProperties = {
  background: "#0f1620", color: "#e6ecf5", border: "1px solid #2e3a4d", borderRadius: 6, padding: "6px 10px", minWidth: 180,
};
const card: React.CSSProperties = {
  marginTop: 14, border: "1px solid var(--line)", borderRadius: 10, padding: "14px 16px", background: "var(--panel)",
};
const cardTitle: React.CSSProperties = { fontWeight: 700, color: "#c7d2e0", marginBottom: 8 };
const pre: React.CSSProperties = {
  background: "#0b1017", border: "1px solid var(--line)", borderRadius: 8, padding: "12px 14px",
  overflowX: "auto", fontSize: 12.5, lineHeight: 1.55, margin: 0,
  fontFamily: "'Cascadia Code','Consolas',monospace", color: "#d7e0ec",
};

function btn(bg: string, color = "#08121e"): React.CSSProperties {
  return { background: bg, color, border: "none", borderRadius: 6, padding: "6px 14px", cursor: "pointer", fontWeight: 600, fontSize: 13 };
}

function toggleBtn(active: boolean): React.CSSProperties {
  return {
    background: active ? "#5b9bd5" : "var(--panel2)", color: active ? "#08121e" : "var(--text)",
    border: `1px solid ${active ? "#5b9bd5" : "var(--line)"}`, borderRadius: 6, padding: "5px 12px",
    cursor: "pointer", fontWeight: 600, fontSize: 12.5,
  };
}
