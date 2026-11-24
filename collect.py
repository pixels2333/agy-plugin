"""Antigravity API usage collector.

Reads the local Antigravity data directory and produces a statistics payload
describing API request volume, model mix, activity timeline and tool usage.

Data sources
------------
conversations/<id>.db   SQLite per conversation. `gen_metadata` holds one row
                        per upstream API request (model enum, request id,
                        last step index). `steps` holds agent steps.
brain/<id>/.system_generated/logs/transcript.jsonl
                        Per-step records with timestamps and tool calls.
token_usage.jsonl       Legacy per-request token ledger (older builds).
antigravity_state.pbtxt Current model selection and install id.

No token counts are persisted by the current build; see README.md.
"""

from __future__ import annotations

import collections
import datetime as dt
import glob
import json
import os
import re
import sqlite3
import sys

BASE_DIR = os.path.join(os.path.expanduser("~"), ".gemini", "antigravity")
CONV_DIR = os.path.join(BASE_DIR, "conversations")
BRAIN_DIR = os.path.join(BASE_DIR, "brain")
LEGACY_TOKEN_LOG = os.path.join(BASE_DIR, "token_usage.jsonl")
STATE_FILE = os.path.join(BASE_DIR, "antigravity_state.pbtxt")

# Protobuf wire format inside gen_metadata.data: field 2 (\x12) is
# length-delimited; the length byte varies with value size.
ENUM_RE = re.compile(rb"model_enum\x12[\s\S](MODEL_PLACEHOLDER_M\d+)")
STEP_RE = re.compile(rb"last_step_index\x12[\s\S](\d{1,3})")
CLAUDE_RE = re.compile(rb"used_claude\x12[\s\S](true|false)")
NON_GEMINI_RE = re.compile(rb"used_non_gemini_model\x12[\s\S](true|false)")

# Model labels inferred from transcript setting-change events; overridable via
# model_map.json.
DEFAULT_MODEL_MAP = {
    "MODEL_PLACEHOLDER_M298": "Gemini 3.7 Flash (High)",
    "MODEL_PLACEHOLDER_M318": "Gemini 3.8 Flash (High)",
    "MODEL_PLACEHOLDER_M71": "Gemini 3.6 Flash (High)",
    "MODEL_PLACEHOLDER_M264": "Gemini 3.6 Flash (High)",
}
UNKNOWN_MODEL = "MODEL_PLACEHOLDER_M322"


def model_label(enum: str, model_map: dict) -> str:
    """Human label for a model enum; keep unidentified enums readable."""
    if enum in model_map:
        return model_map[enum]
    short = enum.rsplit("_", 1)[-1]
    return f"未识别模型 ({short})"


def load_model_map(base_dir: str) -> dict:
    path = os.path.join(base_dir, "model_map.json")
    mapping = dict(DEFAULT_MODEL_MAP)
    if os.path.exists(path):
        with open(path, encoding="utf-8") as fh:
            mapping.update(json.load(fh))
    return mapping


def iso_to_day(value: str) -> str | None:
    if not value:
        return None
    try:
        parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed.astimezone().strftime("%Y-%m-%d")


def read_transcript(path: str) -> tuple[dict, dict]:
    """Return (step_index -> created_at, step_index -> record summary)."""
    times: dict[int, str] = {}
    info: dict[int, dict] = {}
    tool_calls: collections.Counter = collections.Counter()
    try:
        fh = open(path, encoding="utf-8", errors="replace")
    except OSError:
        return times, {"tool_calls": tool_calls, "think_steps": 0, "model_steps": 0,
                       "user_turns": 0, "first_user_text": "", "records": 0}
    with fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            idx = rec.get("step_index")
            ts = rec.get("created_at")
            if isinstance(idx, int) and ts:
                times[idx] = ts
            if rec.get("source") == "MODEL":
                info["model_steps"] = info.get("model_steps", 0) + 1
                if rec.get("thinking"):
                    info["think_steps"] = info.get("think_steps", 0) + 1
            if rec.get("source") == "USER_EXPLICIT":
                info["user_turns"] = info.get("user_turns", 0) + 1
                if not info.get("first_user_text"):
                    info["first_user_text"] = first_user_line(rec.get("content") or "")
            for call in rec.get("tool_calls") or []:
                name = call.get("name")
                if name:
                    tool_calls[name] += 1
            info["records"] = info.get("records", 0) + 1
    info["tool_calls"] = tool_calls
    return times, info


def first_user_line(content: str) -> str:
    text = content.replace("<USER_REQUEST>", "").replace("</USER_REQUEST>", "").strip()
    for line in text.splitlines():
        line = line.strip()
        if line:
            return line[:120]
    return ""


def read_conversation(db_path: str, model_map: dict) -> dict | None:
    cid = os.path.basename(db_path)[:-3]
    try:
        con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    except sqlite3.Error:
        return None
    try:
        cur = con.cursor()
        requests: list[tuple[int | None, str]] = []
        used_claude = 0
        used_non_gemini = 0
        for (blob,) in cur.execute("select data from gen_metadata"):
            raw = bytes(blob)
            enum_match = ENUM_RE.search(raw)
            step_match = STEP_RE.search(raw)
            if not enum_match:
                continue
            requests.append((
                int(step_match.group(1)) if step_match else None,
                enum_match.group(1).decode(),
            ))
            if CLAUDE_RE.search(raw):
                if CLAUDE_RE.search(raw).group(1) == b"true":
                    used_claude += 1
            m = NON_GEMINI_RE.search(raw)
            if m and m.group(1) == b"true":
                used_non_gemini += 1

        steps_by_type = dict(cur.execute(
            "select step_type, count(*) from steps group by step_type"))
        steps_by_status = dict(cur.execute(
            "select status, count(*) from steps group by status"))
        total_steps = sum(steps_by_type.values())
    except sqlite3.Error:
        con.close()
        return None
    con.close()

    transcript = os.path.join(BRAIN_DIR, cid, ".system_generated", "logs", "transcript.jsonl")
    times, info = read_transcript(transcript)

    # Attach a timestamp to each request via its last step index.
    day_counter: collections.Counter = collections.Counter()
    model_counter: collections.Counter = collections.Counter()
    stamped = 0
    for step_index, enum in requests:
        model_counter[enum] += 1
        if step_index is not None and step_index in times:
            day = iso_to_day(times[step_index])
            if day:
                day_counter[day] += 1
                stamped += 1

    all_times = sorted(v for v in times.values() if v)
    duration_s = None
    if len(all_times) >= 2:
        try:
            start = dt.datetime.fromisoformat(all_times[0].replace("Z", "+00:00"))
            end = dt.datetime.fromisoformat(all_times[-1].replace("Z", "+00:00"))
            duration_s = int((end - start).total_seconds())
        except ValueError:
            duration_s = None

    return {
        "id": cid,
        "title": info.get("first_user_text") or "(untitled)",
        "requests": len(requests),
        "requests_stamped": stamped,
        "models": {model_label(k, model_map): v for k, v in model_counter.items()},
        "models_raw": dict(model_counter),
        "days": dict(day_counter),
        "steps": total_steps,
        "steps_by_type": steps_by_type,
        "steps_by_status": steps_by_status,
        "tool_calls": dict(info.get("tool_calls", {})),
        "tool_call_count": sum(info.get("tool_calls", {}).values()),
        "model_steps": info.get("model_steps", 0),
        "thinking_steps": info.get("think_steps", 0),
        "user_turns": info.get("user_turns", 0),
        "started_at": all_times[0] if all_times else None,
        "ended_at": all_times[-1] if all_times else None,
        "duration_s": duration_s,
        "used_claude": used_claude,
        "used_non_gemini": used_non_gemini,
        "db_bytes": os.path.getsize(db_path),
    }


def read_legacy_tokens() -> dict:
    """Parse the legacy token_usage.jsonl ledger if present."""
    if not os.path.exists(LEGACY_TOKEN_LOG):
        return {"present": False}
    rows = []
    with open(LEGACY_TOKEN_LOG, encoding="utf-8", errors="replace") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    if not rows:
        return {"present": True, "requests": 0, "rows": []}
    totals = {
        "prompt": sum(int(r.get("promptTokenCount") or 0) for r in rows),
        "candidates": sum(int(r.get("candidatesTokenCount") or 0) for r in rows),
        "thoughts": sum(int(r.get("thoughtsTokenCount") or 0) for r in rows),
        "cached": sum(int(r.get("cachedContentTokenCount") or 0) for r in rows),
        "total": sum(int(r.get("totalTokenCount") or 0) for r in rows),
    }
    by_model: collections.Counter = collections.Counter()
    by_day: collections.Counter = collections.Counter()
    for r in rows:
        by_model[r.get("model") or "unknown"] += int(r.get("totalTokenCount") or 0)
        day = (r.get("timestamp") or "")[:10]
        if day:
            by_day[day] += int(r.get("totalTokenCount") or 0)
    return {
        "present": True,
        "requests": len(rows),
        "totals": totals,
        "by_model": dict(by_model),
        "by_day": dict(sorted(by_day.items())),
        "first": rows[0].get("timestamp"),
        "last": rows[-1].get("timestamp"),
    }


def read_state() -> dict:
    if not os.path.exists(STATE_FILE):
        return {}
    text = open(STATE_FILE, encoding="utf-8", errors="replace").read()
    out = {}
    m = re.search(r'last_selected_agent_model:\s*(\S+)', text)
    if m:
        out["last_model_enum"] = m.group(1)
    m = re.search(r'installation_uuid:\s*"([^"]+)"', text)
    if m:
        out["installation_uuid"] = m.group(1)
    return out


def load_existing_stats(out_path: str) -> dict | None:
    if not os.path.exists(out_path):
        return None
    try:
        with open(out_path, encoding="utf-8") as fh:
            data = json.load(fh)
            return data if isinstance(data, dict) else None
    except (OSError, json.JSONDecodeError):
        return None


def build(verbose: bool = False, prev_stats: dict | None = None) -> dict:
    model_map = load_model_map(os.path.dirname(os.path.abspath(__file__)))
    live_by_id: dict[str, dict] = {}
    for db_path in glob.glob(os.path.join(CONV_DIR, "*.db")):
        entry = read_conversation(db_path, model_map)
        if entry:
            entry["archived"] = False
            live_by_id[entry["id"]] = entry
        elif verbose:
            print(f"  skipped {os.path.basename(db_path)}", file=sys.stderr)

    # 合并旧 stats.json 中已删除会话的历史快照，确保删除会话不会导致全局累计统计减少
    archived_count = 0
    merged_by_id: dict[str, dict] = dict(live_by_id)
    for prev_c in (prev_stats or {}).get("conversations") or []:
        cid = prev_c.get("id")
        if not cid or cid in merged_by_id:
            continue
        archived = dict(prev_c)
        archived["archived"] = True
        archived["db_bytes"] = 0
        if archived.get("models_raw"):
            archived["models"] = {
                model_label(k, model_map): v for k, v in archived["models_raw"].items()
            }
        merged_by_id[cid] = archived
        archived_count += 1

    conversations = list(merged_by_id.values())

    requests_by_day: collections.Counter = collections.Counter()
    requests_by_model: collections.Counter = collections.Counter()
    tool_calls: collections.Counter = collections.Counter()
    total_requests = 0
    total_steps = 0
    total_tool_calls = 0
    total_thinking = 0
    total_user_turns = 0
    claude_requests = 0
    non_gemini_requests = 0

    for c in conversations:
        total_requests += c["requests"]
        total_steps += c["steps"]
        total_tool_calls += c["tool_call_count"]
        total_thinking += c["thinking_steps"]
        total_user_turns += c["user_turns"]
        claude_requests += c["used_claude"]
        non_gemini_requests += c["used_non_gemini"]
        for day, n in c["days"].items():
            requests_by_day[day] += n
        for model, n in c["models"].items():
            requests_by_model[model] += n
        for name, n in c["tool_calls"].items():
            tool_calls[name] += n

    conversations.sort(key=lambda c: (c["ended_at"] or "", c["requests"]), reverse=True)
    active_days = len(requests_by_day)

    return {
        "generated_at": dt.datetime.now().astimezone().isoformat(timespec="seconds"),
        "source_dir": BASE_DIR,
        "totals": {
            "conversations": len(conversations),
            "archived_conversations": archived_count,
            "requests": total_requests,
            "steps": total_steps,
            "tool_calls": total_tool_calls,
            "thinking_steps": total_thinking,
            "user_turns": total_user_turns,
            "active_days": active_days,
            "claude_requests": claude_requests,
            "non_gemini_requests": non_gemini_requests,
            "db_bytes": sum(c["db_bytes"] for c in conversations),
        },
        "first_day": min(requests_by_day) if requests_by_day else None,
        "last_day": max(requests_by_day) if requests_by_day else None,
        "requests_by_day": dict(sorted(requests_by_day.items())),
        "requests_by_model": dict(requests_by_model.most_common()),
        "tool_calls": dict(tool_calls.most_common()),
        "conversations": conversations,
        "legacy_tokens": read_legacy_tokens(),
        "state": read_state(),
    }


def main() -> None:
    out_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "stats.json")
    prev_stats = load_existing_stats(out_path)
    data = build(verbose=True, prev_stats=prev_stats)
    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, indent=2)
    t = data["totals"]
    print(f"wrote {out_path}")
    print(f"  conversations={t['conversations']} (archived={t['archived_conversations']}) "
          f"requests={t['requests']} steps={t['steps']} tool_calls={t['tool_calls']} active_days={t['active_days']}")
    print(f"  range: {data['first_day']} .. {data['last_day']}")
    print(f"  models: {data['requests_by_model']}")


if __name__ == "__main__":
    main()
