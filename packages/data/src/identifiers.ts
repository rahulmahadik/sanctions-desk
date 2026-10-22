import type { ListIdentifierRow } from "./model.js";

/**
 * Map the free-text name of an identity document ("Passport", "Tax ID No.", "Registration ID", ...)
 * to one of our identifier types. Anything not recognised is "other"; the original name is kept in
 * the row's note.
 */
export function docTypeToIdType(name: string): ListIdentifierRow["id_type"] {
  const n = name.toLowerCase();
  if (/passport|travel document/.test(n)) return "passport";
  if (/driver/.test(n)) return "drivers_license";
  if (/mmsi|vessel registration/.test(n)) return "vessel_imo";
  if (/aircraft/.test(n)) return "aircraft_id";
  if (
    /tax|vat|v\.a\.t|fein|fiscal|\bnit\b|\bruc\b|\brfc\b|r\.f\.c|cuit|c\.u\.i\.t|\bnif\b|n\.i\.f|\brtn\b|nuit|\brif\b|c\.i\.f|c\.u\.i\./.test(
      n,
    )
  )
    return "tax_id";
  if (
    /registration|registry|incorporation|company|business|charity|license|licence|\bc\.r\.|commerce|enterprise|organi[sz]ation code|entity code|legal entity|\ble number|social credit|uscc|gazette|trademark|permit|folio|matricula/.test(
      n,
    )
  )
    return "registration";
  if (
    /national|identification|identity|\bid\b|id card|cedula|d\.n\.i|dni|ssn|curp|c\.u\.r\.p|credencial|i\.f\.e|\bnie\b|n\.i\.e|citizen|residen|immigration|birth certificate|refugee|stateless|personal|tazkira|military|numero de identidad|tarjeta/.test(
      n,
    )
  )
    return "national_id";
  return "other";
}
