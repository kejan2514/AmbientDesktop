#!/usr/bin/env python3
"""Reproduce the Pi/Ambient empty terminal assistant event from saved session logs.

The default scenario replays the Kokoro install thread that ended with:

1. assistant `edit` tool call
2. successful `edit` tool result
3. Ambient's post-tool continuation prompt
4. empty aborted assistant event in the original session log

This script does not execute tools. It converts the recorded Pi JSONL history up
to the continuation prompt into an OpenAI-compatible Ambient streaming request,
then records whether the live provider again returns no assistant text/tool call.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import pathlib
import sys
import time
import urllib.error
import urllib.request
import uuid
from typing import Any


REPO_ROOT = pathlib.Path(__file__).resolve().parents[1]
DEFAULT_BASE_URL = "https://api.ambient.xyz/v1"
DEFAULT_MODEL = "example/model-id"
DEFAULT_SESSION_LOG = pathlib.Path(
    "/Users/example/.ambient-hardening/bases/example-core-no-secrets/"
    "workspace/.ambient-codex/sessions/fb1c7ffc-732d-421c-a429-c66c4628bf60/"
    "2026-05-14T23-55-00-533Z_019e28ea-3e35-71f1-a6f9-5233bcce0cac.jsonl"
)
CONTINUATION_PREFIX = "Ambient completed the most recent tool call, but no assistant-visible response followed."


def read_api_key() -> str:
    for name in ("AMBIENT_API_KEY", "AMBIENT_AGENT_AMBIENT_API_KEY"):
        value = os.environ.get(name, "").strip()
        if value:
            return value
    candidates = [
        os.environ.get("AMBIENT_API_KEY_FILE", ""),
        str(REPO_ROOT / "ignored-provider-key-file.txt"),
        str(REPO_ROOT.parent / "ignored-provider-key-file.txt"),
        "/Users/example/Documents/ambientCoder/ignored-provider-key-file.txt",
        "/Users/example/Documents/New project 3/ignored-provider-key-file.txt",
        str(pathlib.Path.home() / "ignored-provider-key-file.txt"),
    ]
    for raw in candidates:
        if not raw:
            continue
        path = pathlib.Path(raw).expanduser()
        if path.exists():
            value = path.read_text(encoding="utf-8").strip()
            if value:
                return value
    raise SystemExit("Ambient API key missing. Set AMBIENT_API_KEY or provide ignored-provider-key-file.txt.")


def text_from_content(content: Any) -> str:
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    parts: list[str] = []
    for block in content:
        if isinstance(block, dict) and block.get("type") == "text":
            parts.append(str(block.get("text", "")))
    return "\n".join(part for part in parts if part)


def load_jsonl(path: pathlib.Path) -> list[dict[str, Any]]:
    entries: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as handle:
        for line_no, line in enumerate(handle, 1):
            if not line.strip():
                continue
            try:
                entries.append(json.loads(line))
            except json.JSONDecodeError as error:
                raise SystemExit(f"Could not parse {path}:{line_no}: {error}") from error
    return entries


def find_repro_cut(entries: list[dict[str, Any]]) -> tuple[int, int | None]:
    """Return (continuation entry index inclusive, aborted assistant index)."""
    fallback: tuple[int, int | None] | None = None
    for index, entry in enumerate(entries):
        message = entry.get("message") or {}
        if message.get("role") != "user":
            continue
        if text_from_content(message.get("content", "")).startswith(CONTINUATION_PREFIX):
            aborted_index = None
            if index + 1 < len(entries):
                next_message = entries[index + 1].get("message") or {}
                if next_message.get("role") == "assistant" and next_message.get("stopReason") == "aborted":
                    aborted_index = index + 1
                    return index, aborted_index
            fallback = (index, aborted_index)
    if fallback is not None:
        return fallback
    raise SystemExit(f"No post-tool continuation prompt found in {DEFAULT_SESSION_LOG}")


def convert_entries_to_chat(entries: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    messages: list[dict[str, Any]] = []
    tool_names: set[str] = set()

    for entry in entries:
        if entry.get("type") == "custom_message":
            content = text_from_content(entry.get("content", ""))
            if content:
                messages.append({"role": "user", "content": content})
            continue

        if entry.get("type") != "message":
            continue

        message = entry.get("message") or {}
        role = message.get("role")
        content = message.get("content") or []

        if role == "user":
            text = text_from_content(content)
            if text:
                messages.append({"role": "user", "content": text})
            continue

        if role == "assistant":
            if message.get("stopReason") in {"aborted", "error"}:
                continue
            text_parts: list[str] = []
            tool_calls: list[dict[str, Any]] = []
            for block in content:
                if not isinstance(block, dict):
                    continue
                if block.get("type") == "text":
                    text = str(block.get("text", ""))
                    if text.strip():
                        text_parts.append(text)
                elif block.get("type") == "toolCall":
                    name = str(block.get("name", "tool"))
                    tool_names.add(name)
                    tool_calls.append(
                        {
                            "id": str(block.get("id", f"call_{uuid.uuid4().hex[:24]}")),
                            "type": "function",
                            "function": {
                                "name": name,
                                "arguments": json.dumps(block.get("arguments") or {}, ensure_ascii=False),
                            },
                        }
                    )
            assistant: dict[str, Any] = {"role": "assistant", "content": "".join(text_parts) or None}
            if tool_calls:
                assistant["tool_calls"] = tool_calls
            if assistant["content"] is not None or tool_calls:
                messages.append(assistant)
            continue

        if role == "toolResult":
            tool_name = str(message.get("toolName", "tool"))
            tool_names.add(tool_name)
            messages.append(
                {
                    "role": "tool",
                    "tool_call_id": str(message.get("toolCallId", "")),
                    "content": text_from_content(content) or "(no output)",
                }
            )

    tools = [
        {
            "type": "function",
            "function": {
                "name": name,
                "description": f"Recorded Ambient/Pi tool from the repro session: {name}.",
                "parameters": {"type": "object", "properties": {}, "additionalProperties": True},
            },
        }
        for name in sorted(tool_names)
    ]
    return messages, tools


def trim_for_tail(entries: list[dict[str, Any]], continuation_index: int, tail_messages: int | None) -> list[dict[str, Any]]:
    selected = entries[: continuation_index + 1]
    if tail_messages is None or tail_messages <= 0:
        return selected

    message_seen = 0
    cut = 0
    for index in range(len(selected) - 1, -1, -1):
        if selected[index].get("type") in {"message", "custom_message"}:
            message_seen += 1
        if message_seen >= tail_messages:
            cut = index
            break
    return selected[cut:]


def stream_ambient(
    *,
    api_key: str,
    base_url: str,
    model: str,
    messages: list[dict[str, Any]],
    tools: list[dict[str, Any]],
    max_completion_tokens: int,
    timeout_seconds: int,
    session_id: str,
) -> tuple[dict[str, Any], list[str]]:
    payload: dict[str, Any] = {
        "model": model,
        "messages": messages,
        "tools": tools,
        "stream": True,
        "stream_options": {"include_usage": True},
        "tool_stream": True,
        "enable_thinking": True,
        "max_completion_tokens": max_completion_tokens,
    }
    request = urllib.request.Request(
        f"{base_url.rstrip('/')}/chat/completions",
        data=json.dumps(payload).encode("utf-8"),
        method="POST",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "Accept": "text/event-stream",
            "x-client-request-id": session_id,
        },
    )

    content_chars = 0
    reasoning_chars = 0
    tool_call_chars = 0
    finish_reasons: list[str] = []
    usage: Any = None
    chunks = 0
    raw_lines: list[str] = []
    started = time.monotonic()
    error: str | None = None

    try:
        with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
            for raw in response:
                line = raw.decode("utf-8", errors="replace").rstrip("\r\n")
                if not line:
                    continue
                raw_lines.append(line)
                if not line.startswith("data:"):
                    continue
                data = line[5:].strip()
                if data == "[DONE]":
                    break
                try:
                    event = json.loads(data)
                except json.JSONDecodeError:
                    continue
                chunks += 1
                if event.get("usage"):
                    usage = event["usage"]
                for choice in event.get("choices") or []:
                    finish = choice.get("finish_reason")
                    if finish:
                        finish_reasons.append(str(finish))
                    delta = choice.get("delta") or {}
                    content = delta.get("content")
                    if isinstance(content, str):
                        content_chars += len(content)
                    for key in ("reasoning", "reasoning_content", "reasoning_text"):
                        value = delta.get(key)
                        if isinstance(value, str):
                            reasoning_chars += len(value)
                    for tool_call in delta.get("tool_calls") or []:
                        function = tool_call.get("function") or {}
                        tool_call_chars += len(str(tool_call.get("id") or ""))
                        tool_call_chars += len(str(function.get("name") or ""))
                        tool_call_chars += len(str(function.get("arguments") or ""))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        error = f"HTTP {exc.code}: {body[:2000]}"
    except Exception as exc:  # noqa: BLE001 - repro harness should record raw failure
        error = repr(exc)

    elapsed_ms = round((time.monotonic() - started) * 1000)
    summary = {
        "sessionId": session_id,
        "elapsedMs": elapsed_ms,
        "chunks": chunks,
        "contentChars": content_chars,
        "reasoningChars": reasoning_chars,
        "toolCallChars": tool_call_chars,
        "finishReasons": finish_reasons,
        "usage": usage,
        "error": error,
        "emptyTerminalLike": (not error and chunks > 0 and content_chars == 0 and reasoning_chars == 0 and tool_call_chars == 0),
        "abortedLike": bool(error and "abort" in error.lower()),
    }
    return summary, raw_lines


def write_json(path: pathlib.Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--session-log", type=pathlib.Path, default=DEFAULT_SESSION_LOG)
    parser.add_argument("--base-url", default=os.environ.get("AMBIENT_BASE_URL") or os.environ.get("AMBIENT_AGENT_AMBIENT_BASE_URL") or DEFAULT_BASE_URL)
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--tail-messages", type=int, default=0, help="Use only the last N session message/custom entries before the continuation; 0 keeps full history.")
    parser.add_argument("--repeat", type=int, default=1)
    parser.add_argument("--max-completion-tokens", type=int, default=2048)
    parser.add_argument("--timeout-seconds", type=int, default=300)
    parser.add_argument("--out-dir", type=pathlib.Path, default=REPO_ROOT / ".ambient" / "repros" / "pi-empty-terminal")
    args = parser.parse_args()

    api_key = read_api_key()
    entries = load_jsonl(args.session_log)
    continuation_index, aborted_index = find_repro_cut(entries)
    selected_entries = trim_for_tail(entries, continuation_index, args.tail_messages)
    messages, tools = convert_entries_to_chat(selected_entries)

    stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    out_dir = args.out_dir / stamp
    out_dir.mkdir(parents=True, exist_ok=True)
    write_json(
        out_dir / "repro-input-summary.json",
        {
            "sourceSessionLog": str(args.session_log),
            "continuationLine": continuation_index + 1,
            "originalAbortedLine": None if aborted_index is None else aborted_index + 1,
            "selectedEntries": len(selected_entries),
            "chatMessages": len(messages),
            "tools": [tool["function"]["name"] for tool in tools],
            "tailMessages": args.tail_messages,
            "baseUrl": args.base_url,
            "model": args.model,
        },
    )
    write_json(out_dir / "payload.redacted.json", {"model": args.model, "messages": messages, "tools": tools, "stream": True})

    print(f"Repro source: {args.session_log}")
    print(f"Continuation line: {continuation_index + 1}; original aborted line: {None if aborted_index is None else aborted_index + 1}")
    print(f"Sending {len(messages)} chat messages with {len(tools)} recorded tool schemas.")
    print(f"Artifacts: {out_dir}")

    results: list[dict[str, Any]] = []
    for attempt in range(1, args.repeat + 1):
        session_id = f"pi-empty-terminal-repro-{stamp}-{attempt}-{uuid.uuid4().hex[:8]}"
        summary, raw_lines = stream_ambient(
            api_key=api_key,
            base_url=args.base_url,
            model=args.model,
            messages=messages,
            tools=tools,
            max_completion_tokens=args.max_completion_tokens,
            timeout_seconds=args.timeout_seconds,
            session_id=session_id,
        )
        summary["attempt"] = attempt
        results.append(summary)
        write_json(out_dir / f"attempt-{attempt:02d}-summary.json", summary)
        (out_dir / f"attempt-{attempt:02d}-raw-sse.txt").write_text("\n".join(raw_lines) + "\n", encoding="utf-8")
        print(
            f"attempt {attempt}: chunks={summary['chunks']} content={summary['contentChars']} "
            f"reasoning={summary['reasoningChars']} tools={summary['toolCallChars']} "
            f"finish={summary['finishReasons']} emptyTerminalLike={summary['emptyTerminalLike']} "
            f"error={summary['error']!r}"
        )

    write_json(out_dir / "summary.json", {"results": results})
    reproduced = any(result["emptyTerminalLike"] or result["abortedLike"] for result in results)
    print(f"reproduced_empty_or_aborted={reproduced}")
    return 2 if reproduced else 0


if __name__ == "__main__":
    raise SystemExit(main())
