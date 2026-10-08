import hashlib
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from video_compat import prepare_browser_video, video_info


@unittest.skipUnless(shutil.which('ffmpeg') and shutil.which('ffprobe'), 'FFmpeg is installed in the cloud image')
class VideoCompatibilityTests(unittest.TestCase):
    def test_hevc_gets_a_browser_video_and_keeps_original_bytes(self):
        with tempfile.TemporaryDirectory() as folder:
            original, output = Path(folder)/'original.mp4', Path(folder)/'playable.mp4'
            subprocess.run(['ffmpeg','-nostdin','-loglevel','error','-f','lavfi','-i','color=c=orange:s=64x96:r=10',
                '-t','0.3','-c:v','libx265','-x265-params','pools=1:frame-threads=1','-pix_fmt','yuv420p',str(original)],
                check=True,capture_output=True,timeout=30)
            digest=hashlib.sha256(original.read_bytes()).hexdigest()
            self.assertEqual(video_info(original)['codec_name'],'hevc')
            prepare_browser_video(original,output)
            self.assertEqual(hashlib.sha256(original.read_bytes()).hexdigest(),digest)
            info=video_info(output)
            self.assertEqual((info['codec_name'],info['pix_fmt'],info['width'],info['height']),('h264','yuv420p',64,96))
            prepare_browser_video(original,output,'9:16',0.3)
            info=video_info(output)
            self.assertEqual((info['width'],info['height']),(720,1280))
            with self.assertRaisesRegex(RuntimeError,'VIDEO_DURATION_MISMATCH'):
                prepare_browser_video(original,Path(folder)/'wrong.mp4','16:9',10)
            self.assertEqual(hashlib.sha256(original.read_bytes()).hexdigest(),digest)

    def test_audio_only_mp4_is_never_reported_as_a_video(self):
        with tempfile.TemporaryDirectory() as folder:
            original,output=Path(folder)/'audio.mp4',Path(folder)/'result.mp4'
            subprocess.run(['ffmpeg','-nostdin','-loglevel','error','-f','lavfi','-i','anullsrc','-t','0.1','-c:a','aac',str(original)],
                check=True,capture_output=True,timeout=30)
            with self.assertRaisesRegex(RuntimeError,'VIDEO_FILE_INVALID'):
                prepare_browser_video(original,output)
            self.assertFalse(output.exists())


if __name__=='__main__':unittest.main()
