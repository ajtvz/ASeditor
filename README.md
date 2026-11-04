# Azeroth Survivors Save Editor

**Customized and maintained by ajtvz** · Created by [darhanger](https://github.com/darhanger)

## [✨ Open the editor — use it in your browser](https://ajtvz.github.io/ASeditor/)

No download or installation needed. Your save is read and edited locally in your browser; it is not uploaded to a server.

![Azeroth Survivors Save Editor home screen](docs/screenshots/editor-home.png)

## Make your save your own

- Adjust character progress, zones, talents, gear, equipment, codex entries, stats, perks, pets, and more.
- Equip a complete gear set at once or choose items for each character slot; set individual upgrades from 0 to 5 stars or upgrade all equipped items to 5 stars.
- Browse and search 129 achievements, edit earned dates, or choose an exact achievement score up to 3,195 points.
- Export an edited `.sav` file or copy its RSE1 string to import into your game.
- Keep your original save as a backup before importing changes.

![Equipment loadout editor with gear selection and star upgrades](docs/screenshots/editor-equipment.png)

## How to use

1. **[Open the editor](https://ajtvz.github.io/ASeditor/).**
2. Select your `characters.txt` save or an exported `.sav` file, or paste an RSE1 string.
3. Make your changes, then download the edited save or copy the RSE1 string.
4. Import the edited save in the game. Keep your backup until you confirm it works.

## Find your save file

The editor runs in your browser and does not search your computer automatically. Use **Browse files** to select the save file from its folder. The game stores its character save in these locations:

| Platform | Character save | Exports and backups |
| --- | --- | --- |
| Windows | `%APPDATA%\wenilla-rogue\characters.txt` | `%APPDATA%\wenilla-rogue\Saves` |
| Linux | `~/.local/share/wenilla-rogue/characters.txt` (or `$XDG_DATA_HOME/wenilla-rogue/characters.txt`) | `~/.local/share/wenilla-rogue/Saves` |
| macOS | `~/.local/share/wenilla-rogue/characters.txt` | `~/.local/share/wenilla-rogue/Saves` |

On Windows, press **Win+R**, enter `%APPDATA%\wenilla-rogue`, and press Enter. Back up your save before replacing or importing any changes.

## Support development

Enjoying the editor? [💜 Support ajtvz on PayPal](https://paypal.me/aaronaj222). Donations are optional and appreciated.

## Credits

The original Azeroth Survivors Save Editor was created by [darhanger](https://github.com/darhanger/AzerothSurvivors-SaveEditor). This edition is customized and maintained by [ajtvz](https://github.com/ajtvz), with expanded save customization and additional achievement tools.
