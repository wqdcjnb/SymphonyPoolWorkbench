"""Browser selection shared by Linux login, verification, and video execution."""

import os
import json
from pathlib import Path


def profile_in_use_error(error, profile_path=None):
    """Recognize Chromium's headed and headless responses to an occupied profile."""
    detail = str(error).lower()
    if any(marker in detail for marker in (
        "processsingleton",
        "user data directory is already in use",
        "opening in existing browser session",
        "profile is already in use by another instance of chromium",
    )):
        return True
    return bool(profile_path is not None and "exitcode=0" in detail
                and (Path(profile_path) / "lockfile").exists())


def browser_channels(environ=None):
    env = os.environ if environ is None else environ
    channel = env.get("WORKBENCH_BROWSER_CHANNEL", "").strip()
    if channel:
        if channel not in ("chrome", "msedge", "chromium"):
            raise RuntimeError("INVALID_BROWSER_CHANNEL")
        return (None if channel == "chromium" else channel,)
    return ("chrome", "msedge", None)


def generation_browser_options(environ=None):
    env = os.environ if environ is None else environ
    channel = browser_channels(env)[0]
    options = {} if channel is None else {"channel": channel}
    if env.get("WORKBENCH_BROWSER_PROXY"):
        options["proxy"] = json.loads(env["WORKBENCH_BROWSER_PROXY"])
    return options


def verify_egress(context):
    expected = os.environ.get("WORKBENCH_EXPECTED_IP")
    if not expected:
        return
    try:
        from stream_media import session_for_account
        with session_for_account() as session:
            actual = session.get("https://api.ipify.org?format=json", timeout=20).json()["ip"]
    except Exception as error:
        raise RuntimeError("EGRESS_CHECK_FAILED") from error
    if actual != expected:
        raise RuntimeError("EGRESS_IP_MISMATCH")


class SharedContext:
    """Disconnect the automation transport without closing the supervised browser."""
    def __init__(self, browser):
        self.browser = browser
        self.context = browser.contexts[0]
        self.initial_pages = set(self.context.pages)

    def __getattr__(self, name):
        return getattr(self.context, name)

    def preserve_page(self, page):
        """Keep a challenge visible for the account's authorized human operator."""
        self.initial_pages.add(page)

    def close(self):
        for page in list(self.context.pages):
            if page not in self.initial_pages:
                page.close()
        # sync_playwright's lifetime closes this client's transport.


def persistent_context(playwright, profile=None, **options):
    profile = profile or options.pop("user_data_dir", None)
    endpoint = os.environ.get("WORKBENCH_BROWSER_ENDPOINT")
    if endpoint:
        if not endpoint.startswith("http://127.0.0.1:"):
            raise RuntimeError("INVALID_BROWSER_ENDPOINT")
        context = SharedContext(playwright.chromium.connect_over_cdp(endpoint, timeout=20000))
    else:
        for key, value in generation_browser_options().items():
            options.setdefault(key, value)
        context = playwright.chromium.launch_persistent_context(profile, **options)
    try:
        verify_egress(context)
        return context
    except Exception:
        context.close()
        raise
