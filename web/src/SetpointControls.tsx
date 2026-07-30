/**
 * 設定點寫入控件(學生面):世界側欄與設備詳情彈窗共用,不要兩邊各寫一份。
 *
 * - 一般設定點:數字輸入 + 範圍 / 暫存器說明,走 POST /setpoint(後端夾限)。
 * - CNC 刻字:偵測到 engrave_char_1 就把 8 格 ASCII 收成一個文字輸入,
 *   走 POST /engrave_text 一次寫整串(僅轉寫 setpoints,狀態仍只在引擎)。
 */
import { useState } from "react";
import { CatalogSetpoint, setEngraveText, setSetpoint } from "./api";
import { ENGRAVE_MAX_CHARS, engraveText } from "./world/deviceMotion";

/** 整組設定點(含刻字文字收合)。values = snapshot.setpoints 的即時值。 */
export function SetpointList({ deviceId, setpoints, values, onMsg }: {
  deviceId: string; setpoints: CatalogSetpoint[]; values: Record<string, number>; onMsg: (m: string) => void;
}) {
  return (
    <>
      {setpoints.some((sp) => sp.name === "engrave_char_1") && (
        <EngraveTextControl deviceId={deviceId} current={engraveText(values)} onMsg={onMsg} />
      )}
      {setpoints.filter((sp) => !sp.name.startsWith("engrave_char_")).map((sp) => (
        <SetpointControl key={sp.name} deviceId={deviceId} sp={sp}
                         value={values[sp.name] ?? sp.default} onMsg={onMsg} />
      ))}
    </>
  );
}

// 設定點寫入控制(學生面,公開免 token):輸入新值 → 寫入,後端夾限;顯示目前即時值。
export function SetpointControl({ deviceId, sp, value, onMsg }: {
  deviceId: string; sp: CatalogSetpoint; value: number; onMsg: (m: string) => void;
}) {
  const [v, setV] = useState(String(value));
  const write = async () => {
    const num = parseFloat(v);
    if (Number.isNaN(num)) { onMsg("請輸入數字"); return; }
    try {
      const r = await setSetpoint(deviceId, sp.name, num);
      onMsg(`已寫 ${sp.name}=${r.value}${sp.unit}${r.clamped ? `(超範圍,夾限到 ${sp.min}~${sp.max})` : ""}`);
    } catch (e: any) { onMsg(`寫入失敗:${e.message}`); }
  };
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, margin: "2px 0", flexWrap: "wrap" }}>
      <span style={{ fontSize: 12, color: "var(--text-2)", minWidth: 116, fontFamily: "var(--font-mono)" }}>{sp.name}</span>
      <span className="muted mono" style={{ fontSize: 12 }}>{value.toFixed(1)}{sp.unit}</span>
      <input className="inp mono" value={v} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => e.key === "Enter" && write()}
             style={{ width: 62, padding: "4px 7px" }} />
      <button className="btn primary" style={{ padding: "4px 11px" }} onClick={write}>寫入</button>
      <span className="muted" style={{ fontSize: 10.5, width: "100%" }}>範圍 {sp.min}~{sp.max} {sp.unit} · Modbus FC06 寫 reg {sp.register}(raw = 值 × {sp.scale})</span>
    </div>
  );
}

// CNC 刻字文字輸入:呼叫 /engrave_text 一次寫進 engrave_char_1..8(pattern 0 生效)。
export function EngraveTextControl({ deviceId, current, onMsg }: {
  deviceId: string; current: string; onMsg: (m: string) => void;
}) {
  const [v, setV] = useState(current);
  const write = async () => {
    const text = v.toUpperCase().trim();
    if (!/^[A-Z0-9 -]*$/.test(text)) { onMsg("僅支援 A–Z、0–9、空白、-"); return; }
    if (text.length > ENGRAVE_MAX_CHARS) { onMsg(`最多 ${ENGRAVE_MAX_CHARS} 個字`); return; }
    try {
      const r = await setEngraveText(deviceId, text);
      onMsg(`已寫刻字文字「${r.text || "(空白)"}」(machining_pattern=0 時生效)`);
    } catch (e: any) { onMsg(`寫入失敗:${e.message}`); }
  };
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, margin: "2px 0", flexWrap: "wrap" }}>
      <span style={{ fontSize: 12, color: "var(--text-2)", minWidth: 116, fontFamily: "var(--font-mono)" }}>engrave_text</span>
      <span className="muted mono" style={{ fontSize: 12 }}>{current || "(空白)"}</span>
      <input className="inp mono" value={v} maxLength={ENGRAVE_MAX_CHARS} placeholder="NCUT"
             onChange={(e) => setV(e.target.value.toUpperCase())} onKeyDown={(e) => e.key === "Enter" && write()}
             style={{ width: 96, padding: "4px 7px" }} />
      <button className="btn primary" style={{ padding: "4px 11px" }} onClick={write}>寫入</button>
      <span className="muted" style={{ fontSize: 10.5, width: "100%" }}>
        pattern 0 刻這串字(A–Z / 0–9 / - / 空白,≤{ENGRAVE_MAX_CHARS} 字)· 等同逐格 FC06 寫 reg 102..109 的 ASCII 碼
      </span>
    </div>
  );
}
