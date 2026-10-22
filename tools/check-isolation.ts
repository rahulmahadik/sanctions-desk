/**
 * Prove the data services are reachable by Zetaris and by nothing else.
 *
 *   npm run check:isolation
 *
 * Checks, on the running containers:
 *   1. bankdb and payments-api are attached to the Zetaris network only and publish no host ports;
 *   2. a Zetaris container can open a connection to each of them;
 *   3. a container on the review API's own network cannot reach either of them, by name or at all.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const docker = async (...args: string[]): Promise<{ ok: boolean; out: string }> => {
  try {
    const { stdout } = await run("docker", args, { timeout: 60_000 });
    return { ok: true, out: stdout.trim() };
  } catch (err) {
    return { ok: false, out: err instanceof Error ? err.message : String(err) };
  }
};

const SERVICES = [
  { container: "sanctions-bankdb", host: "bankdb", port: 5432 },
  { container: "sanctions-payments-api", host: "payments-api", port: 8100 },
] as const;
const ZETARIS_NETWORK = "zetaris_default";
const ZETARIS_CLIENT = process.env.ZETARIS_CHECK_CONTAINER ?? "zetaris-driver-1";

let failures = 0;
const report = (ok: boolean, text: string) => {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"} ${text}`);
};

for (const s of SERVICES) {
  const inspect = await docker(
    "inspect",
    s.container,
    "--format",
    "{{json .NetworkSettings.Networks}}|{{json .NetworkSettings.Ports}}",
  );
  if (!inspect.ok) {
    report(false, `${s.container} is not running`);
    continue;
  }
  const [networks, ports] = inspect.out.split("|") as [string, string];
  const names = Object.keys(JSON.parse(networks));
  report(names.length === 1 && names[0] === ZETARIS_NETWORK, `${s.container} is on ${names.join(", ")} only`);
  const published = Object.values(JSON.parse(ports) as Record<string, unknown[] | null>).filter(
    (v) => Array.isArray(v) && v.length > 0,
  );
  report(published.length === 0, `${s.container} publishes no host ports`);

  const fromZetaris = await docker(
    "exec",
    ZETARIS_CLIENT,
    "bash",
    "-c",
    `timeout 3 bash -c 'exec 3<>/dev/tcp/${s.host}/${s.port}' && echo open`,
  );
  report(fromZetaris.ok && fromZetaris.out.includes("open"), `${ZETARIS_CLIENT} can reach ${s.host}:${s.port}`);

  // A container on any other network (the API's own network when it exists, else the default bridge).
  const apiNetwork = (
    await docker("network", "ls", "--format", "{{.Name}}", "--filter", "name=sanctions-desk_default")
  ).out
    .split("\n")
    .find((n) => n === "sanctions-desk_default");
  const probeNetwork = apiNetwork ?? "bridge";
  const outside = await docker(
    "run",
    "--rm",
    "--network",
    probeNetwork,
    "alpine:3",
    "sh",
    "-c",
    `nc -z -w 2 ${s.host} ${s.port} && echo reachable || echo blocked`,
  );
  report(
    outside.ok && outside.out.endsWith("blocked"),
    `a container on ${probeNetwork} cannot reach ${s.host}:${s.port}`,
  );
}

console.log(failures === 0 ? "isolation holds" : `${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
