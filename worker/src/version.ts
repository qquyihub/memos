import type { Env } from "./types";

const DEFAULT_APP_VERSION = "26.11.0";

export function getAppVersion(env: Pick<Env, "APP_VERSION">): string {
  return env.APP_VERSION?.trim() || DEFAULT_APP_VERSION;
}
