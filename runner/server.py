"""Keep a persistent Playwright Chromium and mail bridge alive on Ubuntu."""
import argparse
import asyncio
import logging
import os
import signal
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path

from .config import ROOT, load_env
from .mail_bridge import create_server

LOG = logging.getLogger("douyin.runner")


async def run(extension, profile):
    from playwright.async_api import async_playwright

    server = create_server()
    bridge_thread = threading.Thread(target=server.serve_forever, daemon=True)
    bridge_thread.start()
    stop, closed = asyncio.Event(), asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, stop.set)
        except (NotImplementedError, RuntimeError):
            pass
    context = None
    failed = False
    try:
        async with async_playwright() as playwright:
            context = await playwright.chromium.launch_persistent_context(
                str(profile), channel="chromium", headless=False, chromium_sandbox=True,
                viewport={"width": 1366, "height": 900},
                args=[f"--disable-extensions-except={extension}", f"--load-extension={extension}"],
            )
            context.on("close", lambda *_: closed.set())
            worker = next((w for w in context.service_workers if w.url.startswith("chrome-extension://")), None)
            if worker is None:
                worker = await context.wait_for_event("serviceworker", timeout=30000,
                    predicate=lambda w: w.url.startswith("chrome-extension://"))
            extension_id = worker.url.split("/")[2]
            settings_url = f"chrome-extension://{extension_id}/options.html"
            settings = next((p for p in context.pages if p.url == settings_url), None)
            if settings is None:
                settings = await context.new_page()
                await settings.goto(settings_url)
            LOG.info("Chromium ready; open the remote desktop to configure the extension and sign in")
            LOG.info("Mail bridge: http://127.0.0.1:17321; SMTP configured=%s", server.bridge.config.configured)
            # Alarms and state belong to the extension, not this launcher. MV3 worker idle
            # suspension is expected; waiting for worker shutdown would be incorrect.
            while not stop.is_set() and not closed.is_set():
                try:
                    await asyncio.wait_for(stop.wait(), timeout=2)
                except asyncio.TimeoutError:
                    pass
            failed = closed.is_set() and not stop.is_set()
            if not closed.is_set():
                await context.close()
    except Exception as exc:
        LOG.error("Chromium runner failed (%s); details omitted to protect account data", type(exc).__name__)
        failed = True
        if context:
            try:
                await context.close()
            except Exception:
                pass
    finally:
        if failed:
            try:
                await asyncio.to_thread(server.bridge.notify, {
                    "incidentId": "runner-" + str(uuid.uuid4()),
                    "reason": "服务器 Chromium 意外关闭或启动失败，请通过远程桌面检查后手动恢复。",
                    "at": datetime.now(timezone.utc).isoformat(), "accountName": "服务器运行器",
                })
            except Exception:
                LOG.error("Runner stopped and email could not be delivered; check local configuration")
        await asyncio.to_thread(server.shutdown)
        server.server_close()
    return 1 if failed else 0


def main():
    parser = argparse.ArgumentParser(description="Ubuntu persistent Chromium launcher")
    parser.add_argument("--env-file", type=Path, default=ROOT / ".env")
    parser.add_argument("--extension", type=Path, default=ROOT / "extension")
    args = parser.parse_args()
    load_env(args.env_file)
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    extension = args.extension.resolve()
    if not (extension / "manifest.json").is_file():
        LOG.error("Extension folder must contain manifest.json")
        return 1
    if os.name != "nt" and not os.environ.get("DISPLAY"):
        LOG.error("No DISPLAY: start this runner using deploy/compose.yaml on Ubuntu")
        return 1
    profile = Path(os.getenv("BOT_DATA_DIR", str(ROOT / "data"))) / "chromium-profile"
    profile.mkdir(parents=True, exist_ok=True)
    try:
        return asyncio.run(run(extension, profile))
    except (ValueError, OSError, ImportError):
        LOG.error("Cannot start runner: check installed requirements, .env, data permissions and port 17321")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
