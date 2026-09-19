"""Offline tests for the narrowly scoped pinned DuckDB alpha fix."""

import importlib.util
from pathlib import Path
import unittest

SPEC = importlib.util.spec_from_file_location("patch_core_alpha", Path(__file__).with_name("patch_core_alpha.py"))
PATCH = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PATCH)


class CorePatchTests(unittest.TestCase):
    def test_original_patches_once(self):
        source = "before\n" + PATCH.OLD + "\nafter\n"
        updated, changed = PATCH.stage(source)
        self.assertTrue(changed)
        self.assertEqual(updated, "before\n" + PATCH.NEW + "\nafter\n")
        self.assertEqual(PATCH.stage(updated), (updated, False))

    def test_missing_marker_fails_closed(self):
        with self.assertRaises(ValueError):
            PATCH.stage("unrelated source")

    def test_duplicate_marker_fails_closed(self):
        with self.assertRaises(ValueError):
            PATCH.stage(PATCH.OLD + PATCH.OLD)

    def test_mixed_marker_fails_closed(self):
        with self.assertRaises(ValueError):
            PATCH.stage(PATCH.OLD + PATCH.NEW)


if __name__ == "__main__":
    unittest.main()
