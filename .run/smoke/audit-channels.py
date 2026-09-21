"""Call every IPC channel with minimal args and report hard failures.

A channel that returns {ok:false, error:"expected ..."} is fine — that is
input validation. A channel that throws an unhandled exception, hangs, or
kills the server is a bug. We bucket by response shape so the real breakage
is visible instead of buried in 531 lines.
"""
import json, urllib.request, urllib.parse, sys, time

BASE = "http://127.0.0.1:18080"

def ipc(channel, args=(), timeout=12):
    url = f"{BASE}/api/ipc/{urllib.parse.quote(channel, safe='')}"
    body = json.dumps({"args": list(args)}).encode()
    req = urllib.request.Request(url, data=body, headers={"content-type": "application/json"})
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read()
            return json.loads(raw), time.time() - t0
    except urllib.error.HTTPError as e:
        return {"_http": e.code, "_body": e.read()[:300].decode(errors="replace")}, time.time() - t0
    except Exception as e:
        return {"_transport": str(e)}, time.time() - t0

with urllib.request.urlopen(f"{BASE}/api/channels", timeout=10) as r:
    channels = json.loads(r.read())["channels"]

buckets = {"ok": [], "validation": [], "server_error": [], "transport": [], "slow": []}
for ch in sorted(channels):
    res, dt = ipc(ch)
    if dt > 4:
        buckets["slow"].append((ch, round(dt, 1)))
    if "_transport" in res:
        buckets["transport"].append((ch, res["_transport"][:120]))
        continue
    if "_http" in res:
        buckets["server_error"].append((ch, f"HTTP {res['_http']}"))
        continue
    inner = res.get("result", res) if isinstance(res, dict) else res
    err = ""
    if isinstance(inner, dict):
        err = str(inner.get("error") or "")
    low = err.lower()
    if not err:
        buckets["ok"].append(ch)
    elif any(k in low for k in ("expected", "non-empty", "required", "missing", "invalid", "not found", "unknown", "unsupported", "no api key", "no model", "must be", "cannot be empty", "provide")):
        buckets["validation"].append((ch, err[:100]))
    else:
        buckets["server_error"].append((ch, err[:160]))

print(f"total channels: {len(channels)}")
print(f"  ok (no error):           {len(buckets['ok'])}")
print(f"  input-validation errors: {len(buckets['validation'])}")
print(f"  hard errors:             {len(buckets['server_error'])}")
print(f"  transport failures:      {len(buckets['transport'])}")
print(f"  slow (>4s):              {len(buckets['slow'])}")

for label in ("server_error", "transport", "slow"):
    if buckets[label]:
        print(f"\n=== {label} ===")
        for item in buckets[label]:
            print("  ", item)
