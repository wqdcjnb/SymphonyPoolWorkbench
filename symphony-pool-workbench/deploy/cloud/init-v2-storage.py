"""Run once with sudo on the existing server. Never format disks or reuse V1 data."""
import os
from pathlib import Path
import secrets

root = Path('/data/symphony/v2')
for name in ('data', 'profiles', 'secrets', 'backups'):
    directory = root / name
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chown(directory, 10001, 10001)
password_file = root / 'secrets/postgres-password'
if not password_file.exists():
    with password_file.open('x') as target:
        target.write(secrets.token_hex(32))
password = password_file.read_text().strip()
url_file = root / 'secrets/database-url'
if not url_file.exists():
    with url_file.open('x') as target:
        target.write(f'postgresql://symphony:{password}@postgres:5432/symphony')
key_file = root / 'secrets/vault-key'
if not key_file.exists():
    with key_file.open('xb') as target:
        target.write(secrets.token_bytes(32))
for file in (password_file,url_file,key_file):
    os.chmod(file,0o600)
    os.chown(file,10001,10001)
print('V2 storage initialized; secrets generated locally and not displayed.')
