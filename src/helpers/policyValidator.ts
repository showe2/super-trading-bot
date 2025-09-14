
import fs from "fs";
type Schema = { required?: string[], properties?: Record<string, any> };
export function validatePolicyShape(policy: any, schemaPath: string): {ok: boolean; errors: string[]} {
  const schema: Schema = JSON.parse(fs.readFileSync(schemaPath,"utf-8"));
  const errors: string[] = [];
  if (schema.required) for (const key of schema.required) if (!(key in policy)) errors.push(`Missing required field: ${key}`);
  return { ok: errors.length===0, errors };
}
