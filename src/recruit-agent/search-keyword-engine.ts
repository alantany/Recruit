import type { JobDefinition, SearchKeywordPlan } from "./types.js";
import { compactLines, uniqueStrings } from "./utils.js";

export function buildSearchKeywordPlans(job: JobDefinition, maxQueries: number): SearchKeywordPlan[] {
  const requirementTerms = compactLines(job.requirements).slice(0, 6);
  const responsibilityTerms = compactLines(job.responsibilities).slice(0, 4);
  const keywordPool = uniqueStrings([job.title, ...job.cityNames, ...job.keywords, ...requirementTerms, ...responsibilityTerms]);
  const plans: SearchKeywordPlan[] = [];

  const combinations = [
    [job.title, job.cityNames[0]],
    [job.title, keywordPool[0]],
    [job.title, keywordPool[1]],
    [keywordPool[0], keywordPool[1], job.cityNames[0]],
    [keywordPool[0], keywordPool[2]],
  ];

  for (let index = 0; index < combinations.length; index += 1) {
    const values = combinations[index]?.filter(Boolean) ?? [];
    const keyword = uniqueStrings(values).join(" ");
    if (!keyword) {
      continue;
    }

    plans.push({
      keyword,
      excludes: ["兼职", "销售", "助理"].filter((item) => !keyword.includes(item)),
      priority: combinations.length - index,
      why: index === 0 ? "岗位名加城市优先" : "岗位名结合 JD 关键词扩展",
    });
  }

  return plans.slice(0, maxQueries);
}
