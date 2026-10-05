"""Crea claude-bridge.xpi (zip con percorsi '/'), pronto per Thunderbird."""
import zipfile
from pathlib import Path

root = Path(__file__).parent
src = root / "extension"
out = root / "claude-bridge.xpi"
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    for f in sorted(src.rglob("*")):
        if f.is_file():
            z.write(f, f.relative_to(src).as_posix())
print("Creato", out)
