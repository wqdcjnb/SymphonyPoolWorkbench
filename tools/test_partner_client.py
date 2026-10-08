import importlib.util
from pathlib import Path
import unittest
import urllib.error

source = Path(__file__).resolve().parents[1] / 'symphony-pool-workbench/docs/examples/partner-client.py'
spec = importlib.util.spec_from_file_location('partner_client', source)
client = importlib.util.module_from_spec(spec)
spec.loader.exec_module(client)
TASK = 'task-550e8400-e29b-41d4-a716-446655440000'


class LongWait(unittest.TestCase):
    def fixture(self):
        self.now = 0
        self.sleeps = []
        def sleep(seconds):
            self.sleeps.append(seconds)
            self.now += seconds
        return client.Client(key='test-only', clock=lambda: self.now, sleep=sleep, random_value=lambda: 0)

    def test_watch_beyond_20_minutes_retries_and_reconciliation(self):
        c = self.fixture()
        seen = []
        calls = 0
        def request(path):
            nonlocal calls
            calls += 1
            if calls == 1:
                raise client.ApiError(429, 'RATE_LIMITED', 125)
            if calls == 2:
                raise TimeoutError('temporary query timeout')
            return {'task_id': TASK, 'status': 'succeeded' if self.now > 36 * 60 else 'reconciling', 'results': []}
        c.request = request
        result = c.wait(TASK, on_progress=seen.append)
        self.assertEqual(result['status'], 'succeeded')
        self.assertTrue(result['terminal'])
        self.assertGreater(self.now, 36 * 60)
        self.assertEqual(self.sleeps[0], 125)
        self.assertTrue(any(item['status'] == 'reconciling' for item in seen))
        self.assertTrue(all(seconds >= 60 for seconds in self.sleeps))

    def test_local_timeout_returns_pending_and_preserves_task(self):
        c = self.fixture()
        c.request = lambda path: {'task_id': TASK, 'status': 'running', 'results': []}
        result = c.wait(TASK, timeout=120, on_progress=lambda task: None)
        self.assertTrue(result['wait_expired'])
        self.assertFalse(result['terminal'])
        self.assertEqual(result['task_id'], TASK)
        self.assertEqual(result['status'], 'running')

    def test_lost_submit_response_reuses_business_id(self):
        c = self.fixture()
        requests = []
        def submit(task, images):
            requests.append(dict(task))
            if len(requests) == 1:
                raise urllib.error.URLError('response lost after commit')
            return {'task_id': TASK, 'status': 'queued'}
        c._submit_once = submit
        c.submit({'client_task_id': 'same-id', 'prompt': 'test'})
        self.assertEqual(requests[0], requests[1])
        self.assertEqual(len(requests), 2)

    def test_authentication_errors_are_not_retried_forever(self):
        c = self.fixture()
        def request(path):
            raise client.ApiError(401, 'INVALID_API_KEY')
        c.request = request
        with self.assertRaises(client.ApiError):
            c.wait(TASK)
        self.assertEqual(self.sleeps, [])


if __name__ == '__main__':
    unittest.main()
