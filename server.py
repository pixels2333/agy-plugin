"""Local HTTP server for the Antigravity API usage dashboard.

Serves the dashboard UI and a JSON statistics endpoint computed from the local
Antigravity data directory. Standard library only.

Usage:
    python server.py                 # http://127.0.0.1:8787
    python server.py --port 9000
    python server.py --open          # open the browser on start
"""

from __future__ import annotations

import argparse
import json
import os
import threading
import time
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

import collect

HERE = os.path.dirname(os.path.abspath(__file__))
INDEX = os.path.join(HERE, "index.html")
STATS_JSON = os.path.join(HERE, "stats.json")

CACHE_TTL = 10.0
_cache: dict = {"at": 0.0, "data": None}
_lock = threading.Lock()


def get_stats(force: bool = False) -> dict:
    """Return the statistics payload, recomputing at most once per CACHE_TTL."""
    with _lock:
        now = time.time()
        if not force and _cache["data"] is not None and now - _cache["at"] < CACHE_TTL:
            return _cache["data"]
        try:
            data = collect.build()
            _cache["data"] = data
            _cache["at"] = now
            return data
        except Exception as exc:  # fall back to the last snapshot on disk
            if _cache["data"] is not None:
                return _cache["data"]
            if os.path.exists(STATS_JSON):
                with open(STATS_JSON, encoding="utf-8") as fh:
                    return json.load(fh)
            raise exc


class Handler(BaseHTTPRequestHandler):
    server_version = "AgyStats/1.0"

    def log_message(self, fmt, *args):  # quieter console
        pass

    def _send(self, status: int, body: bytes, ctype: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):  # noqa: N802
        path = urlparse(self.path).path
        if path in ("/", "/index.html"):
            try:
                with open(INDEX, "rb") as fh:
                    self._send(200, fh.read(), "text/html; charset=utf-8")
            except OSError:
                self._send(500, b"index.html not found", "text/plain; charset=utf-8")
            return
        if path == "/api/stats":
            force = parse_qs(urlparse(self.path).query).get("refresh") == ["1"]
            try:
                payload = json.dumps(get_stats(force), ensure_ascii=False).encode("utf-8")
                self._send(200, payload, "application/json; charset=utf-8")
            except Exception as exc:
                msg = json.dumps({"error": str(exc)}).encode("utf-8")
                self._send(500, msg, "application/json; charset=utf-8")
            return
        if path == "/api/health":
            self._send(200, b'{"ok":true}', "application/json")
            return
        self._send(404, b"not found", "text/plain; charset=utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(description="Antigravity API usage dashboard server")
    parser.add_argument("--port", type=int,
                        default=int(os.environ.get("AGY_STATS_PORT", "8787")))
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--open", action="store_true", help="open the browser on start")
    args = parser.parse_args()

    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    url = f"http://{args.host}:{args.port}/"
    print(f"Antigravity API usage dashboard: {url}")
    print("数据源:", collect.BASE_DIR)
    print("Ctrl+C 停止服务")

    # Warm the cache so the first page view is instant.
    def warm() -> None:
        try:
            stats = get_stats(force=True)
            print(f"已采集 {stats['totals']['requests']} 次请求 / "
                  f"{stats['totals']['conversations']} 个会话")
        except Exception as exc:
            print("预热失败:", exc)

    threading.Thread(target=warm, daemon=True).start()
    if args.open:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
