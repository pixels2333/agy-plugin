"""Probe where token-usage fields live inside the Antigravity conversation DBs."""
import sqlite3
import os
import glob
import re

CONV_DIR = os.path.join(os.path.expanduser("~"), ".gemini", "antigravity", "conversations")

TARGETS = [b"prompt_tokens", b"completion_tokens", b"total_tokens_used",
           b"task_tokens_used", b"thinking_tokens", b"model_enum", b"request_id"]

COLUMNS = [
    ("gen_metadata", "data"),
    ("executor_metadata", "data"),
    ("steps", "metadata"),
    ("steps", "render_info"),
    ("steps", "task_details"),
    ("steps", "step_payload"),
    ("trajectory_metadata_blob", "data"),
]


def probe(db_path, limit_per_col=2):
    con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    cur = con.cursor()
    for table, col in COLUMNS:
        hits = 0
        try:
            rows = cur.execute(f'select rowid, "{col}" from "{table}" where "{col}" is not null')
        except sqlite3.Error as e:
            print(f"  [{table}.{col}] skip: {e}")
            continue
        for rowid, d in rows:
            blob = d if isinstance(d, (bytes, bytearray)) else str(d).encode("utf-8", "replace")
            blob = bytes(blob)
            for tg in TARGETS:
                i = blob.find(tg)
                if i >= 0:
                    seg = blob[max(0, i - 30): i + 110]
                    txt = seg.decode("latin1").replace("\n", " ").replace("\x00", ".")
                    print(f"  [{table}.{col}] rowid={rowid} field={tg.decode()}")
                    print(f"      ...{txt}...")
                    hits += 1
                    break
            if hits >= limit_per_col:
                break
    con.close()


dbs = sorted(glob.glob(os.path.join(CONV_DIR, "*.db")), key=os.path.getmtime, reverse=True)
print(f"found {len(dbs)} conversation DBs; probing most recent 3\n")
for p in dbs[:3]:
    print(f"########## {os.path.basename(p)} ({os.path.getsize(p)} bytes) ##########")
    probe(p)
    print()
