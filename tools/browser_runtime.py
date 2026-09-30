"""Browser selection shared by Linux login, verification, and video execution."""

import os


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
