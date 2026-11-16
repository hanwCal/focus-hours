"""Build an installable source ZIP without development tools or local state."""
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED

root = Path(__file__).resolve().parent.parent
output = root / 'dist' / 'focus-hours.zip'
output.parent.mkdir(exist_ok=True)
files = [root / 'manifest.json', root / 'README.md']
for pattern in ('*.js', '*.html', '*.css', 'lib/*.js', 'icons/*.png', 'icons/*.svg', 'assets/*.svg', 'assets/fonts/*'):
    files.extend(root.glob(pattern))
with ZipFile(output, 'w', ZIP_DEFLATED) as archive:
    for path in sorted(set(files)):
        archive.write(path, Path('focus-hours') / path.relative_to(root))
print(output)
