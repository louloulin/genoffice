import json, urllib.request, urllib.parse, time

BASE = "http://127.0.0.1:18080"

def ipc(channel, args, timeout=60):
    url = f"{BASE}/api/ipc/{urllib.parse.quote(channel, safe='')}"
    body = json.dumps({"args": args}).encode()
    req = urllib.request.Request(url, data=body, headers={"content-type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read())
    except Exception as e:
        return {"ok": False, "error": f"transport: {e}"}

DOCX = "apps/docs/tests/pagination-corpus/docx/07-page-breaks.docx"

def show(name, res, keys=("ok","error")):
    if not isinstance(res, dict):
        print(f"{name:34s} -> non-dict {type(res).__name__}")
        return
    inner = res.get("result", res)
    if isinstance(inner, dict):
        status = "ok" if inner.get("ok") else "FAIL"
        err = inner.get("error") or res.get("error") or ""
        extra = ""
        if "totalSegments" in inner:
            extra = f" totalSegments={inner['totalSegments']} kb={inner.get('kbEntries')} llm={inner.get('llmEntries')}"
        print(f"{name:34s} -> {status}{extra}" + (f"  err={str(err)[:90]}" if err else ""))
    else:
        print(f"{name:34s} -> {str(inner)[:110]}")

print("=== read-only / status channels ===")
show("ai:translate-dictionary-status", ipc("ai:translate-dictionary-status", []))
show("ai:translate-file-status", ipc("ai:translate-file-status", []))
show("home:translate-kb-list", ipc("home:translate-kb-list", []))
show("home:translate-kb-search", ipc("home:translate-kb-search", ["oxford"]))

print("\n=== dictionary build (KB-only) ===")
d = ipc("ai:translate-build-dictionary", [{
    "inputPath": DOCX, "sourceLang": "zh-CN", "targetLang": "en-US", "useLlm": False,
}])
show("ai:translate-build-dictionary", d)
dict_path = (d.get("result") or {}).get("dictionaryPath") if isinstance(d, dict) else None
print("   dictionaryPath:", dict_path)

print("\n=== dict status after build ===")
show("ai:translate-dictionary-status", ipc("ai:translate-dictionary-status", []))

print("\n=== snippet (KB-only, no provider => expect LLM error) ===")
show("home:translate-snippet", ipc("home:translate-snippet", [{
    "text": "产品验收报告", "targetLang": "en-US", "useDictionary": True,
}]))

print("\n=== file translate with the built dictionary ===")
if dict_path:
    show("ai:translate-file-auto", ipc("ai:translate-file-auto", [{
        "inputPath": DOCX, "targetLang": "en-US", "dictionaryPath": dict_path,
    }], timeout=180), )
else:
    print("   skipped (no dictionary)")

print("\n=== fill gaps ===")
if dict_path:
    show("ai:translate-fill-gaps", ipc("ai:translate-fill-gaps", [{
        "inputPath": DOCX, "targetLang": "en-US", "dictionaryPath": dict_path,
    }], timeout=180))
