import { decodeSave, encodeSave, isSealed } from "./codec.js";
import { className, currentLanguage, equipmentSlotName, localizeStatic, localized, setName, slotName, t, zoneName } from "./i18n.js";
import { SaveModel } from "./model.js";

const $ = selector => document.querySelector(selector);
const workspace = $("#workspace");
const body = $("#panel-body");
const header = $("#panel-header");
const message = $("#message");
const tabNames = {
  zones: ["Зоны", "Победы и текущая открытая зона хранятся отдельно для каждого класса."],
  talents: ["Таланты", "Опыт класса и ранги талантов. Неизвестный игре ID может быть проигнорирован."],
  codex: ["Кодекс украшений", "Здесь хранятся увиденные кольца, аксессуары и амулеты. Число 0–4 — записанное качество."],
  achievements: ["Достижения", "Флаги достижений и время получения — отдельные поля сохранения."],
  items: ["Предметы и экипировка", "Список найденных предметов аккаунта и экипировка выбранного класса."],
  other: ["Прочее", "Статистика, награды и спутники из известных строк сейва."],
  raw: ["Открытый текст", "Правьте любые строки напрямую. Неизвестные поля сохраняются при экспорте."]
};
let catalog;
let visuals;
let gameData;
let achievementDetails;
let model;
let activeTab = "zones";
let selectedClass = "11";
let codexGroup = "amulets";
let itemQuery = "";
let itemScope = "class";
let itemFilter = "all";
let importedItems = [];
let sourceName = "AzerothSurvivors-edited.sav";
let loadedFormat = "";
let achievementQuery = "";
let achievementStatus = "all";
let bulkUndo = null;
const achievementReleaseDate = "2026-10-14";
const achievementDateMinimums = new Map([
  ["collection:t05", "2026-11-04"],
  ["heroic:prepared", "2026-11-04"],
  ["feat:graduation", "2026-11-04"],
  ["feat:straightas", "2026-11-04"],
]);
const achievementScoreStep = 5;
const classSlugs = { "1": "warrior", "2": "paladin", "3": "hunter", "4": "rogue", "5": "priest", "7": "shaman", "8": "mage", "9": "warlock", "11": "druid" };
const slotSlugs = ["head", "shoulder", "chest", "waist", "legs", "feet", "wrist", "hands", "main-hand", "off-hand"];

function icon(name) {
  if (name.startsWith("game/")) {
    const atlas = visuals?.atlas;
    const index = atlas?.index[name.slice(5)];
    if (index !== undefined) {
      const element = node("span", { className: "game-icon atlas-icon", ariaHidden: "true" });
      element.style.backgroundSize = `${atlas.columns * 100}% ${atlas.rows * 100}%`;
      element.style.backgroundPosition = `${index % atlas.columns / (atlas.columns - 1) * 100}% ${Math.floor(index / atlas.columns) / (atlas.rows - 1) * 100}%`;
      return element;
    }
  }
  return node("img", { className: "game-icon", src: `./assets/icons/${name}.png`, alt: "" });
}

function node(tag, options = {}, ...children) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(options)) {
    if (key === "className") element.className = value;
    else if (key === "text") element.textContent = t(value);
    else if (key === "value") element.value = value;
    else if (key === "checked") element.checked = value;
    else if (key === "dataset") Object.assign(element.dataset, value);
    else element[key] = key === "placeholder" || key === "title" ? t(value) : value;
  }
  element.append(...children);
  return element;
}

function showMessage(text, kind = "") {
  message.textContent = t(text);
  message.className = `message ${kind}`;
}

function currentDateValue() {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function achievementMinimumDate(id) {
  return achievementDateMinimums.get(id) || achievementReleaseDate;
}

function randomAchievementTimestamp(minimumDate = achievementReleaseDate) {
  const firstUtcDay = Date.parse(`${minimumDate}T00:00:00Z`);
  const lastUtcDay = Date.parse(`${currentDateValue()}T00:00:00Z`);
  const dayCount = Math.floor((lastUtcDay - firstUtcDay) / 86400000) + 1;
  const date = new Date(`${minimumDate}T00:00:00`);
  date.setDate(date.getDate() + Math.floor(Math.random() * dayCount));
  return String(Math.floor(date.getTime() / 1000));
}

function findAchievementSubset(achievements, earnedIds, target) {
  const layers = [new Map([[0, { cost: 0, previousSum: null, included: false }]])];
  for (const achievement of achievements) {
    const previous = layers.at(-1);
    const next = new Map();
    for (const [sum, state] of previous) {
      const existingExcluded = next.get(sum);
      if (!existingExcluded || state.cost < existingExcluded.cost) {
        next.set(sum, { cost: state.cost, previousSum: sum, included: false });
      }
      const nextSum = sum + achievement.points;
      const cost = state.cost + (earnedIds.has(achievement.id) ? -1 : 1);
      const existing = next.get(nextSum);
      if (!existing || cost < existing.cost) {
        next.set(nextSum, { cost, previousSum: sum, included: true });
      }
    }
    layers.push(next);
  }
  const finalStates = layers.at(-1);
  if (!finalStates.has(target)) {
    const sums = [...finalStates.keys()];
    const lower = Math.max(...sums.filter(sum => sum < target));
    const upperCandidates = sums.filter(sum => sum > target);
    return { selected: null, lower, upper: upperCandidates.length ? Math.min(...upperCandidates) : null };
  }
  const selected = new Set();
  let sum = target;
  for (let index = achievements.length; index > 0; index--) {
    const state = layers[index].get(sum);
    if (state.included) selected.add(achievements[index - 1].id);
    sum = state.previousSum;
  }
  return { selected, lower: target, upper: target };
}

function clearBulkUndo() {
  bulkUndo = null;
  $("#undo-bulk").hidden = true;
}

function beginBulkAction() {
  bulkUndo = { text: model.toString(), expected: null };
  $("#undo-bulk").hidden = true;
}

function finishBulkAction() {
  if (!bulkUndo) return;
  bulkUndo.expected = model.toString();
  $("#undo-bulk").hidden = false;
}

function undoBulkAction() {
  if (!bulkUndo) return;
  model.setText(bulkUndo.text);
  clearBulkUndo();
  render();
  showMessage("The last bulk change was undone.", "success");
}

function syncBulkUndo() {
  if (bulkUndo?.expected !== null && bulkUndo?.expected !== undefined && model.toString() !== bulkUndo.expected) {
    clearBulkUndo();
  }
}

function labelFor(id) {
  if (id === "legendary:shred") return t("Shred · амулет друида");
  const legendary = id.startsWith("legendary:");
  const name = id.replace(/^legendary:/, "").replace(/_/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([a-zA-Z])(\d)/g, "$1 $2")
    .replace(/:/g, ": ")
    .replace(/\b\w/g, letter => letter.toUpperCase());
  return legendary ? `${t("Легендарный")} · ${name}` : name;
}

function gameText(pair) {
  return pair?.[currentLanguage() === "ru" ? 1 : 0] || "";
}

function field(label, control, grow = false) {
  return node("div", { className: `field${grow ? " grow" : ""}` }, node("label", { text: label }), control);
}

function button(text, onClick, style = "secondary") {
  const result = node("button", { type: "button", className: `button ${style}`, text });
  result.addEventListener("click", onClick);
  return result;
}

function addForm(placeholder, action) {
  const input = node("input", { type: "text", placeholder, autocomplete: "off" });
  const form = node("form", { className: "inline-form" }, input, node("button", { type: "submit", className: "button secondary", text: "Добавить" }));
  form.addEventListener("submit", event => {
    event.preventDefault();
    const value = input.value.trim();
    if (!value || /[|,\r\n]/.test(value)) return showMessage("ID не должен содержать |, запятую или перевод строки.", "error");
    action(value);
    render();
  });
  return form;
}

function classPicker() {
  const select = node("select", { value: selectedClass });
  for (const [id] of catalog.classes) select.append(node("option", { value: id, text: className(id) }));
  select.value = selectedClass;
  select.addEventListener("change", () => { selectedClass = select.value; render(); });
  return field("Класс", node("div", { className: "picker-with-icon" }, icon(`class-${classSlugs[selectedClass]}`), select));
}

function classCsv(type) {
  const fields = model.fields(type, selectedClass);
  return fields?.[2] ? fields[2].split(",").filter(Boolean) : [];
}

function setClassCsv(type, values) {
  model.set(type, [selectedClass, values.join(",")], selectedClass);
  render();
}

function saveZoneId(zoneId) {
  return zoneId === "scholo" ? "scholomance" : zoneId;
}

function editorZoneId(zoneId) {
  return zoneId === "scholomance" ? "scholo" : zoneId;
}

function heroicProgress(classId = selectedClass) {
  const entries = model.fields("hbeat", classId)?.[2] || "";
  return new Map(entries.split(",").filter(Boolean).map(entry => {
    const at = entry.lastIndexOf(":");
    const zoneId = at < 0 ? entry : entry.slice(0, at);
    return [editorZoneId(zoneId), at < 0 ? "" : entry.slice(at + 1)];
  }));
}

function saveHeroicProgress(progress, classId = selectedClass, refresh = true) {
  if (progress.size) {
    model.set("hbeat", [classId, [...progress].map(([zone, level]) => `${saveZoneId(zone)}:${level}`).join(",")], classId);
  } else {
    model.remove("hbeat", classId);
  }
  if (refresh) render();
}

function renderZones() {
  const toolbar = node("div", { className: "toolbar" }, classPicker());
  const savedCurrent = model.fields("open", selectedClass)?.[2] || "";
  const current = editorZoneId(savedCurrent);
  const select = node("select");
  select.append(node("option", { value: "", text: "Не задана" }));
  for (const [id] of catalog.zones) select.append(node("option", { value: id, text: zoneName(id) }));
  if (current && !catalog.zones.some(([id]) => id === current)) select.append(node("option", { value: current, text: `${savedCurrent} · ${t("неизвестная зона")}` }));
  select.value = current;
  select.addEventListener("change", () => {
    if (select.value) model.set("open", [selectedClass, saveZoneId(select.value)], selectedClass);
    else model.remove("open", selectedClass);
    render();
  });
  toolbar.append(field("Открытая зона", select));
  const zoneIds = catalog.zones.map(([id]) => id);
  const zoneActions = node("div", { className: "zone-bulk-actions" },
    node("div", { className: "zone-bulk-copy" },
      node("strong", { text: "Unlock every map for every character" }),
      node("small", { text: "Also marks each map cleared; heroic progress is unchanged." })),
    button("Unlock all zones", () => {
      const lastZone = zoneIds.at(-1);
      if (!lastZone) return showMessage("No zones are available to unlock.", "error");
      beginBulkAction();
      for (const [classId] of catalog.classes) {
        model.set("open", [classId, lastZone], classId);
        model.set("beat", [classId, zoneIds.map(saveZoneId).join(",")], classId);
      }
      finishBulkAction();
      render();
      showMessage("All zones unlocked and marked cleared for every character.", "success");
    }, "primary"));
  body.append(toolbar, zoneActions, node("h4", { className: "subheading", text: "Пройденные зоны" }));
  const beaten = new Set(classCsv("beat"));
  const normalizedBeaten = new Set([...beaten].map(editorZoneId));
  const list = node("div", { className: "grid-list" });
  for (const [id] of catalog.zones) {
    const check = node("input", { type: "checkbox", checked: normalizedBeaten.has(id) });
    check.addEventListener("change", () => {
      if (check.checked) normalizedBeaten.add(id); else normalizedBeaten.delete(id);
      model.set("beat", [selectedClass, [...normalizedBeaten].map(saveZoneId).join(",")], selectedClass);
      render();
    });
    list.append(node("label", { className: "check-row" }, check, node("span", { text: zoneName(id) }), node("small", { text: id })));
  }
  body.append(list, node("p", { className: "hint", text: "Игра может требовать согласованности открытой зоны и списка побед. Проверьте результат после импорта." }));

  const heroic = heroicProgress();
  const heroicZoneIds = [...zoneIds.filter(id => id !== "scholo"), ...zoneIds.filter(id => id === "scholo")];
  const heroicHeading = node("div", { className: "heroic-heading" },
    node("div", {},
      node("h4", { className: "subheading", text: "Heroic progress by map" }),
      node("p", { className: "hint", text: "Set the highest heroic level recorded for each map and class." })),
    button("Set Heroic V on all maps for this character", () => {
      beginBulkAction();
      for (const id of heroicZoneIds) heroic.set(id, "5");
      saveHeroicProgress(heroic, selectedClass, false);
      finishBulkAction();
      render();
      showMessage("Heroic V progress set for every map for this character.", "success");
    }, "primary"));
  const allHeroicAction = node("div", { className: "bulk-editor-action heroic-bulk-action" },
    node("div", { className: "bulk-editor-copy" },
      node("strong", { text: "Set Heroic V for every character" }),
      node("small", { text: "Writes a level 5 entry for every map in each character's hbeat record." })),
    button("Set all characters to Heroic V", () => {
      beginBulkAction();
      for (const [classId] of catalog.classes) {
        const progress = heroicProgress(classId);
        for (const id of heroicZoneIds) progress.set(id, "5");
        saveHeroicProgress(progress, classId, false);
      }
      finishBulkAction();
      render();
      showMessage("Heroic V progress set for every map and character.", "success");
    }, "primary"));
  const heroicList = node("div", { className: "heroic-zone-list" });
  const heroicLevels = ["No heroic progress", "Heroic I", "Heroic II", "Heroic III", "Heroic IV", "Heroic V"];
  for (const [id] of catalog.zones) {
    const level = heroic.get(id) || "0";
    const select = node("select", { ariaLabel: `${zoneName(id)} heroic progress` });
    heroicLevels.forEach((name, value) => select.append(node("option", { value: String(value), text: name })));
    select.value = /^\d+$/.test(level) && Number(level) <= 5 ? level : "0";
    select.addEventListener("change", () => {
      const progress = heroicProgress();
      if (select.value === "0") progress.delete(id);
      else progress.set(id, select.value);
      saveHeroicProgress(progress);
    });
    heroicList.append(
      node("div", { className: "heroic-zone-row" },
        node("span", { text: zoneName(id) }),
        select,
      ),
    );
  }
  body.append(heroicHeading, allHeroicAction, heroicList,
    node("p", { className: "hint", text: "Heroic levels are saved as the highest level beaten, not a separate unlock flag. Check the game after importing the edited save." }));
}

function talentRanks() {
  const entries = model.fields("talent", selectedClass)?.[3] || "";
  return new Map(entries.split(",").filter(Boolean).map(entry => {
    const at = entry.lastIndexOf(":");
    return [entry.slice(0, at), entry.slice(at + 1)];
  }));
}

function saveTalents(xp, ranks) {
  model.set("talent", [selectedClass, xp, [...ranks].map(([id, rank]) => `${id}:${rank}`).join(",")], selectedClass);
  render();
}

const maxTalentPoints = 51;

function experienceForPoints(points) {
  return points * 80 + 15 * points * (points - 1) / 2;
}

function talentProgress(experience) {
  let earned = 0;
  while (earned < maxTalentPoints && experience >= experienceForPoints(earned + 1)) earned++;
  return { earned, previous: experienceForPoints(earned), next: earned < maxTalentPoints ? experienceForPoints(earned + 1) : null };
}

function renderTalents() {
  const fields = model.fields("talent", selectedClass);
  const xp = fields?.[2] || "0";
  const ranks = talentRanks();
  const xpInput = node("input", { type: "number", min: "0", max: "999999999", step: "1", value: xp });
  xpInput.addEventListener("change", () => {
    if (!/^\d+$/.test(xpInput.value)) return render();
    saveTalents(xpInput.value, ranks);
  });
  body.append(node("div", { className: "toolbar" }, classPicker(), field("Опыт талантов", xpInput)));
  const progress = talentProgress(Number(xp));
  const spent = [...ranks.values()].reduce((sum, rank) => sum + (Number(rank) || 0), 0);
  const free = Math.max(0, progress.earned - spent);
  const summary = node("div", { className: "talent-summary" },
    node("div", { className: "talent-stat" }, node("small", { text: "Получено очков" }), node("strong", { text: `${progress.earned} / ${maxTalentPoints}` })),
    node("div", { className: "talent-stat" }, node("small", { text: "Потрачено" }), node("strong", { text: String(spent) })),
    node("div", { className: "talent-stat" }, node("small", { text: "Свободно" }), node("strong", { text: String(free) })));
  const xpStep = progress.next === null ? 1 : progress.next - progress.previous;
  const xpInStep = progress.next === null ? 1 : Math.max(0, Number(xp) - progress.previous);
  const xpLabel = progress.next === null
    ? localized("Maximum reached", "Достигнут максимум")
    : localized(`${xpInStep} / ${xpStep} XP toward next point`, `${xpInStep} / ${xpStep} опыта на следующее очко`);
  body.append(summary, node("div", { className: "talent-xp" },
    node("span", { text: xpLabel }), node("span", { text: `${xp} XP` }),
    node("progress", { max: xpStep, value: xpInStep })));
  const xpNumber = Number(xp);
  const maxXp = experienceForPoints(maxTalentPoints);
  const numberFormat = new Intl.NumberFormat(currentLanguage() === "ru" ? "ru-RU" : "en-US");
  const number = value => numberFormat.format(value);
  const xpMetrics = node("div", { className: "talent-xp-metrics" },
    node("div", {}, node("small", { text: "Опыт для 51 очка" }), node("strong", { text: `${number(maxXp)} XP` })),
    progress.next === null
      ? node("div", {}, node("small", { text: "Опыт сверх максимума" }), node("strong", { text: `${number(Math.max(0, xpNumber - maxXp))} XP` }))
      : node("div", {}, node("small", { text: "До следующего очка" }), node("strong", { text: `${number(progress.next - xpNumber)} XP` })),
    progress.next === null
      ? node("div", {}, node("small", { text: "Следующих очков" }), node("strong", { text: "0" }))
      : node("div", {}, node("small", { text: "До максимума" }), node("strong", { text: `${number(maxXp - xpNumber)} XP` })));
  body.append(xpMetrics);
  if (spent > progress.earned) body.append(node("p", { className: "hint talent-warning", text: "Потрачено больше очков, чем даёт текущий опыт. Игра может сбросить или отклонить таланты." }));
  const talentInput = id => {
    const input = node("input", { type: "number", min: "0", max: "99", step: "1", value: ranks.get(id) || "0", title: id });
    input.addEventListener("change", () => {
      const rank = Number(input.value);
      if (!Number.isInteger(rank) || rank < 0 || rank > 99) return render();
      if (rank) ranks.set(id, String(rank)); else ranks.delete(id);
      saveTalents(xpInput.value, ranks);
    });
    return input;
  };
  const trees = gameData?.talents?.[selectedClass];
  const known = new Set();
  if (trees) {
    const layout = node("div", { className: "talent-trees" });
    for (const tree of trees) {
      const treeSpent = tree.talents.reduce((total, talent) => total + (Number(ranks.get(talent.id)) || 0), 0);
      const section = node("section", { className: "talent-tree" },
        node("div", { className: "talent-tree-heading" },
          icon(tree.icon ? `game/${tree.icon}` : `class-${classSlugs[selectedClass]}`),
          node("h4", { text: gameText(tree.name) }), node("small", { text: `${treeSpent}` })));
      for (const talent of tree.talents) {
        known.add(talent.id);
        const description = gameText(talent.description);
        section.append(node("div", { className: `talent-node${Number(ranks.get(talent.id)) ? " selected" : ""}`, title: talent.id },
          icon(talent.icon ? `game/${talent.icon}` : `class-${classSlugs[selectedClass]}`),
          node("div", { className: "talent-copy" }, node("strong", { text: gameText(talent.name) }),
            ...(description ? [node("details", { className: "talent-description" },
              node("summary", { text: description.replaceAll("{v}", "…"), title: description.replaceAll("{v}", "…") }))] : [])),
          talentInput(talent.id)));
      }
      layout.append(section);
    }
    body.append(node("p", { className: "hint", text: "В описаниях талантов … означает значение, которое игра рассчитывает по рангу." }), layout);
  }
  const extras = [...new Set([...(trees ? [] : catalog.talents[selectedClass] || []), ...ranks.keys()])].filter(id => !known.has(id));
  if (extras.length) {
    if (trees) body.append(node("h4", { className: "subheading", text: "Дополнительные ID талантов" }));
    const list = node("div", { className: "grid-list" });
    for (const id of extras) list.append(node("div", { className: "rank-row" }, node("span", { text: labelFor(id) }), talentInput(id)));
    body.append(list);
  }
  body.append(addForm("ID таланта, например imp_wrath", id => {
    if (!/^[a-z][a-z0-9_]*$/.test(id)) return showMessage("Ожидался ID вида imp_wrath.", "error");
    ranks.set(id, "1");
    saveTalents(xpInput.value, ranks);
  }));
  body.append(node("p", { className: "hint", text: "ID талантов извлечены из текущего исполняемого файла игры. Игра задаёт ограничения по максимальному рангу и очкам." }));
}

function codexCategory(id) {
  if (catalog.amulets.includes(id)) return "amulets";
  if (id.startsWith("legendary:")) return "legendary";
  return "other";
}

function codexIcon(id) {
  const name = visuals?.codex[id];
  if (!name) return icon(`codex-${codexGroup}`);
  if (!id.startsWith("legendary:")) return icon(`game/${name}`);
  return node("span", { className: "codex-icon" }, icon(`game/${name}`), icon("codex-legendary"));
}

function renderCodex() {
  const groupSelect = node("select");
  for (const [id, name] of [["amulets", "Обычные амулеты"], ["legendary", "Легендарные амулеты"], ["other", "Кольца и аксессуары"]]) groupSelect.append(node("option", { value: id, text: name }));
  groupSelect.value = codexGroup;
  groupSelect.addEventListener("change", () => { codexGroup = groupSelect.value; render(); });
  body.append(node("div", { className: "toolbar" }, field("Категория", groupSelect)));
  body.append(node("p", { className: "hint", text: "Скрыт удаляет запись из кодекса. Значения 0–4 отмечают предмет найденным и задают сохранённое качество: обычное, необычное, редкое, эпическое или легендарное." }));
  const seen = model.keyed("seen");
  if (codexGroup === "legendary" && !seen.has("legendary:shred")) {
    body.append(node("div", { className: "inline-form" },
      node("p", { className: "hint", text: "В этой версии игры есть легендарный амулет Shred друида, которого нет в исходном сейве." }),
      button("Открыть амулет Shred", () => { model.setKey("seen", "legendary:shred", "4"); render(); }, "primary")));
  }
  const keys = [...new Set([...catalog.codex, ...seen.keys()])].filter(id => codexCategory(id) === codexGroup);
  const codexRow = id => {
    const current = seen.get(id);
    const select = node("select", { title: id });
    select.append(node("option", { value: "", text: "Скрыт" }));
    for (let rarity = 0; rarity <= 4; rarity++) select.append(node("option", { value: String(rarity), text: `${setName(rarity)} · ${rarity}` }));
    select.value = current ?? "";
    select.addEventListener("change", () => { model.setKey("seen", id, select.value || null); render(); });
    return node("div", { className: "rank-row" }, codexIcon(id), node("span", { text: labelFor(id), title: id }), select);
  };
  if (codexGroup === "legendary" && gameData?.codexClasses) {
    const grouped = new Set();
    for (const [classId] of catalog.classes) {
      const classKeys = gameData.codexClasses[classId] || [];
      for (const id of classKeys) grouped.add(id);
      const section = node("section", { className: "codex-class-section" });
      section.append(node("div", { className: "codex-class-heading" }, icon(`class-${classSlugs[classId]}`),
        node("strong", { text: className(classId) }),
        node("small", { text: `${classKeys.filter(id => seen.has(id)).length} / ${classKeys.length}` })));
      const list = node("div", { className: "grid-list" });
      for (const id of classKeys) list.append(codexRow(id));
      section.append(list);
      body.append(section);
    }
    const unknown = keys.filter(id => !grouped.has(id));
    if (unknown.length) {
      body.append(node("h4", { className: "subheading", text: "Другие амулеты" }));
      const list = node("div", { className: "grid-list" });
      for (const id of unknown) list.append(codexRow(id));
      body.append(list);
    }
  } else {
    const list = node("div", { className: "grid-list" });
    for (const id of keys) list.append(codexRow(id));
    body.append(list);
  }
  body.append(addForm("ID кодекса, например legendary:shred", id => {
    model.setKey("seen", id, id.startsWith("legendary:") ? "4" : "0");
  }));
}

function updateAchievementVisibility() {
  const query = achievementQuery.trim().toLocaleLowerCase();
  let visibleCount = 0;
  for (const card of body.querySelectorAll(".achievement-card")) {
    const earned = card.classList.contains("earned");
    const matchesQuery = card.dataset.achievementSearch.includes(query);
    const matchesStatus = achievementStatus === "all" ||
      (achievementStatus === "earned") === earned;
    card.hidden = !matchesQuery || !matchesStatus;
    if (!card.hidden) visibleCount++;
  }
  for (const list of body.querySelectorAll(".achievement-list")) {
    list.previousElementSibling.hidden = ![...list.children].some(card => !card.hidden);
  }
  const noResults = body.querySelector(".achievement-no-results");
  if (noResults) noResults.hidden = visibleCount > 0;
}

function renderAchievements() {
  const achieved = new Set(model.list("ach"));
  const unlockTimes = model.keyed("achat");
  const keys = [...new Set([...catalog.achievements, ...achieved])];
  const scoredAchievements = achievementDetails.groups.flatMap(group => group.items.map(([id, title, points]) => ({
    id,
    title,
    points: Number(points) || 0,
  })));
  const scoredPointTotal = scoredAchievements.reduce((total, achievement) => total + achievement.points, 0);
  const groupedIds = new Set(achievementDetails.groups.flatMap(group => group.items.map(([id]) => id)));
  body.append(node("p", { className: "achievement-total", text: localized(
    `${keys.filter(id => achieved.has(id)).length} / ${keys.length} achievements earned`,
    `Получено достижений: ${keys.filter(id => achieved.has(id)).length} / ${keys.length}`) }));
  const targetPoints = node("input", {
    type: "number",
    min: "0",
    max: String(scoredPointTotal),
    step: String(achievementScoreStep),
    placeholder: "e.g. 1650",
    ariaLabel: "Target achievement points",
  });
  const setTargetPoints = button("Set custom total", () => {
    if (!/^\d+$/.test(targetPoints.value) || !Number.isSafeInteger(Number(targetPoints.value))) {
      return showMessage("Enter a non-negative whole-number achievement total.", "error");
    }
    const target = Number(targetPoints.value);
    if (target % achievementScoreStep !== 0) {
      return showMessage(`Achievement points must be in increments of ${achievementScoreStep}.`, "error");
    }
    if (target > scoredPointTotal) {
      return showMessage(`The current achievement catalog contains ${scoredPointTotal.toLocaleString("en-US")} points.`, "error");
    }
    if (currentDateValue() < achievementReleaseDate) {
      return showMessage("The current date is before the game release date.", "error");
    }
    const currentEarned = new Set(model.list("ach"));
    const result = findAchievementSubset(scoredAchievements, currentEarned, target);
    if (!result.selected) {
      const nearest = result.upper === null ? `${result.lower.toLocaleString("en-US")} points` :
        `${result.lower.toLocaleString("en-US")} or ${result.upper.toLocaleString("en-US")} points`;
      return showMessage(`An exact total of ${target.toLocaleString("en-US")} is not possible with the current achievement point values. Nearest totals: ${nearest}.`, "error");
    }

    const knownIds = new Set(scoredAchievements.map(achievement => achievement.id));
    const unknownEarned = [...currentEarned].filter(id => !knownIds.has(id));
    const nextEarned = [...unknownEarned, ...result.selected];
    beginBulkAction();
    model.setList("ach", nextEarned);
    for (const achievement of scoredAchievements) {
      if (!result.selected.has(achievement.id)) {
        unlockTimes.delete(achievement.id);
        continue;
      }
      const existingValue = unlockTimes.get(achievement.id);
      const existingTimestamp = Number(existingValue);
      const existingDate = new Date(existingTimestamp * 1000);
      const existingDateValue = Number.isFinite(existingDate.getTime())
        ? `${existingDate.getFullYear()}-${String(existingDate.getMonth() + 1).padStart(2, "0")}-${String(existingDate.getDate()).padStart(2, "0")}`
        : "";
      const minimumDate = achievementMinimumDate(achievement.id);
      const validExistingDate = /^\d+$/.test(existingValue || "") &&
        Number.isSafeInteger(existingTimestamp) &&
        existingDateValue >= minimumDate && existingDateValue <= currentDateValue();
      if (!validExistingDate) unlockTimes.set(achievement.id, randomAchievementTimestamp(minimumDate));
    }
    model.setKeyed("achat", unlockTimes);
    finishBulkAction();
    render();
    showMessage(`Custom achievement total set to ${target.toLocaleString("en-US")} points.`, "success");
  }, "primary");
  const customScoreAction = node("div", { className: "bulk-editor-action achievement-score-action" },
    node("div", { className: "bulk-editor-copy" },
      node("strong", { text: "Choose a custom achievement total" }),
      node("small", { text: `Unlocks a combination worth exactly your target, preserving existing dates where possible. Achievement points available: ${scoredPointTotal.toLocaleString("en-US")}.` })),
    node("div", { className: "achievement-score-controls" },
      field("Target points", targetPoints),
      setTargetPoints));
  body.append(customScoreAction);
  const achievementBulkAction = node("div", { className: "bulk-editor-action" },
    node("div", { className: "bulk-editor-copy" },
      node("strong", { text: "Unlock all achievements with random dates" }),
      node("small", { text: "Assigns random earned dates from October 14, 2026 through today; the four newest achievements are dated no earlier than November 4, 2026. Existing dates will be replaced." })),
    button("Unlock all achievements", () => {
      if (currentDateValue() < achievementReleaseDate) return showMessage("The current date is before the game release date.", "error");
      const unavailable = keys.find(id => currentDateValue() < achievementMinimumDate(id));
      if (unavailable) return showMessage(`Achievement "${unavailable}" cannot be dated before ${achievementMinimumDate(unavailable)}.`, "error");
      beginBulkAction();
      model.setList("ach", keys);
      for (const id of keys) {
        model.setKey("achat", id, randomAchievementTimestamp(achievementMinimumDate(id)));
      }
      finishBulkAction();
      render();
      showMessage("All achievements unlocked with random earned dates.", "success");
    }, "primary"));
  body.append(achievementBulkAction);
  const search = node("input", { type: "search", value: achievementQuery, placeholder: "Search by name, ID, or description", ariaLabel: "Search achievements" });
  search.addEventListener("input", () => {
    achievementQuery = search.value;
    updateAchievementVisibility();
  });
  const statusFilter = node("select", { ariaLabel: "Filter achievements by earned status" });
  statusFilter.append(
    node("option", { value: "all", text: "All achievements" }),
    node("option", { value: "earned", text: "Earned" }),
    node("option", { value: "unearned", text: "Not earned" }),
  );
  statusFilter.value = achievementStatus;
  statusFilter.addEventListener("change", () => {
    achievementStatus = statusFilter.value;
    updateAchievementVisibility();
  });
  body.append(node("div", { className: "achievement-filters" },
    field("Search achievements", search, true),
    field("Show", statusFilter)));
  const groups = achievementDetails.groups.map(group => ({
    title: group.title,
    items: group.items.filter(([id]) => keys.includes(id)),
  }));
  const ungrouped = keys.filter(id => !groupedIds.has(id));
  if (ungrouped.length) groups.push({ title: "Other Achievements", items: ungrouped.map(id => [id]) });
  for (const group of groups) {
    if (!group.items.length) continue;
    const list = node("div", { className: "grid-list achievement-list" });
    for (const [id, title, points, description, reward] of group.items) {
      const entry = gameData?.achievements?.[id];
      const displayTitle = title || (entry ? gameText(entry.name) : labelFor(id));
      const displayDescription = description || (entry?.description ? gameText(entry.description) : "");
      const check = node("input", { type: "checkbox", checked: achieved.has(id) });
      check.addEventListener("change", () => {
        const minimumDate = achievementMinimumDate(id);
        if (check.checked && currentDateValue() < minimumDate) {
          check.checked = false;
          return showMessage(`Achievement "${id}" cannot be unlocked before ${minimumDate}.`, "error");
        }
        model.toggleList("ach", id, check.checked);
        if (check.checked) model.setKey("achat", id, String(Math.floor(Date.now() / 1000)));
        else model.setKey("achat", id, null);
        render();
      });
      const timestamp = Number(unlockTimes.get(id));
      const unlockDate = achieved.has(id) && Number.isFinite(timestamp) && timestamp > 0
        ? new Date(timestamp * 1000) : null;
      const dateValue = unlockDate
        ? `${unlockDate.getFullYear()}-${String(unlockDate.getMonth() + 1).padStart(2, "0")}-${String(unlockDate.getDate()).padStart(2, "0")}`
        : "";
      const dateInput = achieved.has(id)
        ? node("input", { type: "date", className: "achievement-date-input", value: dateValue, min: achievementMinimumDate(id), max: currentDateValue(), ariaLabel: `Earned date for ${title || labelFor(id)}` })
        : null;
      dateInput?.addEventListener("change", () => {
        if (!dateInput.value) {
          model.setKey("achat", id, null);
          render();
          return;
        }
        const minimumDate = achievementMinimumDate(id);
        if (dateInput.value < minimumDate || dateInput.value > currentDateValue()) {
          showMessage(`Achievement dates must be between ${minimumDate} and today.`, "error");
          dateInput.value = dateValue;
          return;
        }
        const updatedDate = new Date(`${dateInput.value}T00:00:00`);
        const updatedTimestamp = Math.floor(updatedDate.getTime() / 1000);
        if (!Number.isFinite(updatedTimestamp) || updatedTimestamp <= 0) {
          showMessage("Enter a valid achievement date.", "error");
          return;
        }
        model.setKey("achat", id, String(updatedTimestamp));
        render();
      });
      const copy = node("span", { className: "achievement-copy" },
          node("span", { className: "achievement-title" },
            node("strong", { text: displayTitle }),
            ...(points ? [node("span", { className: "achievement-points", text: String(points) })] : [])),
          ...(displayDescription ? [node("small", { text: displayDescription })] : []),
          ...(reward ? [node("small", { className: "achievement-reward", text: reward })] : []));
      const toggle = node("label", { className: "achievement-toggle" }, check, copy);
      const card = node("div", {
        className: `check-row achievement-card${achieved.has(id) ? " earned" : ""}`,
        title: id,
        dataset: { achievementSearch: `${id} ${displayTitle} ${displayDescription} ${reward || ""} ${group.title}`.toLocaleLowerCase() },
      }, toggle, ...(dateInput ? [dateInput] : []));
      list.append(card);
    }
    body.append(node("h4", { className: "subheading achievement-group-title", text: `${group.title} ${group.items.length}` }), list);
  }
  body.append(node("p", { className: "hint achievement-no-results", text: "No achievements match your search." }));
  body.append(addForm("ID достижения, например zone:ab", id => {
    model.toggleList("ach", id, true);
    model.setKey("achat", id, String(Math.floor(Date.now() / 1000)));
  }));
  body.append(node("p", { className: "hint", text: "Newly enabled achievements are dated today. Earned dates are generally from October 14, 2026 through today; the four newest achievements cannot be dated before November 4, 2026. Some achievements may be recalculated from stats by the game." }));
  updateAchievementVisibility();
}

function itemDetails(id) {
  const match = /^1(\d{2})(\d)(\d)0$/.exec(id);
  if (!match || !classSlugs[String(Number(match[1]))] || (Number(match[3]) > 5 && Number(match[3]) !== 7)) return null;
  return { classId: String(Number(match[1])), slot: Number(match[2]), set: Number(match[3]) };
}

function availableItems(collected) {
  const ids = new Set([...catalog.items, ...collected]);
  for (const [classId] of catalog.classes) {
    const slots = classId === "4" || classId === "7" ? 10 : 9;
    for (let slot = 0; slot < slots; slot++) ids.add(`1${classId.padStart(2, "0")}${slot}50`);
  }
  return [...ids].sort();
}

const collectionSets = [0, 1, 2, 3, 5, 7, 4];

function classCollectionIds(classId) {
  const regularSlots = classId === "4" || classId === "7" ? 10 : 9;
  return collectionSets.flatMap(set => {
    const slots = set === 7 ? 10 : regularSlots;
    return Array.from({ length: slots }, (_, slot) => `1${classId.padStart(2, "0")}${slot}${set}0`);
  });
}

function allCollectionIds() {
  return catalog.classes.flatMap(([classId]) => classCollectionIds(classId));
}

function renderItems() {
  const search = node("input", { type: "search", placeholder: "Поиск по ID предмета", value: itemQuery });
  search.addEventListener("input", () => {
    itemQuery = search.value.trim().toLocaleLowerCase();
    updateItemVisibility();
  });
  const scope = node("select");
  scope.append(node("option", { value: "class", text: "Выбранный класс" }), node("option", { value: "all", text: "Все классы" }));
  scope.value = itemScope;
  scope.addEventListener("change", () => { itemScope = scope.value; render(); });
  body.append(node("div", { className: "toolbar" }, field("Предметы аккаунта", search, true), classPicker(), field("Показывать", scope)));
  const items = new Set(model.list("items"));
  if (itemScope === "class") {
    const regularSlots = selectedClass === "4" || selectedClass === "7" ? 10 : 9;
    const slotsForSet = set => set === 7 ? 10 : regularSlots;
    const maxSlots = Math.max(...collectionSets.map(slotsForSet));
    const equipped = new Set(classCsv("equip").map(entry => entry.split(":")[1]));
    const classIds = classCollectionIds(selectedClass);
    const accountIds = allCollectionIds();
    const classCollected = classIds.filter(id => items.has(id)).length;
    const accountCollected = accountIds.filter(id => items.has(id)).length;
    const overview = node("section", { className: "collection-overview" },
      node("div", { className: "collection-overview-copy" },
        node("strong", { text: `${classCollected} / ${classIds.length} ${localized("collected", "собрано")}` }),
        node("span", { text: `${accountCollected} / ${accountIds.length} ${localized("gear pieces across all classes", "предметов экипировки всех классов")}` })),
      node("div", { className: "collection-progress", role: "progressbar", ariaLabel: `${className(selectedClass)} collection`, ariaValueNow: String(classCollected), ariaValueMin: "0", ariaValueMax: String(classIds.length) },
        node("span", { style: `width:${classCollected / classIds.length * 100}%` })));
    const actions = node("div", { className: "collection-actions" });
    actions.append(
      button(localized(`Unlock all for ${className(selectedClass)}`, `Открыть всё: ${className(selectedClass)}`), () => {
        const next = new Set(model.list("items"));
        for (const id of classIds) next.add(id);
        beginBulkAction();
        model.setList("items", [...next]);
        itemFilter = "collected";
        itemQuery = "";
        finishBulkAction();
        render();
        showMessage(localized(`${className(selectedClass)} collection unlocked.`, `Коллекция класса ${className(selectedClass)} открыта.`), "success");
      }, "secondary"),
      button("Unlock every equipment piece", () => {
        const next = new Set(model.list("items"));
        for (const id of accountIds) next.add(id);
        beginBulkAction();
        model.setList("items", [...next]);
        itemFilter = "collected";
        itemQuery = "";
        finishBulkAction();
        render();
        showMessage("All equipment pieces unlocked.", "success");
      }, "secondary"),
      button("Reset to imported save", () => {
        beginBulkAction();
        if (importedItems.length) model.setList("items", importedItems);
        else model.remove("items");
        itemFilter = "all";
        itemQuery = "";
        finishBulkAction();
        render();
        showMessage("Equipment collection reset to the imported save.", "success");
      }, "secondary"),
    );
    const filters = node("div", { className: "collection-filters", role: "group", ariaLabel: "Filter equipment" });
    for (const [value, label] of [["all", "All"], ["missing", "Missing"], ["collected", "Collected"]]) {
      const filterButton = button(label, () => { itemFilter = value; render(); }, "secondary");
      filterButton.classList.toggle("active", itemFilter === value);
      filterButton.setAttribute("aria-pressed", String(itemFilter === value));
      filters.append(filterButton);
    }
    const grid = node("div", { className: "gear-collection-grid" });
    grid.style.gridTemplateColumns = `minmax(130px, 1.35fr) repeat(${maxSlots}, minmax(82px, 1fr))`;
    grid.append(node("div", { className: "gear-grid-corner", text: "Tier / Set" }));
    for (let slot = 0; slot < maxSlots; slot++) grid.append(node("div", { className: "gear-grid-slot", text: slotName(slot) }));
    for (const set of collectionSets) {
      const slots = slotsForSet(set);
      const setIds = Array.from({ length: slots }, (_, slot) => `1${selectedClass.padStart(2, "0")}${slot}${set}0`);
      const setTitle = gameText(gameData?.sets?.[selectedClass]?.[set]);
      grid.append(node("div", { className: `gear-collection-set tier-${set}` },
        node("strong", { text: setName(set) }),
        ...(setTitle ? [node("small", { text: setTitle })] : []),
        node("small", { text: `${setIds.filter(id => items.has(id)).length} / ${slots}` })));
      for (let slot = 0; slot < slots; slot++) {
        const id = setIds[slot];
        const name = visuals?.gear?.[selectedClass]?.[set]?.[slot];
        const isCollected = items.has(id);
        const label = `${setName(set)} ${slotName(slot)}`;
        const title = `${className(selectedClass)} · ${label} · ${id}`;
        const tile = node("button", {
          type: "button",
          className: `gear-tile tier-${set}${isCollected ? " collected" : ""}${equipped.has(id) ? " equipped" : ""}`,
          title,
          dataset: {
            itemSearch: `${id} ${label} ${className(selectedClass)} ${setTitle}`.toLocaleLowerCase(),
            itemCollected: String(isCollected),
          },
        },
        icon(name ? `game/${name}` : set === 5 ? "pvp" : `slot-${slotSlugs[slot]}`),
        node("span", { className: "gear-tile-name", text: label }),
        node("span", { className: "gear-tile-status", text: isCollected ? "✓ Collected" : "Not collected" }),
        ...(equipped.has(id) ? [node("span", { className: "gear-tile-equipped", text: "E" })] : []));
        tile.addEventListener("click", () => { model.toggleList("items", id, !items.has(id)); render(); });
        grid.append(tile);
      }
      for (let slot = slots; slot < maxSlots; slot++) grid.append(node("div", { className: "gear-tile-empty", ariaHidden: "true" }));
    }
    body.append(overview, actions, node("p", { className: "collection-summary", text: "Select a gear tile to toggle its collected status. Green tiles are collected." }),
      node("div", { className: "collection-toolbar" }, filters),
      node("div", { className: "collection-scroll" }, grid));
  } else {
    const itemList = node("div", { className: "grid-list item-list" });
    for (const id of availableItems(items)) {
      const details = itemDetails(id);
      if (itemScope === "class" && details?.classId !== selectedClass) continue;
      const check = node("input", { type: "checkbox", checked: items.has(id) });
      check.addEventListener("change", () => { model.toggleList("items", id, check.checked); render(); });
      const label = details ? `${className(details.classId)} · ${setName(details.set)} · ${slotName(details.slot)}` : localized(`Item ${id}`, `Предмет ${id}`);
      const setTitle = details ? gameText(gameData?.sets?.[details.classId]?.[details.set]) : "";
      const row = node("label", { className: `check-row item-row${items.has(id) ? "" : " uncollected"}`, dataset: { itemSearch: `${id} ${label} ${setTitle}`.toLocaleLowerCase() } }, check,
        ...(details ? [icon(visuals?.gear?.[details.classId]?.[details.set]?.[details.slot]
          ? `game/${visuals.gear[details.classId][details.set][details.slot]}`
          : details.set === 5 ? "pvp" : `slot-${slotSlugs[details.slot]}`)] : []),
        node("span", { text: label }), node("small", { text: id }));
      itemList.append(row);
    }
    body.append(itemList);
  }
  body.append(addForm("Числовой ID предмета", id => {
    if (!/^\d+$/.test(id)) return showMessage("ID предмета должен быть числом.", "error");
    model.toggleList("items", id, true);
    if (itemDetails(id)?.classId !== selectedClass) itemScope = "all";
  }));
  body.append(node("h4", { className: "subheading", text: "Экипировка класса" }));
  const equip = classCsv("equip");
  const equipList = node("div", { className: "stack" });
  for (const entry of equip) {
    const [slot, id] = entry.split(":");
    equipList.append(node("div", { className: "rank-row" },
      node("span", { text: `${equipmentSlotName(Number(slot))} · ${id}` }),
      button("Убрать", () => setClassCsv("equip", equip.filter(value => value !== entry)), "danger small-button")));
  }
  const slotInput = node("input", { type: "number", min: "0", step: "1", placeholder: "Слот" });
  const itemInput = node("input", { type: "text", inputMode: "numeric", placeholder: "ID предмета" });
  const form = node("form", { className: "inline-form" }, slotInput, itemInput, node("button", { type: "submit", className: "button secondary", text: "Установить" }));
  form.addEventListener("submit", event => {
    event.preventDefault();
    if (!/^\d+$/.test(slotInput.value) || !/^\d+$/.test(itemInput.value)) return showMessage("Введите числовой слот и ID предмета.", "error");
    const next = equip.filter(entry => !entry.startsWith(`${slotInput.value}:`));
    next.push(`${slotInput.value}:${itemInput.value}`);
    model.toggleList("items", itemInput.value, true);
    setClassCsv("equip", next);
  });
  body.append(equipList, form);
  body.append(node("p", { className: "hint", text: "ID найденных предметов взяты из сейва. ID PvP-набора выведены из той же схемы и по умолчанию не отмечены. Слоты и совместимость проверяет игра." }));

  body.append(node("h4", { className: "subheading", text: "Marks" }));
  const marksBulkAction = node("div", { className: "bulk-editor-action" },
    node("div", { className: "bulk-editor-copy" },
      node("strong", { text: "Set marks for every character" }),
      node("small", { text: "Sets each character's marks to exactly 10,000." })),
    button("Give all characters 10,000 marks", () => {
      beginBulkAction();
      for (const [classId] of catalog.classes) {
        model.set("marks", [classId, "10000"], classId);
      }
      finishBulkAction();
      render();
      showMessage("Marks set to 10,000 for every character.", "success");
    }, "primary"));
  const marksInput = node("input", {
    type: "number",
    min: "0",
    step: "1",
    value: model.fields("marks", selectedClass)?.[2] || "0",
  });
  const saveMarks = button("Update marks", () => {
    if (!/^\d+$/.test(marksInput.value) || !Number.isSafeInteger(Number(marksInput.value))) {
      return showMessage("Marks must be a non-negative whole number.", "error");
    }
    model.set("marks", [selectedClass, marksInput.value], selectedClass);
    showMessage("Class marks updated.", "success");
    render();
  }, "secondary");
  body.append(
    marksBulkAction,
    node("div", { className: "rank-row marks-editor" },
      node("span", { text: `${className(selectedClass)} · ${t("Marks available for equipment upgrades")}` }),
      marksInput,
      saveMarks),
    node("p", { className: "hint", text: "Marks are stored separately for each class." }),
  );
  updateItemVisibility();
}

function updateItemVisibility() {
  for (const card of body.querySelectorAll("[data-item-search]")) {
    const matchesSearch = card.dataset.itemSearch.includes(itemQuery);
    if (card.classList.contains("gear-tile")) {
      const matchesFilter = itemFilter === "all" ||
        (itemFilter === "collected") === (card.dataset.itemCollected === "true");
      card.classList.toggle("filtered-out", !matchesSearch || !matchesFilter);
    } else {
      card.hidden = !matchesSearch;
    }
  }
}

function renderOther() {
  const stats = model.keyed("stat");
  body.append(node("h4", { className: "subheading", text: "Статистика" }));
  const statGrid = node("div", { className: "stat-grid" });
  for (const [id, value] of stats) {
    const input = node("input", { type: "number", min: "0", step: "1", value });
    input.addEventListener("change", () => {
      if (/^\d+$/.test(input.value)) model.setKey("stat", id, input.value);
      render();
    });
    statGrid.append(field(id, input));
  }
  body.append(statGrid);
  body.append(node("h4", { className: "subheading", text: "Награды / перки" }));
  const perks = model.keyed("perk", ":");
  const perkList = node("div", { className: "grid-list" });
  for (const [id, value] of perks) {
    const input = node("input", { type: "number", min: "0", max: "99", step: "1", value });
    input.addEventListener("change", () => { model.setKey("perk", id, Number(input.value) ? input.value : null, ":"); render(); });
    perkList.append(node("div", { className: "rank-row" }, node("span", { text: labelFor(id) }), input));
  }
  body.append(perkList, addForm("ID перка", id => model.setKey("perk", id, "1", ":")));
  body.append(node("h4", { className: "subheading", text: "Спутники" }));
  const pets = model.list("pets");
  const petList = node("div", { className: "grid-list" });
  for (const id of pets) petList.append(node("div", { className: "rank-row" }, node("span", { text: labelFor(id) }), button("Убрать", () => { model.toggleList("pets", id, false); render(); }, "danger small-button")));
  body.append(petList, addForm("ID спутника", id => model.toggleList("pets", id, true)));
}

function renderRaw() {
  const textarea = node("textarea", { className: "raw-editor", spellcheck: false, value: model.toString() });
  body.append(textarea, node("div", { className: "inline-form" }, button("Применить открытый текст", () => {
    if (!/^[A-Za-z][A-Za-z0-9_]*\|/m.test(textarea.value)) return showMessage("В тексте не найдено строк формата key|value.", "error");
    model.setText(textarea.value);
    showMessage("Открытый текст применён.", "success");
    render();
  }, "primary")));
  body.append(node("p", { className: "hint", text: "Поля разделены символом |, списки — запятыми. Изменения в этом поле вступают в силу после нажатия кнопки." }));
}

function renderSaveProfile() {
  const profile = $("#save-profile");
  if (!profile || !model) return;
  const pick = model.fields("pick") || [];
  const characterName = pick[5]?.trim() || "Unnamed character";
  const stats = model.keyed("stat");
  const winsValue = stats.get("wins");
  const wins = /^\d+$/.test(winsValue || "") ? Number(winsValue).toLocaleString("en-US") : "—";
  const earnedAchievements = new Set(model.list("ach"));
  const achievements = new Set([...catalog.achievements, ...earnedAchievements]);
  const achievementCount = [...achievements].filter(id => earnedAchievements.has(id)).length;
  const achievementProgress = achievements.size
    ? Math.round(achievementCount / achievements.size * 100)
    : 0;

  profile.replaceChildren(
    node("div", { className: "import-art-stars", ariaHidden: "true" }),
    node("div", { className: "profile-content" },
      node("div", { className: "profile-illustration", ariaHidden: "true" },
        node("span", { className: "profile-map-orbit" }),
        node("span", { className: "profile-map-orbit profile-map-orbit-inner" }),
        node("span", { className: "profile-map-star profile-map-star-one" }),
        node("span", { className: "profile-map-star profile-map-star-two" }),
        node("span", { className: "profile-map-marker" }, node("span", { text: "AS" }))),
      node("div", { className: "profile-name" },
        node("span", { className: "profile-kicker", text: "SAVE CHRONICLE" }),
        node("strong", { text: characterName })),
      node("div", { className: "profile-stats" },
        node("div", { className: "profile-stat" },
          node("span", { text: "Wins" }),
          node("strong", { text: wins })),
        node("div", { className: "profile-stat profile-achievements" },
          node("div", { className: "profile-achievements-heading" },
            node("span", { text: "Achievements" }),
            node("strong", { text: `${achievementCount.toLocaleString("en-US")} / ${achievements.size.toLocaleString("en-US")}` })),
          node("div", { className: "profile-achievement-track", role: "progressbar",
            ariaLabel: "Achievements earned", ariaValueNow: String(achievementCount),
            ariaValueMin: "0", ariaValueMax: String(achievements.size) },
            node("span", { style: `width:${achievementProgress}%` })))),
      node("small", { className: "profile-footnote", text: "SAVE DATA · PROCESSED LOCALLY" })),
    node("span", { className: "import-art-spark spark-one", ariaHidden: "true" }),
    node("span", { className: "import-art-spark spark-two", ariaHidden: "true" }),
    node("span", { className: "import-art-spark spark-three", ariaHidden: "true" }),
  );
  profile.classList.add("has-save-profile");
}

function render() {
  if (!model) return;
  syncBulkUndo();
  renderSaveProfile();
  header.replaceChildren(node("h3", { text: tabNames[activeTab][0] }), node("p", { text: tabNames[activeTab][1] }));
  body.replaceChildren();
  ({ zones: renderZones, talents: renderTalents, codex: renderCodex, achievements: renderAchievements,
    items: renderItems, other: renderOther, raw: renderRaw })[activeTab]();
  const lines = model.lines.filter(Boolean).length;
  const items = model.list("items").length;
  const entries = model.keyed("seen").size;
  $("#save-summary").textContent = localized(
    `${lines} lines · ${items} items · ${entries} codex entries`,
    `${lines} строк · ${items} предметов · ${entries} записей кодекса`,
  );
  for (const tab of document.querySelectorAll(".tab")) tab.classList.toggle("active", tab.dataset.tab === activeTab);
}

async function load(value, filename) {
  try {
    if (value.length > 2_000_000) throw new Error("Файл превышает 2 МБ.");
    showMessage("Проверяю подпись и читаю сохранение…");
    const plaintext = await decodeSave(value);
    model = new SaveModel(plaintext);
    clearBulkUndo();
    achievementQuery = "";
    achievementStatus = "all";
    importedItems = model.list("items");
    sourceName = filename ? filename.replace(/\.(sav|txt)$/i, "") + "-edited.sav" : "AzerothSurvivors-edited.sav";
    loadedFormat = isSealed(value) ? "RSE1 проверен" : "Открытый текст";
    $("#format-status").textContent = t(loadedFormat);
    $("#format-status").classList.add("good");
    workspace.hidden = false;
    render();
    showMessage("Сохранение открыто. Оригинал не изменён.", "success");
    workspace.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    showMessage(error.message, "error");
  }
}

function validateSaveForExport() {
  const warnings = [];
  const earned = new Set(model.list("ach"));
  const unlockTimes = model.keyed("achat");
  const today = currentDateValue();
  for (const id of earned) {
    const rawTimestamp = unlockTimes.get(id);
    const timestamp = Number(rawTimestamp);
    if (!rawTimestamp || !/^\d+$/.test(rawTimestamp) || !Number.isSafeInteger(timestamp) || timestamp <= 0) {
      warnings.push(`Earned achievement "${id}" has a missing or invalid date.`);
      continue;
    }
    const date = new Date(timestamp * 1000);
    if (!Number.isFinite(date.getTime())) {
      warnings.push(`Earned achievement "${id}" has an invalid timestamp.`);
      continue;
    }
    const dateValue = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    const minimumDate = achievementMinimumDate(id);
    if (dateValue < minimumDate || dateValue > today) {
      warnings.push(`Earned achievement "${id}" is dated outside its ${minimumDate}-to-today range.`);
    }
  }
  for (const id of unlockTimes.keys()) {
    if (!earned.has(id)) warnings.push(`Achievement "${id}" has a date but is not marked earned.`);
  }
  for (const line of model.lines) {
    const fields = line.split("|");
    if (fields[0] === "open" && fields[2]) {
      const cleared = new Set(model.fields("beat", fields[1])?.[2]?.split(",").filter(Boolean) || []);
      if (!cleared.has(fields[2])) warnings.push(`Class ${fields[1]}'s open zone "${fields[2]}" is not in its cleared-zone list.`);
    } else if (fields[0] === "hbeat" && fields[2]) {
      for (const entry of fields[2].split(",").filter(Boolean)) {
        const separator = entry.lastIndexOf(":");
        const zoneId = separator < 0 ? entry : entry.slice(0, separator);
        const level = separator < 0 ? "" : entry.slice(separator + 1);
        if (!/^[1-5]$/.test(level)) warnings.push(`Heroic progress for "${zoneId}" has an invalid level.`);
      }
    } else if (fields[0] === "marks" && fields[2] &&
      (!/^\d+$/.test(fields[2]) || !Number.isSafeInteger(Number(fields[2])))) {
      warnings.push(`Class ${fields[1]}'s marks value is not a non-negative whole number.`);
    }
  }
  return [...new Set(warnings)];
}

async function exportSave(copy) {
  const earned = new Set(model.list("ach"));
  const unlockTimes = model.keyed("achat");
  const tooEarlyAchievement = [...earned].find(id => {
    const minimumDate = achievementDateMinimums.get(id);
    const rawTimestamp = unlockTimes.get(id);
    if (!minimumDate || !/^\d+$/.test(rawTimestamp || "")) return false;
    const timestamp = Number(rawTimestamp);
    if (!Number.isSafeInteger(timestamp) || timestamp <= 0) return false;
    const date = new Date(timestamp * 1000);
    if (!Number.isFinite(date.getTime())) return false;
    const dateValue = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    return dateValue < minimumDate;
  });
  if (tooEarlyAchievement) {
    showMessage(`Achievement "${tooEarlyAchievement}" cannot be unlocked before ${achievementDateMinimums.get(tooEarlyAchievement)}. Update its earned date before exporting.`, "error");
    return;
  }
  const warnings = validateSaveForExport();
  if (warnings.length) {
    const visibleWarnings = warnings.slice(0, 8).map(warning => `• ${warning}`);
    if (warnings.length > visibleWarnings.length) visibleWarnings.push(`• And ${warnings.length - visibleWarnings.length} more potential issue(s).`);
    const message = `Pre-export check found potential save issues:\n\n${visibleWarnings.join("\n")}\n\nContinue exporting anyway?`;
    if (!window.confirm(message)) {
      showMessage("Export cancelled. Review the save issues before trying again.", "error");
      return;
    }
  }
  const target = $(copy ? "#copy-save" : "#download-save");
  target.disabled = true;
  try {
    const sealed = await encodeSave(model.toString());
    if (copy) {
      await navigator.clipboard.writeText(sealed);
      showMessage("Новая строка RSE1 скопирована в буфер обмена.", "success");
    } else {
      const url = URL.createObjectURL(new Blob([sealed], { type: "text/plain;charset=utf-8" }));
      const link = node("a", { href: url, download: sourceName });
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      showMessage(localized(`Downloaded ${sourceName}.`, `Скачан файл ${sourceName}.`), "success");
    }
  } catch (error) {
    showMessage(error.message || "Не удалось экспортировать сохранение.", "error");
  } finally {
    target.disabled = false;
  }
}

async function start() {
  localizeStatic();
  try {
    const [response, visualResponse, gameResponse, achievementResponse] = await Promise.all([
      fetch("./data/catalog.json"),
      fetch("./data/visuals.json").catch(() => null),
      fetch("./data/game.json").catch(() => null),
      fetch("./data/achievement-details.json"),
    ]);
    if (!response.ok) throw new Error(`Could not load catalog: HTTP ${response.status}`);
    if (!achievementResponse.ok) throw new Error(`Could not load achievement details: HTTP ${achievementResponse.status}`);
    catalog = await response.json();
    visuals = visualResponse?.ok ? await visualResponse.json() : null;
    gameData = gameResponse?.ok ? await gameResponse.json() : null;
    achievementDetails = await achievementResponse.json();
  } catch {
    showMessage("Could not load editor data. Open the page through a web server or GitHub Pages.", "error");
    return;
  }
  $("#load-text").addEventListener("click", () => load($("#save-input").value));
  $("#save-file").addEventListener("change", async event => {
    const file = event.target.files[0];
    if (file) {
      if (file.size > 2_000_000) return showMessage("Файл превышает 2 МБ.", "error");
      await load(await file.text(), file.name);
    }
  });
  const drop = $("#drop-zone");
  for (const type of ["dragenter", "dragover"]) drop.addEventListener(type, event => { event.preventDefault(); drop.classList.add("dragging"); });
  for (const type of ["dragleave", "drop"]) drop.addEventListener(type, event => { event.preventDefault(); drop.classList.remove("dragging"); });
  drop.addEventListener("drop", async event => {
    const file = event.dataTransfer.files[0];
    if (file) {
      if (file.size > 2_000_000) return showMessage("Файл превышает 2 МБ.", "error");
      await load(await file.text(), file.name);
    }
  });
  for (const tab of document.querySelectorAll(".tab")) tab.addEventListener("click", () => { activeTab = tab.dataset.tab; render(); });
  $("#copy-save").addEventListener("click", () => exportSave(true));
  $("#download-save").addEventListener("click", () => exportSave(false));
  $("#undo-bulk").addEventListener("click", undoBulkAction);
}

start();
