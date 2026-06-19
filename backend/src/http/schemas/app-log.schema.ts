import { z } from "zod";

const isoDateSchema = z
  .string()
  .datetime({ offset: true })
  .refine((value) => !Number.isNaN(Date.parse(value)), "createdAt must be ISO 8601");

export const appLogRequestSchema = z.object({
  sessionId: z.string().uuid(),
  createdAt: isoDateSchema,
  kind: z.enum(["session_start", "session_stop", "road_context_event", "client_error"]),
  platform: z.literal("ios"),
  appName: z.string().min(1).max(80),
  appVersion: z.string().min(1).max(40).optional(),
  backendBaseURL: z.string().min(1).max(500),
  message: z.string().max(2000).optional(),
  counters: z
    .object({
      sentCount: z.number().int().min(0),
      errorCount: z.number().int().min(0),
      localEventCount: z.number().int().min(0),
    })
    .optional(),
  event: z.unknown().optional(),
});

export const appLogResponseSchema = z.object({
  stored: z.literal(true),
  storedAt: z.string().datetime({ offset: true }),
  file: z.string(),
});

export type AppLogRequest = z.infer<typeof appLogRequestSchema>;
