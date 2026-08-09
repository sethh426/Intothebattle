# Aetheris Structure Assets

The committed GLBs are generated from `generate_assets.py` with Blender 4.5 LTS.
No third-party model content is used.

Run from the repository root:

```powershell
npm install
powershell -ExecutionPolicy Bypass -File tools/aetheris-assets/build-assets.ps1
```

Set `AETHERIS_BLENDER` when the portable Blender executable is not at the
default path used by the build script.

The build exports 30 hero LOD files plus regional, stronghold, and ambient
packs, optimizes them with glTF Transform Meshopt compression, validates every
GLB, and enforces the 12 MB committed asset budget.
