"""Call verify_webhook with the untouched HTTP body bytes, before JSON parsing."""
import hashlib
import hmac
import json
import time


def verify_webhook(raw_body, headers, secret, now=None):
    headers = {key.lower(): value for key, value in headers.items()}
    stamp = headers.get('x-webhook-timestamp', '')
    if not stamp.isascii() or not stamp.isdigit():
        raise ValueError('INVALID_WEBHOOK_TIMESTAMP')
    if abs((time.time() if now is None else now) - int(stamp)) > 300:
        raise ValueError('WEBHOOK_TIMESTAMP_EXPIRED')
    expected = 'sha256=' + hmac.new(secret.encode(), stamp.encode()+b'.'+raw_body, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, headers.get('x-webhook-signature', '')):
        raise ValueError('INVALID_WEBHOOK_SIGNATURE')
    event = json.loads(raw_body)
    if not event.get('event_id') or event['event_id'] != headers.get('x-webhook-id'):
        raise ValueError('WEBHOOK_ID_MISMATCH')
    return event

# In your HTTPS handler:
# 1. event = verify_webhook(request_raw_bytes, request_headers, configured_secret)
# 2. Atomically save/queue event, deduplicated by event['event_id'].
# 3. Return 2xx promptly, including for duplicates. Download files in a background job.
