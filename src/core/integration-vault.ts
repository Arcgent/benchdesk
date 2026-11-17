import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";

// The wrapping key is supplied by Electron after OS-backed safeStorage decryption.
// Neither the key nor tokens are written to session files, preferences or backups.
export class IntegrationVault<T> {
  private key?: Buffer;
  private data?: T;
  constructor(
    private path: string,
    private initial: () => T,
  ) {}
  get unlocked() {
    return !!this.key;
  }
  unlock(encoded: string) {
    if (!/^[a-f0-9]{64}$/.test(encoded))
      throw new Error("Ongeldige integratiesleutel.");
    const key = Buffer.from(encoded, "hex");
    if (this.key) {
      if (!timingSafeEqual(key, this.key))
        throw new Error(
          "Integratiekluis is al ontgrendeld met een andere sleutel.",
        );
      return;
    }
    let data: T;
    if (existsSync(this.path)) {
      try {
        const envelope = JSON.parse(readFileSync(this.path, "utf8"));
        if (envelope.version !== 1) throw new Error("version");
        const decipher = createDecipheriv(
          "aes-256-gcm",
          key,
          Buffer.from(envelope.iv, "base64"),
        );
        decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
        data = JSON.parse(
          Buffer.concat([
            decipher.update(Buffer.from(envelope.data, "base64")),
            decipher.final(),
          ]).toString("utf8"),
        );
      } catch {
        throw new Error(
          "De integratiekluis kan niet worden geopend. De bestaande gegevens zijn behouden.",
        );
      }
    } else data = this.initial();
    this.data = data;
    this.key = key;
  }
  get value(): T {
    if (!this.data || !this.key)
      throw new Error(
        "Open Koppelingen in de desktop-app om de beveiligde opslag te ontgrendelen.",
      );
    return this.data;
  }
  save() {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key!, iv);
    const data = Buffer.concat([
      cipher.update(JSON.stringify(this.value)),
      cipher.final(),
    ]);
    writeFileSync(
      this.path + ".tmp",
      JSON.stringify({
        version: 1,
        iv: iv.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
        data: data.toString("base64"),
      }),
      { mode: 0o600 },
    );
    renameSync(this.path + ".tmp", this.path);
  }
}
