"""Infer MODEL_PLACEHOLDER_* -> human model name by correlating gen_metadata
model_enum values with '<USER_SETTINGS_CHANGE>' model-selection events recorded
in the conversation transcripts.
"""
import glob
import json
import os
import re
import sqlite3
import collections

BASE = os.path.join(os.path.expanduser("~"), ".gemini", "antigravity")
CONV_DIR = os.path.join(BASE, "conversations")
BRAIN_DIR = os.path.join(BASE, "brain")

SETTINGS_RE = re.compile(
    r"setting `Model Selection` from (?P<old>.+?) to (?P<new>.+?)\.(?=\s|</|\Z)"
)
# Protobuf length-delimited field: \x12 <length byte> <value>. The length byte
# varies with the value size, so accept any single byte.
ENUM_RE = re.compile(rb"model_enum\x12[\s\S](MODEL_PLACEHOLDER_M\d+)")
STEP_RE = re.compile(rb"last_step_index\x12[\s\S](\d{1,3})")


def read_enums(db_path):
    """Return list of (last_step_index, model_enum) for a conversation."""
    out = []
    con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    for (d,) in con.execute("select data from gen_metadata"):
        b = bytes(d)
        e = ENUM_RE.search(b)
        s = STEP_RE.search(b)
        if e and s:
            out.append((int(s.group(1)), e.group(1).decode()))
    con.close()
    return out


def read_transcript(path):
    """Return list of records (step_index, created_at, content) from transcript."""
    recs = []
    with open(path, encoding="utf-8", errors="replace") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                o = json.loads(line)
            except json.JSONDecodeError:
                continue
            recs.append((o.get("step_index"), o.get("created_at"), o.get("content") or ""))
    return recs


def main():
    votes = collections.Counter()  # (enum, name) -> weight
    per_conv = {}
    for db in glob.glob(os.path.join(CONV_DIR, "*.db")):
        cid = os.path.basename(db)[:-3]
        enums = read_enums(db)
        if not enums:
            continue
        tr = os.path.join(BRAIN_DIR, cid, ".system_generated", "logs", "transcript.jsonl")
        if not os.path.exists(tr):
            continue
        recs = read_transcript(tr)
        events = []
        for si, ts, content in recs:
            for m in SETTINGS_RE.finditer(content):
                events.append((si, m.group("old").strip(), m.group("new").strip()))
        if not events:
            continue
        per_conv[cid] = (sorted(enums), events)
        for si, old, new in events:
            after = [e for idx, e in enums if idx >= si]
            before = [e for idx, e in enums if idx < si]
            if after:
                votes[(collections.Counter(after).most_common(1)[0][0], new)] += 1
            if before:
                votes[(collections.Counter(before).most_common(1)[0][0], old)] += 1

    print("=== 推断的模型枚举映射 (票数) ===")
    for (enum, name), n in votes.most_common(40):
        print(f"  {n:4d}  {enum}  ->  {name}")

    print("\n=== 样例会话明细 ===")
    for cid, (enums, events) in list(per_conv.items())[:4]:
        print(f"\n-- {cid}")
        print("   枚举序列:", collections.Counter(e for _, e in enums))
        for si, old, new in events:
            print(f"   step {si}: {old!r} -> {new!r}")


if __name__ == "__main__":
    main()
