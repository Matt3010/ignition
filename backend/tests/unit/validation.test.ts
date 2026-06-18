import { roadContextRequestSchema } from "../../src/http/schemas/road-context.schema.js";
import { validPayload } from "../fixtures/config.js";

describe("road context request validation", () => {
  it("accepts a valid payload", () => {
    expect(roadContextRequestSchema.parse(validPayload)).toEqual(validPayload);
  });

  it("rejects invalid latitude and uuid", () => {
    const result = roadContextRequestSchema.safeParse({
      ...validPayload,
      latitude: 120,
      sessionId: "not-a-uuid",
    });
    expect(result.success).toBe(false);
  });

  it("rejects negative speed and invalid course", () => {
    const result = roadContextRequestSchema.safeParse({
      ...validPayload,
      speedKmh: -1,
      course: 361,
    });
    expect(result.success).toBe(false);
  });
});
