// Platform-agnostic environment variable access
// Works with both Node.js (process.env) and Deno (Deno.env) 
export const getEnv = (key: string): string | undefined => {
  if (typeof process !== "undefined" && process.env) return process.env[key];
  if (typeof Deno !== "undefined" && Deno.env) return Deno.env.get(key);
  return undefined;
};
