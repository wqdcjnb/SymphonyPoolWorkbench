"""Symphony v1: Python 3.10+ standard library. Credentials come from the environment."""
import argparse
import hashlib
import http.client
import json
import math
import os
from pathlib import Path
import re
import random
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class ApiError(RuntimeError):
    def __init__(self, status, code, retry_after=0):
        self.status, self.code, self.retry_after = status, code, retry_after
        super().__init__(f'HTTP {status}: {code}')


def terminal(task):
    return task.get('status') in ('succeeded', 'partially_succeeded', 'failed', 'cancelled')


def retryable(error):
    return (isinstance(error, ApiError) and error.status in (408, 429, 500, 502, 503, 504)
            or isinstance(error, (urllib.error.URLError, TimeoutError, ConnectionError, http.client.IncompleteRead)))


def safe_task(task):
    return {key: task[key] for key in ('task_id', 'client_task_id', 'status', 'terminal', 'poll_after_seconds',
            'completed_count', 'succeeded_count', 'failed_count', 'cancelled_count', 'wait_expired',
            'retrying', 'delivery_pending', 'progress', 'progress_sequence') if key in task}


class Client:
    def __init__(self, base=None, key=None, clock=time.monotonic, sleep=time.sleep, random_value=random.random):
        self.clock, self.sleep, self.random = clock, sleep, random_value
        self.base = (base or os.environ.get('PARTNER_API_BASE_URL', 'https://47.84.3.74/v1')).rstrip('/')
        self.key = key or os.environ.get('PARTNER_API_KEY', '')
        parsed = urllib.parse.urlsplit(self.base)
        if parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path != '/v1':
            raise ValueError('INVALID_API_BASE_URL')
        if parsed.scheme != 'https' and not (parsed.scheme == 'http' and parsed.hostname in ('localhost', '127.0.0.1')):
            raise ValueError('HTTPS_REQUIRED')
        if not self.key:
            raise ValueError('Set PARTNER_API_KEY locally before running this client.')
        self.opener = urllib.request.build_opener(NoRedirect)

    def open(self, path, method='GET', data=None, content_type=None):
        headers = {'Authorization': 'Bearer ' + self.key, 'Accept': 'application/json'}
        if content_type:
            headers['Content-Type'] = content_type
        req = urllib.request.Request(self.base + path, data=data, headers=headers, method=method)
        try:
            return self.opener.open(req, timeout=120)
        except urllib.error.HTTPError as error:
            try:
                code = json.loads(error.read(65536)).get('error', {}).get('code', 'HTTP_ERROR')
            except (ValueError, AttributeError):
                code = 'UNEXPECTED_RESPONSE'
            retry = error.headers.get('Retry-After', '0')
            raise ApiError(error.code, code, int(retry) if retry.isdigit() else 0) from None

    def request(self, path, method='GET', payload=None):
        data = None if payload is None else json.dumps(payload, ensure_ascii=False).encode()
        with self.open(path, method, data, 'application/json' if data else None) as response:
            return json.load(response)

    def submit(self, task, images=()):
        if not re.fullmatch(r'[A-Za-z0-9_-]{1,128}', task.get('client_task_id', '')):
            raise ValueError('CLIENT_TASK_ID_REQUIRED')
        for attempt in range(4):
            try:
                return self._submit_once(task, images)
            except Exception as error:
                if attempt == 3 or not retryable(error):
                    raise
                self.sleep(max(getattr(error, 'retry_after', 0), 5 * 2**attempt))

    def _submit_once(self, task, images=()):
        if not images:
            return self.request('/videos', 'POST', task)
        if len(images) > 9:
            raise ValueError('TOO_MANY_IMAGES')
        boundary = 'symphony-' + uuid.uuid4().hex
        parts = [f'--{boundary}\r\nContent-Disposition: form-data; name="task"\r\n\r\n'.encode(),
                 json.dumps(task, ensure_ascii=False).encode(), b'\r\n']
        size = 0
        for index, name in enumerate(images, 1):
            image = Path(name)
            if image.stat().st_size > 20 * 1024**2:
                raise ValueError('IMAGE_TOO_LARGE')
            data = image.read_bytes()
            size += len(data)
            if size > 100 * 1024**2:
                raise ValueError('IMAGES_TOO_LARGE')
            parts += [f'--{boundary}\r\nContent-Disposition: form-data; name="images"; filename="image-{index}"\r\nContent-Type: application/octet-stream\r\n\r\n'.encode(), data, b'\r\n']
        parts.append(f'--{boundary}--\r\n'.encode())
        with self.open('/videos', 'POST', b''.join(parts), f'multipart/form-data; boundary={boundary}') as response:
            return json.load(response)

    @staticmethod
    def task_path(task_id):
        if not re.fullmatch(r'task-[a-f0-9-]{36}', task_id):
            raise ValueError('INVALID_TASK_ID')
        return '/videos/' + task_id

    def download(self, task_id, result, output, delivery_mode='official_original'):
        index = result['index']
        if type(index) is not int or not 1 <= index <= 100:
            raise ValueError('INVALID_RESULT_INDEX')
        repaired = (delivery_mode == 'watermark_repair' and result.get('delivery_mode') == 'watermark_repair'
                    and result.get('postprocessed') is True and result.get('watermark_free') is None)
        if not result.get('video_url') or (not repaired and result.get('watermark_free') is not True):
            raise ValueError('WATERMARK_FREE_RESULT_REQUIRED')
        directory = Path(output)
        directory.mkdir(parents=True, exist_ok=True)
        target = directory / f'{task_id}-{index}.mp4'
        if target.exists():
            if hashlib.sha256(target.read_bytes()).hexdigest() == result['sha256']:
                return target
            raise ValueError('LOCAL_FILE_CONFLICT')
        temporary = directory / f'.download-{uuid.uuid4().hex}.part'
        checksum, total = hashlib.sha256(), 0
        try:
            with self.open(self.task_path(task_id) + f'/results/{index}') as response, temporary.open('xb') as file:
                if response.headers.get_content_type() != 'video/mp4':
                    raise ValueError('UNEXPECTED_MEDIA_TYPE')
                while chunk := response.read(1024 * 1024):
                    checksum.update(chunk)
                    total += len(chunk)
                    file.write(chunk)
            if total != result['size_bytes'] or checksum.hexdigest() != result['sha256']:
                raise ValueError('VIDEO_CHECKSUM_MISMATCH')
            temporary.replace(target)
            return target
        finally:
            temporary.unlink(missing_ok=True)

    def wait(self, task_id, output='videos', timeout=0, interval=60, on_progress=None):
        self.task_path(task_id)
        if not math.isfinite(timeout) or timeout < 0 or not math.isfinite(interval) or interval <= 0:
            raise ValueError('INVALID_WAIT_OPTIONS')
        progress = on_progress or (lambda task: print(json.dumps(safe_task(task))))
        deadline = self.clock() + timeout if timeout else float('inf')
        task = {'task_id': task_id, 'status': 'unknown', 'terminal': False}
        failures = 0
        while self.clock() < deadline:
            pause = interval
            try:
                task = self.request(self.task_path(task_id))
                task['terminal'] = terminal(task)
                failures = 0
                if not terminal(task):
                    progress(safe_task(task))
                if terminal(task):
                    paths = [str(self.download(task_id, r, output, task.get('delivery_mode', 'official_original')))
                             for r in task.get('results', []) if r['status'] == 'succeeded']
                    return {**safe_task(task), 'files': paths,
                            'errors': [r['error']['code'] for r in task.get('results', []) if r.get('error')]}
                pause = max(interval, task.get('poll_after_seconds') or 60)
            except Exception as error:
                if not retryable(error):
                    raise
                pause = max(interval, getattr(error, 'retry_after', 0), min(300, 15 * 2**min(failures, 5)))
                failures += 1
                progress({**safe_task(task), 'retrying': True, 'delivery_pending': terminal(task)})
            self.sleep(max(0, min(pause * (1 + self.random() * .15), deadline - self.clock())))
        return {**safe_task(task), 'terminal': terminal(task), 'wait_expired': True,
                **({'delivery_pending': True} if terminal(task) else {})}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['models', 'submit', 'get', 'wait', 'cancel'])
    parser.add_argument('value', nargs='?')
    parser.add_argument('--image', action='append', default=[])
    parser.add_argument('--output', default='videos')
    parser.add_argument('--timeout', type=float, default=0, help='Local wait limit in seconds; 0 keeps watching until terminal')
    parser.add_argument('--interval', type=float, default=60)
    parser.add_argument('--state-dir', default='.symphony-tasks')
    args = parser.parse_args()
    client = Client()
    def record(task):
        safe = {**safe_task(task), 'updated_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}
        if safe.get('task_id'):
            client.task_path(safe['task_id'])
            directory = Path(args.state_dir)
            directory.mkdir(parents=True, exist_ok=True)
            target = directory / (safe['task_id'] + '.json')
            temporary = directory / (safe['task_id'] + '.' + uuid.uuid4().hex + '.tmp')
            temporary.write_text(json.dumps(safe, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
            temporary.replace(target)
        print(json.dumps({**safe, **({'files': task['files'], 'errors': task['errors']} if 'files' in task else {})}, ensure_ascii=False))
    if args.action == 'models':
        result = client.request('/models')
    elif args.action == 'submit':
        result = client.submit(json.loads(Path(args.value).read_text(encoding='utf-8-sig')), args.image)
    elif args.action == 'wait':
        result = client.wait(args.value, args.output, args.timeout, args.interval, record)
    else:
        path = client.task_path(args.value)
        result = client.request(path + ('/cancel' if args.action == 'cancel' else ''), 'POST' if args.action == 'cancel' else 'GET')
    if 'task_id' in result:
        result['terminal'] = terminal(result)
        record(result)
        return 2 if terminal(result) and result['status'] != 'succeeded' else 0
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')
    try:
        sys.exit(main())
    except (ApiError, ValueError, TimeoutError, OSError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
