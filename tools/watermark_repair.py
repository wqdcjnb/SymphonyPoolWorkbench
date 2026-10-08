"""Create a labelled derivative of a Dola clip; keep the downloaded source intact."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import shutil
import sys
import uuid

from video_compat import video_info
from video_ratios import VIDEO_RATIOS, delivery_dimensions

MAX_BYTES = 500_000_000
ENGINE = 'dola-tracked-glyph-v1'
ASSET = Path(__file__).with_name('dola-logo-mask.png')


def sha256(path):
    digest = hashlib.sha256()
    with Path(path).open('rb') as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def cached_receipt(target, source_hash, ratio, duration, asset_hash):
    try:
        target = Path(target)
        if target.is_symlink():
            return None
        saved = json.loads(Path(str(target) + '.delivery.json').read_text(encoding='utf-8'))
        if (saved['version'] == 3 and saved['source'] == 'dola_postprocessed'
                and saved['delivery_mode'] == 'watermark_repair' and saved['postprocessed'] is True
                and saved['watermark_free'] is None
                and saved['source_sha256'] == source_hash and saved['processing']['preset'] == ENGINE
                and saved['processing']['method'] == 'opencv_temporal_inpaint'
                and saved['processing']['template_sha256'] == asset_hash
                and saved['requested_ratio'] == ratio and saved['requested_duration'] == duration
                and target.stat().st_size == saved['size_bytes'] and sha256(target) == saved['sha256']):
            return saved
    except (OSError, ValueError, KeyError, TypeError):
        pass
    return None


def repair_video(source, output, ratio, duration, reuse=None):
    source, output = Path(source), Path(output)
    if source.is_symlink() or output.is_symlink() or source.resolve() == output.resolve():
        raise RuntimeError('WATERMARK_REPAIR_INVALID_INPUT')
    if not source.is_file() or not 12 <= source.stat().st_size <= MAX_BYTES:
        raise RuntimeError('WATERMARK_REPAIR_INVALID_INPUT')
    if ratio not in VIDEO_RATIOS or duration not in (5, 10, 30):
        raise RuntimeError('WATERMARK_REPAIR_INVALID_INPUT')
    info = video_info(source)
    width, height = delivery_dimensions(ratio, info['width'], info['height'])
    if abs(info['duration'] - duration) > .65:
        raise RuntimeError('VIDEO_DURATION_MISMATCH')
    source_hash = sha256(source)
    asset_hash = sha256(ASSET)
    receipt_path = Path(str(output) + '.delivery.json')
    saved = cached_receipt(output, source_hash, ratio, duration, asset_hash)
    if saved:
        return saved
    if not shutil.which('ffmpeg'):
        raise RuntimeError('VIDEO_TRANSCODER_NOT_INSTALLED')
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_name(output.stem + '.' + uuid.uuid4().hex + '.part.mp4')
    receipt_temp = Path(str(temporary) + '.json')
    try:
        reusable = cached_receipt(reuse, source_hash, ratio, duration, asset_hash) if reuse else None
        if reusable:
            shutil.copyfile(reuse, temporary)
            if sha256(temporary) != reusable['sha256']:
                raise RuntimeError('WATERMARK_REPAIR_FAILED')
            processing = reusable['processing']
        else:
            from dola_watermark_tracker import tracked_repair
            processing = tracked_repair(source, temporary, ratio)
            processing['template_sha256'] = asset_hash
        media = video_info(temporary)
        if (media['codec_name'] != 'h264' or media.get('pix_fmt') != 'yuv420p'
                or (media['width'], media['height']) != (width, height)
                or abs(media['duration'] - info['duration']) > .15
                or not 12 <= temporary.stat().st_size <= MAX_BYTES
                or sha256(source) != source_hash):
            raise RuntimeError('WATERMARK_REPAIR_FAILED')
        receipt = {'version': 3, 'source': 'dola_postprocessed', 'delivery_mode': 'watermark_repair',
            'watermark_free': None, 'postprocessed': True, 'source_sha256': source_hash,
            'sha256': sha256(temporary), 'size_bytes': temporary.stat().st_size,
            'requested_ratio': ratio, 'requested_duration': duration, 'media': media,
            'processing': processing,
            'verified_at': datetime.now(timezone.utc).isoformat()}
        receipt_temp.write_text(json.dumps(receipt), encoding='utf-8')
        temporary.replace(output)
        receipt_temp.replace(receipt_path)
        return receipt
    finally:
        temporary.unlink(missing_ok=True)
        receipt_temp.unlink(missing_ok=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--input', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--ratio', required=True)
    parser.add_argument('--duration', required=True, type=int)
    parser.add_argument('--reuse')
    args = parser.parse_args()
    try:
        result = repair_video(args.input, args.output, args.ratio, args.duration, args.reuse)
        print(json.dumps({'ok': True, 'sha256': result['sha256'], 'size_bytes': result['size_bytes']}))
    except Exception as error:
        code = str(error)
        if code not in {'WATERMARK_REPAIR_INVALID_INPUT', 'WATERMARK_REPAIR_UNSUPPORTED_LAYOUT',
                        'VIDEO_DURATION_MISMATCH', 'VIDEO_TRANSCODER_NOT_INSTALLED'}:
            code = 'WATERMARK_REPAIR_FAILED'
        print(json.dumps({'ok': False, 'code': code}))
        sys.exit(1)
