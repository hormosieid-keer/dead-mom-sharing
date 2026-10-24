"""Offline tests only: SMTP is mocked; no email is ever sent."""
import http.client
import json
import os
import smtplib
import tempfile
import threading
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import MagicMock, patch

from runner.mail_bridge import MailConfig, MailBridge, create_server, send_smtp, main

TOKEN = "test-only-" + "a" * 40
ORIGIN = "chrome-extension://" + "a" * 32
ALERT = {"incidentId": "test-incident", "reason": "登录失效", "at": "2026-10-23T12:00:00Z", "accountName": "测试账号"}


class MailBridgeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.config = MailConfig(token=TOKEN, host="smtp.invalid", sender="bot@example.invalid",
            recipient="owner@example.invalid", state_path=Path(self.temp.name) / "alerts.sqlite3")
        self.sender = MagicMock()
        self.server = create_server(self.config, port=0, sender=self.sender)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
        self.temp.cleanup()

    def request(self, path="/alert", method="POST", payload=ALERT, headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=3)
        combined = {"Content-Type": "application/json", "Authorization": "Bearer " + TOKEN, "Origin": ORIGIN}
        combined.update(headers or {})
        body = json.dumps(payload).encode() if payload is not None else None
        conn.request(method, path, body=body, headers=combined)
        response = conn.getresponse()
        result = (response.status, dict(response.getheaders()), response.read())
        conn.close()
        return result

    def test_health_only_reports_configuration(self):
        status, _, body = self.request("/health", "GET", None, {"Authorization": ""})
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body), {"configured": True})
        self.assertNotIn(TOKEN.encode(), body)
        self.assertEqual(self.sender.call_count, 0)

    def test_auth_and_web_origin_rejected(self):
        self.assertEqual(self.request(headers={"Authorization": ""})[0], 401)
        self.assertEqual(self.request(headers={"Authorization": "Bearer wrong"})[0], 401)
        self.assertEqual(self.request(headers={"Origin": "https://untrusted.invalid"})[0], 403)
        self.assertEqual(self.sender.call_count, 0)

    def test_authenticated_check_never_sends_email(self):
        status, headers, body = self.request("/check", "GET", None)
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body), {"configured": True})
        self.assertEqual(headers["Access-Control-Allow-Origin"], ORIGIN)
        self.assertEqual(self.request("/check", "GET", None, {"Authorization": ""})[0], 401)
        self.assertEqual(self.request("/check", "GET", None, {"Authorization": "Bearer wrong"})[0], 401)
        self.assertEqual(self.request("/check", "GET", None, {"Origin": "https://untrusted.invalid"})[0], 403)
        self.server.bridge.config = replace(self.config, host="")
        self.assertEqual(json.loads(self.request("/check", "GET", None)[2]), {"configured": False})
        self.assertEqual(self.request("/check", "OPTIONS", None)[0], 204)
        self.assertEqual(self.sender.call_count, 0)

    def test_extension_cors_only(self):
        status, headers, _ = self.request(method="OPTIONS", payload=None)
        self.assertEqual(status, 204)
        self.assertEqual(headers["Access-Control-Allow-Origin"], ORIGIN)
        status, headers, _ = self.request(method="OPTIONS", payload=None, headers={"Origin": "null"})
        self.assertEqual(status, 403)
        self.assertNotIn("Access-Control-Allow-Origin", headers)

    def test_delivery_dedup_persists_between_instances(self):
        self.assertEqual(self.request()[0], 200)
        self.assertTrue(json.loads(self.request()[2])["duplicate"])
        self.assertEqual(self.sender.call_count, 1)
        new_bridge = MailBridge(self.config, self.sender)
        self.assertTrue(new_bridge.notify(ALERT))
        self.assertEqual(self.sender.call_count, 1)

    def test_failure_can_be_retried(self):
        self.sender.side_effect = [smtplib.SMTPException("secret must not be returned"), None]
        status, _, body = self.request()
        self.assertEqual(status, 503)
        self.assertTrue(json.loads(body)["retryable"])
        self.assertNotIn(b"secret", body)
        status, _, body = self.request()
        self.assertEqual(status, 200)
        self.assertFalse(json.loads(body)["duplicate"])
        self.assertEqual(self.sender.call_count, 2)

    def test_concurrent_duplicate_only_delivered_once(self):
        responses = []
        threads = [threading.Thread(target=lambda: responses.append(self.request()[0])) for _ in range(6)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=4)
        self.assertEqual(responses, [200] * 6)
        self.assertEqual(self.sender.call_count, 1)

    def test_payload_validation_and_bounded_size(self):
        self.assertEqual(self.request(payload={"reason": "missing fields"})[0], 400)
        self.assertEqual(self.request(payload={**ALERT, "reason": "x" * 10000})[0], 413)
        self.assertEqual(self.request(payload={**ALERT, "incidentId": 12})[0], 400)
        self.assertEqual(self.request(headers={"Content-Type": "text/plain"})[0], 415)
        self.assertEqual(self.sender.call_count, 0)

    def test_payload_cannot_override_email_recipient(self):
        self.assertEqual(self.request(payload={**ALERT, "recipient": "attacker@example.invalid"})[0], 200)
        config, passed = self.sender.call_args.args
        self.assertEqual(config.recipient, "owner@example.invalid")
        self.assertNotIn("recipient", passed)

    def test_no_smtp_configuration_is_retryable(self):
        self.server.bridge.config = replace(self.config, host="")
        self.assertEqual(self.request()[0], 503)
        self.assertEqual(self.sender.call_count, 0)

    def test_short_bridge_token_refused(self):
        with self.assertRaises(ValueError):
            MailBridge(replace(self.config, token="short"), self.sender)

    def test_startup_invalid_configuration_returns_error(self):
        with patch.dict(os.environ, {"SMTP_PORT": "invalid-port", "BOT_BRIDGE_TOKEN": TOKEN}, clear=True), \
                patch("runner.mail_bridge.load_env"), patch("sys.argv", ["mail_bridge"]), \
                self.assertLogs("douyin.mail", level="ERROR"):
            self.assertEqual(main(), 1)
        with self.assertRaises(ValueError):
            create_server(replace(self.config, token=""), port=0, sender=self.sender)
        self.assertEqual(self.sender.call_count, 0)


class SmtpTests(unittest.TestCase):
    def test_ssl_uses_config_recipient(self):
        config = MailConfig(token=TOKEN, host="smtp.invalid", username="bot", password="secret",
            sender="bot@example.invalid", recipient="owner@example.invalid")
        with patch("runner.mail_bridge.smtplib.SMTP_SSL") as smtp:
            client = smtp.return_value.__enter__.return_value
            client.send_message.return_value = {}
            send_smtp(config, ALERT)
            client.login.assert_called_once_with("bot", "secret")
            self.assertEqual(client.send_message.call_args.args[0]["To"], config.recipient)
            self.assertEqual(smtp.call_args.kwargs["timeout"], 15)

    def test_starttls_and_refusal_is_failure(self):
        config = MailConfig(token=TOKEN, host="smtp.invalid", security="starttls", port=587,
            sender="bot@example.invalid", recipient="owner@example.invalid")
        with patch("runner.mail_bridge.smtplib.SMTP") as smtp:
            client = smtp.return_value.__enter__.return_value
            client.send_message.return_value = {config.recipient: (550, b"refused")}
            with self.assertRaises(smtplib.SMTPRecipientsRefused):
                send_smtp(config, ALERT)
            client.starttls.assert_called_once()


if __name__ == "__main__":
    unittest.main()
