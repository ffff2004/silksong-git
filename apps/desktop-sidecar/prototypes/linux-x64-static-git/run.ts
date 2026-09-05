import { buildLinuxSidecar } from "./build.ts";
import { prepareStaticGit } from "./prepare-static-git.ts";
import { verifyLinuxSidecar } from "./verify.ts";

const staticGit = await prepareStaticGit();
const built = await buildLinuxSidecar(staticGit);
const evidence = await verifyLinuxSidecar(built);

process.stdout.write(
  `Linux x64 SEA + static-git sidecar prototype passed:\n${JSON.stringify(evidence, undefined, 2)}\n`,
);
