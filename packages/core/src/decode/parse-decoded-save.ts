import { z } from "zod";

import type { ParsedDecodedSave } from "../types.ts";

const saveSchemaVersion = "silksong-save-v1";

const stringSchema = z.string();
const unknownSchema = z.unknown();
const booleanSchema = z.boolean();
const integerSchema = z.int();
const numberSchema = z.number();
const savedDataRecordSchema = z.record(stringSchema, unknownSchema);

const savedDataEntrySchema = z.looseObject({
  Data: savedDataRecordSchema,
  Name: stringSchema,
});
const objectWithSavedDataSchema = z.looseObject({
  savedData: z.array(savedDataEntrySchema),
});

const journalRecordSchema = z.looseObject({
  HasBeenSeen: booleanSchema,
  Kills: integerSchema,
});
const journalEntrySchema = z.looseObject({
  Name: stringSchema,
  Record: journalRecordSchema,
});
const enemyJournalKillDataSchema = z.looseObject({
  list: z.array(journalEntrySchema),
});

const permadeathNumberSchema = z.union([
  z.literal(0),
  z.literal(1),
  z.literal(2),
  z.literal(3),
]);
const permadeathStringSchema = z.union([
  z.literal("Off"),
  z.literal("On"),
  z.literal("Dead"),
]);
const permadeathModeSchema = z
  .union([permadeathNumberSchema, permadeathStringSchema])
  .optional();

const playerDataSchema = z
  .looseObject({
    BallowGivenKey: booleanSchema,
    CollectedDustCageKey: booleanSchema,
    Collectables: objectWithSavedDataSchema,
    completionPercentage: integerSchema,
    EnemyJournalKillData: enemyJournalKillDataSchema,
    geo: integerSchema,
    HasSlabKeyA: booleanSchema,
    HasSlabKeyB: booleanSchema,
    HasSlabKeyC: booleanSchema,
    MateriumCollected: objectWithSavedDataSchema,
    MementosDeposited: objectWithSavedDataSchema,
    MerchantEnclaveSimpleKey: booleanSchema,
    permadeathMode: permadeathModeSchema,
    playTime: numberSchema,
    PurchasedArchitectKey: booleanSchema,
    PurchasedBonebottomFaithToken: booleanSchema,
    QuestCompletionData: objectWithSavedDataSchema,
    Relics: objectWithSavedDataSchema,
    scenesVisited: z.array(stringSchema),
    ShellShards: integerSchema,
    ToolEquips: objectWithSavedDataSchema,
    Tools: objectWithSavedDataSchema,
    collectedWardBossKey: booleanSchema,
    collectedWardKey: booleanSchema,
  })
  .readonly();

const silksongSaveSchema = z
  .looseObject({
    playerData: playerDataSchema,
    sceneData: z.looseObject({}).readonly(),
  })
  .readonly();

export class UnrecognizedSaveSchemaError extends Error {
  public readonly issues: readonly z.core.$ZodIssue[];

  public constructor(
    issues: readonly z.core.$ZodIssue[],
    options?: ErrorOptions,
  ) {
    super(
      "Decoded save does not match a recognized Silksong save schema.",
      options,
    );
    this.name = "UnrecognizedSaveSchemaError";
    this.issues = issues;
  }
}

export function parseDecodedSave(decodedSave: unknown): ParsedDecodedSave {
  const result = silksongSaveSchema.safeParse(decodedSave);

  if (!result.success) {
    throw new UnrecognizedSaveSchemaError(result.error.issues);
  }

  return {
    decodedSave: result.data,
    version: {
      saveSchemaVersion,
    },
  };
}
