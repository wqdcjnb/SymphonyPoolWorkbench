"""Fail packaging early when a previously delivered feature is missing.

This structural check complements the quota, progress, browser adapter and
delivery tests. It does not replace them or authorize a live deployment.
"""
import argparse
import json
from pathlib import Path

REQUIRED = {
    'daily_free_videos': {
        'symphony-pool-workbench/public/js/video-policy.js': ['DAILY_FREE_VIDEOS = 2'],
        'symphony-pool-workbench/lib/daily-credits.mjs': ['freeVideosRemaining:', 'freeVideosReserved:'],
        'symphony-pool-workbench/lib/db.mjs': ['recordExternalVideoGeneration', 'account_external_videos'],
        'symphony-pool-workbench/tests/free-video-limit.test.mjs': [],
    },
    'partner_progress': {
        'symphony-pool-workbench/lib/partner-store.mjs': ['video.task.progress'],
        'symphony-pool-workbench/lib/partner-api.mjs': ['partnerTaskProgress'],
        'symphony-pool-workbench/tests/partner-api.test.mjs': [],
    },
    'generation_estimate': {
        'symphony-pool-workbench/lib/generation-estimate.mjs': ['generationEstimate'],
        'symphony-pool-workbench/lib/partner-api.mjs': ['generation_estimate'],
        'symphony-pool-workbench/tests/generation-estimate.test.mjs': [],
    },
    'doubao_chat_submission': {
        'tools/doubao_chat.py': [],
        'tools/test_doubao_chat.py': [],
        'tools/run-image-to-video.py': ['doubao_chat'],
        'tools/joint_submission.py': [],
    },
    'doubao_original_collection': {
        'tools/doubao_export.py': ['def conversation_original(', 'unwatermarked'],
        'tools/test_doubao_export.py': [],
    },
    'accepted_generation_waiting': {
        'symphony-pool-workbench/lib/long-task.mjs': [],
        'symphony-pool-workbench/tests/long-task.test.mjs': [],
        'tools/test_dola_video.py': [],
    },
}


def validate_payload(payload):
    errors = []
    for feature, files in REQUIRED.items():
        for name, markers in files.items():
            data = payload.get(name)
            if data is None:
                errors.append({'feature': feature, 'file': name, 'reason': 'missing_file'})
                continue
            text = data.decode('utf-8-sig') if isinstance(data, bytes) else data
            if any(marker not in text for marker in markers):
                errors.append({'feature': feature, 'file': name, 'reason': 'missing_feature_marker'})
    if errors:
        raise ValueError('RELEASE_FEATURES_MISSING: ' + json.dumps(errors, ensure_ascii=False))
    return list(REQUIRED)


def validate_tree(root):
    names = {name for files in REQUIRED.values() for name in files}
    return validate_payload({name: (root / name).read_bytes() for name in names if (root / name).is_file()})


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('root', type=Path, help='source release root to check')
    args = parser.parse_args()
    try:
        print(json.dumps({'ok': True, 'features': validate_tree(args.root.resolve())}))
    except ValueError as error:
        print(str(error))
        raise SystemExit(1)
