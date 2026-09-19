"""Offline regression tests; no Emscripten or network required."""
import importlib.util
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).with_name("port_api.py")
spec = importlib.util.spec_from_file_location("port_api", SCRIPT)
port = importlib.util.module_from_spec(spec)
spec.loader.exec_module(port)


class PortTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        for relative, pairs in port.CHANGES.items():
            path = self.root / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("\n".join(old for old, _ in pairs), encoding="utf-8")

    def test_apply_and_idempotence(self):
        staged, before = port.stage(self.root)
        self.assertEqual(sum(s.startswith("PENDING") for s in before), 4)
        for path, text in staged.items():
            path.write_text(text, encoding="utf-8")
        staged2, after = port.stage(self.root)
        self.assertTrue(all(s.startswith("APPLIED") for s in after))
        self.assertTrue(all(path.read_text() == text for path, text in staged2.items()))

    def test_fail_closed_on_missing_or_ambiguous_marker(self):
        path = self.root / "lib/src/http_wasm.cc"
        path.write_text("unrelated code", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "nothing written"):
            port.stage(self.root)
        other = self.root / "lib/src/json_typedef.cc"
        self.assertIn("AGGREGATE_STATE", other.read_text())

    def test_http_options_does_not_return_null(self):
        new = port.CHANGES["lib/src/http_wasm.cc"][0][1]
        self.assertIn("NotImplemented_501", new)
        self.assertIn("response->success = false", new)
        self.assertNotIn("return nullptr", new)

    def test_guard_against_double_replacement(self):
        path = self.root / "lib/src/json_typedef.cc"
        old, new = port.CHANGES["lib/src/json_typedef.cc"][0]
        path.write_text(path.read_text() + "\n" + new, encoding="utf-8")
        with self.assertRaises(ValueError):
            port.stage(self.root)


if __name__ == "__main__":
    unittest.main()
