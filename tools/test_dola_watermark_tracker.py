"""Real codec regression: drifting/fading logo, source retention, audio, fail closed."""
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import cv2
import numpy as np

from dola_watermark_tracker import ASSET
from watermark_repair import repair_video, sha256


@unittest.skipUnless(shutil.which('ffmpeg'), 'ffmpeg required')
class TrackingTests(unittest.TestCase):
    def fixture(self, root, logo=True, size=(960, 960), glyph_scale=1.):
        width, height = size
        silent = root / 'silent.mp4'
        writer = cv2.VideoWriter(str(silent), cv2.VideoWriter_fourcc(*'mp4v'), 24, size)
        self.assertTrue(writer.isOpened())
        glyph = cv2.imdecode(np.fromfile(ASSET, np.uint8), cv2.IMREAD_GRAYSCALE)
        if glyph_scale != 1.:
            glyph = cv2.resize(glyph, (round(glyph.shape[1]*glyph_scale), round(glyph.shape[0]*glyph_scale)), interpolation=cv2.INTER_AREA)
        for n in range(120):
            frame = np.full((height, width, 3), 40, np.uint8)
            if logo:
                # Abrupt relocation splits two moving tracks; ends fade out.
                x, y = (120+n*3, 200+n) if n < 60 else (650-(n-60)*2, 650-(n-60))
                x, y = round(x*width/960), round(y*height/960)
                opacity = min(1., (n+1)/6, (120-n)/6)
                alpha = glyph.astype(np.float32)[:, :, None]/255 * opacity
                h, w = glyph.shape
                frame[y:y+h, x:x+w] = (40*(1-alpha)+245*alpha).astype(np.uint8)
            writer.write(frame)
        writer.release()
        source = root / 'source.mp4'
        subprocess.run(['ffmpeg','-v','error','-y','-i',str(silent),'-f','lavfi','-i',
                        'sine=frequency=440:duration=5','-map','0:v','-map','1:a',
                        '-c:v','copy','-c:a','aac',str(source)],check=True,capture_output=True)
        return source

    def audio_hash(self, path):
        return subprocess.run(['ffmpeg','-v','error','-i',str(path),'-map','0:a:0',
                               '-c','copy','-f','hash','-'],check=True,capture_output=True).stdout

    def test_moving_fading_logo_audio_and_verified_reuse(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = self.fixture(root)
            original_hash = sha256(source)
            output = root / 'clean.mp4'
            receipt = repair_video(source, output, '1:1', 5)
            self.assertEqual(receipt['version'], 3)
            self.assertEqual(receipt['processing']['segments'], 2)
            self.assertEqual(receipt['processing']['frames'], 120)
            self.assertEqual(sha256(source), original_hash)
            self.assertEqual(self.audio_hash(source), self.audio_hash(output))
            capture = cv2.VideoCapture(str(output))
            # A clean uniform background has no surviving white glyphs.
            for n in [4, 24, 55, 65, 90, 116]:
                capture.set(cv2.CAP_PROP_POS_FRAMES, n)
                ok, frame = capture.read()
                self.assertTrue(ok)
                self.assertLess(np.percentile(frame, 99.99), 70)
            capture.release()
            with patch('dola_watermark_tracker.tracked_repair', side_effect=AssertionError('must reuse')):
                reused = repair_video(source, root / 'api.mp4', '1:1', 5, reuse=output)
                self.assertEqual(reused['sha256'], receipt['sha256'])
                self.assertEqual(repair_video(source, output, '1:1', 5)['sha256'], receipt['sha256'])

    def test_no_confirmed_logo_keeps_existing_output_and_creates_no_receipt(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = self.fixture(root, logo=False)
            output = root / 'clean.mp4'
            output.write_bytes(b'previous accepted result')
            with self.assertRaisesRegex(RuntimeError, 'WATERMARK_REPAIR_UNCONFIRMED'):
                repair_video(source, output, '1:1', 5)
            self.assertEqual(output.read_bytes(), b'previous accepted result')
            self.assertFalse(Path(str(output)+'.delivery.json').exists())
            self.assertFalse(list(root.glob('*.part.mp4')))

    def test_new_ratios_scaled_watermarks_and_auto_keep_full_frame_audio_and_duration(self):
        cases = [('3:4', (864, 1152), .9, (960, 1280)),
                 ('4:3', (1152, 864), 1.2, (1280, 960)),
                 ('21:9', (1470, 630), .65, (1260, 540)),
                 ('auto', (1080, 1440), 1.35, (1080, 1440))]
        for ratio, size, scale, expected in cases:
            with self.subTest(ratio=ratio), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                source = self.fixture(root, size=size, glyph_scale=scale)
                original_hash = sha256(source)
                output = root / 'delivered.mp4'
                receipt = repair_video(source, output, ratio, 5)
                media = receipt['media']
                self.assertEqual((media['width'], media['height']), expected)
                self.assertEqual(media['codec_name'], 'h264')
                self.assertAlmostEqual(media['duration'], 5, delta=.15)
                self.assertEqual(receipt['requested_ratio'], ratio)
                self.assertEqual(sha256(source), original_hash)
                self.assertEqual(self.audio_hash(source), self.audio_hash(output))
                capture = cv2.VideoCapture(str(output))
                for n in [4, 24, 55, 65, 90, 116]:
                    capture.set(cv2.CAP_PROP_POS_FRAMES, n)
                    ok, frame = capture.read()
                    self.assertTrue(ok)
                    self.assertLess(np.percentile(frame, 99.99), 70)
                capture.release()


if __name__ == '__main__':
    unittest.main()
