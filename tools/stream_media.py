"""Bounded downloads with the account's explicit proxy and cookie scope."""
import json
import os
from pathlib import Path
from urllib.parse import urlparse, quote
import requests


def session_for_account(context=None):
    session = requests.Session()
    session.trust_env = False
    proxy = json.loads(os.environ.get('WORKBENCH_BROWSER_PROXY', 'null') or 'null')
    if proxy:
        parsed = urlparse(proxy['server'])
        auth = ''
        if proxy.get('username'):
            auth = quote(proxy['username'], safe='') + ':' + quote(proxy.get('password', ''), safe='') + '@'
        scheme = 'socks5h' if parsed.scheme == 'socks5' else parsed.scheme
        address = f'{scheme}://{auth}{parsed.netloc}'
        session.proxies = {'http': address, 'https': address}
    if context:
        for cookie in context.cookies():
            session.cookies.set(cookie['name'], cookie['value'], domain=cookie['domain'], path=cookie['path'], secure=cookie.get('secure', True))
    return session


def download_video(context, url, output, allowed_hosts):
    def allowed(value):
        parsed = urlparse(value)
        return parsed.scheme == 'https' and any(parsed.hostname == h or (parsed.hostname or '').endswith('.' + h) for h in allowed_hosts)
    if not allowed(url):
        raise RuntimeError('UNEXPECTED_MEDIA_HOST')
    temporary = Path(output).with_suffix('.part')
    Path(output).parent.mkdir(parents=True, exist_ok=True)
    try:
        with session_for_account(context) as session:
            # Do not forward cookies or proxy credentials to an unvalidated redirect target.
            # Doubao's creation-library CDN requires its page as the referrer.
            headers = {'Referer': 'https://www.doubao.com/'} if 'doubao.com' in allowed_hosts else {}
            with session.get(url, stream=True, timeout=(20, 90), allow_redirects=False, headers=headers) as response:
                if response.status_code != 200 or 'video/mp4' not in response.headers.get('Content-Type', ''):
                    raise RuntimeError('VIDEO_DOWNLOAD_FAILED')
                size = 0
                metadata = {'size_bytes': int(response.headers.get('Content-Length', '0')),
                            'md5': response.headers.get('ETag', '').strip('"').lower()}
                with temporary.open('wb') as target:
                    for block in response.iter_content(65536):
                        size += len(block)
                        if size > 500_000_000:
                            raise RuntimeError('VIDEO_TOO_LARGE')
                        target.write(block)
                with temporary.open('rb') as source:
                    if source.read(8)[4:8] != b'ftyp':
                        raise RuntimeError('VIDEO_DOWNLOAD_FAILED')
        temporary.replace(output)
        return metadata
    except requests.RequestException:
        raise RuntimeError('VIDEO_DOWNLOAD_FAILED') from None
    finally:
        temporary.unlink(missing_ok=True)
