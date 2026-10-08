"""ByteDance verifycenter (bdcaptcha) slider auto-solver for Dola.

When video submission triggers the platform's slider captcha, locate the gap
with OpenCV edge template matching and drag the slider with a human-like
track. Returns control to the caller's polling loop once the captcha frame
detaches; the platform frontend then retries the submission by itself.

Ported from the proven dola-pool implementation (gap.py + video_worker_ui.py)
to this workbench's synchronous Playwright runtime. Diagnostic messages go to
stderr only: the worker's stdout carries JSON status lines parsed by Node.
"""

import os
import random
import sys
import time

import cv2
import numpy as np

CAPTCHA_FRAME_KEYS = ("bdcaptcha", "captcha")
CONTAINER_SELECTOR = "#captcha_container:visible, .captcha_verify_container:visible"
SLIDER_BUTTON = ".captcha-slider-btn"
IMAGE_WAIT_MS = 15000


def _log(message):
    print(f"[slider-captcha] {message}", file=sys.stderr, flush=True)


def autosolve_enabled(environ=None):
    env = os.environ if environ is None else environ
    return env.get("WORKBENCH_DOLA_CAPTCHA_AUTOSOLVE", "1").strip().lower() not in ("0", "false", "no")


def max_attempts(environ=None):
    env = os.environ if environ is None else environ
    try:
        return max(1, min(5, int(env.get("WORKBENCH_DOLA_CAPTCHA_MAX_ATTEMPTS", "3"))))
    except ValueError:
        return 3


def find_captcha_frame(page):
    """The verifycenter challenge lives in an iframe (URL contains bdcaptcha)."""
    frames = page.frames
    for frame in frames:
        url = (frame.url or "").lower()
        if any(key in url for key in CAPTCHA_FRAME_KEYS):
            return frame
    # URL naming can change; fall back to whichever frame holds the slider.
    for frame in frames:
        if frame == page.main_frame:
            continue
        try:
            if frame.locator(SLIDER_BUTTON).count():
                return frame
        except Exception:
            continue
    return None


def captcha_visible(page):
    if page.locator(CONTAINER_SELECTOR).count():
        return True
    return find_captcha_frame(page) is not None


def find_gap_x(bg_bytes, piece_bytes):
    """Return (gap_x, confidence); gap_x is the notch's left edge in the
    background image's natural pixel coordinates."""
    bg = cv2.imdecode(np.frombuffer(bg_bytes, np.uint8), cv2.IMREAD_COLOR)
    piece = cv2.imdecode(np.frombuffer(piece_bytes, np.uint8), cv2.IMREAD_UNCHANGED)
    if bg is None or piece is None:
        raise ValueError("CAPTCHA_IMAGE_DECODE_FAILED")
    if piece.ndim == 3 and piece.shape[2] == 4:
        alpha = piece[:, :, 3]
    else:
        alpha = cv2.cvtColor(piece, cv2.COLOR_BGR2GRAY)
    piece_edge = cv2.Canny(alpha, 100, 200)
    bg_edge = cv2.Canny(cv2.cvtColor(bg, cv2.COLOR_BGR2GRAY), 100, 200)
    if piece_edge.shape[0] > bg_edge.shape[0] or piece_edge.shape[1] > bg_edge.shape[1]:
        raise ValueError("CAPTCHA_PIECE_LARGER_THAN_BACKGROUND")
    result = cv2.matchTemplate(bg_edge, piece_edge, cv2.TM_CCOEFF_NORMED)
    _, max_val, _, max_loc = cv2.minMaxLoc(result)
    return int(max_loc[0]), float(max_val)


def drag_distance(gap_x, scale, piece_left, bg_left):
    """CSS-pixel distance the button must travel. The piece's current left
    offset is already part of the journey, so subtract it."""
    return gap_x * scale - (piece_left - bg_left)


def human_track(distance):
    """Smootherstep main travel + small overshoot settling + y jitter.
    Returns [(dx, dy, dt_ms), ...] relative to the drag start point."""
    steps = random.randint(45, 65)
    overshoot = random.uniform(3, 9)
    points = []
    for i in range(1, steps + 1):
        t = i / steps
        s = 10 * t**3 - 15 * t**4 + 6 * t**5
        x = (distance + overshoot) * s
        y = random.uniform(-1.5, 1.5) if 0.1 < t < 0.95 else 0
        points.append((x, y, random.randint(8, 22)))
    for i in range(1, random.randint(3, 5) + 1):
        points.append((distance + overshoot * (1 - i / 5), random.uniform(-0.8, 0.8), random.randint(15, 30)))
    return points


def _image_meta(frame):
    return frame.evaluate("""() => [...document.images].map(im => ({
        src: im.src, w: im.naturalWidth, h: im.naturalHeight,
        bw: im.getBoundingClientRect().width,
        left: im.getBoundingClientRect().left,
    }))""")


def _wait_for_images(frame):
    frame.wait_for_selector("img", timeout=IMAGE_WAIT_MS)
    frame.evaluate("""async () => {
        const t0 = Date.now();
        while (Date.now() - t0 < 10000) {
            const imgs = [...document.images];
            if (imgs.length >= 2 && imgs.every(im => im.complete && im.naturalWidth > 0)) return;
            await new Promise(r => setTimeout(r, 200));
        }
        throw new Error("captcha images load timeout");
    }""")


def _fetch_bytes(page, url):
    # The context's APIRequestContext shares the browser's proxy and cookies.
    response = page.context.request.get(url, timeout=20000)
    if not response.ok:
        raise RuntimeError(f"CAPTCHA_IMAGE_FETCH_{response.status}")
    return response.body()


def solve_slider(page, frame, attempt):
    """One recognition + drag cycle inside the bdcaptcha iframe."""
    try:
        _wait_for_images(frame)
    except Exception as error:
        _log(f"#{attempt} 验证码图片未就绪: {error}")
        return False
    page.wait_for_timeout(800)  # let the layout settle before measuring

    imgs = _image_meta(frame)
    bg = next((i for i in imgs if ".jpeg" in i["src"] or "-2." in i["src"]), None)
    piece = next((i for i in imgs if i is not bg and (".png" in i["src"] or "-1." in i["src"])), None)
    if not bg or not piece:
        _log(f"#{attempt} 未找到背景/滑块图 ({len(imgs)} imgs)")
        return False

    try:
        bg_bytes = _fetch_bytes(page, bg["src"])
        piece_bytes = _fetch_bytes(page, piece["src"])
    except Exception as error:
        _log(f"#{attempt} 验证码图片下载失败: {error}")
        return False

    try:
        gap_x, conf = find_gap_x(bg_bytes, piece_bytes)
    except ValueError as error:
        _log(f"#{attempt} 缺口识别失败: {error}")
        return False

    scale = bg["bw"] / bg["w"] if bg["w"] else 340 / 552
    distance = drag_distance(gap_x, scale, piece["left"], bg["left"])
    _log(f"#{attempt} gap_x={gap_x} conf={conf:.3f} scale={scale:.2f} distance={distance:.0f}px")
    if not 10 <= distance <= 600:
        _log(f"#{attempt} 距离异常，跳过本次拖动")
        return False

    button = frame.locator(SLIDER_BUTTON)
    box = button.bounding_box()
    if not box:
        _log(f"#{attempt} 未找到拖动按钮 {SLIDER_BUTTON}")
        return False
    start_x, start_y = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
    page.mouse.move(start_x, start_y)
    page.wait_for_timeout(random.randint(150, 350))
    page.mouse.down()
    page.wait_for_timeout(random.randint(80, 180))
    for dx, dy, dt in human_track(distance):
        page.mouse.move(start_x + dx, start_y + dy)
        time.sleep(dt / 1000)
    page.wait_for_timeout(random.randint(120, 260))
    page.mouse.up()

    for _ in range(10):
        page.wait_for_timeout(700)
        if not captcha_visible(page):
            return True
    return False


def solve_dola_captcha(page, attempts=None):
    """Best-effort auto solve of the Dola slider captcha.

    Returns True when no captcha remains (or none was present). Returns False
    when the challenge is still up after every attempt, so the caller can fall
    back to the human-operator flow."""
    if not captcha_visible(page):
        return True
    if not autosolve_enabled():
        _log("自动求解已禁用 (WORKBENCH_DOLA_CAPTCHA_AUTOSOLVE=0)")
        return False
    for attempt in range(1, (attempts or max_attempts()) + 1):
        frame = find_captcha_frame(page)
        if frame is None:
            # The container can render before its iframe attaches.
            page.wait_for_timeout(1000)
            frame = find_captcha_frame(page)
            if frame is None:
                _log(f"#{attempt} 未找到验证码 iframe")
                continue
        _log(f"滑块出现，第 {attempt} 次求解...")
        try:
            if solve_slider(page, frame, attempt):
                _log("滑块通过")
                page.wait_for_timeout(3000)  # frontend retries the submission
                return True
        except Exception as error:
            _log(f"#{attempt} 求解异常: {error}")
        _log(f"#{attempt} 未通过，等待刷新重试")
        page.wait_for_timeout(1500)
    return captcha_visible(page) is False
