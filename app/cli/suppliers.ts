// The requested vendor IDs in ERP order, or every ID when none is requested; null, after printing the usage,
// when a requested ID is not in the ERP.
export function selectSuppliers(requested: string[], vendorIds: string[], usage: string): string[] | null {
  const unknown = requested.filter((id) => !vendorIds.includes(id));
  if (unknown.length > 0) {
    console.error(`Not in the ERP: ${unknown.join(", ")}. Usage: ${usage}`);
    process.exitCode = 2;
    return null;
  }
  return requested.length === 0 ? vendorIds : vendorIds.filter((id) => requested.includes(id));
}
