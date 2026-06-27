// 與後端世界溝通:REST 取目錄 / 園區,WebSocket 收即時遙測與事件。
// 一律用相對路徑(/api、/ws),開發走 Vite proxy、正式同源(見 vite.config.ts)。

export interface MapPos { x: number; y: number; }
export interface Company {
  id: string; name: string; industry: string;
  owner: string | null; map_pos: MapPos; device_ids: string[];
}
export interface Park {
  name: string; protocol_mode: string;
  ports: Record<string, number>; companies: Company[];
}

export interface DeviceSnapshot {
  id: string; template: string; state: string;
  state_code: number; tags: Record<string, number>;
}
export interface TelemetryMsg {
  wall_t: number; sim_t: number; multiplier: number;
  devices: Record<string, DeviceSnapshot>;
}
export interface EventMsg {
  type: string; device: string; company?: string;
  from?: string; to?: string; component?: string;
  fault_type?: string; sim_t: number;
}

export interface CatalogTag {
  name: string; unit: string; datatype: string;
  modbus_register: number; opcua_node: string; mqtt_field: string;
}
export interface CatalogDevice {
  id: string; template: string; company_id: string;
  protocols: Record<string, any>;
  tags: CatalogTag[];
  connection: Record<string, any>;
}
export interface Catalog {
  park: string; protocol_mode: string; synthetic: boolean;
  devices: CatalogDevice[]; hint: string;
}

export async function getJSON<T>(path: string): Promise<T> {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`${path} -> ${r.status}`);
  return r.json();
}

export const getPark = () => getJSON<Park>("/api/park");
export const getCatalog = () => getJSON<Catalog>("/api/catalog");

// 設定模擬時鐘(倍率 / 暫停)
export async function setClock(body: { multiplier?: number; paused?: boolean }) {
  await fetch("/api/sim/clock", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// 自動重連的 WebSocket 訂閱;回傳 close 函式。
export function subscribe<T>(path: string, onMessage: (msg: T) => void): () => void {
  let ws: WebSocket | null = null;
  let closed = false;
  let timer: number | undefined;

  const proto = location.protocol === "https:" ? "wss" : "ws";
  const url = `${proto}://${location.host}${path}`;

  const open = () => {
    ws = new WebSocket(url);
    ws.onmessage = (e) => {
      try { onMessage(JSON.parse(e.data)); } catch { /* 忽略壞封包 */ }
    };
    ws.onclose = () => {
      if (!closed) timer = window.setTimeout(open, 1000); // 斷線 1 秒後重連
    };
    ws.onerror = () => ws?.close();
  };
  open();

  return () => {
    closed = true;
    if (timer) clearTimeout(timer);
    ws?.close();
  };
}

// ── 狀態 → 顏色 / 嚴重度(2D 世界燈號)──────────────────
// 綠=正常 / 黃=警告 / 橘=預測故障(P3) / 紅=故障 / 灰=停機
export const STATUS_COLOR: Record<string, number> = {
  running: 0x37d67a, moving: 0x37d67a,
  idle: 0x8a93a6, charging: 0x5b9bd5, maintenance: 0x8a93a6,
  alarm: 0xf2c037, tool_change: 0xf2c037, blocked: 0xf2c037,
  fault: 0xe24c4c, predicted_fault: 0xf08c2e,
};
export const STATUS_COLOR_CSS: Record<string, string> = {
  running: "#37d67a", moving: "#37d67a",
  idle: "#8a93a6", charging: "#5b9bd5", maintenance: "#8a93a6",
  alarm: "#f2c037", tool_change: "#f2c037", blocked: "#f2c037",
  fault: "#e24c4c", predicted_fault: "#f08c2e",
};
const SEVERITY: Record<string, number> = {
  fault: 5, predicted_fault: 4, alarm: 3, tool_change: 3, blocked: 3,
  running: 2, moving: 2, charging: 1, idle: 1, maintenance: 1,
};

export function worstState(states: string[]): string {
  let worst = "idle", sev = -1;
  for (const s of states) {
    const v = SEVERITY[s] ?? 0;
    if (v > sev) { sev = v; worst = s; }
  }
  return worst;
}

export function colorOf(state: string): number {
  return STATUS_COLOR[state] ?? 0x8a93a6;
}
