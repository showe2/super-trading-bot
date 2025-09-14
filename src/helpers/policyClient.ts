
import fs from "fs";
import path from "path";
import http from "http";
import https from "https";
import { deepMerge } from "./merge";
import { sha256OfObject, printPolicyBanner } from "./policyIntegrity";
import { validatePolicyShape } from "./policyValidator";

const root = process.cwd();
const LOCAL_POLICY_PATH = path.join(root, "src", "policy", "master_config.json");
const LOCAL_BOT_DEFAULTS = path.join(root, "config", "config.json");
const LOCAL_OVERRIDES = path.join(root, "config", "config.local.json");

function fetchUrl(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = url.startsWith("https") ? https : http;
    const req = h.get(url, (res) => {
      if (res.statusCode && res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}`));
      const chunks: Buffer[] = [];
      res.on("data", d => chunks.push(d));
      res.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    });
    req.on("error", reject);
  });
}

export async function loadPolicy(): Promise<any> {
  const url = process.env.POLICY_URL || "";
  let policy: any = null;
  try {
    if (url) {
      if (url.startsWith("file://")) policy = JSON.parse(fs.readFileSync(url.replace("file://",""), "utf-8"));
      else if (url.startsWith("http")) policy = JSON.parse(await fetchUrl(url));
    }
  } catch (e) { /* ignore and fallback */ }
  if (!policy) policy = JSON.parse(fs.readFileSync(LOCAL_POLICY_PATH, "utf-8"));

  let result = policy;
  if (fs.existsSync(LOCAL_BOT_DEFAULTS)) result = deepMerge(result, JSON.parse(fs.readFileSync(LOCAL_BOT_DEFAULTS, "utf-8")));
  if (fs.existsSync(LOCAL_OVERRIDES))    result = deepMerge(result, JSON.parse(fs.readFileSync(LOCAL_OVERRIDES, "utf-8")));
  const fp = sha256OfObject(result); const v = result.version || "unknown"; const sv = result.schemaVersion || "unknown";
  validatePolicyShape(result, path.join(root,"src","policy","schema.json"));
  printPolicyBanner("local", v, sv, fp);
  return result;
}
export async function loadPolicyWithIntegrity(){ return loadPolicy(); }
