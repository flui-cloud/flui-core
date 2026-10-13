/** Scaleway Instances need a zone; a bare region such as 'nl-ams' means its first zone. */
export function toScalewayZone(location: string | undefined): string {
  const raw = location || 'fr-par-1';
  return /^[a-z]{2}-[a-z]{3}$/.test(raw) ? `${raw}-1` : raw;
}
