// Scripts saved in this browser: your own, examples you opened, and marketplace installs.
import { usePersistentState } from './persist';

export interface SavedScript {
  id: string;
  name: string;
  code: string;
  origin: 'mine' | 'example' | 'market';
  marketId?: string; // id in the marketplace, when published or installed from it
  author?: string;
  updatedAt: number;
}

export const SCRIPTS_KEY = 'hs.scripts';

export function useScriptLibrary() {
  return usePersistentState<SavedScript[]>(SCRIPTS_KEY, []);
}
