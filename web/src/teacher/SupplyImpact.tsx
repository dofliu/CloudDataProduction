import { useEffect, useState } from "react";
import { SupplyLinkView, SupplyImpactRow, getSupply } from "../api";

/**
 * 供應鏈連鎖反應(教師面):現在誰在等誰、誰卡住誰。
 *
 * 這張表回答的是「今天全班為什麼產出掉了」——通常不是每個人各自出事,
 * 而是某一間停了,後面整條鏈跟著停。上課時直接投影出來,因果一目了然。
 */
export default function SupplyImpact() {
  const [links, setLinks] = useState<SupplyLinkView[]>([]);
  const [impact, setImpact] = useState<SupplyImpactRow[]>([]);

  useEffect(() => {
    const load = () => getSupply().then((r) => { setLinks(r.links); setImpact(r.impact); }).catch(() => {});
    load();
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, []);

  if (!links.length) return null;
  const starving = impact.filter((i) => i.kind === "starving");
  const blocking = impact.filter((i) => i.kind === "blocking");
  // 靠外購撐著的關係:自給率低 = 那位同學的上游長期不出貨(單一供應商風險的量化版)
  const external = links.filter((l) => l.self_sufficiency != null && l.self_sufficiency < 0.9)
    .sort((a, b) => (a.self_sufficiency ?? 1) - (b.self_sufficiency ?? 1));

  return (
    <div className="card" style={{ padding: "12px 14px" }}>
      <div className="card-title">🔗 供應鏈連鎖反應({links.length} 條供應關係)</div>
      <div className="hint" style={{ margin: "0 0 8px" }}>
        全班產出掉下來通常不是每個人各自出事,而是<b>某一間停了,後面整條鏈跟著停</b>。
        餓料與阻塞都不罰可用率(不是設備的錯),它們降的是產出。
      </div>

      <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginBottom: 8 }}>
        <Stat label="正在餓料" n={starving.length} color="var(--fault)" />
        <Stat label="正在阻塞" n={blocking.length} color="var(--warn)" />
        <Stat label="靠外購撐著" n={external.length} color="var(--pred)" />
      </div>

      {impact.length === 0 ? (
        <div className="muted" style={{ fontSize: 12 }}>目前沒有斷鏈,全班進料都跟得上。</div>
      ) : (
        <div style={{ display: "grid", gap: 3 }}>
          {impact.slice(0, 12).map((r, i) => (
            <div key={i} style={{ fontSize: 11.5, color: "var(--text-2)" }}>
              <span style={{ color: r.kind === "starving" ? "var(--fault)" : "var(--warn)" }}>
                {r.kind === "starving" ? "餓料" : "阻塞"}
              </span>{" "}
              <span className="mono">{r.from} → {r.to}</span>
              <span className="muted"> · {r.detail}</span>
            </div>
          ))}
          {impact.length > 12 && <div className="muted" style={{ fontSize: 11 }}>…另有 {impact.length - 12} 條</div>}
        </div>
      )}

      {external.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <div className="mono" style={{ fontSize: 11, color: "var(--dim)", marginBottom: 3 }}>
            自給率最低(長期靠外部備援補料 —— 上游那位同學該關心了)
          </div>
          {external.slice(0, 5).map((l) => (
            <div key={`${l.from}-${l.to}`} className="mono" style={{ fontSize: 11.5, color: "var(--text-2)" }}>
              {l.from} → {l.to}:自給率 {Math.round((l.self_sufficiency ?? 0) * 100)}%
              <span className="muted">(供 {l.delivered} / 外購 {l.purchased})</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Stat({ label, n, color }: { label: string; n: number; color: string }) {
  return (
    <div>
      <div className="mono" style={{ fontSize: 20, fontWeight: 800, color: n > 0 ? color : "var(--dim)" }}>{n}</div>
      <div className="muted" style={{ fontSize: 11 }}>{label}</div>
    </div>
  );
}
