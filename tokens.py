"""Collect per-request token usage and context occupancy for every Antigravity
conversation, by calling the local language server's
GetCascadeTrajectoryGeneratorMetadata RPC.

The token counts are not persisted to disk by the app; they are only served
over the local API, so this talks to the running app.

Usage: python tokens.py [--limit N]
"""

from __future__ import annotations

import glob
import json
import os
import re
import subprocess
import sys
import collections

HERE = os.path.dirname(os.path.abspath(__file__))
BASE = os.path.join(os.path.expanduser("~"), ".gemini", "antigravity")
CONV_DIR = os.path.join(BASE, "conversations")
TRANSCRIPT = os.path.join(BASE, "brain", "%s", ".system_generated", "logs", "transcript.jsonl")

METHOD = "GetCascadeTrajectoryGeneratorMetadata"


_PORT = None
_CSRF = None


def get_port_and_csrf() -> tuple[str, str]:
    global _PORT, _CSRF
    if _PORT and _CSRF:
        return _PORT, _CSRF

    ports = []
    txt_path = os.path.join(HERE, "ui_port.txt")
    if os.path.exists(txt_path):
        try:
            ports.append(open(txt_path, encoding="utf-8").read().strip())
        except Exception:
            pass

    try:
        netstat = subprocess.run(["netstat", "-ano"], capture_output=True, text=True, encoding="utf-8", errors="replace").stdout
        tasklist = subprocess.run(["tasklist", "/fi", "imagename eq language_server.exe", "/fo", "csv"], capture_output=True, text=True, encoding="utf-8", errors="replace").stdout
        pids = set(re.findall(r'"language_server\.exe","(\d+)"', tasklist))
        for line in netstat.splitlines():
            parts = line.strip().split()
            if len(parts) >= 5 and parts[1].startswith("127.0.0.1:") and parts[3] == "LISTENING" and parts[4] in pids:
                ports.append(parts[1].split(":")[1])
    except Exception:
        pass

    for port in set(ports):
        if not port:
            continue
        try:
            r = subprocess.run(["curl", "-sk", "-m", "2", f"https://127.0.0.1:{port}/"], capture_output=True, text=True, encoding="utf-8", errors="replace")
            m = re.search(r'"csrfToken":"([^"]+)"', r.stdout)
            if m:
                _PORT = port
                _CSRF = m.group(1)
                try:
                    with open(txt_path, "w", encoding="utf-8") as fh:
                        fh.write(port)
                except Exception:
                    pass
                return _PORT, _CSRF
        except Exception:
            pass

    # Fallback to index.html if language server not reachable
    csrf = ""
    idx_path = os.path.join(HERE, "index.html")
    if os.path.exists(idx_path):
        m = re.search(r'"csrfToken":"([^"]+)"', open(idx_path, encoding="utf-8", errors="replace").read())
        if m:
            csrf = m.group(1)
    return "5209", csrf


def conversation_ids() -> list[str]:
    dbs = sorted(glob.glob(os.path.join(CONV_DIR, "*.db")), key=os.path.getmtime, reverse=True)
    return [os.path.basename(p)[:-3] for p in dbs]


def call_raw(method: str, payload: dict) -> str:
    port, csrf = get_port_and_csrf()
    url = f"https://127.0.0.1:{port}/exa.language_server_pb.LanguageServerService/{method}"
    r = subprocess.run([
        "curl", "-sk", "-m", "60", "-X", "POST", url,
        "-H", "Content-Type: application/json",
        "-H", f"x-codeium-csrf-token: {csrf}",
        "-H", "x-grpc-web: 1", "-H", "x-user-agent: antigravity",
        "-d", json.dumps(payload),
    ], capture_output=True, text=True, encoding="utf-8", errors="replace")
    return r.stdout


def parse(raw: str) -> dict | None:
    m = re.search(r"\{.*\}", raw, re.S)
    if not m:
        return None
    try:
        return json.loads(m.group(0))
    except json.JSONDecodeError:
        return None


def step_timestamps(conv_id: str) -> dict[int, str]:
    """step_index -> created_at, from the conversation transcript."""
    path = TRANSCRIPT % conv_id
    out = {}
    if not os.path.exists(path):
        return out
    with open(path, encoding="utf-8", errors="replace") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            idx, ts = rec.get("step_index"), rec.get("created_at")
            if isinstance(idx, int) and ts:
                out[idx] = ts
    return out


def to_int(v) -> int:
    try:
        return int(v)
    except (TypeError, ValueError):
        return 0


def collect(limit: int | None = None) -> dict:
    ids = conversation_ids()
    if limit:
        ids = ids[:limit]

    calls = []
    by_model = collections.Counter()
    by_day = collections.Counter()
    by_day_ctx = collections.Counter()
    ctx_peak = 0
    ctx_peak_conv = None
    max_window = 0
    ttft = []
    skipped = []
    total = collections.Counter()

    for n, cid in enumerate(ids, 1):
        raw = call_raw(METHOD, {"cascade_id": cid, "include_messages": True})
        data = parse(raw)
        if not data or "generatorMetadata" not in data:
            skipped.append(cid)
            continue
        times = step_timestamps(cid)
        for gen in data["generatorMetadata"]:
            cm = gen.get("chatModel") or {}
            usage = cm.get("usage") or {}
            if not usage:
                continue
            model = usage.get("model") or cm.get("model") or "unknown"
            response_model = cm.get("responseModel") or ""
            inp = to_int(usage.get("inputTokens"))
            out = to_int(usage.get("outputTokens"))
            think = to_int(usage.get("thinkingOutputTokens"))
            resp = to_int(usage.get("responseOutputTokens"))
            cache = to_int(usage.get("cacheReadTokens"))
            cwm = ((cm.get("chatStartMetadata") or {}).get("contextWindowMetadata") or {})
            ctx_used = to_int(cwm.get("estimatedTokensUsed"))
            ctx_max = to_int(cwm.get("maxContextTokens"))
            step_idx = (gen.get("stepIndices") or [None])[0]

            calls.append({
                "conversation": cid,
                "stepIndex": step_idx,
                "model": model,
                "responseModel": response_model,
                "inputTokens": inp,
                "cacheReadTokens": cache,
                "promptTokens": inp + cache,
                "outputTokens": out,
                "thinkingOutputTokens": think,
                "responseOutputTokens": resp,
                "totalTokens": inp + cache + out,
                "contextUsed": ctx_used,
                "contextMax": ctx_max,
                "timeToFirstToken": cm.get("timeToFirstToken"),
            })

            by_model[response_model or model] += inp + cache + out
            total["inputTokens"] += inp
            total["cacheReadTokens"] += cache
            total["promptTokens"] += inp + cache
            total["outputTokens"] += out
            total["thinkingOutputTokens"] += think
            total["totalTokens"] += inp + cache + out
            total["calls"] += 1
            if ctx_max:
                max_window = max(max_window, ctx_max)
            if ctx_used > ctx_peak:
                ctx_peak = ctx_used
                ctx_peak_conv = cid
            if step_idx is not None and step_idx in times:
                day = times[step_idx][:10]
                by_day[day] += inp + out
                by_day_ctx[day] = max(by_day_ctx[day], ctx_used)
            if cm.get("timeToFirstToken"):
                m = re.match(r"([0-9.]+)s", cm["timeToFirstToken"])
                if m:
                    ttft.append(float(m.group(1)))
        if n % 10 == 0:
            print(f"  ... {n}/{len(ids)} conversations, {total['calls']} calls", flush=True)

    ttft.sort()
    def pct(p):
        return round(ttft[int(len(ttft) * p)], 3) if ttft else None

    return {
        "generatedAt": __import__("datetime").datetime.now().astimezone().isoformat(timespec="seconds"),
        "conversationsScanned": len(ids),
        "conversationsWithoutData": skipped,
        "calls": total["calls"],
        "totals": dict(total),
        "cacheHitRate": (total["cacheReadTokens"] / total["promptTokens"]) if total["promptTokens"] else 0,
        "byModel": dict(by_model.most_common()),
        "tokensByDay": dict(sorted(by_day.items())),
        "contextPeakByDay": dict(sorted(by_day_ctx.items())),
        "contextPeak": {"tokens": ctx_peak, "conversation": ctx_peak_conv, "window": max_window},
        "ttftSeconds": {"p50": pct(0.50), "p90": pct(0.90), "p99": pct(0.99), "samples": len(ttft)},
        "callsDetail": calls,
    }


def main():
    limit = None
    if "--limit" in sys.argv:
        limit = int(sys.argv[sys.argv.index("--limit") + 1])
    data = collect(limit)
    out = os.path.join(HERE, "tokens.json")
    with open(out, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, indent=2)
    t = data["totals"]
    print(f"\nwrote {out}")
    print(f"  calls={t.get('calls', 0)}")
    print(f"  prompt={t.get('promptTokens') or 0:,} = new {t.get('inputTokens') or 0:,} + cache {t.get('cacheReadTokens') or 0:,}")
    print(f"  output={t.get('outputTokens') or 0:,}  thinking={t.get('thinkingOutputTokens') or 0:,}"
          f"  total={t.get('totalTokens') or 0:,}")
    print(f"  context peak: {data['contextPeak']['tokens']:,} / {data['contextPeak']['window']:,} window")
    print(f"  ttft p50={data['ttftSeconds']['p50']}s p90={data['ttftSeconds']['p90']}s")
    print(f"  models: {data['byModel']}")


if __name__ == "__main__":
    main()
