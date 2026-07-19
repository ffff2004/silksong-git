# Pre-Solid Save-to-Semantic Mapping Compatibility Source

> **Legacy warning:** Despite this directory's historical name, this document
> describes the removed pre-Solid decoding, mapping, and DOM-rendering path. It
> must not be used as current architecture or current semantic behavior. Read
> the [Semantic Core architecture](../architecture/semantic-core.md) for current
> behavior and the
> [classified legacy mapping reference](../legacy/web-before-solid/save-to-semantic.md)
> for the preserved compatibility summary.

This source is retained temporarily so the final documentation-contract ticket
can verify the migration before retiring old paths. The functions, paths, and
present-tense statements below form a historical snapshot of how `<save>.dat`
was decoded, parsed, semantically mapped, and rendered before the Solid and Core
extractions; they do not describe the live pipeline.

After the P2 workspace migration, old `src/...` references in this document correspond to `apps/web/src/...` unless a path explicitly says otherwise.

## Historical Pipeline Overview

The pre-Solid pipeline was:

```txt
<save>.dat
  -> File.arrayBuffer()
  -> decodeSilksongSave()
  -> raw save JSON object
  -> parseSilksongSave()
  -> getSaveFileFlags()
  -> currentLoadedSaveData / currentLoadedSaveDataFlags
  -> renderActiveTab()
  -> updateTabProgress()
  -> src/data/*.json item definitions
  -> getSaveDataValue(item)
  -> getUnlocked(item, value)
  -> renderGenericGrid()
  -> DOM class: done / accepted / locked / unlocked / unobtainable
```

The most important responsibilities are:

- The raw save JSON stores the game's original state and is not directly user-facing.
- `src/data/*.json` stores user-readable item definitions such as name, category, icon, description, map location, and save flag.
- `getSaveDataValue()` reads the corresponding state from the raw save JSON based on fields such as an item's `type`, `flag`, and `scene`.
- `getUnlocked()` normalizes the extracted raw value or intermediate state into whether the item is completed.
- `renderGenericGrid()` renders the normalized state into CSS classes and icon states.

## Semantic Information Categories by JSON Structure

From the structure of the raw save JSON, the semantic information parsed by the project is not one uniform format. Instead, it is composed of several different data shapes. In practice, `item.type` in `src/data/*.json` tells `getSaveDataValue()` which shape to read from the raw save.

### 1. Direct `playerData` fields

This type of data lives directly on `playerData`, usually as a boolean or number.

Common item types:

```txt
flag
boss
key
flagInt
level
quill
```

Typical raw shape:

```ts
{
  playerData: {
    PurchasedBonebottomHeartPiece: true,
    nailUpgrades: 2,
    hasQuill: true
  }
}
```

Typical read pattern:

```ts
playerData[item.flag];
```

Semantic meaning:

- A boolean directly indicates whether a global state has been triggered, such as whether a key item has been purchased.
- A number represents a level or stage, such as a needle upgrade level.
- `key` can use one flag, or treat any of multiple flags being `true` as obtained.
- `quill` first checks `hasQuill`, then uses the quill state to decide which specific quill entry to display.

### 2. `SceneName` / `ID` / `Value` scene flags

This type of data is scattered through nested structures in the raw save and does not always live in one fixed top-level field. The project extracts it with a recursive scan.

Typical raw shape:

```ts
{
  SceneName: "Crawl_02",
  ID: "Heart Piece",
  Value: true
}
```

Corresponding item types:

```txt
sceneBool
the scene flag portion of device
```

Parsing flow:

```txt
raw save nested objects
  -> getSaveFileFlags()
  -> normalize SceneName and ID
  -> saveDataFlags[scene][id] = Boolean(Value)
```

Semantic meaning:

- Whether a pickup, interaction point, or state within a given scene has been triggered.
- This works well for location-based collection states such as Mask Shards, Heart Pieces, and Silk Spools inside rooms.
- `Value` may originally be a number or a boolean, but it is converted to a boolean after entering `saveDataFlags`.

### 3. `Name` / `Data` lists in `savedData[]`

This is a common Unity save format: a list of named entries. It is not a normal map. Instead, it is an array where each element uses `Name` to identify the business object and `Data` to store state fields.

Typical raw shape:

```ts
{
  savedData: [
    {
      Name: "Some Item Name",
      Data: {
        IsUnlocked: true,
        IsCompleted: false,
        Amount: 1,
      },
    },
  ];
}
```

Corresponding raw areas:

```txt
playerData.Collectables
playerData.Tools
playerData.ToolEquips
playerData.QuestCompletionData
playerData.Relics
playerData.MementosDeposited
playerData.MateriumCollected
```

Corresponding item types:

```txt
collectable
tool
quest
relic
materium
```

Parsing flow:

```txt
objectWithSavedData.savedData[]
  -> find entry where entry.Name matches item.flag
  -> read entry.Data specific fields
  -> map raw fields to tracker state
```

Different types read different fields from `Data`:

```txt
collectable -> Data.Amount
tool        -> Data.IsUnlocked
quest       -> Data.IsCompleted / Data.IsAccepted
relic       -> Data.IsDeposited / Data.IsCollected / Data.HasSeenInRelicBoard
materium    -> Data.IsCollected / Data.HasSeenInRelicBoard
```

Semantic meaning:

- `Name` is the internal object name in the save.
- Fields in `Data` express that object's business state.
- The tracker further normalizes those fields into number, boolean, `"completed"`, `"accepted"`, `"collected"`, or `"deposited"`.

### 4. `EnemyJournalKillData.list[]` journal counts

The enemy journal has its own dedicated structure and does not use the generic `savedData[]` format.

Typical raw shape:

```ts
{
  playerData: {
    EnemyJournalKillData: {
      list: [
        {
          Name: "Some Enemy",
          Record: {
            Kills: 3,
            HasBeenSeen: true,
          },
        },
      ];
    }
  }
}
```

Corresponding item type:

```txt
journal
```

Parsing flow:

```txt
EnemyJournalKillData.list[]
  -> find entry where entry.Name === item.flag
  -> return entry.Record.Kills
  -> compare Kills with item.required
```

Semantic meaning:

- `Kills` is the progress value.
- `item.required` is the completion threshold.
- `0 < Kills < required` appears in the UI as partial progress.

### 5. `scenesVisited` string set

Visited rooms are stored as an array of strings.

Typical raw shape:

```ts
{
  playerData: {
    scenesVisited: ["Crawl_02", "Dock_08"];
  }
}
```

Corresponding item type:

```txt
sceneVisited
```

Parsing flow:

```txt
playerData.scenesVisited.includes(item.scene)
```

Semantic meaning:

- Whether a room or region has been visited.
- This does not represent the pickup itself, only membership in the visited set.

### 6. Combined-condition semantics

Some user-readable entries cannot be determined by a single raw save field. Instead, they are complete if any one of several conditions is satisfied.

Corresponding item type:

```txt
anyOf
```

Typical item shape:

```json
{
  "type": "anyOf",
  "anyOf": [
    { "type": "level", "flag": "someFlag", "required": 1 },
    { "type": "sceneBool", "scene": "SomeScene", "flag": "Some Flag" }
  ]
}
```

Parsing flow:

```txt
item.anyOf[]
  -> treat each check as a temporary item
  -> call getSaveDataValue() for each check
  -> getUnlocked() succeeds if any check is satisfied
```

Semantic meaning:

- This is an aggregation rule defined by the tracker itself.
- There is no single field in the raw save that directly represents this user-facing entry.
- It is useful when the same semantic state can come from different routes, version differences, or mutually exclusive sources.

### 7. Display-semantic metadata

This information does not come from the save. It comes from `src/data/*.json` and converts internal state into user-readable content.

Common fields:

```txt
label
description
icon
link
act
mapViewer
mapCategory
showOnMap
missable
unobtainable
group
mode
```

Semantic meaning:

- `label` is the UI card title.
- `description` is the modal description.
- `icon` determines which icon is shown when completed or unlocked.
- `act`, `mode`, `group`, `missable`, and `unobtainable` affect filtering, counting, and special states.
- `mapViewer`, `mapCategory`, and `showOnMap` allow the same item to appear as a pin in the map tab.

Only after combining this metadata with the raw save parse result does the final user-facing information emerge. For example, the raw save may only contain:

```txt
SceneName = Crawl_02
ID = Heart Piece
Value = true
```

But the UI can display:

```txt
Mask Shard #2
Act I
actual icon
map location
done state
```

## 1. File upload entry point

The entry point is `handleSaveFile(file)` in `src/save-data.ts`.

After the user selects or drags in a save file, the code first reads the binary content:

```ts
const buffer = await file.arrayBuffer();
const isJSON = file.name.toLowerCase().endsWith(".json");
```

If the uploaded file is `.json`, it is already a decoded raw save JSON and is parsed directly:

```ts
JSON.parse(new TextDecoder("utf8").decode(buffer));
```

If the uploaded file is `.dat`, the code calls:

```ts
decodeSilksongSave(buffer);
```

The output of this step is uniformly named `saveDataRaw`, with type `unknown`. All later semantic mapping is built on top of this raw object.

## 2. Decoding `.dat` into raw JSON

The `.dat` decoding logic is in `decodeSilksongSave(arrayBuffer)` in `src/save-decoder.ts`.

The decode process is:

1. Wrap the `ArrayBuffer` in a `Uint8Array`.
2. Call `removeHeader(bytes)` to strip the Unity/C# serialization header and length prefix.
3. Reconstruct the remaining bytes into a Base64 string.
4. Use `crypto-js` to decrypt with AES ECB PKCS7 mode.
5. Convert the decrypted result into a UTF-8 JSON string.
6. Call `JSON.parse(jsonString)` to get the raw save object.

Corresponding code structure:

```ts
const bytes = new Uint8Array(arrayBuffer);
const bytesWithoutHeader = removeHeader(bytes);
const encryptedWords = CryptoJS.enc.Base64.parse(b64String);
const decrypted = CryptoJS.AES.decrypt(cipherParams, key, {
  mode: CryptoJS.mode.ECB,
  padding: CryptoJS.pad.Pkcs7,
});
const jsonString = CryptoJS.enc.Utf8.stringify(decrypted);
return JSON.parse(jsonString);
```

This step only restores `.dat` into JSON. It does not decide whether an item has been obtained, and it does not translate flags into user-readable names.

## 3. Validating the save structure

After decoding, `handleSaveFile()` first asserts that the raw value is an object, then calls `parseSilksongSave(saveDataRaw)`.

The validation logic is in `src/save-parser.ts`:

```ts
const silksongSaveSchema = z.object({
  playerData: z.object({
    Collectables: objectWithSavedData,
    completionPercentage: z.int(),
    EnemyJournalKillData: z.object(...),
    MateriumCollected: objectWithSavedData,
    MementosDeposited: objectWithSavedData,
    geo: z.int(),
    playTime: z.number(),
    QuestCompletionData: objectWithSavedData,
    Relics: objectWithSavedData,
    scenesVisited: z.array(z.string()),
    ShellShards: z.int(),
    ToolEquips: objectWithSavedData,
    Tools: objectWithSavedData,
    ...
  }),
  sceneData: z.object({}).readonly(),
});
```

`parseSilksongSave()` uses Zod's `safeParseAsync()`. If the structure does not match expectations, the page reports an invalid or corrupted save and stops further mapping.

The purpose of this step is to confirm that the raw save contains at least the key regions the tracker needs to read:

- `playerData`
- `sceneData`
- `playerData.Collectables`
- `playerData.Tools`
- `playerData.ToolEquips`
- `playerData.QuestCompletionData`
- `playerData.EnemyJournalKillData`
- `playerData.Relics`
- `playerData.MateriumCollected`
- `playerData.MementosDeposited`
- `playerData.scenesVisited`

## 4. Building the scene flag index

Some progress is not stored directly on `playerData.someFlag`. Instead, it is scattered through nested raw save structures in forms such as:

```ts
{
  SceneName: "Crawl_02",
  ID: "Heart Piece",
  Value: true
}
```

To support fast lookup later, `handleSaveFile()` calls `getSaveFileFlags(saveDataRaw)`.

This function is defined in `src/save-parser.ts`. It recursively traverses the entire raw save object and finds every object that contains `SceneName`, `ID`, and `Value` at the same time:

```ts
if (SceneName !== undefined && ID !== undefined && Value !== undefined) {
  mark(SceneName, ID, Value);
}
```

`mark()` normalizes the scene and id:

```ts
scene = normalizeStringWithUnderscores(scene);
id = normalizeStringWithUnderscores(id);
flags[scene][id] = Boolean(value);
```

The result is an index like this:

```ts
{
  Crawl_02: {
    Heart_Piece: true
  },
  Dock_08: {
    Heart_Piece: false
  }
}
```

This index mainly serves `sceneBool` items, such as Mask Shards, Heart Pieces, and Silk Spools scattered across rooms.

Note: `Value` may be a boolean or a number, but it is converted to a boolean in the index. This means `getSaveFileFlags()` is well suited to represent whether a given scene/id has been triggered, but not to preserve original numeric progress. Entries that need numeric values normally go through `level`, `journal`, or another dedicated branch.

## 5. Storing current runtime state

After validation, `handleSaveFile()` stores the current save in module-level variables:

```ts
currentLoadedSaveData = saveDataRaw as unknown as SilksongSave;
currentLoadedSaveDataFlags = getSaveFileFlags(saveDataRaw);
```

It then updates the top-level summary:

```ts
completionValue.textContent = `${saveData.playerData.completionPercentage}%`;
playtimeValue.textContent = `${hours}h ${mins}m`;
rosariesValue.textContent = saveData.playerData.geo.toString();
shardsValue.textContent = saveData.playerData.ShellShards.toString();
```

Steel Soul versus normal mode is also determined here:

```ts
const isSteelSoul = [1, 2, 3, "On", "Dead"].includes(
  saveData.playerData.permadeathMode,
);
currentLoadedSaveDataMode = isSteelSoul ? "steel" : "normal";
```

Finally, it triggers a rerender:

```ts
renderActiveTab();
globalThis.dispatchEvent(new Event("save-data-changed"));
```

## 6. Static JSON data provides user-readable semantics

Field names in the raw save JSON come from the game's internals, for example:

- `nailUpgrades`
- `PurchasedBonebottomHeartPiece`
- `Heart Piece`
- `Citadel Seeker`
- `Seal Chit Aspid_01`

Those field names are not always suitable for direct display. The tracker uses `src/data/*.json` as its semantic layer.

`updateTabProgress()` in `src/tabs/progress.ts` loads these data sources:

```ts
main.json;
essentials.json;
bosses.json;
mini - bosses.json;
completion.json;
wishes.json;
journal.json;
scenes.json;
```

Each JSON file contains categories and items. A typical item looks like:

```json
{
  "act": 1,
  "description": "In lower Wormways, accessed through Mosshome...",
  "flag": "Heart Piece",
  "icon": "icons/MaskShard.png",
  "id": "mask-shard-2",
  "label": "Mask Shard #2",
  "link": "https://hollowknight.wiki/w/Mask_Shard_(Silksong)",
  "scene": "Crawl_02",
  "showOnMap": true,
  "type": "sceneBool"
}
```

The semantic layering here is:

- `label`: the user-visible name.
- `description`: the text shown in the modal.
- `icon`: the UI icon.
- `link`: an external reference link.
- `act`: the owning act, used for filtering.
- `mapViewer` / `showOnMap` / `mapCategory`: information for map pins.
- `type`: tells the code which read rule to use.
- `flag`: the field name, entry name, or ID in the raw save.
- `scene`: the room for a scene-scoped flag.
- `required`: the completion threshold for numeric items.

In other words, the semantic mapping dictionary is not just `flag -> label`. It is a combination of `type + flag + scene + required + label + metadata`.

## 7. `getSaveDataValue()` reads raw values by item type

The core mapping function is this function in `src/save-data.ts`:

```ts
getSaveDataValue(saveData, saveDataFlags, item);
```

Its inputs are:

- `saveData`: the current raw save object.
- `saveDataFlags`: the scene flag index generated by `getSaveFileFlags()`.
- `item`: the semantic item definition from `src/data/*.json`.

Its output can be:

- boolean, such as `true` / `false`
- number, such as an upgrade level or kill count
- string states, such as `"completed"`, `"accepted"`, `"collected"`, `"deposited"`
- `undefined`, meaning no corresponding data was found in the save

The mapping rules by `item.type` are below.

### `flag`

Used for boolean flags that exist directly on `playerData`.

```ts
return playerDataExpanded[flag];
```

Example item:

```json
{
  "label": "Mask Shard #1",
  "type": "flag",
  "flag": "PurchasedBonebottomHeartPiece"
}
```

Mapping meaning:

```txt
playerData.PurchasedBonebottomHeartPiece === true
  -> Mask Shard #1 obtained
```

### `sceneBool`

Used for scene-scoped flags. The code reads the `saveDataFlags` index built in step 4.

```ts
const normalizedScene = normalizeStringWithUnderscores(scene);
const normalizedFlag = normalizeStringWithUnderscores(flag);
const sceneFlags = saveDataFlags[normalizedScene];
return sceneFlags[normalizedFlag];
```

Example item:

```json
{
  "label": "Mask Shard #2",
  "type": "sceneBool",
  "scene": "Crawl_02",
  "flag": "Heart Piece"
}
```

Mapping meaning:

```txt
saveDataFlags.Crawl_02.Heart_Piece === true
  -> Mask Shard #2 obtained
```

Some special entries, such as `"Shell Fossil Mimic"`, also read `sceneData.persistentInts.serializedList` and compare the scene value against `required`.

### `collectable`

Used for quantity-based collectables in `playerData.Collectables.savedData`.

```ts
const entry = playerData.Collectables.savedData.find(
  (element) => element.Name === flag,
);
return entry.Data.Amount ?? 0;
```

Mapping meaning:

```txt
Collectables.savedData[].Name === item.flag
  -> return Data.Amount
```

Later, `Amount > 0` means the collectable has been obtained.

### `tool`

Used for tools, equipment, and tool upgrades. The code checks both `playerData.Tools` and `playerData.ToolEquips`.

```ts
const entry = findIn(Tools) ?? findIn(ToolEquips);
return entry.Data["IsUnlocked"] === true;
```

Lookup uses `normalizeString()` so it can ignore differences such as case and extra whitespace.

Mapping meaning:

```txt
Tools.savedData[].Name ~= item.flag
  -> Data.IsUnlocked === true
```

or:

```txt
ToolEquips.savedData[].Name ~= item.flag
  -> Data.IsUnlocked === true
```

### `quest`

Used for wish and quest state. The code looks in `playerData.QuestCompletionData.savedData`:

```ts
const entry = QuestCompletionData.savedData.find(
  (e) => normalizeString(e.Name) === normalizedFlag,
);
```

It then converts the raw quest fields into an intermediate state:

```ts
if (Data["IsCompleted"] === true) {
  return "completed";
}

if (Data["IsAccepted"] === true) {
  return "accepted";
}

return false;
```

Mapping meaning:

```txt
IsCompleted -> completed
IsAccepted  -> accepted
otherwise   -> false
```

In the UI, `"completed"` shows as complete, while `"accepted"` shows as accepted but not complete.

### `level`

Used for numeric progress, such as needle upgrades and tool pouch upgrades.

```ts
return playerDataExpanded[flag] ?? 0;
```

The item uses `required` to define the threshold:

```json
{
  "label": "Shining Needle",
  "type": "level",
  "flag": "nailUpgrades",
  "required": 2
}
```

Mapping meaning:

```txt
playerData.nailUpgrades >= 2
  -> Shining Needle obtained
```

### `flagInt`

Used for integer flags stored directly on `playerData` where only values of at least 1 matter.

```ts
const current = playerDataExpanded[flag];
return typeof current === "number" ? current >= 1 : false;
```

Mapping meaning:

```txt
number >= 1 -> true
otherwise   -> false
```

### `journal`

Used for Hunter Journal or enemy journal progress.

The code looks in `playerData.EnemyJournalKillData.list`:

```ts
const entry = list.find((element) => element.Name === item.flag);
return entry.Record.Kills;
```

The item uses `required` to define the kill count needed for completion:

```json
{
  "label": "Some Enemy",
  "type": "journal",
  "flag": "Some Enemy Internal Name",
  "required": 3
}
```

Mapping meaning:

```txt
EnemyJournalKillData.list[].Name === item.flag
  -> return Record.Kills

Kills >= item.required
  -> completed

0 < Kills < item.required
  -> accepted / partial
```

### `relic`

Used for relic and memento entries. The code reads from a combined list:

```ts
const combinedList = [...Relics.savedData, ...MementosDeposited.savedData];
```

It then looks up by `Name === item.flag`. The state mapping is:

```ts
if (Data["IsDeposited"] === true) {
  return "deposited";
}

if (Data["HasSeenInRelicBoard"] === true) {
  return "collected";
}

if (Data["IsCollected"] === true) {
  return "collected";
}

return false;
```

Mapping meaning:

```txt
IsDeposited         -> deposited
HasSeenInRelicBoard -> collected
IsCollected         -> collected
otherwise           -> false
```

### `materium`

Used for materium entries. The code reads `playerData.MateriumCollected.savedData`.

The state mapping is:

```ts
if (Data["HasSeenInRelicBoard"] === true) {
  return "deposited";
}

if (Data["IsCollected"] === true) {
  return "collected";
}

return false;
```

Note that `HasSeenInRelicBoard` is mapped to `"deposited"`, while `IsCollected` is mapped to `"collected"`.

### `device`

Used for entries such as Materium and Farsight, whose state is determined jointly by a scene flag and a related player flag.

The code first checks `relatedFlag`:

```ts
if (playerDataExpanded[relatedFlag] === true) {
  return "deposited";
}
```

If the related flag is not triggered, it then checks the scene flag:

```ts
if (sceneFlags[normalizedFlag] === true) {
  return "collected";
}
```

Mapping meaning:

```txt
playerData[item.relatedFlag] === true
  -> deposited

saveDataFlags[item.scene][item.flag] === true
  -> collected

otherwise
  -> false
```

### `boss`

Used for boss defeat state. It is currently a simple boolean flag:

```ts
return playerDataExpanded[flag];
```

Its mapping meaning is similar to `flag`, but the type is used for the boss data table.

### `key`

Used for key entries. It supports either a single flag or multiple candidate flags.

Single flag:

```ts
return playerDataExpanded[flag] === true;
```

Multiple flags:

```ts
return item.flags.some((flag) => playerDataExpanded[flag] === true);
```

Mapping meaning:

```txt
any listed key flag is true
  -> key obtained
```

### `quill`

Used for quill state. It first confirms that the player owns the quill:

```ts
if (playerDataExpanded["hasQuill"] !== true) {
  return 0;
}
```

If the player has the quill, it returns the numeric value of the specified flag:

```ts
return playerDataExpanded[flag] ?? 0;
```

Later, the UI checks:

```ts
item.id === `QuillState_${value}` && [1, 2, 3].includes(value);
```

So `quill` entries are not a simple `value > 0`. The current quill state must match the item's `id`.

### `sceneVisited`

Used for room or region visit state. The code reads:

```ts
playerData.scenesVisited.includes(item.scene);
```

Mapping meaning:

```txt
item.scene in playerData.scenesVisited
  -> visited / obtained
```

### `anyOf`

Used when any one of multiple conditions is enough to complete the entry.

The item contains:

```json
{
  "type": "anyOf",
  "anyOf": [
    { "type": "level", "flag": "someFlag", "required": 1 },
    { "type": "sceneBool", "scene": "SomeScene", "flag": "Some Flag" }
  ]
}
```

The code constructs a temporary item for each sub-condition and recursively calls `getSaveDataValue()`:

```ts
const checkResult = getSaveDataValue(saveData, saveDataFlags, mockItem);
results.push(checkResult);
```

It finally returns the result array for all sub-conditions. Later, `getUnlocked()` and `renderGenericGrid()` evaluate those sub-conditions one by one, and the item is considered complete if any one of them passes.

## 8. `getUnlocked()` normalizes values into completion state

The output of `getSaveDataValue()` is not uniform: it may be a boolean, number, string, or array. `getUnlocked(item, value)` in `src/tabs/progress.ts` normalizes them into a boolean.

Core rules:

```txt
quest:
  value === "completed" || value === true

level:
  numeric value >= item.required

collectable:
  numeric value > 0

quill:
  item.id === `QuillState_${value}` && value in [1, 2, 3]

journal:
  numeric value >= item.required || value === true

key:
  value === true

sceneVisited:
  item.scene in playerData.scenesVisited

anyOf:
  any sub-check is satisfied

default:
  value === true || value === "collected" || value === "deposited"
```

This is the second layer of semantic mapping: the first layer extracts the status value for the item from the raw save, and the second layer decides whether that status value means the user has completed or obtained it.

## 9. `renderGenericGrid()` converts to UI state

`renderGenericGrid()` in `src/tabs/progress.ts` renders each item as a card.

It calls:

```ts
const value = getSaveDataValue(saveData, saveDataFlags, item);
```

It then calculates two UI states based on `item.type`:

- `isDone`: whether the item is complete.
- `isAccepted`: whether it is partially complete, accepted, or collected but not deposited.

Main rules:

```txt
level:
  isDone = current >= required

collectable:
  isDone = current > 0

quest:
  isDone = value === "completed"
  isAccepted = value === "accepted"

relic / materium / device:
  isDone = value === "deposited"
  isAccepted = value === "collected"

journal:
  isDone = kills >= required
  isAccepted = kills > 0 && kills < required

key:
  isDone = value === true

sceneVisited:
  isDone = scene is in scenesVisited

default:
  isDone = value === true
```

These are then mapped to DOM classes:

```txt
isDone
  -> class "done"

isAccepted
  -> class "accepted"

item.unobtainable && save loaded
  -> class "unobtainable"

spoilerOn && not done
  -> class "unlocked"

otherwise
  -> class "locked"
```

Icons are also decided here:

- `done`: show the real icon.
- `accepted`: show the real icon with accepted styling.
- `unobtainable`: show the real icon with unobtainable styling.
- `unlocked` with spoilers: show the real icon.
- `locked` without spoilers: show the locked icon, and temporarily show the real icon on hover.

The card title comes from:

```ts
title.textContent = item.label;
```

That is the final readable name shown to the user.

## 10. Category counts and the missing filter

When `updateTabProgress()` renders each category, it counts:

```txt
obtained / total
```

It iterates through the filtered items and, for each item, calls:

```ts
const value = getSaveDataValue(saveData, saveDataFlags, item);
const unlocked = getUnlocked(item, value);
```

It then increments `total` and `obtained`.

The `Show only missing` filter is also based on the same mapping results:

- Completed items are filtered out.
- `collectable` requires a quantity of `0` to count as missing.
- `level` requires the current value to be less than `required` to count as missing.
- `quest` requires the state to not be `"completed"` to count as missing.
- `anyOf` requires all sub-conditions to fail to count as missing.

This means category counts, the missing filter, and card classes all use the same semantic mapping, but consume the result in different ways.

## 11. Map pin state

Map pins also reuse the same semantic mapping.

`renderWorldMapPins()` collects all items from `src/data/*.json` where `showOnMap === true` and `mapViewer` is present. For each pin:

```ts
const value = getSaveDataValue(saveData, saveDataFlags, item);
const unlocked = getUnlocked(item, value);
if (unlocked) {
  pin.classList.add("obtained");
}
```

In other words, an obtained pin on the map and a done state in the Progress tab both come from the same `getSaveDataValue()` + `getUnlocked()` pair.

## 12. The Raw Save tab does not participate in semantic mapping

The Raw Save tab in `src/tabs/raw-save.ts` only displays the current save object:

```ts
const jsonText = JSON.stringify(saveData, undefined, 2);
editor?.setValue(jsonText);
```

It does not call `getSaveDataValue()`, and it does not use `src/data/*.json`. As a result, the Raw Save tab is an entry point for debugging and inspecting original data, not a semantic mapping output.

## 13. A complete example: Mask Shard #2

For `Mask Shard #2`, the static item definition looks roughly like:

```json
{
  "label": "Mask Shard #2",
  "type": "sceneBool",
  "flag": "Heart Piece",
  "scene": "Crawl_02",
  "icon": "icons/MaskShard.png"
}
```

Full pipeline:

```txt
<save>.dat
  -> decodeSilksongSave()
  -> raw JSON
  -> getSaveFileFlags(raw JSON)
  -> find { SceneName: "Crawl_02", ID: "Heart Piece", Value: true }
  -> saveDataFlags.Crawl_02.Heart_Piece = true
  -> getSaveDataValue(item) returns true
  -> getUnlocked(item, true) returns true
  -> renderGenericGrid() sets class "done"
  -> UI shows "Mask Shard #2" with real icon
```

Here, the raw save's `"Heart Piece"` is not shown directly to the user. The user instead sees `"Mask Shard #2"` as defined in `src/data/main.json`.

## 14. A complete example: Quest

For a quest item:

```json
{
  "label": "The Great Citadel",
  "type": "quest",
  "flag": "Citadel Seeker"
}
```

Full pipeline:

```txt
<save>.dat
  -> raw JSON
  -> playerData.QuestCompletionData.savedData
  -> find Name ~= "Citadel Seeker"
  -> read Data.IsCompleted / Data.IsAccepted
```

State mapping:

```txt
IsCompleted === true
  -> getSaveDataValue() returns "completed"
  -> getUnlocked() returns true
  -> UI class "done"

IsAccepted === true
  -> getSaveDataValue() returns "accepted"
  -> getUnlocked() returns false
  -> UI class "accepted"

otherwise
  -> getSaveDataValue() returns false
  -> UI class "locked" or "unlocked" depending on spoiler setting
```

## 15. A complete example: Needle upgrade

Needle upgrades use the `level` type:

```json
{
  "label": "Shining Needle",
  "type": "level",
  "flag": "nailUpgrades",
  "required": 2
}
```

Full pipeline:

```txt
<save>.dat
  -> raw JSON
  -> playerData.nailUpgrades
  -> getSaveDataValue() returns numeric level
  -> getUnlocked() compares level >= required
```

If:

```txt
playerData.nailUpgrades = 3
```

Then:

```txt
3 >= 2
  -> Shining Needle done
```

If:

```txt
playerData.nailUpgrades = 1
```

Then:

```txt
1 < 2
  -> Shining Needle not done
```

## 16. Key source locations

- `src/save-data.ts`
  - `handleSaveFile()`: reads files, decodes, validates, stores current state, and triggers rendering.
  - `getSaveDataValue()`: the core semantic mapping read function.
  - `getSaveData()`, `getSaveDataFlags()`, `getSaveDataMode()`: expose current save state.
- `src/save-decoder.ts`
  - `decodeSilksongSave()`: `.dat` to raw JSON.
- `src/save-parser.ts`
  - `parseSilksongSave()`: Zod schema validation.
  - `getSaveFileFlags()`: recursively extracts scene-scoped flags.
- `src/tabs/progress.ts`
  - `updateTabProgress()`: loads static data tables and renders the progress tab.
  - `getUnlocked()`: normalizes mapping values into completion state.
  - `renderGenericGrid()`: converts completion state into a UI card class.
  - `renderWorldMapPins()`: map pins reuse the same mapping.
- `src/tabs/raw-save.ts`
  - `updateTabRawSaveData()`: displays raw JSON directly and does not participate in semantic mapping.
- `src/data/*.json`
  - User-readable semantic data sources: categories, items, `label`, `description`, `icon`, `flag`, `scene`, `required`, and map metadata.

## 17. Reuse recommendations for a new CLI project

If the goal is to implement a CLI in another new project, for example:

```txt
silksong-save-cli path/to/user.dat --json
```

The recommended approach is to reuse this project's core parsing capabilities, but not the browser UI layer directly. The current repository is a Vite frontend app, not a library package specifically published for external consumption, so importing the whole app as an npm package carries unnecessary risk.

### Recommended parts to reuse

These modules or data files are close to pure logic and are suitable to copy, extract, or convert into the core of a new CLI project.

```txt
src/save-decoder.ts
```

Reusable content:

```txt
decodeSilksongSave()
```

Why:

- It handles the core `.dat` to raw JSON decoding.
- The logic is relatively self-contained and depends only on `crypto-js`.
- A CLI needs the same AES decryption and JSON parsing capability.

```txt
src/save-parser.ts
```

Reusable content:

```txt
parseSilksongSave()
getSaveFileFlags()
```

Why:

- `parseSilksongSave()` defines the save schema currently needed by the tracker.
- `getSaveFileFlags()` is the core extraction logic for scene-scoped flags.
- This part has no DOM dependencies and fits CLI reuse well.

```txt
src/data/*.json
```

Reusable content:

```txt
main.json
essentials.json
bosses.json
mini-bosses.json
completion.json
wishes.json
journal.json
scenes.json
```

Why:

- These JSON files are the main semantic mapping data source.
- They define user-readable `label`, `description`, `icon`, `flag`, `scene`, `required`, `mapViewer`, and related information.
- Without reusing them, the CLI would need to maintain a second mapping table from flags to user semantics, which would be easy to drift out of sync with the website.

```txt
src/types/Item.ts
src/types/Category.ts
src/types/Act.ts
src/types/Mode.ts
```

Reusable content:

```txt
Item
Category
Act
Mode
```

Why:

- These types define the shape of `src/data/*.json`.
- A CLI that outputs semantic results also needs to understand each item's `type` and metadata.

```txt
src/save-data.ts
```

Recommended extraction:

```txt
getSaveDataValue()
```

Why:

- `getSaveDataValue()` is the core mapping function from raw save to item state.
- But `src/save-data.ts` also contains DOM updates, toasts, global state, and UI triggers, so the whole file is not a good reuse target.

```txt
src/tabs/progress.ts
```

Recommended extraction:

```txt
getUnlocked()
the data merge approach used by collectAllItems()
```

Why:

- `getUnlocked()` normalizes the output of `getSaveDataValue()` into a completion state.
- The `collectAllItems()` approach can help a CLI merge all of `src/data/*.json`.
- But most of the file is UI rendering, modal, TOC, map pin, and DOM code, so the whole file is not a good reuse target.

### Parts not recommended for reuse

These areas are tightly coupled to the browser UI and are not good candidates for direct import into a CLI project.

```txt
`handleSaveFile()` in `src/save-data.ts`
```

Why not:

- It depends on the browser `File` API.
- It manipulates DOM elements such as `completionValue`, `playtimeValue`, and `modeBanner`.
- It calls `showToast()`.
- It calls `renderActiveTab()` and dispatches a `save-data-changed` event.
- A CLI only needs file reading, decoding, and output, not those UI side effects.

```txt
the UI rendering section of `src/tabs/progress.ts`
```

Content not recommended:

```txt
updateTabProgress()
renderGenericGrid()
showGenericModal()
renderWorldMapPins()
initWorldMapPins()
buildDynamicTOC()
initScrollSpy()
```

Why not:

- It depends on `document`, DOM elements, CSS classes, modals, `IntersectionObserver`, map images, and browser events.
- Its output target is webpage cards and map pins, not CLI JSON or tables.
- Reusing it directly would bind the CLI to a browser environment.

```txt
src/elements.ts
src/components/*
src/tabs/raw-save.ts
src/tabs/map.ts
src/main.ts
```

Why not:

- These are app-shell, component initialization, tab switching, upload modal, raw editor, and map interaction code.
- A CLI does not need this interaction layer.

### Recommended structure for a new project

For a new CLI project, a good approach is to organize the core logic under `core/` and let the CLI itself only handle argument parsing, file reading, and output formatting.

```txt
your-cli/
  src/
    cli.ts
    core/
      save-decoder.ts
      save-parser.ts
      semantic.ts
      items.ts
      status.ts
      types.ts
    data/
      main.json
      essentials.json
      completion.json
      wishes.json
      journal.json
      bosses.json
      mini-bosses.json
      scenes.json
```

Recommended responsibility split:

```txt
save-decoder.ts
  decodeSilksongSave()

save-parser.ts
  parseSilksongSave()
  getSaveFileFlags()

items.ts
  load all data/*.json
  collectAllItems()

semantic.ts
  getSaveDataValue()
  mapSaveToSemanticItems()

status.ts
  getUnlocked()
  toSemanticStatus()

cli.ts
  parse argv
  read file from fs
  call core functions
  print JSON/table
```

### Recommended CLI pipeline

A CLI does not need to produce DOM classes. It should output neutral semantic results.

```txt
file path
  -> fs.readFile()
  -> decodeSilksongSave() or JSON.parse()
  -> parseSilksongSave()
  -> getSaveFileFlags()
  -> collectAllItems()
  -> getSaveDataValue() for each item
  -> getUnlocked()
  -> semantic result objects
  -> JSON/table output
```

Recommended output shape:

```ts
{
  id: "mask-shard-2",
  label: "Mask Shard #2",
  category: "Mask Shards",
  section: "Main Progress",
  type: "sceneBool",
  source: {
    scene: "Crawl_02",
    flag: "Heart Piece"
  },
  value: true,
  unlocked: true,
  status: "done"
}
```

Here, `status` should ideally use CLI semantics rather than the website's CSS classes:

```txt
done
accepted
collected
deposited
missing
unobtainable
unknown
```

The webpage's `locked` and `unlocked` states depend on the spoiler setting and belong to the presentation layer. A CLI is usually better served by outputting `missing` or `unknown`.

### Recommended dependencies

The minimum dependencies can be:

```txt
crypto-js
zod
typescript
tsx or tsup
```

The original project uses `complete-common`. A new CLI can keep using it, or reimplement the small helper subset it needs:

```txt
isObject()
isArray()
assertString()
assertObject()
```

If reducing external dependencies is a goal, implementing those helpers locally is more direct.

### Why rewriting the mapping is not recommended

It is not recommended to rewrite the full `.dat -> semantic item` logic from scratch, because:

- The decode format, save schema, scene flags, `savedData[]`, journal, quest, relic, and related structures all have small but important differences.
- `src/data/*.json` already encodes a large amount of manually curated mapping from flags to user semantics.
- If the CLI maintains a second mapping, the website and the CLI can easily diverge.
- If a future fix changes an item's `flag`, `scene`, or `required`, sharing one data source makes synchronization much easier.

The safer approach is:

```txt
copy or extract the core logic
  -> keep data/*.json and mapping rules aligned
  -> add only file reading and output formatting in the CLI
```

### Licensing note

If code or data is copied from the original project, its license should be checked and followed. The current repository's `package.json` marks the project as `MIT`, which usually allows reuse, modification, and redistribution, but the necessary copyright and license attribution should still be preserved.

## 18. Summary

Semantic mapping in Silksong Git does not eagerly convert the raw save JSON into one new fully semantic object. Instead, each item is interpreted on demand at render time:

```txt
raw save value + item definition -> item state -> UI state
```

Specifically:

- The raw save value comes from the game's internal data after `.dat` decoding.
- The item definition comes from `src/data/*.json`.
- The item state is computed by `getSaveDataValue()`.
- The UI state is computed by `getUnlocked()` and `renderGenericGrid()`.

So, when adding or correcting semantic mapping for an item, the usual two places to check are:

1. Whether that item's `type`, `flag`, `scene`, and `required` are correct in `src/data/*.json`.
2. Whether `getSaveDataValue()` in `src/save-data.ts` supports that raw save structure.
