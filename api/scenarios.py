"""情境腳本引擎(docs/05 §進階教學、docs/07 P4)。

預寫的連鎖故障腳本(如災難日),當期末實作測驗 —— 全班同條件、同時間軸。
腳本步驟依 **sim 時間** 排程執行(對 sim_clock,故加速 / 暫停都正確)。
步驟動作沿用既有機制:注入故障 / 感測器故障 / 調時鐘。
"""
from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Awaitable, Callable, Optional

import yaml

from engine.world import World

SCRIPTS_DIR = Path("scenarios/scripts")


class ScenarioManager:
    def __init__(self, world: World):
        self.world = world
        self._task: Optional[asyncio.Task] = None
        self._running_name: Optional[str] = None
        self._log: list[dict] = []
        self._emit: Optional[Callable[[dict], Awaitable[None]]] = None

    def set_emitter(self, emit: Callable[[dict], Awaitable[None]]) -> None:
        self._emit = emit

    async def _broadcast(self, message: str) -> None:
        entry = {"type": "scenario", "message": message, "sim_t": self.world.clock.now()}
        self._log.insert(0, entry)
        self._log = self._log[:30]
        if self._emit is not None:
            await self._emit(entry)

    # ── 列出 / 狀態 ────────────────────────────────────────
    def list_scripts(self) -> list[dict]:
        out = []
        if SCRIPTS_DIR.exists():
            for f in sorted(SCRIPTS_DIR.glob("*.yaml")):
                try:
                    data = yaml.safe_load(f.read_text(encoding="utf-8")) or {}
                    out.append({"name": data.get("name", f.stem),
                                "description": data.get("description", ""),
                                "steps": len(data.get("steps", []))})
                except Exception:
                    continue
        return out

    def status(self) -> dict:
        running = self._running_name if (self._task and not self._task.done()) else None
        return {"running": running, "log": self._log}

    # ── 執行 ──────────────────────────────────────────────
    async def run(self, name: str) -> dict:
        if self._task and not self._task.done():
            raise RuntimeError(f"已有情境在執行:{self._running_name}")
        path = SCRIPTS_DIR / f"{name}.yaml"
        if not path.exists():
            raise FileNotFoundError(name)
        script = yaml.safe_load(path.read_text(encoding="utf-8"))
        self._task = asyncio.create_task(self._run_script(script))
        return {"started": script.get("name", name), "steps": len(script.get("steps", []))}

    def stop(self) -> None:
        if self._task and not self._task.done():
            self._task.cancel()
        self._running_name = None

    async def _run_script(self, script: dict) -> None:
        self._running_name = script.get("name", "scenario")
        self._log = []
        start = self.world.clock.now()
        steps = sorted(script.get("steps", []), key=lambda s: s.get("at_sim_s", 0))
        await self._broadcast(f"情境開始:{self._running_name}")
        try:
            for step in steps:
                target = start + float(step.get("at_sim_s", 0))
                while self.world.clock.now() < target:    # 等 sim 時間到(加速/暫停都正確)
                    await asyncio.sleep(0.1)
                await self._execute(step)
            await self._broadcast(f"情境結束:{self._running_name}")
        except asyncio.CancelledError:
            await self._broadcast(f"情境中止:{self._running_name}")
        finally:
            self._running_name = None

    async def _execute(self, step: dict) -> None:
        action = step.get("action")
        p = step.get("params", {}) or {}
        if action == "inject_fault":
            dev = self.world.devices.get(p.get("device"))
            if dev is not None:
                dev.inject_fault(p.get("fault_type", "gradual"), p.get("target"),
                                 p.get("severity", 1.0), p.get("onset_sim_s"),
                                 **{k: v for k, v in p.items()
                                    if k not in ("device", "fault_type", "target", "severity", "onset_sim_s")})
                await self._broadcast(f"注入 {p.get('fault_type')} → {p.get('device')}.{p.get('target')}")
        elif action == "set_clock":
            if "multiplier" in p:
                self.world.clock.set_multiplier(p["multiplier"])
            if "paused" in p:
                self.world.clock.set_paused(p["paused"])
            await self._broadcast(f"調時鐘 {p}")
        elif action == "reset":
            dev = self.world.devices.get(p.get("device"))
            if dev is not None:
                dev.reset()
                await self._broadcast(f"reset {p.get('device')}")
        elif action == "message":
            await self._broadcast(p.get("text", ""))
