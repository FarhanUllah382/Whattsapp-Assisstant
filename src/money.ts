// Financial truth is stored as integer Pakistani paisas. Human/model-facing
// APIs continue to use rupees, with explicit conversion only at boundaries.
export const MINOR_UNITS_PER_RUPEE = 100;

export function rupeesToMinor(value: number, label = 'amount'): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a finite non-negative rupee amount.`);
  }
  const scaled = value * MINOR_UNITS_PER_RUPEE;
  const rounded = Math.round(scaled);
  if (!Number.isSafeInteger(rounded) || Math.abs(scaled - rounded) > 1e-7) {
    throw new Error(`${label} must have at most two decimal places.`);
  }
  return rounded;
}

export function positiveRupeesToMinor(value: number, label = 'amount'): number {
  const minor = rupeesToMinor(value, label);
  if (minor <= 0) throw new Error(`${label} must be greater than 0.`);
  return minor;
}

export function minorToRupees(value: number, label = 'amount_minor'): number {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${label} must be a safe integer number of paisas.`);
  }
  return value / MINOR_UNITS_PER_RUPEE;
}

export function multiplyMinor(unitMinor: number, quantity: number): number {
  if (!Number.isSafeInteger(unitMinor) || unitMinor < 0) {
    throw new Error('Unit price must be a non-negative safe integer number of paisas.');
  }
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new Error('Quantity must be a positive whole number.');
  }
  const total = unitMinor * quantity;
  if (!Number.isSafeInteger(total)) throw new Error('Money total exceeds the safe integer range.');
  return total;
}
