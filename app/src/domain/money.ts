// Integer-cents formatting; avoids floating-point division so large amounts round exactly.
export function formatUsd(cents: number): string {
  const dollars = Math.floor(cents / 100);
  const remainder = (cents % 100).toString().padStart(2, '0');
  return `$${dollars.toLocaleString('en-US')}.${remainder}`;
}
