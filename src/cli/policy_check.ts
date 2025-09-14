import "dotenv/config";
import fs from "fs";
import path from "path";
import https from "https";
import http from "http";
import { sha256OfObject, printPolicyBanner } from "../helpers/policyIntegrity";
const localPath = path.join(
  process.cwd(),
  "src",
  "policy",
  "master_config.json"
);
const local = JSON.parse(fs.readFileSync(localPath, "utf-8"));
printPolicyBanner(
  "local",
  local.version || "unknown",
  local.schemaVersion || "unknown",
  sha256OfObject(local)
);
const url = process.env.POLICY_URL || "";
if (!url) {
  console.log("[policy:check] POLICY_URL not set");
  process.exit(0);
}
const h = url.startsWith("https") ? https : http;
h.get(url, (res) => {
  const chunks: Buffer[] = [];
  res.on("data", (d) => chunks.push(d));
  res.on("end", () => {
    const remote = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
    printPolicyBanner(
      "remote",
      remote.version || "unknown",
      remote.schemaVersion || "unknown",
      sha256OfObject(remote)
    );
  });
}).on("error", (e) => console.error(e));
