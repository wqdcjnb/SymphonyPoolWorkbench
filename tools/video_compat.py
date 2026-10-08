"""Keep the platform original and create an MP4 that common browsers can play."""
import json
import math
from pathlib import Path
import shutil
import subprocess
from video_ratios import VIDEO_RATIOS


def video_info(filename):
    if not shutil.which('ffprobe'):
        raise RuntimeError('VIDEO_TRANSCODER_NOT_INSTALLED')
    try:
        result = subprocess.run(['ffprobe', '-v', 'error', '-protocol_whitelist', 'file,pipe',
            '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,pix_fmt,width,height:format=duration',
            '-of', 'json', str(filename)], capture_output=True, text=True, timeout=30, check=True)
        info = json.loads(result.stdout)
        stream = info.get('streams', [])[0]
        if stream.get('width', 0) < 1 or stream.get('height', 0) < 1 or float(info['format']['duration']) <= 0:
            raise ValueError('invalid video')
        return {**stream, 'duration': float(info['format']['duration'])}
    except (subprocess.SubprocessError, ValueError, KeyError, IndexError) as error:
        raise RuntimeError('VIDEO_FILE_INVALID') from error


def prepare_browser_video(original, output, aspect_ratio='auto', duration_seconds=None):
    info = video_info(original)
    if duration_seconds is not None and abs(info['duration'] - duration_seconds) > 0.65:
        raise RuntimeError('VIDEO_DURATION_MISMATCH')
    output = Path(output)
    temporary = output.with_suffix('.browser.part.mp4')
    ratio_filter = 'scale=trunc(iw/2)*2:trunc(ih/2)*2'
    resize = False
    if aspect_ratio != 'auto':
        if aspect_ratio not in VIDEO_RATIOS:
            raise RuntimeError('INVALID_ASPECT_RATIO')
        width_unit, height_unit = map(int, aspect_ratio.split(':'))
        resize = abs(info['width'] / info['height'] - width_unit / height_unit) > 0.002
        if resize:
            # Fit the original frame without cropping. Use an even-sized canvas
            # with the exact requested ratio and at most a 1280px long edge.
            factor = 2 * max(1, math.floor(1280 / max(width_unit,height_unit) / 2))
            width,height=width_unit*factor,height_unit*factor
            ratio_filter = f'scale={width}:{height}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad={width}:{height}:(ow-iw)/2:(oh-ih)/2,setsar=1'
    try:
        if info['codec_name'] == 'h264' and info.get('pix_fmt') == 'yuv420p' and not resize:
            shutil.copyfile(original, temporary)
        else:
            if not shutil.which('ffmpeg'):
                raise RuntimeError('VIDEO_TRANSCODER_NOT_INSTALLED')
            try:
                subprocess.run(['ffmpeg', '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
                    '-threads', '2', '-protocol_whitelist', 'file,pipe', '-i', str(original),
                    '-map', '0:v:0', '-map', '0:a?', '-c:v', 'libx264', '-preset', 'fast',
                    '-crf', '20', '-pix_fmt', 'yuv420p', '-vf', ratio_filter,
                    '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', '-threads', '2', str(temporary)],
                    capture_output=True, timeout=180, check=True)
            except subprocess.SubprocessError as error:
                raise RuntimeError('VIDEO_CONVERSION_FAILED') from error
        converted = video_info(temporary)
        if converted['codec_name'] != 'h264' or converted.get('pix_fmt') != 'yuv420p':
            raise RuntimeError('VIDEO_CONVERSION_FAILED')
        if aspect_ratio != 'auto' and abs(converted['width']/converted['height']-width_unit/height_unit)>0.002:
            raise RuntimeError('PLATFORM_PARAMETERS_MISMATCH')
        if temporary.stat().st_size > 500_000_000:
            raise RuntimeError('VIDEO_TOO_LARGE')
        temporary.replace(output)
    finally:
        temporary.unlink(missing_ok=True)
