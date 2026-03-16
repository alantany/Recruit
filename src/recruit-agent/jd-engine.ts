import type { JobDefinition, RecruitAgentConfig } from "./types.js";
import { compactLines, uniqueStrings } from "./utils.js";

export function normalizeJob(job: JobDefinition, config: RecruitAgentConfig): JobDefinition {
  const seedKeywords = uniqueStrings([
    job.title,
    ...job.cityNames,
    job.requiredEducation,
    ...compactLines(job.requirements).slice(0, 8),
    ...compactLines(job.responsibilities).slice(0, 8),
    ...config.job.mustHaveKeywords,
  ]);

  return {
    ...job,
    companyName: job.companyName || config.job.companyName,
    keywords: seedKeywords.filter((item) => item.length >= 2).slice(0, 20),
  };
}

export function fallbackJob(config: RecruitAgentConfig): JobDefinition {
  return normalizeJob(
    {
      id: config.job.id,
      title: config.job.title,
      cityNames: config.job.cityNames,
      salaryRange: config.job.salaryRange,
      requiredEducation: config.job.requiredEducation,
      minExperienceYears: config.job.minExperienceYears,
      responsibilities: config.job.openingSummary,
      requirements: [
        ...config.job.mustHaveKeywords,
        ...config.job.niceToHaveKeywords,
      ].join("、"),
      companyName: config.job.companyName,
      keywords: [],
      syncedAt: new Date().toISOString(),
    },
    config,
  );
}
