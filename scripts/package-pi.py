"""Regenerate both public downloads from one Pi entry. No network or private settings."""

from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'integrations/pi/agent-mini-office'
PUBLIC = ROOT / 'public'
OUT = PUBLIC / 'downloads'
files = {
    'index.ts': SOURCE / 'index.ts',
    'actions.json': SOURCE / 'actions.json',
    'actions.example.json': PUBLIC / 'downloads/examples/pi-tool-map.json',
    'actions.schema.json': PUBLIC / 'schemas/pi-action-map-v1.json',
    'action-v1.json': PUBLIC / 'schemas/action-v1.json',
}
OUT.mkdir(exist_ok=True)
with ZipFile(OUT / 'agent-mini-office.zip', 'w') as archive:
    for name, source in files.items():
        item = ZipInfo('agent-mini-office/' + name)  # fixed ZIP timestamp
        item.create_system = 3
        item.external_attr = 0o100644 << 16
        archive.writestr(item, source.read_bytes(), compress_type=ZIP_DEFLATED)
(OUT / 'agent-mini-office.ts').write_bytes(files['index.ts'].read_bytes())
