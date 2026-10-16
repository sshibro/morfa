import {useCallback, useEffect, useState} from 'react';
import type {DesignTeamSummary} from '../../../shared/design/teams';
import {listDesignTeams} from './api';

export type TeamsState = {
  /** null until the first answer (or when the list could not be read: the browser shows personal files only). */
  teams: DesignTeamSummary[] | null;
  error: unknown;
};

/** The caller's teams (GET /api/design-teams), refreshed on demand and changed in place after a write answers. */
export function useDesignTeams() {
  const [state, setState] = useState<TeamsState>({teams: null, error: null});
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    listDesignTeams(controller.signal).then(
      answer => !controller.signal.aborted && setState({teams: answer.teams, error: null}),
      error => !controller.signal.aborted && setState(current => ({teams: current.teams, error})),
    );
    return () => controller.abort();
  }, [revision]);
  const refresh = useCallback(() => setRevision(value => value + 1), []);
  /** Reads the list now and resolves once it is in place (a view about to show a team the list does not hold yet waits for it). */
  const reload = useCallback(async () => {
    try {
      const answer = await listDesignTeams();
      setState({teams: answer.teams, error: null});
    } catch (error) {
      setState(current => ({teams: current.teams, error}));
    }
  }, []);
  /** Puts one team as the server answered it (or adds it). */
  const put = useCallback((team: DesignTeamSummary) => {
    setState(current => {
      const teams = current.teams ?? [];
      return {...current, teams: teams.some(entry => entry.id === team.id) ? teams.map(entry => (entry.id === team.id ? team : entry)) : [...teams, team]};
    });
  }, []);
  const remove = useCallback((teamId: string) => {
    setState(current => ({...current, teams: (current.teams ?? []).filter(entry => entry.id !== teamId)}));
  }, []);
  return {...state, refresh, reload, put, remove};
}
