"""Call an Antigravity local language-server RPC and dump the response shape."""
import json, re, subprocess, sys, os

HERE = os.path.dirname(os.path.abspath(__file__))

def csrf():
    html = open(os.path.join(HERE, "index.html"), encoding="utf-8", errors="replace").read()
    return re.search(r'"csrfToken":"([^"]+)"', html).group(1)

def ui_port():
    # find the listening HTTPS port of language_server
    out = subprocess.run(["netstat", "-ano"], capture_output=True, text=True).stdout
    html = open(os.path.join(HERE, "index.html"), encoding="utf-8", errors="replace").read()
    return None

def call(method, payload=None):
    token = csrf()
    port = open(os.path.join(HERE, "ui_port.txt")).read().strip() if os.path.exists(os.path.join(HERE,"ui_port.txt")) else "62534"
    url = f"https://127.0.0.1:{port}/exa.language_server_pb.LanguageServerService/{method}"
    body = json.dumps(payload if payload is not None else {"metadata": {}})
    r = subprocess.run([
        "curl", "-sk", "-m", "25", "-X", "POST", url,
        "-H", "Content-Type: application/json",
        "-H", f"x-codeium-csrf-token: {token}",
        "-H", "x-grpc-web: 1", "-H", "x-user-agent: antigravity",
        "-d", body,
    ], capture_output=True, text=True)
    raw = r.stdout
    m = re.search(r"\{.*\}", raw, re.S)
    if not m:
        return {"_raw": raw[:300], "_len": len(raw)}
    try:
        return json.loads(m.group(0))
    except json.JSONDecodeError:
        return {"_raw": m.group(0)[:300]}

def keys_of(obj, prefix="", depth=0, maxdepth=3, out=None):
    if out is None: out = []
    if depth > maxdepth: return out
    if isinstance(obj, dict):
        for k, v in obj.items():
            out.append(f"{prefix}{k}")
            if isinstance(v, (dict, list)): keys_of(v, f"{prefix}{k}.", depth+1, maxdepth, out)
    elif isinstance(obj, list) and obj:
        keys_of(obj[0], f"{prefix}[].", depth+1, maxdepth, out)
    return out

if __name__ == "__main__":
    method = sys.argv[1]
    payload = json.loads(sys.argv[2]) if len(sys.argv) > 2 else None
    res = call(method, payload)
    s = json.dumps(res, ensure_ascii=False)
    print(f"=== {method} === raw {len(s)} bytes")
    ks = keys_of(res)
    print("keys:", ks[:60])
    print()
    print(s[:1200])
