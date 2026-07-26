import { buildLinuxSidecar } from "./build.ts";
import { prepareStaticGit } from "./prepare-git.ts";
import { verifyLinuxSidecar } from "./verify.ts";

const staticGit = await prepareStaticGit();
const built = await buildLinuxSidecar(staticGit);
const evidence = await verifyLinuxSidecar(built);

process.stdout.write(
  `Linux sidecar prototype passed:\n${JSON.stringify(evidence, undefined, 2)}\n`,
);
