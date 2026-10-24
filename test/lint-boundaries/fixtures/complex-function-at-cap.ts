// Fixture: a function of complexity 20 (19 branches plus one), at the complexity cap (DIPO-127).
export function atCap(n: number): number {
  if (n === 1) return 10;
  if (n === 2) return 20;
  if (n === 3) return 30;
  if (n === 4) return 40;
  if (n === 5) return 50;
  if (n === 6) return 60;
  if (n === 7) return 70;
  if (n === 8) return 80;
  if (n === 9) return 90;
  if (n === 10) return 100;
  if (n === 11) return 110;
  if (n === 12) return 120;
  if (n === 13) return 130;
  if (n === 14) return 140;
  if (n === 15) return 150;
  if (n === 16) return 160;
  if (n === 17) return 170;
  if (n === 18) return 180;
  if (n === 19) return 190;
  return 0;
}
