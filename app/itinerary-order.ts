export function reorderIdsForInsertion(
  ids: readonly string[],
  draggedId: string,
  insertionIndex: number,
) {
  const draggedIndex = ids.indexOf(draggedId);
  if (draggedIndex < 0) return [...ids];

  const next = ids.filter((_, index) => index !== draggedIndex);
  const safeInsertionIndex = Math.max(0, Math.min(next.length, insertionIndex));
  next.splice(safeInsertionIndex, 0, draggedId);
  return next;
}

export function sameIdOrder(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}
