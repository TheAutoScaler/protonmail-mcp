const MAX_UIDS_PER_OPERATION = 500;

export function normalizeUids(uids: string[]): string[] {
  if (uids.length === 0 || uids.length > MAX_UIDS_PER_OPERATION) {
    throw new Error(`UID list must contain between 1 and ${MAX_UIDS_PER_OPERATION} entries`);
  }

  const normalized = uids.map(uid => {
    if (!/^[1-9]\d*$/.test(uid)) {
      throw new Error(`Invalid UID: ${uid}`);
    }
    return String(BigInt(uid));
  });

  return [...new Set(normalized)];
}
