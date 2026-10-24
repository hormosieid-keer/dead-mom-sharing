"""Loopback HTTP -> SMTP alert bridge. No external Python dependencies."""
import argparse
import hmac
import json
import logging
import os
import re
import smtplib
import socket
import sqlite3
import ssl
import threading
from contextlib import closing
from dataclasses import dataclass
from email.message import EmailMessage
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Callable

from .config import ROOT, load_env

LOG = logging.getLogger("douyin.mail")
MAX_BODY = 8192
EXTENSION_ORIGIN = re.compile(r"chrome-extension://[a-p]{32}\Z")


@dataclass(frozen=True)
class MailConfig:
    token: str
    host: str = ""
    port: int = 465
    security: str = "ssl"
    username: str = ""
    password: str = ""
    sender: str = ""
    recipient: str = ""
    state_path: Path = ROOT / "data" / "alerts.sqlite3"

    @property
    def configured(self):
        return bool(len(self.token) >= 32 and self.host and self.sender and self.recipient
                    and self.security in ("ssl", "starttls")
                    and (not self.username or self.password))

    @classmethod
    def from_env(cls):
        return cls(
            token=os.getenv("BOT_BRIDGE_TOKEN", ""), host=os.getenv("SMTP_HOST", ""),
            port=int(os.getenv("SMTP_PORT", "465")), security=os.getenv("SMTP_SECURITY", "ssl"),
            username=os.getenv("SMTP_USER", ""), password=os.getenv("SMTP_PASSWORD", ""),
            sender=os.getenv("SMTP_FROM", ""), recipient=os.getenv("ALERT_EMAIL_TO", ""),
            state_path=Path(os.getenv("BOT_DATA_DIR", str(ROOT / "data"))) / "alerts.sqlite3",
        )


def send_smtp(config: MailConfig, alert: dict):
    message = EmailMessage()
    message["Subject"] = "司凤转发已暂停：需要人工处理"
    message["From"] = config.sender
    message["To"] = config.recipient
    message.set_content(
        "司凤转发已暂停。请核对账号状态和待确认发送记录，再在插件中手动恢复。\n\n"
        f"事件：{alert['incidentId']}\n时间：{alert['at']}\n"
        f"账号：{alert['accountName']}\n原因：{alert['reason']}\n"
    )
    tls = ssl.create_default_context()
    if config.security == "ssl":
        client = smtplib.SMTP_SSL(config.host, config.port, timeout=15, context=tls)
    elif config.security == "starttls":
        client = smtplib.SMTP(config.host, config.port, timeout=15)
    else:
        raise ValueError("SMTP security must be ssl or starttls")
    with client as client:
        if config.security == "starttls":
            client.ehlo()
            client.starttls(context=tls)
            client.ehlo()
        if config.username:
            client.login(config.username, config.password)
        refused = client.send_message(message)
        if refused:
            raise smtplib.SMTPRecipientsRefused(refused)


def validate_alert(payload):
    if not isinstance(payload, dict):
        raise ValueError("Expected JSON object")
    limits = {"incidentId": 160, "reason": 2000, "at": 80, "accountName": 200}
    result = {}
    for name, maximum in limits.items():
        value = payload.get(name, "" if name == "accountName" else None)
        if not isinstance(value, str) or len(value) > maximum:
            raise ValueError("Invalid alert field")
        if name != "accountName" and not value.strip():
            raise ValueError("Missing alert field")
        result[name] = value
    return result


class MailBridge:
    def __init__(self, config: MailConfig, sender: Callable = send_smtp):
        if len(config.token) < 32:
            raise ValueError("BOT_BRIDGE_TOKEN must contain at least 32 random characters")
        self.config, self.sender = config, sender
        self.lock = threading.Lock()
        config.state_path.parent.mkdir(parents=True, exist_ok=True)
        with closing(sqlite3.connect(config.state_path)) as db, db:
            db.execute("CREATE TABLE IF NOT EXISTS delivered (incident_id TEXT PRIMARY KEY, delivered_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)")

    def notify(self, alert):
        alert = validate_alert(alert)
        if not self.config.configured:
            raise RuntimeError("Email is not configured")
        # Serializes duplicate concurrent POSTs; only successful SMTP deliveries are persisted.
        with self.lock, closing(sqlite3.connect(self.config.state_path, timeout=20)) as db, db:
            if db.execute("SELECT 1 FROM delivered WHERE incident_id=?", (alert["incidentId"],)).fetchone():
                return True
            self.sender(self.config, alert)
            db.execute("INSERT INTO delivered (incident_id) VALUES (?)", (alert["incidentId"],))
        return False


class BridgeServer(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 8

    def __init__(self, address, bridge):
        self.bridge = bridge
        # Bound the number of simultaneous slow clients; each socket has a read timeout.
        self.slots = threading.BoundedSemaphore(16)
        super().__init__(address, BridgeHandler)

    def process_request(self, request, client_address):
        if not self.slots.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except Exception:
            self.slots.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.slots.release()

    def handle_error(self, request, client_address):
        LOG.warning("Mail bridge request failed; request contents omitted")


class BridgeHandler(BaseHTTPRequestHandler):
    server_version = "DouyinMailBridge/1"
    protocol_version = "HTTP/1.0"

    def setup(self):
        super().setup()
        self.connection.settimeout(10)

    def log_message(self, *args):
        # Request bodies, credentials, addresses and URLs are never logged.
        pass

    def origin_ok(self):
        origin = self.headers.get("Origin")
        return not origin or bool(EXTENSION_ORIGIN.fullmatch(origin))

    def authorized(self):
        expected = "Bearer " + self.server.bridge.config.token
        return hmac.compare_digest(self.headers.get("Authorization", "").encode(), expected.encode())

    def respond(self, status, value):
        body = json.dumps(value, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        origin = self.headers.get("Origin")
        if origin and EXTENSION_ORIGIN.fullmatch(origin):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        if self.path not in ("/alert", "/health", "/check") or not self.origin_ok() or not self.headers.get("Origin"):
            return self.respond(403, {"error": "origin_not_allowed"})
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", self.headers["Origin"])
        self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
        self.send_header("Access-Control-Max-Age", "600")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        if not self.origin_ok():
            return self.respond(403, {"error": "origin_not_allowed"})
        if self.path not in ("/health", "/check"):
            return self.respond(404, {"error": "not_found"})
        if self.path == "/check" and not self.authorized():
            return self.respond(401, {"error": "unauthorized"})
        self.respond(200, {"configured": self.server.bridge.config.configured})

    def do_POST(self):
        if not self.origin_ok():
            return self.respond(403, {"error": "origin_not_allowed"})
        if self.path != "/alert":
            return self.respond(404, {"error": "not_found"})
        if not self.authorized():
            return self.respond(401, {"error": "unauthorized"})
        if self.headers.get("Transfer-Encoding"):
            return self.respond(400, {"error": "unsupported_transfer_encoding"})
        try:
            size = int(self.headers.get("Content-Length", "-1"))
        except ValueError:
            return self.respond(400, {"error": "invalid_length"})
        if size < 1 or size > MAX_BODY:
            return self.respond(413, {"error": "invalid_body_size"})
        if self.headers.get_content_type() != "application/json":
            return self.respond(415, {"error": "json_required"})
        try:
            raw = self.rfile.read(size)
            if len(raw) != size:
                return self.respond(400, {"error": "incomplete_body"})
            alert = validate_alert(json.loads(raw))
        except (ValueError, UnicodeDecodeError):
            return self.respond(400, {"error": "invalid_alert"})
        except (socket.timeout, TimeoutError):
            return self.respond(408, {"error": "request_timeout"})
        try:
            duplicate = self.server.bridge.notify(alert)
        except Exception as exc:
            LOG.warning("Email delivery failed (%s); same incident may be retried", type(exc).__name__)
            return self.respond(503, {"error": "email_delivery_failed", "retryable": True})
        self.respond(200, {"ok": True, "duplicate": duplicate})


def create_server(config=None, port=17321, sender=send_smtp):
    return BridgeServer(("127.0.0.1", port), MailBridge(config or MailConfig.from_env(), sender))


def main():
    parser = argparse.ArgumentParser(description="Local mail bridge; bind 127.0.0.1 only")
    parser.add_argument("--env-file", type=Path, default=ROOT / ".env")
    args = parser.parse_args()
    load_env(args.env_file)
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    try:
        server = create_server()
    except (ValueError, OSError):
        LOG.error("Cannot start mail bridge: check .env token, SMTP port, state folder and port 17321")
        return 1
    LOG.info("Mail bridge listening at http://127.0.0.1:17321; SMTP configured=%s", server.bridge.config.configured)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
