"""Doubao grid (九宫格) captcha solver via the Volcengine Ark vision API.

The domestic verifycenter widget renders one composite 3x3 image plus an
instruction line ("请点击所有..."). We fetch the original image bytes (never
a screenshot), ask a fast vision model which cells match the instruction, then
click the cell centres with human-like pacing. Anything uncertain (ordered
click challenges, missing widget pieces, API errors) falls back to the
existing human-operator flow by returning False.

Diagnostic messages go to stderr only: worker stdout carries JSON status
lines parsed by Node.

Environment:
    WORKBENCH_DOUBAO_GRID_AUTOSOLVE   "0" disables (default enabled)
    WORKBENCH_ARK_API_KEY             required; absent -> always fall back
    WORKBENCH_ARK_MODEL               default doubao-seed-2-1-turbo-260628
    WORKBENCH_ARK_BASE_URL            default https://ark.cn-beijing.volces.com/api/v3
    WORKBENCH_DOUBAO_GRID_ATTEMPTS    default 2 (1-4)
    WORKBENCH_DOUBAO_GRID_SIZE        default 3 (cells per side)
    WORKBENCH_DOUBAO_GRID_CAPTURE_DIR optional failure diagnostics dump
"""

import base64
import json
import os
import random
import re
import sys
import time
from pathlib import Path

import requests

CONTAINER_SELECTOR = ('#captcha_container:visible, .captcha_verify_container:visible, '
                      '#captcha-verify-container-main-page:visible')
INSTRUCTION_RE = re.compile(r'点击|选择|选出|select|click', re.I)
UNSUPPORTED_RE = re.compile(r'依次|按顺序|顺序|in order', re.I)
CONFIRM_RE = re.compile(r'^(确认|确定|提交|验证|confirm|verify|submit)$', re.I)
DEFAULT_MODEL = 'doubao-seed-2-1-turbo-260628'
DEFAULT_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3'

_solve_throttle = {}


def _log(message):
    print(f"[grid-captcha] {message}", file=sys.stderr, flush=True)


def autosolve_enabled(environ=None):
    env = os.environ if environ is None else environ
    return env.get('WORKBENCH_DOUBAO_GRID_AUTOSOLVE', '1').strip().lower() not in ('0', 'false', 'no')


def max_attempts(environ=None):
    env = os.environ if environ is None else environ
    try:
        return max(1, min(4, int(env.get('WORKBENCH_DOUBAO_GRID_ATTEMPTS', '2'))))
    except ValueError:
        return 2


def grid_size(environ=None):
    env = os.environ if environ is None else environ
    try:
        return max(2, min(5, int(env.get('WORKBENCH_DOUBAO_GRID_SIZE', '3'))))
    except ValueError:
        return 3


def grid_captcha_present(page):
    if page.locator(CONTAINER_SELECTOR).count():
        return True
    return find_widget_frame(page) is not None


def find_widget_frame(page):
    for frame in page.frames:
        if frame == page.main_frame:
            continue
        url = (frame.url or '').lower()
        if 'captcha' in url or 'verify' in url:
            return frame
    return None


def _widget_contexts(page):
    """The widget can live inline on the main page or inside an iframe."""
    contexts = []
    frame = find_widget_frame(page)
    if frame is not None:
        contexts.append(frame)
    contexts.append(page)
    return contexts


def _extract_widget(context):
    """Return (instruction, img_locator, img_src) or None.

    Instruction: the shortest visible text that reads like a challenge
    directive. Grid image: the largest visible roughly-square image.
    """
    instruction = None
    for locator in (context.locator('[class*="tip" i]:visible, [class*="title" i]:visible, '
                                    '[class*="desc" i]:visible, [class*="prompt" i]:visible, '
                                    '[class*="text" i]:visible'),
                    context.locator('*:visible')):
        try:
            texts = locator.all_text_contents()
        except Exception:
            continue
        candidates = [t.strip() for t in texts
                      if t and 4 <= len(t.strip()) <= 60 and INSTRUCTION_RE.search(t)]
        if candidates:
            instruction = min(candidates, key=len)
            break
    images = context.locator('img:visible')
    best = None
    try:
        count = min(images.count(), 20)
    except Exception:
        count = 0
    for index in range(count):
        image = images.nth(index)
        try:
            box = image.bounding_box()
            src = image.get_attribute('src') or ''
            natural = image.evaluate('im => ({w: im.naturalWidth, h: im.naturalHeight})')
        except Exception:
            continue
        if not box or not src or src.startswith('data:'):
            continue
        if not natural.get('w'):
            continue
        width, height = box['width'], box['height']
        if not (140 <= width <= 700 and 140 <= height <= 700):
            continue
        if not 0.7 <= width / max(height, 1) <= 1.4:
            continue
        area = width * height
        if best is None or area > best[0]:
            best = (area, image, src)
    if instruction and best:
        return instruction, best[1], best[2]
    return None


def _fetch_image(page, src):
    response = page.context.request.get(src, timeout=20000)
    if not response.ok:
        raise RuntimeError(f'GRID_IMAGE_FETCH_{response.status}')
    content_type = (response.headers.get('content-type') or 'image/jpeg').split(';')[0].strip()
    if not content_type.startswith('image/'):
        content_type = 'image/jpeg'
    return response.body(), content_type


def parse_indices(content, cells):
    """Extract {"indices":[...]} from a model reply; None when unusable."""
    match = re.search(r'\{[^{}]*"indices"[^{}]*\}', content or '', re.S)
    if not match:
        return None
    try:
        data = json.loads(match.group(0))
    except ValueError:
        return None
    indices = data.get('indices')
    if not isinstance(indices, list):
        return None
    result = []
    for item in indices:
        if isinstance(item, bool) or not isinstance(item, (int, float)):
            return None
        value = int(item)
        if value != item or not 1 <= value <= cells or value in result:
            return None
        result.append(value)
    return result or None


def recognize(image_bytes, content_type, instruction, cells, environ=None):
    """Ask the Ark vision model which grid cells match the instruction."""
    env = os.environ if environ is None else environ
    key = (env.get('WORKBENCH_ARK_API_KEY') or '').strip()
    if not key:
        raise RuntimeError('ARK_API_KEY_MISSING')
    model = env.get('WORKBENCH_ARK_MODEL', DEFAULT_MODEL)
    base = env.get('WORKBENCH_ARK_BASE_URL', DEFAULT_BASE_URL).rstrip('/')
    prompt = (
        f'这是一张九宫格验证码图片（{int(cells ** 0.5)}x{int(cells ** 0.5)}，从左上到右下按行编号1-{cells}）。'
        f'页面指令是："{instruction}"\n'
        '请严格按指令找出所有符合要求的格子，只返回JSON：{"indices":[编号,...]}。'
        '不要返回任何其他内容。')
    body = {
        'model': model,
        'messages': [{'role': 'user', 'content': [
            {'type': 'text', 'text': prompt},
            {'type': 'image_url', 'image_url': {
                'url': f'data:{content_type};base64,' + base64.b64encode(image_bytes).decode()}},
        ]}],
        'max_tokens': 200,
    }
    response = requests.post(base + '/chat/completions', json=body, timeout=90,
                             headers={'Authorization': 'Bearer ' + key,
                                      'Content-Type': 'application/json'})
    if response.status_code != 200:
        raise RuntimeError(f'ARK_API_{response.status_code}')
    content = response.json()['choices'][0]['message']['content']
    if isinstance(content, list):
        content = ''.join(part.get('text', '') for part in content if isinstance(part, dict))
    indices = parse_indices(content, cells)
    if indices is None:
        raise RuntimeError('ARK_REPLY_UNPARSEABLE')
    return indices


def cell_center(box, index, size):
    row, col = divmod(index - 1, size)
    return (box['x'] + (col + 0.5) * box['width'] / size,
            box['y'] + (row + 0.5) * box['height'] / size)


def _human_click(page, x, y):
    x += random.uniform(-3, 3)
    y += random.uniform(-3, 3)
    steps = random.randint(6, 12)
    page.mouse.move(x + random.uniform(-40, 40), y + random.uniform(-30, 30))
    page.wait_for_timeout(random.randint(60, 160))
    page.mouse.move(x, y, steps=steps)
    page.wait_for_timeout(random.randint(120, 320))
    page.mouse.down()
    page.wait_for_timeout(random.randint(60, 140))
    page.mouse.up()


def _capture(page, context, tag):
    directory = os.environ.get('WORKBENCH_DOUBAO_GRID_CAPTURE_DIR')
    if not directory:
        return
    try:
        stamp = time.strftime('%Y%m%d-%H%M%S')
        target = Path(directory)
        target.mkdir(parents=True, exist_ok=True)
        (target / f'grid-{stamp}-{tag}.html').write_text(
            context.evaluate('() => document.documentElement.outerHTML'), encoding='utf-8')
        page.screenshot(path=str(target / f'grid-{stamp}-{tag}.png'))
    except Exception as error:
        _log(f'诊断转存失败: {error}')


def solve_once(page, attempt):
    for context in _widget_contexts(page):
        try:
            widget = _extract_widget(context)
        except Exception as error:
            _log(f'#{attempt} 控件提取异常: {error}')
            continue
        if not widget:
            continue
        instruction, image, src = widget
        if UNSUPPORTED_RE.search(instruction):
            _log(f'#{attempt} 顺序点选类验证不支持自动求解: {instruction}')
            return False
        size = grid_size()
        try:
            image_bytes, content_type = _fetch_image(page, src)
        except Exception as error:
            _log(f'#{attempt} 图片下载失败: {error}')
            continue
        try:
            indices = recognize(image_bytes, content_type, instruction, size * size)
        except Exception as error:
            _log(f'#{attempt} 识别失败: {error}')
            _capture(page, context, f'recognize-{attempt}')
            continue
        box = image.bounding_box()
        if not box:
            continue
        _log(f'#{attempt} 指令「{instruction}」 命中格子 {indices}')
        for index in indices:
            x, y = cell_center(box, index, size)
            _human_click(page, x, y)
            page.wait_for_timeout(random.randint(250, 600))
        confirm = context.get_by_role('button', name=CONFIRM_RE)
        try:
            if confirm.count():
                confirm.first.click(timeout=3000)
        except Exception:
            pass
        for _ in range(20):
            page.wait_for_timeout(500)
            if not grid_captcha_present(page):
                return True
        _log(f'#{attempt} 点击后验证仍未通过')
        _capture(page, context, f'rejected-{attempt}')
        return False
    _log(f'#{attempt} 未找到九宫格控件（可能是滑块等其他验证）')
    return False


def solve_doubao_grid_captcha(page, attempts=None):
    """Best-effort solve of the Doubao grid captcha.

    Returns True when no captcha remains. Returns False to fall back to the
    human-operator flow. Throttled per page so polling loops never spam the
    recognition API."""
    if not grid_captcha_present(page):
        return True
    if not autosolve_enabled():
        _log('九宫格自动求解已禁用 (WORKBENCH_DOUBAO_GRID_AUTOSOLVE=0)')
        return False
    if not (os.environ.get('WORKBENCH_ARK_API_KEY') or '').strip():
        _log('未配置 WORKBENCH_ARK_API_KEY，回退人工')
        return False
    key = id(page)
    now = time.monotonic()
    if now - _solve_throttle.get(key, -120) < 30:
        return False
    _solve_throttle[key] = now
    for attempt in range(1, (attempts or max_attempts()) + 1):
        _log(f'九宫格出现，第 {attempt} 次求解...')
        try:
            if solve_once(page, attempt):
                _log('九宫格通过')
                page.wait_for_timeout(2000)
                return True
        except Exception as error:
            _log(f'#{attempt} 求解异常: {error}')
        page.wait_for_timeout(2000)
        if not grid_captcha_present(page):
            return True
    return not grid_captcha_present(page)
