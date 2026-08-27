/* Local executors for the fixed set of bridge actions. */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatForArtwork } from "@absolutejs/commerce-machines";
import {
  base64ToBytes,
  type BridgeAction,
  type BridgeJob,
  type SendResult,
} from "@absolutejs/commerce-machines/bridge";
import {
  createTransports,
  safeFilename,
  sendRawTcp,
  writeToFolder,
  DEFAULT_RAW_TCP_PORT,
  type MachineTransports,
} from "@absolutejs/commerce-machines/transports";
import type { MachineExport } from "@absolutejs/commerce-machines";
import { bunSpawner, isWindows, powershell, type Spawner } from "./printers";

export type ExecutorOptions = {
  spawn?: Spawner;
  transports?: MachineTransports;
  /** Raw TCP timeout in ms (default 10 000). */
  timeoutMs?: number;
  /** Override platform detection (tests). */
  windows?: boolean;
};

const TEXT_FORMATS = new Set(["zpl", "epl", "tspl"]);

export const toMachineExports = (job: BridgeJob): MachineExport[] =>
  job.files.map((file) => ({
    bytes: base64ToBytes(file.bytesBase64),
    filename: safeFilename(file.filename),
    format: formatForArtwork(file.mime, file.filename) ?? "pdf",
    mime: file.mime,
  }));

const fail = (error: string): SendResult => ({ error, ok: false });

/** Write files to a temp dir and run one OS print command per file. */
export const osPrint = async (
  files: MachineExport[],
  printer: string,
  spawn: Spawner,
  windows: boolean,
): Promise<SendResult> => {
  if (printer.trim().length === 0) return fail("printer name is empty");
  const dir = await mkdtemp(join(tmpdir(), "abs-bridge-"));
  try {
    const printed: string[] = [];
    for (const file of files) {
      const path = join(dir, file.filename);
      await Bun.write(path, file.bytes);
      const isText = TEXT_FORMATS.has(file.format);
      const result = windows
        ? await spawn(
            powershell(
              isText
                ? "Get-Content -Raw -LiteralPath $env:ABS_BRIDGE_FILE | Out-Printer -Name $env:ABS_BRIDGE_PRINTER"
                : "Start-Process -FilePath $env:ABS_BRIDGE_FILE -Verb PrintTo -ArgumentList (('\"' + $env:ABS_BRIDGE_PRINTER + '\"')) -Wait",
            ),
            { ABS_BRIDGE_FILE: path, ABS_BRIDGE_PRINTER: printer },
          )
        : await spawn([
            "lp",
            "-d",
            printer,
            ...(isText ? ["-o", "raw"] : []),
            "-t",
            file.filename,
            "--",
            path,
          ]);
      if (result.exitCode !== 0) {
        return fail(
          `print of ${file.filename} on "${printer}" failed (exit ${result.exitCode}): ${(result.stderr || result.stdout).trim()}`,
        );
      }
      printed.push(file.filename);
    }

    return {
      detail: `printed ${printed.join(", ")} on "${printer}"`,
      ok: true,
    };
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
};

/** Execute a single typed action locally. Anything not in `BridgeAction` is rejected. */
export const executeAction = async (
  action: BridgeAction,
  files: MachineExport[],
  reference: string,
  options: ExecutorOptions = {},
): Promise<SendResult> => {
  const spawn = options.spawn ?? bunSpawner;
  const windows = options.windows ?? isWindows();
  switch (action.kind) {
    case "folder":
      return writeToFolder(files, action.path);
    case "raw-tcp": {
      const port = action.port ?? DEFAULT_RAW_TCP_PORT;
      for (const file of files) {
        const result = await sendRawTcp(
          action.host,
          port,
          file.bytes,
          options.timeoutMs,
        );
        if (!result.ok) return fail(`${file.filename}: ${result.error}`);
      }

      return {
        detail: `sent ${files.map((file) => file.filename).join(", ")} to ${action.host}:${port}`,
        ok: true,
      };
    }
    case "ipp": {
      const transports =
        options.transports ??
        createTransports({ timeoutMs: options.timeoutMs });

      return transports.ipp.send(
        files,
        { ...action, transport: "ipp" },
        { reference },
      );
    }
    case "os-print":
      return osPrint(files, action.printer, spawn, windows);
    default:
      return fail(
        `unsupported action ${String((action as { kind: unknown }).kind)}`,
      );
  }
};

export const executeJob = (job: BridgeJob, options: ExecutorOptions = {}) =>
  executeAction(job.action, toMachineExports(job), job.reference, options);
