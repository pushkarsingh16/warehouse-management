export class AppError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
export function allocate(items, balances) {
  const allocations = [];
  for (const item of items) {
    let remaining = item.quantity;
    for (const balance of balances.filter(b => String(b.productId) === item.productId)) {
      const quantity = Math.min(remaining, balance.onHand - balance.reserved);
      if (quantity > 0) allocations.push({ balanceId: balance._id, productId: balance.productId, binId: balance.binId, quantity });
      remaining -= quantity;
      if (remaining === 0) break;
    }
    if (remaining > 0) return null;
  }
  return allocations;
}
export function requireTransition(current, expected) {
  if (current !== expected) throw new AppError(409, 'INVALID_STATE', `Expected ${expected}, received ${current}.`);
}
