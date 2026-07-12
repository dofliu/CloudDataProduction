import { useState } from "react";
import { Session, login, loginWithToken } from "../api";

/**
 * 登入頁 —— 啟用身分驗證後的進站關卡。
 * 學生用教師發的帳密登入;教師 / 管理員可用 token 進入(bootstrap,用來建立學生帳號)。
 */
export default function LoginView({ parkName, onAuthed }: { parkName: string; onAuthed: (s: Session) => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [token, setToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const doLogin = async () => {
    setErr(""); setBusy(true);
    try { onAuthed(await login(username.trim(), password)); }
    catch (e: any) { setErr(String(e.message).includes("401") ? "帳號或密碼錯誤" : `登入失敗:${e.message}`); }
    finally { setBusy(false); }
  };
  const doToken = async () => {
    setErr(""); setBusy(true);
    try { onAuthed(await loginWithToken(token.trim())); }
    catch { setErr("token 無效(需與伺服器 TEACHER_TOKEN 相符)"); }
    finally { setBusy(false); }
  };

  return (
    <div style={{ position: "fixed", inset: 0, display: "flex", alignItems: "center", justifyContent: "center",
                  background: "radial-gradient(1200px 600px at 50% -10%, #f4e6d2 0%, var(--bg) 60%)", padding: 20 }}>
      <div className="card float" style={{ width: "min(400px, 100%)", padding: "26px 26px 22px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
          <div className="logo" style={{ width: 30, height: 30, borderRadius: 8, background: "var(--accent-grad)",
                display: "flex", alignItems: "center", justifyContent: "center", color: "#fffaf0", fontWeight: 700 }}>勤</div>
          <div style={{ fontSize: 18, fontWeight: 700 }}>{parkName || "智慧工業區"}</div>
        </div>
        <p className="hint" style={{ margin: "0 0 16px" }}>用老師發給你的帳號密碼登入。</p>

        <div style={{ display: "grid", gap: 10 }}>
          <input className="inp" placeholder="學號 / 帳號" value={username}
                 onChange={(e) => setUsername(e.target.value)} onKeyDown={(e) => e.key === "Enter" && doLogin()} />
          <input className="inp" placeholder="密碼" type="password" value={password}
                 onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => e.key === "Enter" && doLogin()} />
          <button className="btn primary" onClick={doLogin} disabled={busy || !username || !password}>
            {busy ? "登入中…" : "登入"}
          </button>
        </div>

        {err && <div style={{ marginTop: 12, color: "var(--fault)", fontSize: 12.5 }}>{err}</div>}

        <div style={{ marginTop: 16, borderTop: "1px solid var(--line)", paddingTop: 12 }}>
          <button className="btn ghost" style={{ padding: "5px 11px", fontSize: 12 }} onClick={() => setShowToken((v) => !v)}>
            {showToken ? "▾" : "▸"} 老師 / 管理員以 token 進入
          </button>
          {showToken && (
            <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
              <input className="inp" placeholder="TEACHER_TOKEN" value={token}
                     onChange={(e) => setToken(e.target.value)} onKeyDown={(e) => e.key === "Enter" && doToken()} style={{ flex: 1 }} />
              <button className="btn" style={{ background: "var(--warn)", color: "#fffaf0" }} onClick={doToken} disabled={busy || !token}>進入</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
