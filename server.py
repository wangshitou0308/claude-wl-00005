#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
漂移法赤道仪校准推演台 —— 本地服务端

仅依赖 Python 标准库：http.server + sqlite3。
提供：
  - web/ 目录下的静态页面（原生 HTML/CSS/JS/SVG）
  - 校准会话 / 轮次 / 测段 / 打点 的 REST 接口
  - 单会话 JSON 导出、整库 JSON 导入

启动：
  python3 server.py [--host 127.0.0.1] [--port 8000] [--db driftalign.db]
"""

import argparse
import json
import os
import sqlite3
import threading
import time
import uuid
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
WEB_DIR = os.path.join(BASE_DIR, "web")

SCHEMA = """
CREATE TABLE IF NOT EXISTS sessions (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    settings    TEXT NOT NULL DEFAULT '{}',
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS rounds (
    id            TEXT PRIMARY KEY,
    session_id    TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    seq           INTEGER NOT NULL,
    note          TEXT NOT NULL DEFAULT '',
    adjustment    TEXT NOT NULL DEFAULT '{}',
    created_at    INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS segments (
    id          TEXT PRIMARY KEY,
    round_id    TEXT NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
    kind        TEXT NOT NULL CHECK (kind IN ('meridian','east_low','west_low')),
    locked      INTEGER NOT NULL DEFAULT 0,
    note        TEXT NOT NULL DEFAULT '',
    created_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS points (
    id          TEXT PRIMARY KEY,
    segment_id  TEXT NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
    t           INTEGER NOT NULL,          -- 毫秒时间戳
    tick        REAL NOT NULL,             -- 刻度位置（格 / 像素）
    direction   INTEGER NOT NULL DEFAULT 1,-- +1: 刻度增大方向越过, -1: 反向
    excluded    INTEGER NOT NULL DEFAULT 0,
    note        TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_rounds_session ON rounds(session_id);
CREATE INDEX IF NOT EXISTS idx_segments_round ON segments(round_id);
CREATE INDEX IF NOT EXISTS idx_points_segment ON points(segment_id);
"""

_db_lock = threading.Lock()


def get_db(path):
    conn = sqlite3.connect(path, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.executescript(SCHEMA)
    return conn


# ---------------------------------------------------------------- 序列化

def session_bundle(conn, sid):
    """导出单个会话的完整数据（含全部轮次/测段/打点）。"""
    s = conn.execute("SELECT * FROM sessions WHERE id=?", (sid,)).fetchone()
    if s is None:
        return None
    bundle = {
        "id": s["id"],
        "name": s["name"],
        "settings": json.loads(s["settings"]),
        "created_at": s["created_at"],
        "updated_at": s["updated_at"],
        "rounds": [],
    }
    rounds = conn.execute(
        "SELECT * FROM rounds WHERE session_id=? ORDER BY seq, created_at", (sid,)
    ).fetchall()
    for r in rounds:
        rd = {
            "id": r["id"],
            "seq": r["seq"],
            "note": r["note"],
            "adjustment": json.loads(r["adjustment"]),
            "created_at": r["created_at"],
            "segments": [],
        }
        segs = conn.execute(
            "SELECT * FROM segments WHERE round_id=? ORDER BY created_at", (r["id"],)
        ).fetchall()
        for g in segs:
            gd = {
                "id": g["id"],
                "kind": g["kind"],
                "locked": bool(g["locked"]),
                "note": g["note"],
                "created_at": g["created_at"],
                "points": [],
            }
            pts = conn.execute(
                "SELECT * FROM points WHERE segment_id=? ORDER BY t", (g["id"],)
            ).fetchall()
            for p in pts:
                gd["points"].append({
                    "id": p["id"],
                    "t": p["t"],
                    "tick": p["tick"],
                    "direction": p["direction"],
                    "excluded": bool(p["excluded"]),
                    "note": p["note"],
                })
            rd["segments"].append(gd)
        bundle["rounds"].append(rd)
    return bundle


def next_seq(conn, sid):
    row = conn.execute(
        "SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM rounds WHERE session_id=?", (sid,)
    ).fetchone()
    return row["n"]


def import_bundle(conn, bundle, keep_ids=False):
    """导入一个会话 bundle；默认重新分配全部 id，避免主键冲突。"""
    now = int(time.time() * 1000)
    sid = bundle.get("id") if keep_ids else uuid.uuid4().hex
    if not sid:
        sid = uuid.uuid4().hex
    conn.execute(
        "INSERT INTO sessions(id, name, settings, created_at, updated_at) VALUES(?,?,?,?,?)",
        (sid, bundle.get("name", "导入的会话"),
         json.dumps(bundle.get("settings", {}), ensure_ascii=False),
         bundle.get("created_at", now), now),
    )
    idmap_rounds, idmap_segments = {}, {}
    for r in bundle.get("rounds", []):
        rid = r["id"] if keep_ids else uuid.uuid4().hex
        idmap_rounds[r.get("id")] = rid
        conn.execute(
            "INSERT INTO rounds(id, session_id, seq, note, adjustment, created_at) "
            "VALUES(?,?,?,?,?,?)",
            (rid, sid, int(r.get("seq", 1)), r.get("note", ""),
             json.dumps(r.get("adjustment", {}), ensure_ascii=False),
             r.get("created_at", now)),
        )
        for g in r.get("segments", []):
            gid = g["id"] if keep_ids else uuid.uuid4().hex
            idmap_segments[g.get("id")] = gid
            conn.execute(
                "INSERT INTO segments(id, round_id, kind, locked, note, created_at) "
                "VALUES(?,?,?,?,?,?)",
                (gid, rid, g["kind"], 1 if g.get("locked") else 0,
                 g.get("note", ""), g.get("created_at", now)),
            )
            for p in g.get("points", []):
                pid = p["id"] if keep_ids else uuid.uuid4().hex
                conn.execute(
                    "INSERT INTO points(id, segment_id, t, tick, direction, excluded, note) "
                    "VALUES(?,?,?,?,?,?,?)",
                    (pid, gid, int(p["t"]), float(p["tick"]),
                     int(p.get("direction", 1)),
                     1 if p.get("excluded") else 0, p.get("note", "")),
                )
    return sid


# ---------------------------------------------------------------- HTTP

class Handler(BaseHTTPRequestHandler):
    server_version = "DriftAlign/1.0"

    def log_message(self, fmt, *args):
        # 本机工具，保持安静；出错时由各处理函数自行说明
        pass

    # ---- 工具 ----
    def _json(self, obj, status=HTTPStatus.OK):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _error(self, status, message):
        self._json({"error": message}, status)

    def _read_json(self):
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n) if n else b"{}"
        try:
            return json.loads(raw.decode("utf-8"))
        except Exception:
            raise ValueError("请求体不是合法 JSON")

    def _sid(self):
        parts = [p for p in urlparse(self.path).path.split("/") if p]
        return parts[2] if len(parts) >= 3 and parts[1] == "sessions" else None

    # ---- 静态文件 ----
    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        if path.startswith("/api/"):
            return self.api_get(path)
        if path == "/":
            path = "/index.html"
        return self.serve_static(path)

    def serve_static(self, url_path):
        # 防目录穿越
        rel = os.path.normpath(url_path.lstrip("/"))
        if rel.startswith("..") or os.path.isabs(rel):
            return self._error(HTTPStatus.FORBIDDEN, "禁止访问")
        full = os.path.join(WEB_DIR, rel)
        if not os.path.isfile(full):
            return self._error(HTTPStatus.NOT_FOUND, "文件不存在")
        ctype = {
            ".html": "text/html; charset=utf-8",
            ".css": "text/css; charset=utf-8",
            ".js": "application/javascript; charset=utf-8",
            ".svg": "image/svg+xml",
            ".json": "application/json; charset=utf-8",
        }.get(os.path.splitext(full)[1], "application/octet-stream")
        with open(full, "rb") as f:
            body = f.read()
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    # ---- GET 接口 ----
    def api_get(self, path):
        conn = self.server.db
        with _db_lock:
            try:
                if path == "/api/sessions":
                    rows = conn.execute(
                        "SELECT s.*, "
                        "(SELECT COUNT(*) FROM rounds r WHERE r.session_id=s.id) AS n_rounds "
                        "FROM sessions s ORDER BY updated_at DESC"
                    ).fetchall()
                    return self._json([{
                        "id": r["id"], "name": r["name"],
                        "settings": json.loads(r["settings"]),
                        "created_at": r["created_at"],
                        "updated_at": r["updated_at"],
                        "n_rounds": r["n_rounds"],
                    } for r in rows])

                parts = [p for p in path.split("/") if p]
                # /api/sessions/<sid>
                if len(parts) == 3 and parts[1] == "sessions":
                    b = session_bundle(conn, parts[2])
                    return self._json(b) if b else self._error(404, "会话不存在")
                # /api/sessions/<sid>/export
                if len(parts) == 4 and parts[1] == "sessions" and parts[3] == "export":
                    b = session_bundle(conn, parts[2])
                    if not b:
                        return self._error(404, "会话不存在")
                    b["__export_format__"] = "drift-align-station/v1"
                    return self._json(b)
                return self._error(404, "未知接口")
            except Exception as e:  # noqa: BLE001
                return self._error(500, f"服务器错误: {e}")

    # ---- POST ----
    def do_POST(self):
        path = urlparse(self.path).path
        if not path.startswith("/api/"):
            return self._error(404, "未知接口")
        parts = [p for p in path.split("/") if p]
        try:
            data = self._read_json()
        except ValueError as e:
            return self._error(400, str(e))
        conn = self.server.db
        with _db_lock:
            try:
                now = int(time.time() * 1000)

                if path == "/api/sessions":
                    sid = uuid.uuid4().hex
                    conn.execute(
                        "INSERT INTO sessions(id,name,settings,created_at,updated_at) "
                        "VALUES(?,?,?,?,?)",
                        (sid, (data.get("name") or "未命名校准会话")[:80],
                         json.dumps(data.get("settings", {}), ensure_ascii=False),
                         now, now),
                    )
                    conn.commit()
                    return self._json(session_bundle(conn, sid), 201)

                # /api/sessions/<sid>/rounds
                if len(parts) == 4 and parts[1] == "sessions" and parts[3] == "rounds":
                    sid = parts[2]
                    if not conn.execute("SELECT 1 FROM sessions WHERE id=?", (sid,)).fetchone():
                        return self._error(404, "会话不存在")
                    seq = data.get("seq") or next_seq(conn, sid)
                    rid = uuid.uuid4().hex
                    conn.execute(
                        "INSERT INTO rounds(id,session_id,seq,note,adjustment,created_at) "
                        "VALUES(?,?,?,?,?,?)",
                        (rid, sid, int(seq), str(data.get("note", "")),
                         json.dumps(data.get("adjustment", {}), ensure_ascii=False), now),
                    )
                    conn.execute("UPDATE sessions SET updated_at=? WHERE id=?", (now, sid))
                    conn.commit()
                    return self._json({"id": rid, "seq": int(seq)}, 201)

                # /api/rounds/<rid>/segments
                if len(parts) == 4 and parts[1] == "rounds" and parts[3] == "segments":
                    rid = parts[2]
                    r = conn.execute("SELECT * FROM rounds WHERE id=?", (rid,)).fetchone()
                    if not r:
                        return self._error(404, "轮次不存在")
                    kind = data.get("kind")
                    if kind not in ("meridian", "east_low", "west_low"):
                        return self._error(400, "kind 必须是 meridian / east_low / west_low")
                    gid = uuid.uuid4().hex
                    conn.execute(
                        "INSERT INTO segments(id,round_id,kind,locked,note,created_at) "
                        "VALUES(?,?,?,?,?,?)",
                        (gid, rid, kind, 1 if data.get("locked") else 0,
                         str(data.get("note", "")), now),
                    )
                    conn.execute("UPDATE sessions SET updated_at=? WHERE id=?",
                                 (now, r["session_id"]))
                    conn.commit()
                    return self._json({"id": gid}, 201)

                # /api/segments/<gid>/points
                if len(parts) == 4 and parts[1] == "segments" and parts[3] == "points":
                    gid = parts[2]
                    g = conn.execute("SELECT * FROM segments WHERE id=?", (gid,)).fetchone()
                    if not g:
                        return self._error(404, "测段不存在")
                    if "t" not in data or "tick" not in data:
                        return self._error(400, "需要 t(毫秒) 与 tick(刻度)")
                    pid = uuid.uuid4().hex
                    conn.execute(
                        "INSERT INTO points(id,segment_id,t,tick,direction,excluded,note) "
                        "VALUES(?,?,?,?,?,?,?)",
                        (pid, gid, int(data["t"]), float(data["tick"]),
                         1 if int(data.get("direction", 1)) >= 0 else -1,
                         1 if data.get("excluded") else 0, str(data.get("note", ""))),
                    )
                    r = conn.execute("SELECT session_id FROM rounds WHERE id=?",
                                     (g["round_id"],)).fetchone()
                    conn.execute("UPDATE sessions SET updated_at=? WHERE id=?",
                                 (now, r["session_id"]))
                    conn.commit()
                    return self._json({"id": pid}, 201)

                # /api/import  —— 单会话或 {sessions:[...]}
                if path == "/api/import":
                    bundles = data.get("sessions") if isinstance(data, dict) else None
                    if bundles is None:
                        bundles = [data]
                    ids = []
                    for b in bundles:
                        if not isinstance(b, dict):
                            continue
                        ids.append(import_bundle(conn, b))
                    conn.commit()
                    return self._json({"session_ids": ids}, 201)

                return self._error(404, "未知接口")
            except sqlite3.IntegrityError as e:
                conn.rollback()
                return self._error(409, f"数据冲突: {e}")
            except Exception as e:  # noqa: BLE001
                conn.rollback()
                return self._error(400, f"请求处理失败: {e}")

    # ---- PATCH ----
    def do_PATCH(self):
        path = urlparse(self.path).path
        if not path.startswith("/api/"):
            return self._error(404, "未知接口")
        parts = [p for p in path.split("/") if p]
        try:
            data = self._read_json()
        except ValueError as e:
            return self._error(400, str(e))
        conn = self.server.db
        with _db_lock:
            try:
                now = int(time.time() * 1000)

                # /api/sessions/<sid>
                if len(parts) == 3 and parts[1] == "sessions":
                    sid = parts[2]
                    s = conn.execute("SELECT * FROM sessions WHERE id=?", (sid,)).fetchone()
                    if not s:
                        return self._error(404, "会话不存在")
                    settings = json.loads(s["settings"])
                    if "settings" in data:
                        settings.update(data["settings"] or {})
                    conn.execute(
                        "UPDATE sessions SET name=?, settings=?, updated_at=? WHERE id=?",
                        (str(data.get("name", s["name"])),
                         json.dumps(settings, ensure_ascii=False), now, sid),
                    )
                    conn.commit()
                    return self._json(session_bundle(conn, sid))

                # /api/rounds/<rid>
                if len(parts) == 3 and parts[1] == "rounds":
                    rid = parts[2]
                    r = conn.execute("SELECT * FROM rounds WHERE id=?", (rid,)).fetchone()
                    if not r:
                        return self._error(404, "轮次不存在")
                    adj = json.loads(r["adjustment"])
                    if "adjustment" in data:
                        adj.update(data["adjustment"] or {})
                    conn.execute(
                        "UPDATE rounds SET note=?, adjustment=? WHERE id=?",
                        (str(data.get("note", r["note"])),
                         json.dumps(adj, ensure_ascii=False), rid),
                    )
                    conn.execute("UPDATE sessions SET updated_at=? WHERE id=?",
                                 (now, r["session_id"]))
                    conn.commit()
                    return self._json({"ok": True})

                # /api/segments/<gid>
                if len(parts) == 3 and parts[1] == "segments":
                    gid = parts[2]
                    g = conn.execute("SELECT * FROM segments WHERE id=?", (gid,)).fetchone()
                    if not g:
                        return self._error(404, "测段不存在")
                    conn.execute(
                        "UPDATE segments SET kind=?, locked=?, note=? WHERE id=?",
                        (data.get("kind", g["kind"]),
                         1 if data.get("locked", bool(g["locked"])) else 0,
                         str(data.get("note", g["note"])), gid),
                    )
                    r = conn.execute("SELECT session_id FROM rounds WHERE id=?",
                                     (g["round_id"],)).fetchone()
                    conn.execute("UPDATE sessions SET updated_at=? WHERE id=?",
                                 (now, r["session_id"]))
                    conn.commit()
                    return self._json({"ok": True})

                # /api/points/<pid>
                if len(parts) == 3 and parts[1] == "points":
                    pid = parts[2]
                    p = conn.execute(
                        "SELECT pt.*, s.round_id FROM points pt JOIN segments s "
                        "ON pt.segment_id=s.id WHERE pt.id=?", (pid,)
                    ).fetchone()
                    if not p:
                        return self._error(404, "打点不存在")
                    conn.execute(
                        "UPDATE points SET tick=?, direction=?, excluded=?, note=? WHERE id=?",
                        (float(data.get("tick", p["tick"])),
                         1 if int(data.get("direction", p["direction"])) >= 0 else -1,
                         1 if data.get("excluded", bool(p["excluded"])) else 0,
                         str(data.get("note", p["note"])), pid),
                    )
                    r = conn.execute("SELECT session_id FROM rounds WHERE id=?",
                                     (p["round_id"],)).fetchone()
                    conn.execute("UPDATE sessions SET updated_at=? WHERE id=?",
                                 (now, r["session_id"]))
                    conn.commit()
                    return self._json({"ok": True})

                return self._error(404, "未知接口")
            except Exception as e:  # noqa: BLE001
                conn.rollback()
                return self._error(400, f"请求处理失败: {e}")

    # ---- DELETE ----
    def do_DELETE(self):
        path = urlparse(self.path).path
        if not path.startswith("/api/"):
            return self._error(404, "未知接口")
        parts = [p for p in path.split("/") if p]
        conn = self.server.db
        with _db_lock:
            try:
                def touch_session(sid):
                    conn.execute(
                        "UPDATE sessions SET updated_at=? WHERE id=?",
                        (int(time.time() * 1000), sid))

                if len(parts) == 3 and parts[1] == "sessions":
                    conn.execute("DELETE FROM sessions WHERE id=?", (parts[2],))
                    conn.commit()
                    return self._json({"ok": True})
                if len(parts) == 3 and parts[1] == "rounds":
                    r = conn.execute("SELECT session_id FROM rounds WHERE id=?",
                                     (parts[2],)).fetchone()
                    conn.execute("DELETE FROM rounds WHERE id=?", (parts[2],))
                    if r:
                        touch_session(r["session_id"])
                    conn.commit()
                    return self._json({"ok": True})
                if len(parts) == 3 and parts[1] == "segments":
                    g = conn.execute(
                        "SELECT s.round_id FROM segments s WHERE s.id=?", (parts[2],)
                    ).fetchone()
                    conn.execute("DELETE FROM segments WHERE id=?", (parts[2],))
                    if g:
                        r = conn.execute("SELECT session_id FROM rounds WHERE id=?",
                                         (g["round_id"],)).fetchone()
                        if r:
                            touch_session(r["session_id"])
                    conn.commit()
                    return self._json({"ok": True})
                if len(parts) == 3 and parts[1] == "points":
                    conn.execute("DELETE FROM points WHERE id=?", (parts[2],))
                    conn.commit()
                    return self._json({"ok": True})
                return self._error(404, "未知接口")
            except Exception as e:  # noqa: BLE001
                conn.rollback()
                return self._error(400, f"请求处理失败: {e}")


def main():
    ap = argparse.ArgumentParser(description="漂移法赤道仪校准推演台")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--db", default=os.path.join(BASE_DIR, "driftalign.db"))
    args = ap.parse_args()

    os.makedirs(WEB_DIR, exist_ok=True)
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    server.db = get_db(args.db)
    url = f"http://{args.host}:{args.port}/"
    print(f"漂移法校准推演台已启动: {url}")
    print(f"数据库: {args.db}  (Ctrl+C 停止)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止。")
    finally:
        server.db.close()
        server.server_close()


if __name__ == "__main__":
    main()
