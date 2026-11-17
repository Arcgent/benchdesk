import { safeStorage } from "electron";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";

export function integrationKey(dataDir: string) {
  if (
    !safeStorage.isEncryptionAvailable() ||
    (process.platform === "linux" &&
      safeStorage.getSelectedStorageBackend() === "basic_text")
  )
    throw new Error(
      "Beveiligde opslag is niet beschikbaar. Ontgrendel je systeemsleutelhanger en probeer opnieuw.",
    );
  const path = join(dataDir, "integrations.key");
  if (existsSync(path)) {
    try {
      return safeStorage.decryptString(readFileSync(path));
    } catch {
      throw new Error(
        "De integratiesleutel kan niet worden geopend. Ontgrendel je systeemsleutelhanger. De bestaande verbindingen zijn behouden.",
      );
    }
  }
  if (existsSync(join(dataDir, "integrations.vault")))
    throw new Error(
      "De sleutel van je bestaande Gmail-verbindingen ontbreekt. Herstel de oorspronkelijke sleutel om ze te openen.",
    );
  const key = randomBytes(32).toString("hex");
  writeFileSync(path + ".tmp", safeStorage.encryptString(key), { mode: 0o600 });
  renameSync(path + ".tmp", path);
  return key;
}
