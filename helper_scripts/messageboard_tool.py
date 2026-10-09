#!/usr/bin/env python3
"""
Command-line tool for the messageboard API.

Usage:
  python messageboard_tool.py threads              -- list all active threads
  python messageboard_tool.py thread --json <id>   -- read a thread's posts (pretty JSON)
  python messageboard_tool.py thread <id>          -- read a thread's posts (formatted text)
  python messageboard_tool.py new --text "msg" [--signature "name"] [--secret "key"]
  python messageboard_tool.py reply --json <id> --text "msg" [--signature "name"] [--secret "key"]
  python messageboard_tool.py reply <id> --text "msg" [--signature "name"] [--secret "key"]
  python messageboard_tool.py delete <message_id> --secret "key"

API endpoints (hosted on localhost:3000):
  GET  /api/threads              — list active threads
  GET  /api/thread/:threadId     — get all messages in a thread
  POST /api/thread               — create a new thread
  POST /api/thread/:id/reply     — reply to a thread
  POST /api/delete/:messageId    — delete a message (requires tripcode secret)
"""

import argparse
import json
import sys
import urllib.request
import urllib.error

BASE = "http://localhost:3000"


def api_get(path: str) -> list | dict:
    url = f"{BASE}{path}"
    req = urllib.request.Request(url)
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read().decode())


def api_post(path: str, data: dict, file_path: str | None = None):
    url = f"{BASE}{path}"
    if file_path:
        # multipart form (file upload)
        import email.mime
        # Simple multipart via urllib
        import uuid, os
        boundary = uuid.uuid4().hex
        body = b""
        for k, v in data.items():
            body += f"--{boundary}\r\nContent-Disposition: form-data; name=\"{k}\"\r\n\r\n{v}\r\n".encode()
        fname = os.path.basename(file_path)
        with open(file_path, "rb") as f:
            raw = f.read()
        body += f"--{boundary}\r\nContent-Disposition: form-data; name=\"media\"; filename=\"{fname}\"\r\nContent-Type: application/octet-stream\r\n\r\n".encode()
        body += raw
        body += f"\r\n--{boundary}--\r\n".encode()

        req = urllib.request.Request(url, data=body)
        req.add_header("Content-Type", f"multipart/form-data; boundary={boundary}")
    else:
        body = json.dumps(data).encode()
        req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"})

    try:
        with urllib.request.urlopen(req) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        return {"error": e.read().decode()}


def cmd_threads(_args):
    threads = api_get("/api/threads")
    for t in threads:
        print(f"[{t['threadId']}] ({t['messageCount']} msgs) {t['lastBump'][:10]} — {t['signature']}: {t['text'][:120]}")
    print(f"\n{len(threads)} threads total.")


def cmd_thread_read(args):
    tid = args.thread_id
    messages = api_get(f"/api/thread/{tid}")
    if args.json:
        print(json.dumps(messages, indent=2, ensure_ascii=False))
    else:
        # Format as readable text
        for m in messages:
            sig = m['signature'] or 'Anonymous'
            hash_part = f" [{m['hash']}]" if m.get('hash') else ""
            media = f"\n  📎 {m['mediaUrl']}" if m.get('mediaUrl') else ""
            thumb = f" 🖼 {m['thumbnailUrl']}" if m.get('thumbnailUrl') else ""
            is_head = m.get('isHeadPost')
            prefix = ">> " if is_head else "  "
            print(f"{prefix}{m['id']}| {m['timestamp'][:10]} {sig}{hash_part}")
            print(f"   {m['text']}")
            print(f"   {media}{thumb}")
            print()


def cmd_new(args):
    data = {"text": args.text, "signature": args.signature or "Anonymous"}
    if args.secret:
        data["secret"] = args.secret
    result = api_post("/api/thread", data)
    print(json.dumps(result, indent=2))


def cmd_reply(args):
    data = {"text": args.text, "signature": args.signature or "Anonymous"}
    if args.secret:
        data["secret"] = args.secret
    result = api_post(f"/api/thread/{args.thread_id}/reply", data)
    if args.json:
        print(json.dumps(result, indent=2))
    else:
        if "error" in result:
            print(f"Error: {result['error']}")
        else:
            msg = result.get("message")
            mid = msg["id"] if isinstance(msg, dict) else result.get("id", "?")
            print(f"Posted! Message ID: {mid}")


def cmd_delete(args):
    data = {"secret": args.secret}
    result = api_post(f"/api/delete/{args.message_id}", data)
    print(json.dumps(result, indent=2))


def main():
    parser = argparse.ArgumentParser(description="Messageboard CLI tool")
    sub = parser.add_subparsers(dest="command")

    # threads
    sub.add_parser("threads", help="List all active threads")

    # thread read
    t_parser = sub.add_parser("thread", help="Read a thread")
    t_parser.add_argument("thread_id", type=int, help="Thread ID")
    t_parser.add_argument("--json", action="store_true", help="Output raw JSON")

    # new thread
    n_parser = sub.add_parser("new", help="Create a new thread")
    n_parser.add_argument("--text", required=True, help="Post text")
    n_parser.add_argument("--signature", default="Anonymous", help="Your signature/name")
    n_parser.add_argument("--secret", default=None, help="Secret key for tripcode (optional)")

    # reply
    r_parser = sub.add_parser("reply", help="Reply to a thread")
    r_parser.add_argument("thread_id", type=int, help="Thread ID")
    r_parser.add_argument("--text", required=True, help="Reply text")
    r_parser.add_argument("--signature", default="Anonymous", help="Your signature/name")
    r_parser.add_argument("--secret", default=None, help="Secret key for tripcode (optional)")
    r_parser.add_argument("--json", action="store_true", help="Output raw JSON")

    # delete
    d_parser = sub.add_parser("delete", help="Delete a message")
    d_parser.add_argument("message_id", type=int, help="Message ID")
    d_parser.add_argument("--secret", required=True, help="Secret key for tripcode")

    args = parser.parse_args()

    if not args.command:
        parser.print_help()
        sys.exit(1)

    commands = {
        "threads": cmd_threads,
        "thread": cmd_thread_read,
        "new": cmd_new,
        "reply": cmd_reply,
        "delete": cmd_delete,
    }
    commands[args.command](args)


if __name__ == "__main__":
    main()
