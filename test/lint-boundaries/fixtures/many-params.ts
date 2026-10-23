// Fixture: a function with 6 parameters, over the max-params cap of 5 (DIPO-127).
export function tooMany(a: number, b: number, c: number, d: number, e: number, f: number): number {
  return a + b + c + d + e + f;
}
