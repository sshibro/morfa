import type {DesignTeamSummary} from '../../../shared/design/teams';
import {matchesSearch} from './format';

// The file browser's search finds projects too (docs/figma-parity-shell.md "Search"), as Figma's results have "Files" and
// "Projects": every project of every team the caller is in whose name or team's name matches, from the teams it already has.

export type ProjectMatch = {teamId: string; teamName: string; projectId: string; name: string};

export function matchProjects(teams: readonly Pick<DesignTeamSummary, 'id' | 'name' | 'projects'>[], query: string, limit = 8): ProjectMatch[] {
  if (!query.trim()) return [];
  const found: ProjectMatch[] = [];
  for (const team of teams)
    for (const project of team.projects)
      if (matchesSearch(project.name, query) || matchesSearch(team.name, query)) found.push({teamId: team.id, teamName: team.name, projectId: project.id, name: project.name});
  // Projects named by the query come before those of a team so named.
  return found.sort((a, b) => Number(matchesSearch(b.name, query)) - Number(matchesSearch(a.name, query))).slice(0, limit);
}
