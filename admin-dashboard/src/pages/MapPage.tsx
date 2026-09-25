import React, { useEffect, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { MapContainer, TileLayer, Marker, Popup, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { MapPinned, Smartphone, Monitor } from 'lucide-react';
import { useApi } from '../hooks/useApi';

interface MapDevice {
  id: string;
  hostname: string;
  display_name: string | null;
  os_type: string;
  device_type?: string | null;
  status: string;
  ip_address: string | null;
  last_heartbeat: string | null;
  latitude: number | null;
  longitude: number | null;
  battery_level?: number | null;
  location_updated_at?: string | null;
  approval_status?: string | null;
  geo_source?: 'gps' | 'ip' | null;
}

const statusColor: Record<string, string> = {
  online: '#10b981',
  offline: '#9ca3af',
  alert: '#f59e0b',
  blocked: '#ef4444',
  quarantine: '#8b5cf6',
};

function isMobile(d: MapDevice): boolean {
  const type = (d.device_type || '').toUpperCase();
  if (type === 'MOBILE' || type === 'TABLET') return true;
  const os = (d.os_type || '').toLowerCase();
  return os === 'android' || os === 'ios' || os === 'ipados';
}

function formatTimeAgo(dateStr: string | null): string {
  if (!dateStr) return 'Never';
  const diffMs = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m atrás`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h atrás`;
  return `${Math.floor(hrs / 24)}d atrás`;
}

function deviceIcon(d: MapDevice): L.DivIcon {
  const color = statusColor[d.status] || '#3b82f6';
  const emoji = isMobile(d) ? '📱' : '💻';
  return L.divIcon({
    className: '',
    html: `<div style="width:30px;height:30px;background:${color};border:2px solid #fff;border-radius:50% 50% 50% 0;transform:rotate(-45deg);display:flex;align-items:center;justify-content:center;box-shadow:0 2px 6px rgba(0,0,0,.4)"><span style="transform:rotate(45deg);font-size:14px;line-height:1">${emoji}</span></div>`,
    iconSize: [30, 30],
    iconAnchor: [15, 30],
    popupAnchor: [0, -28],
  });
}

function FitBounds({ positions }: { positions: [number, number][] }) {
  const map = useMap();
  const key = positions.map((p) => `${p[0].toFixed(4)},${p[1].toFixed(4)}`).join('|');
  useEffect(() => {
    if (!key) return;
    if (positions.length === 1) {
      map.setView(positions[0], 13);
    } else {
      map.fitBounds(L.latLngBounds(positions), { padding: [50, 50], maxZoom: 14 });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return null;
}

export default function MapPage() {
  const { data, loading, error } = useApi<{ devices: MapDevice[] }>('/devices/map', {
    refreshInterval: 30000,
  });

  const devices = Array.isArray(data?.devices) ? data.devices : [];
  const located = useMemo(
    () =>
      devices.filter(
        (d): d is MapDevice & { latitude: number; longitude: number } =>
          typeof d.latitude === 'number' && typeof d.longitude === 'number'
      ),
    [devices]
  );
  const positions = useMemo(
    () => located.map((d) => [d.latitude, d.longitude] as [number, number]),
    [located]
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Mapa de Dispositivos</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
            {located.length} de {devices.length} dispositivos localizados · actualiza a cada 30s
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3 text-xs text-gray-500 dark:text-gray-400">
          {[
            { color: statusColor.online, label: 'Online' },
            { color: statusColor.offline, label: 'Offline' },
            { color: statusColor.alert, label: 'Alerta' },
            { color: statusColor.blocked, label: 'Bloqueado' },
          ].map((s) => (
            <span key={s.label} className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-full" style={{ background: s.color }} />
              {s.label}
            </span>
          ))}
          <span className="flex items-center gap-1">
            <Smartphone className="w-3.5 h-3.5" /> móvel
          </span>
          <span className="flex items-center gap-1">
            <Monitor className="w-3.5 h-3.5" /> PC
          </span>
        </div>
      </div>

      {error && (
        <div className="px-4 py-3 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800">
          <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
        </div>
      )}

      <div className="relative h-[70vh] min-h-[420px] rounded-xl overflow-hidden border border-gray-200 dark:border-gray-700 bg-gray-100 dark:bg-gray-800">
        <MapContainer center={[20, 0]} zoom={2} className="h-full w-full" scrollWheelZoom>
          <TileLayer
            url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          />
          <FitBounds positions={positions} />
          {located.map((d) => (
            <Marker key={d.id} position={[d.latitude, d.longitude]} icon={deviceIcon(d)}>
              <Popup>
                <div className="min-w-[200px] space-y-1.5 text-xs text-gray-800">
                  <p className="font-semibold text-sm text-gray-900">
                    {d.display_name || d.hostname}
                  </p>
                  <div className="flex items-center justify-between">
                    <span className="flex items-center gap-1.5 font-medium">
                      <span
                        className="w-2 h-2 rounded-full inline-block"
                        style={{ background: statusColor[d.status] || '#3b82f6' }}
                      />
                      {d.status}
                    </span>
                    <span>
                      {isMobile(d) ? '📱' : '💻'} {d.os_type}
                    </span>
                  </div>
                  <p>
                    📍 {d.geo_source === 'gps' ? 'GPS do dispositivo' : 'localização aproximada (IP)'}
                  </p>
                  {d.location_updated_at && (
                    <p>🕒 {formatTimeAgo(d.location_updated_at)}</p>
                  )}
                  {d.ip_address && <p>🌐 {d.ip_address}</p>}
                  {d.battery_level != null && <p>🔋 {d.battery_level}%</p>}
                  <p>💓 {formatTimeAgo(d.last_heartbeat)}</p>
                  <Link
                    to={`/devices/${d.id}`}
                    className="inline-block mt-1 font-medium text-blue-600 hover:underline"
                  >
                    Ver detalhes →
                  </Link>
                </div>
              </Popup>
            </Marker>
          ))}
        </MapContainer>

        {loading && devices.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center bg-white/70 dark:bg-gray-900/70 z-[1000]">
            <div className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-300">
              <MapPinned className="w-4 h-4 animate-pulse" /> A carregar localizações…
            </div>
          </div>
        )}

        {!loading && located.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center z-[1000] pointer-events-none">
            <div className="mx-4 max-w-md rounded-xl bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 shadow-lg p-5 text-center">
              <MapPinned className="w-8 h-8 text-gray-400 mx-auto mb-2" />
              <p className="text-sm font-medium text-gray-900 dark:text-white">
                Sem localizações ainda
              </p>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                Telemóveis aparecem com GPS activo no momento do registo; PCs são aproximados por IP
                público. LAN/VPN (IP privado) não é geolocalizável.
              </p>
            </div>
          </div>
        )}
      </div>

      <p className="text-xs text-gray-400 dark:text-gray-500">
        Tiles: OpenStreetMap · Telemóveis: GPS real (enquanto a página de registo está aberta) ·
        PCs: aproximado por IP público (cache 6h)
      </p>
    </div>
  );
}
