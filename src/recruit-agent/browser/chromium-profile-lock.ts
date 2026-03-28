import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import { platform } from "node:os";
import path from "node:path";

/** Chromium 单例锁相关残留（进程异常退出时常遗留，导致下次无法启动） */
const SINGLETON_FILES = ["SingletonLock", "SingletonCookie", "SingletonSocket"] as const;

function errorText(err: unknown): string {
  const parts: string[] = [];
  let e: unknown = err;
  for (let i = 0; i < 6 && e; i += 1) {
    if (e instanceof Error) {
      parts.push(e.message);
      e = e.cause;
    } else {
      parts.push(String(e));
      break;
    }
  }
  return parts.join(" | ");
}

export function isChromiumProfileSingletonError(err: unknown): boolean {
  const msg = errorText(err);
  return (
    msg.includes("SingletonLock") ||
    msg.includes("ProcessSingleton") ||
    (msg.includes("profile directory") && msg.includes("already in use"))
  );
}

/** 删除残留单例文件，便于下一次 launchPersistentContext 成功（勿在仍有浏览器占用同一目录时调用） */
export async function clearStaleChromiumSingletonFiles(userDataDir: string): Promise<void> {
  for (const name of SINGLETON_FILES) {
    const p = path.join(userDataDir, name);
    try {
      await fs.unlink(p);
    } catch {
      // 不存在或无权删则忽略
    }
  }
}

/** 对仍占用单例文件的进程发 SIGTERM（macOS/Linux），便于自动「关掉上次没关的自动化浏览器」 */
function terminatePidsHoldingFiles(filePaths: string[]): void {
  const os = platform();
  if (os !== "darwin" && os !== "linux") {
    return;
  }
  const pids = new Set<number>();
  for (const fp of filePaths) {
    try {
      const out = execFileSync("lsof", ["-t", fp], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      for (const line of out.trim().split(/\n/)) {
        const n = Number(line.trim());
        if (Number.isFinite(n) && n !== process.pid) {
          pids.add(n);
        }
      }
    } catch {
      // 无占用或 lsof 失败
    }
  }
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // 忽略
    }
  }
}

/**
 * 启动持久化 Chromium 前调用：结束仍占用锁文件的进程、再删残留锁。
 * 解决「上次浏览器未关 / 异常退出留下 SingletonLock」导致无法再次启动。
 */
export async function preparePersistentProfileDir(userDataDir: string): Promise<void> {
  const existing: string[] = [];
  for (const name of SINGLETON_FILES) {
    const p = path.join(userDataDir, name);
    try {
      await fs.access(p);
      existing.push(p);
    } catch {
      // 不存在
    }
  }
  if (existing.length > 0) {
    terminatePidsHoldingFiles(existing);
    await new Promise((r) => setTimeout(r, 900));
  }
  await clearStaleChromiumSingletonFiles(userDataDir);
}
