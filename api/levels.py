"""資料的一生 —— 九關與全班進度看板(scenarios/levels.yaml)。

## 為什麼要關卡

60 人、無助教,最難的不是批改(那已經自動了),是**看不到誰卡住**。作業是一次一次交的,
交了幾份、卡在哪一步,老師要自己拼。九關把「資料的一生」這條課程主軸變成一條可見的進度線,
教師面一張 64×9 的格子牆就知道「12 個人卡在 OPC-UA」。

## 為什麼不另創遊戲劇情

課程主軸已經是「產生 → 接取 → 串流 → 儲存 → 統計 → 視覺化 → KPI → 預警 → 報告」。
另外發明一套關卡故事只會跟課程打架、還多一份東西要維護。這裡的九關就是那九個階段,
過關條件就是課程本來就要交的東西 —— 關卡是外殼,不是新作業。

## 誠實性

通關判定**不接受學生自己說「我做完了」**。一律查平台手上的事實:

  - `submission`:對 ground-truth 容差計分的作業有一筆 passed(api/submissions.py)。
  - `claim` / `tickets` / `maintenance` / `alarm` / `prediction`:查各自的 store。
  - `access`:協定端真實存取軌跡(但拿不到身分,見 adapters/access_log.py 的限制說明)。
  - `manual`:本質要人看的(儀表板 demo、期末報告),教師勾 —— 誠實地標成人工。

鐵則一:本類只存「教師勾了哪幾格」;其他全部現查,不快取任何進度狀態。
"""
from __future__ import annotations

import time
from pathlib import Path
from typing import Callable, Dict, List, Optional

import yaml


class LevelManager:
    def __init__(self, world, submissions, tickets, maintenance, alarm_rules, predictions,
                 access_log=None, roster: Optional[Callable[[], List[str]]] = None,
                 path: str = "scenarios/levels.yaml", persist=None):
        self.world = world
        self.submissions = submissions
        self.tickets = tickets
        self.maintenance = maintenance
        self.alarm_rules = alarm_rules
        self.predictions = predictions
        self.access_log = access_log
        self._roster = roster
        self.persist = persist
        self.levels: List[dict] = []
        self.badges: List[dict] = []
        self.manual: Dict[str, dict] = {}     # f"{student}:{level_id}" → {by, wall_t}
        self._load(path)
        if persist is not None:
            self.manual = (persist.load("levels") or {}).get("manual", {}) or {}

    def _load(self, path: str) -> None:
        try:
            data = yaml.safe_load(Path(path).read_text(encoding="utf-8")) or {}
        except Exception as exc:
            print(f"[levels] 讀不到關卡定義({path}),關卡系統停用:{exc}")
            data = {}
        self.levels = data.get("levels", []) or []
        self.badges = data.get("badges", []) or []

    def _save(self) -> None:
        if self.persist is not None:
            self.persist.save("levels", {"manual": self.manual})

    def clear(self) -> int:
        n = len(self.manual)
        self.manual = {}
        self._save()
        return n

    # ── 判定 ───────────────────────────────────────────────
    def _student_devices(self, student: str) -> List[str]:
        out: List[str] = []
        for c in self.world.park.get("companies", []):
            if c.get("owner") == student:
                out.extend(c.get("device_ids") or [])
        return out

    def _check(self, student: str, spec: dict) -> dict:
        """回傳 {done, evidence}。evidence 是給學生看的一句話,說明「你現在到哪」。"""
        kind = (spec or {}).get("kind", "manual")

        if kind == "any" or kind == "all":
            subs = [self._check(student, s) for s in (spec.get("of") or [])]
            done = any(s["done"] for s in subs) if kind == "any" else all(s["done"] for s in subs)
            joiner = " 或 " if kind == "any" else " 且 "
            return {"done": done, "evidence": joiner.join(s["evidence"] for s in subs)}

        if kind == "claim":
            n = len(self._student_devices(student))
            return {"done": n > 0, "evidence": f"已認領設備 {n} 台" if n else "還沒認領公司"}

        if kind == "submission":
            stype = spec.get("type")
            min_score = float(spec.get("min_score", 0))
            rows = [r for r in self.submissions.list(student=student, type=stype)
                    if r.get("passed") and r.get("score", 0) >= min_score]
            best = max((r.get("score", 0) for r in rows), default=None)
            return {"done": bool(rows),
                    "evidence": f"{stype} 作業已通過(最佳 {best:.0f} 分)" if rows
                                else f"還沒有通過的 {stype} 作業"}

        if kind == "access":
            if self.access_log is None:
                return {"done": False, "evidence": "未啟用協定存取軌跡"}
            need = int(spec.get("min_reads", 50))
            total = sum(self.access_log.reads(d, spec.get("protocol")) for d in self._student_devices(student))
            return {"done": total >= need,
                    "evidence": f"你的設備被協定讀取 {total} 次(需 {need} 次)"}

        if kind == "tickets":
            mine = [t for t in self.tickets.tickets.values() if t.get("owner") == student]
            resolved = [t for t in mine if t.get("status") == "resolved"]
            wrong = sum(t.get("wrong_attempts", 0) for t in mine)
            ok = (len(resolved) >= int(spec.get("min_resolved", 1))
                  and wrong <= int(spec.get("max_wrong", 10 ** 9)))
            return {"done": ok, "evidence": f"結案 {len(resolved)} 張、誤修 {wrong} 次"}

        if kind == "maintenance":
            rows = [r for r in self.maintenance.log
                    if r.get("actor") == student and r.get("effective")]
            need = int(spec.get("min_effective", 1))
            return {"done": len(rows) >= need,
                    "evidence": f"有效保養 {len(rows)} 次(需 {need} 次)"}

        if kind == "alarm":
            row = next((r for r in self.alarm_rules.scores()["ranking"]
                        if r["student"] == student), None)
            if row is None:
                return {"done": False, "evidence": "還沒託管告警規則"}
            ok = (row["f1"] >= float(spec.get("min_f1", 0))
                  and row["hits"] >= int(spec.get("min_hits", 0))
                  and row["false_alarms"] <= int(spec.get("max_false_alarms", 10 ** 9)))
            return {"done": ok,
                    "evidence": f"告警 F1 {row['f1']}、命中 {row['hits']}、誤報 {row['false_alarms']}"}

        if kind == "prediction":
            row = next((r for r in self.predictions.scores()["ranking"]
                        if r["student"] == student), None)
            hits = row["hits"] if row else 0
            need = int(spec.get("min_hits", 1))
            return {"done": hits >= need, "evidence": f"預測命中 {hits} 次(需 {need} 次)"}

        if kind == "manual":
            m = self.manual.get(f"{student}:{spec.get('_level_id', '')}")
            return {"done": bool(m),
                    "evidence": f"教師已認可({m.get('by')})" if m else "等待教師課堂認可"}

        return {"done": False, "evidence": f"未知的判定方式:{kind}"}

    def _eval_items(self, student: str, items: List[dict]) -> List[dict]:
        out = []
        for it in items:
            spec = dict(it.get("check") or {})
            spec["_level_id"] = it.get("id")           # manual 判定要知道是哪一關
            res = self._check(student, spec)
            out.append({
                "id": it.get("id"), "name": it.get("name"), "title": it.get("title"),
                "week": it.get("week"), "hint": it.get("hint"),
                "manual": (spec.get("kind") == "manual"),
                "done": res["done"], "evidence": res["evidence"],
            })
        return out

    # ── 對外視圖 ───────────────────────────────────────────
    def status(self, student: str) -> dict:
        levels = self._eval_items(student, self.levels)
        badges = self._eval_items(student, self.badges)
        done = sum(1 for l in levels if l["done"])
        # 「下一關」= 第一個沒過的,學生面直接把 hint 頂出來,不用自己找
        nxt = next((l for l in levels if not l["done"]), None)
        access = []
        if self.access_log is not None:
            for d in self._student_devices(student):
                rows = self.access_log.view(d)["rows"]
                access.extend(rows)
        return {
            "student": student, "levels": levels, "badges": badges,
            "done": done, "total": len(levels), "next": nxt,
            "access": access,
        }

    def roster(self) -> List[str]:
        """全班名單:帳號(教師傳入)+ 有認領公司的 + 交過作業的,去重排序。"""
        names = set(self._roster() if self._roster else [])
        for c in self.world.park.get("companies", []):
            if c.get("owner"):
                names.add(c["owner"])
        for r in self.submissions.list():
            if r.get("student"):
                names.add(r["student"])
        return sorted(names)

    def board(self) -> dict:
        """全班 N×9 進度矩陣(教師面)。每關順便附上卡關人數,一眼看到瓶頸在哪。"""
        students = self.roster()
        rows = [self.status(s) for s in students]
        cols = []
        for i, lv in enumerate(self.levels):
            done = sum(1 for r in rows if r["levels"][i]["done"])
            cols.append({"id": lv.get("id"), "name": lv.get("name"), "week": lv.get("week"),
                         "manual": (lv.get("check") or {}).get("kind") == "manual",
                         "done": done, "stuck": len(rows) - done})
        # 瓶頸 = 前一關過了、這一關沒過的人最多的那一關(不是「沒過的人最多」——
        # 那永遠是最後一關。真正卡住的是「已經走到門口卻進不去」的人。)
        bottleneck = None
        best = -1
        for i, lv in enumerate(self.levels):
            at_door = sum(1 for r in rows
                          if not r["levels"][i]["done"] and (i == 0 or r["levels"][i - 1]["done"]))
            if at_door > best:
                best, bottleneck = at_door, {"id": lv.get("id"), "name": lv.get("name"), "count": at_door}
        return {"students": rows, "levels": cols, "bottleneck": bottleneck,
                "count": len(rows), "synthetic": True}

    # ── 教師勾選(manual 關) ────────────────────────────────
    def mark(self, student: str, level_id: str, done: bool, by: str = "teacher") -> dict:
        item = next((l for l in self.levels + self.badges if l.get("id") == level_id), None)
        if item is None:
            return {"ok": False, "error": f"無此關卡:{level_id}"}
        if (item.get("check") or {}).get("kind") != "manual":
            return {"ok": False, "error": f"{level_id} 是自動判定的關卡,不能手動勾"}
        key = f"{student}:{level_id}"
        if done:
            self.manual[key] = {"by": by, "wall_t": round(time.time(), 1)}
        else:
            self.manual.pop(key, None)
        self._save()
        return {"ok": True, "student": student, "level": level_id, "done": done}
