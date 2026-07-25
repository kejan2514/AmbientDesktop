#!/usr/bin/env python3
"""Live Ambient fixture for long streamed tool-call arguments.

This intentionally uses only the Python standard library. It calls Ambient's
OpenAI-compatible /chat/completions endpoint with a forced dummy `write` tool,
streams the response, records tool-call argument growth, and writes a redacted
evidence bundle that can be shared with provider engineers.

Example:
  python3 scripts/ambient_long_tool_call_stream_fixture.py \
    --api-key-file /path/to/ignored-provider-key-file.txt \
    --requested-content-chars 24000
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import socket
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any


DEFAULT_BASE_URL = "https://api.ambient.xyz/v1"
DEFAULT_MODEL = "example/model-id"
DEFAULT_OUTPUT_DIR = Path("test-results/ambient-long-tool-call-stream-fixture")


def utc_now() -> str:
    return dt.datetime.now(dt.UTC).isoformat().replace("+00:00", "Z")


def normalize_base_url(value: str) -> str:
    trimmed = value.strip().rstrip("/")
    if not trimmed:
        return DEFAULT_BASE_URL
    if trimmed.endswith("/v1"):
        return trimmed
    return f"{trimmed}/v1"


def read_api_key(args: argparse.Namespace) -> str:
    if args.api_key:
        return args.api_key.strip()
    if args.api_key_file:
        return Path(args.api_key_file).read_text(encoding="utf-8").strip()
    return os.environ.get("AMBIENT_API_KEY", "").strip() or os.environ.get("AMBIENT_AGENT_AMBIENT_API_KEY", "").strip()


def apply_reasoning_mode(body: dict[str, Any], mode: str) -> None:
    if mode == "off":
        body["thinking"] = {"type": "disabled"}
        body["reasoning"] = {"effort": "none", "enabled": False, "exclude": True}
        body["enable_thinking"] = False
    elif mode != "on":
        raise ValueError(f"Unsupported reasoning mode: {mode}")


def build_payload(args: argparse.Namespace) -> dict[str, Any]:
    prompt = (
        "Call the write tool exactly once. Use path ambient-long-tool-call-fixture.md. "
        f"The content argument must be at least {args.requested_content_chars} characters. "
        "Use plain ASCII text with numbered sections about validating a long streamed tool-call argument. "
        "Do not answer in prose; the only useful output is the tool call."
    )
    body: dict[str, Any] = {
        "model": args.model,
        "stream": True,
        "temperature": args.temperature,
        "max_tokens": args.max_tokens,
        "messages": [
            {
                "role": "system",
                "content": (
                    "You are a provider reliability fixture. You must exercise streamed tool-call arguments, "
                    "not normal assistant text."
                ),
            },
            {"role": "user", "content": prompt},
        ],
        "tools": [
            {
                "type": "function",
                "function": {
                    "name": "write",
                    "description": "Dummy fixture tool. The client will not execute it; it only records streamed arguments.",
                    "parameters": {
                        "type": "object",
                        "additionalProperties": False,
                        "required": ["path", "content"],
                        "properties": {
                            "path": {"type": "string"},
                            "content": {"type": "string"},
                        },
                    },
                },
            }
        ],
        "tool_choice": {"type": "function", "function": {"name": "write"}},
    }
    apply_reasoning_mode(body, args.reasoning)
    return body


def redact_request(body: dict[str, Any]) -> dict[str, Any]:
    return json.loads(json.dumps(body))


def set_response_idle_timeout(response: Any, timeout_seconds: float) -> None:
    try:
        response.fp.raw._sock.settimeout(timeout_seconds)
    except Exception:
        pass


def process_chunk(chunk: dict[str, Any], state: dict[str, Any]) -> None:
    if "error" in chunk:
        state["provider_errors"].append(chunk["error"])
    choices = chunk.get("choices")
    if not isinstance(choices, list):
        return
    for choice in choices:
        if not isinstance(choice, dict):
            continue
        finish_reason = choice.get("finish_reason")
        if finish_reason:
            state["finish_reasons"].append(finish_reason)
        delta = choice.get("delta")
        if not isinstance(delta, dict):
            continue
        content = delta.get("content")
        if isinstance(content, str):
            state["assistant_content_chars"] += len(content)
        tool_calls = delta.get("tool_calls")
        if not isinstance(tool_calls, list):
            continue
        for tool_call in tool_calls:
            if not isinstance(tool_call, dict):
                continue
            index = int(tool_call.get("index") or 0)
            calls = state["tool_calls"]
            call = calls.setdefault(index, {"id": "", "name": "", "arguments": ""})
            if isinstance(tool_call.get("id"), str):
                call["id"] = tool_call["id"]
            function = tool_call.get("function")
            if isinstance(function, dict):
                if isinstance(function.get("name"), str):
                    call["name"] = function["name"]
                if isinstance(function.get("arguments"), str):
                    call["arguments"] += function["arguments"]
                    state["argument_delta_events"] += 1
                    state["max_observed_argument_chars"] = max(
                        state["max_observed_argument_chars"],
                        len(call["arguments"]),
                    )


def stream_ambient(args: argparse.Namespace, body: dict[str, Any], out_dir: Path) -> dict[str, Any]:
    api_key = read_api_key(args)
    if not api_key:
        raise SystemExit("Set AMBIENT_API_KEY, AMBIENT_AGENT_AMBIENT_API_KEY, pass --api-key-file, or pass --api-key.")

    request = urllib.request.Request(
        f"{normalize_base_url(args.base_url)}/chat/completions",
        data=json.dumps(body).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "Accept": "text/event-stream",
        },
        method="POST",
    )

    state: dict[str, Any] = {
        "started_at": utc_now(),
        "completed_at": None,
        "done": False,
        "http_status": None,
        "stream_event_count": 0,
        "json_chunk_count": 0,
        "argument_delta_events": 0,
        "assistant_content_chars": 0,
        "max_observed_argument_chars": 0,
        "finish_reasons": [],
        "provider_errors": [],
        "exception": None,
        "tool_calls": {},
    }

    chunks_path = out_dir / "stream-chunks.jsonl"
    first_byte_at: float | None = None
    last_event_at: float | None = None

    try:
        with urllib.request.urlopen(request, timeout=args.pre_stream_timeout_seconds) as response:
            state["http_status"] = response.status
            set_response_idle_timeout(response, args.stream_idle_timeout_seconds)
            with chunks_path.open("w", encoding="utf-8") as chunks_file:
                while True:
                    raw = response.readline()
                    now = time.monotonic()
                    if raw == b"":
                        break
                    if first_byte_at is None:
                        first_byte_at = now
                    line = raw.decode("utf-8", errors="replace").strip()
                    if not line or line.startswith(":"):
                        continue
                    if not line.startswith("data:"):
                        continue
                    data = line[5:].strip()
                    state["stream_event_count"] += 1
                    last_event_at = now
                    if data == "[DONE]":
                        state["done"] = True
                        break
                    try:
                        chunk = json.loads(data)
                    except json.JSONDecodeError:
                        state["provider_errors"].append({"type": "invalid_json_sse_data", "preview": data[:500]})
                        continue
                    state["json_chunk_count"] += 1
                    chunks_file.write(json.dumps(chunk, sort_keys=True) + "\n")
                    process_chunk(chunk, state)
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")
        state["http_status"] = error.code
        state["exception"] = {"type": "HTTPError", "message": f"{error.code} {error.reason}", "detail_preview": detail[:1000]}
    except (urllib.error.URLError, socket.timeout, TimeoutError, OSError) as error:
        state["exception"] = {"type": type(error).__name__, "message": str(error)}
    finally:
        state["completed_at"] = utc_now()
        state["first_byte_seen"] = first_byte_at is not None
        state["last_event_seen"] = last_event_at is not None

    return state


def summarize(args: argparse.Namespace, body: dict[str, Any], state: dict[str, Any], out_dir: Path) -> tuple[dict[str, Any], int]:
    tool_calls = state.get("tool_calls") if isinstance(state.get("tool_calls"), dict) else {}
    first_call = tool_calls.get(0) if isinstance(tool_calls, dict) else None
    arguments = first_call.get("arguments", "") if isinstance(first_call, dict) else ""
    args_path = out_dir / "tool-arguments.partial.json"
    args_path.write_text(arguments, encoding="utf-8")

    parsed_arguments: Any = None
    parsed_error: str | None = None
    content_chars = 0
    try:
        parsed_arguments = json.loads(arguments) if arguments else None
        if isinstance(parsed_arguments, dict) and isinstance(parsed_arguments.get("content"), str):
            content_chars = len(parsed_arguments["content"])
    except json.JSONDecodeError as error:
        parsed_error = str(error)

    summary = {
        "fixture": "ambient_long_tool_call_stream_fixture",
        "base_url": normalize_base_url(args.base_url),
        "model": args.model,
        "requested_content_chars": args.requested_content_chars,
        "expected_min_argument_chars": args.expected_min_argument_chars,
        "pre_stream_timeout_seconds": args.pre_stream_timeout_seconds,
        "stream_idle_timeout_seconds": args.stream_idle_timeout_seconds,
        "state": {key: value for key, value in state.items() if key != "tool_calls"},
        "tool_call": {
            "id": first_call.get("id") if isinstance(first_call, dict) else "",
            "name": first_call.get("name") if isinstance(first_call, dict) else "",
            "argument_chars": len(arguments),
            "argument_sha256": hashlib.sha256(arguments.encode("utf-8")).hexdigest() if arguments else "",
            "argument_parse_error": parsed_error,
            "content_chars": content_chars,
        },
        "request_path": str(out_dir / "request.redacted.json"),
        "chunks_path": str(out_dir / "stream-chunks.jsonl"),
        "tool_arguments_path": str(args_path),
        "summary_path": str(out_dir / "summary.json"),
    }

    if state.get("exception") or state.get("provider_errors"):
        exit_code = 4 if len(arguments) >= args.expected_min_argument_chars else 3
    elif not state.get("done"):
        exit_code = 4 if len(arguments) >= args.expected_min_argument_chars else 3
    elif parsed_error:
        exit_code = 2
    elif content_chars < args.requested_content_chars:
        exit_code = 2
    else:
        exit_code = 0

    (out_dir / "request.redacted.json").write_text(json.dumps(redact_request(body), indent=2, sort_keys=True), encoding="utf-8")
    (out_dir / "summary.json").write_text(json.dumps(summary, indent=2, sort_keys=True), encoding="utf-8")
    return summary, exit_code


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--api-key", help="Ambient API key. Prefer --api-key-file or env vars for local use.")
    parser.add_argument("--api-key-file", help="Path to a file containing the Ambient API key.")
    parser.add_argument("--base-url", default=DEFAULT_BASE_URL, help=f"Ambient base URL. Default: {DEFAULT_BASE_URL}")
    parser.add_argument("--model", default=DEFAULT_MODEL, help=f"Ambient model. Default: {DEFAULT_MODEL}")
    parser.add_argument("--reasoning", choices=["off", "on"], default="off", help="Whether to allow provider-default reasoning.")
    parser.add_argument("--requested-content-chars", type=int, default=24_000, help="Requested size of the write.content argument.")
    parser.add_argument("--expected-min-argument-chars", type=int, default=16_000, help="Threshold for classifying an interrupted stream as the target failure mode.")
    parser.add_argument("--max-tokens", type=int, default=12_000, help="Maximum completion tokens.")
    parser.add_argument("--temperature", type=float, default=0.0, help="Sampling temperature.")
    parser.add_argument("--pre-stream-timeout-seconds", type=float, default=60.0, help="Timeout for response headers / first bytes.")
    parser.add_argument("--stream-idle-timeout-seconds", type=float, default=120.0, help="Socket timeout while reading SSE lines.")
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT_DIR, help=f"Evidence output directory. Default: {DEFAULT_OUTPUT_DIR}")
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    run_id = dt.datetime.now(dt.UTC).strftime("%Y%m%dT%H%M%SZ")
    out_dir = args.output_dir / run_id
    out_dir.mkdir(parents=True, exist_ok=True)

    body = build_payload(args)
    state = stream_ambient(args, body, out_dir)
    summary, exit_code = summarize(args, body, state, out_dir)

    print(json.dumps({
        "exit_code": exit_code,
        "done": state.get("done"),
        "exception": state.get("exception"),
        "provider_errors": state.get("provider_errors"),
        "stream_event_count": state.get("stream_event_count"),
        "max_observed_argument_chars": state.get("max_observed_argument_chars"),
        "tool_call": summary["tool_call"],
        "summary_path": summary["summary_path"],
    }, indent=2, sort_keys=True))
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
