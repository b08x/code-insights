/**
 * Normalizes JSON Schema for OpenAI Structured Outputs (`strict: true`).
 *
 * OpenAI enforces two strict constraints on JSON Schema:
 * 1. All objects with `properties` MUST set `additionalProperties: false`.
 * 2. Every key defined in `properties` MUST be listed in `required`.
 *    To represent an optional property, its schema must accept `null`
 *    (e.g. `type: [existingType, "null"]` or `anyOf: [schema, { type: "null" }]`)
 *    and it must still be included in `required`.
 *
 * This normalizer transforms standard Draft-07 schemas into schemas that
 * OpenAI / Codex Structured Outputs can accept without HTTP 400 errors.
 */

function makeNullable(schema: Record<string, unknown>): Record<string, unknown> {
  const result = { ...schema };

  if (typeof result.type === 'string') {
    if (result.type !== 'null') {
      result.type = [result.type, 'null'];
    }
    return result;
  }

  if (Array.isArray(result.type)) {
    if (!result.type.includes('null')) {
      result.type = [...result.type, 'null'];
    }
    return result;
  }

  if (Array.isArray(result.anyOf)) {
    const hasNull = result.anyOf.some(
      variant => variant && typeof variant === 'object' && (variant as Record<string, unknown>).type === 'null',
    );
    if (!hasNull) {
      result.anyOf = [...result.anyOf, { type: 'null' }];
    }
    return result;
  }

  // If no type or anyOf is present (e.g. $ref, allOf, or untyped), wrap in anyOf with null
  return {
    anyOf: [schema, { type: 'null' }],
  };
}

export function toStrictOpenAiSchema<T extends object>(schema: T): T {
  if (!schema || typeof schema !== 'object') {
    return schema;
  }

  // Deep clone
  const clone = JSON.parse(JSON.stringify(schema)) as Record<string, unknown>;

  function walk(node: unknown): unknown {
    if (!node || typeof node !== 'object') {
      return node;
    }

    if (Array.isArray(node)) {
      return node.map(walk);
    }

    const obj = node as Record<string, unknown>;

    // Process $defs / definitions
    if (obj.$defs && typeof obj.$defs === 'object') {
      obj.$defs = walk(obj.$defs);
    }
    if (obj.definitions && typeof obj.definitions === 'object') {
      obj.definitions = walk(obj.definitions);
    }

    // Process anyOf / oneOf / allOf
    if (Array.isArray(obj.anyOf)) {
      obj.anyOf = obj.anyOf.map(walk);
    }
    if (Array.isArray(obj.oneOf)) {
      obj.oneOf = obj.oneOf.map(walk);
    }
    if (Array.isArray(obj.allOf)) {
      obj.allOf = obj.allOf.map(walk);
    }

    // Process items (array)
    if (obj.items) {
      obj.items = walk(obj.items);
    }

    // Process object properties
    if (obj.properties && typeof obj.properties === 'object' && !Array.isArray(obj.properties)) {
      obj.additionalProperties = false;

      const rawRequired = Array.isArray(obj.required) ? obj.required : [];
      const originalRequired = new Set(rawRequired.filter(r => typeof r === 'string'));
      const props = obj.properties as Record<string, unknown>;
      const allPropKeys = Object.keys(props);

      const updatedProps: Record<string, unknown> = {};

      for (const key of allPropKeys) {
        let propSchema = props[key];
        if (propSchema && typeof propSchema === 'object') {
          // If property was optional (not in original required), make it nullable
          if (!originalRequired.has(key)) {
            propSchema = makeNullable(propSchema as Record<string, unknown>);
          }
          propSchema = walk(propSchema);
        }
        updatedProps[key] = propSchema;
      }

      obj.properties = updatedProps;
      obj.required = allPropKeys;
    }

    return obj;
  }

  return walk(clone) as T;
}
