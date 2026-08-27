/* Discover OS print queues. Every process is spawned with an argv array —
 * nothing is ever interpolated into a shell string. */

export type SpawnResult = { exitCode: number; stdout: string; stderr: string };
export type Spawner = (
  argv: string[],
  env?: Record<string, string>,
) => Promise<SpawnResult>;

export const bunSpawner: Spawner = async (argv, env) => {
  try {
    const proc = Bun.spawn(argv, {
      env: { ...process.env, ...env },
      stderr: "pipe",
      stdout: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    return { exitCode, stderr, stdout };
  } catch (error) {
    return {
      exitCode: 127,
      stderr: error instanceof Error ? error.message : String(error),
      stdout: "",
    };
  }
};

export const isWindows = () => process.platform === "win32";

/** PowerShell invocation that reads its inputs from environment variables. */
export const powershell = (script: string) => [
  "powershell.exe",
  "-NoProfile",
  "-NonInteractive",
  "-Command",
  script,
];

/** Printer names as the OS knows them: `lpstat -p` on Linux/macOS, `Get-Printer` on Windows. */
export const listPrinters = async (
  spawn: Spawner = bunSpawner,
): Promise<string[]> => {
  if (isWindows()) {
    const result = await spawn(
      powershell("Get-Printer | Select-Object -ExpandProperty Name"),
    );
    if (result.exitCode !== 0) return [];

    return result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }
  const result = await spawn(["lpstat", "-p"]);
  if (result.exitCode !== 0) return [];

  return result.stdout.split(/\r?\n/).flatMap((line) => {
    const match = /^printer\s+(\S+)/.exec(line);

    return match?.[1] ? [match[1]] : [];
  });
};
