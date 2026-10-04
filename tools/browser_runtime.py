"""Browser selection shared by Linux login, verification, and video execution."""

import os
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
    channel = browser_channels(environ)[0]
    return {} if channel is None else {"channel": channel}
