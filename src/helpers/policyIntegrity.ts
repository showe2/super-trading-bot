
import crypto from "crypto";
export function sha256OfObject(obj: any): string {
  const json = JSON.stringify(obj, Object.keys(obj).sort());
  return crypto.createHash("sha256").update(json).digest("hex");
}
export function printPolicyBanner(source: "local"|"remote", version: string, schemaVersion: string, fingerprint: string){
  console.log([
    "================ POLICY =================",
    `source       : ${source}`,
    `version      : ${version}`,
    `schema       : ${schemaVersion}`,
    `fingerprint  : ${fingerprint}`,
    "========================================="
  ].join("\n"));
}
