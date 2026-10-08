import tempfile
from pathlib import Path
import unittest
from unittest.mock import patch

from watermark_repair import repair_video
from video_ratios import delivery_dimensions


class RepairGuards(unittest.TestCase):
    def test_original_cannot_be_overwritten(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'original.mp4'
            source.write_bytes(b'original source bytes')
            with self.assertRaisesRegex(RuntimeError, 'INVALID_INPUT'):
                repair_video(source, source, '1:1', 5)
            self.assertEqual(source.read_bytes(), b'original source bytes')

    def test_oversized_layout_fails_before_encoding(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'original.mp4'
            source.write_bytes(b'original source bytes')
            target = Path(directory) / 'output.mp4'
            with patch('watermark_repair.video_info', return_value={'width':5000,'height':5000,'duration':5}), patch('watermark_repair.sha256') as digest:
                with self.assertRaisesRegex(RuntimeError, 'UNSUPPORTED_LAYOUT'):
                    repair_video(source, target, '9:16', 5)
                digest.assert_not_called()
            self.assertFalse(target.exists())
            self.assertFalse(Path(str(target)+'.delivery.json').exists())

    def test_exact_even_canvases_and_auto_without_cropping(self):
        for ratio, expected in [('9:16',(720,1280)),('16:9',(1280,720)),('1:1',(960,960)),
                                ('3:4',(960,1280)),('4:3',(1280,960)),('21:9',(1260,540)),('auto',(1920,1080))]:
            self.assertEqual(delivery_dimensions(ratio,1920,1080),expected)
        self.assertEqual(delivery_dimensions('auto',1919,1079),(1920,1080))
        with self.assertRaisesRegex(RuntimeError, 'UNSUPPORTED_LAYOUT'):
            delivery_dimensions('auto',3000,3000)


if __name__ == '__main__':
    unittest.main()
