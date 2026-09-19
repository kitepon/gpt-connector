import { execFileSync } from "node:child_process";
import { readWindowsProcesses } from "./windows-codex-parent.js";

export interface RuntimeProcess {
  pid: number; parent_pid: number; command: string; started_identity: string;
}

export function readRuntimeProcesses(): RuntimeProcess[] {
  if (process.platform === "win32") return readWindowsProcesses().map(row => ({ ...row, started_identity: row.started }));
  const text = execFileSync("/bin/ps", ["-axo", "pid=,ppid=,lstart=,command="], {
    encoding: "utf8", env: { ...process.env, LC_ALL: "C" },
  });
  return text.split("\n").flatMap(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.{24})\s+(.*)$/.exec(line);
    return match ? [{ pid: Number(match[1]), parent_pid: Number(match[2]), started_identity: match[3]!, command: match[4]! }] : [];
  });
}
