"""Extract editor metadata and searchable strings from an Azeroth Survivors EXE."""

import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import struct

from game_data import ICON_START, build_metadata, locale_tables


ROOT = Path(__file__).resolve().parents[1]
ASCII_STRINGS = re.compile(rb"[\x20-\x7e]{4,}")
UTF16LE_STRINGS = re.compile(rb"(?:[\x20-\x7e]\x00){4,}")
ITEM_ID = re.compile(rb"(?<!\d)1\d{5}(?!\d)")
MACHINES = {
    0x014C: "x86",
    0x8664: "x86-64",
    0xAA64: "ARM64",
}
SUBSYSTEMS = {
    2: "Windows GUI",
    3: "Windows console",
}


def parse_pe(data):
    if len(data) < 64 or data[:2] != b"MZ":
        raise ValueError("The selected file does not have a valid Windows EXE header.")

    pe_offset = struct.unpack_from("<I", data, 0x3C)[0]
    if pe_offset + 24 > len(data) or data[pe_offset:pe_offset + 4] != b"PE\0\0":
        raise ValueError("The selected file is missing a valid PE header.")

    coff_offset = pe_offset + 4
    machine, section_count, timestamp, _, _, optional_size, _ = struct.unpack_from(
        "<HHIIIHH", data, coff_offset
    )
    optional_offset = coff_offset + 20
    optional_end = optional_offset + optional_size
    if optional_end > len(data) or optional_size < 70:
        raise ValueError("The EXE has an incomplete PE optional header.")

    optional_magic = struct.unpack_from("<H", data, optional_offset)[0]
    if optional_magic not in (0x10B, 0x20B):
        raise ValueError(f"Unsupported PE optional header format: 0x{optional_magic:04X}.")
    subsystem = struct.unpack_from("<H", data, optional_offset + 68)[0]
    sections = []
    section_offset = optional_end
    for index in range(section_count):
        offset = section_offset + index * 40
        if offset + 40 > len(data):
            raise ValueError("The EXE has an incomplete PE section table.")
        name, virtual_size, virtual_address, raw_size, raw_offset = struct.unpack_from(
            "<8sIIII", data, offset
        )
        sections.append({
            "name": name.split(b"\0", 1)[0].decode("ascii", errors="replace"),
            "virtualSize": virtual_size,
            "virtualAddress": f"0x{virtual_address:08X}",
            "rawSize": raw_size,
            "rawOffset": f"0x{raw_offset:08X}",
        })

    return {
        "machine": MACHINES.get(machine, f"Unknown (0x{machine:04X})"),
        "peFormat": "PE32+" if optional_magic == 0x20B else "PE32",
        "subsystem": SUBSYSTEMS.get(subsystem, f"Unknown ({subsystem})"),
        "timestampUtc": datetime.fromtimestamp(timestamp, timezone.utc).isoformat(),
        "sections": sections,
    }


def scan_strings(data):
    found = {}
    for encoding, pattern, codec in (
        ("ASCII", ASCII_STRINGS, "ascii"),
        ("UTF-16LE", UTF16LE_STRINGS, "utf-16le"),
    ):
        for match in pattern.finditer(data):
            value = match.group().decode(codec)
            found.setdefault((encoding, value), match.start())
    return [
        {"encoding": encoding, "offset": offset, "value": value}
        for (encoding, value), offset in sorted(found.items(), key=lambda entry: entry[1])
    ]


def build_report(executable, data, catalog):
    pe_metadata = parse_pe(data)
    all_localizations = locale_tables(data)
    editor_metadata = build_metadata(data, catalog)
    item_ids = sorted({match.group().decode("ascii") for match in ITEM_ID.finditer(data)})
    asset_names = sorted({match.group().decode("ascii") for match in ICON_START.finditer(data)})

    return {
        "source": {
            "fileName": executable.name,
            "sizeBytes": len(data),
            "sha256": hashlib.sha256(data).hexdigest(),
            "pe": pe_metadata,
        },
        "editorMetadata": editor_metadata,
        "editorCatalogSnapshot": catalog,
        "localizations": all_localizations,
        "embeddedAssetNameCandidates": asset_names,
        "candidateItemIds": item_ids,
    }


def main():
    parser = argparse.ArgumentParser(
        description="Extract searchable game metadata from a local Azeroth Survivors EXE."
    )
    parser.add_argument("executable", type=Path, help="Path to AzerothSurvivors.exe")
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=ROOT / "metadata-extracts",
        help="Folder for the JSON report and searchable string inventory.",
    )
    args = parser.parse_args()
    executable = args.executable.expanduser().resolve()
    if not executable.is_file():
        parser.error(f"EXE not found: {executable}")

    data = executable.read_bytes()
    try:
        catalog = json.loads((ROOT / "data" / "catalog.json").read_text(encoding="utf-8"))
        report = build_report(executable, data, catalog)
    except (ValueError, KeyError, IndexError, AssertionError) as error:
        raise SystemExit(
            "Could not recognize this game build's metadata tables. "
            f"Check that the file is the original Azeroth Survivors EXE. Details: {error}"
        ) from error

    output_dir = args.output_dir.expanduser().resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    report_path = output_dir / f"{executable.stem}-metadata.json"
    strings_path = output_dir / f"{executable.stem}-strings.txt"
    strings = scan_strings(data)
    report["inventory"] = {
        "uniqueEmbeddedStrings": len(strings),
        "localizationLanguages": len(report["localizations"]),
        "localizationEntries": sum(len(table) for table in report["localizations"].values()),
        "assetNameCandidates": len(report["embeddedAssetNameCandidates"]),
        "candidateItemIds": len(report["candidateItemIds"]),
    }
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    strings_path.write_text(
        "".join(f'{entry["encoding"]}\t0x{entry["offset"]:08X}\t{entry["value"]}\n' for entry in strings),
        encoding="utf-8",
    )
    print(f"Metadata report: {report_path}")
    print(f"Searchable strings: {strings_path}")
    print(
        "Extracted "
        f'{report["inventory"]["localizationEntries"]} localization entries in '
        f'{report["inventory"]["localizationLanguages"]} languages, '
        f'{report["inventory"]["assetNameCandidates"]} asset-name candidates, and '
        f'{report["inventory"]["candidateItemIds"]} candidate item IDs.'
    )
    print("Candidate IDs and strings require verification; not every embedded value is game data.")


if __name__ == "__main__":
    main()
