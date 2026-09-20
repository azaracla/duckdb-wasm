"""Unit tests for the trace *instrument*, not DuckDB async-I/O acceptance."""
import concurrent.futures
import json
import threading
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from range_trace_server import make_server


class RangeTraceServerTests(unittest.TestCase):
    def setUp(self):
        self.server = make_server(b'0123456789', delay_ms=120)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = f'http://127.0.0.1:{self.server.server_port}'

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)

    def request(self, path='/fixture.parquet', method='GET', range_header=None):
        headers = {'Range': range_header} if range_header else {}
        req = Request(self.base + path, headers=headers, method=method)
        try:
            with urlopen(req, timeout=5) as response:
                return response.status, response.headers, response.read()
        except HTTPError as error:
            return error.code, error.headers, error.read()

    def test_range_and_cors_semantics(self):
        status, headers, body = self.request(range_header='bytes=2-5')
        self.assertEqual((status, body), (206, b'2345'))
        self.assertEqual(headers['Content-Range'], 'bytes 2-5/10')
        self.assertEqual(headers['Accept-Ranges'], 'bytes')
        self.assertEqual(headers['Access-Control-Allow-Origin'], '*')
        self.assertIn('Content-Range', headers['Access-Control-Expose-Headers'])
        self.assertEqual(self.request(range_header='bytes=-3')[2], b'789')
        self.assertEqual(self.request(range_header='bytes=7-')[2], b'789')
        status, headers, body = self.request(range_header='bytes=20-30')
        self.assertEqual((status, body), (416, b''))
        self.assertEqual(headers['Content-Range'], 'bytes */10')
        self.assertEqual(self.request(method='HEAD', range_header='bytes=0-1')[0], 206)
        self.assertEqual(self.request(method='OPTIONS')[0], 204)
        trace = json.loads(self.request('/__trace')[2])
        self.assertEqual(len(trace['events']), 5)
        self.assertEqual(trace['completed_range_gets'], 4)

    def test_concurrent_ranges_have_real_overlapping_intervals(self):
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
            futures = [executor.submit(self.request, range_header=f'bytes={i}-{i + 1}')
                       for i in (0, 2)]
            results = [future.result(timeout=5) for future in futures]
        self.assertEqual([result[0] for result in results], [206, 206])
        trace = json.loads(self.request('/__trace')[2])
        self.assertEqual(trace['completed_range_gets'], 2)
        self.assertGreaterEqual(trace['max_overlapping_ranges'], 2)
        self.assertTrue(all(event['end_ns'] > event['start_ns'] for event in trace['events']))
        self.assertEqual(self.request('/__reset')[0], 200)
        self.assertEqual(json.loads(self.request('/__trace')[2])['events'], [])


if __name__ == '__main__':
    unittest.main()
