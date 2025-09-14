
export function deepMerge<T>(base: T, patch: Partial<T>): T {
  if (patch === null || patch === undefined) return base;
  if (typeof base !== "object" || typeof patch !== "object") return (patch as T) ?? base;
  const out: any = Array.isArray(base) ? [...(base as any)] : {...(base as any)};
  for (const [k, v] of Object.entries(patch as any)) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      (out as any)[k] = deepMerge((out as any)[k] ?? {}, v as any);
    } else {
      (out as any)[k] = v;
    }
  }
  return out as T;
}
