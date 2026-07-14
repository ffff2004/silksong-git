export function createLocalHistoryUrl(endpoint: string, path: string): string {
  const url = new URL(path, endpoint);
  return url.href;
}

export function getQueryParam(
  search: string,
  name: string,
): string | undefined {
  const params = new URLSearchParams(search);
  const value = params.get(name);
  return value ?? undefined;
}

export function hasQueryParam(search: string, name: string): boolean {
  return getQueryParam(search, name) !== undefined;
}
