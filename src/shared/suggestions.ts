import { z } from "zod";
import { taskInput } from "./types";

export const nextAction = z.object({
  task: taskInput.omit({ companyId: true }).extend({
    goalId: z.string().min(1),
    status: z.literal("todo").default("todo"),
  }),
  reason: z.string().trim().min(1).max(1000),
  evidence: z.array(z.string().trim().min(1).max(400)).min(1).max(5),
});
export const nextActionsInput = z
  .object({
    summary: z.string().trim().min(1).max(2000),
    actions: z.array(nextAction).length(3),
  })
  .strict();
export const nextActionsPayload = nextActionsInput.extend({
  decisions: z.record(z.enum(["accepted", "dismissed"])).default({}),
  createdTasks: z.record(z.string()).default({}),
});
export type NextAction = z.infer<typeof nextAction>;
export type NextActionsPayload = z.infer<typeof nextActionsPayload>;
