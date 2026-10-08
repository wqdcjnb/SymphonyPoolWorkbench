"""Prepare Dola text while retaining original jobs and their structured settings."""
import re
from decimal import Decimal

MODEL = 'Dreamina Seedance 2.5'
THIRTY_SECONDS = re.compile(
    r'(?<![A-Za-z0-9_.０-９])(?:[3３][0０](?:[.．][0０]+)?[\s\u200b]*'
    r'(?:[-‐‑–－][\s\u200b]*)?(?:seconds?|secs?\.?|[sＳｓ]|秒(?:钟|鐘)?)'
    r'|三十\s*秒(?:钟|鐘)?|thirty[\s-]+seconds?)(?![A-Za-z0-9_０-９])', re.I)
TIMELINE = re.compile(
    r'(?<![A-Za-z0-9_.０-９])(?P<start>\d+(?:[.．]\d+)?)\s*'
    r'(?:(?:seconds?|secs?|[sＳｓ]|秒)\s*)?[-~～–—至到]\s*'
    r'(?P<end>\d+(?:[.．]\d+)?)\s*(?:seconds?|secs?|[sＳｓ]|秒(?:钟|鐘)?)'
    r'(?![A-Za-z0-9_])', re.I)
OLD_MODEL = re.compile(
    r'(?:(?:适配|使用|采用)\s*)?(?:Dreamina\s*)?Seedance\s*(?:1\.0|2\.0)'
    r'(?:\s*(?:Fast|Mini|Pro|Std))?(?![A-Za-z0-9_.])', re.I)


def mentions_thirty_seconds(text):
    return bool(THIRTY_SECONDS.search(text or ''))


def enabled(job):
    return job.get('model') == MODEL and job.get('durationSeconds') == 30


def clean_text(text):
    def progress(match):
        start, end = (Decimal(match[key].replace('．', '.')) for key in ['start', 'end'])
        if not 0 <= start < end <= 30:
            # Removing just the endpoint would damage an unsupported timeline.
            if start == 30 or end == 30 or mentions_thirty_seconds(match.group()):
                raise RuntimeError('DOLA_PROMPT_TIMELINE_INVALID')
            return match.group()
        def percent(value):
            return format(value / 30 * 100, '.2f').rstrip('0').rstrip('.')
        return f'全片进度 {percent(start)}%–{percent(end)}%'

    text = TIMELINE.sub(progress, text)
    text = THIRTY_SECONDS.sub('', text)
    text = OLD_MODEL.sub('', text)
    # Only collapse whitespace/separators left by removed directives; keep lines,
    # scene details, product counts and spoken content in their original order.
    text = re.sub(r'[ \t]{2,}', ' ', text)
    text = re.sub(r'[、,，]\s*([、,，。])', r'\1', text)
    return text.strip()


def prompt_parts(job, cleaned=True):
    parts = [job['prompt'].strip(), (job.get('negativePrompt') or '').strip()]
    if cleaned and enabled(job):
        parts = [clean_text(part) for part in parts]
    return parts


def build_prompt(job):
    positive, negative = prompt_parts(job)
    if not positive:
        raise RuntimeError('DOLA_PROMPT_EMPTY_AFTER_TIMING_CLEANUP')
    return positive + ('\n\nAvoid: ' + negative if negative else '')


def prompt_variants(job):
    # Old conversations contain the raw prompt; new ones contain cleaned text.
    # Both parts must match within the same user message, even when legacy
    # automatic settings were inserted between the positive and negative text.
    variants = []
    for cleaned in [False, True]:
        try:
            positive, negative = prompt_parts(job, cleaned)
        except RuntimeError:
            continue
        if not positive:
            continue
        parts = [positive] + (['Avoid: ' + negative] if negative else [])
        if parts not in variants:
            variants.append(parts)
    return variants


def matches_prompt(job, text):
    # Dola renders list markers and can reuse that rendering after verification.
    # Keep semantic punctuation such as 24-28mm, -5 degrees and word-internal '-'.
    normalize = lambda value: re.sub(r'\s+', '', re.sub(r'(?m)^[ \t]{0,3}[-*+][ \t]+(?=\S)', '', value))
    actual = normalize(text)
    return any(all(normalize(part) in actual for part in parts) for parts in prompt_variants(job))
