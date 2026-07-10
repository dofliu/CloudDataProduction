"""帳號 / 登入 / 角色 —— 教學平台的身分層。

- 密碼用標準庫 PBKDF2-HMAC-SHA256 + 隨機 salt 雜湊(不存明文、不加外部相依)。
- 登入發不透明 session token;帳號與 session 皆持久化到 StateStore(進程重啟免重登)。
- 角色:student / teacher。教師由控制台批次建立學生帳號(名冊制)。
- 現有 shared teacher_token 保留為「管理員 bootstrap」:第一次還沒有教師帳號時,
  可用它進教師面建帳號(見 api/rest.py 的 current_user / require_teacher)。
"""
from __future__ import annotations

import hashlib
import secrets
import time
from typing import Dict, List, Optional

PBKDF2_ROUNDS = 120_000


def _hash(password: str, salt: str) -> str:
    return hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), bytes.fromhex(salt), PBKDF2_ROUNDS).hex()


class AuthStore:
    def __init__(self, persist=None):
        self.persist = persist
        self.users: Dict[str, dict] = {}      # username → {role, salt, hash, created}
        self.sessions: Dict[str, str] = {}    # token → username
        if persist is not None:
            self.users = persist.load("users", {}) or {}
            self.sessions = persist.load("sessions", {}) or {}

    def _save(self) -> None:
        if self.persist is not None:
            self.persist.save("users", self.users)
            self.persist.save("sessions", self.sessions)

    def has_users(self) -> bool:
        return len(self.users) > 0

    # ── 帳號管理(教師面)────────────────────────────────────
    def create_user(self, username: str, password: str, role: str = "student", overwrite: bool = False) -> dict:
        username = (username or "").strip()
        if not username:
            raise ValueError("帳號不可空白")
        if not password:
            raise ValueError("密碼不可空白")
        if role not in ("student", "teacher"):
            raise ValueError("角色需為 student / teacher")
        if username in self.users and not overwrite:
            raise ValueError(f"帳號已存在:{username}")
        salt = secrets.token_hex(16)
        self.users[username] = {"role": role, "salt": salt, "hash": _hash(password, salt), "created": time.time()}
        self._save()
        return {"username": username, "role": role}

    def bulk_create(self, users: List[dict], default_role: str = "student") -> dict:
        created, skipped = [], []
        for u in users or []:
            un = (u.get("username") or "").strip()
            pw = u.get("password") or ""
            try:
                self.create_user(un, pw, u.get("role") or default_role)
                created.append(un)
            except ValueError:
                skipped.append(un or "(空白)")
        return {"created": created, "skipped": skipped}

    def set_password(self, username: str, password: str) -> dict:
        if username not in self.users:
            raise ValueError(f"查無帳號:{username}")
        if not password:
            raise ValueError("密碼不可空白")
        salt = secrets.token_hex(16)
        self.users[username]["salt"] = salt
        self.users[username]["hash"] = _hash(password, salt)
        self._save()
        return {"username": username, "password_reset": True}

    def delete_user(self, username: str) -> bool:
        if username not in self.users:
            return False
        del self.users[username]
        self.sessions = {t: u for t, u in self.sessions.items() if u != username}  # 撤銷其 session
        self._save()
        return True

    def list_users(self) -> List[dict]:
        return [{"username": u, "role": d["role"], "created": d.get("created")}
                for u, d in sorted(self.users.items())]

    # ── 登入 / session ──────────────────────────────────────
    def verify(self, username: str, password: str) -> bool:
        u = self.users.get((username or "").strip())
        if not u:
            return False
        return secrets.compare_digest(_hash(password, u["salt"]), u["hash"])

    def login(self, username: str, password: str) -> Optional[dict]:
        username = (username or "").strip()
        if not self.verify(username, password):
            return None
        token = secrets.token_urlsafe(24)
        self.sessions[token] = username
        self._save()
        return {"token": token, "username": username, "role": self.users[username]["role"]}

    def logout(self, token: Optional[str]) -> None:
        if token and token in self.sessions:
            del self.sessions[token]
            self._save()

    def user_for_token(self, token: Optional[str]) -> Optional[dict]:
        un = self.sessions.get(token or "")
        if not un or un not in self.users:
            return None
        return {"username": un, "role": self.users[un]["role"]}
