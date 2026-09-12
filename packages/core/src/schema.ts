/**
 * JSON-schema sanitization for tool definitions.
 *
 * VS Code tools may carry $ref/$defs/$id/$schema keys that some
 * upstream APIs reject. This flattens to a minimal { type, properties, required } shape.
 */

/** Check if value is a plain object */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Resolve a JSON pointer like "#/definitions/Foo" within the root schema */
function resolveJsonPointer(root: Record<string, unknown>, pointer: string): unknown {
  if (!pointer.startsWith("#/")) return undefined;
  const parts = pointer.slice(2).split("/");
  let current: unknown = root;
  for (const part of parts) {
    if (!isRecord(current)) return undefined;
    current = current[part];
  }
  return current;
}

/** Sanitize a JSON Schema node into a minimal safe shape */
function sanitizeNode(
  value: unknown,
  root: Record<string, unknown>,
  seenRefs: Set<string>,
  visiting: WeakSet<object>
): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeNode(item, root, seenRefs, visiting));
  }
  if (!isRecord(value)) return value;

  // Cycle guard
  if (visiting.has(value)) return {};
  visiting.add(value);

  try {
    // Resolve $ref
    const ref = typeof value.$ref === "string" ? value.$ref : undefined;
    if (ref?.startsWith("#/") && !seenRefs.has(ref)) {
      seenRefs.add(ref);
      const target = resolveJsonPointer(root, ref);
      if (target !== undefined) {
        return sanitizeNode(target, root, seenRefs, visiting);
      }
    }

    // Sanitize properties
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      if (key === "$ref" || key === "$defs" || key === "$id" || key === "$schema") continue;
      result[key] = sanitizeNode(val, root, seenRefs, visiting);
    }
    return result;
  } finally {
    visiting.delete(value);
  }
}

/**
 * Clean a tool's inputSchema for API consumption.
 * Removes $ref, $defs, $id, $schema and resolves references.
 */
export function sanitizeToolSchema(schema: unknown): Record<string, unknown> {
  const root = isRecord(schema) ? schema : { type: "object", properties: {} };
  const sanitized = sanitizeNode(root, root, new Set(), new WeakSet());
  if (!isRecord(sanitized)) return { type: "object", properties: {} };
  return {
    type: "object",
    properties: isRecord(sanitized.properties) ? sanitized.properties : {},
    ...(Array.isArray(sanitized.required) ? { required: sanitized.required } : {}),
    ...(Array.isArray(sanitized.enum) ? { enum: sanitized.enum } : {}),
  };
}
