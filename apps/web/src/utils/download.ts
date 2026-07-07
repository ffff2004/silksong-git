export function downloadJsonFile(input: {
  readonly filename: string;
  readonly value: unknown;
}): void {
  const blob = new Blob([JSON.stringify(input.value, undefined, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = input.filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
