"""Offline mitmdump addon: every WebSocket frame on a Responses route, both directions, timed.

  mitmdump -nr <flows> -s scripts/bench/ab/codex-ws-frames.py -q    (WS_OUT=<dir>)

Writes <dir>/conn-<n>.json per WebSocket connection: the upgrade request and
101 response headers (credentials redacted), the close code, and one entry per
frame with its time since the first frame, its size, and what it carries:
client `response.create` frames list `previous_response_id`, their input
items and every other body field (tools and instructions as byte counts);
server frames name their event, the response id, and on completion its
output items and usage (input / cached / output / reasoning tokens).
Non-WebSocket requests are listed in <dir>/http.json.

The 2026-10-17 Codex CLI capture (read + edit, then a resume) is summarized in
the team memory `codex-0.162-wire-diff`. codex-wire-dump.py answers the body
questions per request; this one answers the transport ones (deltas, timing,
the events only a socket sends). The flow file holds the bearer token: delete
it once decoded.
"""

import json
import os

OUT = os.environ.get("WS_OUT", "ws-out")
SECRET = {"authorization", "cookie", "set-cookie", "chatgpt-account-id"}
OPAQUE = {"x-codex-turn-state"}
counter = {"n": 0}
other = []


def _redact(headers):
    return {k: (f"<redacted len={len(v)}>" if k.lower() in SECRET else v) for k, v in headers.items()}


def _redact_opaque(value):
    if isinstance(value, dict):
        return {k: (f"<len={len(str(v))}>" if k.lower() in OPAQUE else _redact_opaque(v)) for k, v in value.items()}
    return value


def _item(item):
    out = {"type": item.get("type")}
    for key in ("id", "role", "phase", "call_id", "name", "status"):
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


def _client(data, size):
    body = {k: v for k, v in data.items() if k not in ("type", "input", "tools", "instructions")}
    for big in ("tools", "instructions"):
        if big in data:
            body[big] = f"<{len(json.dumps(data[big]))} bytes>"
    return {
        "type": data.get("type"),
        "bytes": size,
        "previous_response_id": data.get("previous_response_id"),
        "input_items": [_item(i) for i in data.get("input") or []],
        "fields": body,
    }


def _server(data, size):
    t = data.get("type")
    out = {"type": t, "bytes": size}
    if t in ("response.created", "response.in_progress"):
        out["response_id"] = (data.get("response") or {}).get("id")
    if t in ("response.output_item.added", "response.output_item.done"):
        out["item"] = _item(data.get("item") or {})
    if t in ("response.completed", "response.incomplete", "response.failed"):
        r = data.get("response") or {}
        out["response_id"] = r.get("id")
        out["status"] = r.get("status")
        out["usage"] = _usage(r)
        out["output"] = [_item(i) for i in r.get("output") or []]
    if t == "error" or t.startswith("codex.") or t in ("response.metadata", "responsesapi.websocket_timing"):
        out["data"] = _redact_opaque(data)
    return out


def websocket_end(flow):
    if not flow.websocket:
        return
    counter["n"] += 1
    msgs = flow.websocket.messages
    t0 = msgs[0].timestamp if msgs else 0
    entries = []
    for m in msgs:
        raw = m.content or b""
        base = {"t_ms": round((m.timestamp - t0) * 1000), "dir": "C" if m.from_client else "S"}
        try:
            data = json.loads(raw)
        except (ValueError, UnicodeDecodeError):
            entries.append({**base, "bytes": len(raw), "nonjson": True})
            continue
        entries.append({**base, **(_client(data, len(raw)) if m.from_client else _server(data, len(raw)))})
    record = {
        "url": flow.request.pretty_url,
        "request_headers": _redact(dict(flow.request.headers)),
        "response_status": flow.response.status_code if flow.response else None,
        "response_headers": _redact(dict(flow.response.headers)) if flow.response else None,
        "close_code": flow.websocket.close_code,
        "close_reason": flow.websocket.close_reason,
        "closed_by_client": flow.websocket.closed_by_client,
        "messages": entries,
    }
    os.makedirs(OUT, exist_ok=True)
    with open(os.path.join(OUT, f"conn-{counter['n']}.json"), "w") as f:
        json.dump(record, f, indent=1)


def response(flow):
    if flow.websocket:
        return
    other.append({
        "method": flow.request.method,
        "url": flow.request.pretty_url.split("?")[0],
        "status": flow.response.status_code if flow.response else None,
    })


def done():
    os.makedirs(OUT, exist_ok=True)
    with open(os.path.join(OUT, "http.json"), "w") as f:
        json.dump(other, f, indent=1)
