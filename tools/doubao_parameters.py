"""Explicit video parameters for Doubao's conversational confirmation step."""

import re
import unicodedata

VIDEO_PARAMS_PANEL = '[data-input-engine-actionbar-render-entry-key$="video-generation-params-panel"]'


def is_confirmation_message(text, job):
    value=text.strip()
    if (job.get('model') and job.get('referenceAssets') and job.get('durationSeconds') and job.get('aspectRatio')
            and value == chat_confirmation_text(job)):
        return True
    native='生成视频：确认生成，'+job.get('aspectRatio','')
    # The DOM retains the composer's visible 10s suffix until it is reloaded;
    # the actual requested duration is checked separately in the transport.
    return value in ('确认生成',native,native+'，10s',native+f'，{job.get("durationSeconds",15)}s')


def prompt_matches(prompt: str, rendered: str) -> bool:
    """Match literal content after the platform renders Markdown list markers.

    Do not remove punctuation globally: ranges, negative values and product
    names must still match. Only a line-leading Markdown bullet is formatting.
    """
    normalize = lambda value: re.sub(r'\s+', '', value)
    expected = normalize(prompt)
    if not expected:
        return False
    if expected in normalize(rendered):
        return True
    without_bullets = re.sub(r'(?m)^[ \t]{0,3}[-*+][ \t]+(?=\S)', '', prompt)
    return bool(normalize(without_bullets)) and normalize(without_bullets) in normalize(rendered)


def response_state(assistant_texts):
    """Classify the latest platform reply, never text from the user's prompt."""
    # An empty newest reply is still streaming; an older confirmation or error
    # must not be mistaken for the reply to the just-sent control message.
    text = assistant_texts[-1].strip() if assistant_texts else ''
    if re.search(r'(?:订阅标准套餐专属能力|(?:需要|需先|请先)开通.{0,12}(?:会员|订阅|标准套餐).{0,12}(?:才能|继续))', text):
        return 'subscription'
    if re.search(r'(?:免费次数|生成次数|免费额度|剩余额度|次数).{0,12}(?:用完|用尽|耗尽|不足)', text):
        return 'quota'
    if '你的视频生成好了' in text:
        return 'done'
    if ('视频生成参数确认' in text
            or re.search(r'请(?:先)?确认|确认后.{0,12}(?:开始|生成)|确认.{0,4}再.{0,8}生成', text)):
        return 'confirm'
    if re.search(r'视频生成好后|视频.{0,12}生成中|(?:正在|开始)(?:为你|帮你)?生成视频', text):
        return 'auto'
    return None


def select_ratio(page, ratio):
    # Explicitly reset Auto too: the platform can remember a previous fixed ratio.
    name = re.compile(r'^(?:自动|自适应|Auto)(?:比例)?$', re.I) if ratio == 'auto' else ratio
    page.get_by_role('button', name=name, exact=True).click(timeout=15_000)
    selected = page.locator(VIDEO_PARAMS_PANEL).inner_text(timeout=5_000)
    if ((ratio == 'auto' and not re.search(r'自动|自适应|\bAuto\b', selected, re.I))
            or (ratio != 'auto' and ratio not in selected)):
        raise RuntimeError('ASPECT_RATIO_SELECTION_FAILED')


def prepare_video_confirmation(page, job):
    """Continue in the same chat's video tool, which resets to chat after a reply."""
    if not page.locator(VIDEO_PARAMS_PANEL).count():
        page.locator('[data-testid="chat_input"]').get_by_text('视频生成', exact=True).click(timeout=15_000)
    page.locator(VIDEO_PARAMS_PANEL).wait_for(timeout=15_000)
    page.get_by_text('模型', exact=True).first.locator('..').click(timeout=15_000)
    selected = page.get_by_text(job['model'], exact=True).last
    if '升级' in selected.locator('..').inner_text(timeout=5_000):
        raise RuntimeError('MODEL_REQUIRES_UPGRADE')
    selected.click(timeout=15_000)
    page.locator(VIDEO_PARAMS_PANEL).click(timeout=15_000)
    from doubao_duration import select_base_duration
    select_base_duration(page)
    select_ratio(page, job['aspectRatio'])


def chat_confirmation_text(job: dict) -> str:
    return (f'请生成视频：使用 {job["model"]}，按上文已确认的 {job["durationSeconds"]} 秒、'
            f'{job["aspectRatio"]} 参数，根据本对话已上传的全部 {len(job["referenceAssets"])} 张参考图'
            '和原剧情分镜生成实际视频。参数已确认，请开始制作。')


def chat_video_prompt(job: dict) -> str:
    return (f'请根据这 {len(job["referenceAssets"])} 张参考图，使用 {job["model"]} '
            f'生成严格 {job["durationSeconds"]} 秒、比例 {job["aspectRatio"]} 的视频。\n'
            + video_prompt(job)
            + '\n请生成实际视频文件。如果指定模型当前不可用，请直接说明，不要自动换成其他模型。')


def video_prompt(job: dict) -> str:
    # Match the platform's video composer flow: visual instructions are text;
    # model, duration and ratio are carried by the guarded ability parameters.
    # Asking the chat assistant to reconfirm them changes the generation flow.
    positive = job['prompt'].strip()
    negative = (job.get("negativePrompt") or "").strip()
    return positive + ('\n\n请避免出现：' + negative if negative else '')


def confirmation_matches(text: str, job: dict) -> bool:
    """Accept only explicit fields; e.g. 15 seconds must never match 5 seconds."""
    text = unicodedata.normalize("NFKC", text)
    if "视频生成参数确认" not in text:
        return False
    text = text.split("视频生成参数确认", 1)[1]
    fields = {}
    for match in re.finditer(
        r"^\s*(?:[-•]\s*)?(模型|时长|比例|画面比例|视频比例|宽高比)\s*:\s*([^\n]+)",
        text, re.MULTILINE,
    ):
        key = match[1] if match[1] in ("模型", "时长") else "比例"
        if key in fields:
            return False
        fields[key] = match[2].strip()
    normalized_model = lambda value: re.sub(r"\s+", " ", value).strip().casefold()
    if normalized_model(fields.get("模型", "")) != normalized_model(job["model"]):
        return False
    duration = re.fullmatch(r"(?:严格\s*)?(\d+)\s*(?:秒|s|seconds?)", fields.get("时长", ""), re.I)
    if not duration or int(duration[1]) != job["durationSeconds"]:
        return False
    ratio = job.get("aspectRatio") or "auto"
    if ratio != "auto":
        selected = re.match(r"^(\d+)\s*:\s*(\d+)(?!\d)", fields.get("比例", ""))
        if not selected or f"{selected[1]}:{selected[2]}" != ratio:
            return False
    return True
