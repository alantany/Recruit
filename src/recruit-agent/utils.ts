import fs from "node:fs/promises";
import path from "node:path";

export function nowIso(): string {
  return new Date().toISOString();
}

export function resolveFromRoot(...parts: string[]): string {
  return path.resolve(process.cwd(), ...parts);
}

export async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function pickText(input: string | undefined | null): string {
  return (input ?? "").replace(/\s+/g, " ").trim();
}

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function randomBetween(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export function extractNumber(input: string | undefined): number | undefined {
  if (!input) {
    return undefined;
  }

  const match = input.match(/(\d+(?:\.\d+)?)/);
  if (!match) {
    return undefined;
  }

  return Number(match[1]);
}

export function includesAny(text: string, keywords: string[]): string[] {
  const normalized = pickText(text).toLowerCase();
  return keywords.filter((keyword) => normalized.includes(keyword.toLowerCase()));
}

export function formatDateKey(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

export function formatHourKey(date = new Date()): string {
  return date.toISOString().slice(0, 13);
}

export function uniqueStrings(values: Array<string | undefined | null>): string[] {
  return [...new Set(values.map((value) => pickText(value)).filter(Boolean))];
}

export function compactLines(input: string): string[] {
  return input
    .split(/[\n,，;；、]/)
    .map((item) => pickText(item))
    .filter(Boolean);
}

export function truncate(input: string, maxLength: number): string {
  const normalized = pickText(input);
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 3)}...`;
}
