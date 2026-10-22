import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { promisify } from "node:util";
import { AppError } from "@sanctions-desk/shared";

/**
 * Put list and bank files where the Zetaris file store can read them. The file store is a folder inside
 * the Zetaris containers, so files are written through `docker exec` into the folder of the organisation.
 */

export interface CommandResult {
  stdout: string;
}
export type CommandRunner = (file: string, args: readonly string[], input?: Buffer) => Promise<CommandResult>;

const execFileAsync = promisify(execFile);

export const dockerRunner: CommandRunner = async (file, args, input) => {
  if (input === undefined) {
    const { stdout } = await execFileAsync(file, [...args], { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
    return { stdout };
  }
  return new Promise<CommandResult>((resolve, reject) => {
    const child = execFile(file, [...args], { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) =>
      err ? reject(err) : resolve({ stdout }),
    );
    child.stdin?.end(input);
  });
};

const DATA_ROOT = "/home/zetaris/customer-data";

export interface FileStoreTarget {
  container: string;
  folder: string;
  run?: CommandRunner;
}

/** The organisation folder inside the container: the one that has a file-store directory. */
export async function findFileStoreRoot(target: FileStoreTarget): Promise<string> {
  const run = target.run ?? dockerRunner;
  const script = `for d in ${DATA_ROOT}/*/; do [ -d "\${d}file-store" ] && echo "\${d}file-store"; done; true`;
  const { stdout } = await run("docker", ["exec", target.container, "sh", "-c", script]);
  const roots = stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
  if (roots.length !== 1) {
    throw new AppError(
      "config_missing",
      `expected one file-store folder in ${target.container}, found ${roots.length}`,
      {
        recoverable: true,
      },
    );
  }
  return (roots[0] as string).replace(/\/$/, "");
}

const SAFE_SEGMENT = /^[A-Za-z0-9_.-]+$/;

export interface FileToPlace {
  localPath: string;
  /** Sub-folder under the sanctions folder, e.g. "sanctions_lists". */
  subfolder: string;
}

export interface PlacedFile {
  localPath: string;
  remotePath: string;
  bytes: number;
}

/** Copy files into <file-store>/<folder>/<subfolder>/. Only our own folder is written. */
export async function placeFiles(target: FileStoreTarget, files: readonly FileToPlace[]): Promise<PlacedFile[]> {
  const run = target.run ?? dockerRunner;
  if (!SAFE_SEGMENT.test(target.folder)) throw new AppError("validation", "the file-store folder name is not safe");
  const root = await findFileStoreRoot(target);
  const placed: PlacedFile[] = [];
  for (const file of files) {
    if (!SAFE_SEGMENT.test(file.subfolder)) throw new AppError("validation", `unsafe sub-folder "${file.subfolder}"`);
    const name = basename(file.localPath);
    if (!SAFE_SEGMENT.test(name)) throw new AppError("validation", `unsafe file name "${name}"`);
    const dir = `${root}/${target.folder}/${file.subfolder}`;
    const body = readFileSync(file.localPath);
    await run(
      "docker",
      ["exec", "-i", target.container, "sh", "-c", 'mkdir -p "$1" && cat > "$2"', "sh", dir, `${dir}/${name}`],
      body,
    );
    placed.push({ localPath: file.localPath, remotePath: `${dir}/${name}`, bytes: body.length });
  }
  return placed;
}
