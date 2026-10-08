"""Bounded-memory tracking and glyph repair, calibrated from our Dola sample.

The linked upstream tool informed the choice of temporal matching and inpainting.
This implementation and its calibration mask are independent; see WATERMARK.md.
"""
from fractions import Fraction
from pathlib import Path
import subprocess
import tempfile
import time

import cv2
import numpy as np
from video_ratios import delivery_dimensions, validate_source_dimensions

ASSET = Path(__file__).with_name('dola-logo-mask.png')
ENGINE = 'dola-tracked-glyph-v1'


def edge(image):
    return cv2.magnitude(cv2.Sobel(image, cv2.CV_32F, 1, 0),
                         cv2.Sobel(image, cv2.CV_32F, 0, 1))


def template(mask, scale):
    size = tuple(max(8, round(n * scale)) for n in (mask.shape[1], mask.shape[0]))
    glyph = cv2.resize(mask, size, interpolation=cv2.INTER_AREA)
    gray = cv2.GaussianBlur(glyph, (3, 3), .6)
    return glyph, gray, edge(gray)


def match(gray, tpl):
    if min(gray.shape) < min(tpl[1].shape) or any(a < b for a, b in zip(gray.shape, tpl[1].shape)):
        return 0., (0, 0)
    intensity = cv2.matchTemplate(gray, tpl[1], cv2.TM_CCOEFF_NORMED)
    gradient = cv2.matchTemplate(edge(gray), tpl[2], cv2.TM_CCOEFF_NORMED)
    combined = intensity * .6 + gradient * .4
    _, confidence, _, location = cv2.minMaxLoc(combined)
    x, y = location
    h, w = tpl[1].shape
    # Normalized correlation can amplify barely visible codec noise on a flat
    # repaired background. Require measurable contrast before calling it ink.
    if float(np.std(gray[y:y+h, x:x+w])) < 4.:
        confidence = 0.
    return confidence, location


def trajectory_groups(hits, fps):
    """Reject isolated texture matches; fit each continuous location separately."""
    groups, current = [], []
    for hit in hits:
        if current:
            dt = hit[0] - current[-1][0]
            distance = np.linalg.norm(np.array(hit[1:3]) - current[-1][1:3])
            if dt > fps * .8 or distance > max(15, dt * 8):
                groups.append(current)
                current = []
        current.append(hit)
    groups.append(current)
    tracks = []
    for group in groups:
        if len(group) < 4:
            continue
        values = np.asarray(group, dtype=float)
        coeff = np.polyfit(values[:, 0], values[:, 1:3], 1)
        residual = np.linalg.norm(values[:, 1:3] - np.polyval(coeff, values[:, 0, None]), axis=1)
        keep = residual < max(3., np.median(residual) * 2.5)
        values = values[keep]
        if len(values) < 4 or values[-1, 0] - values[0, 0] < fps * .35:
            continue
        coeff = np.polyfit(values[:, 0], values[:, 1:3], 1)
        tracks.append({'start': max(0, int(values[0, 0] - fps * .6)),
                       'end': int(values[-1, 0] + fps * .6), 'coeff': coeff,
                       'hits': len(values), 'score': float(np.median(values[:, 3]))})
    return tracks


def analyze(source):
    deadline = time.monotonic() + 120
    cv2.setNumThreads(2)
    mask = cv2.imdecode(np.fromfile(ASSET, dtype=np.uint8), cv2.IMREAD_GRAYSCALE)
    if mask is None:
        raise RuntimeError('WATERMARK_REPAIR_ASSET_MISSING')
    capture = cv2.VideoCapture(str(source))
    if not capture.isOpened():
        raise RuntimeError('VIDEO_FILE_INVALID')
    try:
        width, height = (int(capture.get(prop)) for prop in (cv2.CAP_PROP_FRAME_WIDTH, cv2.CAP_PROP_FRAME_HEIGHT))
        validate_source_dimensions(width, height)
        fps, count = capture.get(cv2.CAP_PROP_FPS), int(capture.get(cv2.CAP_PROP_FRAME_COUNT))
        if not (1 <= fps <= 120 and 1 <= count <= 12000 and width * height <= 8_500_000):
            raise RuntimeError('WATERMARK_REPAIR_UNSUPPORTED_LAYOUT')
        factor = min(1., 640 / max(width, height))
        work_size = (round(width * factor), round(height * factor))
        base_scales = (.5, .55, .6, .65, .7, .75, .8, .85, .9, .95, 1., 1.05, 1.1, 1.2, 1.35, 1.5, 1.7)
        resolution_scale = min(width, height) / 960
        scales = sorted(set(base_scales) | {round(s * resolution_scale, 3) for s in base_scales
                                           if .25 <= s * resolution_scale <= 4.})
        candidates = [template(mask, scale * factor) for scale in scales]
        scores = [[] for _ in scales]
        for index in np.linspace(min(count - 1, fps), max(0, count - fps), 7).astype(int):
            capture.set(cv2.CAP_PROP_POS_FRAMES, int(index))
            ok, frame = capture.read()
            if not ok:
                continue
            gray = cv2.cvtColor(cv2.resize(frame, work_size), cv2.COLOR_BGR2GRAY)
            for i, candidate in enumerate(candidates):
                scores[i].append(match(gray, candidate)[0])
        quality = [float(np.median(sorted(s)[-4:])) if s else 0. for s in scores]
        chosen = int(np.argmax(quality))
        tpl = candidates[chosen]
        capture.set(cv2.CAP_PROP_POS_FRAMES, 0)
        hits, index = [], 0
        stride = max(1, round(fps / 8))
        while capture.grab():
            if time.monotonic() > deadline:
                raise RuntimeError('WATERMARK_REPAIR_TIMEOUT')
            if index % stride == 0:
                ok, frame = capture.retrieve()
                if not ok:
                    raise RuntimeError('VIDEO_FILE_INVALID')
                gray = cv2.cvtColor(cv2.resize(frame, work_size), cv2.COLOR_BGR2GRAY)
                confidence, point = match(gray, tpl)
                if confidence >= .43:
                    hits.append((index, *point, confidence))
            index += 1
        tracks = trajectory_groups(hits, fps)
        if not tracks:
            raise RuntimeError('WATERMARK_REPAIR_UNCONFIRMED')
        return {'width': width, 'height': height, 'fps': fps, 'count': index,
                'factor': factor, 'scale': scales[chosen], 'tracks': tracks,
                'template': template(mask, scales[chosen]), 'scan_template': tpl, 'hits': len(hits)}
    finally:
        capture.release()


def repair_frame(frame, analysis, index):
    glyph, _, _ = analysis['template']
    height, width = frame.shape[:2]
    repaired = False
    for track in analysis['tracks']:
        if not track['start'] <= index <= track['end']:
            continue
        point = np.polyval(track['coeff'], index) / analysis['factor']
        x, y = np.round(point).astype(int)
        h, w = glyph.shape
        if x < 0 or y < 0 or x + w > width or y + h > height:
            continue
        margin = max(16, round(20 * analysis['scale']))
        left, top, right, bottom = max(0, x-margin), max(0, y-margin), min(width, x+w+margin), min(height, y+h+margin)
        roi = frame[top:bottom, left:right]
        mask = np.zeros(roi.shape[:2], np.uint8)
        mask[y-top:y-top+h, x-left:x-left+w] = glyph
        # Dola's drop shadow extends several pixels past the white glyph;
        # leaving its halo outside the mask imprints faint text after repair.
        spread = max(13, round(17 * analysis['scale']) | 1)
        mask = cv2.dilate((mask > 24).astype(np.uint8)*255, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (spread, spread)))
        # Only the letters and their antialias/shadow border are interpolated.
        cleaned = cv2.inpaint(roi, mask, 3, cv2.INPAINT_TELEA)
        frame[top:bottom, left:right] = cleaned
        repaired = True
    scores = []
    if index % max(1, round(analysis['fps']/2)) == 0:
        size = (round(width*analysis['factor']), round(height*analysis['factor']))
        gray = cv2.cvtColor(cv2.resize(frame, size), cv2.COLOR_BGR2GRAY)
        scores.append(match(gray, analysis['scan_template'])[0])
    return repaired, scores


def render(source, output, ratio, analysis):
    width, height, fps = analysis['width'], analysis['height'], analysis['fps']
    out_w, out_h = delivery_dimensions(ratio, width, height)
    filters = (f'pad={out_w}:{out_h}:0:0,setsar=1' if ratio == 'auto' else
               f'scale={out_w}:{out_h}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad={out_w}:{out_h}:(ow-iw)/2:(oh-ih)/2,setsar=1')
    capture = cv2.VideoCapture(str(source))
    command = ['ffmpeg', '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
               '-f', 'rawvideo', '-pix_fmt', 'bgr24', '-s', f'{width}x{height}',
               '-r', str(Fraction(fps).limit_denominator(1001)), '-i', 'pipe:0',
               '-threads', '2', '-protocol_whitelist', 'file,pipe', '-i', str(source),
               '-map', '0:v:0', '-map', '1:a?', '-vf', filters,
               '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p',
               '-c:a', 'copy', '-movflags', '+faststart', '-threads', '2', str(output)]
    count, repaired, residuals = 0, 0, []
    deadline = time.monotonic() + 180
    with tempfile.TemporaryFile() as log:
        process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=log)
        try:
            while True:
                if time.monotonic() > deadline:
                    raise RuntimeError('WATERMARK_REPAIR_TIMEOUT')
                ok, frame = capture.read()
                if not ok:
                    break
                changed, scores = repair_frame(frame, analysis, count)
                process.stdin.write(frame.tobytes())
                repaired += int(changed)
                residuals.extend(scores)
                count += 1
            process.stdin.close()
            if process.wait(timeout=30) != 0 or count != analysis['count']:
                raise RuntimeError('WATERMARK_REPAIR_FAILED')
            if not residuals or np.count_nonzero(np.array(residuals) > .43) > max(1, len(residuals)*.03):
                raise RuntimeError('WATERMARK_REPAIR_UNCONFIRMED')
        except Exception:
            process.kill()
            process.wait()
            raise
        finally:
            capture.release()
            if not process.stdin.closed:
                try:
                    process.stdin.close()
                except BrokenPipeError:
                    pass
    return {'method': 'opencv_temporal_inpaint', 'preset': ENGINE, 'template_scale': analysis['scale'],
            'segments': len(analysis['tracks']), 'detections': analysis['hits'],
            'frames': count, 'repaired_frames': repaired,
            'residual_score_p95': round(float(np.percentile(residuals, 95)), 4) if residuals else None,
            'quality_note': 'Tracked glyph interpolation; local detail may be softened.'}


def tracked_repair(source, output, ratio):
    return render(source, output, ratio, analyze(source))
