import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { AppEvent, WerkAPI } from "../shared/types";
const api: WerkAPI = {
  call: (method, params) => ipcRenderer.invoke("werk:call", method, params),
  onEvent: (callback) => {
    const handler = (_: unknown, event: AppEvent) => callback(event);
    ipcRenderer.on("werk:event", handler);
    return () => ipcRenderer.removeListener("werk:event", handler);
  },
  selectFolder: () => ipcRenderer.invoke("werk:folder"),
  selectFiles: () => ipcRenderer.invoke("werk:files"),
  pathForFile: (file) => webUtils.getPathForFile(file),
  clipboardFiles: () => ipcRenderer.invoke("werk:clipboard-files"),
  openPath: (path) => ipcRenderer.invoke("werk:open", path),
  preview: (path) => ipcRenderer.invoke("werk:preview", path),
  backup: () => ipcRenderer.invoke("werk:backup"),
  restore: () => ipcRenderer.invoke("werk:restore"),
};
contextBridge.exposeInMainWorld("werk", api);
