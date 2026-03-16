import type { BrowserCandidateSnapshot, JobDefinition, MatchScore, RecruitAgentConfig } from "./types.js";
import { clamp, includesAny, pickText } from "./utils.js";

export function scoreCandidate(
  candidate: BrowserCandidateSnapshot,
  job: JobDefinition,
  config: RecruitAgentConfig,
): MatchScore {
  const positives: string[] = [];
  const negatives: string[] = [];
  const sourceText = [
    candidate.currentCompany,
    candidate.currentTitle,
    candidate.expectedPosition,
    candidate.summary,
    candidate.location,
    candidate.education,
    candidate.school,
    candidate.tags.join(" "),
  ]
    .filter(Boolean)
    .join(" ");

  const excluded = includesAny(sourceText, config.job.excludeKeywords);
  if (excluded.length > 0) {
    return {
      total: 0,
      hardPass: false,
      positives,
      negatives: [`命中过滤词: ${excluded.join("、")}`],
      matchedKeywords: [],
      recommendedAction: "skip",
    };
  }

  let total = 0;
  let hardPass = true;

  const matchedMust = includesAny(sourceText, [...job.keywords, ...config.job.mustHaveKeywords]);
  const matchedNice = includesAny(sourceText, config.job.niceToHaveKeywords);

  if (matchedMust.length === 0) {
    hardPass = false;
    negatives.push("核心关键词未命中");
  } else {
    positives.push(`命中核心关键词 ${matchedMust.join("、")}`);
    total += Math.min(matchedMust.length * 18, 36);
  }

  if (matchedNice.length > 0) {
    positives.push(`命中加分关键词 ${matchedNice.join("、")}`);
    total += Math.min(matchedNice.length * 8, 24);
  }

  if (candidate.location) {
    const matchedCity = includesAny(candidate.location, job.cityNames.length > 0 ? job.cityNames : config.job.cityNames);
    if (matchedCity.length > 0) {
      positives.push(`城市匹配 ${matchedCity.join("、")}`);
      total += 12;
    } else {
      negatives.push(`城市不匹配: ${candidate.location}`);
      total -= 8;
    }
  }

  if (typeof candidate.experienceYears === "number") {
    const requiredYears = job.minExperienceYears ?? config.job.minExperienceYears ?? 0;
    if (candidate.experienceYears >= requiredYears) {
      positives.push(`工作年限满足 ${candidate.experienceYears} 年`);
      total += 14;
    } else {
      negatives.push(`工作年限不足 ${candidate.experienceYears} 年`);
      total -= 14;
    }
  }

  if (job.requiredEducation || config.job.requiredEducation) {
    const requiredEducation = job.requiredEducation ?? config.job.requiredEducation ?? "";
    const educationText = pickText(candidate.education);
    if (educationText.includes(requiredEducation)) {
      positives.push(`学历满足 ${educationText}`);
      total += 8;
    } else if (educationText) {
      negatives.push(`学历不满足 ${educationText}`);
      total -= 10;
    }
  }

  if (candidate.school) {
    const normalizedSchool = pickText(candidate.school).toLowerCase();
    if (config.denyList.schools.some((school) => normalizedSchool.includes(school.toLowerCase()))) {
      hardPass = false;
      negatives.push(`学校在排除名单中: ${candidate.school}`);
    }
  }

  if (candidate.currentCompany) {
    const normalizedCompany = pickText(candidate.currentCompany).toLowerCase();
    if (config.denyList.companies.some((company) => normalizedCompany.includes(company.toLowerCase()))) {
      hardPass = false;
      negatives.push(`公司在排除名单中: ${candidate.currentCompany}`);
    }
  }

  total = clamp(total, 0, 100);

  let recommendedAction: MatchScore["recommendedAction"] = "skip";
  if (!hardPass) {
    recommendedAction = "skip";
  } else if (total >= config.guardrails.autoContactScoreMin) {
    recommendedAction = "contact";
  } else if (total >= config.guardrails.manualReviewScoreMin) {
    recommendedAction = "manual_review";
  }

  return {
    total,
    hardPass,
    positives,
    negatives,
    matchedKeywords: [...matchedMust, ...matchedNice],
    recommendedAction,
  };
}
