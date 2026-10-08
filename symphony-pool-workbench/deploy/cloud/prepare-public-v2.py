"""Create private gateway credentials once; never print passwords or hashes."""
import argparse
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import secrets
import subprocess


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--ip", required=True)
    args = parser.parse_args()
    address = ipaddress.ip_address(args.ip)
    if address.version != 4 or not address.is_global:
        parser.error("A public IPv4 address is required")
    if os.geteuid() != 0:
        parser.error("Run with sudo")
    os.umask(0o077)
    root = Path("/data/symphony/v2/public-gateway")
    root.mkdir(mode=0o700, exist_ok=True)
    for name in ("caddy-data", "caddy-config"):
        (root / name).mkdir(mode=0o700, exist_ok=True)
    access_path = root / "admin-access.json"
    if access_path.exists():
        access = json.loads(access_path.read_text())
        if access["url"] != f"https://{address}/pool":
            raise SystemExit("Existing credentials belong to another address")
    else:
        access = {"url": f"https://{address}/pool", "username": "admin", "password": secrets.token_urlsafe(24)}
        with access_path.open("x", encoding="utf-8") as stream:
            json.dump(access, stream, indent=2)
            stream.write("\n")
    auth_path = root / "admin-auth.caddy"
    if not auth_path.exists():
        result = subprocess.run(
            ["docker", "run", "--rm", "-i", "caddy:2.11.4-alpine", "caddy", "hash-password"],
            input=access["password"] + "\n", text=True, capture_output=True, check=True,
        )
        password_hash = result.stdout.strip()
        if not password_hash.startswith("$2") or len(password_hash) != 60:
            raise SystemExit("Unexpected password hash format")
        with auth_path.open("x", encoding="utf-8") as stream:
            stream.write('basic_auth bcrypt "Symphony Workbench" {\n')
            stream.write(f'    {access["username"]} {password_hash}\n')
            stream.write("}\n")
    env_path = Path("/data/symphony/public-v2.env")
    if not env_path.exists():
        with env_path.open("x", encoding="utf-8") as stream:
            stream.write(f"WORKBENCH_PUBLIC_IP={address}\nWORKBENCH_ADMIN_PORT=8790\nWORKBENCH_XPRA_PORT=6084\n")
    for path in (access_path, auth_path, env_path):
        path.chmod(0o600)
    auth_root = Path('/data/symphony/v2/public-auth')
    auth_root.mkdir(mode=0o700, exist_ok=True)
    session_dir = auth_root / 'data'
    session_dir.mkdir(mode=0o700, exist_ok=True)
    credential_path = auth_root / 'admin-credential.json'
    if not credential_path.exists():
        salt = secrets.token_hex(24)
        verifier = hashlib.scrypt(access['password'].encode(), salt=salt.encode(), n=32768,
                                  r=8, p=1, dklen=64, maxmem=64*1024*1024).hex()
        with credential_path.open('x', encoding='utf-8') as stream:
            json.dump({'version':1, 'username':access['username'], 'salt':salt, 'verifier':verifier}, stream)
            stream.write('\n')
    for path in (auth_root, session_dir, credential_path):
        os.chown(path, 10001, 10001)
    credential_path.chmod(0o600)
    print("Gateway credentials ready; private files retained on the server.")


if __name__ == "__main__":
    main()
