"""Download the platform-authorized original; never substitute a preview URL."""

import base64
from contextlib import suppress
import hashlib
import json
import re
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import parse_qs, urlparse
from playwright.sync_api import TimeoutError as PlaywrightTimeoutError


MAX_VIDEO_BYTES = 500_000_000
ORIGINAL_HOSTS = ("doubao.com", "douyinvod.com")
ERROR = "WATERMARK_FREE_RESULT_REQUIRED"


def validate_original_url(url):
    parsed = urlparse(url)
    query = parse_qs(parsed.query)
    if (parsed.scheme != 'https' or parsed.username or parsed.password
            or parsed.port not in (None, 443) or parsed.fragment
            or not any(parsed.hostname == host or (parsed.hostname or '').endswith('.' + host)
                       for host in ORIGINAL_HOSTS)
            or any('watermark' in value.lower() and 'no_watermark' not in value.lower()
                   for key in ('lr', 'logo_type') for value in query.get(key, []))):
        raise RuntimeError(ERROR)
    return url


def select_original(payload: dict) -> dict:
    try:
        data = payload["data"]
        if payload.get("code") != 0 or data.get("without_watermark") is not True:
            raise ValueError("not authorized")
        videos = data["download_video"]
        if len(videos) != 1:
            raise ValueError("ambiguous video")
        vid, video = next(iter(videos.items()))
        model = video["video_model"]
        model = json.loads(model) if isinstance(model, str) else model
        if not vid or video.get("vid") != vid or model.get("video_id") != vid or model.get("status") != 10:
            raise ValueError("video identity mismatch")
        candidates = []
        for stream in model["video_list"].values():
            if stream.get("vtype") != "mp4" or stream.get("encryption_method"):
                continue
            size = int(stream["size"])
            md5 = stream["file_hash"]
            url = base64.b64decode(stream["main_url"], validate=True).decode("utf-8")
            validate_original_url(url)
            if (not 12 <= size <= MAX_VIDEO_BYTES or not re.fullmatch(r"[a-fA-F0-9]{32}", md5)
                    ):
                continue
            candidates.append({"url": url, "size_bytes": size, "md5": md5.lower(),
                               "width": int(stream["vwidth"]), "height": int(stream["vheight"]),
                               "bitrate": int(stream.get("bitrate", 0))})
        if not candidates:
            raise ValueError("no original stream")
        return max(candidates, key=lambda item: (item["width"] * item["height"], item["bitrate"]))
    except (KeyError, TypeError, ValueError, AttributeError) as error:
        raise RuntimeError(ERROR) from error


def _download(context, url, target, allowed_hosts):
    # Retry only this idempotent original-file read, never a generation request.
    for attempt in range(2):
        try:
            validate_original_url(url)
            response = context.request.get(url, headers={'Referer': 'https://www.doubao.com/'},
                                           timeout=180_000, max_redirects=0)
            break
        except Exception:
            if attempt:
                raise
    try:
        if response.status != 200 or "video/mp4" not in response.headers.get("content-type", ""):
            raise RuntimeError(ERROR)
        length = response.headers.get("content-length")
        if length and int(length) > MAX_VIDEO_BYTES:
            raise RuntimeError(ERROR)
        body = response.body()
        if len(body) > MAX_VIDEO_BYTES or body[4:8] != b"ftyp":
            raise RuntimeError(ERROR)
        target.write_bytes(body)
        return {'size_bytes': int(length or 0), 'md5': response.headers.get('etag', '').strip('"').lower()}
    finally:
        response.dispose()


def save_original(context, payload: dict, output_path: Path, downloader=None) -> dict:
    original = select_original(payload)
    return save_verified_original(context, original, output_path, downloader)


def save_verified_original(context, original: dict, output_path: Path, downloader=None) -> dict:
    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    temporary = output_path.with_name(output_path.name + ".original")
    receipt_path = Path(str(output_path) + ".delivery.json")
    receipt_temp = Path(str(receipt_path) + ".part")
    try:
        urls = list(dict.fromkeys([original['url'], *original.get('backup_urls', [])]))
        for index, url in enumerate(urls):
            try:
                validate_original_url(url)
                downloaded = (downloader or _download)(context, url, temporary, ORIGINAL_HOSTS)
                downloaded = downloaded if isinstance(downloaded, dict) else {}
                expected_size = original.get('size_bytes', downloaded.get('size_bytes'))
                expected_md5 = original.get('md5', downloaded.get('md5'))
                if (not isinstance(expected_size, int) or not 12 <= expected_size <= MAX_VIDEO_BYTES
                        or not isinstance(expected_md5, str) or not re.fullmatch(r'[a-f0-9]{32}', expected_md5)):
                    raise RuntimeError('DOUBAO_ORIGINAL_EXPORT_FAILED')
                break
            except Exception as error:
                retryable = isinstance(error, PlaywrightTimeoutError) or str(error) in (
                    'VIDEO_DOWNLOAD_FAILED', 'DOUBAO_ORIGINAL_EXPORT_FAILED')
                if not retryable or index == len(urls) - 1:
                    raise
        md5, sha256 = hashlib.md5(), hashlib.sha256()
        with temporary.open("rb") as source:
            if source.read(8)[4:8] != b"ftyp":
                raise RuntimeError(ERROR)
            source.seek(0)
            while block := source.read(65536):
                md5.update(block)
                sha256.update(block)
        size = temporary.stat().st_size
        if size != expected_size or md5.hexdigest() != expected_md5:
            raise RuntimeError(ERROR)
        receipt = {"version": 1, "source": "doubao_authorized_original", "watermark_free": True,
                   "sha256": sha256.hexdigest(), "source_md5": md5.hexdigest(), "size_bytes": size,
                   "verified_at": datetime.now(timezone.utc).isoformat()}
        if original.get('export_endpoint'):
            receipt['export_endpoint'] = original['export_endpoint']
            receipt['source_checksum'] = 'http_etag_md5'
        receipt_temp.write_text(json.dumps(receipt), encoding="utf-8")
        temporary.replace(output_path)
        receipt_temp.replace(receipt_path)
        return receipt
    except Exception as error:
        if isinstance(error, PlaywrightTimeoutError):
            raise RuntimeError('DOUBAO_ORIGINAL_EXPORT_TIMEOUT') from None
        if str(error) in ('VIDEO_DOWNLOAD_FAILED', 'DOUBAO_ORIGINAL_EXPORT_FAILED'):
            raise RuntimeError('DOUBAO_ORIGINAL_EXPORT_FAILED') from None
        raise RuntimeError(ERROR) from None
    finally:
        temporary.unlink(missing_ok=True)
        receipt_temp.unlink(missing_ok=True)


def workspace_original(context, page, vid):
    # Match the rendered video's resource ID to its creation-library node.
    # The older creativity endpoint can say without_watermark=true while
    # returning a video_gen_watermark_dyn playback stream.
    result = page.evaluate('''async vid => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 30000);
        const suffix = '?aid=497858&device_platform=web&samantha_web=1&use-olympus-account=1&version_code=20800&pkg_type=release_version';
        const post = async (path, body) => {
            const response = await fetch('/samantha/aispace/' + path + suffix, {
                method:'POST', credentials:'include', signal:controller.signal,
                headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)});
            const data = await response.json();
            if (response.status !== 200 || data.code !== 0) throw new Error('export_failed');
            return data.data;
        };
        try {
            const home = await post('homepage', {});
            const roots = (home.children || []).filter(node => node.name === '我的创作');
            if (roots.length !== 1) return {error:'not_found'};
            let cursor, node;
            for (let batch=0; batch<20; batch++) {
                const data = await post('node_info', {node_id:roots[0].id, need_full_path:true,
                    size:50, ...(cursor == null ? {} : {cursor}),
                    sort_param:{need_sort_config:true,sort_order:1,sort_type:0}});
                const matches = (data.children || []).filter(item => String(item.key) === vid);
                if (matches.length > 1) return {error:'identity'};
                if (matches.length === 1) {node=matches[0];break;}
                if (!data.has_more || data.next_cursor == null || data.next_cursor === cursor) break;
                cursor = data.next_cursor;
            }
            if (!node) return {error:'not_found'};
            const data = await post('get_download_info', {requests:[{node_id:node.id}]});
            const infos = data.download_infos || [];
            if (infos.length !== 1 || String(infos[0].node_id) !== String(node.id)) return {error:'identity'};
            return {video_id:String(node.key), url:infos[0].main_url, backup_url:infos[0].backup_url};
        } catch (error) {return {error:error.name === 'AbortError' ? 'timeout' : 'export_failed'};}
        finally {clearTimeout(timer);}
    }''', vid)
    if result.get('error') == 'timeout':
        raise RuntimeError('DOUBAO_ORIGINAL_EXPORT_TIMEOUT')
    if result.get('error') == 'identity' or (not result.get('error') and result.get('video_id') != vid):
        raise RuntimeError(ERROR)
    if result.get('error'):
        raise RuntimeError('DOUBAO_ORIGINAL_EXPORT_FAILED')
    url = validate_original_url(result['url'])
    # Verify Content-Length and ETag on the actual GET response. Some CDN edges
    # stall HEAD requests or omit its metadata despite serving the file normally.
    backups = []
    if isinstance(result.get('backup_url'), str) and result['backup_url']:
        # A backup is usable only when returned for this same creation node.
        # Never construct CDN URLs or strip signed query parameters ourselves.
        with suppress(RuntimeError, ValueError):
            backups.append(validate_original_url(result['backup_url']))
    return {'url':url,'backup_urls':backups,'export_endpoint':'samantha/aispace/get_download_info'}


def export_original(context, page, output_path: Path, downloader=None) -> dict:
    def is_export(response):
        parsed = urlparse(response.url)
        return (parsed.scheme == "https" and parsed.hostname == "www.doubao.com"
                and parsed.path == "/creativity/resource/get_without_watermark")

    session = None
    scope = {}
    try:
        # Use the creation-library original, matched to the current result card.
        vid = original_video_id(page)
        if vid:
            original = workspace_original(context, page, vid)
            return save_verified_original(context, original, output_path, downloader)
        # The page also starts a blob download. Chrome's native download UI can
        # crash in the container; delivery uses the verified original below.
        # Scope the override to this account and restore normal manual downloads.
        session = context.new_cdp_session(page)
        info = session.send("Target.getTargetInfo")["targetInfo"]
        if info.get("browserContextId"):
            scope["browserContextId"] = info["browserContextId"]
        session.send("Browser.setDownloadBehavior", {"behavior": "deny", **scope})
        with page.expect_response(is_export, timeout=30_000) as pending:
            page.get_by_test_id("edit_image_download_button").click(timeout=15_000)
        response = pending.value
        if response.status != 200:
            raise RuntimeError('DOUBAO_ORIGINAL_EXPORT_FAILED')
        return save_original(context, response.json(), output_path, downloader)
    except PlaywrightTimeoutError as error:
        raise RuntimeError('DOUBAO_ORIGINAL_EXPORT_TIMEOUT') from None
    except Exception as error:
        if str(error) in (ERROR, 'DOUBAO_ORIGINAL_EXPORT_TIMEOUT','DOUBAO_ORIGINAL_EXPORT_FAILED'):
            raise RuntimeError(str(error)) from None
        raise RuntimeError('DOUBAO_ORIGINAL_EXPORT_FAILED') from None
    finally:
        if session is not None:
            with suppress(Exception):
                session.send("Browser.setDownloadBehavior", {"behavior": "default", **scope})
            with suppress(Exception):
                session.detach()


def original_video_id(page):
    card = page.locator('[class*="block-video-"]')
    if card.count() > 1:
        raise RuntimeError(ERROR)
    if card.count() != 1:
        return None
    # Read only the selected rendered card's resource identifier. Do not scan
    # account state, cookies, other messages, or unrelated videos in a list.
    value = card.evaluate('''element => {
        const key = Object.keys(element).find(key => key.startsWith('__reactFiber$'));
        let fiber = element[key]; const ids = new Set();
        for (let depth=0; fiber && depth<8; depth++,fiber=fiber.return) {
            for (const media of [fiber.memoizedProps?.video,fiber.memoizedProps?.media]) {
                if (typeof media?.vid === 'string') ids.add(media.vid);
            }
        }
        return ids.size === 1 ? [...ids][0] : null;
    }''')
    return value if isinstance(value,str) and re.fullmatch(r'[A-Za-z0-9_-]{8,128}',value) else None
