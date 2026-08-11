import packageManifest from "../package.json" with { type: "json" };

export const cliVersion = packageManifest.version;
