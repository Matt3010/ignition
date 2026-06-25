import { z } from "zod";
import { alertTypes } from "../../domain/models/alert.js";

const isoDateSchema = z
  .string()
  .datetime({ offset: true })
  .refine((value) => !Number.isNaN(Date.parse(value)), "timestamp must be ISO 8601");

export const roadContextRequestSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  speedKmh: z.number().min(0),
  course: z.number().min(0).max(360).nullable(),
  horizontalAccuracyMeters: z.number().positive(),
  timestamp: isoDateSchema,
  sessionId: z.string().uuid(),
});

const roadAlertResponseSchema = z.object({
  id: z.string(),
  type: z.enum(alertTypes),
  subtype: z.string().nullable(),
  capabilities: z.array(z.string()),
  primaryCapability: z.string().nullable(),
  distanceMeters: z.number().min(0),
  speedLimitKmh: z.number().int().positive().nullable(),
  speedLimitSource: z.enum(["explicit", "implicit", "unknown"]),
  latitude: z.number(),
  longitude: z.number(),
  direction: z.enum(["forward", "backward", "unknown"]),
  confidence: z.number().min(0).max(1),
  operationalStatus: z.enum(["operational", "notOperational", "unknown"]),
  statusReason: z.string().nullable(),
  directionBearings: z.array(z.number().min(0).lt(360)),
  osmPresenceStatus: z.enum(["present", "missingFromLatestImport"]),
  active: z.boolean(),
  positionApproximate: z.boolean(),
  osmType: z.string().nullable(),
  osmId: z.string().nullable(),
  osmRelationId: z.string().nullable(),
  osmTimestamp: z.string().datetime({ offset: true }).nullable(),
});

export const roadContextResponseSchema = z.object({
  matched: z.boolean(),
  matchStatus: z.enum(["matched", "noMatch", "providerUnavailable"]),
  roadId: z.string().nullable(),
  roadName: z.string().nullable(),
  speedLimitKmh: z.number().int().positive().nullable(),
  speedLimitSource: z.enum(["explicit", "implicit", "unknown"]),
  roadType: z.string().nullable(),
  confidence: z.number().min(0).max(1),
  direction: z.enum(["forward", "backward", "unknown"]),
  dataTimestamp: z.string().datetime({ offset: true }),
  alerts: z.array(roadAlertResponseSchema),
  genericAlerts: z.array(roadAlertResponseSchema),
});

export type RoadContextRequest = z.infer<typeof roadContextRequestSchema>;
