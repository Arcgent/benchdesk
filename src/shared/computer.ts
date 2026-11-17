export type ComputerStatus = {
  available: boolean;
  version: string | null;
  reason: string;
  configured: boolean;
  sessionVersion: string | null;
};
