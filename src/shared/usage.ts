export type UsageWindow = {
  id: string;
  label: string;
  usedPercent: number;
  resetsAt: string | null;
};
export type AccountUsage = {
  accountId: string;
  state: "available" | "unavailable" | "stale";
  windows: UsageWindow[];
  checkedAt: string;
  updatedAt: string | null;
  message: string;
  plan?: string;
  blocked?: boolean;
};
