#!/usr/bin/env python3
"""Verify a release web archive and extract it without following archive paths."""

import argparse
import gzip
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import tarfile
import tempfile
from typing import BinaryIO


REQUIRED_PWA_FILES = {"index.html", "manifest.webmanifest", "sw.js", "icon.svg"}
MAX_MANIFEST_BYTES = 1024 * 1024
MAX_ARCHIVE_BYTES = 16 * 1024 * 1024
MAX_TAR_BYTES = 128 * 1024 * 1024
MAX_ARCHIVE_MEMBERS = 10_000
MAX_MEMBER_BYTES = 64 * 1024 * 1024
MAX_TOTAL_UNPACKED_BYTES = 128 * 1024 * 1024
FORBIDDEN_ARCHIVE_PARTS = (
    re.compile(r"^\.env(?:$|\.)", re.IGNORECASE),
    re.compile(r"^\.npmrc$", re.IGNORECASE),
    re.compile(r"^\.netrc$", re.IGNORECASE),
    re.compile(r"^credentials?(?:$|\.)", re.IGNORECASE),
    re.compile(r"^secrets?(?:$|\.)", re.IGNORECASE),
    re.compile(r"^id_(?:rsa|ed25519)(?:$|\.)", re.IGNORECASE),
    re.compile(r"\.(?:pem|key|p12|pfx|sqlite3?|db|log)$", re.IGNORECASE),
    re.compile(r"(?:^|[-_.])(?:local[-_.]?state|browser[-_.]?(?:profile|data)|indexeddb)(?:$|[-_.])", re.IGNORECASE),
)


def fail(message: str) -> None:
    raise ValueError(message)


def read_manifest(artifact_dir: Path) -> tuple[Path, dict]:
    manifest_path = artifact_dir / "SHA256SUMS.json"
    try:
        if manifest_path.stat().st_size > MAX_MANIFEST_BYTES:
            fail("Checksum manifest exceeds the maximum size.")
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        fail(f"Could not read SHA256SUMS.json: {error}")
    if not isinstance(manifest, dict):
        fail("Checksum manifest must be a JSON object.")
    artifacts = manifest.get("artifacts")
    if not isinstance(artifacts, list):
        fail("Checksum manifest has no artifact list.")
    web_entries = [
        item for item in artifacts
        if isinstance(item, dict)
        and isinstance(item.get("name"), str)
        and item["name"].endswith("-web.tar.gz")
    ]
    if len(web_entries) != 1:
        fail("Checksum manifest must identify exactly one web archive.")
    entry = web_entries[0]
    name = entry.get("name")
    expected = entry.get("sha256")
    if not isinstance(name, str) or Path(name).name != name or not name.endswith("-web.tar.gz"):
        fail("Web archive name in checksum manifest is invalid.")
    if not isinstance(expected, str) or len(expected) != 64 or any(char not in "0123456789abcdef" for char in expected):
        fail("Web archive checksum in manifest is invalid.")
    archive_path = artifact_dir / name
    expected_root = name[:-len(".tar.gz")]
    try:
        archive_size = archive_path.stat().st_size
        if archive_size > MAX_ARCHIVE_BYTES:
            fail("Web archive exceeds the maximum compressed size.")
        checksum = hashlib.sha256()
        with archive_path.open("rb") as source:
            for chunk in iter(lambda: source.read(1024 * 1024), b""):
                checksum.update(chunk)
        digest = checksum.hexdigest()
    except OSError as error:
        fail(f"Could not read web archive: {error}")
    if digest != expected:
        fail("Web archive SHA-256 does not match SHA256SUMS.json.")
    if not isinstance(entry.get("sizeBytes"), int) or isinstance(entry.get("sizeBytes"), bool) or entry["sizeBytes"] != archive_size:
        fail("Web archive size does not match SHA256SUMS.json.")
    return archive_path, manifest, expected_root


def safe_member_name(name: str) -> str:
    if not name or "\\" in name or name.startswith("/"):
        fail(f"Archive contains an unsafe path: {name!r}")
    raw_parts = name.rstrip("/").split("/")
    if any(part in ("", ".", "..") for part in raw_parts):
        fail(f"Archive contains an unsafe path: {name!r}")
    path = PurePosixPath(name)
    parts = path.parts
    if not parts:
        fail(f"Archive contains an unsafe path: {name!r}")
    if any(":" in part for part in parts):
        fail(f"Archive contains an unsafe path: {name!r}")
    return "/".join(parts).rstrip("/")


def forbidden_archive_path(name: str) -> bool:
    return any(pattern.search(part) for part in PurePosixPath(name).parts for pattern in FORBIDDEN_ARCHIVE_PARTS)


def inspect_archive(archive_path: Path, expected_root: str) -> tuple[tarfile.TarFile, BinaryIO, list[tuple[tarfile.TarInfo, str]], str]:
    tar_stream = tempfile.TemporaryFile()
    archive = None
    try:
        expanded_tar_size = 0
        with gzip.open(archive_path, "rb") as compressed:
            while chunk := compressed.read(1024 * 1024):
                expanded_tar_size += len(chunk)
                if expanded_tar_size > MAX_TAR_BYTES:
                    fail("Decompressed tar archive exceeds the maximum size.")
                tar_stream.write(chunk)
        tar_stream.seek(0)
        archive = tarfile.open(fileobj=tar_stream, mode="r:")
        members = []
        for member in archive:
            members.append(member)
            if len(members) > MAX_ARCHIVE_MEMBERS:
                fail("Web archive exceeds the maximum member count.")
    except (OSError, EOFError, ValueError, tarfile.TarError) as error:
        if archive is not None:
            archive.close()
        tar_stream.close()
        fail(f"Web archive is malformed: {error}")

    try:
        seen: set[str] = set()
        path_types: dict[str, str] = {}
        normalized: list[tuple[tarfile.TarInfo, str]] = []
        roots: set[str] = set()
        total_unpacked_bytes = 0
        for member in members:
            name = safe_member_name(member.name)
            if name in seen:
                fail(f"Web archive contains a duplicate path: {name}")
            seen.add(name)
            if not (member.isdir() or member.isfile()):
                fail(f"Web archive contains an unsupported filesystem object: {name}")
            if forbidden_archive_path(name):
                fail(f"Web archive contains a prohibited secret or local-state path: {name}")
            if member.isfile():
                if member.size < 0 or member.size > MAX_MEMBER_BYTES:
                    fail(f"Web archive member exceeds the maximum file size: {name}")
                total_unpacked_bytes += member.size
                if total_unpacked_bytes > MAX_TOTAL_UNPACKED_BYTES:
                    fail("Web archive exceeds the maximum unpacked size.")
            path_types[name] = "directory" if member.isdir() else "file"
            roots.add(name.split("/", 1)[0])
            normalized.append((member, name))

        for name in sorted(path_types):
            parts = name.split("/")
            for depth in range(1, len(parts)):
                ancestor = "/".join(parts[:depth])
                if path_types.get(ancestor) == "file":
                    fail(f"Web archive has a file/directory path collision: {ancestor} and {name}")

        if len(roots) != 1:
            fail("Web archive must contain a single package root directory.")
        package_root = next(iter(roots))
        if package_root != expected_root:
            fail("Web archive package root does not match its checksum manifest name.")
        if not any(name == package_root and member.isdir() for member, name in normalized):
            fail("Web archive is missing its package root directory.")
        relative_files = {
            name[len(package_root) + 1:]
            for member, name in normalized
            if member.isfile() and name.startswith(package_root + "/")
        }
        missing = sorted(REQUIRED_PWA_FILES - relative_files)
        if missing:
            fail(f"Web archive is missing required PWA files: {', '.join(missing)}")
        return archive, tar_stream, normalized, package_root
    except Exception:
        archive.close()
        tar_stream.close()
        raise


def verify_and_extract(artifact_dir: Path, destination: Path) -> Path:
    archive_path, _manifest, expected_root = read_manifest(artifact_dir)
    archive, tar_stream, members, package_root = inspect_archive(archive_path, expected_root)
    destination.mkdir(parents=True, exist_ok=True)
    if any(destination.iterdir()):
        archive.close()
        tar_stream.close()
        fail("Extraction destination must be empty.")

    package_dir = destination / package_root
    package_dir.mkdir()
    try:
        for member, name in members:
            if name == package_root:
                continue
            relative = name[len(package_root) + 1:]
            target = package_dir.joinpath(*PurePosixPath(relative).parts)
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            stream = archive.extractfile(member)
            if stream is None:
                fail(f"Could not read archive file: {name}")
            with stream, target.open("xb") as output:
                shutil.copyfileobj(stream, output)
            os.chmod(target, member.mode & 0o755)
    except Exception:
        shutil.rmtree(package_dir, ignore_errors=True)
        raise
    finally:
        archive.close()
        tar_stream.close()
    return package_dir


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("artifact_dir", type=Path)
    parser.add_argument("destination", type=Path)
    args = parser.parse_args()
    try:
        result = verify_and_extract(args.artifact_dir.resolve(), args.destination.resolve())
    except (OSError, ValueError, tarfile.TarError) as error:
        parser.exit(1, f"{error}\n")
    print(result)


if __name__ == "__main__":
    main()
