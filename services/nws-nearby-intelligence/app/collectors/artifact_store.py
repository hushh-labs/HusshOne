from __future__ import annotations

import hashlib
import json
from dataclasses import asdict
from pathlib import Path

from app.collectors.contracts import ArtifactManifest


class LocalContentAddressedStore:
    """Local development implementation of the immutable raw artifact zone."""

    def __init__(self, root: str | Path) -> None:
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)

    @staticmethod
    def digest(content: bytes) -> str:
        return hashlib.sha256(content).hexdigest()

    def put(self, *, source_id: str, content: bytes, manifest: ArtifactManifest) -> Path:
        digest = self.digest(content)
        if digest != manifest.sha256:
            raise ValueError("manifest digest does not match content")
        artifact_dir = self.root / source_id / digest[:2] / digest
        artifact_dir.mkdir(parents=True, exist_ok=True)
        artifact_path = artifact_dir / "artifact.bin"
        manifest_path = artifact_dir / "manifest.json"
        if artifact_path.exists() and artifact_path.read_bytes() != content:
            raise RuntimeError("content-addressed artifact collision")
        artifact_path.write_bytes(content)
        manifest_path.write_text(
            json.dumps(asdict(manifest), default=str, sort_keys=True, indent=2),
            encoding="utf-8",
        )
        return artifact_path
