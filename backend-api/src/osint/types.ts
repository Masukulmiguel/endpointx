export type LookupType = 'ip' | 'domain' | 'email' | 'phone' | 'vin' | 'subdomain' | 'port';

export interface IpInfo {
  country: string;
  countryCode: string;
  region: string;
  regionName: string;
  city: string;
  zip: string;
  lat: number;
  lon: number;
  timezone: string;
  isp: string;
  org: string;
  as: string;
  asname: string;
  reverse: string;
  query: string;
}

export interface DnsRecords {
  a: string[];
  aaaa: string[];
  mx: string[];
  txt: string[];
  ns: string[];
  soa: string[];
  cname: string[];
  ptr: string[];
}

export interface WhoisInfo {
  registrar?: string;
  creationDate?: string;
  expiryDate?: string;
  nameServers: string[];
  status: string[];
  registrantOrg?: string;
  registrantCountry?: string;
  domain?: string;
  ip?: string;
}

export interface SubdomainEntry {
  domain: string;
  source: string;
}

export interface EmailInfo {
  provider: string;
  mxRecords: string[];
  isDisposable: boolean;
  domainAge?: string;
  breaches?: BreachEntry[];
}

export interface BreachEntry {
  name: string;
  breachDate: string;
  dataClasses: string[];
}

export interface PhoneHlr {
  connectivity?: string;
  originalNetwork?: string;
  currentNetwork?: string;
  mccmnc?: string;
  isPorted?: boolean;
  roaming?: boolean;
  countryIso?: string;
}

export interface PhoneReputation {
  displayName?: string;
  category?: string;
  isSpam?: boolean;
}

export interface PhoneInfo {
  valid: boolean;
  countryCode: string;
  country: string;
  carrier?: string;
  lineType?: string;
  numberType?: string;
  e164?: string;
  national?: string;
  prefixOperator?: string;
  prefixType?: string;
  hlr?: PhoneHlr;
  reputation?: PhoneReputation;
  identityName?: string;
}

export interface VinInfo {
  make: string;
  model: string;
  modelYear: string;
  bodyClass: string;
  manufacturer: string;
  plantCountry: string;
  series: string;
  trim: string;
  engineCylinders?: string;
  fuelTypePrimary?: string;
}

export interface ShodanInfo {
  ports: number[];
  hostnames: string[];
  org: string;
  os?: string;
  vulns?: string[];
  ipStr?: string;
}

export interface PortResult {
  port: number;
  state: 'open' | 'closed' | 'filtered';
  service?: string;
  banner?: string;
}

export interface OsintLookupResult {
  type: LookupType;
  target: string;
  timestamp: string;
  sources: string[];
  data: {
    ip?: IpInfo;
    dns?: DnsRecords;
    whois?: WhoisInfo;
    subdomains?: SubdomainEntry[];
    email?: EmailInfo;
    phone?: PhoneInfo;
    vin?: VinInfo;
    shodan?: ShodanInfo;
    ports?: PortResult[];
  };
  errors?: string[];
}

export interface OsintModuleResult<T> {
  success: boolean;
  data?: T;
  error?: string;
  source?: string;
  requiresKey?: boolean;
}
