import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {findDshRoot} from '../../packages/domain/dsh-path.js';

export const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url))).replace(/[\\/]dist$/, '');
export interface Settings { root: string; dataDir: string; port: number; defaultBudget: number; dshRoot: string; runtimeEnabled: boolean; workerInterval: number; }
export function settings(overrides: Partial<Settings> = {}): Settings {
  return { root: ROOT, dataDir: resolve(ROOT,process.env.DITING_DATA_DIR || 'data'),
    port: Number(process.env.PORT || process.env.DITING_PORT || 8090), defaultBudget: 20,
    dshRoot: findDshRoot(ROOT,process.env.DITING_DSH_ROOT),
    runtimeEnabled: process.env.DITING_RUNTIME_ENABLED === 'true', workerInterval: 1500, ...overrides };
}
