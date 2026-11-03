/**
 * The paths of keys in a fixture that its schema dropped when parsing. Zod objects strip unknown
 * keys, so a field the contract removed would still parse; walking the fixture and the parsed
 * value together finds it. Arrays and records are compared element by element; a `z.unknown()`
 * value comes back whole, so its keys are all present.
 */
export function staleKeys(input: unknown, parsed: unknown, path = "$"): string[] {
  if (Array.isArray(input)) {
    if (!Array.isArray(parsed)) return [];
    return input.flatMap((value, index) => staleKeys(value, parsed[index], `${path}[${index}]`));
  }
  if (!isObject(input) || !isObject(parsed)) return [];
  return Object.keys(input).flatMap((key) =>
    Object.hasOwn(parsed, key)
      ? staleKeys(input[key], parsed[key], `${path}.${key}`)
      : [`${path}.${key}`],
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
