import { t as tr } from "../shared/i18n";
import type { AppEvent, WerkAPI } from "../shared/types";

// Electron supplies its own bridge. A browser uses the same API over localhost.
if (!window.werk) {
  const request = async <T>(
    action: string,
    params: unknown = {},
  ): Promise<T> => {
    const response = await fetch(`/api/${action}`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    });
    const value = await response.json();
    if (!response.ok || value.error)
      throw new Error(value.error || tr("Verbinding met Benchdesk mislukt."));
    return value.result;
  };
  const listeners = new Set<(event: AppEvent) => void>();
  let events: EventSource | null = null;
  const api: WerkAPI = {
    call: (method, params) => request("call", { method, params }),
    onEvent(callback) {
      listeners.add(callback);
      if (!events) {
        events = new EventSource("/api/events");
        events.onmessage = (message) => {
          const event = JSON.parse(message.data) as AppEvent;
          for (const listener of listeners) listener(event);
        };
      }
      return () => {
        listeners.delete(callback);
        if (!listeners.size) {
          events?.close();
          events = null;
        }
      };
    },
    selectFolder: () => request("folder"),
    selectFiles: () => request("files"),
    openPath: (path) => request("open", { path }),
    preview: (path) => request("preview", { path }),
    async backup() {
      const data = await request("call", { method: "backup.export" });
      const name = `Benchdesk-backup-${new Date().toISOString().slice(0, 10)}.json`;
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
      );
      const link = Object.assign(document.createElement("a"), {
        href: url,
        download: name,
      });
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      return name;
    },
    restore: () =>
      new Promise((resolve, reject) => {
        const input = Object.assign(document.createElement("input"), {
          type: "file",
          accept: ".json,application/json",
        });
        input.oncancel = () => resolve(false);
        input.onchange = async () => {
          try {
            const file = input.files?.[0];
            if (
              !file ||
              !confirm(
                tr(
                  "Huidige bedrijfsgegevens vervangen? Benchdesk bewaart eerst een kopie. Werkbestanden blijven op hun plek.",
                ),
              )
            )
              return resolve(false);
            if (file.size > 20_000_000)
              throw new Error(tr("De back-up is te groot."));
            await request("call", {
              method: "backup.restore",
              params: { backup: JSON.parse(await file.text()) },
            });
            resolve(true);
          } catch (e) {
            reject(e);
          }
        };
        input.click();
      }),
  };
  window.werk = api;
}
