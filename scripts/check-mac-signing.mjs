import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import assert from "node:assert/strict";

// A linker-signed Electron executable does not bind Benchdesk's Info.plist.
// TCC can then attribute the native helper to an executable path instead of
// the bundle that the user enabled in System Settings.
const bundle = resolve(process.argv[2] || "release/mac-arm64/Benchdesk.app");
const { appId: expected, mac } = JSON.parse(
  readFileSync("package.json", "utf8"),
).build;
execFileSync("codesign", ["--verify", "--deep", "--strict", bundle]);
const details = spawnSync("codesign", ["-dv", "--verbose=2", bundle], {
  encoding: "utf8",
});
assert.equal(details.status, 0, details.stderr);
assert.ok(details.stderr.includes(`Identifier=${expected}\n`), details.stderr);
// An ad-hoc build gets a cdhash-based designated requirement. TCC then treats
// it as a different app than the certificate-signed builds with the same
// bundle id, and the Documents prompt returns after every install.
assert.doesNotMatch(
  details.stderr,
  /Signature=adhoc/,
  "Build is ad-hoc signed",
);
assert.ok(
  details.stderr.includes(`Authority=${mac.identity}\n`),
  `Expected signing identity "${mac.identity}"`,
);
assert.match(details.stderr, /Info.plist entries=/);
assert.match(details.stderr, /Sealed Resources version=/);
assert.equal(
  existsSync(join(bundle, "Contents/Resources/native/benchdesk-computer")),
  false,
  "The replaced physical cursor helper must not be packaged",
);
console.log(`Verified signed bundle ${expected}; no legacy input helper.`);
