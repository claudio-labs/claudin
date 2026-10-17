"""mitmdump addon for scripts/bench/ab/codex-wire-capture.ts.

Reads a recorded flow file offline (`mitmdump -nr <flows> -s <this> -q`) and
writes one JSON per Codex backend exchange into $CODEX_WIRE_OUT:

  <n>-<label>.json   an HTTP POST to /backend-api/codex/responses (Claudin)
  <n>-<label>.json   one `response.create` frame of a WebSocket (Codex CLI)

Each file holds the request body, the request headers with every credential
redacted, the response items (reasoning keeps only its encrypted_content
length) and the usage. The label is $CODEX_WIRE_LABEL when set (the runner
records one flow file per arm), else "codex" when the user-agent says
codex_exec and "claudin" otherwise. Nothing with a token is written: the flow
file is the only copy, and the runner deletes it.
"""

import json
import os

OUT = os.environ.get("CODEX_WIRE_OUT", "cap")
FORCED_LABEL = os.environ.get("CODEX_WIRE_LABEL")
SECRET_HEADERS = {"authorization", "cookie", "chatgpt-account-id", "set-cookie"}
counter = {"n": 0}


def _redact(headers):
    return {
        k: (f"<redacted len={len(v)}>" if k.lower() in SECRET_HEADERS else v)
        for k, v in headers.items()
    }


def _label(headers):
    if FORCED_LABEL:
        return FORCED_LABEL
    agent = headers.get("user-agent", "")
    return "codex" if "codex_exec" in agent or "codex_cli" in agent else "claudin"


def _summarize_item(item):
    out = {"type": item.get("type")}
    for key in ("id", "name", "phase", "role", "call_id"):
        if key in item:
            out[key] = item[key]
    if item.get("type") == "reasoning":
        out["encrypted_content_len"] = len(item.get("encrypted_content") or "")
    return out


def _usage(response):
    u = (response or {}).get("usage") or {}
    return {
        "input": u.get("input_tokens"),
        "cached": (u.get("input_tokens_details") or {}).get("cached_tokens"),
        "output": u.get("output_tokens"),
        "reasoning": (u.get("output_tokens_details") or {}).get("reasoning_tokens"),
    }


def _write(label, record):
    counter["n"] += 1
    os.makedirs(OUT, exist_ok=True)
    with open(os.path.join(OUT, f"{counter['n']:03d}-{label}.json"), "w") as f:
        json.dump(record, f, indent=1)


def _events(text):
    for chunk in text.replace("\r\n", "\n").split("\n\n"):
        data = "\n".join(line[6:] for line in chunk.split("\n") if line.startswith("data: "))
        if not data:
            continue
        try:
            yield json.loads(data)
        except ValueError:
            continue


def response(flow):
    if "/backend-api/codex/responses" not in flow.request.path or flow.request.method != "POST":
        return
    try:
        body = json.loads(flow.request.get_text() or "{}")
    except ValueError:
        return
    items, usage, completed_output = [], [], []
    for ev in _events(flow.response.get_text() or ""):
        if ev.get("type") == "response.output_item.done":
            items.append(_summarize_item(ev.get("item") or {}))
        if ev.get("type") == "response.completed":
            usage.append(_usage(ev.get("response")))
            completed_output.append(len((ev.get("response") or {}).get("output") or []))
    _write(_label(flow.request.headers), {
        "transport": "http",
        "status": flow.response.status_code,
        "headers": _redact(dict(flow.request.headers)),
        "body": body,
        "items": items,
        "usage": usage,
        "completed_output": completed_output,
    })


def websocket_end(flow):
    if "/backend-api/codex/responses" not in flow.request.path or not flow.websocket:
        return
    headers = _redact(dict(flow.request.headers))
    label = _label(flow.request.headers)
    pending = None
    for message in flow.websocket.messages:
        try:
            data = json.loads(message.text)
        except (ValueError, UnicodeDecodeError):
            continue
        if message.from_client and data.get("type") == "response.create":
            if pending:
                _write(label, pending)
            body = {k: v for k, v in data.items() if k != "type"}
            pending = {"transport": "websocket", "headers": headers, "body": body, "items": [], "usage": []}
        elif pending and not message.from_client:
            if data.get("type") == "response.output_item.done":
                pending["items"].append(_summarize_item(data.get("item") or {}))
            if data.get("type") == "response.completed":
                pending["usage"].append(_usage(data.get("response")))
    if pending:
        _write(label, pending)
