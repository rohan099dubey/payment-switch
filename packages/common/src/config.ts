import type { z } from 'zod';

export class ConfigError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(`Invalid configuration:\n${issues.map((issue) => `  - ${issue}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

/**
 * Parses environment variables through a zod schema. Throws a `ConfigError` listing
 * every problem at once, so a misconfigured service refuses to start with a readable
 * message instead of failing later on first use.
 */
export function loadConfig<S extends z.ZodType>(schema: S, env: NodeJS.ProcessEnv = process.env): z.output<S> {
  const result = schema.safeParse(env);
  if (!result.success) {
    throw new ConfigError(
      result.error.issues.map((issue) => {
        const path = issue.path.map(String).join('.');
        return path === '' ? issue.message : `${path}: ${issue.message}`;
      }),
    );
  }
  return result.data;
}
