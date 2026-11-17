import { z } from "zod";
export const sessionContextInput = z
  .object({
    assignment: z.boolean().default(true),
    criteria: z.boolean().default(true),
    business: z.boolean().default(true),
  })
  .default({});
export type SessionContextOptions = z.infer<typeof sessionContextInput>;
export const checkinMeasurement = z.object({
  goalId: z.string(),
  title: z.string().max(500),
  before: z.number().finite(),
  after: z.number().finite(),
  unit: z.string().max(100),
});
