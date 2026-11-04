# Azeroth Survivors Save Editor

**Customized and maintained by ajtvz**

[**Open the editor in your browser**](https://ajtvz.github.io/ASeditor/) · [View the GitHub repository](https://github.com/ajtvz/ASeditor)

A browser-based editor for Azeroth Survivors save files. Open an exported `.sav` file, paste an `RSE1:` string, or edit plaintext save data. Changes are processed locally in your browser; the editor does not upload save files.

Created by **darhanger**: [original Azeroth Survivors Save Editor](https://github.com/darhanger/AzerothSurvivors-SaveEditor). This customized edition is maintained by **ajtvz**, with expanded options for personalizing save data and greater freedom over achievements, gear, and progress.

## Features

- Import signed RSE1 saves, verify signatures, and export an edited save or RSE1 string.
- Edit zones, Heroic progress, talents, codex entries, achievements, collected gear, equipment, marks, stats, perks, pets, and other supported save fields.
- Manage all 354 talent entries, with branch information, descriptions, and XP progress.
- Browse gear by class, rarity, and slot; search the item list and manage collected pieces.
- Browse 129 achievements with descriptions, point values, reward notes, earned flags, and editable earned dates. Adjusting earned dates lets you customize the achievement timeline, including making edited unlocks appear less conspicuous.
- Filter and search achievements, unlock all achievements, or choose an exact custom total up to 3,195 points. Undo the last bulk change.
- Enforce achievement-specific minimum dates: the four newest achievements cannot be dated earlier than November 4, 2026.
- Check achievement dates, zone progress, Heroic levels, and marks before export.
- Preserve unknown save lines when editing through the form controls.

## Use the editor

1. Open [ajtvz's editor](https://ajtvz.github.io/ASeditor/) after the GitHub Pages deployment completes. Until then, run it locally using the instructions below.
2. Select a `.sav` or `.txt` file, drop it onto the page, or paste an `RSE1:` string or save plaintext.
3. Edit the desired sections. Use the **Plaintext** tab for direct save-line editing.
4. Export a new `.sav` file or copy the updated RSE1 string, then import it in the game.

**Back up your original save first.** Importing a save in the game replaces account progress. The editor does not modify the original file on your device.

## Run locally

No build step is required. From the project folder, start a local web server:

```powershell
python -m http.server 8000
```

Then open <http://localhost:8000/>. Opening `index.html` directly with `file://` may prevent the browser from loading the editor's JSON data files.

## Deploy with GitHub Pages

The included [Pages workflow](.github/workflows/pages.yml) publishes the editor when changes are pushed to the `main` branch. In [your repository's Pages settings](https://github.com/ajtvz/ASeditor/settings/pages), set the Pages source to **GitHub Actions**. Push your changes to `main` and wait for the workflow to finish. The expected site URL is <https://ajtvz.github.io/ASeditor/>. The workflow publishes `index.html`, `styles.css`, `src/`, `data/`, and `assets/`.

Save files are excluded from deployment. Never commit private `.sav` files or the game executable.

## Data notes and limitations

- The editor targets the original standalone Azeroth Survivors Windows build analyzed on October 18, 2026. It is not a World of Warcraft addon.
- The save format, talent information, achievement metadata, and item mappings are based on the supplied save and local game data. Game updates may change valid fields, signatures, or IDs.
- Tier .05 gear IDs follow the existing item ID pattern. Some PvP IDs are inferred and should be tested in game before making broader changes.
- Some gear, talent, and spell icons are representative visual approximations and do not change save values.
- Achievement point totals use the editor's current catalog. Some achievements may be recalculated by the game from save statistics.
- Unknown lines are retained when using form controls; direct edits in the **Plaintext** tab can change or remove any line.

See [docs/format.md](docs/format.md) for details about the save format and editor behavior.

## Local game metadata tools

To extract a metadata report and searchable strings from your own copy of the game executable:

```powershell
python tools\extract_metadata.py "C:\Path\To\AzerothSurvivors.exe"
```

The executable is read locally and is not uploaded. Extracted strings and numeric IDs are candidates, not proof that a value is valid in game.

To regenerate visual data from a full installed game folder, install `mpyq` and `Pillow`, then run:

```powershell
python tools\extract_icons.py C:\WoW\Surv\Data
python tools\build_visuals.py C:\WoW\Surv
```

The original project and its source history are available at [darhanger/AzerothSurvivors-SaveEditor](https://github.com/darhanger/AzerothSurvivors-SaveEditor).
