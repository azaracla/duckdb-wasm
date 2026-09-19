"""Fast offline guards for the pinned WebDB 2 alpha migration."""
import importlib.util
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).with_name("port_webdb_alpha.py")
spec = importlib.util.spec_from_file_location("port_webdb_alpha", SCRIPT)
port = importlib.util.module_from_spec(spec)
spec.loader.exec_module(port)


class WebDBAlphaPortTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.file = self.root / port.PATH
        self.file.parent.mkdir(parents=True, exist_ok=True)
        # All old fragments must appear exactly once, including the multi-line
        # UDF registration and storage blocks; no fork checkout is needed.
        self.file.write_text("\n// boundary\n".join(old for old, _ in port.CHANGES), encoding="utf-8")

    def test_apply_and_check_are_idempotent(self):
        target, staged, statuses = port.stage(self.root)
        self.assertEqual(len(statuses), len(port.CHANGES))
        self.assertTrue(all(s.startswith("PENDING") for s in statuses))
        target.write_text(staged, encoding="utf-8")
        target, second, statuses = port.stage(self.root)
        self.assertTrue(all(s.startswith("APPLIED") for s in statuses))
        self.assertEqual(second, target.read_text(encoding="utf-8"))

    def test_missing_fragment_fails_closed(self):
        initial = self.file.read_text(encoding="utf-8")
        self.file.write_text(initial.replace(port.CHANGES[0][0], "different includes"), encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "no changes written"):
            port.stage(self.root)
        self.assertIn("different includes", self.file.read_text())

    def test_duplicate_fragment_fails_closed(self):
        old, _ = port.CHANGES[3]
        self.file.write_text(self.file.read_text() + "\n" + old, encoding="utf-8")
        with self.assertRaises(ValueError):
            port.stage(self.root)

    def test_critical_compatibility_is_preserved(self):
        text = "\n".join(new for _, new in port.CHANGES)
        self.assertIn("GetResultType()", text)
        self.assertIn("GetIdentifierName()", text)
        self.assertIn("RunFunctionInTransaction", text)
        self.assertIn("SetFallible()", text)
        self.assertIn("FlatVector::GetDataMutable(out)", text)
        self.assertIn("free(res_buf)", text)
        self.assertIn("Identifier::DefaultSchema()", text)
        self.assertIn("throw InvalidInputException", text)
        self.assertNotIn("maximum_threads = 1", text)


if __name__ == "__main__":
    unittest.main()
