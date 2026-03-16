import type { RecruitAgentConfig } from "./types.js";
import { sleep } from "./utils.js";

export interface DaemonTask {
  id: string;
  intervalMs: number;
  run: () => Promise<void>;
}

export async function runDaemonLoop(tasks: DaemonTask[], config: RecruitAgentConfig): Promise<void> {
  if (!config.daemon.enabled) {
    throw new Error("daemon.enabled=false，拒绝启动常驻模式");
  }

  const lastRunAt = new Map<string, number>();
  for (;;) {
    const now = Date.now();
    for (const task of tasks) {
      const previous = lastRunAt.get(task.id) ?? 0;
      if (now - previous < task.intervalMs) {
        continue;
      }

      try {
        await task.run();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[daemon] 任务 ${task.id} 失败: ${message}`);
      } finally {
        lastRunAt.set(task.id, Date.now());
      }
    }

    await sleep(5000);
  }
}
