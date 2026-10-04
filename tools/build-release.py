"""Build a clean source release without local accounts, secrets, or runtime data."""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import tempfile
import zipfile


ROOT = Path(__file__).resolve().parents[1]
APP = "symphony-pool-workbench"
FILES = (
    "README.md", ".gitignore", ".gitattributes", ".dockerignore",
    f"{APP}/deploy/docker/Dockerfile", f"{APP}/deploy/docker/Caddyfile",
    *(f"{APP}/{name}" for name in (
        "README.md", "CHANGELOG.md", "PARTNER_API.md", "VIDEO_API.md",
        "NOCSNOW_API.md", "package.json", "requirements.txt", ".env.example",
        ".gitignore", "server.mjs", "start-workbench.ps1", "stop-workbench.ps1",
    )),
    *(f"tools/{name}" for name in (
        "build-release.py", "open-symphony-profile.ps1", "run-image-to-video.py",
        "verify-doubao-profile.py", "verify-symphony-profile.py",
        "test_verify_symphony_profile.py", "test_verification_launch.py",
        "browser_runtime.py", "open-browser-profile.py", "test_browser_runtime.py",
        "desktop_routes.py", "login_desktop.py", "test_desktop_routes.py", "test_login_desktop.py",
        "xpra_gateway.py", "test_xpra_gateway.py", "fixtures/xpra-input.html",
        "test_generation_launch.py", "test_verification_launch.py",
        "start-docker-test.ps1", "allow-docker-lan.ps1", "configure-xpra-client.ps1",
        "win-xpra-launcher.cs", "test-xpra-client.ps1",
    )),
)
DIRECTORIES = tuple(f"{APP}/{name}" for name in (
    "lib", "public", "views", "tests", "scripts", "docs", "deploy",
))
EXTENSIONS = {".mjs", ".js", ".css", ".html", ".svg", ".json", ".md", ".txt", ".sh", ".service", ".example", ".yml", ".ps1"}
BLOCKED_PARTS = {
    ".git", ".venv", ".env", ".migration-backups", "__pycache__",
    "node_modules", "data", "logs", "output", "backups", "release", ".runtime", ".docker-local",
}


def checked(path: Path) -> Path:
    """Reject links and escapes before reading a source path or writing output."""
    relative = path.relative_to(ROOT)
    current = ROOT
    for part in relative.parts:
        current /= part
        if current.is_symlink() or current.is_junction():
            raise ValueError(f"Links cannot be packaged: {relative.as_posix()}")
    if not path.resolve().is_relative_to(ROOT):
        raise ValueError(f"Path escapes project: {relative.as_posix()}")
    return path


def allowed(relative: Path) -> bool:
    return not any(
        part.lower() in BLOCKED_PARTS
        or part.lower().endswith("_sandbox_data")
        or (part.lower().startswith(".env") and part != ".env.example")
        for part in relative.parts
    )


def collect() -> dict[str, bytes]:
    paths = {checked(ROOT / name) for name in FILES}
    for name in DIRECTORIES:
        base = checked(ROOT / name)
        if not base.is_dir():
            raise FileNotFoundError(f"Required source directory missing: {name}")
        for directory, children, files in os.walk(base, followlinks=False):
            parent = checked(Path(directory))
            for child in children:
                checked(parent / child)
            children[:] = [child for child in children if allowed((parent / child).relative_to(ROOT))]
            for filename in files:
                path = checked(parent / filename)
                if allowed(path.relative_to(ROOT)) and path.suffix.lower() in EXTENSIONS:
                    paths.add(path)
    payload = {}
    for path in sorted(paths):
        relative = path.relative_to(ROOT)
        if not allowed(relative) or not path.is_file():
            raise ValueError(f"Invalid release file: {relative.as_posix()}")
        data = path.read_bytes()
        if path.suffix in {".sh", ".service"}:
            data = data.replace(b"\r\n", b"\n")
        payload[relative.as_posix()] = data
    template = payload[f"{APP}/.env.example"].decode("utf-8-sig")
    assignments = dict(
        line.strip().split("=", 1) for line in template.splitlines()
        if line.strip() and not line.lstrip().startswith("#") and "=" in line
    )
    for secret in ("PARTNER_API_KEY", "PARTNER_DOWNLOAD_SECRET", "PARTNER_WEBHOOK_SECRET"):
        if secret not in assignments or assignments[secret].strip().strip("\"'"):
            raise ValueError(f"Release template must leave {secret} empty")
    return payload


def build() -> None:
    payload = collect()
    version = json.loads(payload[f"{APP}/package.json"])["version"]
    if not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?", version):
        raise ValueError("Invalid package version")
    name = f"SymphonyPoolWorkbench-v{version}"
    manifest = "".join(
        f"{hashlib.sha256(data).hexdigest()}  {path}\n"
        for path, data in sorted(payload.items())
    )
    payload["SHA256SUMS.txt"] = manifest.encode("utf-8")
    output = checked(ROOT / "release")
    output.mkdir(exist_ok=True)
    archive = checked(output / f"{name}.zip")
    checksum = checked(output / f"{name}.zip.sha256")
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(prefix="release-", suffix=".tmp", dir=output, delete=False) as handle:
            temporary = Path(handle.name)
        with zipfile.ZipFile(temporary, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as package:
            for relative, data in sorted(payload.items()):
                info = zipfile.ZipInfo(f"{name}/{relative}", date_time=(2026, 1, 1, 0, 0, 0))
                info.compress_type = zipfile.ZIP_DEFLATED
                info.create_system = 3
                info.external_attr = (0o100755 if relative.endswith(".sh") else 0o100644) << 16
                package.writestr(info, data)
        temporary.replace(archive)
        digest = hashlib.sha256(archive.read_bytes()).hexdigest()
        checksum.write_text(f"{digest}  {archive.name}\n", encoding="utf-8", newline="\n")
    finally:
        if temporary is not None and temporary.exists():
            temporary.unlink()
    print(json.dumps({
        "archive": str(archive), "checksum": str(checksum),
        "files": len(payload), "size_bytes": archive.stat().st_size,
        "sha256": digest,
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    build()
