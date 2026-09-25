import { useState } from 'react';
import { Download, Copy, Check, Monitor, Wifi, Smartphone } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { useApi } from '../hooks/useApi';

const API_URL = 'https://endpointx.onrender.com';

export default function InstallPage() {
  const [copied, setCopied] = useState('');
  const { data: tokenData } = useApi<{ token: string }>('/devices/enroll-token');
  const enrollToken = tokenData?.token || '';
  const tokenQS = enrollToken ? `?t=${enrollToken}` : '';

  const copyToClipboard = (text: string, label: string) => {
    navigator.clipboard.writeText(text);
    setCopied(label);
    setTimeout(() => setCopied(''), 2000);
  };

  const installScript = `irm ${API_URL}/api/devices/public/install.ps1${tokenQS} | iex`;
  const updateScript = `irm ${API_URL}/api/devices/public/update.ps1 | iex`;
  const mobileUrl = `${API_URL}/api/devices/public/mobile${tokenQS}`;

  return (
    <div className="max-w-4xl mx-auto p-6">
      <h1 className="text-2xl font-bold mb-6 flex items-center gap-2">
        <Monitor className="w-6 h-6" />
        Instalar Agent (PC e Telemóvel)
      </h1>

      <div className="bg-blue-500/10 border border-blue-500/30 rounded-lg p-4 mb-6">
        <p className="text-blue-400 text-sm">
          Use este guia para conectar PCs e telemóveis da rede ao sistema EndpointX (v1.1.0).
        </p>
      </div>

      <div className="bg-gray-800 rounded-lg p-6 mb-6">
        <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
          <Download className="w-5 h-5 text-green-400" />
          Windows — Instalação rápida
        </h2>
        <p className="text-gray-400 text-sm mb-4">
          No PC remoto, abra o PowerShell e cole (não fecha a shell):
        </p>
        <div className="bg-gray-900 rounded p-3 flex items-center justify-between">
          <code className="text-cyan-400 text-sm font-mono whitespace-nowrap overflow-x-auto min-w-0">{installScript}</code>
          <button
            onClick={() => copyToClipboard(installScript, 'quick')}
            className="ml-3 p-2 hover:bg-gray-700 rounded flex-shrink-0"
            title="Copiar comando"
          >
            {copied === 'quick' ? <Check className="w-4 h-4 text-green-400" /> : <Copy className="w-4 h-4" />}
          </button>
        </div>
        <p className="text-gray-500 text-xs mt-2">
          Requer Python instalado com &quot;Add to PATH&quot; marcado. Seguro para <code>irm | iex</code>.
        </p>

        <div className="mt-4 bg-gray-900 rounded p-3 flex items-center justify-between">
          <code className="text-yellow-400 text-sm font-mono whitespace-nowrap overflow-x-auto min-w-0">{updateScript}</code>
          <button
            onClick={() => copyToClipboard(updateScript, 'update')}
            className="ml-3 p-2 hover:bg-gray-700 rounded flex-shrink-0"
            title="Copiar comando"
          >
            {copied === 'update' ? <Check className="w-4 h-4 text-green-400" /> : <Copy className="w-4 h-4" />}
          </button>
        </div>
        <p className="text-gray-500 text-xs mt-1">Atualização rápida do agent já instalado.</p>
      </div>

      <div className="bg-gray-800 rounded-lg p-6 mb-6">
        <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
          <Smartphone className="w-5 h-5 text-blue-400" />
          Telemóvel / Tablet (Android e iOS)
        </h2>
        <p className="text-gray-400 text-sm mb-4">
          No telemóvel, abra o link de registo (página mobile). O dispositivo entra como{' '}
          <span className="text-yellow-400">PENDING</span> até aprovação no dashboard (Zero Trust).
        </p>
        <div className="bg-gray-900 rounded p-3 flex items-center justify-between mb-3">
          <code className="text-blue-400 text-sm font-mono break-all">{mobileUrl}</code>
          <button
            onClick={() => copyToClipboard(mobileUrl, 'mobile')}
            className="ml-3 p-2 hover:bg-gray-700 rounded flex-shrink-0"
            title="Copiar link"
          >
            {copied === 'mobile' ? <Check className="w-4 h-4 text-green-400" /> : <Copy className="w-4 h-4" />}
          </button>
        </div>
        <div className="bg-white rounded-lg p-3 w-fit">
          <QRCodeSVG value={mobileUrl} size={160} level="M" aria-label="QR code da página de registo mobile" />
        </div>
        <p className="text-gray-500 text-xs mt-2">
          Alternativa: abra a partir do QR code no telemóvel. Também disponível em{' '}
          <code>GET /api/devices/public/mobile</code> e <code>POST /api/devices/mobile/register</code>.
          Para MDM: Android Enterprise, Apple Business Manager, Intune, Jamf.
        </p>
        <a
          href={mobileUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-block mt-3 px-4 py-2 bg-blue-600 hover:bg-blue-500 rounded text-sm font-medium"
        >
          Abrir página mobile
        </a>
      </div>

      <div className="bg-gray-800 rounded-lg p-6 mb-6">
        <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
          <Wifi className="w-5 h-5 text-blue-400" />
          Metodo 2: Via Git
        </h2>
        <p className="text-gray-400 text-sm mb-4">
          No PC remoto, instale o Python e Git, depois execute:
        </p>
        <div className="space-y-3">
          <div>
            <p className="text-gray-500 text-xs mb-1">1. Instalar Git (se nao tiver)</p>
            <div className="bg-gray-900 rounded p-3 flex items-center justify-between">
              <code className="text-yellow-400 text-xs">https://git-scm.com/download/win</code>
              <button
                onClick={() => copyToClipboard('https://git-scm.com/download/win', 'git')}
                className="ml-3 p-2 hover:bg-gray-700 rounded"
              >
                {copied === 'git' ? <Check className="w-4 h-4 text-green-400" /> : <Copy className="w-4 h-4" />}
              </button>
            </div>
          </div>
          <div>
            <p className="text-gray-500 text-xs mb-1">2. Clonar e instalar</p>
            <div className="bg-gray-900 rounded p-3 flex items-center justify-between">
              <code className="text-green-400 text-xs">
                git clone https://github.com/Masukulmiguel/endpointx.git{'\n'}
                cd endpointx/endpoint-agent{'\n'}
                pip install -r requirements.txt{'\n'}
                python agent.py --register{'\n'}
                python agent.py
              </code>
              <button
                onClick={() => copyToClipboard(
                  'git clone https://github.com/Masukulmiguel/endpointx.git; cd endpointx/endpoint-agent; pip install -r requirements.txt; python agent.py --register; python agent.py',
                  'git-install'
                )}
                className="ml-3 p-2 hover:bg-gray-700 rounded"
              >
                {copied === 'git-install' ? <Check className="w-4 h-4 text-green-400" /> : <Copy className="w-4 h-4" />}
              </button>
            </div>
          </div>
        </div>
      </div>

      <div className="bg-gray-800 rounded-lg p-6">
        <h2 className="text-lg font-semibold mb-4">Configuracao Automatica</h2>
        <p className="text-gray-400 text-sm mb-4">
          Os agents serao automaticamente configurados para apontar para:
        </p>
        <div className="bg-gray-900 rounded p-3">
          <code className="text-blue-400 text-xs">{API_URL}/api</code>
        </div>
        <p className="text-gray-500 text-xs mt-2">
          Nao e necessario editar o config.yaml manualmente.
        </p>
      </div>
    </div>
  );
}
