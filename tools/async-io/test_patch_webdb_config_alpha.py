"""Offline regression checks for DuckDB 2 alpha's DBConfig API migration."""

import importlib.util
from pathlib import Path
import unittest

SPEC = importlib.util.spec_from_file_location(
    "patch_webdb_config_alpha", Path(__file__).with_name("patch_webdb_config_alpha.py")
)
PATCH = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PATCH)


class WebDBConfigPortTests(unittest.TestCase):
    def setUp(self):
        self.source = "\n// unrelated source\n".join(old for old, _ in PATCH.CHANGES)

    def test_apply_once_and_idempotent(self):
        updated, pending = PATCH.stage(self.source)
        self.assertEqual(pending, 2)
        self.assertEqual(PATCH.stage(updated), (updated, 0))

    def test_missing_marker_fails_closed(self):
        with self.assertRaisesRegex(ValueError, "nothing written"):
            PATCH.stage(self.source.replace(PATCH.CHANGES[0][0], "unrelated code"))

    def test_duplicate_and_mixed_markers_fail_closed(self):
        for text in (self.source + PATCH.CHANGES[0][0], self.source + PATCH.CHANGES[1][1]):
            with self.subTest(text=text[-60:]):
                with self.assertRaises(ValueError):
                    PATCH.stage(text)

    def test_preserves_browser_http_provider_and_direct_io_contract(self):
        new = "\n".join(replacement for _, replacement in PATCH.CHANGES)
        self.assertIn("config.GetHTTPUtil().GetName()", new)
        self.assertIn("config.SetHTTPUtil(make_shared_ptr<HTTPWasmUtil>())", new)
        self.assertIn("if (config_->use_direct_io)", new)
        self.assertIn("throw InvalidInputException", new)
        self.assertNotIn("maximum_threads = 1", new)
        self.assertNotIn("allow_unsigned_extensions = true", new)


if __name__ == "__main__":
    unittest.main()
