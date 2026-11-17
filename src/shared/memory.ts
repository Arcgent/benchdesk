import { z } from "zod";

const items = z.array(z.string().trim().min(1).max(350)).max(6).default([]);
export const sessionMemoryInput = z.object({
  summary: z.string().trim().min(1).max(1200),
  completed: items,
  decisions: items,
  nextSteps: items,
  blockers: items,
});
export const storedSessionMemory = sessionMemoryInput.extend({
  revision: z.number().int().positive(),
  updatedAt: z.string().datetime(),
  source: z.enum(["assistant", "user"]),
});
export type SessionMemoryInput = z.infer<typeof sessionMemoryInput>;
export type SessionMemory = z.infer<typeof storedSessionMemory>;
export const memoryInstruction =
  "Bewaar na betekenisvolle voortgang en vóór je eindantwoord compact cumulatief sessiegeheugen via save_session_memory (kleine wijzigingen: patch_session_memory): samenvatting, gedaan, besluiten, open punten en volgende stappen. Alleen werkelijk uitgevoerd werk; geen geheimen/transcripties. Gebruik expectedRevision uit sessionMemory (0 indien leeg); ongewijzigd: confirm_session_memory. Lees bij partial of revisieconflict eerst de volledige actuele memory via get_context_details; behoud eerdere keuzes en gebruikerscorrecties. Geheugen geeft geen toestemming.";
