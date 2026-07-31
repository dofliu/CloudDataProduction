import { useEffect, useState } from "react";
import { Company, SupplyLinkView, getCompanySupply } from "../api";

/**
 * 我的上下游(學生面)。
 *
 * 這是全班第一次感覺到彼此存在的地方:你的進料來自某位同學的廠,你的產出是另一位的原料。
 * 上游停機沒人管 → 你餓料;你停太久 → 下游倉滿,反過來把你卡住。
 *
 * 刻意把「自給率」露出來:進料有多少比例真的來自上游同學、多少是外部備援買的。
 * 長期靠外購撐著,就是單一供應商風險的量化版。
 */
export default function SupplyPanel({ me, companies }: { me: string; companies: Company[] }) {
  const mine = companies.find((c) => c.owner === me && !!me);
  const [inbound, setIn] = useState<SupplyLinkView[]>([]);
  const [outbound, setOut] = useState<SupplyLinkView[]>([]);

  useEffect(() => {
    if (!mine) { setIn([]); setOut([]); return; }
    const load = () => getCompanySupply(mine.id)
      .then((r) => { setIn(r.inbound); setOut(r.outbound); })
      .catch(() => {});
    load();
    const id = setInterval(load, 6000);
    return () => clearInterval(id);
  }, [mine?.id]);

  if (!mine || (!inbound.length && !outbound.length)) return null;
  const nameOf = (cid: string) => companies.find((c) => c.id === cid)?.name ?? cid;
  const ownerOf = (cid: string) => companies.find((c) => c.id === cid)?.owner;

  return (
    <div className="card" style={{ padding: "12px 14px", marginTop: 22 }}>
      <div className="card-title" style={{ fontSize: 13.5 }}>🔗 我的上下游</div>
      <p className="hint" style={{ marginTop: 0 }}>
        你的進料來自上游同學的廠,你的產出是下游同學的原料。
        <b>上游停機沒人管,你就餓料停機</b>;你自己停太久,下游倉會塞爆反過來卡住你。
      </p>

      {inbound.map((l) => (
        <Row key={`in-${l.from}`} l={l} dir="in" name={nameOf(l.from)} owner={ownerOf(l.from)} />
      ))}
      {outbound.map((l) => (
        <Row key={`out-${l.to}`} l={l} dir="out" name={nameOf(l.to)} owner={ownerOf(l.to)} />
      ))}
    </div>
  );
}

function Row({ l, dir, name, owner }: {
  l: SupplyLinkView; dir: "in" | "out"; name: string; owner?: string | null;
}) {
  const pct = Math.min(100, Math.round((l.stock / Math.max(1, l.cap)) * 100));
  const bad = dir === "in" ? l.starving : l.blocking;
  const label = dir === "in"
    ? (l.starving ? "缺料中 —— 你的產線在等他出貨" : "進料正常")
    : (l.blocking ? "他的倉滿了 —— 你的出貨端被卡住" : "出貨正常");

  return (
    <div style={{ padding: "8px 0", borderTop: "1px solid var(--line-3)" }}>
      <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
        <span style={{ fontSize: 12.5, fontWeight: 700 }}>
          {dir === "in" ? "⬅ 上游" : "➡ 下游"} {name}
        </span>
        {owner && <span className="mono muted" style={{ fontSize: 11 }}>({owner})</span>}
        <span className="pill" style={{ fontSize: 11 }}>{l.part}</span>
        <span style={{ flex: 1 }} />
        <span className="mono" style={{ fontSize: 11.5, color: bad ? "var(--fault)" : "var(--ok)" }}>
          {bad ? "● " : "○ "}{label}
        </span>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 5 }}>
        <div style={{ flex: 1, height: 9, borderRadius: 5, background: "var(--panel-3)", overflow: "hidden" }}>
          <div style={{ height: "100%", width: `${pct}%`, transition: "width .3s",
                        background: l.starving ? "var(--fault)" : l.blocking ? "var(--warn)" : "var(--ok)" }} />
        </div>
        <span className="mono" style={{ fontSize: 11.5, width: 62, textAlign: "right" }}>{l.stock}/{l.cap}</span>
      </div>

      <div className="mono muted" style={{ fontSize: 11, marginTop: 4 }}>
        上游供 {l.delivered} · 外購 {l.purchased} · 已用 {l.consumed}
        {l.self_sufficiency != null && ` · 自給率 ${Math.round(l.self_sufficiency * 100)}%`}
        {l.starved_h > 0 && ` · 累計缺料 ${l.starved_h}h`}
        {l.blocked_h > 0 && ` · 累計阻塞 ${l.blocked_h}h`}
        {!l.external_backup_h && <span style={{ color: "var(--warn)" }}> · 無外部備援(上游一停就真的停)</span>}
      </div>
    </div>
  );
}
