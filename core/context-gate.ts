import type { ProjectMemory } from "./project-memory.js";

export interface GatedContext {
  relevantFiles: string[];
  recentTaskSummaries: string[];
  language: string;
}

export function gateContext(memory: ProjectMemory, prompt: string): GatedContext {
  const words = Array.from(
    new Set(
      prompt
        .toLowerCase()
        .split(/\s+/)
        .map(word => word.replace(/[^a-z0-9_-]/g, ""))
        .filter(word => word.length >= 4)
    )
  );

  const relevantFiles = words.length === 0
    ? []
    : memory.recentFiles.filter(path => {
        const normalizedPath = path.toLowerCase();
        return words.some(word => normalizedPath.includes(word));
      });

  const recentTaskSummaries = memory.recentTasks
    .slice(0, 3)
    .map(task => task.prompt.slice(0, 120));

  return {
    relevantFiles,
    recentTaskSummaries,
    language: memory.language,
  };
}
