import { zodToJsonSchema } from "zod-to-json-schema";
import { normalizedErrorSchema } from "./error.schema.js";

export const normalizedErrorJsonSchema = zodToJsonSchema(normalizedErrorSchema);

export function errorResponses<const T extends readonly number[]>(
  ...statuses: T
): Record<T[number], typeof normalizedErrorJsonSchema> {
  return Object.fromEntries(
    statuses.map((status) => [status, normalizedErrorJsonSchema]),
  ) as Record<T[number], typeof normalizedErrorJsonSchema>;
}
