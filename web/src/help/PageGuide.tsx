import { useState } from "react";

// 每頁的情境式說明:一進到某頁就知道「這頁要做什麼、三步驟」。可收合(記在 localStorage),
// 收合後縮成一顆「❔ 這頁怎麼用」小鈕,想看再展開。協助學生快速上手。
export default function PageGuide({ id, title, steps, note }: {
  id: string; title: string; steps: React.ReactNode[]; note?: React.ReactNode;
}) {
  const key = "guide_" + id;
  const [open, setOpen] = useState(() => localStorage.getItem(key) !== "closed");
  const set = (o: boolean) => { setOpen(o); localStorage.setItem(key, o ? "open" : "closed"); };

  if (!open) return (
    <button className="btn ghost" onClick={() => set(true)}
      style={{ fontSize: 12, padding: "5px 12px", marginBottom: 12 }}>❔ 這頁怎麼用</button>
  );
  return (
    <div className="card" style={{ background: "var(--accent-tint)", border: "1px solid #e6d3ad", padding: "12px 16px", marginBottom: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontFamily: "var(--font-serif)", fontWeight: 700, color: "var(--accent)", fontSize: 14 }}>💡 {title}</span>
        <span style={{ flex: 1 }} />
        <button className="btn ghost" onClick={() => set(false)} style={{ fontSize: 11.5, padding: "3px 10px" }}>收合 ✕</button>
      </div>
      <ol style={{ margin: "9px 0 0", padding: 0, listStyle: "none", display: "grid", gap: 7 }}>
        {steps.map((s, i) => (
          <li key={i} style={{ display: "flex", gap: 9, fontSize: 13, color: "var(--text-2)", lineHeight: 1.55 }}>
            <span style={{ flex: "0 0 20px", height: 20, borderRadius: 10, background: "var(--accent)", color: "#fffaf0",
              fontSize: 11, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", marginTop: 1 }}>{i + 1}</span>
            <span>{s}</span>
          </li>
        ))}
      </ol>
      {note && <div className="muted" style={{ fontSize: 11.5, marginTop: 9 }}>{note}</div>}
    </div>
  );
}
