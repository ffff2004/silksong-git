export interface ReadModelCursor {
  readonly afterObservationSequence: number;
  readonly eventIndex: number;
}

export function parseCursor(cursor: string | undefined): ReadModelCursor {
  if (cursor === undefined) {
    return {
      afterObservationSequence: 0,
      eventIndex: -1,
    };
  }

  const [afterObservationSequence, eventIndex] = cursor.split(":").map(Number);

  if (
    afterObservationSequence === undefined
    || eventIndex === undefined
    || Number.isNaN(afterObservationSequence)
    || Number.isNaN(eventIndex)
  ) {
    throw new Error("Invalid history cursor.");
  }

  return {
    afterObservationSequence,
    eventIndex,
  };
}

export function createCursor(cursor: ReadModelCursor): string {
  return `${cursor.afterObservationSequence}:${cursor.eventIndex}`;
}
