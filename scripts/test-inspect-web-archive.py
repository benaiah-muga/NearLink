import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch


MODULE_PATH = Path(__file__).with_name("inspect-web-archive.py")
SPEC = importlib.util.spec_from_file_location("inspect_web_archive", MODULE_PATH)
module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(module)


class WebArchiveInspectionTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="nearlink-archive-test-")
        self.root = Path(self.temporary.name)
        self.artifacts = self.root / "artifacts"
        self.artifacts.mkdir()
        self.destination = self.root / "extracted"
        self.archive_path = self.artifacts / "nearlink-1.2.3-web.tar.gz"

    def tearDown(self):
        self.temporary.cleanup()

    def create_archive(self, entries):
        with tarfile.open(self.archive_path, "w:gz") as archive:
            for name, content, kind in entries:
                info = tarfile.TarInfo(name)
                if kind == "dir":
                    info.type = tarfile.DIRTYPE
                    info.size = 0
                    archive.addfile(info)
                elif kind == "symlink":
                    info.type = tarfile.SYMTYPE
                    info.linkname = "index.html"
                    archive.addfile(info)
                elif kind == "hardlink":
                    info.type = tarfile.LNKTYPE
                    info.linkname = "index.html"
                    archive.addfile(info)
                else:
                    payload = content.encode()
                    info.size = len(payload)
                    archive.addfile(info, io.BytesIO(payload))
        digest = hashlib.sha256(self.archive_path.read_bytes()).hexdigest()
        manifest = {
            "artifacts": [{"name": self.archive_path.name, "sizeBytes": self.archive_path.stat().st_size, "sha256": digest}]
        }
        (self.artifacts / "SHA256SUMS.json").write_text(json.dumps(manifest), encoding="utf-8")

    def valid_entries(self):
        return [("nearlink-1.2.3-web/", "", "dir")] + [
            (f"nearlink-1.2.3-web/{name}", "ok", "file")
            for name in ("index.html", "manifest.webmanifest", "sw.js", "icon.svg", "assets/app.js")
        ]

    def test_checksum_checked_archive_extracts_under_package_root(self):
        self.create_archive(self.valid_entries())
        package = module.verify_and_extract(self.artifacts, self.destination)
        self.assertEqual(package, self.destination / "nearlink-1.2.3-web")
        self.assertEqual((package / "index.html").read_text(), "ok")

    def test_rejects_checksum_mismatch(self):
        self.create_archive(self.valid_entries())
        self.archive_path.write_bytes(self.archive_path.read_bytes() + b"tamper")
        with self.assertRaisesRegex(ValueError, "SHA-256"):
            module.verify_and_extract(self.artifacts, self.destination)

    def test_rejects_malformed_gzip_tar(self):
        self.archive_path.write_bytes(b"not a gzip tar archive")
        digest = hashlib.sha256(self.archive_path.read_bytes()).hexdigest()
        manifest = {
            "artifacts": [{"name": self.archive_path.name, "sizeBytes": self.archive_path.stat().st_size, "sha256": digest}]
        }
        (self.artifacts / "SHA256SUMS.json").write_text(json.dumps(manifest), encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "malformed"):
            module.verify_and_extract(self.artifacts, self.destination)

    def test_rejects_traversal_and_absolute_paths(self):
        for unsafe in ("nearlink-1.2.3-web/../outside", "../outside", "/tmp/outside", "nearlink-1.2.3-web/C:/outside"):
            with self.subTest(path=unsafe):
                self.create_archive(self.valid_entries() + [(unsafe, "bad", "file")])
                with self.assertRaisesRegex(ValueError, "unsafe path"):
                    module.verify_and_extract(self.artifacts, self.destination)

    def test_rejects_duplicate_paths(self):
        entries = self.valid_entries() + [("nearlink-1.2.3-web/index.html", "duplicate", "file")]
        self.create_archive(entries)
        with self.assertRaisesRegex(ValueError, "duplicate path"):
            module.verify_and_extract(self.artifacts, self.destination)

    def test_rejects_file_directory_collisions_and_local_state_paths(self):
        collision = self.valid_entries() + [("nearlink-1.2.3-web/assets", "file", "file"), ("nearlink-1.2.3-web/assets/app/", "", "dir")]
        self.create_archive(collision)
        with self.assertRaisesRegex(ValueError, "path collision"):
            module.verify_and_extract(self.artifacts, self.destination)

        for unsafe in ("nearlink-1.2.3-web/.env", "nearlink-1.2.3-web/profile/IndexedDB/state.db"):
            with self.subTest(path=unsafe):
                self.create_archive(self.valid_entries() + [(unsafe, "secret", "file")])
                with self.assertRaisesRegex(ValueError, "prohibited secret or local-state"):
                    module.verify_and_extract(self.artifacts, self.destination)

    def test_rejects_links_and_missing_pwa_files(self):
        for kind in ("symlink", "hardlink"):
            with self.subTest(kind=kind):
                self.create_archive(self.valid_entries() + [(f"nearlink-1.2.3-web/{kind}", "", kind)])
                with self.assertRaisesRegex(ValueError, "unsupported filesystem object"):
                    module.verify_and_extract(self.artifacts, self.destination)
        entries = [(name, text, kind) for name, text, kind in self.valid_entries() if not name.endswith("/sw.js")]
        self.create_archive(entries)
        with self.assertRaisesRegex(ValueError, "missing required PWA files"):
            module.verify_and_extract(self.artifacts, self.destination)

    def test_enforces_compressed_member_and_expanded_size_limits(self):
        self.create_archive(self.valid_entries())
        with patch.object(module, "MAX_ARCHIVE_BYTES", 1):
            with self.assertRaisesRegex(ValueError, "compressed size"):
                module.verify_and_extract(self.artifacts, self.destination)

        with patch.object(module, "MAX_ARCHIVE_MEMBERS", 2):
            with self.assertRaisesRegex(ValueError, "member count"):
                module.verify_and_extract(self.artifacts, self.destination)

        with patch.object(module, "MAX_MEMBER_BYTES", 1):
            with self.assertRaisesRegex(ValueError, "maximum file size"):
                module.verify_and_extract(self.artifacts, self.destination)

        with patch.object(module, "MAX_TOTAL_UNPACKED_BYTES", 1):
            with self.assertRaisesRegex(ValueError, "maximum unpacked size"):
                module.verify_and_extract(self.artifacts, self.destination)

    def test_bounds_decompression_before_parsing_large_pax_metadata(self):
        with tarfile.open(self.archive_path, "w:gz", format=tarfile.PAX_FORMAT) as archive:
            root = tarfile.TarInfo("nearlink-1.2.3-web/")
            root.type = tarfile.DIRTYPE
            archive.addfile(root)
            for name in ("index.html", "manifest.webmanifest", "sw.js", "icon.svg"):
                info = tarfile.TarInfo(f"nearlink-1.2.3-web/{name}")
                info.size = 1
                if name == "index.html":
                    info.pax_headers = {"comment": "x" * 4096}
                archive.addfile(info, io.BytesIO(b"x"))
        digest = hashlib.sha256(self.archive_path.read_bytes()).hexdigest()
        manifest = {
            "artifacts": [{"name": self.archive_path.name, "sizeBytes": self.archive_path.stat().st_size, "sha256": digest}]
        }
        (self.artifacts / "SHA256SUMS.json").write_text(json.dumps(manifest), encoding="utf-8")
        with patch.object(module, "MAX_TAR_BYTES", 1024):
            with self.assertRaisesRegex(ValueError, "Decompressed tar archive exceeds"):
                module.verify_and_extract(self.artifacts, self.destination)


if __name__ == "__main__":
    unittest.main()
