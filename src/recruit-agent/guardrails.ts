import type { CandidateProfile, RecruitAgentConfig, RecruitAgentState } from "./types.js";
import { getDailyContactCount, getHourlyContactCount } from "./store.js";
import { randomBetween, sleep } from "./utils.js";

export function canContactNow(
  state: RecruitAgentState,
  config: RecruitAgentConfig,
): { ok: true } | { ok: false; reason: string } {
  if (state.consecutiveErrors >= config.guardrails.maxConsecutiveErrors) {
    return {
      ok: false,
      reason: `连续错误达到 ${config.guardrails.maxConsecutiveErrors} 次，已触发自动停机`,
    };
  }

  const daily = getDailyContactCount(state);
  if (daily >= config.guardrails.dailyContactLimit) {
    return {
      ok: false,
      reason: `已触达今日上限 ${config.guardrails.dailyContactLimit}`,
    };
  }

  const hourly = getHourlyContactCount(state);
  if (hourly >= config.guardrails.hourlyContactLimit) {
    return {
      ok: false,
      reason: `已触达小时上限 ${config.guardrails.hourlyContactLimit}`,
    };
  }

  return { ok: true };
}

export function shouldCooldownCandidate(candidate: CandidateProfile, config: RecruitAgentConfig): boolean {
  if (!candidate.lastContactedAt) {
    return false;
  }

  const last = new Date(candidate.lastContactedAt).getTime();
  const cooldownMs = config.guardrails.cooldownHours * 60 * 60 * 1000;
  return Date.now() - last < cooldownMs;
}

export async function applySendDelay(config: RecruitAgentConfig): Promise<number> {
  const delayMs = randomBetween(config.guardrails.minDelayMs, config.guardrails.maxDelayMs);
  await sleep(delayMs);
  return delayMs;
}

export function isDeniedCandidateName(name: string, config: RecruitAgentConfig): boolean {
  const normalized = name.toLowerCase().trim();
  return config.denyList.candidateNames.some((candidateName) => normalized.includes(candidateName.toLowerCase()));
}
