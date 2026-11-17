import { _electron as electron } from "playwright";
import { writeFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
const root = await mkdtemp(join(tmpdir(), "benchdesk-icon-"));
const output = resolve("build");
await mkdir(output, { recursive: true });
// The app icon uses the same status-dot monogram as the current light/dark
// product logo. Keep it as vector geometry so every ICNS size stays crisp.
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <rect x="64" y="64" width="896" height="896" rx="205" fill="#1c1c1a"/>
  <g transform="translate(247 166) scale(5.4)">
    <rect x="0" y="0" width="26" height="82" fill="#f4f3ef"/>
    <circle cx="50" cy="81" r="47" fill="#f4f3ef"/>
    <circle cx="50" cy="82" r="23" fill="#1c1c1a"/>
    <circle cx="82" cy="14" r="14" fill="#5cd885"/>
  </g>
</svg>`;
await writeFile(join(output, "icon.svg"), svg);
const main = join(root, "main.cjs");
await writeFile(
  main,
  `const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(root, "profile"))});app.whenReady().then(()=>{new BrowserWindow({show:false,width:1024,height:1024}).loadURL('about:blank');});`,
);
const app = await electron.launch({
  args: [main],
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "" },
});
try {
  const page = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(1024, 1024),
  );
  await page.setContent(
    `<html><head><style>html,body{margin:0;background:transparent;overflow:hidden}</style></head><body>${svg}</body></html>`,
  );
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: join(output, "icon.png"),
    omitBackground: true,
    scale: "css",
  });
} finally {
  await app.close();
  await rm(root, { recursive: true, force: true });
}
const iconset = join(output, "icon.iconset");
await mkdir(iconset, { recursive: true });
for (const size of [16, 32, 128, 256, 512])
  for (const scale of [1, 2])
    await promisify(execFile)("sips", [
      "-z",
      String(size * scale),
      String(size * scale),
      join(output, "icon.png"),
      "--out",
      join(iconset, `icon_${size}x${size}${scale === 2 ? "@2x" : ""}.png`),
    ]);
await promisify(execFile)("iconutil", [
  "-c",
  "icns",
  iconset,
  "-o",
  join(output, "icon.icns"),
]);
console.log(
  "Benchdesk app icon generated from the status-dot product monogram.",
);
