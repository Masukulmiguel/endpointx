import { VinInfo, OsintModuleResult } from './types';
import { cacheGet, cacheSet, TTL } from './cache';

const USER_AGENT = 'EndpointX-OSINT/1.4.0';

export function isValidVin(vin: string): boolean {
  return /^[A-HJ-NPR-Z0-9]{17}$/i.test(vin);
}

export async function lookupVin(vin: string): Promise<OsintModuleResult<VinInfo>> {
  if (!isValidVin(vin)) {
    return { success: false, error: 'Invalid VIN (must be 17 alphanumeric characters, excluding I, O, Q)', source: 'nhtsa' };
  }

  const cacheKey = `vin:${vin.toUpperCase()}`;
  const cached = cacheGet<VinInfo>(cacheKey);
  if (cached) return { success: true, data: cached, source: 'nhtsa (cached)' };

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12_000);
    const resp = await fetch(`https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues/${encodeURIComponent(vin)}?format=json`, {
      signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT },
    });
    clearTimeout(timeout);

    if (!resp.ok) {
      return { success: false, error: `NHTSA returned ${resp.status}`, source: 'nhtsa' };
    }

    const json = await resp.json() as any;
    const results = json.Results?.[0];
    if (!results || results.ErrorText?.includes('Unable to decode')) {
      return { success: false, error: results?.ErrorText || 'VIN not found', source: 'nhtsa' };
    }

    const info: VinInfo = {
      make: results.Make || '',
      model: results.Model || '',
      modelYear: results.ModelYear || '',
      bodyClass: results.BodyClass || '',
      manufacturer: results.Manufacturer || '',
      plantCountry: results.PlantCountry || '',
      series: results.Series || '',
      trim: results.Trim || '',
      engineCylinders: results.EngineCylinders || undefined,
      fuelTypePrimary: results.FuelTypePrimary || undefined,
    };

    cacheSet(cacheKey, info, TTL.VIN);
    return { success: true, data: info, source: 'nhtsa' };
  } catch (error) {
    return { success: false, error: (error as Error).message, source: 'nhtsa' };
  }
}
