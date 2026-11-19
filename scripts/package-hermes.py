"""Build the editable map schema and reproducible Hermes download from public sources only."""

import json
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo

root = Path(__file__).resolve().parents[1]
plugin = root / "integrations/hermes/agent-mini-office"
catalog = (root / "public/schemas/action-v1.json").read_bytes()
(plugin / "action-v1.json").write_bytes(catalog)
choices = []
for name, spec in json.loads(catalog)["x-actions"].items():
    fields = {"action": {"const": name}}
    if "variants" in spec:
        fields["variant"] = {"enum": [v["id"] for v in spec["variants"]]}
    choices.append(
        {
            "type": "object",
            "properties": fields,
            "required": ["action"],
            "additionalProperties": False,
        }
    )
schema = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "required": ["$schema", "tools"],
    "additionalProperties": False,
    "properties": {
        "$schema": {"const": "actions.schema.json"},
        "tools": {
            "type": "object",
            "propertyNames": {"pattern": "^[a-zA-Z0-9_.:-]{1,120}$"},
            "additionalProperties": {"oneOf": choices},
        },
    },
}
(plugin / "actions.schema.json").write_text(json.dumps(schema, indent=2) + "\n")
with ZipFile(root / "public/downloads/agent-mini-office-hermes.zip", "w") as archive:
    for name in (
        "__init__.py",
        "panel.py",
        "daemon.py",
        "visit.py",
        "plugin.yaml",
        "README.md",
        "config.example.json",
        "config.schema.json",
        "actions.json",
        "actions.schema.json",
        "action-v1.json",
    ):
        archive.writestr(
            ZipInfo("agent-mini-office/" + name),
            (plugin / name).read_bytes(),
            compress_type=ZIP_DEFLATED,
        )
