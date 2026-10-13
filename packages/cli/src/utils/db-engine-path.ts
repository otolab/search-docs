import * as path from 'path';
import { fileURLToPath } from 'url';

export function resolveDbEngineRoot(): string {
  try {
    const dbEngineModulePath = import.meta.resolve('@search-docs/db-engine');
    const dbEngineModuleFile = fileURLToPath(dbEngineModulePath);
    return path.resolve(path.dirname(dbEngineModuleFile), '..');
  } catch {
    const currentFile = fileURLToPath(import.meta.url);
    return path.resolve(path.dirname(currentFile), '../../../db-engine');
  }
}
